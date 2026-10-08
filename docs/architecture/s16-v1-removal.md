# S16: removing v1

**Status: done (architect-50).** The PM approved it early: the go-live rollback target is the previous agent-office service from the main branch, not v1 inside the new code. §1 and §2 below are what was removed, with the exceptions noted in architect-50 (the old UI's files are frontend's; `READONLY_MESSAGE` stays as the CLI wrapper's refusal text). v2 and v3 are byte-identical to the pre-S16 baseline over the corpus.

**Before (S16 prep, architect-36): engine-only mode.** With `AO_API_ONLY=1` (production), v1 wasn't mounted: no v1 routes, no legacy runtime, no v1 SSE, no old UI. `AO_LEGACY_V1=1` brought it back for a planned 7-day rollback window. The engine is fed by the source loop (`src/sources/loop.js` + the adapter's `runtime.start`) in **both** modes, so v2/v3 don't depend on v1. Proven: v2 (553) and v3 (567) responses are identical with and without v1 over the golden corpus.

**The deletion** (planned for after that window; done early on the PM's decision, in small green steps):

## 1. Code removed
| What | Where | Note |
| --- | --- | --- |
| v1 routes | `src/api/routes/v1-legacy.js` | `/api/{summary,health,logs,cron,access,skills,channels,chat,session,interlocutor,stream,data-quality}`, `/api/cron/:id/*`, `/api/skills/:name*`, `/api/gateway/restart` |
| legacy runtime, views, session adapter | `src/legacy/*.js` | the v1 journal/hooks; `engine.legacyType` users |
| v1 SSE | `src/api/sse.js` | |
| old UI | `public/{index.html,app.js,app.css,office.js,sw.js,manifest.webmanifest,icon.svg}` | `public/_ds` stays only if `/v2` still links it; `http.js` drops the v1 fallback and `legacyUi` |
| config flag | `cfg.legacyV1`, `AO_LEGACY_V1`; `server.js` v1 branch | the flag then means nothing: remove it and say so in go-live.md |
| audit | the v1 entries of `V1_COMMANDS` in `src/api/audit.js` (rename the list `AUDITED_COMMANDS`) | v2/v3 entries stay |
| v1 skill-info cache, `READONLY_MESSAGE` | `src/config.js`, v1 routes | |

**Kept:** `/api/login`, `/api/logout`, `/api/me` (the `/v2` UI signs in through them; moving them under `/api/v2/session` is a separate contract change). `/api/v2` stays until the frontend and office have switched to `/api/v3` (G5); its removal is the step after this one.

## 2. Tests and fixtures removed or rewritten
- **Removed:** `test/characterisation/v1-routes.test.js`, `test/golden/v1-routes/**`, `test/golden/v1-writes/**`, the v1 parts of `test/unit/http-v2.test.js` ("leaves the old UI…"), and the v1 read-only guard tests.
- **Rewritten:** `test/unit/portable-checkout.test.js` runs the v2 golden corpus from the copy instead of v1's. The harness drops its optional v1 summary wait.
- **Kept and moved:** `test/characterisation/auth.test.js` (login/logout/me) moves to `test/api/`.
- **The portability allow-list loses its v1 entries** (23); the lint then fails on any stale one, which proves they're gone.

## 3. Order
1. **Day 0** (done): production runs engine-only; the rollback is `AO_LEGACY_V1=1` + restart.
2. **Day 7**: the PM confirms no rollback. One change removes §1 and §2; `npm pack` and the Docker image shrink accordingly. Gate: full suite green, the v2/v3 corpus identical to day 0, go-live.md updated.
3. **Later**: when `/v2` runs on `/api/v3`, remove `/api/v2` (`project2x`, the 2.x schemas and examples) as its own step.
