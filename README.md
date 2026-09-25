# KPPP-NEEWWW

Karnataka Tender Intelligence — Cloudflare Worker (`worker/`) serving the static site in `public/`.

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

Locally, copy `.dev.vars.example` → `.dev.vars` (never commit `.dev.vars`).

## Tender data

- The hourly GitHub Action (`.github/workflows/collect-kppp.yml`) collects tenders from KPPP and commits `public/tenders.json` + `public/health.json`; the Worker reads them from this repo and falls back to the deployed copy.
- KPPP's public tender list does not include EMD or tender fee, and some departments hide the tender value, so those columns can be empty.
- TenderKart blocks automated lookups with a bot check, so the tender popup links to a TenderKart search instead of loading its data.

## Notes

- Admin is seeded into KV (`AUTH_STORE`) and stays in sync with `ADMIN_PASSWORD`.
- Optional: `ADMIN_RESET=true` once, then remove it.
- Admins manage users at `/admin.html`.

## Cloudflare auto-deploy (built-in)

Workers → Settings → Build / Connect to Git → `kppp` repo → branch `main`.
