#!/usr/bin/env node
/**
 * site_scraper.js - Crawl every page of a website and export everything to one folder.
 *
 * Usage:
 *   node site_scraper.js                      (prompts for the target URL)
 *   node site_scraper.js https://example.com
 *   node site_scraper.js https://example.com -o my_export --max-pages 500 --workers 8
 *   node site_scraper.js https://example.com --assets --text --use-sitemap
 *
 * Output folder layout:
 *   <out>/<target host>/
 *     pages/        raw HTML of every crawled page
 *     text/         clean plain text of every page        (with --text)
 *     assets/       images, CSS, JS, PDFs, etc.           (with --assets)
 *     index.csv     one row per URL: status, title, file, depth, ...
 *     index.json    same data as JSON
 *     errors.log    URLs that failed
 *
 * Install:
 *   npm install
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import * as cheerio from "cheerio";
import robotsParser from "robots-parser";

const SKIP_EXTENSIONS = new Set([
  ".zip", ".rar", ".7z", ".tar", ".gz", ".exe", ".dmg", ".iso",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav",
]);
const ASSET_EXTENSIONS = new Set([
  ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
  ".woff", ".woff2", ".ttf", ".pdf",
]);
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER = 300;


// --------------------------------------------------------------------------- //
// URL helpers
// --------------------------------------------------------------------------- //
/** Remove fragment, lowercase host, strip default ports. */
function normalizeUrl(raw, keepQuery = true) {
  const u = new URL(raw.trim());
  u.hash = "";
  if (!keepQuery || !u.search) u.search = "";
  return u.href;
}

/** Host without leading 'www.' so example.com and www.example.com match. */
function hostKey(url) {
  const host = new URL(url).host.toLowerCase();
  return host.startsWith("www.") ? host.slice(4) : host;
}

/** Resolve href against base, or null if it isn't a valid URL. */
function resolveUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function extOf(url) {
  return path.posix.extname(new URL(url).pathname).toLowerCase();
}

function safeSegments(p) {
  return p.split("/").map((seg) => seg.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "_");
}

function shortHash(s) {
  return createHash("md5").update(s).digest("hex").slice(0, 8);
}

/** Map a URL to a safe relative file path inside the export folder. */
function urlToRelpath(url, suffix) {
  const u = new URL(url);
  let p = u.pathname.replace(/^\/+|\/+$/g, "") || "index";
  // Drop existing extension so about.html -> about.html (not about.html.html)
  const last = p.slice(p.lastIndexOf("/") + 1);
  if (last.includes(".")) {
    const dot = p.lastIndexOf(".");
    const ext = p.slice(dot + 1).toLowerCase();
    if (ext && (suffix !== ".html" || ext === "html" || ext === "htm")) p = p.slice(0, dot);
  }
  let name = path.join(...safeSegments(p));
  if (u.search) name += "__" + shortHash(u.search.slice(1));
  return name + suffix;
}


// --------------------------------------------------------------------------- //
// Misc helpers
// --------------------------------------------------------------------------- //
/** Decode a response body using the charset from the header or <meta>, defaulting to UTF-8. */
function decodeBody(buf, contentType) {
  const charset =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ||
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString("latin1"))?.[1] ||
    "utf-8";
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/** All text nodes joined by newlines, with runs of blank lines collapsed. */
function pageText($) {
  const parts = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type === "text") parts.push(node.data);
      else if (node.children) walk(node.children);
    }
  };
  walk($.root().get(0).children);
  return parts.join("\n").replace(/\n\s*\n+/g, "\n\n").trim();
}

async function writeFileSafe(dest, data) {
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, data);
}

function errorMessage(e) {
  const msg = e?.cause?.message ? `${e.message}: ${e.cause.message}` : String(e?.message ?? e);
  return msg.slice(0, 200);
}

/** Seconds from a numeric Retry-After header, capped, or null. */
function retryAfter(res) {
  const s = Number(res.headers.get("retry-after") ?? NaN);
  return Number.isFinite(s) ? Math.min(Math.max(s, 0), MAX_RETRY_AFTER) : null;
}

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Like Promise.all(items.map(fn)) but with at most `limit` calls in flight. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}


// --------------------------------------------------------------------------- //
// Crawler
// --------------------------------------------------------------------------- //
class SiteScraper {
  constructor(args) {
    this.args = args;
    this.startUrl = normalizeUrl(args.url, !args.ignoreQuery);
    this.domain = hostKey(this.startUrl);
    const siteFolder = new URL(this.startUrl).host.replace(/[^A-Za-z0-9._-]/g, "_");
    this.out = path.join(args.output, siteFolder);
    this.pagesDir = path.join(this.out, "pages");
    this.textDir = path.join(this.out, "text");
    this.assetsDir = path.join(this.out, "assets");
    this.robots = null;
    this.records = [];
    this.errors = [];
    this.seenAssets = new Set();
    this.cooldownUntil = 0;
    this.includeRe = args.include ? new RegExp(args.include) : null;
    this.excludeRe = args.exclude ? new RegExp(args.exclude) : null;
  }

  // ---- requests with retry ------------------------------------------- //
  /** GET url. Connection errors, timeouts, 429 and 5xx pause every worker, then retry. */
  async request(url) {
    for (let attempt = 0; ; attempt++) {
      await this.waitForCooldown();
      const backoff = this.args.retryWait * 2 ** attempt;
      let res;
      try {
        res = await fetch(url, {
          headers: { "User-Agent": this.args.userAgent },
          redirect: "follow",
          signal: AbortSignal.timeout(this.args.timeout * 1000),
        });
      } catch (e) {
        if (attempt >= this.args.retries) throw e;
        this.startCooldown(backoff, url, e.cause?.code || e.name);
        continue;
      }
      if (!RETRY_STATUSES.has(res.status) || attempt >= this.args.retries) return res;
      await res.body?.cancel();
      this.startCooldown(retryAfter(res) || backoff, url, `HTTP ${res.status}`);
    }
  }

  async waitForCooldown() {
    let remaining;
    while ((remaining = this.cooldownUntil - Date.now()) > 0) await sleep(remaining);
  }

  startCooldown(seconds, url, reason) {
    const until = Date.now() + seconds * 1000;
    if (until <= this.cooldownUntil) return;
    this.cooldownUntil = until;
    console.log(`[retry] ${reason} on ${url}; pausing all requests for ${Math.round(seconds)}s`);
  }

  // ---- setup ---------------------------------------------------------- //
  async loadRobots() {
    if (!this.args.respectRobots) return;
    const robotsUrl = new URL("/robots.txt", this.startUrl).href;
    try {
      const res = await this.request(robotsUrl);
      if (res.status === 200) {
        this.robots = robotsParser(robotsUrl, await res.text());
        console.log(`[robots] loaded ${robotsUrl}`);
      } else {
        await res.body?.cancel();
        console.log(`[robots] none found (${res.status}); crawling freely`);
      }
    } catch {
      console.log("[robots] could not fetch robots.txt; crawling freely");
    }
  }

  /** Seed URLs from sitemap.xml (handles sitemap indexes). */
  async sitemapUrls() {
    const queue = [new URL("/sitemap.xml", this.startUrl).href];
    const found = [];
    const visited = new Set();
    while (queue.length && visited.size < 50) {
      const sm = queue.pop();
      if (visited.has(sm)) continue;
      visited.add(sm);
      let xml;
      try {
        const res = await this.request(sm);
        if (res.status !== 200) {
          await res.body?.cancel();
          continue;
        }
        xml = await res.text();
      } catch {
        continue;
      }
      const $ = cheerio.load(xml, { xml: true });
      $("loc").each((_, el) => {
        const loc = $(el).text().trim();
        if (!loc) return;
        if (loc.endsWith(".xml") || loc.endsWith(".xml.gz")) queue.push(loc);
        else found.push(loc);
      });
    }
    console.log(`[sitemap] found ${found.length} URLs`);
    return found;
  }

  // ---- filtering ------------------------------------------------------ //
  allowed(url) {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (hostKey(url) !== this.domain) return false;
    const ext = extOf(url);
    if (SKIP_EXTENSIONS.has(ext) || ASSET_EXTENSIONS.has(ext)) return false;
    if (this.includeRe && !this.includeRe.test(url)) return false;
    if (this.excludeRe && this.excludeRe.test(url)) return false;
    if (this.robots) {
      // robots-parser ignores URLs on other hosts, so check www/non-www variants against the start host
      const check = new URL(u.pathname + u.search, this.startUrl).href;
      if (this.robots.isAllowed(check, this.args.userAgent) === false) return false;
    }
    return true;
  }

  // ---- fetching ------------------------------------------------------- //
  async fetchPage([url, depth]) {
    const rec = {
      url, depth, status: null, title: "",
      file: "", text_file: "", content_type: "", links: [],
      assets: [], error: "",
    };
    try {
      const res = await this.request(url);
      rec.status = res.status;
      rec.content_type = res.headers.get("content-type") || "";
      if (res.status !== 200 || !rec.content_type.toLowerCase().includes("html")) {
        await res.body?.cancel();
        if (res.status !== 200) rec.error = `HTTP ${res.status}`;
        return rec;
      }

      const html = decodeBody(Buffer.from(await res.arrayBuffer()), rec.content_type);
      const $ = cheerio.load(html);
      rec.title = $("title").first().text().trim();

      // Save HTML
      const rel = urlToRelpath(url, ".html");
      await writeFileSafe(path.join(this.pagesDir, rel), html);
      rec.file = path.join("pages", rel);

      // Save plain text
      if (this.args.text) {
        const $text = cheerio.load(html);
        $text("script, style, noscript").remove();
        const trel = urlToRelpath(url, ".txt");
        await writeFileSafe(
          path.join(this.textDir, trel),
          `URL: ${url}\nTITLE: ${rec.title}\n\n${pageText($text)}\n`,
        );
        rec.text_file = path.join("text", trel);
      }

      // Collect links
      const baseHref = $("base[href]").first().attr("href");
      const base = (baseHref && resolveUrl(baseHref.trim(), res.url)) || res.url;
      $("a[href]").each((_, a) => {
        const href = $(a).attr("href").trim();
        if (/^(mailto|tel|javascript|data):/i.test(href)) return;
        const full = resolveUrl(href, base);
        if (full) rec.links.push(normalizeUrl(full, !this.args.ignoreQuery));
      });

      // Collect asset URLs
      if (this.args.assets) {
        for (const [tag, attr] of [["img", "src"], ["script", "src"], ["link", "href"], ["source", "src"]]) {
          $(`${tag}[${attr}]`).each((_, el) => {
            if (tag === "link") {
              const relAttr = ($(el).attr("rel") || "").toLowerCase();
              if (!relAttr.split(/\s+/).includes("stylesheet") && !relAttr.includes("icon")) return;
            }
            const full = resolveUrl($(el).attr(attr), base);
            if (full) rec.assets.push(full);
          });
        }
        $("a[href]").each((_, a) => {
          const full = resolveUrl($(a).attr("href"), base);
          if (full && ASSET_EXTENSIONS.has(extOf(full))) rec.assets.push(full);
        });
      }
    } catch (e) {
      rec.error = errorMessage(e);
    } finally {
      if (this.args.delay) await sleep(this.args.delay * 1000);
    }
    return rec;
  }

  async downloadAsset(url) {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return;
    if (hostKey(url) !== this.domain && !this.args.externalAssets) return;
    u.hash = "";
    const clean = u.href;
    if (this.seenAssets.has(clean)) return;
    this.seenAssets.add(clean);
    try {
      const res = await this.request(clean);
      if (res.status !== 200) {
        await res.body?.cancel();
        return;
      }
      const segs = safeSegments(u.pathname.replace(/^\/+|\/+$/g, "") || "file");
      if (u.search) {
        const tag = shortHash(u.search.slice(1));
        const last = segs.length - 1;
        const dot = segs[last].lastIndexOf(".");
        segs[last] = dot >= 0
          ? `${segs[last].slice(0, dot)}__${tag}${segs[last].slice(dot)}`
          : `${segs[last]}__${tag}`;
      }
      const dest = path.join(this.assetsDir, u.host.replace(/:/g, "_"), ...segs);
      await writeFileSafe(dest, Buffer.from(await res.arrayBuffer()));
    } catch {
      // asset failures are not fatal
    }
  }

  // ---- main loop ------------------------------------------------------ //
  async run() {
    await mkdir(this.pagesDir, { recursive: true });
    console.log(`[start] ${this.startUrl}  ->  ${path.resolve(this.out)}`);
    await this.loadRobots();

    const keepQuery = !this.args.ignoreQuery;
    const seen = new Set([this.startUrl]);
    let frontier = [[this.startUrl, 0]];
    if (this.args.useSitemap) {
      for (const u of await this.sitemapUrls()) {
        let nu;
        try {
          nu = normalizeUrl(u, keepQuery);
        } catch {
          continue;
        }
        if (!seen.has(nu) && this.allowed(nu)) {
          seen.add(nu);
          frontier.push([nu, 0]);
        }
      }
    }

    let crawled = 0;
    while (frontier.length && crawled < this.args.maxPages) {
      const batch = frontier.slice(0, this.args.maxPages - crawled);
      frontier = [];
      const results = await mapPool(batch, this.args.workers, (item) => this.fetchPage(item));

      for (const rec of results) {
        crawled += 1;
        console.log(`[${String(crawled).padStart(5)}] ${rec.status ?? "ERR"}  d${rec.depth}  ${rec.url}`);
        if (rec.error) this.errors.push(`${rec.url}\t${rec.error}`);

        // queue new links
        if (this.args.maxDepth == null || rec.depth < this.args.maxDepth) {
          for (const link of rec.links) {
            if (!seen.has(link) && this.allowed(link)) {
              seen.add(link);
              frontier.push([link, rec.depth + 1]);
            }
          }
        }

        // download assets
        if (this.args.assets && rec.assets.length) {
          await mapPool([...new Set(rec.assets)], this.args.workers, (a) => this.downloadAsset(a));
        }

        this.records.push(rec);
      }
    }

    await this.writeIndexes();
    const ok = this.records.filter((r) => r.status === 200 && r.file).length;
    console.log(`\n[done] crawled ${crawled} URLs, saved ${ok} pages, ${this.errors.length} errors`);
    console.log(`[done] output folder: ${path.resolve(this.out)}`);
  }

  async writeIndexes() {
    const fields = ["url", "depth", "status", "title", "file", "text_file", "content_type", "error"];
    const rows = [fields, ...this.records.map((r) => fields.map((f) => r[f]))];
    await writeFile(
      path.join(this.out, "index.csv"),
      rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n",
      "utf8",
    );
    const slim = this.records.map((r) => ({
      ...Object.fromEntries(fields.map((f) => [f, r[f]])),
      links_found: r.links.length,
    }));
    await writeFile(path.join(this.out, "index.json"), JSON.stringify(slim, null, 2), "utf8");
    if (this.errors.length) {
      await writeFile(path.join(this.out, "errors.log"), this.errors.join("\n"), "utf8");
    }
  }
}


// --------------------------------------------------------------------------- //
// CLI
// --------------------------------------------------------------------------- //
const USAGE = `usage: node site_scraper.js [options] [url]

Crawl all pages of a website and export them into one folder.

positional arguments:
  url                    Start URL, e.g. https://example.com (prompted if omitted)

options:
  -h, --help             Show this help message and exit
  -o, --output DIR       Output root folder; each site goes in a subfolder named after its host (default: scraped_site)
  --max-pages N          Stop after this many URLs (default: 1000)
  --max-depth N          Max link depth from start URL (default: unlimited)
  --workers N            Parallel downloads (default: 5)
  --delay SECONDS        Seconds each worker waits after a request (default: 0.5)
  --timeout SECONDS      Request timeout in seconds (default: 20)
  --retries N            Retries after a connection error, timeout, 429 or 5xx (default: 3)
  --retry-wait SECONDS   Seconds to pause before the first retry, doubled each time (default: 30)
  --text                 Also export clean plain text of each page
  --assets               Also download images, CSS, JS, PDFs
  --external-assets      Allow assets from other domains (CDNs)
  --use-sitemap          Seed the crawl from sitemap.xml
  --ignore-query         Treat URLs with different ?query as the same page
  --include REGEX        Only crawl URLs matching this
  --exclude REGEX        Skip URLs matching this
  --ignore-robots        Ignore robots.txt (only use on sites you own / have permission for)
  --user-agent UA        User-Agent header (default: Mozilla/5.0 (compatible; SiteScraper/1.0))`;

function fail(message) {
  console.error(`${USAGE}\n\nerror: ${message}`);
  process.exit(2);
}

function abort() {
  console.log("\n[abort] interrupted by user");
  process.exit(1);
}

function toNumber(flag, value, { integer = true, min = -Infinity } = {}) {
  const n = Number(value);
  if (value === "" || !Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min) {
    fail(`argument ${flag}: invalid value: '${value}'`);
  }
  return n;
}

async function promptUrl() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", abort);
  try {
    let url = "";
    while (!url) url = (await rl.question("Target URL: ")).trim();
    return url;
  } catch {
    abort();
  } finally {
    rl.close();
  }
}

async function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        output: { type: "string", short: "o", default: "scraped_site" },
        "max-pages": { type: "string", default: "1000" },
        "max-depth": { type: "string" },
        workers: { type: "string", default: "5" },
        delay: { type: "string", default: "0.5" },
        timeout: { type: "string", default: "20" },
        retries: { type: "string", default: "3" },
        "retry-wait": { type: "string", default: "30" },
        text: { type: "boolean", default: false },
        assets: { type: "boolean", default: false },
        "external-assets": { type: "boolean", default: false },
        "use-sitemap": { type: "boolean", default: false },
        "ignore-query": { type: "boolean", default: false },
        include: { type: "string" },
        exclude: { type: "string" },
        "ignore-robots": { type: "boolean", default: false },
        "user-agent": { type: "string", default: "Mozilla/5.0 (compatible; SiteScraper/1.0)" },
      },
    });
  } catch (e) {
    fail(e.message);
  }
  const { values: v, positionals } = parsed;
  if (v.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (positionals.length > 1) fail(`unrecognized arguments: ${positionals.slice(1).join(" ")}`);

  const args = {
    url: positionals[0],
    output: v.output,
    maxPages: toNumber("--max-pages", v["max-pages"]),
    maxDepth: v["max-depth"] === undefined ? null : toNumber("--max-depth", v["max-depth"]),
    workers: toNumber("--workers", v.workers, { min: 1 }),
    delay: toNumber("--delay", v.delay, { integer: false, min: 0 }),
    timeout: toNumber("--timeout", v.timeout, { integer: false, min: 0 }),
    retries: toNumber("--retries", v.retries, { min: 0 }),
    retryWait: toNumber("--retry-wait", v["retry-wait"], { integer: false, min: 0 }),
    text: v.text,
    assets: v.assets,
    externalAssets: v["external-assets"],
    useSitemap: v["use-sitemap"],
    ignoreQuery: v["ignore-query"],
    include: v.include,
    exclude: v.exclude,
    respectRobots: !v["ignore-robots"],
    userAgent: v["user-agent"],
  };

  if (!args.url) args.url = await promptUrl();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(args.url)) args.url = "https://" + args.url;
  return args;
}

process.on("SIGINT", abort);

try {
  const args = await parseCli();
  await new SiteScraper(args).run();
} catch (e) {
  console.error(`[error] ${errorMessage(e)}`);
  process.exit(1);
}
