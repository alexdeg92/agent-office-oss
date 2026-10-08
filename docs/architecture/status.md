# Agent Office: current state (2026-10-06)

One page: what's done, what sits behind a flag, what's deprecated, and the known gaps. Details live in the linked documents (index: `README.md`). The suite has 1292 tests (1290 green on 2026-10-06; the two reds are owned elsewhere, see architect-47).

## Done
| Area | State | Where |
| --- | --- | --- |
| **Engine** | Canonical model (sessions, agents, flows, skills, channels, transcripts, config), quarantine (value-free, closed codes), LiveEvents, one primary-agent resolver, typed on-demand reads | `engine.md`, `data-model.md` |
| **Runtime adapters** | `openclaw` (production) and `demo` (a synthesised read-only team, no network). Selected by the instance config `runtime.adapter` or `AO_RUNTIME` | ADR-001 §3, §13 |
| **Channels and enrichers** | Pluggable channel grammars (static) and enrichers (selected; Discord first); interlocutors of any channel; `unresolvable` without an enricher | ADR-001 §14 |
| **API** | `/api/v2` = contract **2.5** (the current UI); `/api/v3` = contract **3.0** (open vocabularies, no personal values), served side by side from one router, one engine, one stream hub per version | `api.md`, `api-v3.md`, `migration-v3.md` |
| **Security** | One-owner login (scrypt hash, shared login/setup throttle, CSRF guard, `Secure` cookies in production), the agent's scoped token, audit of every write, private file permissions checked at boot | `api.md` §5, `go-live.md` |
| **Instance config and setup** | Config + secrets files (0600, atomic, OS-locked publication, env wins), first-run setup with a one-time code and an in-process handoff, locale (fr/en) and time zone | `api.md` §5.7, ADR-001 §5 |
| **Store** | SQLite, migrations 001–009 (latest: canonical seen inventory with one id limit in code points), daily backup, retention | `storage.md` |
| **Operations** | `/healthz`, `/readyz`, `/healthz/proxy`; `agent-office backup / restore` (online, verified, secrets opt-in; restore is all-or-nothing, payloads schema-validated, refused while any server, setup included, owns the data dir); `agent-office doctor` (read-only install checks, FR/EN, `--json`, never prints a value); configurable retention | `operations.md`, `../guide/troubleshooting.md` |
| **Soak (G10)** | Real OpenClaw-shaped traffic (the local captures) replayed into the real server (`AO_API_ONLY=1`), compressed (`AO_TIME_SCALE`): zero quarantine growth and a flat live heap over 10 simulated minutes after the stream buffers fill. Local-only (needs the captures) | `test/e2e/replay.test.js` |
| **Portability** | Foreign-instance end-to-end test, personal-literals lint (per-occurrence allowances with a mutation self-test), v3 examples written for a foreign instance | ADR-001 §12.8 |
| **Production** | `AO_API_ONLY=1` behind `/backend`. **v1 removed (S16):** no v1 routes, legacy runtime, v1 SSE or `AO_LEGACY_V1`; the rollback target is the previous service from the main branch | `go-live.md`, `s16-v1-removal.md` |

## Behind a flag
| Flag | Default | What it does |
| --- | --- | --- |
| `AO_API_ONLY` | off | API only: no static files, no SPA fallback (production behind `/backend`) |
| `AO_RUNTIME` | `openclaw` | `demo`: the synthesised team (read-only) |
| `AO_ENRICHERS` | `discord` | Interlocutor enrichers; empty = none |
| `AO_CAPTURE` | off | Project screenshots. Stays off until Chrome runs in an isolated network namespace (real Chrome bypasses the proxy for loopback) |
| `AO_PROJECTS_DISCOVERY`, `AO_PROJECTS_OWNERS`, `AO_PROJECTS_ROOT` | off until an owner or a root is set | Project discovery from code hosts and a workspace root |
| `PORTAL_READONLY`, `PORTAL_READONLY_STORE` | off | Staging: no runtime writes (and optionally no store writes) |
| `AO_STRICT_VM` | off (on in dev and test) | A VM that fails its runtime check throws instead of falling back |
| `AO_AUDIT_RETENTION_DAYS`, `AO_ISSUE_RETENTION_DAYS` | 365, 30 | Retention (bounded) |
| `AO_TIME_SCALE` | 1 | Test instance only (`AO_ENV=test`): compresses every periodic loop by this factor (1–1000); ignored elsewhere |
| `AO_TRUST_PROXY`, `AO_PUBLIC_URL`, `AO_PUBLIC_API_BASE` | loopback, none, `''` | Proxy trust for client IPs; absolute URLs; the API prefix the browser sees |

## Deprecated (kept for compatibility; removal planned)
| What | Replaced by | Removal |
| --- | --- | --- |
| Old UI files in `public/` (`index.html`, `app.js`, `office.js`…) | the `/v2` UI | no longer served (redirect to `/v2/`) since S16; frontend deletes them |
| `/api/v2` (contract 2.5, `project2x`, the 2.x examples) | `/api/v3` | after the UI and the office have switched (`migration-v3.md`) |
| `PORTAL_PASSWORD` (plaintext) | `PORTAL_PASSWORD_HASH` / setup's hash | a later release (it warns at boot) |
| 2.x aliases: `with-timmy`, occupant `main`, `discord-user` / `discord-channel` kinds, `resolution: pending` for "no enricher" | the 3.0 names | with `/api/v2` |
| `persons.discord_user_id` column | `person_identities` | the 3.0 store cleanup |
| `MetaVM.capabilities.openclawWrites` (name) | `runtimeWrites` | 3.x (ADR-001 §13.2) |

## Known gaps
- **Before a third runtime adapter (Hermes):** ADR-001 §13.2's OpenClaw-flavoured spots:
  - the Discord-shaped runtime config;
  - `cron` + `tz` flow inputs;
  - explicit-key chat;
  - the setup adapter list in `setup.js`;
  - file-based skill docs.

  The Hermes adapter itself needs a capture of a real Hermes API first (§13.3).
- **Access policies are Discord-only** (from the runtime config); other channels show `null` policies.
- **Projects:** `with-agent` filters by the primary agent only (another `agent` → 400 `unsupported`).
- **G4 leftovers:**
  - `scripts/config-from-env.js` (optional for env-configured installs);
  - `agent-office setup` in the terminal;
  - applying setup's `agents.looks` to the office layout (with office-dev).
- **UI migration to `/api/v3`:** frontend's version switch (`apiVersion` config) and office-dev's mock (`presence`) are in progress.
- **Open review items owned elsewhere:**
  - R22-10 (the mock setup throttle never releases; frontend);
  - R22-11 (44 px targets; frontend and office-dev);
  - review-23's deployment findings.
- **Awaiting re-test:** R24-01 and R26-01 (lengths in code points; long ids now admitted and only left out of the seen inventory, with a `store.unindexed` warning).
- **One adapter and one primary agent per instance** (3.0 scope; ADR-001 §2).
