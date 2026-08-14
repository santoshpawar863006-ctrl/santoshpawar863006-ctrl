# Admin credentials (local / demo)

Use these to sign in at `/login.html`.

| Field | Value |
|---|---|
| Username | `admin` |
| Password | `Admin@KPPP2026!` |
| Role | Administrator |

These defaults are also set in `.dev.vars` as:

```bash
ADMIN_USERNAME=admin
ADMIN_PASSWORD=Admin@KPPP2026!
ADMIN_NAME=System Administrator
SESSION_SECRET=replace-with-a-long-random-string
```

## Notes

- On first Worker start, the admin account is seeded into Cloudflare KV (`AUTH_STORE`).
- In production, set the same values as **Worker secrets** in the Cloudflare dashboard (`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_NAME`, `SESSION_SECRET`).
- The bootstrap admin password is kept in sync with `ADMIN_PASSWORD` from Worker secrets. After changing the secret, sign in with the new password.
- Optional: set `ADMIN_RESET=true` once to force a reset, then remove it.
- Change the password immediately for any shared or production environment.
- Admins manage users at `/admin.html` (add / deactivate / remove / reset password).

## Cloudflare auto-deploy (built-in)

Use Cloudflare Workers Builds (Git integration), not GitHub Actions:

1. Cloudflare Dashboard → **Workers & Pages** → your Worker (`karnataka-tender-intelligence`)
2. **Settings** → **Build** / **Connect to Git** → select the `kppp` GitHub repo
3. Production branch: `main`
4. Build/deploy command should be `npx wrangler deploy` (or Cloudflare’s Workers default)
5. Ensure `wrangler.jsonc` has your real KV namespace ID for `AUTH_STORE`

Worker secrets stay in Cloudflare → Worker → **Settings** → **Variables and Secrets**.
