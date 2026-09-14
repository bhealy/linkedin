# LinkedIn Connection Cleaner

A Node.js tool to download your 1st-degree LinkedIn connections, classify them by job title (sales, recruitment, or neither), and bulk-remove the ones you don't want.

**Documentation:** [How to use it](https://bhealy.github.io/linkedin/readme.html) (executive summary + deeper dive) · [setup wizard & FAQ](https://bhealy.github.io/linkedin/)

---

## Features

- Downloads your full connections list via LinkedIn's connections-page pagination API, or only the last N months (`--months`)
- Generates a local analytics dashboard with charts, role breakdown, and searchable contact table
- Scrapes 1st-degree connections via LinkedIn people search using a keyword × geography grid (for title-based discovery)
- Classifies each connection as `sales`, `recruitment`, `sales_and_recruitment`, or `not_target`
- Exports results to CSV with name, title, profile URL, and status
- Resumes interrupted downloads/scrapes automatically — no data lost
- Bulk-removes connections by status, with dry-run mode before anything is deleted
- Tracks removed profiles so they're skipped on future runs
- Ignores connections at specified companies (e.g. colleagues)
- Local web dashboard (`npm start`) on 127.0.0.1 to run download, analytics, and removals without the CLI

---

## Requirements

- Node.js 18+
- A LinkedIn account

---

## Setup

```bash
git clone https://github.com/bhealy/linkedin.git
cd linkedin
npm install
cp .env.example .env
```

Edit `.env` and set your LinkedIn email:

```
LINKEDIN_EMAIL=you@example.com
```

### Local dashboard (easiest on a Mac)

```bash
npm start
```

Opens `http://127.0.0.1:3847/` in your browser (localhost only). Use it to save your email, start a download (`--months` / `--limit` / fresh), generate analytics, and dry-run or execute removals. Live logs stream in the page. Your password is sent only for that job and is **not** written to `.env`. LinkedIn login still happens in the Puppeteer Chromium window when a session is missing. Cancel stops the running job.

The CLI commands below still work the same way.

---

## Recommended workflow

```bash
npm run connections:download          # 1. Export your network to connections.csv
npm run connections:analytics:open    # 2. Explore the analytics dashboard
npm run scrape:sales                  # 3. (Optional) Classify sales/recruitment via people search
npm run connections:remove -- --status spam --limit 20   # 4. Dry-run removals
```

---

## Usage

### 1. Download your connections list

```bash
npm run connections:download
```

Opens a browser window, logs in to LinkedIn, and paginates through your connections list using LinkedIn's SDUI pagination API. Results are written to `connections.csv` after every batch. Progress is saved to `download-connections-state.json` so you can stop and resume at any time.

```bash
npm run connections:download:status   # show download progress
npm run connections:download:fresh    # reset download state and CSV
node download-connections.js --resume # continue if wrongly marked complete
```

`connections.csv` columns:

| Column | Description |
|---|---|
| `name` | Full name |
| `title` | LinkedIn headline |
| `profile_url` | LinkedIn profile URL |
| `vanity_name` | Profile slug (used for removal) |
| `connected_on` | Connection date as shown on LinkedIn |

The downloader fetches up to **5,000 new contacts per run**. Run it again to continue (e.g. 5,000 → 10,000). Pagination requests are spaced with a **random 1–10 second delay** to reduce rate-limit risk.

To download only recent connections (LinkedIn lists newest first), stop paging once dates fall outside the window:

```bash
npm run connections:download -- --fresh --months 6
npm run connections:download -- --months 3 --limit 5000
```

`--months N` keeps contacts connected on or after today minus N calendar months. Use `--fresh --months N` for a CSV that only contains that window. Without `--fresh`, older rows already in `connections.csv` are kept. After the window is complete, `--resume` continues into older connections.

### 2. Generate analytics dashboard

```bash
npm run connections:analytics
```

Builds a self-contained `connections-analytics.html` dashboard from `connections.csv` — network growth timeline, seniority and role charts, weekday patterns, top companies & keywords, recent connections, and a searchable contact table. All data stays local in the generated HTML file.

```bash
npm run connections:analytics:open   # generate and open in your browser
```

You can also pass custom paths:

```bash
node generate-connections-analytics.js --input connections.csv --output report.html --open
```

#### Analytics dashboard includes

| Section | What it shows |
|---|---|
| Overview stats | Total connections, unique companies, dated profiles, headline length |
| Growth timeline | New connections by month |
| Role & seniority | Functional categories and seniority inferred from headlines |
| Top companies & keywords | Most mentioned organisations and headline terms |
| Contact explorer | Searchable, filterable table of every contact |

### 3. Scrape connections by title (optional)

Use this if you want to find sales/recruitment contacts via people search rather than downloading your full list:

```bash
npm run scrape:sales
```

Opens a browser window and works through a grid of keyword × geography searches. Results are written to `sales-connections.csv` after every page. Progress is saved to `scrape-state.json`.

```bash
npm run scrape:status        # show grid progress summary
npm run scrape:sales:fresh   # reset scrape progress (keeps existing CSV rows)
```

`sales-connections.csv` columns:

| Column | Description |
|---|---|
| `name` | Full name |
| `title` | LinkedIn headline |
| `profile_url` | LinkedIn profile URL |
| `status` | `sales` / `recruitment` / `sales_and_recruitment` / `not_target` |
| `search_id` | Which keyword × geo cell found them |
| `geo` | Geography label |

### 4. Remove connections

```bash
# Dry run — shows who would be removed, makes no changes
npm run connections:remove -- --status spam --limit 20

# Execute removals
npm run connections:remove -- --execute --status spam --limit 20
```

`--status spam` targets all of `sales`, `recruitment`, and `sales_and_recruitment` in one pass. You can also target individual statuses:

```bash
npm run connections:remove -- --execute --status not_target --limit 50
npm run connections:remove -- --execute --status sales --limit 50
npm run connections:remove -- --execute --status recruitment --limit 50
```

#### Options

| Flag | Description |
|---|---|
| `--execute` | Actually remove (omit for dry run) |
| `--status <value>` | Filter by status: `spam`, `sales`, `recruitment`, `sales_and_recruitment`, `not_target` |
| `--limit <n>` | Max connections to remove in this run |
| `--ignore-company <name>` | Skip connections whose title mentions this company (can repeat) |
| `--ignore-companies <a,b>` | Comma-separated list of companies to ignore |
| `--fresh` | Clear removal history and start fresh |
| `--csv <path>` | Use a different CSV file |

Default ignored companies: **Manna**, **Meili** (colleagues). Add more with `--ignore-company`.

---

## Files

| File | Purpose |
|---|---|
| `download-connections.js` | Full connections list downloader |
| `lib/connected-date.js` | Parse LinkedIn “Connected on” dates and months-window cutoff |
| `generate-connections-analytics.js` | Analytics dashboard generator |
| `lib/connections-analytics.js` | Analytics computation |
| `lib/render-connections-analytics-html.js` | Dashboard HTML renderer |
| `lib/connections-csv.js` | Shared CSV loader |
| `lib/parse-sdui-connections.js` | Parser for LinkedIn SDUI pagination responses |
| `scrape-sales-connections.js` | Keyword × geography people-search scraper |
| `remove-connections.js` | Bulk removal script |
| `search-plan.json` | Keyword × geography grid config |
| `connections.csv` | Download output (gitignored) |
| `connections-analytics.html` | Analytics dashboard output (gitignored) |
| `download-connections-state.json` | Download resume state (gitignored) |
| `sales-connections.csv` | Search scrape output (gitignored) |
| `scrape-state.json` | Scrape resume state (gitignored) |
| `remove-connections-state.json` | Tracks removed profiles (gitignored) |
| `.env` | Your credentials (gitignored — never committed) |

---

## Notes

- Uses Puppeteer with your local LinkedIn session — nothing is sent to any external service
- The connections downloader uses LinkedIn's `/flagship-web/rsc-action/actions/pagination` endpoint on the connections page — faster and more complete than people search for getting your full list
- The analytics dashboard is a static HTML file — open it locally in any browser; it embeds your contact data so keep it private
- LinkedIn caps people search results at ~250 per query; the keyword × geography grid works around this for the sales/recruitment scraper
- Removals are spaced ~1.2 seconds apart to avoid rate limiting
- The people-search scraper supports both old and new LinkedIn search result DOM layouts
- Never commit `.env`, CSV exports, analytics HTML, or browser session data — see `.cursor/rules/no-sensitive-git-commits.mdc`

### 5. Scrape an individual profile

Export a single LinkedIn profile to structured JSON for cross-network portability:

```bash
npm run profile:scrape -- https://www.linkedin.com/in/your-profile/
npm run profile:scrape -- --vanity your-profile
node scrape-profile.js --skip-details    # ~35s: main page + API only
node scrape-profile.js --full-details    # ~2min: all 12 detail sub-pages
```

**Speed:** The default now visits **3 detail pages** (experience, education, skills) plus batched API calls (~30–45s). The previous behaviour visited **12 detail pages** with a **1.5s delay** before each step, which is why a full run took ~2.5 minutes. Use `--full-details` only if you need every section archived to `dom/`.

| Path | Contents |
|---|---|
| `profile.json` | Normalized profile (identity, experience, education, skills, etc.) |
| `profile.html` | Self-contained visual profile page — open in any browser |
| `manifest.json` | Scrape metadata and section counts |
| `raw/` | Raw Voyager API responses |
| `dom/` | DOM snapshots from main and detail pages |

The scraper uses your saved LinkedIn session, fetches Voyager API data, and visits detail sub-pages (experience, education, skills by default). `profiles/` is gitignored.

Regenerate the HTML page from an existing export:

```bash
npm run profile:html:open
node generate-profile-html.js profiles/your-profile/profile.json --open
```
