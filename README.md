# TenderOne

Karnataka tender desk — a Cloudflare Worker (`worker/index.js`) serving the site in `public/` (`index.html`, `app.js`, `app.css`). No login: every visitor sees the live tenders.

## Tender data

The hourly GitHub Action (`.github/workflows/collect-kppp.yml`) runs:

1. `fetch_kppp.py` — collects every published tender from KPPP into `public/tenders.json`.
2. `fix_financial_fields.py` — keeps the best tender value from the raw KPPP fields.
3. `enrich_fees.py` — adds EMD and tender fee from KPPP's public per-tender "general info" endpoint, cached in `data/kppp-fees.json` so each run only looks up new tenders.
4. `build_lite.py` — writes `public/tenders-lite.json`, the small file the website loads, with districts matched from KPPP office names.

An action every 2 hours (`.github/workflows/collect-results.yml`) runs `collect_results.py`, which stores awarded tenders — winner, every bidder's quoted total and rank from KPPP's public comparative statement (works and goods) — in `public/results-lite.json` (cached in `data/results-cache.json`). Each awarded tender also gets an award page, `data/awards/{nitId}.json`: timeline (closing → bids opened → approved → performance guarantee → award), officers, and every bidder's item-wise rates. From those it builds `public/rates-lite.json`: for each BOQ item (schedule code + unit + description), what winning (L1) bidders quoted against the department's rate. The bid % is computed against the tender's estimated value, because the % in KPPP's statement double-counts the estimate.

An hourly action (`.github/workflows/collect-details.yml`) runs `collect_details.py`, which keeps a copy of every live tender's full KPPP details and documents list in the `data` branch (`details/{CATEGORY}/{nitId}.json`, one snapshot commit that replaces the last). The website serves that copy, so tender pages open instantly, and asks KPPP live only for tenders not collected yet. When a department changes the closing date, EMD, fee, value or documents, the change is recorded and shown on the tender page.

Data commits say `[skip ci]`: the website reads the data straight from GitHub, so only code changes need a redeploy.

The Worker serves the data files from this repo, falling back to the deployed copy. TenderKart blocks automated lookups, so tenders link to a TenderKart search instead.

## Deploying

Cloudflare builds and deploys the Worker (`santoshpawar863006-ctrl`, serving tenderone.online, configured in `wrangler.jsonc`) from this repo's `main` branch through its Git integration (Worker → Settings → Build). No secrets are needed.

To run locally: `npm ci && npx wrangler dev`.
