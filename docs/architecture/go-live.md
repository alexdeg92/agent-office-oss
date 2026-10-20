# Go-live: cut-over checklist (replaces S16's cut-over)

Status: draft (GL, architect, 2026-10-05). Executed by the **operator**. Agents never run service operations.
Go-live happens after S7. The ADR-001 platform steps (G3–G5) continue afterwards on the live system.

## Target topology

```
https://office.example.com/          → the static web service (the v2 UI, frontend-owned; SPA fallback; og:* from instance.publicUrl)
https://office.example.com/backend/  → Traefik StripPrefix(/backend) → Agent Office API (AO_API_ONLY=1) on 172.30.0.1:<port>
```

- **The API runs API-only** (`AO_API_ONLY=1`). It serves no static files and no SPA fallback, and every non-API path is the v2 JSON 404. It never emits a `Location` header, so the stripped prefix can't leak.
  - Covered by `test/api/topology.test.js`, which puts a real stripping proxy in front of the server and checks login, cookies, SSE, the 404s and logout.
- **The cookie** `taco_sess` is unchanged: `Path=/`, no `Domain`, `HttpOnly; SameSite=Lax`, and `Secure` in production (`PORTAL_COOKIE_SECURE` defaults to on for the production instance). The UI and the API share one origin, so there's no CORS. The UI calls `/backend/api/...` (frontend's API base setting).
- **SSE** (`/backend/api/v2/stream`): Traefik streams by default. **Don't put a compress or buffering middleware on the `/backend` router.** If one is ever needed for other routes, exclude `text/event-stream`. Heartbeats every 25 s keep idle connections open through Traefik's default timeouts.
- **Logout** is server-side revocation (R1-09): copied cookies stop working, and open streams close with `system{closing:'logged-out'}`.

## Production profile

Set in the production env file (`~/.config/agent-office.env` today; the instance config file in G4). Secrets stay in env.

| Setting | Value | Why |
| --- | --- | --- |
| `AO_ENV` | `production` | instance identity; the store refuses another instance's data dir |
| `NODE_ENV` | `production` | |
| `AO_API_ONLY` | `1` | topology above (v1 no longer exists in any topology since S16) |
| ~~`AO_LEGACY_V1`~~ | — | **removed at S16** (`s16-v1-removal.md`): it means nothing now. The rollback target is the previous agent-office service from the main branch, not v1 inside the new code |
| `PORT` / `HOST` | new port (e.g. `18790`) / `0.0.0.0` | runs **beside** the old service until cut-over |
| `PORTAL_READONLY`, `PORTAL_READONLY_STORE` | **unset** | writes enabled (OpenClaw and store) |
| `AO_DATA_DIR` | unset → `~/.local/share/agent-office` | the production data dir (0700); staging keeps `~/.local/share/agent-office-staging` |
| `PORTAL_COOKIE_SECURE` | unset → on | HTTPS only |
| `PORTAL_DISPLAY_NAME` | `Owner` | MeVM / owner Person |
| `AO_PROJECTS_OWNERS`, `AO_PROJECTS_ROOT` | `alexdeg92`, Owner's workspace root | discovery and repo refresh are off until configured (ADR §12.1, since G2). **Staging needs them too.** |
| `OC_GATEWAY_TOKEN`, `PORTAL_EMAIL`, `PORTAL_SECRET` | as today | secrets |
| **`PORTAL_PASSWORD_HASH`** | `node scripts/hash-password.js` (or `agent-office hash-password`), typed by Owner | **replaces `PORTAL_PASSWORD`**: remove the plaintext from the env file (PM audit (A)) |
| `AO_TRUST_PROXY` | **`loopback,172.30.0.0/16`** (default: `loopback` only) | only Traefik's Docker network may set `X-Forwarded-For` for the login throttle's client IP (R16-02) |

**Separate-instance check:**
- On first boot, the store records `store_meta.instance = 'production'`.
- From then on, a staging or dev process pointed at this dir (directly, or through a symlink) is refused **before any file is touched** (R8-01).
- A read-only process can't claim `production`.
- Check it with `sqlite3 -readonly ~/.local/share/agent-office/agent-office.sqlite "select * from store_meta"`.

## Checklist

### A. Before (any day before)
1. **Approved build:**
   - the PM has committed the approved step on `redesign`, and `npm test` is green on that commit;
   - the rehearsal has been smoked (`scripts/deploy.sh --target rehearsal <sha>`, which runs `scripts/golive-smoke.sh`).
2. **Units already follow the release symlink.** Do not point them at a SHA directory. Both stay **disabled** and **stopped** until the first prod deploy restarts them. Do not `enable` or `start` them in this step. Do not edit the running `agent-office` unit.
   - `agent-office-api.service`: `WorkingDirectory` and `ExecStart` are `~/dev/project/agent-office-releases/current/server.js`, `EnvironmentFile` is the production env, `Restart=on-failure`, `RestartForceExitStatus=75`, and `Environment=AO_RESTART_POLICY=on-failure`.
   - `agent-office-web.service`: the same directory, `ExecStart` is `…/current/scripts/serve-frontend.js` (UI at `/`, API base `/backend`).
   - `systemctl --user daemon-reload` only.
   - `current` must already be a symlink (a previous checkout is enough) so a failed first deploy can switch it back. The deploy does not touch `agent-office-portal`.
3. **Write the production env** (above), including `PORTAL_PASSWORD_HASH`. Keep a copy of the old env file: `cp ~/.config/agent-office.env ~/.config/agent-office.env.v1`. `deploy.sh` runs the config check before it moves `current`. A missing email, session secret, or password hash stops the deploy with `key: missing` and does not switch the symlink. The check does not print values.
4. **Static web service** is `agent-office-web` above: SPA fallback, `no-cache` on HTML, `og:*` from `AO_PUBLIC_URL`. It is not started in this step.

### B. Traefik route, then the deploy
5. **Back up** the dynamic file: `cp ~/deployments/example/traefik-dynamic/taco.yml{,.v1}`.
6. **Edit `taco.yml`:**
   - add the API router: `Host(office.example.com) && PathPrefix(/backend)`, **priority above the UI router**, middleware `stripPrefix: { prefixes: ["/backend"] }`, service `http://172.30.0.1:<new port>`, same TLS resolver as today;
   - point the root router at the static web service.

   Traefik's file provider reloads automatically. Check the Traefik logs for errors. Do not restart Traefik, and do not restart `openclaw-gateway`. The public URL will miss until the next step starts the new units. That gap is the cut-over. The smoke hits the public URL, so this edit has to land before `deploy.sh`; otherwise the smoke would certify the old service.
7. **Deploy and public smoke**, from a checkout that contains the script:

   ```sh
   scripts/deploy.sh --target prod <sha>
   ```

   That command checks the SHA out under `~/dev/project/agent-office-releases/<sha>`, runs `npm ci --omit=dev` and `node scripts/sync-design.js`, runs `node --check` and the config check, switches `current`, and restarts **only** `agent-office-api` and `agent-office-web`. It then runs `scripts/golive-smoke.sh https://office.example.com` (API base `/backend`). `GET /` must be HTML. Mute uses the first non-error issue from the health view (api.md §5.3). When there is none, the script prints `notice: no issue to mute` and continues. On `https` the session cookie must be `Secure` and `HttpOnly`. The production env file stays hash-only. The smoke password is `AO_SMOKE_PASSWORD` in the environment of this command, or a prompt when the command has a terminal. It is not read from the env file, not written back, and not printed. `scripts/deploy.sh` runs `node scripts/deploy.js`.
   - If the smoke (or the restart) fails, `deploy.sh` points `current` back at the previous release and restarts those two units. It does not restore `taco.yml` and it does not stop or start `agent-office`.
   - After it exits 0: `https://office.example.com/` loads the v2 UI; `/backend/api/v2/meta` is 200; a browser login cookie is Secure; Bureau, Santé and Projets render live data; an SSE frame is visible; mute then unmute one info issue; logout, then the old cookie is 401.
   - The generic steps for another host are [docs/guide/deploy.md](../guide/deploy.md).

### C. After `deploy.sh` exits 0
8. `journalctl --user -u agent-office-api -n 50`. The process was started by `deploy.sh`, not by a separate `systemctl start`. Expect:
   - `store: applied migration 001_init`, `002_projects`, `003_sessions`, `004_api_tokens` (and any later ones);
   - `Store: …/agent-office.sqlite (instance production, schema vN)`;
   - `listening … (API only)`.
9. **Check the data dir:**
   - `ls -ld ~/.local/share/agent-office` → `drwx------`;
   - the db file is `-rw-------`;
   - `sqlite3 -readonly … "select version,name from schema_migrations"` lists every migration;
   - `store_meta.instance` is `production`.
10. **Take a first manual backup** (the daily one runs at 04:00):

    ```sh
    sqlite3 ~/.local/share/agent-office/agent-office.sqlite \
      ".backup ~/.local/share/agent-office/backups/agent-office-pre-golive.sqlite"
    chmod 600 ~/.local/share/agent-office/backups/agent-office-pre-golive.sqlite
    ```

11. **Local API checks** on `127.0.0.1:<api port>` (the public smoke already ran inside `deploy.sh`):
    - `curl -s 127.0.0.1:<port>/api/v2/meta | jq '.data | {env, contractVersion, capabilities}'` → `production`, the expected contract, writes `true`.
    - Log in with a cookie jar. `Set-Cookie` shows `Secure; HttpOnly; SameSite=Lax; Path=/`. Curl over plain HTTP can't send a Secure cookie back, so authenticated local checks need `--cookie` set explicitly. `GET /api/v2/me` → 200, `gateway: up`.
    - `GET /api/v2/views/health` returns real host data, and `/api/data-quality` has **no open error issues**.
    - `curl -N -H 'cookie: …' '127.0.0.1:<port>/api/v2/stream?topics=health'` → a `hello`, then a `snapshot`, within 1 s.
    - `GET /` → 404 JSON (API-only). `GET /api/v2/views/projects` → 200.

### D. Old service shutdown
12. `systemctl --user stop agent-office`, then `systemctl --user disable agent-office` (the v1 service at :18789). Keep its checkout and env copy for **7 days** for rollback, then remove them.
13. **Never touch** `openclaw-gateway.service`: Timmy runs on it. Agent Office never needs a gateway restart for the cut-over.

## Rollback (any time within the 7 days)
A failed `deploy.sh` has already put `current` back and restarted `agent-office-api` and `agent-office-web`. Returning the public site to v1 is still the Traefik file plus the old unit:

1. `cp taco.yml.v1 taco.yml`: the root router goes back to `:18789`, and the `/backend` router disappears.
2. `systemctl --user start agent-office` (the v1 service, from its untouched checkout and `agent-office.env.v1`).
3. Optionally `systemctl --user stop agent-office-api` and stop the static web service.
4. **No data loss:**
   - v1 keeps no store;
   - the new store stays in `~/.local/share/agent-office` for a retry, with its migrations recorded;
   - a retry later starts it again unchanged.
5. If a **migration** is what failed: stop the API, restore the pre-migration backup the store took (`backups/agent-office-premigrate-v…`, or `agent-office-pre-golive.sqlite`) over `agent-office.sqlite`, and start again. Migrations are forward-only; a fix is a new migration.

For migration 036 (environment owner to database credentials), use its in-place rollback instead of restoring a stale database backup. Keep the configured environment file unchanged. First run `agent-office owner rollback-env --dry-run --env-file ~/.config/agent-office-prod.env`; it reports eligibility without changing the database. Then run `agent-office owner rollback-env --apply --env-file ~/.config/agent-office-prod.env` from a terminal and enter the retained environment password at the hidden prompt. The command verifies that password against the configured environment credential before changing anything; if it fails, do not switch releases. The rollback intentionally resets the owner's email and display name to those environment values, clears the database password hash, restores environment credential mode, and advances the auth generation to revoke sessions. This matches the old release's `ensureEnv()` behavior. All other current database contents, including sessions, projects, chats, and later application writes, remain in place. Never overwrite them with the pre-migration backup; retain that backup for recovery only if a separate, verified reconciliation is required.

## After go-live
- **Watch** `journalctl --user -u agent-office-api` and `/api/data-quality` for 24 h, and check that the 04:00 backup appears in `backups/`.
- **Staging** remains the read-only rehearsal instance (its own data dir and `instance staging`).
- **Instance-specific files** (the env, units, the Traefik snippet, CLAUDE.md) live outside the core repo (ADR-001 §11.6).
