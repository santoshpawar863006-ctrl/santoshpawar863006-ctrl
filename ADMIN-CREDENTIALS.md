# Admin credentials (local / demo)

Use these to sign in at `/login.html`.

| Field | Value |
|---|---|
| Username | `admin` |
| Password | `Admin@KPPP2026!` |
| Role | Administrator |

## Cloudflare Worker secrets (required for production)

Open your **deployed Worker** → **Settings** → **Variables and Secrets** (runtime secrets, not Build variables) and set:

| Name | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude bid calculator (`sk-ant-…` from console.anthropic.com) |
| `ADMIN_USERNAME` | Bootstrap admin login |
| `ADMIN_PASSWORD` | Bootstrap admin password |
| `ADMIN_NAME` | Display name |
| `SESSION_SECRET` | Random string (`openssl rand -base64 48`) |

Build/CI variables do **not** become Worker `env` values. If Claude says the key is missing, the secret is not on the Worker runtime.

Locally, put the same keys in `.dev.vars` (never commit that file).

## Why Cloudflare can show “Refer tender” while localhost looks complete

1. **Claude** — localhost loads `ANTHROPIC_API_KEY` from `.dev.vars`; Cloudflare only sees Worker secrets.
2. **TenderKart / BidAssist enrichment** — the UI fills missing amounts via `/api/public_tender_detail`. TenderKart often returns a bot-challenge page to Cloudflare Workers, so enrichment fails in production even when localhost still shows old browser `localStorage` cache.
3. **Base amounts** still come from the hourly GitHub `tenders.json` collector. After deploy, hard-refresh and check System Health → `anthropic.configured` and `tenderkart.blocked_by_bot_protection`.

## Notes

- On first Worker start, the admin account is seeded into Cloudflare KV (`AUTH_STORE`).
- The bootstrap admin password stays in sync with `ADMIN_PASSWORD`.
- Optional: set `ADMIN_RESET=true` once to force a reset, then remove it.
- Admins manage users at `/admin.html`.

## Cloudflare auto-deploy (built-in)

Workers → Settings → Build / Connect to Git → `kppp` repo → branch `main` → deploy with `npx wrangler deploy`. Ensure `wrangler.jsonc` has a real `AUTH_STORE` KV namespace ID.
