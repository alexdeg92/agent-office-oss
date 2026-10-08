# Upgrade from v1

This is for an install that still runs the earlier single-page app (taco-portal, the v1 routes under `/api`). A later upgrade of an install that is already on this design is [upgrading.md](upgrading.md). Paths below are the defaults. Point them at your own directories when you have set `AO_DATA_DIR` or an env file somewhere else.

Keep a copy of the env file before you edit it. `agent-office check-config --env-file <file>` prints `ok` or `missing` and does not print values. Do not start the new process against the live data directory until that check passes.

## Environment

These names stay: `PORTAL_EMAIL`, `PORTAL_SECRET`, `OC_GATEWAY_TOKEN`, `PORT`, `HOST`, `NODE_ENV`. Keep the same `PORTAL_SECRET`. It signs the session cookie. A new secret signs everyone out.

Replace `PORTAL_PASSWORD` with `PORTAL_PASSWORD_HASH`:

```sh
agent-office hash-password
```

On a terminal it asks twice and does not echo. Otherwise it reads the password from stdin. It does not take the password as an argument or from the environment, and it prints only the `scrypt:…` line. Paste that line into the env file, then delete `PORTAL_PASSWORD`. This release still accepts the plaintext variable, and it logs a warning. The hash is the one to keep.

New names you are likely to set:

| Variable | When |
| --- | --- |
| `AO_ENV` | `production`, `staging`, `dev`, or `test`. If unset: `staging` when `PORTAL_READONLY=1`, `production` when `NODE_ENV=production`, otherwise `dev`. The data directory belongs to that value for its whole life. |
| `AO_DATA_DIR` | Store directory. Unset uses `$XDG_DATA_HOME/agent-office` (or `~/.local/share/agent-office`) for production. Staging and dev use `agent-office-staging` and `agent-office-dev` beside it, and they refuse the production directory. |
| `AO_API_ONLY` | `1` on the API process when a reverse proxy splits the UI and the API. The process serves no pages. |
| `AO_PUBLIC_URL` | Origin people type in the browser, `scheme://host[:port]`, no path. Set it when that origin is not a loopback name. |
| `AO_PUBLIC_API_BASE` | Prefix the browser uses to call the API. Default `/backend` when `AO_API_ONLY=1`, otherwise empty. |
| `AO_RUNTIME` | `openclaw` (default) or `demo`. Demo needs no gateway token. |
| `AO_TRUST_PROXY` | Who may set `X-Forwarded-For` for the login throttle. Default `loopback`. Name your proxy's address or range when the API sits behind one. |
| `PORTAL_COOKIE_SECURE` | `1` or `0`. Unset means on for `AO_ENV=production` and off otherwise. Plain HTTP needs `0`, or the browser will not send the cookie. |
| `AO_PROJECTS_OWNERS`, `AO_PROJECTS_ROOT` | Code-host owners and a workspace root. Discovery stays off until one of them is set. There is no default owner and no default path. |

`PORTAL_DISPLAY_NAME`, `PORTAL_READONLY`, and `PORTAL_READONLY_STORE` are unchanged in meaning. The full list is [config.md](config.md).

## Topology

v1 was one process: the old page at `/`, and `/api/…` on the same port (18789 unless you moved it).

`agent-office start` is still one public port. The new interface is at `/`. The API is at `/backend` (`/backend/api/v2` and `/backend/api/v3`). That process forwards `/backend` to an API-only child and strips the prefix. The old `/api/…` routes no longer exist (they were removed in this release; only `/api/login`, `/api/logout` and `/api/me` remain).

A process you start as `node server.js` without `AO_API_ONLY` still serves pages itself: the new interface under `/v2/` (the old page's addresses redirect there). The API on that process is `/api/v2` and `/api/v3` (there is no `/backend` prefix unless you set `AO_PUBLIC_API_BASE`).

A split install is two processes behind one origin:

- `/` is the web process (`agent-office web`, port 8080 by default).
- `/backend` is the API process (`AO_API_ONLY=1`). The proxy strips `/backend` before the request reaches it. Do not compress or buffer `text/event-stream`. The live stream is `/backend/api/v2/stream` (or `/api/v3/stream` on the API's own port).

There is no CORS. The browser talks to one origin. The new UI calls `/backend/api/…`.

## Data directory and migrations

v1 did not use this store. The first start creates it.

| `AO_ENV` | Directory |
| --- | --- |
| production | `~/.local/share/agent-office/` |
| staging | `~/.local/share/agent-office-staging/` |
| dev | `~/.local/share/agent-office-dev/` |

`$XDG_DATA_HOME` replaces `~/.local/share` when it is set. `AO_DATA_DIR` replaces the whole path. The directory is mode `0700`. The database file is `agent-office.sqlite` (mode `0600`), plus the `-wal` and `-shm` files SQLite adds.

If that file already exists (a rehearsal, or an earlier build of this design), the process applies any pending numbered migration, 001 through 009, when it opens the store. Before it applies one to a database that already has a schema, it writes a backup under `backups/` named `agent-office-premigrate-vNNN-<timestamp>.sqlite`. Migrations only move forward. A database whose schema is newer than the program refuses to start, and the files are left as they were. A directory whose `store_meta.instance` is a different `AO_ENV` also refuses to start, before anything is written.

Do not point staging or dev at the production directory. Do not delete the directory as part of the upgrade.

## Rollback

1. Stop the new process.
2. Put the previous program back, and put the previous env file back if you changed it.
3. If a migration ran and the previous program refuses the store (`schema-too-new`), stop the process and copy the newest `backups/agent-office-premigrate-v*.sqlite` over `agent-office.sqlite`. Remove the `-wal` and `-shm` files beside it only after the process is stopped. The backup is the database from before that migration. Keep the copy you did not restore.
4. Start the previous program and confirm the old page answers.

The new program no longer contains the old API or the old page, so going back means running the previous program (steps 1 to 4). `AO_LEGACY_V1`, which mounted them again during the go-live window, is gone; setting it changes nothing.

Leave the data directory in place either way. The runtime's own home (the OpenClaw directory) is not part of this upgrade and is not written by it, apart from the existing skill on/off switch.

## What does not change

The session cookie is still named `taco_sess`. Renaming it would sign everyone out, so it stays. It is `Path=/`, with no `Domain`, `HttpOnly`, and `SameSite=Lax`. `Secure` is added in production unless `PORTAL_COOKIE_SECURE=0`. The same `PORTAL_SECRET` keeps an existing cookie valid until it expires (12 hours). Logout now revokes that session on the server, so a copied cookie stops working at once.

`OC_GATEWAY_TOKEN`, the gateway URL, and the runtime home are the same variables as before. The login email is the same variable.
