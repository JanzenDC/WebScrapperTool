# Site Scraper

A tool that crawls every page of a website and saves the results to one folder. Each crawl produces raw HTML files and an index (CSV and JSON). You can also export plain text and download assets such as images, CSS, JS and PDFs.

It comes in two versions with the same options and output: one in Python and one in Node.js. Use whichever you have installed.

## Project layout

```
WebScrapperTool/
  python/
    site_scraper.py     Python version
    requirements.txt    Python dependencies
  node/
    site_scraper.js     Node.js version
    package.json        Node.js dependencies
  run.bat               Windows launcher (pick Python or Node.js)
  README.md
```

## Windows launcher

On Windows, double-click `run.bat` or run it from a terminal. It checks which runtimes are installed and shows them in green. The recommended one (Python if both are installed) is marked and runs if you just press Enter. If Node.js is installed, the launcher checks `node\node_modules` as soon as it opens and runs `npm install` if any module from `node\package.json` is missing. Missing Python packages are installed when you choose Python.

If Python isn't installed, choosing 1 offers to install Python 3.13 for your user account. No admin rights are needed. The launcher uses `winget` if it's available, and otherwise downloads the official installer from python.org. Once it finishes, the scraper starts right away; you don't need to restart the launcher.

```
  [1] Python    installed, Python 3.12.0  (recommended)
  [2] Node.js   installed, Node.js v24.14.1

  Choose 1 or 2, Q to quit [Enter = 1]:
```

Anything you put after `run.bat` is passed to the scraper, for example `run.bat https://example.com --text --assets`. Results always go to `scraped_site\` next to `run.bat`.

## Features

- Crawls all internal pages starting from one URL. `example.com` and `www.example.com` count as the same site.
- Downloads several pages at once; you choose how many with `--workers`.
- Follows `robots.txt` by default.
- Can seed the crawl from `sitemap.xml`, including sitemap indexes.
- Can export plain text for each page, with scripts and styles removed.
- Can download assets (images, CSS, JS, fonts, PDFs), including assets hosted on CDNs if you allow it.
- Lets you include or exclude URLs with regex filters, and limit the crawl by depth or page count.
- Writes an index of every crawled URL with its status, title, depth and saved file path.

## Python version

Requires Python 3.8+ with `requests` and `beautifulsoup4`.

```bash
cd python
pip install -r requirements.txt
python site_scraper.py https://example.com
```

On Windows you can use `py` instead of `python`.

## Node.js version

Requires Node.js 20.18.1+. The dependencies are `cheerio` for HTML parsing and `robots-parser` for `robots.txt`.

```bash
cd node
npm install
node site_scraper.js https://example.com
```

You can also use `npm start -- https://example.com`.

## Quick start

If you leave out the URL, either version asks for it:

```
> python site_scraper.py
Target URL: example.com
```

If you don't include `https://`, it's added for you. The results are saved to `scraped_site/<host>/` in the folder you ran the command from, for example `scraped_site/example.com/`. Each site gets its own folder, so scraping a different site doesn't overwrite earlier results.

## Usage examples

These examples use the Python version. The options are identical in the Node.js version; just replace `python site_scraper.py` with `node site_scraper.js`.

```bash
# Custom output folder, up to 500 pages, 8 parallel workers
python site_scraper.py https://example.com -o my_export --max-pages 500 --workers 8

# Full export: HTML + plain text + assets, seeded from sitemap.xml
python site_scraper.py https://example.com --assets --text --use-sitemap

# Only crawl the blog, skip tag pages, stay within 3 clicks of the start URL
python site_scraper.py https://example.com/blog --include "/blog/" --exclude "/tag/" --max-depth 3

# Treat ?page=1 and ?page=2 as the same URL
python site_scraper.py https://example.com --ignore-query

# Also download assets served from CDNs / other domains
python site_scraper.py https://example.com --assets --external-assets
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `url` | prompted | Start URL, e.g. `https://example.com`. If omitted, you're asked for it |
| `-o`, `--output` | `scraped_site` | Output root folder. Each site is saved in a subfolder named after its host |
| `--max-pages` | `1000` | Stop after this many URLs |
| `--max-depth` | unlimited | Maximum link depth from the start URL |
| `--workers` | `5` | Number of parallel downloads |
| `--delay` | `0.5` | Seconds each worker waits after a request |
| `--timeout` | `20` | Request timeout in seconds |
| `--retries` | `3` | How many times to retry after a connection error, timeout, HTTP 429 or 5xx |
| `--retry-wait` | `30` | Seconds to pause before the first retry, doubled each time (30s, 60s, 120s). A `Retry-After` header from the server takes priority |
| `--text` | off | Also export clean plain text of each page |
| `--assets` | off | Also download images, CSS, JS, fonts and PDFs |
| `--external-assets` | off | Allow assets from other domains (CDNs) |
| `--use-sitemap` | off | Seed the crawl from `sitemap.xml` |
| `--ignore-query` | off | Treat URLs with different `?query` strings as the same page |
| `--include REGEX` | none | Only crawl URLs matching this regex |
| `--exclude REGEX` | none | Skip URLs matching this regex |
| `--ignore-robots` | off | Ignore `robots.txt` (only use this on sites you own or have permission to crawl) |
| `--user-agent` | `Mozilla/5.0 (compatible; SiteScraper/1.0)` | User-Agent header sent with requests |

Run `python site_scraper.py -h` or `node site_scraper.js -h` to see the full help text.

## Output

```
<output>/<host>/      e.g. scraped_site/www.example.com/
  pages/        raw HTML of every crawled page
  text/         plain text of every page            (with --text)
  assets/       images, CSS, JS, PDFs, etc.         (with --assets), grouped by host
  index.csv     one row per URL
  index.json    same data as JSON, plus a links_found count
  errors.log    URLs that failed (only created if there were errors)
```

The saved files follow the URL structure. For example, `https://example.com/about/team` is saved as `scraped_site/example.com/pages/about/team.html`, and the start page is saved as `scraped_site/example.com/pages/index.html`. If a URL has a query string, a short hash is added to the file name so that different queries don't overwrite each other.

Each text file starts with the page's URL and title, followed by its visible text.

### Index columns

| Column | Meaning |
| --- | --- |
| `url` | Normalized URL that was fetched |
| `depth` | Number of links away from the start URL (sitemap URLs start at 0) |
| `status` | HTTP status code (empty if the request failed) |
| `title` | Contents of the page's `<title>` |
| `file` | Path of the saved HTML file, relative to the output folder |
| `text_file` | Path of the saved text file (with `--text`) |
| `content_type` | `Content-Type` response header |
| `error` | Error message, if any |

## How it works

1. The scraper normalizes the start URL and loads `robots.txt`, unless you pass `--ignore-robots`.
2. If you pass `--use-sitemap`, it adds the URLs from `sitemap.xml` to the queue.
3. It fetches pages in batches, one link depth at a time, with up to `--workers` requests running at once. Only `200` responses with an HTML content type are saved.
4. It extracts links from each page and queues the new ones that pass these checks: same site, not a binary or asset file, matches the include/exclude filters, and allowed by `robots.txt`.
5. If you pass `--assets`, it downloads the assets referenced by each page (`<img>`, `<script>`, stylesheet and icon `<link>` tags, `<source>`, and links to asset files). Each asset is downloaded only once.
6. When the crawl finishes, it writes `index.csv`, `index.json` and `errors.log`.

Archives, executables and audio/video files (`.zip`, `.exe`, `.mp4`, `.mp3`, and similar) are never crawled.

## Notes

- `--max-pages` counts every URL that was fetched, including failed ones and non-HTML responses.
- Pages are fetched with plain HTTP requests, so content that JavaScript renders in the browser won't be captured.
- If you press `Ctrl+C`, the crawl stops right away. The pages saved so far stay on disk, but the index files are not written.
- The two versions apply `--timeout` slightly differently. In Python, it's the longest the scraper waits for the server to respond or send more data. In Node.js, it's the time limit for the whole request, including the download, so very large assets may need a higher value.
- When a request fails because of a connection problem or rate limiting, every worker pauses (not just the one that failed) and the request is retried. Lines starting with `[retry]` show this. If a site keeps blocking you, lower `--workers` and raise `--delay`.
- Crawl responsibly. Respect `robots.txt` and the site's terms of service, and keep `--delay` and `--workers` low enough that you don't overload the server.
