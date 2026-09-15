# LinkedIn Connection Cleaner

A local Node.js toolkit to download your 1st-degree LinkedIn connections, find unanswered inbound messages (“unrequited love”), review candidates, and bulk-remove the ones you don't want. Everything runs on your machine.

**Documentation:** [How to use it](https://bhealy.github.io/linkedin/readme.html) (executive summary + command reference) · [setup wizard & FAQ](https://bhealy.github.io/linkedin/)

---

## Features

- Local dashboard (`npm start`) at `http://127.0.0.1:3847/` — login, download, inbox cache/search, live analytics, protect contacts, dry-run and execute removals
- Live job ETAs while a download, inbox scan, or removal is running
- Downloads your full connections list via LinkedIn's connections-page pagination API, or only the last N months (`--months`)
- In-dashboard charts for connections and cached conversations; optional standalone `connections-analytics.html`
- Inbox cache + unrequited-love search: connections who messaged you and never got a reply
- Conversation page-open budget (2,000/hour, 4,000/4 hours) with pause, slower scheduled scan, or override
- Uses **installed Google Chrome**, not Puppeteer's Chrome for Testing build, so LinkedIn is less likely to serve a captcha on login
- Optional `LI_AT` cookie in `.env` to skip the password prompt when the saved Chrome profile has no session
- Optional people-search scraper to classify sales/recruitment contacts
- Bulk-remove with dry-run first, per-contact protect flags, founder/CEO/investor safe list, and company ignore list
- Resumes interrupted downloads, inbox cache, and removals — no data lost
- Tracks removed profiles so they're skipped on later runs

---

## Requirements

- Node.js 18+
- A LinkedIn account
- **Google Chrome** installed (the dashboard and CLI launch it via Puppeteer)

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

Optional: paste your `li_at` cookie from Chrome DevTools (Application → Cookies → `linkedin.com`) as `LI_AT=` to skip the password prompt on a **fresh** Chrome profile. A rejected cookie still sits in the jar, so the tool only treats login as successful if LinkedIn does not bounce you to login/authwall. A working session in `.linkedin-session/` is never overwritten by a stale `LI_AT`.

Do **not** put your password in `.env`. The dashboard passes it only for the job that needs it.

---

## Local dashboard (recommended)

```bash
npm start
```

Opens `http://127.0.0.1:3847/` (localhost only). Use it to:

1. Save your email and, if needed, a one-run password
2. Download connections (`months` / `limit` / fresh)
3. Cache the conversation list, then search for unrequited love
4. Explore connections and conversations in the Analytics tab
5. Review & protect contacts, preview a dry run, then execute removals

Live logs and ETAs stream in the page. **Stop / pause for now** keeps CSV and cache progress. LinkedIn login happens in a **Google Chrome** window when the saved session is missing. Only one job runs at a time.

The CLI commands below still work the same way.

---

## Recommended workflow

```bash
npm start                                 # dashboard, or use the CLI below
npm run connections:download              # 1. Export your network to connections.csv
npm run inbox:cache                       # 2. Page the inbox into unrequited-love.csv
npm run inbox:scan                        # 3. Open threads and flag unanswered inbound
npm run connections:analytics:open        # 4. Optional standalone HTML report
npm run connections:remove -- --csv unrequited-love.csv --limit 20   # 5. Dry-run
```

---

## Usage

### 1. Download your connections list

```bash
npm run connections:download
```

Opens Chrome, logs in to LinkedIn, and paginates through your connections list using LinkedIn's SDUI pagination API. Results are written to `connections.csv` after every batch. Progress is saved to `download-connections-state.json` so you can stop and resume at any time.

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

### 2. Cache the inbox, then search for unrequited love

A candidate is a 1st-degree connection who sent at least one message in a 1:1 thread **and you sent none**. The search itself never removes anyone.

**Cache first.** Search stays locked (in the dashboard) until the cache has paged to the oldest conversation. The cache uses LinkedIn's conversation list API and does not open threads.

```bash
npm run inbox:cache
npm run inbox:scan
npm run inbox:scan -- --days 90 --limit 50 --tabs 4
npm run inbox:scan:status
npm run inbox:cache -- --fresh
```

| Flag | Description |
|---|---|
| `--cache` | Page the conversation list into the CSV without opening threads. Re-running resumes from the last saved page |
| `--days` | How far back to look, by last activity (default 30) |
| `--limit` | Max conversations to **open** this run |
| `--tabs` | Parallel Chrome tabs for reading threads (default 4). Use 1 for a slower scan |
| `--override-page-budget` | Ignore the 2,000/hour and 4,000/4-hour conversation-page cap |
| `--pace-page-budget` | Wait for the cap to ease instead of pausing |
| `--csv` | Output path (default `unrequited-love.csv`) |
| `--fresh` | Back up, then reset the CSV and scan state |
| `--status` | Print scanned, found, and ready-to-remove counts |

Opening conversation pages is capped at **2,000 per hour** and **4,000 per 4 hours** (`inbox-page-opens.json`). The dashboard shows the count. When the cap is hit you can come back later, schedule a slower scan with fewer tabs, or override. LinkedIn may still challenge or restrict the account if you go over.

LinkedIn's own **Connections** inbox filter is not used: it stops after roughly 100 threads. Download `connections.csv` before searching. Group threads are skipped. Later runs skip threads whose last activity has not changed. Some candidates stay “awaiting profile name” until a later search visits the profile to resolve a duplicated name.

Review the CSV, then dry-run removals:

```bash
npm run connections:remove -- --csv unrequited-love.csv --limit 20
npm run connections:remove -- --execute --csv unrequited-love.csv --limit 20
```

### 3. Generate analytics dashboard

```bash
npm run connections:analytics
npm run connections:analytics:open
```

Builds a self-contained `connections-analytics.html` from `connections.csv`. The local UI also charts connections and conversations live in the Analytics tab (no HTML export required).

```bash
node generate-connections-analytics.js --input connections.csv --output report.html --open
```

### 4. Scrape connections by title (optional)

```bash
npm run scrape:sales
npm run scrape:status
npm run scrape:sales:fresh
```

Walks a keyword × geography grid in `search-plan.json`. Output: `sales-connections.csv` with status `sales` / `recruitment` / `sales_and_recruitment` / `not_target`. Skip this if you only want a full export, inbox search, and charts.

### 5. Remove connections

```bash
# Dry run — shows who would be removed, makes no changes
npm run connections:remove -- --status spam --limit 20

# Execute removals
npm run connections:remove -- --execute --status spam --limit 20
```

`--status spam` targets `sales`, `recruitment`, and `sales_and_recruitment` in one pass.

For an inbox CSV such as `unrequited-love.csv`, only people who sent **more than one** unanswered message are included by default. Pass `--include-single-message` to also remove people who sent a single unanswered message. A safe list is on by default (founders, C-suite, investors, board, selected owner/partner roles). Add phrases with `--safe-keywords`, or turn the list off with `--no-unrequited-safe-list`.

Use **Review & protect contacts** in the dashboard (or the CSV `protected` column) to keep individual people. All removal runs skip those rows. Default ignored company names in headlines: **Manna**, **Meili**.

| Flag | Description |
|---|---|
| `--execute` | Actually remove (omit for dry run) |
| `--status <value>` | `spam`, `sales`, `recruitment`, `sales_and_recruitment`, `not_target` |
| `--limit <n>` | Max connections to remove this run |
| `--ignore-company <name>` | Skip titles mentioning this company (repeatable) |
| `--ignore-companies <a,b>` | Comma-separated companies to ignore |
| `--safe-keywords` | Extra protected title words/phrases for inbox CSV removals |
| `--no-unrequited-safe-list` | Turn off the default protected-title list |
| `--include-single-message` | Also remove unrequited contacts who sent only one unanswered message |
| `--fresh` | Clear removal history and start fresh |
| `--csv <path>` | Use a different CSV file |

Removals are spaced ~1.2 seconds apart. Successful removals are marked `disconnected=yes` in the source inbox CSV and remembered in `connections.csv`.

### 6. Scrape an individual profile

```bash
npm run profile:scrape -- https://www.linkedin.com/in/your-profile/
npm run profile:scrape -- --vanity your-profile
node scrape-profile.js --skip-details
node scrape-profile.js --full-details
npm run profile:html:open
```

Default visits experience, education, and skills (~30–45s). `--full-details` visits every detail sub-page. Output lives under `profiles/` (gitignored).

---

## Files

| File | Purpose |
|---|---|
| `ui/server.js` | Local dashboard (localhost:3847) |
| `download-connections.js` | Full connections list downloader |
| `scan-inbox.js` | Inbox cache and unrequited-love search |
| `lib/inbox-page-budget.js` | Conversation page-open limits |
| `lib/job-eta.js` | Live ETA from job progress logs |
| `lib/linkedin-auth.js` | Chrome launch, session, `LI_AT` injection |
| `generate-connections-analytics.js` | Standalone analytics HTML generator |
| `scrape-sales-connections.js` | Keyword × geography people-search scraper |
| `remove-connections.js` | Bulk removal script |
| `scrape-profile.js` | Single-profile archive |
| `search-plan.json` | Keyword × geography grid config |
| `connections.csv` | Download output (gitignored) |
| `unrequited-love.csv` | Inbox cache + candidates (gitignored) |
| `inbox-page-opens.json` | Page-open timestamps for the budget (gitignored) |
| `connections-analytics.html` | Analytics dashboard output (gitignored) |
| `download-connections-state.json` | Download resume state (gitignored) |
| `inbox-scan-state.json` | Inbox resume state (gitignored) |
| `sales-connections.csv` | Search scrape output (gitignored) |
| `scrape-state.json` | Scrape resume state (gitignored) |
| `remove-connections-state.json` | Tracks removed profiles (gitignored) |
| `.linkedin-session/` | Logged-in Chrome profile (gitignored) |
| `.env` | Your email / optional cookie (gitignored) |

---

## Notes

- Uses Puppeteer with **your installed Google Chrome** and a persistent profile in `.linkedin-session/`. The bundled Chrome-for-Testing build reports `navigator.webdriver = true` and often draws a captcha; real Chrome with automation switches off does not.
- `--no-sandbox` is not used on launch (unnecessary on macOS and a known automation signature).
- Nothing is sent to any external service except LinkedIn itself.
- The connections downloader uses LinkedIn's `/flagship-web/rsc-action/actions/pagination` endpoint.
- Inbox search opens real messaging pages; stay inside the page-open budget and prefer `--tabs 1` if LinkedIn starts challenging you.
- The analytics HTML embeds your contact data — keep it private.
- LinkedIn caps people search at ~250 per query; the keyword × geography grid works around this for the sales/recruitment scraper.
- Never commit `.env`, CSV exports, analytics HTML, `inbox-page-opens.json`, or browser session data — see `.cursor/rules/no-sensitive-git-commits.mdc`
