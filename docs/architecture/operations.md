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
  - **`secrets` (secrets.json's content) only with `--include-secrets`.** Default backups preserve DB-auth owner password hashes so owner login survives restore. They are sensitive: keep every backup private, even without `--include-secrets`. Only the separate session-secret/runtime-token file is excluded by default. Metadata reports `hasCredentialHashes` and `hasSecretsFile`; `hasSecrets` is their union. Inspection checks the actual DB, including older backups without a classification marker. The CLI labels credential-bearing backups as sensitive.
- **Refused before anything is written** when the config file or (with `--include-secrets`) the secrets file is not valid (R30-03: it would be refused at restore). The reason names the file, never its content.
- **Verified after writing, before publication:** `PRAGMA integrity_check` is `ok`; the instance and schema match the source; the `config` and `secrets` payloads (when present) match their SHA-256 **and validate against the instance config and secrets schemas**.

**Filesystem requirements:** backup, inspection and restore require operator-owned directories with no group/world write permission. Their ancestors must be owned by the operator or root. Non-sticky world-writable ancestors are refused. A group-writable ancestor (for example Ubuntu’s `~/.local` with mode `0775`) is admitted only when local passwd/group records prove that its owner’s group has no other primary or supplementary members. With `files systemd`, local userdb records are checked too; external NSS identity providers or unreadable/ambiguous records refuse this exception. Artifact parents themselves still forbid group/world write. Sticky system ancestors such as `/tmp` remain supported. A refusal identifies the path, mode, owner/group IDs and rule, and gives the permission command to remove the unsafe write bit. No directory permissions above the data directory are changed automatically. Use a private directory below `/tmp`, never `/tmp` itself as the output parent. Unsafe shared parents, linked descendants and changed file/directory identities are refused. Inspection stages a private copy beside the input and therefore needs write permission in its parent directory. On macOS, the system `/tmp` and `/var` aliases are resolved once when the filesystem helper is configured; subsequent operations check the configured link and canonical directory identities. Arbitrary workspace links remain refused.

SQLite artifacts are preallocated at mode `0600` inside unpredictable, exclusively created mode `0700` staging directories. The shared filesystem helper pins the parent, retains a no-follow guard descriptor through SQLite handoffs, and sets the final mode through that descriptor before publication. Other payloads are copied/read through descriptors. Publication without `--force` uses an exclusive hard link, so a destination created after admission is preserved. `--force` permits replacement of the reviewed regular file. Daily and pre-migration backups use the same staging path. These checks protect against other local users; the operator account and root remain trusted.

For a fresh DB-auth restore, use a private `--include-secrets` backup (or restore the separately retained private secrets file). A default backup can restore onto an instance that retains its own matching config/secrets. Without the required private secrets file, startup stays refused; onboarding is not reopened and the owner is not reset.

**`restore`** replaces the store (and, when absent, the config files) with a backup's.
- **Refused** when:
  - **a server is running on the data dir**, in setup mode too (it holds an OS lock on `<data>/.server-lock.sqlite` for its whole life; R30-01). The setup → app handoff keeps it;
  - the backup isn't a valid format-1 backup, or fails its integrity check, or a payload's digest matches but the payload is not a valid config or secrets file (R30-03);
  - a config or secrets destination exists and is not a regular file;
  - its schema is newer than this build;
  - **its instance id differs from the target store's** (or, without a target store, from `AO_ENV`): a staging backup never lands on production.
- **Order (R30-02: all or nothing):**
  1. **Stage:** the backup's database is copied into a private staging directory in the data dir, as one self-contained file, and its `ao_backup` table is removed, so secrets-file payloads do not remain in the live store. Owner credential hashes are deliberately preserved in `users`. It is verified (integrity, instance, schema). Each payload to publish (config, secrets) is written through a descriptor in a private staging directory next to its destination and verified. A refusal or failure here leaves the live files unchanged. Conflicting staging entries are retained for local inspection.
  2. A copy of the current store goes to `<data>/backups/agent-office-prerestore-<time>.sqlite` (0600). It is read from a private copy, so the live files, `-shm` included, are never opened.
  3. **Swap:** the current store and its `-wal`/`-shm`, and any config or secrets file being replaced, are moved aside with identity receipts; the staged files are published exclusively into the vacated names (0600). A failure here rolls back: each moved file is renamed back **over only the inode this restore published**, or into its still-empty original name. A concurrent replacement refuses rollback and remains untouched. The pre-restore copy is deleted **only after a complete rollback**. If the rollback can't finish, exit `2` names the retained recovery copies (`.*.rollback-*` and `backups/agent-office-prerestore-*`); a complete previous store remains available.
  4. **Commit point (R32-01):** the new store is verified where it now lives (a private copy: integrity, instance, schema). From here nothing is rolled back.
  5. **Cleanup:** only the recorded moved-aside original inodes and owned staging files are deleted. Replacement entries remain untouched. A file that can't be deleted is left in place and named (`restore ok`, exit `0`, plus one line on stderr listing what to inspect by hand). The pre-restore copy is always kept.
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
| captured message senders | 30 days from first capture; 10,000 records / 8 MiB of identity/key data | `AO_SENDER_RETENTION_DAYS` (1–365); `AO_SENDER_CAPTURE=0` disables capture |

At most 500 issue fingerprints are kept; beyond that, new ones are counted under one `quarantine.overflow` row. Maintenance logs counts only (`store: maintenance pruned audit=…, issues=…`), never row content. A value out of bounds refuses to start, naming the variable.

Sender capture is optional adapter functionality, advertised as `runtime.capabilities.senderCapture` in v3. It is disabled when `PORTAL_READONLY_STORE=1`; runtime read-only mode can still capture into Agent Office's own store. Migration `013_sender_captures` stores only exact runtime/session/message keys and neutral identity fields. Expired entries are unavailable on lookup and pruned at boot, on capture and during daily maintenance. Replays cannot refresh an entry's retention or change its attribution. The 8 MiB cap counts UTF-8 key and identity data; SQLite indexes, free pages and the existing store backups add overhead. See [sender-identities.md](sender-identities.md).

## 4. Office layout: `presence` (3.0, office-dev O8)
`LayoutData.presence: { seenMinutes: integer 0–1440 }` (optional, top level): how long an occupant stays in the « seen » inventory shown by the editor.
- **3.0:** read and written as is.
- **2.x:** the field isn't part of the 2.x layout, so **v2 reads don't show it**, and **a v2 save keeps the stored value** (a 2.x client can't lose a 3.0 setting by saving).
- It's validated in the server's structural check (integer, 0–1440, no other keys).


### Onboarding recovery and rollback (config v2, schema 015)

An unfinished owner draft survives restart and can be amended using the new locally printed 30-minute setup code. If valid private DB-auth config/secrets exist but the DB has no owner, boot opens code-protected recovery. This does not apply to a configured existing owner. A missing secrets file serves locked setup with a clear restore-and-restart message, never a new owner or code. Config publication reconciles the prepared DB digest after a crash.

DB schema 014/015 and config v2 are forward migrations. Before upgrading, retain a private backup with `--include-secrets`, covering the DB, config and matching session-secret/runtime-token file. To roll back, stop Agent Office, restore that pre-upgrade backup using the restore command, then start the matching earlier binary. Do not feed v2 config or a newer schema to a v1-only binary; the reader refuses the version and the store refuses unsupported migrations. Default DB backups still contain owner hashes and remain sensitive.

A confirmed integration plan stages private `plan-*.json` file preimages before mutation. On ordinary failure, completed target changes are undone with bytes and permission bits restored; inode identities change, so review a fresh plan. If another writer replaced a target or parent, rollback refuses rather than overwriting it and retains preimages for local recovery. Crash interruption also leaves the private preimage artifact; filesystem changes across multiple workspaces are not a crash-atomic database transaction. Plan again against the current state or recover from the private preimages after inspecting it locally. Never publish these files. Uninstall removes only exact owned files and empty directories.

## Owner-requested API restart

Settings exposes `POST /api/v3/settings/restart` for the configured owner, with CSRF protection, a recent password confirmation, explicit confirmation, the current Settings revision and the current process `bootId`. A persisted 60-second cooldown applies across sessions and process boots. The API closes its sources and store and exits with dedicated restart status `75` only after a successful response finishes. It does not restart the Gateway or a separate static web service. Meta (`/api/v2/meta` and `/api/v3/meta`) carries an opaque process-lifetime `bootId`; clients wait for a different ID before reloading, and retry polling rather than repeating the POST.

A supervisor capability requires an explicit `AO_SUPERVISED=1` or `AO_RESTART_POLICY=always|on-failure|unless-stopped` declaration. `INVOCATION_ID`, `NOTIFY_SOCKET`, or container presence alone do not prove a restart policy and do not enable the action. These are operator declarations, not permission to execute host-management commands. The shipped systemd unit uses `Restart=on-failure`, `RestartForceExitStatus=75`, and `Environment=AO_RESTART_POLICY=on-failure`. Apply those declarations to the API unit and reload its service definition when upgrading an existing install. Ordinary SIGTERM/SIGINT shutdown still exits 0; only the owner restart exits 75. Docker examples use `restart: unless-stopped` and the matching policy hint. Homebrew declares `always` alongside its actual `keep_alive true` policy, and the npm wrapper propagates the child's exit status. In a split deployment only the API unit owns this capability. Without a declared supervisor, Settings displays the shell-quoted startup command for manual restart and the endpoint refuses the operation. Read-only instances also refuse it.
