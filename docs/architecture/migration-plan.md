# Migration plan

Status: draft v1 (2026-10-05).

This plan goes from the single 712-line `server.js` plus the 941-line `app.js` to:
- an engine, a store and a typed API with view models (backend);
- a stateless frontend rebuilt on Bureau, page by page, including Projets and the illustrated office.

**Ground rules:**
- **Each step is one PR-sized change on `redesign`.** The PM commits it and restarts `agent-office-staging` (port 18790). A step is done when its acceptance checks pass on staging.
- **Production is untouched** until the cut-over step (S16). It keeps running `agent-office-portal` on `main`.
- **Rollback for any step:** revert the commit and restart staging. Store migrations take a backup first (storage.md §5.1).
- **`npm test` must pass before each staging restart.** From step S0 on, the PM's restart runs `npm test && systemctl --user restart agent-office-staging`.
- **Old and new routes coexist.** `/api/*` (v1) stays until the last page that uses it is rebuilt. The old UI stays reachable at `/` until S16, and the new UI grows at `/v2/` until it replaces `/`.
- **No new dependency** without PM approval. The frontend choice (§3) is a PM decision before S8.

## 1. Target module layout

```
server.js                 composition root only (≤ 80 lines): config → store → engine → api → listen
src/
  config.js               env parsing + validation (exits on missing vars, as today)
  auth.js                 taco_sess cookie sign/verify, login/logout, requireAuth
  engine/…                engine.md §2
  store/…                 storage.md §5
  api/
    http.js               express app, error middleware, request id, readonly guard
    routes/v1-legacy.js   today's routes, unchanged responses (deleted at S16: done, architect-50)
    routes/v2/*.js        views, commands, stream
    vm/*.js               view-model builders (pure)
    sse.js                topics, diffing, coalescing, resume
  i18n/fr.js              labels for every enum key
  schema/…                DSL
  model/types.js          JSDoc typedefs
public/
  (old UI, until S16)
  v2/
    index.html, app.js (router, shell), api.js (fetch + error format), stream.js (SSE + delta apply)
    fmt.js (fr-CA dates/numbers), pages/*.js, components/*.js, office/*.js
    bureau/               design-system CSS + assets, copied from design/ by scripts/sync-design.js
test/ …                   engine.md §10
scripts/ capture-fixtures.js, sync-design.js, schemas-doc.js
```

## 2. Steps

### Phase A: make the backend safe to change

**S0. Fixtures and characterisation tests.**
- **Work:**
  - add `scripts/capture-fixtures.js` (read-only RPCs + CLI reads, strict redaction; engine.md §10.1);
  - the PM runs it on the host and reviews the output before it's committed;
  - add `test/` with `node:test`;
  - add a `FakeGateway`, plus a fake `openclaw` CLI script that prints fixtures;
  - write characterisation tests that pin today's `buildSummary/Health/Logs/Cron/Access/Skills` outputs for those fixtures;
  - add `"test": "node --test test/"`.
- **Ships:** no runtime change.
- **Accept:** `npm test` is green, and the fixtures contain no real ids, text or secrets (the PM reviews the redaction report the script prints).
- **Unblocks:** the real enum values in data-model.md's open questions.

**S1. Split `server.js` into modules, without behaviour change.**
- **Work:** move code into `config.js`, `auth.js`, `engine/sources/{gateway,cli,config,host,discord}.js` (plain moves, existing logic) and `api/routes/v1-legacy.js` (the `build*` functions and routes). `gateway.js` moves to `src/engine/sources/gateway.js` and the root file re-exports it.
- **Also:** split the read-only guard into the CLI wrapper and the restart route (storage.md §6), keeping the middleware as a backstop.
- **Accept:** characterisation tests are unchanged and green; staging behaves identically (manual pass over the 7 pages); `node --check` passes on every file.

**S2. Schema DSL, quarantine and the engine in shadow mode.**
- **Work:**
  - add `src/schema/` with its unit tests;
  - add `engine/pipeline.js`, `registry.js`, `quarantine.js` (in memory for now) and `redact.js`;
  - add v1 raw schemas for every RPC, event and CLI output in the fixtures.

  The engine ingests the same envelopes alongside the legacy cache, and the legacy routes still read the legacy cache.
- **Visible:** a *Qualité des données* block appended to the old Santé système page through `/api/health` (one extra card: open issues by severity).
- **Accept:** golden tests pass for every fixture; on staging, after 24 h, every open issue is either explained or fixed with a schema change.

**S3. Sessions through the engine; `classifySession` removed.**
- **Work:** the Session, RunState, Activity and Interlocutor normalisers; the SessionKind rule table, tightened against the fixture keys; occupant derivation. Legacy `buildRoster/buildLogs/buildAccess` now read the registry through a thin adapter, and the old regexes are deleted.
- **Accept:**
  - the characterisation tests still pass, except for deliberate, listed diffs (e.g. heartbeat vs main);
  - zero `session.unclassified` issues on staging over 24 h;
  - the journal coalesces repeated activity.

**S2.1 / S3.1. Hardening after reviews R1 and R2** (inserted 2026-10-05; `design/reports/review-01.md`, `review-02.md`).
- **Work, R1 (S2.1):**
  - data-quality diagnostics are default-deny, sanitised centrally at `quarantine.record()` (R1-01, R2-01);
  - fixture redaction is default-deny for identities, and the capture is re-redacted without a recapture (R1-02);
  - per-channel freshness plus gateway down state (R1-03);
  - `version.untested` stays open while unsupported (R1-04);
  - the CLI process outcome travels in the envelope (R1-05);
  - own-property checks in the DSL (R1-06);
  - admitted-value checks with a mutation proof (R1-07);
  - negative auth tests for every route and SSE; a malformed cookie gives 401, not 500 (R1-08).
- **Work, R2 (S3.1):** R2-02 to R2-10 (see review-02).
- **Accept:** the reviewer checks S2.1 and S3.1 together on one frozen snapshot.

**C1. Contract repair after review R3** (inserted 2026-10-05; contract version 2.0, see the api.md changelog).
- **Work (architect; docs only, plus small fixture/engine changes):**
  - api.md 2.0: every route typed, with JSON examples, the SSE lifecycle and the delta grammar, concurrency/409, history and activity per command, capabilities, Flow unions, `ProjectSourceInput`, flag rules, repo state;
  - data-model, storage and engine aligned: SourceStatus per channel, revision/activity rules, repoStatus, auto stations, accessory precedence, the change bus, derivation ownership;
  - **the Activity model on 2026.9.8:** `sessions.changed` + run state, with no per-tool events (capture-20261005-active);
  - schemas for `sessions.changed` and `chat.metadata.changed`; the active capture added as a scenario.
- **Pending:** office-dev's proposals for R3-14…R3-18 (and the R3-08 manifest encoding) will be merged into 2.1; projects' confirmation of the history payloads and revision table.
- **Accept:** the PM relays the changed contracts to frontend, office-dev and projects; the reviewer re-checks R3.

**S4. The rest of the canonical types.**
- **Work:**
  - CronJob, CronRun, Skill (with `--agent main` enforced by the wrapper's signature), Channel, HealthSnapshot, LiveEvent and Transcript;
  - the legacy routes read only the registry, and the legacy `cache` object is deleted;
  - `sessions.usage` polling is removed;
  - the change set drives the old SSE `refresh`, so it fires only on a real change.
- **Accept:** `grep -n "cache\." src/` returns nothing; tests are green; the old UI still works on staging.

**S5. The store.** Done 2026-10-05 (architect-05). Migration 001 holds only the core tables; the project, repo-cache and layout tables move to S15a/S15b/S14b (storage.md §4).
- **Work:**
  - `node:sqlite` store at `AO_DATA_DIR`, with migration 001, backups and seeding;
  - quarantine, the interlocutor cache and the audit log are persisted;
  - every legacy write route (cron, skills, restart, chat) is audited.
- **Accept:**
  - quarantine counts survive a restart;
  - Discord names appear right after a restart, without a refetch storm;
  - staging and prod data dirs are separate (an env check at boot).

### Phase B: the typed API

**S6. API v2 skeleton: envelope, errors, meta, SSE.** Done 2026-10-05 (architect-08).
- **Work:**
  - `api/http.js` error middleware (one error format, request ids);
  - `GET /api/v2/meta`, `/me`;
  - `sse.js` with topics, snapshots, deltas, coalescing and resume;
  - `vm/health.js` + `GET /api/v2/views/health` + the `health` topic;
  - `GET /api/v2/meta` carries `env` (`production` | `staging` | `dev`); `src/i18n/fr.js` uses frontend's label namespaces (api.md §3.2);
  - `PUT /api/v2/health/issues/:id/muted` (refused for `error`), and a mute that survives recurrence (quarantine currently reopens; fix with the store);
  - contract tests.
  - **From review R1, inherited behaviour:**
    - **R1-09:** SSE streams close at session expiry; logout semantics are decided, documented and tested (cookie-only, or a server-side revocation list).
    - **R1-10:** `Secure` cookie on HTTPS deployments, behind a config switch (`PORTAL_COOKIE_SECURE`, default on in production and off on staging over HTTP) with attribute tests. Never enabled silently for staging.
- **Accept:** the SSE contract tests (rev sequence, gap resync, `Last-Event-ID` resume) pass; `curl` on staging shows the frames.

**GL. Go-live (after S7):** API-only mode (`AO_API_ONLY=1`, done with G1.1), the `/backend` StripPrefix topology, the production profile; the cut-over checklist is [go-live.md](go-live.md) and **replaces S16's cut-over**.

**G1–G5. Platform direction (runtime adapters, open vocabularies, instance config, portability, contract 3.0)**: see [adr-001-runtime-adapters.md](adr-001-runtime-adapters.md) §10. Proposed order: S7a (done) → G2 (done, architect-12: adapter split, typed reads + `engine.request`, `ingestCanonical`, `engine.runtime()`, one runtime home, boot without identity, discovery off until configured) → S7b–S7d on the adapter interface → G3–G5.

**S7. All read VMs and v1 commands as v2 commands.**
- **Timmy's machine auth (PM, from projects-13; must ship and pass BEFORE Owner approves installing `integrations/openclaw-skill/projets/`):**
  - **Principal:** `Authorization: Bearer <token>` on `/api/v2` only. A token resolves to `{ kind: 'agent', tokenId, scopes }` through a store table `api_tokens (id, sha256 hash, created_at, revoked_at)` (migration 004). Only the hash is at rest; lookup is by hash, so there's no secret comparison in JS. The raw token lives outside the repo (`~/.config/agent-office-timmy.token`, 0600). It's created, rotated and revoked by a local script (`scripts/agent-token.js create|rotate|revoke`) that writes the file and never prints the token. It's never logged and never audited.
  - **Enforcement in the route layer, before any handler:** one allowlist of `(method, route pattern, allowed body fields)`:
    - `PUT /projects/:id/status` `{expectedRevision, status}`;
    - `POST /projects/:id/history` `{expectedRevision, kind ∈ commit|flow-run|cron-run|session|agent-action, dedupeKey?, eventAt?, payload…}`;
    - `POST /projects/:id/flags` `{expectedRevision, kind:'label', label}`;
    - `PATCH /projects/:id` `{expectedRevision, summary}` only.

    Matching uses the same Router semantics as the routes (as the S6.2 audit does). **Everything else is 403 `token-scope`**, including every GET, the SSE stream and its transport POSTs, every other area and every other project command. A body `actor` field is refused (400 `unexpected-field`), and the route **forces** `actor: 'timmy'` (the `main` agent Person). A cookie on the same request is ignored, so privileges never mix.
  - **Unknown, malformed or revoked token → 401** (`unauthorized`; nothing says which).
  - **Rate limit:** 30 requests/min per token → 429 `rate_limited` (counted before the handler; refused requests count too).
  - **Audit:** every attempt is recorded with actor `{ kind: 'agent', personId: <timmy> }` and the token id in `detail` (`token:<id>`), never the token or the body. A refused scope is `rejected` / `token-scope`.
  - **Tests (`test/api/agent-token.test.js`):**
    - each allowed command succeeds with the actor forced to Timmy, even when the body tries `actor: 'Owner'` (400) or omits it;
    - wrong scope → 403 for: rename/priority via PATCH, Bloqué, archive, import, a GET of the board, the SSE stream, `/api/v2/meta`-adjacent reads, every v1 route and the health mute;
    - a revoked or rotated token → 401, and a token hash copied into another instance's store doesn't work there;
    - the 31st request in a minute → 429;
    - audit rows for allowed, refused, revoked and rate-limited calls, with no token text anywhere in the db, the logs or the responses;
    - a cookie together with the bearer gets no cookie privileges.
- **Server-side screenshot capturer (PM; behind the interface projects defines; S7 or S15b):** headless Chrome at 1200×630, https only, SSRF-safe:
  - DNS is resolved first, and private, loopback, link-local, CGNAT/tailnet (100.64/10) and metadata addresses are refused, re-checked after redirects;
  - timeouts and size caps apply; results are cached;
  - `repo.image.kind ∈ screenshot | opengraph | monogram` once projects proposes the exact shape.
- **Added to the S7 plan (PM, low priority):** for **active** runs only, derive the current tool kind from the latest `toolCall` in the transcript tail (`sessions.get`, rate-limited, e.g. one fetch per running session every 5 s), and set `OccupantVM.destination` (`server` for exec-class tools) from it. Cheap with the existing transcript normaliser; otherwise `destination` stays null.
- **Work:** the VMs for office, flows (list and detail), access, interlocutors, logs, sessions and skills (list and detail), each with its topic. The commands for flows, skills, the gateway restart and async chat (api.md §5). `cronSteps`, `skillSteps`, `outputTags`, `catOf`, `statOf` and `humanCron` now live in VM builders, with tests. HealthVM `cards[].sub` is `{key, params?}`.
  - **From review R1, inherited behaviour:**
    - **R1-11:** SKILL.md reads use realpath containment in approved skill roots, an expected basename and a size limit, with symlink tests on synthetic temp files. The capture script gets the same treatment.
    - **R1-12:** invalid or option-like ids (`abc/def`, leading `-`) are rejected instead of stripped, with a positional boundary (`--`) where the CLI supports it. Alias-collision and leading-dash tests.
- **Accept:** every VM validates against its schema on staging (`AO_STRICT_VM=1`), and the old UI is unaffected.

### Phase C: the new frontend, page by page

**S8. Frontend foundation at `/v2/`** (after the PM's frontend decision, §3).
- **Work:**
  - `scripts/sync-design.js` copies `design/css/bureau.css`, `design/components/bundle.css` and the approved assets into `public/v2/bureau/`. This is a file copy, not a build, and the generated files are committed;
  - the shell: sidebar on desktop; bottom bar *Bureau · Discuter · Projets · Journaux · Plus* on mobile, with *Flux de travail* under Plus (BRIEF decisions log);
  - Lucide icons as an inline SVG sprite;
  - the theme from `UiPrefs`;
  - the login page;
  - `api.js` (error format → `bu-toast`), `stream.js` (one EventSource, topic switching, delta apply, resync), `fmt.js` and a router (History API, every selection in the URL).
- **Also:** remove the hard-coded e-mail address that pre-fills the old login form (app.js:160). It is not a secret, but it's personal data in a shareable repo.
- **Accept:** login, logout and the empty shell work on desktop and at 375 px wide; a dropped SSE connection reconnects and resyncs; the *Reconnexion…* pill shows when the gateway is down.

**S9. Santé système** (the simplest page; it proves the full loop: VM → snapshot → deltas).
- **Includes:** cards, channels, sources, *Qualité des données* (with mute for warn and info issues) and sparklines.
- **Accept:** the values update live without polling (today the page polls every 5 s); killing the gateway connection on staging flips the cards within 1 s of the event.

**S10. Journaux + session transcript** (Trace component: tree and timeline). Cursor paging. **Accept:** parity with today's Journaux, plus live appends on an open transcript.

**S11. Compétences** (list + detail + flow diagram). Toggling is blocked on staging (`readonly`) with the French message. **Accept:** parity; the empty-page failure mode is now impossible (it would show as an `error` issue with a cached list).

**S12. Flux de travail + Habilitations/interlocutors.** Create, edit, run and delete forms with server-side validation messages. **Accept:** parity; the run history updates live after *Exécuter maintenant* (no more `setTimeout(reload, 4000)`).

**S13. Discuter** with async turns over SSE (typing indicator from the `pending` item). **Accept:** a 2-minute turn survives a page reload (the turn lives on the server and the reply appears when it arrives).

**S14. Bureau, the new illustrated office.**
- **S14a, scene renderer:**
  - layered DOM images per `design/office/README.md` (shell, wall, decal, depth-sorted scene, light, fx, labels);
  - the occupants list from `OfficeVM`;
  - pose and marker from `state`;
  - walking and crossfades are client-side animation only;
  - cues from SSE;
  - reduced-motion support;
  - the roster list beside the scene, from the same occupants;
  - KPIs and the journal.

  The pixel `office.js` is deleted from v2.
- **S14b, layout from the store:** the server resolves stations and looks; the layout is fetched when `layoutRevision` changes.
- **S14c, customization editor** (`design/office/editor.md`): Disposition, Personnages, Thème; save with `expectedRevision`; undo from the revisions.
- **Needs:** the codex assets for the room, furniture and Timmy/sub-agent poses. Until they land, the renderer uses the manifest's placeholder images, and S14c can ship before the final art.
- **Accept:**
  - the scene, roster and agent drawer always show the same state (one field);
  - 60 fps on the staging laptop with 7 occupants;
  - keyboard and screen reader access per the office README §5.

**S15. Projets.** Backend first, then the UI, each sub-step shipped on its own:
- **S15a:** store repos for projects, flags, people and history; the project commands; `BoardVM`/`ProjectVM`; the board (Kanban with drag and drop and optimistic UI with revert on `409`); a manual project; the detail page with Résumé, Historique, Flags and Personnes. Labels, priority and manual *Bloqué* work.
- **S15b:** GitHub sources through `gh` (`repo_cache`, the Dépôt panel, commit history events, the OpenGraph image); the `ci-red` risk.
- **S15c:** workspace and session-group sources; flow, cron and session history events (`dedupeKey`); derived people; the `cron-failing`, `flow-failing` and `stale` risks (the risk monitor).
- **S15d:** the feature-flag scan (after Owner's convention, data-model.md open question 4).

**Accept, per sub-step:** every status move appears in Historique with its actor; a risk raised automatically clears itself when the cause goes away; ack/un-ack works; card order follows priority, then last activity.

### Phase D: cut-over

**S16. Replace the old UI.**
- **Work:**
  - `/` serves v2, and `/v2/*` redirects;
  - delete `public/app.js`, `public/office.js`, `public/_ds/` (Salsa) and `routes/v1-legacy.js`;
  - the service worker gets a new cache name so old clients drop the old bundle.
- **Then:**
  1. The PM merges `redesign` into `main`.
  2. Owner (through the PM) chooses when to restart the production service; the store is created on first boot.
- **Rollback:** redeploy the previous `main` commit; the store is ignored by the old code.
- **Accept:** a production smoke test (login, the 8 pages, SSE live) and `/api/v2/me` reports `gwConnected: true`.

## 3. Frontend: build step and framework (decision for the PM)

**What the stateless frontend needs:**
- keyed list updates driven by SSE deltas (roster, journal, Kanban, transcripts);
- a few interactive components: Kanban drag and drop, the office scene with animation, forms and a modal;
- nothing else. There's no client-side data logic left to organise.

| Option | What | For | Against |
| --- | --- | --- | --- |
| **A. Vanilla ES modules** | Native `import`, plus a ~150-line in-house `html` tagged template with keyed DOM morphing | no dependency, no build, same as today | we own a mini renderer; keyed diffing and event cleanup are easy to get subtly wrong; more code per page |
| **B. Preact + htm, vendored, no build** (recommended) | Two pinned ESM files (≈ 4 KB + 1 KB gzipped) in `public/v2/vendor/`, loaded with an import map; components written with `htm` tagged templates | components, keyed diffing and hooks, battle-tested; still no build step; a small, auditable surface; works directly with the Bureau CSS classes | one new runtime dependency (vendored, so no npm install in production); JSX-like templates are a new idiom in this codebase |
| **C. Vite + TypeScript + a framework** | A build step producing `public/v2/dist` | full type checking shared with the server types; tooling; HMR | a toolchain to maintain on a home server; the build must run before every deploy; generated files to commit or build on the host; overkill for ~10 pages fed by server VMs |

**Recommendation: B.** The server now does the heavy lifting, so the client only needs a reliable keyed renderer, and Preact + htm gives that without changing how the project is built or deployed. If the PM declines the dependency, fall back to A and budget about one extra day in S8 for the renderer and its tests.

**Type checking (optional, independent of the choice above):** add `typescript` as a **devDependency** only, to run `tsc --noEmit --checkJs` over the JSDoc types in CI or before staging restarts. It's never loaded at runtime. Separate approval.

## 4. Dependencies summary
| Step | New dependency | Status |
| --- | --- | --- |
| S0–S7 | none (`node:test`, `node:sqlite`, `node:crypto`, `ws` already present) | — |
| S8 | `preact` + `htm`, vendored ESM (option B) | **needs PM approval** |
| any | `typescript` (devDependency, type-check only) | optional, **needs PM approval** |
| S15b | none: uses the host's `gh` CLI | confirm that `gh` is authenticated for Owner's user on the host |

## 5. Risks
- **Fixture capture touches live data.** The script is read-only and redacts, but the PM must review its output before anything is committed.
- **Staging shares the gateway.** The read-only guard moves into the CLI wrapper in S1, so an API v2 route added later can't bypass it.
- **Gateway protocol drift** (OpenClaw upgrades): versioned schemas and `version.untested` make it visible on Santé système on day one, instead of an empty page.
- **Office assets are on the critical path for S14.** Mitigation: S14a ships with placeholders, and the scene contract (occupants, stations, states) doesn't depend on the art.
- **SSE behind Traefik:** the 25 s heartbeat stays, and `X-Accel-Buffering: no` is kept.
