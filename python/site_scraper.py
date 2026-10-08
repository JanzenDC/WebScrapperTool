#!/usr/bin/python3
"""
site_scraper.py - Crawl every page of a website and export everything to one folder.

Usage:
    python site_scraper.py                      (prompts for the target URL)
    python site_scraper.py https://example.com
    python site_scraper.py https://example.com -o my_export --max-pages 500 --workers 8
    python site_scraper.py https://example.com --assets --text --use-sitemap

Output folder layout:
    <out>/<target host>/
      pages/        raw HTML of every crawled page
      text/         clean plain text of every page        (with --text)
      assets/       images, CSS, JS, PDFs, etc.           (with --assets)
      index.csv     one row per URL: status, title, file, depth, ...
      index.json    same data as JSON
      errors.log    URLs that failed

Install:
    pip install requests beautifulsoup4
"""

import argparse
import csv
import hashlib
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib import robotparser
from urllib.parse import urljoin, urlparse, urldefrag, urlunparse

import requests
from bs4 import BeautifulSoup

SKIP_EXTENSIONS = {
    ".zip", ".rar", ".7z", ".tar", ".gz", ".exe", ".dmg", ".iso",
    ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav",
}
ASSET_EXTENSIONS = {
    ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
    ".woff", ".woff2", ".ttf", ".pdf",
}


# --------------------------------------------------------------------------- #
# URL helpers
# --------------------------------------------------------------------------- #
def normalize_url(url: str, keep_query: bool = True) -> str:
    """Remove fragment, lowercase host, strip default ports and trailing junk."""
    url, _ = urldefrag(url.strip())
    p = urlparse(url)
    netloc = p.netloc.lower()
    if netloc.endswith(":80") and p.scheme == "http":
        netloc = netloc[:-3]
    if netloc.endswith(":443") and p.scheme == "https":
        netloc = netloc[:-4]
    path = p.path or "/"
    query = p.query if keep_query else ""
    return urlunparse((p.scheme, netloc, path, "", query, ""))


def host_key(url: str) -> str:
    """Host without leading 'www.' so example.com and www.example.com match."""
    host = urlparse(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def url_to_relpath(url: str, suffix: str) -> Path:
    """Map a URL to a safe relative file path inside the export folder."""
    p = urlparse(url)
    path = p.path.strip("/")
    if not path:
        path = "index"
    # Drop existing extension so about.html -> about.html (not about.html.html)
    base, ext = (path.rsplit(".", 1) + [""])[:2] if "." in path.split("/")[-1] else (path, "")
    if ext and suffix == ".html" and ext.lower() in ("html", "htm"):
        path = base
    elif ext and suffix != ".html":
        path = base
    # Sanitize each segment
    parts = [re.sub(r"[^A-Za-z0-9._-]", "_", seg)[:80] or "_" for seg in path.split("/")]
    name = "/".join(parts)
    if p.query:
        name += "__" + hashlib.md5(p.query.encode()).hexdigest()[:8]
    return Path(name + suffix)


# --------------------------------------------------------------------------- #
# Crawler
# --------------------------------------------------------------------------- #
class SiteScraper:
    def __init__(self, args):
        self.args = args
        self.start_url = normalize_url(args.url, keep_query=not args.ignore_query)
        self.domain = host_key(self.start_url)
        site_folder = re.sub(r"[^A-Za-z0-9._-]", "_", urlparse(self.start_url).netloc)
        self.out = Path(args.output) / site_folder
        self.pages_dir = self.out / "pages"
        self.text_dir = self.out / "text"
        self.assets_dir = self.out / "assets"
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": args.user_agent})
        self.robots = None
        self.records = []
        self.errors = []
        self.seen_assets = set()
        self.include_re = re.compile(args.include) if args.include else None
        self.exclude_re = re.compile(args.exclude) if args.exclude else None

    # ---- setup ---------------------------------------------------------- #
    def load_robots(self):
        if not self.args.respect_robots:
            return
        parsed = urlparse(self.start_url)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        rp = robotparser.RobotFileParser()
        try:
            resp = self.session.get(robots_url, timeout=self.args.timeout)
            if resp.status_code == 200:
                rp.parse(resp.text.splitlines())
                self.robots = rp
                print(f"[robots] loaded {robots_url}")
            else:
                print(f"[robots] none found ({resp.status_code}); crawling freely")
        except requests.RequestException:
            print("[robots] could not fetch robots.txt; crawling freely")

    def sitemap_urls(self):
        """Seed URLs from sitemap.xml (handles sitemap indexes)."""
        parsed = urlparse(self.start_url)
        root = f"{parsed.scheme}://{parsed.netloc}"
        queue = [f"{root}/sitemap.xml"]
        found, visited = [], set()
        while queue and len(visited) < 50:
            sm = queue.pop()
            if sm in visited:
                continue
            visited.add(sm)
            try:
                r = self.session.get(sm, timeout=self.args.timeout)
                if r.status_code != 200:
                    continue
                tree = ET.fromstring(r.content)
            except (requests.RequestException, ET.ParseError):
                continue
            for el in tree.iter():
                if el.tag.endswith("}loc") or el.tag == "loc":
                    loc = (el.text or "").strip()
                    if not loc:
                        continue
                    if loc.endswith(".xml") or loc.endswith(".xml.gz"):
                        queue.append(loc)
                    else:
                        found.append(loc)
        print(f"[sitemap] found {len(found)} URLs")
        return found

    # ---- filtering ------------------------------------------------------ #
    def allowed(self, url: str) -> bool:
        p = urlparse(url)
        if p.scheme not in ("http", "https"):
            return False
        if host_key(url) != self.domain:
            return False
        ext = Path(p.path).suffix.lower()
        if ext in SKIP_EXTENSIONS or ext in ASSET_EXTENSIONS:
            return False
        if self.include_re and not self.include_re.search(url):
            return False
        if self.exclude_re and self.exclude_re.search(url):
            return False
        if self.robots and not self.robots.can_fetch(self.args.user_agent, url):
            return False
        return True

    # ---- fetching ------------------------------------------------------- #
    def fetch(self, item):
        url, depth = item
        rec = {
            "url": url, "depth": depth, "status": None, "title": "",
            "file": "", "text_file": "", "content_type": "", "links": [],
            "assets": [], "error": "",
        }
        try:
            resp = self.session.get(url, timeout=self.args.timeout, allow_redirects=True)
            rec["status"] = resp.status_code
            rec["content_type"] = resp.headers.get("Content-Type", "")
            if resp.status_code != 200 or "html" not in rec["content_type"].lower():
                if resp.status_code != 200:
                    rec["error"] = f"HTTP {resp.status_code}"
                return rec

            resp.encoding = resp.encoding or resp.apparent_encoding
            html = resp.text
            soup = BeautifulSoup(html, "html.parser")
            rec["title"] = (soup.title.string.strip() if soup.title and soup.title.string else "")

            # Save HTML
            rel = url_to_relpath(url, ".html")
            dest = self.pages_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(html, encoding="utf-8", errors="replace")
            rec["file"] = str(Path("pages") / rel)

            # Save plain text
            if self.args.text:
                for tag in soup(["script", "style", "noscript"]):
                    tag.decompose()
                text = re.sub(r"\n\s*\n+", "\n\n", soup.get_text("\n")).strip()
                trel = url_to_relpath(url, ".txt")
                tdest = self.text_dir / trel
                tdest.parent.mkdir(parents=True, exist_ok=True)
                tdest.write_text(f"URL: {url}\nTITLE: {rec['title']}\n\n{text}\n", encoding="utf-8")
                rec["text_file"] = str(Path("text") / trel)
                # re-parse since decompose() mutated the tree
                soup = BeautifulSoup(html, "html.parser")

            # Collect links
            base = resp.url
            for a in soup.find_all("a", href=True):
                href = a["href"].strip()
                if href.startswith(("mailto:", "tel:", "javascript:", "data:")):
                    continue
                full = normalize_url(urljoin(base, href), keep_query=not self.args.ignore_query)
                rec["links"].append(full)

            # Collect asset URLs
            if self.args.assets:
                for tag, attr in (("img", "src"), ("script", "src"), ("link", "href"), ("source", "src")):
                    for el in soup.find_all(tag, **{attr: True}):
                        if tag == "link" and "stylesheet" not in (el.get("rel") or []) \
                                and "icon" not in " ".join(el.get("rel") or []):
                            continue
                        rec["assets"].append(urljoin(base, el[attr]))
                for a in soup.find_all("a", href=True):
                    full = urljoin(base, a["href"])
                    if Path(urlparse(full).path).suffix.lower() in ASSET_EXTENSIONS:
                        rec["assets"].append(full)

        except requests.RequestException as e:
            rec["error"] = str(e)[:200]
        finally:
            if self.args.delay:
                time.sleep(self.args.delay)
        return rec

    def download_asset(self, url):
        p = urlparse(url)
        if p.scheme not in ("http", "https") or host_key(url) != self.domain and not self.args.external_assets:
            return
        clean = urldefrag(url)[0]
        if clean in self.seen_assets:
            return
        self.seen_assets.add(clean)
        try:
            r = self.session.get(clean, timeout=self.args.timeout)
            if r.status_code != 200:
                return
            ap = urlparse(clean)
            seg = ap.path.strip("/") or "file"
            parts = [re.sub(r"[^A-Za-z0-9._-]", "_", s)[:80] or "_" for s in seg.split("/")]
            name = "/".join(parts)
            if ap.query:
                stem, dot, ext = name.rpartition(".")
                tag = hashlib.md5(ap.query.encode()).hexdigest()[:8]
                name = f"{stem}__{tag}.{ext}" if dot else f"{name}__{tag}"
            dest = self.assets_dir / ap.netloc.replace(":", "_") / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(r.content)
        except requests.RequestException:
            pass

    # ---- main loop ------------------------------------------------------ #
    def run(self):
        self.out.mkdir(parents=True, exist_ok=True)
        self.pages_dir.mkdir(exist_ok=True)
        print(f"[start] {self.start_url}  ->  {self.out.resolve()}")
        self.load_robots()

        seen = {self.start_url}
        frontier = [(self.start_url, 0)]
        if self.args.use_sitemap:
            for u in self.sitemap_urls():
                nu = normalize_url(u, keep_query=not self.args.ignore_query)
                if nu not in seen and self.allowed(nu):
                    seen.add(nu)
                    frontier.append((nu, 0))

        crawled = 0
        with ThreadPoolExecutor(max_workers=self.args.workers) as pool:
            while frontier and crawled < self.args.max_pages:
                batch = frontier[: self.args.max_pages - crawled]
                frontier = []
                results = list(pool.map(self.fetch, batch))

                for rec in results:
                    crawled += 1
                    status = rec["status"] or "ERR"
                    print(f"[{crawled:>5}] {status}  d{rec['depth']}  {rec['url']}")
                    if rec["error"]:
                        self.errors.append(f"{rec['url']}\t{rec['error']}")

                    # queue new links
                    if self.args.max_depth is None or rec["depth"] < self.args.max_depth:
                        for link in rec["links"]:
                            if link not in seen and self.allowed(link):
                                seen.add(link)
                                frontier.append((link, rec["depth"] + 1))

                    # download assets
                    if self.args.assets and rec["assets"]:
                        list(pool.map(self.download_asset, set(rec["assets"])))

                    self.records.append(rec)

        self.write_indexes()
        ok = sum(1 for r in self.records if r["status"] == 200 and r["file"])
        print(f"\n[done] crawled {crawled} URLs, saved {ok} pages, {len(self.errors)} errors")
        print(f"[done] output folder: {self.out.resolve()}")

    def write_indexes(self):
        fields = ["url", "depth", "status", "title", "file", "text_file", "content_type", "error"]
        with open(self.out / "index.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            w.writerows(self.records)
        slim = [
            {**{k: r[k] for k in fields}, "links_found": len(r["links"])}
            for r in self.records
        ]
        (self.out / "index.json").write_text(json.dumps(slim, indent=2, ensure_ascii=False), encoding="utf-8")
        if self.errors:
            (self.out / "errors.log").write_text("\n".join(self.errors), encoding="utf-8")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def parse_args():
    ap = argparse.ArgumentParser(
        description="Crawl all pages of a website and export them into one folder."
    )
    ap.add_argument("url", nargs="?", help="Start URL, e.g. https://example.com (prompted if omitted)")
    ap.add_argument("-o", "--output", default="scraped_site", help="Output root folder; each site goes in a subfolder named after its host (default: scraped_site)")
    ap.add_argument("--max-pages", type=int, default=1000, help="Stop after this many URLs (default: 1000)")
    ap.add_argument("--max-depth", type=int, default=None, help="Max link depth from start URL (default: unlimited)")
    ap.add_argument("--workers", type=int, default=5, help="Parallel downloads (default: 5)")
    ap.add_argument("--delay", type=float, default=0.5, help="Seconds each worker waits after a request (default: 0.5)")
    ap.add_argument("--timeout", type=int, default=20, help="Request timeout in seconds (default: 20)")
    ap.add_argument("--text", action="store_true", help="Also export clean plain text of each page")
    ap.add_argument("--assets", action="store_true", help="Also download images, CSS, JS, PDFs")
    ap.add_argument("--external-assets", action="store_true", help="Allow assets from other domains (CDNs)")
    ap.add_argument("--use-sitemap", action="store_true", help="Seed the crawl from sitemap.xml")
    ap.add_argument("--ignore-query", action="store_true", help="Treat URLs with different ?query as the same page")
    ap.add_argument("--include", help="Regex: only crawl URLs matching this")
    ap.add_argument("--exclude", help="Regex: skip URLs matching this")
    ap.add_argument("--ignore-robots", dest="respect_robots", action="store_false",
                    help="Ignore robots.txt (only use on sites you own / have permission for)")
    ap.add_argument("--user-agent", default="Mozilla/5.0 (compatible; SiteScraper/1.0)", help="User-Agent header")
    args = ap.parse_args()

    while not args.url:
        args.url = input("Target URL: ").strip()
    if not urlparse(args.url).scheme:
        args.url = "https://" + args.url
    return args


if __name__ == "__main__":
    try:
        SiteScraper(parse_args()).run()
    except KeyboardInterrupt:
        print("\n[abort] interrupted by user")
        sys.exit(1)
