# Operations (G8)

Health probes, backup and restore, retention. Examples: `examples/ops/`. Everything here works the same from a checkout, `npx agent-office` and the Docker image.

## 1. Health probes
Two unauthenticated GETs, mounted at the server root in every mode (setup mode, one-port, API-only). With the one-port launcher they are also at `/backend/healthz` and `/backend/readyz`. They answer `Cache-Control: no-store`, are never audited, and carry **no instance data**: no name, version, path, count or id. Every value is from a closed set.

| Route | Meaning | Answer |
| --- | --- | --- |
| `GET /healthz` | **Liveness:** the process serves HTTP. It never touches the store or the runtime, so it can't hang on them. | Always `200 { "status": "ok" }` (`healthz.json`). |
| `GET /healthz/proxy` | **How this request reached the server** (G11, for `agent-office doctor --url`): whether it is secure as the server sees it, and whether forwarded headers were absent, trusted (`AO_TRUST_PROXY`) or ignored. | Always `200 { "status": "ok", "request": { "secure": true, "forwarded": "trusted" } }` (`healthz-proxy.json`). `forwarded`: `none`, `trusted` or `untrusted`. |
| `GET /readyz` | **Readiness:** this process can serve its API now. | `200 { "status": "ready", "checks": {…} }` (`readyz.json`, `readyz-setup.json`), or `503 { "status": "not-ready", "checks": {…} }` (`readyz-503.json`). |

`checks` (closed values):
- `mode`: `app` or `setup` (a fresh install serves setup and is **ready**, so people can reach it);
- `store`: `ok` (open and answering a query), `unavailable`, or `none` (setup mode, before there is a store);
- `runtime`: `connected`, `disconnected` or `not-configured`, as the engine sees the runtime adapter. **A runtime that is down does not make the instance not-ready.** The API still serves its last good data, marked stale, so a proxy must not take it out of rotation for that.

**Not-ready means** the store isn't usable (`store: unavailable`); in setup mode, never.

**Use:**
- **Docker:** `HEALTHCHECK` calls `/healthz` (then `/backend/healthz`) on the container's port.
- **Reverse proxies:** route traffic on `/readyz` and restart on `/healthz`. Expose neither publicly unless you want to; they reveal nothing, but they also serve no one but the operator. Traefik example: `healthCheck: { path: /readyz, interval: 15s, timeout: 3s }`.

## 2. Backup and restore
```
agent-office backup <file>  [--data dir] [--config file] [--include-secrets] [--force]
agent-office restore <file> [--data dir] [--config file] [--force]
```
**Exit codes:** `0` done and verified; `1` refused (nothing changed; one line says why); `2` failed while writing (nothing changed: everything is staged and verified first, and a failure during the final swap puts every previous file back). The one exception is named: if that rollback itself cannot finish, exit `2` says so and names the kept files; a complete previous store always survives. After the commit point, a cleanup failure is not a failure: exit `0`, with the leftover files named.

**`backup`** takes a consistent copy of the store **while the server runs**, through SQLite's online backup API.
- **The file** is one SQLite database, mode 0600, never overwritten without `--force`. It is the store plus a table `ao_backup` with:
  - `format` (1), `instance` (the store's instance id), `schema` (its migration version), `createdAt`;
  - `config` (the instance config file's content, which is not secret), when there is one;
  - **`secrets` (secrets.json's content) only with `--include-secrets`.** By default the backup has no password hash, session secret or runtime token, so it can be kept somewhere less private than the config dir.
- **Refused before anything is written** when the config file or (with `--include-secrets`) the secrets file is not valid (R30-03: it would be refused at restore). The reason names the file, never its content.
- **Verified after writing, before the rename:** `PRAGMA integrity_check` is `ok`; the instance and schema match the source; the `config` and `secrets` payloads (when present) match their SHA-256 **and validate against the instance config and secrets schemas**.

**`restore`** replaces the store (and, when absent, the config files) with a backup's.
- **Refused** when:
  - **a server is running on the data dir**, in setup mode too (it holds an OS lock on `<data>/.server-lock.sqlite` for its whole life; R30-01). The setup → app handoff keeps it;
  - the backup isn't a valid format-1 backup, or fails its integrity check, or a payload's digest matches but the payload is not a valid config or secrets file (R30-03);
  - a config or secrets destination exists and is not a regular file;
  - its schema is newer than this build;
  - **its instance id differs from the target store's** (or, without a target store, from `AO_ENV`): a staging backup never lands on production.
- **Order (R30-02: all or nothing):**
  1. **Stage:** the backup's database is written to a temporary file in the data dir, as one self-contained file, and its `ao_backup` table is removed, so **no secret ever stays in the live store**. It is verified (integrity, instance, schema). Each payload to publish (config, secrets) is written to a private temporary next to its destination and verified. A refusal or failure here changes nothing.
  2. A copy of the current store goes to `<data>/backups/agent-office-prerestore-<time>.sqlite` (0600). It is read from a private copy, so the live files, `-shm` included, are never opened.
  3. **Swap:** the current store and its `-wal`/`-shm`, and any config or secrets file being replaced, are moved aside; the staged files are renamed into place (0600). A failure here rolls back: each moved file is renamed back **over** what replaced it (one atomic rename, so a live file always exists), and the pre-restore copy is deleted **only after a complete rollback**. If the rollback can't finish, exit `2` names the kept files (`.*.rollback-*` and `backups/agent-office-prerestore-*`); at least one complete previous store always survives.
  4. **Commit point (R32-01):** the new store is verified where it now lives (a private copy: integrity, instance, schema). From here nothing is rolled back.
  5. **Cleanup:** the moved-aside originals are deleted. A file that can't be deleted is left in place and named (`restore ok`, exit `0`, plus one line on stderr listing what to remove by hand). The pre-restore copy is always kept.
  6. The config and secrets are published only when the backup has them and the target has none; with `--force`, they replace the target's.
- **After a restore** the next start runs any pending migrations, as after an upgrade.

## 3. Retention
The store's daily maintenance (04:00 local time) applies this policy, then takes the daily backup (the last 7 are kept):

| Data | Kept | Setting (env; bounds) |
| --- | --- | --- |
| `audit_log` | 365 days | `AO_AUDIT_RETENTION_DAYS` (30–3650) |
| quarantine issues, `resolved` | 30 days after their last occurrence | `AO_ISSUE_RETENTION_DAYS` (7–365) |
| quarantine issues, `open` / `muted` | while they recur; muted ones 365 days after their last occurrence | the audit setting |
| revoked sessions | until they would have expired | n/a |
| seen office occupants | 30 days | n/a |

At most 500 issue fingerprints are kept; beyond that, new ones are counted under one `quarantine.overflow` row. Maintenance logs counts only (`store: maintenance pruned audit=…, issues=…`), never row content. A value out of bounds refuses to start, naming the variable.

## 4. Office layout: `presence` (3.0, office-dev O8)
`LayoutData.presence: { seenMinutes: integer 0–1440 }` (optional, top level): how long an occupant stays in the « seen » inventory shown by the editor.
- **3.0:** read and written as is.
- **2.x:** the field isn't part of the 2.x layout, so **v2 reads don't show it**, and **a v2 save keeps the stored value** (a 2.x client can't lose a 3.0 setting by saving).
- It's validated in the server's structural check (integer, 0–1440, no other keys).
