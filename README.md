# TenderOne

Karnataka tender desk — a Cloudflare Worker (`worker/index.js`) serving the site in `public/` (`index.html`, `app.js`, `app.css`). No login: every visitor sees the live tenders.

## Tender data

The hourly GitHub Action (`.github/workflows/collect-kppp.yml`) runs:

1. `fetch_kppp.py` — collects every published tender from KPPP into `public/tenders.json`.
2. `fix_financial_fields.py` — keeps the best tender value from the raw KPPP fields.
3. `enrich_fees.py` — adds EMD and tender fee from KPPP's public per-tender "general info" endpoint, cached in `data/kppp-fees.json` so each run only looks up new tenders.
4. `build_lite.py` — writes `public/tenders-lite.json`, the small file the website loads, with districts matched from KPPP office names.

The Worker serves the data files from this repo, falling back to the deployed copy. TenderKart blocks automated lookups, so tenders link to a TenderKart search instead.

## Deploying

Cloudflare builds and deploys the Worker (`karnataka-tender-intelligence`, configured in `wrangler.jsonc`) from this repo's `main` branch through its Git integration (Worker → Settings → Build). No secrets are needed.

To run locally: `npm ci && npx wrangler dev`.
