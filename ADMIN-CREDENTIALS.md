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
SESSION_SECRET=change-me-to-a-long-random-string
```

## Notes

- On first Worker start, the admin account is seeded into Cloudflare KV (`AUTH_STORE`).
- Change the password immediately for any shared or production environment.
- To force-reset the admin password from `.dev.vars`, set `ADMIN_RESET=true`, restart Wrangler once, then remove that flag.
- Admins manage users at `/admin.html` (add / deactivate / remove / reset password).
