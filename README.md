# TenderOne

Karnataka tender desk — a Cloudflare Worker (`worker/`) serving the site in `public/` (`index.html`, `app.js`, `app.css`, plus `login.html` and `admin.html`).

Sign in at `/login.html` with the admin account created from the `ADMIN_USERNAME` / `ADMIN_PASSWORD` secrets below.

## Cloudflare Worker secrets (required for production)

Open the **exact Worker that serves your live URL** (check the hostname / Workers list — it may be named `karnataka-tender-intelligence`, `kppp`, or `santoshpawar863006-ctrl`):

**Settings → Variables and Secrets** (runtime, not Build variables):

| Name | Purpose |
|---|---|
| `ADMIN_USERNAME` | Bootstrap admin login |
| `ADMIN_PASSWORD` | Bootstrap admin password |
| `ADMIN_NAME` | Display name |
| `SESSION_SECRET` | Random string (`openssl rand -base64 48`) |

Open **System Health** in the app to check the **Secret Bindings** card: it shows whether the admin password, session secret and login storage are set on this Worker.

`wrangler.jsonc` sets `keep_vars: true` so dashboard variables are not wiped on Git deploys.

Locally, copy `.dev.## Tender data

The hourly GitHub Action (`.github/workflows/collect-kppp.yml`) runs:

1. `fetch_kppp.py` — collects every published tender from KPPP into `public/tenders.json`.
2. `fix_financial_fields.py` — keeps the best tender value from the raw KPPP fields.
3. `enrich_fees.py` — adds EMD and tender fee from KPPP's public per-tender "general info" endpoint, cached in `data/kppp-fees.json` so each run only looks up new tenders.
4. `build_lite.py` — writes `public/tenders-lite.json`, the small file the website loads, with districts matched from KPPP office names.

The Worker serves the data files from this repo (falling back to the deployed copy) to signed-in users only. TenderKart blocks automated lookups, so tenders link to a TenderKart search instead.

nks to a TenderKart search instead of loading its data.

## Notes

- Admin is seeded into KV (`AUTH_STORE`) and stays in sync with `ADMIN_PASSWORD`.
- Optional: `ADMIN_RESET=true` once, then remove it.
- Admins manage users at `/admin.html`.

## Deploying

`.github/workflows/deploy-cloudflare.yml` deploys the Worker on every change to `main` once the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets are set.
