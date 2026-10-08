# Moving the UI from `/api/v2` to `/api/v3` (frontend, office-dev)

**Contract:** `api-v3.md` (deltas D1–D10) and `examples/v3/`. **Nothing breaks on its own:** `/api/v2` keeps serving 2.5 byte-identical until you have moved, so each step below can land separately. Rebuild your mocks from `examples/v3/` (any VM not there keeps its 2.x example).

## Order
1. **office-dev first: `layout-rules.js` accepts both vocabularies** (ADR §12.6): `main` ≡ `primary`, `*cron` ≡ `*scheduled`, `*dm` ≡ `*direct`, `*channel` ≡ `*group`, plus `*conversation`; a rule for the primary under either name. The server normalises layouts to 3.0 on save only once this lands.
2. **frontend: one API version constant.** Today 51 literal `/api/v2` paths sit in 23 files (`api.js`, `stream.js`, `project-api.js`, `config.js`, `vmcheck.js`, `lang.js`, `app.js`, `components/restart.js`, `office/page.js` and 14 pages). Put the prefix in one place (`api.js`: `API = '/api/v3'`), so the switch is one line and the mock can serve both. `vmcheck.js` takes the v3 schemas (`public/v2/generated/vm-schemas.js` gains a v3 set; I'll generate it with the server).
3. **Per page, the field changes** (table below), against the v3 mock.
4. **Switch the constant** to `/api/v3` for everything at once (views, commands **and** the stream: one version per client). Then tell the PM: `/api/v2` is retired at S16.

## What changes, page by page
| Area / file | 2.x | 3.0 | Delta |
| --- | --- | --- | --- |
| Labels, `i18n.js`, `lang.js` | `enums.channel` closed list; « autre » for unknown | no `channel` enum; `labels['channel.<ref>']` etc. are dynamic; **a missing key renders the raw value** | D1 |
| Capabilities | always on | hide or disable by `meta.runtime.capabilities` (e.g. Discuter without `chat`, Flux read-only without `flows.write`) | D1 |
| Journaux (`pages/journaux.js`), Session (`pages/session.js`) | `kind` `main`/`cron`/`chat-*`/`dashboard`/`acp`/`explicit`; `channel` may be `unrecognized` | `primary`/`scheduled`/`conversation-*`/`conversation`/`internal` + `runtimeKind` (a tag for internal ones); `channel` is any ChannelRef | D2 |
| Logs filter | `?kind=chat-direct` … | `?kind=conversation-direct` …, `internal` is a filter value | D2 |
| Bureau (`office/*`: `names.js`, `headline.js`, `editor.js`, `strings.js`, `setup-looks.js`) | occupant `id: 'main'`, roles `main`/`cron`/`dm`/`channel` | `id: 'primary'`, roles `primary`/`scheduled`/`direct`/`group`/`conversation`; ids `<role>:<subject>` | D3 |
| Office editor | rules `main`, `*cron`, `*dm`, `*channel` | rules `primary`, `*scheduled`, `*direct`, `*group` (`*conversation` new) | D4 |
| Habilitations (`pages/access.js`, `access-rules.js`), Interlocuteur (`pages/interlocutor.js`) | Discord only; `kind` `discord-user`/`discord-channel` | every channel; `kind` `user`/`room` + `channel`; `resolution: 'unresolvable'` (no name will come: show the id); `access.*` may be null | D5 |
| Santé (`pages/health.js`) | unknown channels `raw:<id>` | ids are ChannelRefs; label from the server | D6 |
| Flux (`pages/flow.js`, `pages/flows.js`) | `job.sessionTarget`, `job.wakeMode` | `job.ext.openclaw.{sessionTarget, wakeMode}` (detail rows only when present); `job.agentId` always set; create may send `agentId` when `runtime.capabilities.flows.multiAgent` | D7 |
| Projets (`pages/projects.js`, `board.js`, `messages.js`) | `filter=with-timmy` | `filter=with-agent` (+ `&agent=<id>`, default the primary; show its name from `meta.primaryAgent` / `labels['agent.<id>']`); `BoardVM.agent` | D8 |

## What does NOT change
Envelopes, errors, CSRF (`X-AO-Request`), login/session, SSE framing and resume, projects commands and their 409s, setup (§5.7), the agent token, chat, skills, prefs, `LabelRef` rendering, history actors.

## Tests on your side
- Your contract tests compare against `examples/v3/` for the listed VMs (`compareExample` gains a `{ version: 3 }` option with the server work).
- A personal literal in a UI file fails `test/portability/no-personal-literals.test.js` unless allowed; moving to v3 is a good moment to delete the allowances your area still has (frontend 66, office 31).
