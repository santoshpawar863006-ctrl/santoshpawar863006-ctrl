# Admin credentials (local / demo)

Use these to sign in at `/login.html`.

| Field | Value |
|---|---|
| Username | `admin` |
| Password | `Admin@KPPP2026!` |
| Role | Administrator |

## Cloudflare Worker secrets (required for production)

Open the **exact Worker that serves your live URL** (check the hostname / Workers list — it may be named `karnataka-tender-intelligence`, `kppp`, or `santoshpawar863006-ctrl`):

**Settings → Variables and Secrets** (runtime, not Build variables):

| Name | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude bid calculator |
| `ADMIN_USERNAME` | Bootstrap admin login |
| `ADMIN_PASSWORD` | Bootstrap admin password |
| `ADMIN_NAME` | Display name |
| `SESSION_SECRET` | Random string (`openssl rand -base64 48`) |

### Verify the key is on the right Worker

After deploy, open:

`https://YOUR-WORKER.workers.dev/api/debug/env`

You should see `"ANTHROPIC_API_KEY": true`. If it is `false`, the secret is on a different Worker or only set as a Build variable.

Also check **System Health** in the app — it now shows Claude + secret binding status.

`wrangler.jsonc` sets `keep_vars: true` so dashboard variables are not wiped on Git deploys.

Locally, copy `.dev.vars.example` → `.dev.vars` (never commit `.dev.vars`).

## Why Cloudflare can look emptier than localhost (`KPPP-NEEWWW` on :8787)

1. **Claude** — localhost reads `.dev.vars`; Cloudflare only sees Worker runtime secrets on that script.
2. **TenderKart enrichment** — fills many “Refer tender” cells. TenderKart often bot-blocks Cloudflare Workers; localhost may still show old browser `localStorage` cache.
3. Base tender list still comes from the GitHub collector / deployed `tenders.json`.

## Notes

- Admin is seeded into KV (`AUTH_STORE`) and stays in sync with `ADMIN_PASSWORD`.
- Optional: `ADMIN_RESET=true` once, then remove it.
- Admins manage users at `/admin.html`.

## Cloudflare auto-deploy (built-in)

Workers → Settings → Build / Connect to Git → `kppp` repo → branch `main`.
