# TenderOne

Karnataka tender desk — a Cloudflare Worker (`worker/index.js`) serving the site in `public/` (`index.html`, `app.js`, `app.css`). No login: every visitor sees the live tenders.

## Tender data

The hourly GitHub Action (`.github/workflows/collect-kppp.yml`) runs:

1. `fetch_kppp.py` — collects every published tender from KPPP into `public/tenders.json`.
2. `fix_financial_fields.py` — keeps the best tender value from the raw KPPP fields.
3. `enrich_fees.py` — adds EMD and tender fee from KPPP's public per-tender "general info" endpoint, cached in `data/kppp-fees.json` so each run only looks up new tenders.
4. `build_lite.py` — writes `public/tenders-lite.json`, the small file the website loads, with districts matched from KPPP office names.

An action every 4 hours (`.github/workflows/collect-results.yml`) runs `collect_results.py`, which stores awarded works tenders (goods and services are not collected) — winner, every bidder's quoted total and rank from KPPP's public comparative statement — in `public/results-lite.json` (cached in `data/results-cache.json`). Each run looks up as many as it can in 20 minutes; tenders it lists but does not reach wait in `data/results-state.json` and go first in the next run. It also stores every bidder's item-wise quoted rates (`data/item-rates-cache.json`) and builds `public/rates-lite.json`: for each BOQ item (schedule code + unit + description), what winning (L1) bidders quoted against the department's rate. The tender page shows these under each BOQ item. The bid % is computed against the tender's estimated value, because the % in KPPP's statement double-counts the estimate.

The Worker serves the data files from this repo, falling back to the deployed copy. TenderKart blocks automated lookups, so tenders link to a TenderKart search instead.

## Deploying

Cloudflare builds and deploys the Worker (`santoshpawar863006-ctrl`, serving tenderone.online, configured in `wrangler.jsonc`) from this repo's `main` branch through its Git integration (Worker → Settings → Build). No secrets are needed.

To run locally: `npm ci && npx wrangler dev`.
