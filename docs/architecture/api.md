# API contract (v2)

**Contract version 2.10** (2026-10-13: source-aware projects and server-shaped team rosters; 2.9: typed subagent results and backend-resolved chat author appearances; 2.8: adapter-declared canonical health checks and remedies; earlier history below). This document is the single source of truth for the HTTP and SSE wire format between the server and its consumers. Only the architect edits it; proposals go through the PM.

**Contract 3.8** (`/api/v3`, G5) is `api-v3.md`: this document plus the deltas listed there. `/api/v2` serves revision 2.10 until the UI has moved (`migration-v3.md`).

## Changelog
| Version | Date | Changes |
| --- | --- | --- |
| 2.10 | 2026-10-13 | Source filters use canonical source identities (connector instance for conversations, owner for GitHub, declared root for folders, manual source), aggregate distinct project counts, and resolve every kind through FR/EN LabelRefs (2026-10-14). Projects import also supplies labelled statusOptions on CandidatesVM; Projects detail additionally supplies ordered statusTransitions with LabelRefs (2026-10-14); unavailable transitions are empty after source/caller/store policy. Projects add source descriptors/brands, backend-selected source filters, status/count/capability values and empty-state labels. TeamProject adds server-shaped roster groups/members/portraits, task/summary counts and column labels. For permission-scoped Projects reads, topic revisions are opaque payload-derived tokens and SSE sends snapshots only (§4.3). Same projection on v3; examples and shared schemas regenerated. |
| 2.10 additive (T-0140) | 2026-10-14 | Office visits follow each conversation's canonical owning agent. VisitIntent groups visitors by host; visiting occupants carry a localized `visitLabel`, nest under that host, use its floor, and receive a backend-computed reachable visitor target without consuming a desk. The scene only animates these supplied targets. |
| 2.10 additive (T-0237) | 2026-10-18 | Authorized team occupants may include `OccupantVM.memberId`, a stable team-member identity used to join the Bureau character to the Projects roster across runtime session changes. It is omitted without `teams.read`. Team portraits use this exact join or a stable member-derived non-primary look; a role label equal to the member name is omitted. |
| 2.9 | 2026-10-13 | Chat messages add `kind`, structured `body`, backend-resolved `avatar`, and nullable result metadata. Trusted adapter-projected delegated output is `subagent-result` on the assistant side with task title, canonical status and `statusLabel`; the original Markdown body is preserved. Same ChatVM shape on 3.6. Examples `chat-vm` and SessionVM event variant updated. |
| T-0102 additive | 2026-10-12 | Backend floor-scoped LayoutVM/topic, commands and history via `floorId`; `allowNoDesk?: boolean` supplies editor validation policy. Floor saves preserve the other layouts and global appearance rules. Same addition on v3; §3.10. |
| 2.8 | 2026-10-10 | Add canonical adapter-declared `HealthCheckVM` rows, bounded automatic/one-click/guided remedies and audit outcomes; `POST /health/checks/:id/fix` and `POST /health/fix-all`. Santé uses localized explanations instead of raw source/path names. Unknown session classifications remain generic and count once. **T-0053 additive:** `OccupantVM.isNew?: boolean` marks an auto-added agent during its first 24 hours; absent or false means no marker. |
| 2.7 | 2026-10-09 | Locked missing-secrets recovery page; strict named partial-login boot errors; first-run DB owner and code-gated resumption/amendment/recovery; adapter-owned detection/discovery and connect capability; explicit `agent:<id>` peer occupants and role `agent`; runtime-scoped display names; reviewed installation plans with safe descriptor I/O and rollback; network guide; config v2 with strict v1 reader. Setup route examples and `SetupVM` schema are executable. Same additions in contract 3.2. |
| 2.6 | 2026-10-08 | Runtime-neutral Sender identity (`senderInfo` on trace/chat messages), `SessionVM.participants` for humans and primary agents plus `SessionVM.subagents` with linked delegation labels/tasks, metadata-free display text and plain-text summaries, stable human avatars and sender grouping. `user.sender` remains a compatibility display string. See [sender-identities.md](sender-identities.md). |
| 2.5 | 2026-10-06 | **Compatibility exception (G5; review-22 R22-09):** `MetaVM.labels` no longer carries the server-only `prompt.*` keys (`prompt.projectSummary`, `prompt.noSources`: agent prompts, never UI text) on 2.x either. Every other 2.x byte is unchanged by G5. <br>**G4 first-run setup (§5.7, ADR-001 §5).** New routes `GET /api/v2/setup`, `POST /api/v2/setup/check`, `POST /api/v2/setup/discover`, `PUT /api/v2/setup`, from frontend-12 §2 with these changes: **`owner.password`** (write-only) in `PUT`, and `draft.owner.passwordSet`; **`SetupVM.configured`**; **`draft` is null** unless `state` is `open`; a locked instance answers 403 **`forbidden` `{issue:'locked'}`** (`readonly` stays for a read-only instance); results use the standard `CommandResult` envelope. **`MetaVM.instance.configured: boolean`** (additive). Examples `setup-vm`, `setup-check-request`/`-result`, `setup-discover-result`, `setup-save-request`/`-result`, `error-403-setup` (+ sidecars). |
| backend-1 | 2026-10-07 | Project delivery adds `working` and `no-reply`, durable deferred session/child following, summary-event delivery states, and `POST /projects/:id/comments/:cid/retry {agentId}` (202, original author, failed/no-reply only). Linked-session prompt context now contains real requests and final results. Comment creation accepts optional `replyTo`; id/name mentions fold case and accents, and answers stay under the exact mentioning comment even in nested replies. Same extension on v2/v3. |
| 2.4 | 2026-10-06 | **Named session-group refs (PM decision on architect-14, BRIEF Decisions log 2026-10-06).** A `sessionGroup` source's ref is now **`{by: 'group', groupId: SessionGroupId, name}`**: the runtime's group, so sessions filed into it later join the project. `{by: 'keys', sessionKeys}` stays **only as a fallback** for runtimes without groups; `{by: 'interlocutor'}` is unchanged. Applies to `ProjectSourceInput`, `ProjectVM.sources[].ref` and `CandidateVM.sources[].ref`. **`SessionGroupId`** is opaque (1–200 chars). OpenClaw 2026.9.8 keys its catalog by name, so there `groupId === name`, and **a rename yields a new id** (the source then matches no sessions until it's relinked). Examples `project-vm`, `error-409-project` (main example now `by: 'group'`; `interlocutor` and `keys` are sidecar variants), `candidates-vm` (a group candidate `sg:group:Automations`), `import-request`/`import-result` updated. <br>**S7b (implementation, no shape change):** every read view in §3 is served from the engine. New authoritative examples `flow-list-vm`, `flow-detail-vm`, `logs-page`, `access-vm`, `interlocutor-vm`, `skill-list-vm`, `skill-detail-vm` (+ sidecars); `office-vm`'s queue `day` param is the string `"1"` like everywhere else. Only the first logs page **at the default size (50)** is a topic; other sizes and later pages are one-shot. Labels added: `schedule.*`, `flowHealth.*`, `runStatus.skipped/unrecognized`, `delivery.*`, `sessionTarget.*`, `wakeMode.*`, `payloadKind.*`, `accessPolicy.*`, `execSecurity.*`, `interlocutorKind.*`, `resolution.*`, `discordChannelType.*`, `kpi.flowsTotal {n}`; **`kpi.idle` takes `{agent}`** (was « Timmy au repos », ADR §12.9); enum `flowHealth`. |
| 2.3 | 2026-10-05 | **Project images (projects' proposal; PM decision after Owner's iPad review):** `ThumbVM {kind: screenshot \| opengraph \| monogram, url, repoLabel, initials, accent}` replaces `{kind: …generated, tint}`; `RepoVM.image` (same object without `repoLabel`). ProjectCovers aren't referenced. Examples `project-vm`, `board-vm`, `error-409-project` updated. <br>**English (G3c, explorer-06; additive):** `MetaVM.locale: 'fr' | 'en'` and `labels` in that locale (the `UiPrefs.locale` preference, else the best `Accept-Language` match, else fr; `Vary: Accept-Language`); `UiPrefs.locale: 'fr' | 'en' | null` (`PATCH /prefs`; null = follow the browser); `MetaVM.runtime.gatewayLabel` is localised. Server labels: `src/i18n/en.js` covers every `fr.js` key with the same placeholders; explorer-06's corrections applied to both (no runtime or agent name in generic labels). Error messages stay French until G5. **Typed VMs (PM audit (B), no shape change):** every VM in §3 has a schema and a class (`src/api/v2/vm/schemas.js`, `classes.js`); the server validates each VM at runtime before sending it (dev/test: an invalid VM throws; production/staging: the last good VM is sent and a quarantine issue `vm.invalid` / channel `vm.<name>` is raised; `AO_STRICT_VM=1` forces throwing). `undefined` is never allowed anywhere. The UI can validate incoming VMs in dev with the same rules: `import { validateVM } from './generated/vm-schemas.js'` (built by `node scripts/build-vm-schemas.js`). **Login hardening (PM audit (A), go-live gate):** `POST /api/login` accepts **JSON bodies only** (415 otherwise); credentials are verified against an scrypt hash in constant time (same 401 for a wrong e-mail or password); **throttled** per client IP (5 free failures in 15 min, then 2, 4, 8 … s, ≤ 15 min) and globally (> 20 failures/min across clients) → **429 with `Retry-After`** (`{error, retryAfterSec}`); every attempt is audited (`auth.login`). **Copy fixes (office-dev):** `schedule.weekly` is « Chaque {day} à {time} » with `day` a nested LabelRef `weekday.0`…`weekday.6` (was a raw `"1"`); `liveEvent.run.started` is past tense; `skillOutput.agent-reply` is « Réponse de {agent} » (the client supplies `{agent}` from the primary agent, ADR §12.9). **S14b (implementation):** `GET /office/layout` (topic `layout`, re-pushed at `theme.nextChangeAt`), `GET /office/layout/revisions/:rev`, `PUT /office/layout` and `/office/layout/theme` (409 with `current`; the shared validator's issues with `field` `items.<uid>`/`agents.<id>`, never its messages; a structural check first names the bad top-level field), `GET`/`PATCH /prefs` (topic `prefs`); the default layout is seeded as revision 1 by the system; `OfficeVM.layoutRevision` is the active layout's revision; `agentsSeen` fills from the office view. Topic batches accept known topics and list unknown ones in `rejected` (also `hello.rejected`). **S7d (additive):** ErrorCode **`forbidden`** (403, `issue:'token-scope'`) and the agent's scoped token (§5.6). **G2 additions (additive, no version bump):** `MetaVM.runtime {id, name, gatewayLabel}` from the runtime adapter (frontend-06); `SourceErrorCategory` `not-configured` (label `sourceError.not-configured`) for a runtime without identity or token. |
| (unversioned, architect-57) | 2026-10-07 | **Additive.** <br>• **Project thread** (§5.4b): `GET /views/projects/:id/comments` → `CommentThreadVM` (topic `comments:<id>`, example `comment-thread-vm.json`); `POST /projects/:id/comments {body}` (201), `PATCH …/comments/:cid {body}`, `DELETE …/comments/:cid` (soft). An `@agent` mention is delivered to that agent in the project's own session `agent:<id>:ao-projet-<slug>` (never a channel); the reply is posted as the agent's comment. <br>• **Regenerate the summary** runs in that session with the project's context; the request (`event`) and the reply show in the thread. <br>• `HistoryItemVM.session?` (session rows: label, summary, messages, route). |
| (unversioned, architect-55) | 2026-10-07 | **Additive.** <br>• **`Priority` is `P0`…`P9`** (was `P0`…`P3`; P0 the most urgent and important). Stored P0–P3 values are unchanged. Labels `priority.P0`…`priority.P9` are FR/EN, and P1–P3 were relabelled for a ten-level scale; `enums.priority` lists ten. <br>• **`OccupantVM.exchanges?`** (above). <br>• **Project tags** (`docs/guide/project-tag.md`): a tagged slug creates its project as the agent; `candidateReason.agent-tag`; the tag call never appears in a session's trace. |
| 2.2 | 2026-10-05 | **S6.1 + S6.2 (PM live findings on S6 staging; review R8).** <br>• **ChannelId `wechat`** (was `weixin`; raw `openclaw-weixin`/`wechat`/`weixin`), fixed labels Discord / WhatsApp / WeChat (`LogRowVM.channel`, HealthVM channels, CronJob delivery). <br>• **`MeVM.displayName`** (`PORTAL_DISPLAY_NAME`, else the e-mail's local part). <br>• **`SourceErrorCategory` + `rate-limited`** (GitHub, projects' repo cache). <br>• Labels added: `source.cli`, `source.engine`, `runEnd.killed`, `runEnd.budget-limited`, `priority.*`, `sourceError.rate-limited`; a test pins label coverage for every emitted key. <br>• **Strict shape checker (R8-08/09):** null only where the example or its sidecar `<name>.types.json` allows it; same-key-set elements merge (kind is a semantic enum); unmodelled subtrees reported; LabelRef params validated; use `compareExample(name, value)`. <br>• **Audit (R8-06/07):** every Express-accepted variant of a write route is audited; attempts without a verified session are recorded with actor `{kind:'anonymous'}` (including 401s). <br>• **Diagnostics (R8-02, PM rule):** an advertised event name appears in a channel only if it matches `^[a-z][a-z0-9._-]{0,63}$`. |
| 2.1 | 2026-10-05 | **S6 implementation notes (no shape change):** the resumed `hello` has no `id:`; `system.closing` on the final frame; logout revokes server-side; `Secure` cookie switch; `health-vm.json` example; history `flow-run`/`cron-run` group keys aligned to the frontend (`.group.succeeded`/`.group.failed`). <br>**Merge of the 2.0 open items and reviews R6/R7.** <br>• **Examples are the contract (PM, on review-07):** authoritative payloads in `docs/architecture/examples/` and the shape checker `test/helpers/contract-shape.js` (§7). A shape change = example + changelog first. <br>• **R7-01:** `ProjectVM` keeps `recentHistory`/`historyNextCursor`; `HistoryItemVM.text` is a `LabelRef` with the `historyKind.*` table (§3.9.1); `ActorVM` (§3.0); `sources[].ref` added; no `repoNotice`/`archivedAt`/`repo.image`. <br>• **R7-02:** `GET /api/v2/views/project-candidates` → `CandidatesVM` (§3.14), a one-shot GET; `POST /api/v2/projects/import` → `{created, skipped}` (§5.4). <br>• **Frontend-02 answers:** `LabelRef` params are raw and may nest; `sourceError.<category>`; units are data keys `percent`/`bytes`/`ms`/`count`/`tokens`; a board 409 reverts and resyncs (no card in it); **every delta op is idempotent** (§4.5); project action gaps closed (§5.4: regenerate summary, archive UI via `projects?filter=archived`, people overrides). <br>• **Frontend-03 answers:** `TraceEventVM.id` (`ev:<message>:<part>`) and `SessionVM.events` as a Collection; label namespaces `sessionKind`, `runStatus`, `toolKind`, `channel`, `runEnd` and `MetaVM.enums.sessionKind`; heartbeats hidden unless `heartbeat=include`; `run.endReason` closed; `modelProvider` on `LogRowVM`/`SessionVM`. <br>• **Session data (PM):** `SessionVM.cwd` and `messageCount: number \| null`. <br>• **Office (office-dev api-proposal, R3-08/14…18):** manifest v2 encoding, `OccupantVM.ruleId`/`destination`, `LayoutVM.default`/`revisions`/`agentsSeen`/`theme.season`/`layout.updatedBy`, theme quick toggle and revision routes, the shared validator `layout-rules.js`, cue `partnerId`/`interactionId` (§3.2, §3.10, §3.13, §4.4, §5.5). <br>• **S4.1 (review R6, PM privacy decision):** `IssueVM` is value-free: no `source`, `detail` or `sample` (§3.8). <br>• **S4.1 (R6-09):** cron delivery channel is a `ChannelId` or `'last'`; delivery statuses mapped (architect-04b). |
| 2.0 | 2026-10-05 | **C1, review R3.** <br>• **R3-01:** every route has complete request/response types and a JSON example (§3, §5). One success envelope, with no exceptions (§2.1). Paged lists use `{items, nextCursor}`. <br>• **R3-02/03:** SSE topic identity with parameters, server-global topic revisions, the `resync` operation, resume identity and expiry, the path grammar for nested deltas, and exact multi-client and board-move sequences (§4). <br>• **R3-04:** `expectedRevision` on every project write; 409 carries the authoritative revision and `ProjectVM` (§2.2, §5.4). <br>• **R3-05/06:** history kind and activity rule per write (§5.4). <br>• **R3-09:** per-channel source status (§3.10). <br>• **R3-10:** split `capabilities`, and transport control is never guarded (§3.1, §5). <br>• **R3-11:** FlowDetailVM schedule and payload unions, `editable` (§3.4). <br>• **R3-12:** `ProjectSourceInput` (§5.4). <br>• **R3-13:** writable flag subsets, feature `state` in `FlagVM` (§3.12, §5.4). <br>• **R3-20:** `RepoVM.state` for a repo not yet fetched (§3.12). <br>• Office R3-14…18: marked **pending office-dev proposals** in §3.13/§5.5. |
| 1.1 | 2026-10-05 | F1 (frontend-01): `meta.env`, label namespaces, HealthVM `sub {key, params?}`, the mute route, value-free data quality. `/v2` serving rules (§6). LayoutVM carries the generated manifest. No `index` on project moves. |
| 1.0 | 2026-10-05 | First draft. |

The frontend is **stateless**: it holds no business state and derives nothing. It renders what the server sends, keeps the latest copy of each view model it's showing, and applies typed deltas from SSE.

## 1. Principles
- **View models, not entities.** Each page has a view model (VM) built from canonical types (data-model.md). A VM contains exactly what the page shows, already ordered and filtered, with enum **keys**, never labels or colours.
- **Labels come from one dictionary:** `GET /api/v2/meta` (§3.1). The client maps keys to `--bu-*` tokens.
- **Time:** timestamps are epoch ms (`*At`, `Ms`), durations are ms (`*Ms`). The client formats relative times.
- **What "stateless" allows** on the client: the route (URL), focus, scroll, open panels, drag-in-progress, office zoom and camera, unsent form input. Anything that matters on reload lives in the URL or on the server (`UiPrefs`).
- **Base path** `/api/v2/`. The old `/api/*` routes stay until S16.
- **Auth:** the HMAC-signed cookie `taco_sess` (12 h). Every `/api/v2` route except `GET /api/v2/meta` requires it; otherwise 401 `unauthorized`.
- **Common types** used below: `Ms = number`, `ProjectId = 'prj_…'`, `PersonId = 'per_…'`, `SessionKey`, `CronJobId`, `AgentState`, `OccupantRole`, `ProjectStatus`, `Priority`, `Severity`, `RiskKey`, `IssueCode`, `SourceId`, as defined in data-model.md.

## 2. Envelopes and errors

### 2.1 Success: one envelope, no exceptions
Every successful response body, reads and commands alike, is:
```ts
interface Ok<T> {
  data: T;
  meta: {
    modelVersion: number;            // data-model MODEL_VERSION; a change means "reload"
    generatedAt: Ms;
    stale: SourceId[];               // sources whose state isn't 'fresh' (« Données en cache »); [] when all fresh
    topic?: { id: string; rev: number };   // reads that back an SSE topic: its id and current revision (§4)
  };
}
```
- **Paged lists:** `data` is `Page<T> = { items: T[]; nextCursor: string | null }`. `?cursor=<opaque>&limit=<1..100>` (default 50; project history default 20). `nextCursor: null` means there are no more pages. An invalid cursor → `400 validation_failed` (`details:[{field:'cursor', issue:'invalid'}]`).
- **Commands:** `data` is `CommandResult<R>` (§5). Accepted asynchronous work (chat) uses the same envelope with HTTP 202.
- **No content:** never used; deletes return `Ok<CommandResult>` too.

### 2.2 Errors: one format everywhere
```ts
interface ApiError {
  error: {
    code: ErrorCode;
    message: string;                  // French, safe to show in a toast
    details?: { field?: string; issue: string }[];   // validation_failed and some conflicts; `issue` values are listed per route
    requestId: string;                // also in the X-Request-Id header
    current?: { revision: number; vm: ProjectVM };   // ONLY on 409 for project writes: the authoritative state to apply
  };
}
type ErrorCode =
  | 'unauthorized'          // 401: no, invalid or expired session
  | 'readonly'              // 403: this instance refuses this class of write (§5.0); message « Instance de test : actions désactivées. »
  | 'forbidden'             // 403 (2.4, S7d): an agent token outside its scope (details.issue 'token-scope'); see §5.6
  | 'not_found'             // 404
  | 'validation_failed'     // 400: body or query failed its schema, or a domain rule (details.issue says which)
  | 'conflict'              // 409: stale expectedRevision, or a state conflict (chat turn pending, source already linked…)
  | 'rate_limited'          // 429: gateway restart within 2 min; an agent token over 30 requests/min (§5.6)
  | 'upstream_unavailable'  // 503: gateway disconnected / CLI not reachable
  | 'upstream_failed'       // 502: the gateway/CLI answered with an error (message is a fixed French phrase, never upstream text)
  | 'internal';             // 500
```
- A failure is never a 200. Request bodies and queries are validated with the schema DSL (`extra: 'reject'`): unknown fields → `validation_failed` with `issue: 'unexpected-field'`.

Example (stale drag):
```json
{ "error": { "code": "conflict", "message": "Le projet a changé entre-temps.", "requestId": "req_8f2c1a",
  "current": { "revision": 8, "vm": { "id": "prj_k3v9q2m8x1c4d7fz", "revision": 8, "status": "in-review", "…": "…" } } } }
```

## 3. Read endpoints (view models)

| Route | `data` type | Topic (§4) |
| --- | --- | --- |
| `GET /api/v2/meta` (no auth) | `MetaVM` | — |
| `GET /api/v2/me` | `MeVM` | — |
| `GET /api/v2/views/office` | `OfficeVM` | `office` |
| `GET /api/v2/views/office/characters?scope&search` | `OfficeCharactersVM` | — |
| `GET /api/v2/views/chat` | `ChatVM` | `chat` |
| `GET /api/v2/views/flows` | `FlowListVM` | `flows` |
| `GET /api/v2/views/flows/:jobId` | `FlowDetailVM` | `flow:<jobId>` |
| `GET /api/v2/views/access` | `AccessVM` | `access` |
| `GET /api/v2/views/interlocutors/:id` | `InterlocutorVM` | `interlocutor:<id>` |
| `GET /api/v2/views/logs?kind&heartbeat&cursor&limit` | `Page<LogRowVM>` | `logs` / `logs?kind=<k>` / `logs?heartbeat=include` (first page only) |
| `GET /api/v2/views/sessions/:key` | `SessionVM` | `session:<key>` |
| `GET /api/v2/views/skills` | `SkillListVM` | `skills` |
| `GET /api/v2/views/skills/:name` | `SkillDetailVM` | `skill:<name>` |
| `GET /api/v2/views/health` | `HealthVM` | `health` |
| `GET /api/v2/views/projects?filter&source` | `BoardVM` | `projects` / `projects?filter=<f>&source=<source-id>` |
| `GET /api/v2/views/projects/:id` | `ProjectVM` | `project:<id>` |
| `GET /api/v2/views/projects/:id/history?cursor&limit` | `Page<HistoryItemVM>` | — (new events arrive in `ProjectVM.recentHistory`) |
| `GET /api/v2/views/project-candidates` | `CandidatesVM` (2.1) | — (one-shot) |
| `GET /api/v2/office/layout` | `LayoutVM` | `layout` |
| `GET /api/v2/office/layout/revisions/:rev` | `{ revision; updatedAt; updatedBy: ActorVM; data: OfficeLayoutDataV1 }` (2.1) | — (404 past retention) |
| `GET /api/v2/prefs` | `UiPrefs` | `prefs` |

Path parameters are URL-encoded; `:key` is an encoded session key. An unknown id → 404 `not_found`. Each VM builder is a pure function `(registry, store, params) → VM`, validated in tests (and at runtime with `AO_STRICT_VM=1`).

### 3.0 Shared pieces
```ts
type Collection<T extends { id: string }> = T[];     // display order; every item has a stable id
// 2.1 (PM, on frontend-02): params are RAW data — keys, numbers, ISO 8601 durations ('PT2M8S') — and a param may itself be
// a LabelRef (a status, a risk). The client resolves nested refs recursively and formats numbers and durations itself.
interface LabelRef { key: string; params?: Record<string, string | number | LabelRef> }   // key into MetaVM.labels
interface PersonChip { id: PersonId; kind: 'human' | 'agent' | 'git'; name: string; avatarUrl: string | null; state: AgentState | null }
type ActorVM = PersonChip | { kind: 'system'; name: string };   // who did it; the system's name is the fixed « Système »
type Unit = 'count' | 'tokens' | 'percent' | 'bytes' | 'ms';    // 2.1: units are data keys; the client formats
interface Kpi { id: string; label: LabelRef; value: number | null; unit: Unit; sub: LabelRef | null }
```

### 3.1 MetaVM, MeVM

`GET /meta` is public for bootstrap, with request-aware enrichment on both versions. Without a valid owner cookie it contains static labels, null `primaryAgent`/`runtime`, no source inventory in the envelope, and (v3) null `instance.name`/empty `runtimes`. Agent/project/runtime names and the dynamic dictionary are owner-only, including chosen Settings names. Invalid/expired/revoked cookies receive the public projection; bearer scope remains unchanged. Responses are `no-store` and vary by `Accept-Language, Cookie`; public/owner validation fallback caches are separate. Both projections preserve `bootId`, configured state, versions and locale/time-zone fields. Clients refresh on login and clear private metadata before rendering logout/expiry, discarding old in-flight responses.

```ts
interface MetaVM {
  bootId: string; // opaque process identity; stable until the owning process restarts
  modelVersion: number; apiVersion: 2; contractVersion: '2.10'; serverVersion: string;
  env: 'production' | 'staging' | 'dev';     // mock mode is allowed only when meta is 404 or env !== 'production'
  capabilities: {                            // R3-10: two independent switches
    openclawWrites: boolean;                 // false when PORTAL_READONLY=1 (flows, skills, restart, chat)
    storeWrites: boolean;                    // false when PORTAL_READONLY_STORE=1 (projects, layout, prefs, mute)
  };
  readonly: boolean;                         // deprecated alias of !capabilities.openclawWrites (kept for 2.x)
  primaryAgent: { id: string; name: string; avatarUrl: string | null } | null;   // 2.4 (G3a, ADR §12.2/§12.9): the resolver's agent; null before
                                             // any agent listing. The UI names the agent from this, never a literal.
  instance: { timeZone: string /* IANA */; locale: string /* e.g. fr-CA */; configured: boolean /* 2.5, G4: false = setup mode (§5.7) */ };   // 2.4 (G3a, ADR §12.7): format every time in this zone
  runtime: { id: string; name: string; gatewayLabel: string };   // 2.3 (G2, additive): the agent runtime as its adapter names it,
                                             // e.g. { id: 'openclaw', name: 'OpenClaw', gatewayLabel: 'Passerelle OpenClaw' }.
                                             // The UI never writes a runtime's name itself (ADR-001 §12.9).
  labels: Record<string, string>;            // '<namespace>.<key>' → French; namespaces: agentState, projectStatus, healthLevel,
                                             // healthCard, healthValue, healthSub, channelHealth, source, sourceState, issueCode,
                                             // issueSeverity, issueState, toast, flagKind, risk, historyKind, schedule,
                                             // error (ErrorCode only), sourceError (SourceErrorCategory), kpi, occupantRole,
                                             // liveEvent, sessionKind, runStatus, runEnd, toolKind, channel   (2.1)
  enums: Record<string, string[]>;           // ordered members, e.g. projectStatus → [idea, todo, in-progress, in-review, shipped];
                                             // 2.1 adds sessionKind (the Journaux filter)
}
interface MeVM { email: string; displayName: string /* 2.2: owner's name (PORTAL_DISPLAY_NAME), else the e-mail's local part */;
               gateway: 'up' | 'down'; capabilities: MetaVM['capabilities']; sessionExpiresAt: Ms }
```
```json
{ "data": { "bootId": "fixture-process-before-restart", "modelVersion": 1, "apiVersion": 2, "contractVersion": "2.10", "serverVersion": "2026.10.5-s6", "env": "staging",
  "capabilities": { "openclawWrites": false, "storeWrites": true }, "readonly": true,
  "labels": { "agentState.working": "Exécute", "projectStatus.in-progress": "En cours", "healthSub.cores": "Sur {n} cœurs" },
  "enums": { "projectStatus": ["idea", "todo", "in-progress", "in-review", "shipped"] } },
  "meta": { "modelVersion": 1, "generatedAt": 1791223200000, "stale": [] } }
```

### 3.2 OfficeVM
```ts
interface OfficeVM {
  connection: { gateway: 'up' | 'down'; since: Ms | null };
  kpis: Collection<Kpi>;                     // ids: active, runs, subagents, flows, tokens, cpu
  occupants: Collection<OccupantVM>;         // roster order (main first); the scene and the roster read this one list
  occupantOverflowCount?: number;            // eligible rows omitted by the bounded office projection (limit 64); absent on older VMs
  visitIntent?: VisitIntent;                   // visits are host-specific; placement and labels are backend-owned
  journal: Collection<JournalItemVM>;        // newest 14
  layoutRevision: number;                    // client refetches GET /office/layout when it changes (or follows the `layout` topic)
  queue: Collection<{ id: CronJobId; name: string; schedule: LabelRef }>;   // « File »: enabled jobs, next 8
}
interface OccupantVM {
  id: OccupantId; role: OccupantRole; name: string;
  title: LabelRef;                           // 2.4 (Q03-A01): the name as a LabelRef (sessionTitle.*; genuine names as raw params), shown in the UI's language
  roleLabel: LabelRef | null;                // semantic role label; null when it would duplicate the rendered name; a custom layout role replaces it as { key: 'custom', params: { text } }
  state: AgentState; stateSince: Ms;
  execution: { status: 'unknown' | 'idle' | 'running' | 'succeeded' | 'failed'; evidence: { level: 'verified' | 'observed' | 'unknown'; observedAt: Ms | null; expiresAt: Ms | null } };
  stationUid: string | null;                 // null = no free eligible station (overflow), see data-model §12
  homeTarget?: OfficeTarget | null; sceneTarget?: OfficeTarget | null; // reserved home and backend-selected current target
  activity?: OfficeActivity | null; sceneTravel?: SceneTravel | null;  // the client animates these backend decisions
  automaticLook?: { character: string; variant: string | null; accessories: string[] }; // T-0052: durable first-sight look, reused in previews
  look: { character: string; variant: string | null; accessories: string[] };   // resolved server-side (data-model §12); final
  ruleId: string | null;                     // 2.1 (R3-14): the agentId of the layout rule that styled it ('main', '*subagent', …)
  teamId?: string | null; teamIds?: string[]; memberId?: string; // stable team member join only with teams.read; one primary team plus additional memberships
  destination: { kind: 'server' | 'meeting'; stationUid: string } | null;   // 2.1 (R3-15): server-authoritative; null on 2.0 data
  sessionKey: SessionKey | null; tokens: number; lastSeenAt: Ms | null;
  isNew?: boolean;                              // T-0053: auto-added agent, for 24 hours after first sighting
  summary?: string; model?: string; project?: string; runtime?: string;
  startedAt?: Ms; lastActivityAt?: Ms; tokensKnown?: boolean; // session read grant only
  visitPhase?: 'person' | 'agent' | 'linger'; visitOnStage?: boolean; visitStateLabel?: LabelRef; visitLabel?: LabelRef;
  // architect-55 (additive, v2 and v3): conversation occupants (direct/group/conversation) whose transcript is known.
  // An exchange = a message from the person answered by the agent, timed at the reply; recent = within windowMs (600000).
  exchanges?: { recent: number; windowMs: number; lastAt: Ms };
}
interface OfficeTarget { kind: 'station' | 'lounge' | 'standing' | 'destination' | 'visit'; floorId: string; stationUid: string | null;
  point: { x: number; y: number }; approachPoint: { x: number; y: number } | null; seatContact: { x: number; y: number } | null;
  mode: 'stand' | 'desk' | 'sofa'; seatIndex: number | null; facing: 'ne' | 'se' | 'sw' }
interface OfficeActivity { id: string; kind: 'idle' | 'gym' | 'smoke' | 'coffee'; spotId: string; since: Ms; label: LabelRef }
interface SceneTravel { id: string; fromFloorId: string; toFloorId: string; departure: OfficeTarget; arrival: OfficeTarget }
interface VisitIntent { hostId: OccupantId | null; hosts?: { id: OccupantId; visitorIds: OccupantId[] }[];
  desk: OccupantId[]; meeting: OccupantId[]; talking: boolean; speaker: OccupantId | null; until: Ms | null;
  visitors: { id: OccupantId; hostId?: OccupantId; phase: 'person' | 'agent' | 'linger'; stateLabel: LabelRef; onStage: boolean }[] }
interface JournalItemVM { id: string; at: Ms; count: number; actor: ActorVM; text: LabelRef /* liveEvent.<kind> */; kind: LiveEventKind }
```

**Bounded roster (T-0118):** one OfficeVM contains at most 64 occupants. `occupantOverflowCount` counts eligible identities omitted after the backend prioritizes primary/agent/team rows, then other occupants, then conversations, preserving source order within each class and retaining available ancestors. The session registry accepts at most 6,000 sessions (20 pages of at most 300); oversized snapshots/pages are rejected before projection. A positive overflow count means the visible roster is intentionally partial.

**Lineage and roster tree (T-0062/T-0092):** `OccupantVM.parentId` is required and nullable: the occupant id of the agent that spawned this one when it is on stage, resolved generically from the session's `parentKey`, then canonical `Session.spawnedBy`, then `Agent.spawnedBy` (`src/engine/model/lineage.js`: `{ agentId, sessionKey, via, label }`; any adapter or orchestrator source fills it; `null` = root or no known spawner). The client receives null when its principal lacks the sessions grant. OfficeVM also supplies stable `groupId`, `rosterOrder`, `rosterDepth`, `floorId`, `stateActive`, and state LabelRefs so clients render the same roster tree and state on every viewport. Each `RosterFloor.items` entry is either an occupant reference or a localized team header; a team header is emitted when a child must appear on a different floor from its parent, so the client never indents it beneath an unrelated root. `RosterFloor.mobileLabelIds` is the backend-selected shortlist of at most three non-conversation occupants whose names may remain visible on that floor's mobile scene. Selection prioritizes active-work states, then canonical team roots, then roster order; every listed ID also occurs in that floor's `occupantIds`. The client only renders this list in the mobile presentation, while keeping every occupant reachable through the scene or roster. Team placement keeps linked members on their lead's floor, with overflow positioned alongside that team.

**On-stage counts (T-0099):** `rosterSummary.count`, the sum of `rosterFloors[].count`, and the `kpi.onStage` value use the same finalized `occupants` set, including a conversation while it is visibly visiting. The mobile summary's `activeCount` and the active KPI share unknown-state handling (`null` when any counted occupant's state is unknown).

**Session-derived fields (agent-identity-1):** `OccupantVM.summary`, `model`, `project`, `runtime`, `startedAt`, `lastActivityAt`, `tokensKnown` and `exchanges` are optional and come from sessions and transcripts. A caller without the sessions read grant gets the same `office` topic through a limited projection on HTTP and SSE: primary and agent occupants only, names that are not transcript-derived, `sessionKey: null`, no journal, no session KPIs and no `cue` frames. Today every cookie session is the owner and reads everything; RBAC (T-0031) decides it with `logs:read`. Every summary and visible name passes the shared redactor (`src/security/redact-text.js`): one line, at most 320 code points, URL userinfo and credential values masked.

Authoritative example: `docs/architecture/examples/office-vm.json`. On 2026.9.8, occupant states come from the run state only (data-model §3): `working`, `idle`, `error`, `offline`.
```json
{ "data": { "connection": { "gateway": "up", "since": 1791220000000 },
  "kpis": [ { "id": "active", "label": { "key": "kpi.active" }, "value": 2, "unit": "count", "sub": { "key": "kpi.onStage", "params": { "n": 3 } } } ],
  "occupants": [ { "id": "main", "role": "main", "name": "Timmy", "roleLabel": { "key": "occupantRole.main" }, "state": "working", "stateSince": 1791223100000,
    "stationUid": "st-timmy", "look": { "character": "timmy", "variant": null, "accessories": [] }, "sessionKey": "agent:main:main", "tokens": 52300, "lastSeenAt": 1791223080000 },
    { "id": "agent:codex:worker", "role": "agent", "name": "Worker", "title": { "key": "sessionTitle.named", "params": { "name": "Worker" } }, "roleLabel": { "key": "occupantRole.agent" }, "state": "idle", "stateSince": 1791223100000,
      "stationUid": "st-2", "look": { "character": "timmy", "variant": null, "accessories": [] }, "ruleId": "*agent", "destination": null, "sessionKey": "agent:codex:worker", "tokens": 0, "lastSeenAt": null, "isNew": true } ],
  "journal": [ { "id": "le_42", "at": 1791223190000, "count": 3, "actor": { "kind": "system", "name": "Timmy" }, "text": { "key": "activity.calling" }, "kind": "activity" } ],
  "layoutRevision": 4, "queue": [ { "id": "ffffffff-0c01-4000-8000-000000000001", "name": "Veille hebdomadaire", "schedule": { "key": "schedule.weekly", "params": { "day": { "key": "weekday.1" }, "time": "09:00" } } } ] },
  "meta": { "modelVersion": 1, "generatedAt": 1791223200000, "stale": [], "topic": { "id": "office", "rev": 118 } } }
```

### 3.3 ChatVM
```ts
interface ChatVM {
  sessionKey: SessionKey;                    // authenticated account's chat session; raw account ids never appear here
  turnPending: { turnId: string; since: Ms } | null;
  messages: Collection<{ id: string; kind: 'message' | 'subagent-result'; role: 'user' | 'assistant' | 'error'; at: Ms;
    text: string; body: { text: string }; title: string | null; status: 'completed' | 'failed' | 'running' | 'unknown' | null;
    statusLabel: LabelRef | null; collapsedByDefault: boolean; avatar: AppearanceLook | null; senderInfo?: Sender;
    meta: { model: string | null; tokens: number | null; durationMs: number | null } | null }>;   // last 50, chronological
}
```
`kind: 'subagent-result'` is emitted only when the owning adapter has verified internal/delegated provenance; matching text in a human-authored message remains `kind: 'message'`. Its `role` is `assistant`, `title` is the adapter-supplied task label when known, `status` is canonical, and `statusLabel` uses `chat.result.status.<status>`. `body.text` and `text` contain the same original Markdown source, including GFM tables; rendering and safe HTML policy belong to the client. Results start collapsed. `avatar` is the resolved office appearance for an agent author and null when unavailable; clients do not infer a portrait from names or IDs.

Authoritative example: `docs/architecture/examples/chat-vm.json`.
```json
{
  "data": {
    "sessionKey": "agent:atlas:explicit:portal-chat",
    "turnPending": null,
    "messages": [
      {
        "id": "ev:0:0",
        "kind": "message",
        "role": "user",
        "at": 1791223000000,
        "text": "Bonjour",
        "body": {
          "text": "Bonjour"
        },
        "title": null,
        "status": null,
        "statusLabel": null,
        "collapsedByDefault": false,
        "avatar": null,
        "senderInfo": {
          "kind": "human",
          "id": "human:owner",
          "name": "Mira",
          "runtime": "demo",
          "channel": null,
          "avatarHint": null
        },
        "meta": null
      },
      {
        "id": "ev:1:0",
        "kind": "message",
        "role": "assistant",
        "at": 1791223005000,
        "text": "La vérification est en cours.",
        "body": {
          "text": "La vérification est en cours."
        },
        "title": null,
        "status": null,
        "statusLabel": null,
        "collapsedByDefault": false,
        "avatar": {
          "character": "subagent",
          "variant": "sage",
          "accessories": []
        },
        "senderInfo": {
          "kind": "agent",
          "id": "agent:atlas",
          "name": "Atlas",
          "runtime": "demo",
          "channel": null,
          "avatarHint": null
        },
        "meta": {
          "model": "model-a",
          "tokens": 42,
          "durationMs": 100
        }
      },
      {
        "id": "ev:2:0",
        "kind": "subagent-result",
        "role": "assistant",
        "at": 1791223009000,
        "text": "| Check | Result |\n| --- | --- |\n| tests | **pass** |",
        "body": {
          "text": "| Check | Result |\n| --- | --- |\n| tests | **pass** |"
        },
        "title": "Review the changes",
        "status": "completed",
        "statusLabel": {
          "key": "chat.result.status.completed"
        },
        "collapsedByDefault": true,
        "avatar": {
          "character": "fox",
          "variant": null,
          "accessories": [
            "glasses"
          ]
        },
        "senderInfo": {
          "kind": "agent",
          "id": "agent:atlas:subagent:review",
          "name": "Review the changes",
          "runtime": "demo",
          "channel": null,
          "avatarHint": null,
          "delegation": {
            "sessionKey": "agent:atlas:subagent:review",
            "label": "Review the changes"
          }
        },
        "meta": null
      }
    ]
  },
  "meta": {
    "modelVersion": 1,
    "generatedAt": 1791223200000,
    "stale": [],
    "topic": {
      "id": "chat",
      "rev": 4
    }
  }
}
```

### 3.4 FlowListVM, FlowDetailVM, CronRunVM
```ts
type ScheduleVM =                            // R3-11: the canonical union, with a French sentence for each kind
  | { kind: 'cron'; expr: string; tz: string | null; sentence: LabelRef }
  | { kind: 'every'; everyMs: number; anchorAt: Ms | null; sentence: LabelRef }
  | { kind: 'at'; at: Ms; sentence: LabelRef }
  | { kind: 'unrecognized'; sentence: LabelRef };          // display only
type PayloadVM =
  | { kind: 'agent-turn'; message: string; model: string | null; timeoutSeconds: number | null }
  | { kind: 'heartbeat' }
  | { kind: 'command'; argv: string[] }
  | { kind: 'unrecognized' };
interface FlowSummaryVM {
  id: CronJobId; name: string; description: string; enabled: boolean;
  schedule: ScheduleVM; health: 'ok' | 'failing' | 'never-run'; nextRunAt: Ms | null; lastRunAt: Ms | null;
}
interface FlowListVM { flows: Collection<FlowSummaryVM>; counts: { total: number; enabled: number } }
interface FlowDetailVM {
  job: FlowSummaryVM & { agentId: AgentId; sessionTarget: 'isolated' | 'main' | 'unrecognized'; wakeMode: 'now' | 'next-heartbeat' | 'unrecognized';
                         payload: PayloadVM; createdAt: Ms | null; updatedAt: Ms | null };
  // R3-11: only cron schedules with an agent-turn payload are editable through the CLI (--name/--cron/--tz/--message);
  // every other combination is read-only in the UI (toggle, run and delete still work).
  editable: boolean;
  diagram: { nodes: { kind: 'trigger' | 'step' | 'decision' | 'output'; label: string }[] };
  runs: Collection<CronRunVM>;               // newest 25
}
interface CronRunVM {
  id: string; at: Ms; status: 'succeeded' | 'failed' | 'skipped' | 'running' | 'unrecognized';
  durationMs: number | null; nextRunAt: Ms | null; model: string | null;
  tokens: { total: number; input: number; output: number } | null;
  delivery: { status: 'delivered' | 'not-delivered' | 'skipped' | 'none' | string | null; delivered: boolean | null; channel: string | null };   // data-model DeliveryStatus; an unknown raw value passes through
  summary: string; error: string | null;
}
```
```json
{ "data": { "job": { "id": "ffffffff-0c01-4000-8000-000000000001", "name": "Veille hebdomadaire", "description": "Résumé des nouveautés.", "enabled": true,
    "schedule": { "kind": "cron", "expr": "0 9 * * 1", "tz": "America/Toronto", "sentence": { "key": "schedule.weekly", "params": { "day": { "key": "weekday.1" }, "time": "09:00" } } },
    "health": "ok", "nextRunAt": 1791640800000, "lastRunAt": 1791036000000, "agentId": "main", "sessionTarget": "isolated", "wakeMode": "now",
    "payload": { "kind": "agent-turn", "message": "1. Cherche les nouveautés\n2. Résume", "model": null, "timeoutSeconds": null },
    "createdAt": 1788631200000, "updatedAt": 1791050400000 },
  "editable": true,
  "diagram": { "nodes": [ { "kind": "trigger", "label": "Chaque lundi à 09:00" }, { "kind": "step", "label": "Cherche les nouveautés" }, { "kind": "output", "label": "Message" } ] },
  "runs": [ { "id": "run_7c1e", "at": 1791036000000, "status": "succeeded", "durationMs": 128000, "nextRunAt": 1791640800000, "model": "gpt-5.5",
    "tokens": { "total": 3800, "input": 3000, "output": 800 }, "delivery": { "status": "delivered", "delivered": true, "channel": "discord" }, "summary": "Résumé publié.", "error": null } ] },
  "meta": { "modelVersion": 1, "generatedAt": 1791223200000, "stale": [], "topic": { "id": "flow:ffffffff-0c01-4000-8000-000000000001", "rev": 3 } } }
```

### 3.5 AccessVM, InterlocutorVM
```ts
interface AccessVM {
  agents: Collection<{ id: AgentId; name: string; model: string | null;
    modelSource: 'explicit' | 'inherited' | null; runtime: string | null; isPrimary: boolean }>;
  interlocutors: Collection<{ id: InterlocutorId; kind: 'discord-user' | 'discord-channel'; name: string | null; avatarUrl: string | null;
                              resolution: 'pending' | 'resolved' | 'failed'; sessionCount: number; totalTokens: number; lastSeenAt: Ms | null;
                              access: { policy: string | null; enabled: boolean | null; requireMention: boolean | null } }>;
  policy: { dm: string | null; group: string | null; channelsEnabled: number; channelsTotal: number; execSecurity: string | null };
}
interface InterlocutorVM {
  id: InterlocutorId; kind: 'discord-user' | 'discord-channel'; resolution: 'pending' | 'resolved' | 'failed';
  profile: { displayName: string | null; username: string | null; avatarUrl: string | null; isBot: boolean; createdAt: Ms }   // discord-user
         | { name: string | null; type: string; topic: string; guildName: string | null; createdAt: Ms } | null;                 // discord-channel
  access: AccessVM['interlocutors'][number]['access'];
  stats: { sessionCount: number; totalTokens: number; firstSeenAt: Ms | null; lastSeenAt: Ms | null };
  sessions: Collection<{ id: SessionKey; updatedAt: Ms | null; tokens: number; model: string | null }>;
  primarySessionKey: SessionKey | null;
}
```

T-0008 (additive in 2.7/3.2): `modelSource` is the adapter-reported per-agent override vs inherited default; null means unknown. `runtime` is an open external harness id/name (ACP/CLI or any adapter); null means native or unknown. The agents list shows the harness when present, otherwise the effective model with “par défaut” only for confirmed inheritance. Neither the VM nor the UI reads runtime-specific config fields.

```json
{ "data": { "id": "discord-user:100000000000000001", "kind": "discord-user", "resolution": "resolved",
  "profile": { "displayName": "Guest", "username": "guest", "avatarUrl": null, "isBot": false, "createdAt": 1600000000000 },
  "access": { "policy": "pairing", "enabled": null, "requireMention": null },
  "stats": { "sessionCount": 1, "totalTokens": 3300, "firstSeenAt": 1791223140000, "lastSeenAt": 1791223140000 },
  "sessions": [ { "id": "agent:main:discord:direct:100000000000000001", "updatedAt": 1791223140000, "tokens": 3300, "model": "gpt-5.5" } ],
  "primarySessionKey": "agent:main:discord:direct:100000000000000001" },
  "meta": { "modelVersion": 1, "generatedAt": 1791223200000, "stale": [], "topic": { "id": "interlocutor:discord-user:100000000000000001", "rev": 1 } } }
```

### 3.6 Logs (`Page<LogRowVM>`) and SessionVM
```ts
interface LogRowVM { id: SessionKey; kind: SessionKind; channel: 'wechat' | 'discord' | 'whatsapp' | 'unrecognized' | null; label: string /* French; 2.x */;
                     title: LabelRef /* 2.4 (Q03-A01): sessionTitle.*, in the UI's language */;
                     model: string | null; modelProvider: string | null /* 2.1; shown as provider/model */;
                     tokens: number; updatedAt: Ms | null; live: boolean /* activity indicator; check execution.evidence before calling it confirmed */; heartbeat: boolean;
                     execution: { status: 'unknown' | 'idle' | 'running' | 'succeeded' | 'failed'; evidence: { level: 'verified' | 'observed' | 'unknown'; observedAt: Ms | null; expiresAt: Ms | null } };
                     // T-0058 (additive): tokensKnown false → the UI shows no count (never a false 0); the owning connector
                     // instance with its adapter-declared mark; the agent's display name (owner rename first, redacted)
                     tokensKnown?: boolean; connector?: { id: string; adapter: string; name: string; mark: { monogram: string; color: '#rrggbb' } } | null;
                     agent?: { id: AgentId; name: string } | null }
// Page<LogRowVM>.facets (T-0058): { connectors: (ConnectorRef & {count})[], agents: {id, name, connectorId, count}[] } over the
// kind/heartbeat-filtered sessions, before ?connector=<instance id> and ?agent=<agent id> (server filters; topic ids keep
// sorted query keys, e.g. logs?agent=…&connector=…). Titles: the session's canonical displayName, then summary (redacted);
// a group with no known name is « Groupe sans nom · <platform> »; a raw session key is never a title. 2.x: a generic
// `conversation` (e.g. a coding-agent session) stays `conversation` (additive), no longer `chat-group`.
// ?kind=<SessionKind> filters. 2.1: heartbeats are HIDDEN unless ?heartbeat=include (topic logs?heartbeat=include; the
// UI toggle « Afficher les battements »). Order: updatedAt desc, then id.
interface SessionVM {
  key: SessionKey; label: string; title: LabelRef /* 2.4 */; kind: SessionKind; model: string | null; modelProvider: string | null; tokens: number; updatedAt: Ms | null;
  cwd: string | null;                        // 2.1 (PM): Session.cwd — workspaceDir, else spawnedCwd, normalised (data-model §2)
  run: { status: 'unknown' | 'idle' | 'running' | 'succeeded' | 'failed'; endReason: 'error' | 'timeout' | 'killed' | 'budget-limited' | null; evidence: { level: 'verified' | 'observed' | 'unknown'; observedAt: number | null; expiresAt: number | null } };   // evidence and state are independent of source health
  messageCount: number | null;               // 2.1: null when the gateway doesn't report it; window is over the fetched messages
  window: { from: number; to: number }; toolCount: number;
  traceState: 'fresh' | 'stale' | 'unavailable';   // 2.4 (R16-07): fresh = the last transcript read succeeded; stale = it failed (or none
                                             // yet), the last good trace is shown; unavailable = the runtime can't read transcripts
  participants: Collection<Participant>;    // 2.6: humans and primary agents, unique by identity
  subagents: Collection<Sender>;           // delegated agents; delegation.sessionKey links to their trace
  events: Collection<TraceEventVM>;          // 2.1: chronological, keyed; id = 'ev:<messageIndex>:<partIndex>' (stable across fetches)
}
type TraceEventVM = TraceEvent & { id: string; senderInfo?: Sender };   // data-model §2.1; `subagent-result` carries title, status and body; appends arrive as upserts on ['events']
```
Authoritative example: `docs/architecture/examples/session-vm.json`.
```json
{ "data": { "items": [ { "id": "agent:main:subagent:ffffffff-0001-4000-8000-000000000001", "kind": "subagent", "channel": null, "label": "Sous-agent ffff",
  "model": "gpt-5.5", "tokens": 8100, "updatedAt": 1791223170000, "live": true, "heartbeat": false } ], "nextCursor": "eyJvIjo1MH0" },
  "meta": { "modelVersion": 1, "generatedAt": 1791223200000, "stale": [], "topic": { "id": "logs", "rev": 55 } } }
```

### 3.7 Skills
`SkillDetailVM.skill.homepage` is `null` or a canonical absolute HTTP/HTTPS URL, with at most 2,048 UTF-16 code units before and after normalization. Plain HTTP is permitted for homepage navigation. The shared `public/v2/url-policy.js` policy rejects credentials (including empty userinfo), whitespace/control characters, encoded ASCII controls, backslashes, malformed URLs/escapes and other schemes. Adapters normalize list/info metadata; the VM builder also filters both candidates (a refused list value can fall back to a valid info value). Canonical and v2/v3 VM schemas require the normalized form. The UI repeats the same policy and omits the action on refusal, retaining `target="_blank" rel="noopener noreferrer"`. This is outbound navigation only: no server fetch or DNS/IP filtering.

```ts
interface SkillRowVM { id: string /* name */; emoji: string | null; description: string; source: SkillSource; status: 'active' | 'disabled' | 'unavailable';
                       visibility: { model: boolean; command: boolean; user: boolean } }
interface SkillListVM { skills: Collection<SkillRowVM>; counts: { total: number; active: number } }
interface SkillDetailVM {
  skill: SkillRowVM & { homepage: string | null };
  detail: { always: boolean; blockedBy: { allowlist: boolean; agentFilter: boolean; platform: boolean };
            requirements: Requirements | null; missing: Requirements | null;
            install: { id: string; kind: string; label: string; bins: string[] }[] } | null;   // null if `skills info` failed
  markdown: string;                          // SKILL.md body ('' if unreadable or outside approved roots, R1-11)
  flow: { steps: string[]; outputs: ('files' | 'message' | 'tool-actions' | 'agent-reply')[] };
  needsRestart: boolean;                     // a toggle is pending until the gateway restarts
}
```
```json
{ "data": { "skills": [ { "id": "weather", "emoji": "⛅", "description": "Prévisions météo.", "source": "bundled", "status": "active",
  "visibility": { "model": true, "command": false, "user": true } } ], "counts": { "total": 75, "active": 43 } },
  "meta": { "modelVersion": 1, "generatedAt": 1791223200000, "stale": [], "topic": { "id": "skills", "rev": 2 } } }
```

### 3.8 HealthVM
```ts
interface HealthVM {
  level: 'ok' | 'warn' | 'alert';
  cards: Collection<{ id: 'gateway' | 'cpu' | 'memory' | 'disk' | 'event-loop' | 'uptime' | 'cron' | 'plugins';
                      level: 'ok' | 'warn' | 'alert'; value: { n: number; unit: Unit } | { key: string }; sub: LabelRef | null }>;   // 2.1: Unit keys only
  channels: Collection<{ id: string; label: string; health: 'connected' | 'running' | 'stopped' | 'error' | 'not-configured'; lastError: string | null; accounts: number }>;
  sources: Collection<SourceStatusVM>;       // R3-09: same shape as canonical SourceStatus (data-model §10)
  healthChecks: Collection<HealthCheckVM>; healthAudit: HealthAuditVM[];
  dataQuality: { open: { error: number; warn: number; info: number }; issues: Collection<IssueVM> };
  series: { cpu: number[]; mem: number[]; at0: Ms; stepMs: 60000 };
  engineParity?: { surface: LabelRef; comparisons: number; mismatches: number; changedRows: number; overflowKeys: number; overflowSurfaces: number }[]; // admins only; cumulative, value-free Office shadow counters
}
interface HealthCheckVM { id: string; adapter: string; severity: 'error' | 'warn' | 'info'; causeCode: string; textKey: string; impactKey: string;
  remedy: 'none' | 'auto' | 'one-click' | 'guided'; active: boolean; actionId: string | null; guidedPath: string | null; target: string | null; changedAt: Ms; resolvedAt: Ms | null }
interface HealthAuditVM { checkId: string; actionId: string; at: Ms; outcome: string; attempts: number }
interface SourceStatusVM {
  id: SourceId; state: 'fresh' | 'stale' | 'down';      // down: transport down (gateway closed); stale: some channel's last outcome failed
  lastOkAt: Ms | null; lastErrorAt: Ms | null; lastError: SourceErrorCategory | null;
  channels: { channel: string; state: 'fresh' | 'stale'; lastOkAt: Ms | null; lastErrorAt: Ms | null; lastError: SourceErrorCategory | null }[];
}
// 2.1 (S4.1, PM decision on review-06): "no values, ever; paths come from schemas". No source, detail or sample.
interface IssueVM { id: string /* fingerprint */; code: IssueCode; severity: 'error' | 'warn' | 'info'; channel: string;
                    path: string | null; count: number; firstSeenAt: Ms; lastSeenAt: Ms;
                    state: 'open' | 'resolved' | 'muted'; mutable: boolean /* severity !== 'error' */ }
//   path: a schema path; record entries are '{}', array elements '[]', and a payload key the schemas don't declare is
//     '<undeclared>' (e.g. '$.agents[].<undeclared>'). channel: ours, or 'gw.event.<name>' only for an event the gateway
//     advertised, else 'gw.event.<unadvertised>'. The UI presents localized check text, not these raw internal labels.
//   SourceErrorCategory = 'timeout' | 'not-connected' | 'connection-closed' | 'connection-refused' | 'unknown-method' | 'not-found'
//     | 'permission-denied' | 'invalid-json' | 'invalid-output' | 'unreadable' | 'missing-agent' | 'not-ok' | 'payload-rejected'
//     | 'killed-or-timeout' | 'rate-limited' /* 2.2: GitHub (projects' repo cache) */ | `exit-${number}` | 'error'
//     | 'not-configured' /* 2.3, G2: the runtime has no identity or token yet (ADR-001 §12.1); the source is down */
//     labels: sourceError.<category> (2.1; error.* is ErrorCode only)
```
```json
{ "data": { "level": "warn",
  "cards": [ { "id": "cpu", "level": "ok", "value": { "n": 11, "unit": "percent" }, "sub": { "key": "healthSub.cores", "params": { "n": 4 } } } ],
  "channels": [ { "id": "discord", "label": "Discord", "health": "running", "lastError": null, "accounts": 1 } ],
  "healthChecks": [ { "id": "core|generic:session-sync", "adapter": "core", "severity": "warn", "causeCode": "source-stale", "textKey": "healthCheck.source.stale", "impactKey": "healthImpact.sessions", "remedy": "guided", "active": false, "actionId": null, "guidedPath": "/parametres?onglet=connexion", "target": null, "changedAt": 1791223190000, "resolvedAt": 1791223190000 } ], "healthAudit": [],
  "sources": [ { "id": "gateway", "state": "stale", "lastOkAt": 1791223190000, "lastErrorAt": 1791223150000, "lastError": "timeout",
    "channels": [ { "channel": "gw.rpc.cron.list", "state": "stale", "lastOkAt": null, "lastErrorAt": 1791223150000, "lastError": "timeout" } ] } ],
  "dataQuality": { "open": { "error": 1, "warn": 0, "info": 1 },
    "issues": [ { "id": "98015dac40af93b5", "code": "event.unknown", "severity": "info", "channel": "gw.event.<unadvertised>", "path": null,
      "count": 4, "firstSeenAt": 1791223000000, "lastSeenAt": 1791223190000, "state": "open", "mutable": true } ] },
  "series": { "cpu": [9, 11], "mem": [62, 62], "at0": 1791223080000, "stepMs": 60000 } },
  "meta": { "modelVersion": 1, "generatedAt": 1791223200000, "stale": ["gateway"], "topic": { "id": "health", "rev": 902 } } }
```

### 3.9 Projects: BoardVM, ProjectVM, history
The builders are the projects module's `buildBoardVM` / `buildProjectVM` / `presentHistory` (projects.md). These types are their wire contract, and **the examples are authoritative** (`docs/architecture/examples/board-vm.json`, `project-vm.json`, `history-page.json`, `error-409-project.json`): producers assert `compareShape(example, builderOutput)` is `[]` (§7).
```ts
interface BoardVM {
  filter: 'all' | 'at-risk' | 'with-timmy' | 'archived';   // 2.1: 'archived' lists archived projects (restore lives there)
  sourceFilterId: string | null; sourceFilters: Collection<{ id: string; label: LabelRef; count: number; selected: boolean; source: ProjectSourceDescriptorVM }>;
  emptyStateLabel: LabelRef | null;
  columns: Collection<{ id: ProjectStatus; count: number; cards: Collection<ProjectCardVM> }>;   // all 5 statuses, in order, even when empty
}
interface ProjectSourceDescriptorVM { id: string; kind: string; runtime: string | null; label: LabelRef;
  brand: { mark: string; providerName: string | null; logo: string | null; logoDark?: string; color: string | null; foreground: string | null } | null }
interface ProjectCountsVM { sessions: number | null; agents: number | null; activity: number | null }
interface ProjectCapabilitiesVM { read: boolean; write: boolean; comments: 'read-write' | 'read-only' | 'unsupported';
  history: 'read-write' | 'read-only' | 'unsupported'; repository: 'read-write' | 'read-only' | 'unsupported' }
interface ProjectCardVM {
  id: ProjectId; name: string; priority: Priority; revision: number; status: ProjectStatus;
  thumb: ThumbVM;                            // 2.3 (projects' image proposal, PM decision after Owner's iPad review)
  flags: { visible: FlagVM[]; hiddenCount: number };   // every unacked, uncleared risk, then up to 3 others; acked risks omitted (projects.md)
  people: { visible: PersonChip[]; hiddenCount: number };   // 4 visible
  lastActivityAt: Ms;
  origin?: 'orchestrator-team'; teamProject?: { teamId: string; label: string; readOnly: boolean; taskCount: number };
  sourceDescriptors: Collection<ProjectSourceDescriptorVM>; statusLabel: LabelRef; counts: ProjectCountsVM; capabilities: ProjectCapabilitiesVM;
}
// 2.3: image priority screenshot of the project's live site (1200×630, cached 24 h) → GitHub OpenGraph card → a monogram tile.
// ProjectCovers are no longer referenced. `accent` is hashed from the project id; `initials` is the fr-CA monogram.
type ProjectImage = { kind: 'screenshot' | 'opengraph' | 'monogram'; url: string | null /* public https; null for a monogram */;
                      initials: string; accent: 'slate' | 'indigo' | 'teal' | 'amber' | 'rose' | 'green' };
type ThumbVM = ProjectImage & { repoLabel: string | null };
type FlagVM =                                // R3-13: discriminated by kind; feature keeps its state
  | { kind: 'priority'; key: Priority; label: string }
  | { kind: 'risk'; key: RiskKey; label: string; severity: 'high' | 'medium' | 'low'; acked: boolean; removable: boolean /* manual 'blocked' only */ }
  | { kind: 'feature'; key: string; label: string; state: 'on' | 'off' | 'unknown' }
  | { kind: 'label'; key: string; label: string; removable: true };
interface ProjectVM {
  id: ProjectId; revision: number; name: string; status: ProjectStatus; priority: Priority; archived: boolean;
  summary: string; summaryMeta: { author: ActorVM; at: Ms } | null;
  teamProject?: { teamId: string; label: string; readOnly: boolean; taskCount: number; summaryLabel: LabelRef;
    capabilities: { comments: 'read-only' | 'unsupported'; history: 'read-only' | 'unsupported'; repository: 'read-only' | 'unsupported' };
    roster: TeamRosterVM; columns: Collection<TeamProjectColumnVM> } | null;
  thumb: ProjectCardVM['thumb'];
  flags: FlagVM[];                           // all, including acked risks; cleared risks excluded; order priority, risk, feature, label
  sources: Collection<{ id: string; kind: 'github' | 'workspace' | 'sessionGroup' | 'manual'; label: string;
                        ref: ProjectSourceInput['ref'] | null /* 2.1; null for manual */; addedAt: Ms; sessionCount: number | null }>;
  repo: RepoVM | null;                       // null: no github source. « Dépôt lié, récupération en cours… » is the client's text for state 'pending'
  people: Collection<PersonChip & { role: string | null; origin: 'derived' | 'manual'; commitCount: number | null }>;
  recentHistory: Collection<HistoryItemVM>;  // newest 20 (after grouping); older pages via the history route. NOT history:{events,…} (R7-01)
  historyNextCursor: string | null;
  sourceDescriptors: Collection<ProjectSourceDescriptorVM>; statusLabel: LabelRef;
  counts: ProjectCountsVM; capabilities: ProjectCapabilitiesVM;
  statusTransitions?: Collection<{ id: ProjectStatus; label: LabelRef }>;
  lastActivityAt: Ms; createdAt: Ms;
}
```

`statusLabel` is the current backend-authored display label. `statusTransitions` supplies the ordered allowed destination IDs and their LabelRefs; it is empty for read-only sources, callers without Projects write permission, and a read-only store. Older payloads may omit it; consumers show no choices in that case. Desktop and mobile render these values unchanged, submit only a supplied destination, and use the returned VM's labels/transitions for confirmation and undo. The command still enforces write permission and validates the submitted status.

Source descriptor/filter IDs identify a canonical source, not a project-link row. Conversation sources use the owning canonical connector instance and its declared adapter name/brand; an unresolved source has the generic Conversations label. GitHub repositories share one owner identity; folders share their declared root (or local root); manual projects share one identity. Each project counts at most once per source even with multiple links. Source selection applies to that identity and is projected through existing source permissions. Board/card/detail descriptors agree; all labels resolve in FR and EN.

```ts
interface TeamProjectTaskVM {
  id: string; title: string; state: 'open' | 'claimed' | 'working' | 'review' | 'done' | 'blocked';
  column: ProjectStatus; columnLabel: LabelRef; priority: Priority | null;
  owner: { id: string; name: string } | null;
  reviewers: Collection<{ id: string; name: string | null; verdict: 'go' | 'no-go' | 'pending' | 'unknown'; verdictLabel: LabelRef }>;
  createdAt: Ms | null; updatedAt: Ms | null; lastActivityAt: Ms | null;
}
interface TeamProjectColumnVM { id: ProjectStatus; label: LabelRef; count: number; tasks: Collection<TeamProjectTaskVM> }
interface TeamRosterVM { groups: Collection<{ id: string; label: string; order: number; parentGroupId: string | null;
    memberIds: string[]; memberCount: number; memberCountLabel: LabelRef; depth: number }>;
  members: Collection<{ id: string; order: number; parentId: string | null; groupId: string; rosterDepth: number;
    roleLabel: string | null; parentLabel: string | null;
    identity: { id: string; name: string; context: string | null; provider: string | null; teamId: string; parentId: string | null; status: string; statusLabel: LabelRef };
    portrait: { look: AppearanceLook | null; avatarUrl: string | null }; source: ProjectSourceDescriptorVM | null }>;
  memberCount: number; memberCountLabel: LabelRef }
interface RepoVM {                           // R3-20: present as soon as a github source is linked
  state: 'pending' | 'ok' | 'error';         // pending: never fetched; error: last fetch failed (the last good data is kept)
  url: string; owner: string; name: string;
  image: ProjectImage;                       // 2.3
  defaultBranch: string | null; branch: string | null;   // null while pending
  ci: { state: 'passing' | 'failing' | 'running' | 'none' | 'unrecognized'; at: Ms | null; url: string | null } | null;
  commits: { sha: string; at: Ms; author: string; message: string }[];
  fetchedAt: Ms | null; lastError: SourceErrorCategory | null;
}
interface HistoryItemVM { id: string; at: Ms; kind: HistoryKind; actor: ActorVM; text: LabelRef /* §3.9.1 */; group: number /* events merged, ≥ 1 */ }
```
An enabled orchestrator team contributes one read-only project card unless its source adapter declares task writes. The card's `id` is stable and opaque, `origin` identifies the backend projection, and `teamProject.taskCount` is backend-computed. Its detail uses `ProjectVM.teamProject.columns`; tasks map `open → todo`, `claimed|working → in-progress`, `review → in-review`, `done → shipped`, and `blocked → in-progress`. The task's canonical `state` remains present alongside its mapped column. Owner, reviewer verdicts, priority, and last activity are projected from the canonical snapshot; task briefs, review notes, inbox bodies, source paths, and report references are never included. `teamProject.capabilities` declares comments as read-only and history/repository as unsupported where the source does not provide them. The comments read route returns a valid empty, non-writable `CommentThreadVM` for these projects. A project reader without `teams.read` sees no team cards and cannot read a team project's detail.

History page: `Page<HistoryItemVM>`, newest first (`at` desc, `id` desc). Default limit 20, max 100. The cursor is over raw events, so a group can be split across pages.

Board source chips are computed from the eligible backend project set. `source` selects one returned `sourceFilters[].id`; the VM carries selected state, counts, ordered cards, labels and source descriptors. Clients submit a selected id and render the returned projection. The registry is source-neutral: each source contributes its own stable id, kind, runtime, label and declared connector brand. Projects without a known count use `null`; zero means measured none.

Runtime adapters may declare a `projectSource` capability. For workspace projects, the adapter attaches a source-private opaque `projectRef` and safe `projectLabel` to canonical sessions; neither the reference nor a filesystem path appears in a VM. The backend groups sessions only within the same connector identity, derives counts/latest activity from those sessions, and uses the adapter's connector label/brand and declared read/write/comment/history/repository capabilities. Claude Code and Codex currently contribute read-only workspace projects; unsupported history/repository features are declared as such rather than inferred by the client.

Team-project roster groups and members are already presentation-shaped. `group.memberIds`, `order`, `parentId`, `groupId`, `rosterDepth`, role/parent labels, member counts and `portrait` are authoritative; clients render them without rebuilding parent chains or counts. Member identity uses the source's stable canonical ID, while session references and host-private IDs remain private. A portrait may have no character look or URL when no canonical appearance exists; the source brand remains available as provider context. Task summary, labels, counts and source capabilities are likewise server supplied. Task briefs, review notes, inbox bodies, source paths, and report references are never included.

**Board 409 (PM, on frontend-02):** `error.current.vm` is always a `ProjectVM`, never a card. A board reverts its optimistic move and resyncs its board topic.

#### 3.9.1 History text (`historyKind.*`, R7-01)
`text` never contains the actor (the UI renders `actor.name` in bold before the sentence). Params are raw (§3.0): statuses and risks are nested LabelRefs, durations are ISO 8601, counts are numbers.

| `kind` | `text.key` | `params` |
| --- | --- | --- |
| `project-created`, `summary-edited`, `archived`, `restored`, `flags-updated` | `historyKind.<kind>` | — |
| `renamed` | `historyKind.renamed` | `from`, `to` (names) |
| `status` | `historyKind.status` | `from`, `to`: `{key:'projectStatus.<s>'}` |
| `priority` | `historyKind.priority` | `from`, `to` (`P0`…`P9`) |
| `commit` | `historyKind.commit.one` / `.other` | `n`, `branch` |
| `flow-run`, `cron-run` | one run: `historyKind.<kind>.succeeded` / `.failed`; a group: `historyKind.<kind>.group.succeeded` / `.group.failed` | `job` (name), `n`, `duration` (ISO, one run only, when known) |
| `session` | `historyKind.session` | `session` (label), `messages`, `tokens`, `with` (interlocutor name, optional) |
| `risk-raised`, `risk-cleared`, `risk-acked`, `risk-unacked` | `historyKind.<kind>` | `risk`: `{key:'risk.<key>', params?:{n}}` (`n` = stale days) |
| `flag-added`, `flag-removed` | `historyKind.<kind>.label` / `.risk` | `label` (the label text), or `risk` as above |
| `source-linked`, `source-unlinked` | `historyKind.<kind>` | `source` (the source label) |
| `agent-action` | `historyKind.agent-action.delegated` / `.commented` | `subject` (name, optional) |
| `people-override` | `historyKind.people-override` / `.hidden` | `person` (name), `role` (optional) |

### 3.10 LayoutVM, UiPrefs (office; decisions in §3.13)
```ts
interface LayoutVM {
  allowNoDesk?: boolean;                     // backend editor policy; true on scoped lobby/gym reads, false on office/root
  layout: { id: LayoutId; name: string; revision: number; updatedAt: Ms; updatedBy: ActorVM /* 2.1 */; data: OfficeLayoutDataV1 };   // data-model §12
  manifest: unknown;                         // exactly design/office/build-manifest.mjs output (manifest.schema.json, version 2; §3.13)
  theme: { resolved: string; mode: 'auto' | 'fixed'; nextChangeAt: Ms | null; season: string | null /* 2.1 */ };
  default: { data: OfficeLayoutDataV1 };     // 2.1: the shipped layout (design/office/layout.example.json); « Réinitialiser » loads it into the draft
  revisions: Collection<{ id: string /* String(revision) */; revision: number; updatedAt: Ms; updatedBy: ActorVM }>;   // 2.1: newest first, ≤ 20
  agentsSeen: Collection<{ id: OccupantId; role: OccupantRole; name: string; lastSeenAt: Ms; automaticLook?: { character: string; variant: string | null; accessories: string[] } }>;   // 2.1 (R3-14): last 30 days, newest first, ≤ 200
}
interface UiPrefs { uiTheme: 'system' | 'dark' | 'light' }
```
`layout.data.idleRelocationMinutes` is a compatibility projection, bounded to 1–1440 and sourced from the authoritative Settings value `settings.office.idleRelocationMinutes` (default 15). It is not stored with the office layout. On upgrade, an existing layout value is migrated once into instance configuration when that Settings value is absent. Layout writes from older clients may include the field, but the server ignores it; both API versions return the current Settings value so the layout editor and placement engine agree. The backend picks a declared, reachable activity spot and publishes `activity`, `sceneTarget`, and any `sceneTravel`; the browser only animates those intents.
Authoritative example: `docs/architecture/examples/layout-vm.json` (its `layout.data`, `default.data` and `manifest` are the design/office example files, verbatim). The shape checker treats `$.data.manifest` as opaque.

`GET /office/layout?floorId=<id>` and its `layout?floorId=<id>` topic provide a backend-projected floor LayoutVM, including reset defaults, theme and validation policy. The same selector scopes layout/theme writes and revision reads. A scoped write merges that floor into the canonical root, preserves every other floor and global appearance rules, and returns a scoped VM (including on 409). Selectors are bounded and conflicting body/query values or a scoped `data.floors` registry are rejected. Existing authorization, readonly and revision guards apply. Clients render these values and send drafts unchanged; they do not generate defaults or merge the floor registry.

### 3.11 Defaults and null meanings (all VMs)
- An optional *entity* (`repo`, `summaryMeta`, `profile`, `detail`) is `null` when absent, never omitted.
- An unknown *number* (`tokens`, `durationMs`) is `null`; `0` always means zero.
- Strings never use `null` for "empty" when the field is free text that may be empty (`description: ''`, `summary: ''`).
- Arrays are never `null`.
- **URLs in a VM are absolute** (frontend-07; the UI never prefixes data URLs): `avatarUrl`, `ThumbVM.url`, `ProjectImage.url`, … Third-party URLs already are; media the server serves itself is built from `AO_PUBLIC_URL` + the public API prefix (`AO_PUBLIC_API_BASE`, `/backend` in API-only mode), never from request headers, and is `null` when no public origin is configured. Guarded by tests on the examples and on live v2 responses.

### 3.12 Project flag rules (R3-13)
Writable flag kinds are **label** (add/remove) and **risk `blocked`** (set/remove; manual only). Every risk can be acknowledged or un-acknowledged. Feature flags are read-only (the scanner owns them, S15d); priority is derived from `Project.priority`, and auto risks are owned by the risk monitor.

### 3.13 Office decisions (2.1, from office-dev's `design/office/api-proposal.md`)
- **One implementation of every office rule:** `public/v2/office/layout-rules.js` (pure ES module, no DOM). The server loads it with `require(esm)` for PUT validation and occupant resolution; the editor uses it for preview.
- **Manifest v2 (R3-08):** the encoding in the proposal §1 is adopted as is: `variants[].gearFree` and `defaultAccessories`; two-layer accessories `layers["<character>"|"<character>/<variant>"][pose] = {back?, front?}` (draw back → body → front; the variant key wins); legacy `images` + `legacy:true` overlays; head `landmarks`; frame loops `{frames, frameMs}`; `seatAnchor`; seated stations `station.seated`. **Facing:** `*-ne`/`*-sw` are pose families chosen inside a station; `station.facing` stays the standing facing.
- **Accessory precedence (resolved once, server-side):** `rule.accessories` if present (an explicit `[]` = none) → `variant.defaultAccessories` → `[]`. `look.accessories` is final.
- **Identity (R3-14):** a rule's `agentId` is an `OccupantId`, verbatim (`main`, `subagent:<id>`, `cron:<id>`, `dm:<id>`, `channel:<id>`); defaults are `*subagent`, `*cron`, `*dm`, `*channel`. Matching: exact id → `*<role>` → `*subagent`; `main` has no fallback (the validator requires a `main` rule). A default rule rotates through the character's variants in roster order. Names: an exact rule's `name`, else the source name. `OccupantVM.ruleId` names the rule. The inventory is `LayoutVM.agentsSeen` (storage: `office_agents_seen`, S14b).
- **Stations and capacity (T-0158):** only desks are work homes. Explicit desk assignments resolve first; automatic placement fills desks in layout order. Lounge seats remain valid activity destinations and legacy layout references, but are never counted as home capacity; saved lounge homes migrate to a desk as soon as one is available. When desks are full, `stationUid: null` means overflow (a decorative standing area near the entrance; the occupant keeps its roster place and state). Capacity = desks.
- **Validator issues** (`validateLayout`, PUT → 400 `validation_failed`, `details[] = {issue, field: 'items.<uid>' | 'agents.<agentId>'}`): `unknown-room`, `manifest-version`, `too-many`, `uid`, `duplicate-uid`, `unknown-asset`, `placement-kind`, `orientation`, `wrong-wall`, `outside`, `occupied`, `unreachable`, `no-desk`, `agent-id`, `duplicate-agent`, `match`, `unknown-character`, `unknown-variant`, `default-station`, `default-name`, `missing-station`, `station-kind`, `station-taken`, `unknown-accessory`, `slot-conflict`, `accessories`, `name-too-long`, `role-too-long`, `no-main`, `no-default`, `theme`, `theme-time`.
- **Theme (R3-17, final):** `layout.data.theme` is the only owner. The server resolves it on the America/Toronto clock (the night window may wrap midnight), sets `LayoutVM.theme` and pushes the `layout` topic at `nextChangeAt`. A season adds extras on top of the resolved day/night theme. The quick toggle is `PUT /office/layout/theme` (§5.5); on 409 the client re-applies its choice to `current.vm` and resubmits once (accepted).
- **Destinations and partners (R3-15):** lounge after 10 min idle, swivels and the standing area are client-side decoration only. `OccupantVM.destination` and the cue's `partnerId`/`interactionId` (§4.4) are server-authoritative and stay null/absent until the data exists (activity is run-state only on 2026.9.8). Meeting seats wait for the art (`station.seats`).
- **PM points accepted:** `agentsSeen` cap 200; theme-toggle auto-retry once; overflow shown as a standing area.

### 3.14 Project candidates (2.1, R7-02)
`GET /api/v2/views/project-candidates` → `Ok<CandidatesVM>`: a **one-shot GET** (the page's *Actualiser* button), not a topic. The server runs discovery (`proposeCandidates`, projects.md); the browser never calls `gh` or `git`. Authoritative example: `docs/architecture/examples/candidates-vm.json`.
```ts
interface CandidatesVM { scannedAt: Ms; candidates: Collection<CandidateVM>;
  statusOptions?: Collection<{ id: ProjectStatus; label: LabelRef }> }
interface CandidateVM {
  id: string;                                // = key (Collection identity)
  key: string;                               // what POST /projects/import sends back
  name: string; summary: string;
  suggestedStatus: ProjectStatus;
  confidence: 'high' | 'medium' | 'low';     // labels: confidence.* (élevée / moyenne / faible)
  reason: string;                            // French sentence from discovery (an accepted display string, like source names)
  labels: string[];                          // display strings, the same form as overrides.labels; the server slugifies on import
  sources: { kind: 'github' | 'workspace' | 'sessionGroup' | 'manual'; label: string; ref: ProjectSourceInput['ref'] | null }[];
  lastActivityAt: Ms | null;
}
```

Import's initial stage selector renders CandidatesVM.statusOptions in supplied order, with its exact LabelRefs. suggestedStatus is only the backend-selected initial value; the client does not construct choices or labels from it. The backend clears options when Projects writes/store writes are unavailable. Older payloads that omit the optional options field show a disabled stage selector. The import command continues to enforce permission and validate overrides.

### 3.15 OfficeCharactersVM (T-0105)
`GET /api/v2/views/office/characters?scope=office|all&search=<text>` returns the server-built character editor inventory. The same path is available on v3; row roles use that contract's occupant vocabulary. `scope` defaults to `office` (only current office occupants); `all` also includes detected, non-private agent rows. Search, grouping, order, labels, and counts are all projected by the server. The browser renders the returned rows without deriving structure.
```ts
interface OfficeCharactersVM {
  scope: 'office' | 'all'; search: string; count: number; countLabel: LabelRef;
  groups: Collection<{ id: string | null; label: LabelRef; count: number; countLabel: LabelRef; rows: OfficeCharacterRowVM[] }>;
  emptyLabel: LabelRef;
}
interface OfficeCharacterRowVM {
  id: string; role: OccupantRole; name: string; primary: boolean;
  runtime: string | null; runtimeBrand: ConnectorMark | null;
  state: AgentState | null; stateLabel: LabelRef; roleLabel: LabelRef;
  look: AppearanceLook; automaticLook?: AppearanceLook; groupId: string | null;
  order: number; inOffice: boolean; lastSeenAt: Ms | null;
}
type ConnectorMark = { monogram: string; color: string; logo?: string; logoDark?: string; providerName?: string };
```
Authoritative example: `docs/architecture/examples/office-characters-vm.json`. Readers without `logs:read` receive only the summary-role inventory; private conversation rows and their titles are omitted, timestamps are null, and all counts are recomputed after that boundary.

## 4. SSE stream

### 4.1 Topics and identity (R3-03)
A **topic id** is `name` or `name:<param>` or `name?<k>=<v>[&…]`, with params URL-encoded and query keys sorted. Different ids are **different topics with different VMs**, even when they share a stream.

| Topic id | VM |
| --- | --- |
| `office`, `chat`, `flows`, `access`, `skills`, `health`, `layout`, `prefs` | the VM of the same name |
| `flow:<jobId>`, `skill:<name>`, `interlocutor:<id>`, `session:<encodedKey>`, `project:<id>` | detail VMs |
| `logs`, `logs?kind=<k>`, `logs?heartbeat=include` (and combined, keys sorted) | first page of logs (`Page<LogRowVM>`) |
| `projects`, `projects?filter=at-risk`, `projects?filter=with-timmy`, `projects?filter=archived` | `BoardVM` for that filter (`projects` = `filter=all`) |
| `system` | always subscribed; frames of type `system` only |

### 4.2 Lifecycle
- **Open:** `GET /api/v2/stream?topics=<id>,<id>` (comma-separated, each URL-encoded). The response is `text/event-stream`. The first frame is `hello`, then one `snapshot` per requested topic.
- **Change topics:** `POST /api/v2/stream/:streamId/topics` `{add?: string[], remove?: string[]}` → `Ok<{topics: string[]; rejected?: {topic: string; issue: 'unknown-topic'}[]}>`. Each added topic gets a `snapshot` frame on the stream. **2.4 (office-dev-09):** an unknown topic never rejects the batch: the known ones are added and the unknown ones are listed in `rejected` (also on open: `hello.rejected`). A malformed body is still 400.
- **Resync:** `POST /api/v2/stream/:streamId/resync` `{topic: string}` → `Ok<{queued: true}>`. The server sends a `snapshot` for that topic on that stream (R3-02: the explicit recovery operation).
- **Transport control is never guarded (R3-10):** these two POSTs write neither OpenClaw nor the store. They're allowed on read-only instances and are not audited.
- **Stream ids** are random (`str_` + 22 base62 chars) and scoped to the authenticated session. Another session's stream id → 404 `not_found`.

### 4.3 Revisions (R3-02)
- For ordinary topics, each topic id has **one server-wide revision counter**, shared by every stream, starting at 1 when the server first builds that topic's VM. It's held in memory, so a server restart starts topics over at 1; the `hello` frame then carries a new `serverEpoch`, and clients discard their revisions.
- A **snapshot** carries the topic's **current** revision (not 1). On ordinary topics, a **delta** carries `rev` and `baseRev = rev - 1`.
- **Client rule:** on ordinary topics, apply a delta only if `baseRev` equals the client's revision for that topic. Otherwise call `resync` and ignore deltas for that topic until the snapshot arrives.
- **GET** responses that back a topic include `meta.topic {id, rev}`. A client may render a GET result and then wait for the snapshot; it must not apply deltas on top of a GET result whose `rev` differs from their `baseRev`.
- **Entity revisions** (`Project.revision`, `layout.revision`) are unrelated to topic revisions and are used only for command concurrency (§5).
- **Permission-scoped Projects exception (2.10 / 3.8):** `projects` board and `project:<id>` detail revisions are deterministic safe-integer tokens derived from the exact VM projected for that principal. They are **opaque equality tokens**, not counters: they may decrease, recur, or differ across principals; clients must not order them or infer hidden changes from them. The corresponding GET metadata and SSE snapshot use the same token. These scoped topics send snapshots only, never deltas. A client refreshes/render-replaces on each snapshot and may use token equality only to recognize an unchanged projected payload. This does not change entity `Project.revision` or command `expectedRevision`.

### 4.4 Frames
Each frame has `event: <type>`, `id: <streamId>:<seq>` (seq starts at 1 per stream and increases by 1 per frame) and `data: <JSON>`.
```ts
type SseFrame =
  | { type: 'hello'; streamId: string; serverEpoch: string; modelVersion: number; contractVersion: '2.10'; serverTime: Ms; resumed: boolean; topics: string[];
      rejected?: { topic: string; issue: 'unknown-topic' }[] /* 2.4: unknown topics asked at open */ }
  | { type: 'snapshot'; topic: string; rev: number; data: unknown }
  | { type: 'delta'; topic: string; rev: number; baseRev: number; ops: DeltaOp[] }
  | { type: 'cue'; occupantId: OccupantId; cue: 'delegating' | 'talking' | 'celebrating'; at: Ms;
      partnerId?: OccupantId; interactionId?: string }   // office one-shots, not state; 2.1: a repeated interactionId is ignored (§3.13)
  | { type: 'toast'; level: 'info' | 'success' | 'error'; message: LabelRef }
  | { type: 'system'; gateway: 'up' | 'down'; capabilities: MetaVM['capabilities']; reload?: 'model-version' | 'contract-version';
      closing?: 'session-expired' | 'logged-out' | 'shutdown' }   // S6: present on the final frame before the server closes the stream
  | { type: 'heartbeat'; at: Ms };            // every 25 s
```

### 4.5 Delta path grammar (R3-03)
A path is a JSON **array** of segments, never a dotted string: no escaping is needed.
- **String segment:** an object field name.
- **`{ "id": "<id>" }` segment:** the element of a `Collection` (an array whose elements have `id`) with that id.
- Number segments are not allowed (indices are unstable).

```ts
type Path = (string | { id: string })[];
type DeltaOp =
  | { op: 'set';    path: Path; value: unknown }               // replace the value at path (path may end on a field or an {id})
  | { op: 'upsert'; path: Path; item: { id: string }; index: number }   // path = a Collection; insert or replace by id, then place at index
  | { op: 'remove'; path: Path; id: string }                   // path = a Collection
  | { op: 'move';   path: Path; id: string; index: number };   // path = a Collection; reorder within it
```
- Ops in one frame are applied **in order**, and the frame is atomic for the client: render after the last op.
- **Every op is idempotent (2.1, PM on frontend-02):** applying an op to a state that already reflects it changes nothing (`set` of the same value; `upsert` of an item already there at that index; `remove` of an absent id; `move` to the current index). A client may therefore show a command's `vm` before the matching delta arrives.
- `index` is the final position after the op (0-based) in that collection.
- The server may always send a `snapshot` instead of a delta (for example when the delta would be larger). Clients must support both.

### 4.6 Exact sequences
**Two clients on `office`** (R3-02):
```text
A: GET /api/v2/stream?topics=office
A  ← hello{streamId:'str_A…', serverEpoch:'ep1', resumed:false, topics:['office']}   id str_A:1
A  ← snapshot{topic:'office', rev:18, data:{…}}                                       id str_A:2
B: GET /api/v2/stream?topics=office
B  ← hello{streamId:'str_B…', …}                                                      id str_B:1
B  ← snapshot{topic:'office', rev:18, data:{…}}         (current rev, not 1)          id str_B:2
   (an occupant's state changes)
A  ← delta{topic:'office', rev:19, baseRev:18, ops:[{op:'set', path:['occupants',{id:'main'},'state'], value:'calling'}]}   id str_A:3
B  ← same delta                                                                         id str_B:3
   (B missed a frame and holds rev 17)
B: POST /api/v2/stream/str_B…/resync {topic:'office'}  → 200 {data:{queued:true}}
B  ← snapshot{topic:'office', rev:19, data:{…}}
```

**Board move** (`todo` → `in-progress`, project revision 7 → 8, topic `projects` rev 31 → 32):
```json
{ "type": "delta", "topic": "projects", "rev": 32, "baseRev": 31, "ops": [
  { "op": "remove", "path": ["columns", { "id": "todo" }, "cards"], "id": "prj_k3v9q2m8x1c4d7fz" },
  { "op": "set", "path": ["columns", { "id": "todo" }, "count"], "value": 2 },
  { "op": "upsert", "path": ["columns", { "id": "in-progress" }, "cards"], "index": 0,
    "item": { "id": "prj_k3v9q2m8x1c4d7fz", "name": "Agent Office", "status": "in-progress", "revision": 8, "priority": "P1", "…": "…" } },
  { "op": "set", "path": ["columns", { "id": "in-progress" }, "count"], "value": 4 } ] }
```
On the same commit, `project:prj_k3v9q2m8x1c4d7fz` (if subscribed) receives a `set` of `status` and `revision` plus an `upsert` into `recentHistory`, and `projects?filter=at-risk` receives its own delta, or nothing if the card isn't in that board.

**Reconnect and resume:**
```text
(network drop after A received id str_A:57)
A: GET /api/v2/stream?topics=office,projects   with header Last-Event-ID: str_A…:57
   if str_A… is known for this session and was disconnected < 2 min ago, and frames 58… are still buffered (max 500):
A  ← hello{streamId:'str_A…', resumed:true, topics:[…]}, then frames 58, 59, … replayed with their original ids
   else:
A  ← hello{streamId:'str_C…' (new), resumed:false}, then one snapshot per topic in ?topics=
```
The topics of a resumed stream are the stream's own (restored), not the query's. `?topics=` is only used when a new stream is created. **S6:** the resumed `hello` carries **no `id:` line** (so the browser's Last-Event-ID stays on the last replayed frame); every other frame, heartbeats included, has an id.

**Resource bounds (T-0001, PM decisions):** the server's v2/v3 hubs share admission counts: at most 64 active or resumable streams globally, and eight per session. A new tab at the session cap closes that session's oldest stream (including an active or half-open response); the new tab is admitted. At global capacity, a different session gets normal JSON `429 rate_limited` before SSE headers/timers are allocated. Valid same-session `Last-Event-ID` can replace a still-open response without another slot. Its late close cannot detach the replacement. More than eight tabs can rotate as evicted tabs retry; eight is the simultaneous limit.

Replay is limited to 500 frames **and 2 MiB** per stream. The encoded-frame ceiling is 1 MiB for deltas/control frames. A larger delta triggers a current snapshot. **Required snapshots are delivered even when larger** (PM decision), with one value-free warning per server; their payload is excluded from replay, and replay across that gap falls back to a fresh snapshot. The output budget is 1 MiB for normal pending application/known Node data, plus the one required snapshot already being written. Snapshots use contiguous UTF-8 slices of at most 64 KiB, with no other frame interleaved. After `write` returns false, no further writes occur until drain; a five-second interval without observed transport progress closes the stream; progressing snapshots can take longer. A snapshot that exceeds the remaining budget, including existing output, gets the same in-flight exception. Blocked topic changes coalesce into at most 32 topic IDs, with current snapshots fetched after drain instead of accumulating serialized data. A drop with deferred topics forces resync. Normal queue overflow, control-frame overflow, write error or drain timeout closes and forgets the stream. Logout/expiry/shutdown release slots, buffers and timers; a blocked socket receives no additional closing notification. These are process-memory controls, with no SQLite persistence and no absolute size ceiling on required snapshots.

Explicit browser reconnect creates a new EventSource and carries no `Last-Event-ID`: it requests a fresh hello/snapshot. Only the browser's automatic retry uses replay. A process restart also forces snapshot resync.

### 4.7 Delivery rules
- **Coalescing:** at most one frame per topic id every 250 ms. Changes that don't alter a topic's VM produce no frame.
- **Model or contract change:** if `hello.modelVersion` or `hello.contractVersion` differs from what the page loaded with, the client reloads (a `system.reload` frame says the same).
- **Auth (R1-09, S6):** a stream is closed when its session expires, and at once when that session logs out, with a final `system` frame (`closing`). Clients then go through `/api/v2/me` (401 → login).
- **Logout semantics (R1-09, decided in S6):** each login cookie carries a random session id; `POST /api/logout` **revokes it server-side** (stored until the cookie would have expired), so that cookie and any copy of it are refused at once by v1 and v2, and the session's v1 and v2 streams close. Cookies issued before S6 carry no session id and stay valid until they expire (≤ 12 h).

## 5. Commands (writes)

### 5.0 Classes, guards and common rules
| Class | Routes | Guard on a read-only instance |
| --- | --- | --- |
| **OpenClaw** | §5.1, §5.2 | refused with 403 `readonly` when `capabilities.openclawWrites` is false |
| **Store** | §5.3, §5.4, §5.5 | refused with 403 `readonly` when `capabilities.storeWrites` is false |
| **Transport control** | §4.2 stream topics/resync | never guarded, not audited |

- Every command validates its body (`extra: 'reject'`) and **audits** the call (`audit_log`: actor, command, target, outcome, requestId; never bodies).
- **Result:**
  ```ts
  interface CommandResult<R = null> { ok: true; result: R; revision: number | null; vm: unknown | null }
  // revision: the entity's new revision (projects, layout) or null; vm: the entity's fresh VM where stated, else null
  ```
- The resulting VM changes also go out over SSE.

### 5.1 OpenClaw: flows, skills, gateway
| Command | Route | Body | `result` |
| --- | --- | --- | --- |
| Create a flow | `POST /api/v2/flows` | `{ name: string(1..80); cron: string /* 5 fields */; tz: string /* IANA */; message: string(1..4000) }` | `{ jobId: CronJobId \| null }` |
| Edit a flow | `PATCH /api/v2/flows/:jobId` | `{ name?, cron?, tz?, message? }` (at least one) | `null` |
| Enable/disable | `PUT /api/v2/flows/:jobId/enabled` | `{ enabled: boolean }` | `null` |
| Run now | `POST /api/v2/flows/:jobId/runs` | `{}` | `null` |
| Delete | `DELETE /api/v2/flows/:jobId` | `{}` | `null` |
| Toggle a skill | `PUT /api/v2/skills/:name/enabled` | `{ enabled: boolean }` | `{ needsRestart: true }` |
| Restart the gateway | `POST /api/v2/gateway/restart` | `{ confirm: 'redemarrer' }` | `{ via: 'rpc' \| 'systemctl' }` |

- **Create is fixed to agent `main` and session `isolated`,** as today (R3-11). Other agents or targets aren't offered until a decision says otherwise.
- **Edit** is allowed only when `FlowDetailVM.editable` (a `cron` schedule with an `agent-turn` payload); otherwise → 400 `validation_failed` (`issue:'not-editable'`). `unrecognized` is never a legal write value.
- **Validation:** cron must be 5 fields, tz an IANA zone, names 1–80 chars. Ids are validated, not stripped: an invalid or leading-dash id → 400 (`issue:'invalid-id'`, R1-12).
- **Gateway restart:** 429 `rate_limited` within 2 min of the last one. It's audited, and only Owner triggers it.
- **S7c implementation notes (no shape change):**
  - **Create** uses the primary agent (`MetaVM`/agents `isPrimary`); without one → 503 `upstream_unavailable` (`issue:'agent-unknown'`).
  - **A failed CLI command** → 502 `upstream_failed` with the failure category as `details[0].issue` (e.g. `exit-1`, `killed-or-timeout`); never the CLI's text. A refused write on a read-only instance stays 403 `readonly`.
  - **Run now** while a run is still `running` → 409 `conflict` (`issue:'run-pending'`).
  - **Skill names** for the toggle are `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (no `.`: the name is a config path segment); unknown skill → 404.
  - **Restart:** the gateway's own RPC first, else the user service manager (`OC_SERVICE`, default `openclaw-gateway.service`); a failed restart → 502 and does **not** start the 2-minute cooldown.
  - **R1-12 argv:** every value travels as one `--opt=value` element (a value starting with `-` can never become a flag); ids are validated (leading dash → 400 `invalid-id`) **and** placed after `--`.

```json
POST /api/v2/flows/ffffffff-0c01-4000-8000-000000000001/runs  {}
→ 200 { "data": { "ok": true, "result": null, "revision": null, "vm": null }, "meta": { "modelVersion": 1, "generatedAt": 1791223200000, "stale": [] } }
```

### 5.2 Chat
`POST /api/v2/chat/messages` `{ text: string(1..8000) }` → **202** `Ok<CommandResult<{ turnId: string }>>`.
- The CLI turn runs in the background, and its progress arrives on the `chat` topic (`turnPending`, then the assistant message or an `error` message).
- A second POST while a turn is pending → 409 `conflict` (`issue:'turn-pending'`).
- **S7c / T-0159:** each authenticated account gets its own chat history, live topic projection, pending state, and adapter session reference. The account scope is derived server-side from the authenticated user id; callers cannot select another scope. The owner retains the legacy `portal-chat` ref; other accounts receive stable opaque refs. Chat is unavailable (404 `not_found`) unless the adapter declares `chatSessionScope: 'principal'` and can map those refs to distinct conversations. `GET /api/v2/views/chat` re-reads only that account's transcript. While pending, the sent message shows as a `user` message with id `pending_<turnId>` until the transcript has it. A failed turn adds an `error` message « La réponse n’a pas pu être obtenue (<category label>) » (label `chat.turnFailed`); a new turn is then accepted. Explicit Logs/session permissions continue to govern the separate session-history views.

### 5.3 Data quality and preferences (store)
| Command | Route | Body | `result` |
| --- | --- | --- | --- |
| Mute / unmute an issue | `PUT /api/v2/health/issues/:id/muted` | `{ muted: boolean }` | `{ state: 'open' \| 'muted' \| 'resolved' }` |
| UI preferences | `PATCH /api/v2/prefs` | `Partial<UiPrefs>` | `UiPrefs` |

- **Mute:** `:id` is the fingerprint (unknown → 404). An `error` issue → 400 (`issue:'error-not-mutable'`). A muted issue that recurs stays muted; its count still grows.

### 5.4 Projects (store) — R3-04, R3-05, R3-06, R3-12, R3-13
**Concurrency.** Every project write except **create** carries `expectedRevision: number` (the `ProjectVM.revision` / card revision the client saw).
- **Stale** (`expectedRevision !== current`) → 409 `conflict` with `error.current = { revision, vm: ProjectVM }`. The client applies `vm` (for example, reverts an optimistic drop) and may retry.
- **One transaction per command:** at most **+1** to the revision, however many fields or events it writes.
- **No-op** (nothing would change: same status, same name, ack already in that state) → 200, `revision` unchanged, no history, not audited as a change.
- **System writes** (risk monitor, activity ingestion, repo/workspace/session caches) never carry or check `expectedRevision`. The risk monitor bumps the revision when the card changes; caches and activity never do (projects.md), so a background refresh can't 409 an in-flight drag.
- **The 200 result** of every project command (except history reads) is `CommandResult<null>` with `revision` = the new revision and `vm` = the fresh `ProjectVM`.

| Command | Route | Body | History events written (actor = caller) | Moves `lastActivityAt` |
| --- | --- | --- | --- | --- |
| Create | `POST /api/v2/projects` | `{ name: string(1..80); status?: ProjectStatus = 'idea'; priority?: Priority = 'P2'; summary?: string = ''; sources?: ProjectSourceInput[] = [] }` | `project-created`, then `source-linked` per source | yes (creation time) |
| Edit (compound) | `PATCH /api/v2/projects/:id` | `{ expectedRevision; name?; summary?; priority? }` | one per **changed** field: `renamed {from,to}`, `summary-edited`, `priority {from,to}` | yes |
| Move | `PUT /api/v2/projects/:id/status` | `{ expectedRevision; status }` (no index) | `status {from,to}` | yes |
| Archive / restore | `PUT /api/v2/projects/:id/archived` | `{ expectedRevision; archived: boolean }` | `archived` / `restored` | no |
| Add a label | `POST /api/v2/projects/:id/flags` | `{ expectedRevision; kind: 'label'; label: string(1..32) }` | `flag-added {flagKind:'label', key, label}` | yes |
| Set Bloqué | `POST /api/v2/projects/:id/flags` | `{ expectedRevision; kind: 'risk'; key: 'blocked' }` | `flag-added {flagKind:'risk', key:'blocked'}` + `risk-raised {key:'blocked', severity:'high'}` | **no** (2.1: risk bookkeeping) |
| Remove a flag | `DELETE /api/v2/projects/:id/flags/:kind/:key` | `{ expectedRevision }` | `flag-removed {flagKind, key}` | label: yes; `blocked`: **no** (2.1) |
| Ack / un-ack a risk | `PUT /api/v2/projects/:id/flags/risk/:key/ack` | `{ expectedRevision; ack: boolean }` | `risk-acked` / `risk-unacked {key}` | no |
| Link a source | `POST /api/v2/projects/:id/sources` | `{ expectedRevision; source: ProjectSourceInput }` | `source-linked {source, ref}` | yes |
| Unlink a source | `DELETE /api/v2/projects/:id/sources/:sourceId` | `{ expectedRevision }` | `source-unlinked {source, ref}` | yes |
| People override | `PUT /api/v2/projects/:id/people/:personId` | `{ expectedRevision; role?: string(0..32) \| null; hidden?: boolean }` | `people-override {personId, role, hidden}` (both always written) | no |
| Regenerate the summary (2.1) | `POST /api/v2/projects/:id/summary/regenerate` | `{ expectedRevision }` | none now; Timmy's answer arrives later as `summary-edited` (actor Timmy) | when the summary lands |
| Append history (Timmy, 2.1) | `POST /api/v2/projects/:id/history` | `{ expectedRevision; kind: 'commit' \| 'flow-run' \| 'cron-run' \| 'session' \| 'agent-action'; dedupeKey?; eventAt?; …payload }` | that event; a repeated `dedupeKey` is a no-op; `expectedRevision` is checked but the revision is **not** incremented | yes (event time) |
| Import (2.1, R7-02) | `POST /api/v2/projects/import` | `ImportRequest` (below) | per project: `project-created`, `source-linked`, `flag-added` | the candidate's last activity |

```ts
type ProjectSourceInput =                   // R3-12: the server mints id, addedAt and addedBy; clients never send them
  | { kind: 'github'; ref: { owner: string; repo: string } }      // owner must be in the allow-list (alexdeg92)
  | { kind: 'workspace'; ref: { path: string } }                  // relative, no '..'
  | { kind: 'sessionGroup'; ref:
        | { by: 'group'; groupId: SessionGroupId; name: string }   // 2.4: the runtime's group; members follow it (preferred)
        | { by: 'interlocutor'; interlocutorId: InterlocutorId }
        | { by: 'keys'; sessionKeys: SessionKey[] } }            // fallback only: runtimes without session groups (frozen set)
  | { kind: 'manual' };
type SessionGroupId = string;               // 2.4: opaque, 1–200 chars; OpenClaw: the group name (a rename = a new id)
```
- **Regenerate the summary** is an **OpenClaw-class** command (it runs an agent turn): requires both `openclawWrites` and `storeWrites`, else 403 `readonly` before claiming or dispatching a turn. Acceptance persists a recoverable comment delivery and pending identity; it answers **202** with `CommandResult<{ turnId }>`, `revision` unchanged, like chat (§5.2). A second request while one is pending → 409 (`issue:'turn-pending'`).
- **Archive UI (frontend-02 §7.6):** *Archiver* / *Restaurer* in the project header's overflow menu; archived projects are listed by the board filter `archived`.
- **People overrides UI:** the *Personnes impliquées* panel's row menu (*Rôle…*, *Masquer*), from S15a.
- **Import** (one transaction per project; no `expectedRevision`; Owner's cookie only):
  ```ts
  interface ImportRequest { keys: string[] /* ≥ 1 */; overrides?: Record<string, { name?: string(1..80); status?: ProjectStatus; labels?: string[] }> }
  type ImportResult = CommandResult<{ created: { key: string; id: ProjectId }[];
                                      skipped: { key: string; reason: 'unknown' | 'exists' | 'validation_failed' }[] }>;   // revision: null, vm: null
  ```
  A key not in the latest candidate list → skipped `unknown` (not a 409); a GitHub repo already on an active project → `exists`; one bad candidate doesn't roll back the others. Body errors → 400: empty `keys` (`issue:'empty-selection'`), an override for an unselected key (`'override-not-selected'`), a bad name or status (`'validation_failed'` details). Labels in an override are display strings and replace the suggested ones. The client toasts `created.length`, lists `skipped`, and refetches the board. Examples: `import-request.json`, `import-result.json`.
- **Flag rules (R3-13):**
  - `POST /flags` accepts only `kind:'label'` or `{kind:'risk', key:'blocked'}`, else 400 (`issue:'flag-not-writable'`).
  - `DELETE` accepts a label, or the manual `blocked` risk. A feature, priority or auto risk → 400 (`issue:'flag-not-removable'`); an unknown key → 404.
  - Ack accepts any uncleared risk (else 404).
  - A label key is the slugified label; a duplicate label is a no-op.
- **Source rules (R3-12):**
  - The same `(kind, ref)` on the same project is a no-op.
  - A github repo already linked to another active project → 409 `conflict` (`issue:'source-in-use'`, no `current`).
  - An owner not allow-listed → 400 (`issue:'owner-not-allowed'`).
- **Meaningful activity (R3-06):** `lastActivityAt` moves only on the writes marked "yes" above, plus ingested activity (`commit`, `flow-run`, `cron-run`, `session`, `agent-action`, at their own event time). Risk, ack, archive, people and feature-flag bookkeeping never move it, so the `stale` risk can't reset itself. data-model §9.1 holds the canonical list.
- **Timmy's access (later phase):** `Authorization: Bearer <agent token>` on the same routes, scope-limited, with actor `{kind:'agent'}`.

```json
PUT /api/v2/projects/prj_k3v9q2m8x1c4d7fz/status   { "expectedRevision": 7, "status": "in-progress" }
→ 200 { "data": { "ok": true, "result": null, "revision": 8, "vm": { "id": "prj_k3v9q2m8x1c4d7fz", "revision": 8, "status": "in-progress", "…": "…" } },
        "meta": { "modelVersion": 1, "generatedAt": 1791223200000, "stale": [] } }
```

#### 5.4b The project thread (architect-57)
| Command | Route | Body | Result | Class |
| --- | --- | --- | --- | --- |
| Comment | `POST /api/v2/projects/:id/comments` | `{ body: string(1..4000), replyTo?: CommentId | null }` | **201** `CommandResult {comment: CommentItemVM}`; each `@agent` mention (an agent id or name) gets a delivery `pending` (or `unavailable`/`readonly` without OpenClaw writes) | store |
| Edit (own) | `PATCH /api/v2/projects/:id/comments/:cid` | `{ body }` | the comment, `editedAt` set; never re-delivered; another's: 403 | store |
| Delete | `DELETE /api/v2/projects/:id/comments/:cid` | none | soft: the item stays, `deleted: true`, `body: null`; already deleted: 400 | store |

`POST /api/v[23]/projects/:id/comments/:cid/retry { agentId }` returns **202** with `{comment: CommentItemVM}`. Only the original author may retry a non-deleted item; its selected delivery must be `failed` (including legacy `reason: 'empty'`) or `no-reply`. Unknown/cross-project items are 404, non-retryable/invalid bodies are 400, other authors and read-only operation are 403. Retry is an OpenClaw write plus a store write, audited as `projects.retryComment` with project id target. It also accepts failed summary-request events.

Reply parents must be existing, non-deleted stored comments/events in the same project: invalid `replyTo` type is 400, missing/cross-project parent is 404, deleted parent is 400. Mentions match agent id or display name case-insensitively with accents folded (id takes precedence on collisions); aliases for the same agent are delivered once. `@main`, `@Timmy`, and `@timmy` resolve to the same configured agent. An agent's answer always has `replyTo` equal to the exact comment that mentioned it, including when that comment is itself a reply. Its ancestor chain is preserved for synchronous and deferred answers.

Delivery states: `pending | working | replied | failed | no-reply | unavailable`; `working` has label `projectThread.delivery.working` (« {agent} y travaille… »), and `no-reply` has label `projectThread.delivery.no-reply`, reason `timeout`, and the retry action above. Summary-request events carry the same delivery array. Delivery follow-up coordinates are private persisted store metadata and are never exposed in the VM.

Delivery: one agent turn per mention, serial per project, in the session `agent:<agentId>:ao-projet-<slug>` (the tag's slug, else the name's), with the project's context (name, status, priority, summary, linked conversations, the last 8 comments). No channel delivery. An empty terminal CLI payload after spawn/yield becomes `working`. The backend follows the project session and its spawned children, posts each later assistant message as an agent comment (`replyTo` the original request), and publishes the child's final result after 30 seconds if the parent has not relayed it. It keeps watching for a late parent relay. Comments exceeding 4,000 characters are split into consecutive replies. The cursor and replies commit together; pending tracking and queued deliveries resume from SQLite on restart. Pending work times out after two hours as `no-reply` (a delivered child fallback remains `replied`). A runtime failure becomes `failed` with a category. Project turns stay serial until the final relay or tracking deadline. Prompts include real linked-session requests, people, dates, session keys and child final results (1,500 characters per result, 8,000 characters total linked context, newest first), plus the project's name, status, priority, summary and last eight comments. The agent's status/priority changes are `system` items (from the history); « Demander un résumé » adds an `event` item and the reply as a comment. Audited as `projects.comment`, `projects.editComment`, `projects.deleteComment`.

### 5.5 Office layout (store) — R3-18 (2.1)
| Command | Route | Body | `result` |
| --- | --- | --- | --- |
| Save | `PUT /api/v2/office/layout` | `{ expectedRevision: number; data: OfficeLayoutDataV1 }` | `null`; `revision` = new, `vm` = `LayoutVM` |
| Quick theme toggle | `PUT /api/v2/office/layout/theme` | `{ expectedRevision: number; theme: OfficeLayoutDataV1['theme'] }` | `null`; replaces only `data.theme`; a new revision; `vm` = `LayoutVM` |

- **Stale** → 409 `conflict`, with `error.current = { revision, vm: LayoutVM }` (same rule as projects). *Recharger* adopts `current.vm` without another request; *Écraser* resubmits the draft with `expectedRevision = current.revision`.
- **Semantic validation** with the shared validator → 400 `validation_failed`, `details[] = { issue, field }` (issue list in §3.13).
- **Reset:** the client loads `LayoutVM.default.data` into the draft and saves with the normal PUT. **Restore a version:** `GET /office/layout/revisions/:rev` into the draft, then the normal PUT. No dedicated routes: one write path, one validator. Retention: 20 revisions.

### 5.6 The agent's scoped token (S7d, projects-13)
The primary agent writes to Projets with `Authorization: Bearer <token>` on `/api/v2` (its Projets skill). A token is created, rotated and revoked locally (`node scripts/agent-token.js create|rotate|revoke|list --agent <id> [--out <file>]`); the raw token exists only in a 0600 file and is never printed, logged or audited. Only a per-store salted hash is stored (`api_tokens`, migration 004).
- **Allowed, and nothing else** (body fields exactly as listed; an `actor` field → 400 `unexpected-field`; the actor is **forced** to the token's agent):

  | Command | Route | Body |
  | --- | --- | --- |
  | Set the status | `PUT /api/v2/projects/:id/status` | `{ expectedRevision, status }` |
  | Edit the summary | `PATCH /api/v2/projects/:id` | `{ expectedRevision, summary }` |
  | Add a label | `POST /api/v2/projects/:id/flags` | `{ expectedRevision, kind: 'label', label }` |
  | Append history | `POST /api/v2/projects/:id/history` | `{ expectedRevision, kind ∈ commit \| flow-run \| cron-run \| session \| agent-action, dedupeKey?, eventAt?, …payload }` |

- **Everything else → 403 `forbidden`** (`issue:'token-scope'`): every GET (views, meta, me), the SSE stream and its transport POSTs, every other command and area, every v1 route.
- **Unknown, malformed or revoked token → 401 `unauthorized`** (nothing says which). **More than 30 requests per minute per token → 429** (refused requests count too).
- A request with a bearer **never uses a cookie** sent with it.
- **Audit:** every attempt, with actor `{ kind: 'agent', personId }` and `token:<id>` in `detail` (`token-scope token:<id>` for a refused scope, `rate-limited token:<id>`); a bad token is `token.request` / `rejected` / `unauthorized` as anonymous.

### 5.7 First-run setup (ADR-001 §5; 2.7)
An instance with **no configuration** (no config file, and the env lacks the login identity) boots in **setup mode**: only `GET /api/v2/meta` (`instance.configured: false`), these routes and the static UI are served. Every other API route answers 503 `upstream_unavailable` (`issue:'not-configured'`). Setup is unavailable on a read-only instance (`state:'readonly'`) or a configured instance with its owner (`state:'locked'`). A DB-auth config whose owner row is missing, or whose persisted open setup draft does not match the published config digest, boots local recovery with a fresh code. A missing private secrets file serves locked setup with `lockReason: "missing-secrets"`, no setup code or writes, and a restore-and-restart message.

- **The setup code:** a one-time code (`AO-XXXX-XXXX`, 40 bits from an unambiguous alphabet) printed to the server log at boot in setup mode, never stored. It expires after **30 minutes on a monotonic clock**; expiration returns 403 `{field:'setupCode',issue:'expired'}` and discards remembered connection secrets and integration plans. Restart Agent Office locally to obtain a new code; no remote endpoint regenerates it. Owner creation/config publication recheck expiration after password derivation; async discovery/probes/plans discard results after expiry. Each synchronous per-agent file operation admitted before expiry may finish, but no later agent starts after expiry. Every POST/PUT below needs it in the body as `setupCode`; GET state/catalog expose only public setup metadata. A wrong code → 403 `forbidden` `{field:'setupCode', issue:'invalid'}` (`error-403-setup.json`), and it counts toward the login throttle (6 failures → 429 `rate_limited` with `Retry-After`). **Setup and login share one throttle state** for the process, across the handoff (R21-05). A successful `PUT /api/v2/setup` spends it.
- **Write-only secrets:** `runtime.token` and `owner.password` are accepted and **never echoed, logged or audited**. `draft` only reports `tokenSet` / `passwordSet`. A token given to `check` is kept in memory for `discover` and `PUT` (so the client need not resend it), until setup expires, publishes or the process ends.

| Route | Body | Response |
| --- | --- | --- |
| `GET /api/v2/setup` | none (no session, no code) | `Ok<SetupVM>` (`setup-vm.json`) |
| `POST /api/v2/setup/check` | `{ setupCode, runtime: { adapter, gatewayUrl, token? } }` (`setup-check-request.json`) | `Ok<CommandResult<{ ok, status: 'connected'\|'unreachable'\|'refused'\|'unauthorized', protocol: number\|null, latencyMs: number\|null }>>` (`setup-check-result.json`). A failed connection is a **200** with `ok:false`; an invalid `gatewayUrl` is 400 `{field:'runtime.gatewayUrl'}`. |
| `POST /api/v2/setup/discover` | `{ setupCode, runtime }` | `Ok<CommandResult<{ agents: [{ id, name, isPrimary, model: string\|null }] }>>` (`setup-discover-result.json`); an unreachable runtime → 502 `upstream_failed` `{issue: <check status>}` |
| `PUT /api/v2/setup` | `{ setupCode, instance: { name, locale, timeZone }, owner: { displayName, email, password? }, runtime: { adapter, gatewayUrl, token? }, agents: { primary, looks? } }` (`setup-save-request.json`) | `Ok<CommandResult<{ configured: true }>>` (`setup-save-result.json`) |

```ts
interface SetupVM {
  network: { host: string; port: number }; // public listener from server config, including the combined supervisor
  state: 'open' | 'locked' | 'readonly';
  configured: boolean;
  lockReason: 'missing-secrets' | null; // restore matching private secrets and restart; no setup writes
  adapters: Array<{ id: string; name: string; connect: boolean; fields: string[]; defaultGatewayUrl: string | null }>;   // connect means selectable for setup; demo is true with fields [] and no gateway
  draft: null | {                       // null unless state is 'open': nothing about an instance is shown to a visitor
    instance: { name: string; locale: 'fr' | 'en'; timeZone: string | null };
    owner: { displayName: ""; email: ""; passwordSet: boolean }; // identity only from code-gated resume
    runtime: { adapter: string; gatewayUrl: string | null; tokenSet: boolean };
  };
  suggestedTimeZone: string;            // the server process's zone (ADR §12.7)
  locales: Array<'fr' | 'en'>;
  integrations: Array<{id: string; adapters: string[]; default: boolean}>;
}
```
- **`PUT` validation** (400 `validation_failed`, one detail per field): `instance.name` 1–80 chars; `instance.locale` ∈ `locales`; `instance.timeZone` an IANA zone; `owner.displayName` 1–80; `owner.email` an address; `owner.password` ≥ 12 chars, **required unless `passwordSet`**; `runtime.adapter` a listed adapter (`openclaw`, or `demo`: a synthesised read-only team that takes no other runtime field, G6); for `openclaw`, `runtime.gatewayUrl` `ws(s)://host[:port][/path]` and a token **required unless `tokenSet`**; `agents.primary` an agent id (`[A-Za-z0-9_-]{1,64}`); `agents.looks` a map agentId → `{ character, variant: string|null, accessories: string[] }`.
- **What `PUT` writes:** the instance config file (`$AO_CONFIG`, else `$XDG_CONFIG_HOME/agent-office/config.json`; 0600, atomically: temp file + rename) with the non-secret values, and the **secret file** `secrets.json` next to it (0600): the scrypt hash of the password, a new session secret, the runtime token. **Env always wins** over both, and **only a complete environment login replaces file auth**; a partial set of `PORTAL_EMAIL`, `PORTAL_SECRET`, `PORTAL_PASSWORD_HASH`, `PORTAL_PASSWORD` is a named boot error, never a deletion of database auth. Then the server **switches to the configured app in-process on the same port**, once every in-flight setup request has answered (a losing concurrent `PUT` gets its 403 `{issue:'locked'}`, R21-04): the client reloads and signs in.
- **Publication (R21-03):** one publisher at a time (an `O_EXCL` lock file next to the config; a dead process's lock is taken over); `secrets.json` first, then `config.json`, the **commit marker**; each through a private temporary and `link()`, which never overwrites an existing file. A crash before the commit leaves `secrets.json` alone, which boot ignores (a warning) and the next setup replaces: setup is never stranded. Another process publishing → 409 `conflict` `{issue:'publishing'}`.
- **Permissions (R21-01):** at every start, `secrets.json` and `config.json` must be 0600, their directory and the data dir 0700. Ours and too open → fixed, with a warning naming the path; someone else's → the server refuses to start and prints the `chmod` to run.
- **Diagnostics (R21-02):** a config file with undeclared fields fails startup with their parent path, count and types (`$.instance: 2 undeclared fields (number, string)`), never their names.
- **`agents.looks`** is stored in the config (`agents.looks`); applying it to the office layout's agent rules is the layout service's next step (with office-dev).

## 6. HTTP details
- **The UI at `/v2/`** (S3, `src/api/http.js`). Files in `public/v2/` are served as-is (`no-cache, must-revalidate` on html/js/css). Any other `GET /v2` or `/v2/...` path without a file extension gets `public/v2/index.html`. Decisions use one canonical path: decoded once (malformed → 400) and dot-normalised (R2-10). A missing asset is a plain 404, never the shell. The shell is public; every API call enforces auth.
- **Cache:** `Cache-Control: no-store` on `/api/v2/*`.
- **Request id:** `X-Request-Id` on every response, in errors and in the access log (no bodies).
- **CSRF:** same-origin only, no CORS. Writes require `Content-Type: application/json`, which with `SameSite=Lax` blocks form CSRF.
- **`Secure` cookie (R1-10, S6):** `PORTAL_COOKIE_SECURE=1|0`; when unset, on for the production instance only. Staging and dev are served over plain HTTP on the tailnet, so it is never enabled there silently.

## 7. Contract tests
- **VM shape:** every builder's output is validated against its VM schema (the types above, as DSL schemas in `src/api/vm/`), also at runtime with `AO_STRICT_VM=1`.
- **Examples are the contract (2.1, PM on review-07):** `docs/architecture/examples/*.json` holds an authoritative payload for every VM and command shared across agents (README there). **Producers** (projects, architect) assert `compareShape(example, builderOutput)` from `test/helpers/contract-shape.js` returns `[]`; **consumers** (frontend, office-dev) build their mocks from those files. A shape change is example + changelog first, then producers and consumers. `test/api/contract-examples.test.js` checks the examples' own consistency (409 ↔ ProjectVM, history pages ↔ `recentHistory`, import ↔ candidates, LayoutVM ↔ design/office). The JSON snippets in this document are illustrations; where they differ, the example files win.
- **Route tests:** every route and command against FakeGateway + fake CLI, including each `issue` value and the 409 `current` payload.
- **SSE tests:** the exact §4.6 sequences, covering two clients, gap → resync, the board move, and resume within and after 2 min.

Sender extension (2.6): see [sender-identities.md](sender-identities.md) for the shared Sender/Participant schema and adapter conformance hooks. TraceEventVM and ChatVM messages accept `senderInfo`; SessionVM carries a `participants` collection.

### 5.7.1 Owner, detection, installation and network contracts (2.7)

These routes are mounted under both `/api/v2` and `/api/v3`. Every POST requires the logged one-time `setupCode`, follows the existing throttle, and refuses writes when setup is locked or readonly. They return the standard `Ok<CommandResult>` envelope. Existing setup request examples remain valid for legacy clients.

| Route | Request additions beyond `setupCode` | Result |
| --- | --- | --- |
| `POST /setup/resume` | none | Private saved `{owner:{displayName,email,passwordSet}|null}` after setup-code admission. Public GET never returns saved name/email. |
| `POST /setup/owner` | `owner: {displayName, email, password, passwordConfirmation}`; password ≥12 characters and matching confirmation | `{created:true, owner:{displayName,email,passwordSet:true}}`. Creates or amends the one DB owner while setup is open, in a transaction with its Person/layout seed/setup status. A password is required on creation; omitted on amendment it preserves the hash. Never returns password/hash. |
| `POST /setup/detect` | none | `{runtimes:[{runtime,name,found,confidence,supported,agents,connection}],selected}`. Agents have `id`, nullable `name`, `nameSource`, primary/model hints. Connection has gateway URL and `tokenSet`; token/workspace fields are omitted. |
| `GET /setup/catalog` | none; open setup only | `Ok<Manifest>` with all shipped characters and enabled packs, shared with the Store/layout validator. |
| `POST /setup/integrations/plan` | `runtime`, `locale` | `{planId,agents:[{id,status,files,uninstallFiles}],backupDir}`. Server-owned adapter targets; expires in ten minutes; planning writes nothing. |
| `POST /setup/integrations/apply` | `planId`, `agentIds`, `confirmed:true`, optional `action:'install'|'uninstall'` | `{agents:[{id,status,changed,backup,reason}]}`. Rejects stale plans/symlinks. Stages private preimages, then applies the selected set. A later failure restores completed changes; a concurrent replacement refuses rollback (`EROLLBACK`) and retains recovery preimages. Install/uninstall use descriptor I/O with pinned parents; uninstall removes only unchanged owned files and empty directories. |
| `POST /setup/network` | inspection: `domain?`, `port?`, `publicIp?:boolean`; access check: `action:'probe',url` | inspection: bind/addresses/tailnet/public IP/DNS/snippets; probe: `{ok,status,issue}` from bounded `/build.json` fetch. No system files are changed. |

The core delegates discovery to `adapter.setup.discover`; the adapter reconciles detected config/identity names and its transport listing; missing names remain null, with an optional source field. New onboarding uses the DB owner from the first step, so the final `PUT /setup` omits the password. `agents.names` in PUT contains editable local names; config v2 stores them under `agents.names[adapterId]`; `agents.looks` seeds the validated initial layout. `integrations.reviewed:true` prevents the legacy post-save install; the explicit install step owns every confirmed change. Optional `network:{mode,port,publicUrl}` is normalized to Agent Office's own bind/origin/cookie configuration. Modes are local/LAN/tailnet/public/tunnel; the latter three require HTTPS. Current listener/origin settings remain active until restart. Legacy env/file owner logins remain supported. New DB-auth `taco_sess` payloads identify the stable `users.id`; old DB cookies without it require a fresh login, and legacy email cookies retain their verification path.


`selected` is null when more than one detected transport has `setup.connect:true`; selection then belongs to the operator. Presence-only detectors cannot become transports by setting a detector flag. No empty config invents an agent or primary. Named peer occupants use `agent:<agentId>` / role `agent`; delegate occupants remain `subagent:<subjectId>` / role `subagent`, including when the ids match. The subagent KPI counts only delegates. Previously saved onboarding peer rules migrate by their configured labels; ordinary delegate rules stay intact.

**Publication and versions:** modern owner setup publishes config/secrets **version 2**, with `owner.authSource="database"` and no password hash in secrets. Strict v1 remains readable (no authSource/names/network; required secrets passwordHash). DB owner/person/layout/open status commit together; final layout/config digest commit before file publication; status becomes configured afterward. Boot reconciles the digest if publication finished before a crash. These forward DB/config migrations require a private pre-upgrade backup to roll back; an old binary cannot read v2 or the newer DB schema. See operations.md.

**Gateway overrides:** adapters map their own runtime config/credentials into the effective environment. Changing a gateway URL without its token drops the stored credential unless the normalized destination is unchanged.

**Environment auth:** only a complete env login (email, session secret, password or hash) replaces file auth. Every partial login environment, including `PORTAL_SECRET` alone, refuses startup with declared variable names only. Stored DB mode and email are never deleted by an incomplete override.

**Executable fixtures:** each new route has `setup-owner`, `setup-resume`, `setup-detect`, `setup-integration-plan`, `setup-integration-apply`, or `setup-network` request/result examples; catalog uses `setup-catalog-result`, modern PUT uses `setup-finalize-request`/`-result`. `test/setup/contract-examples.test.js` inventories actual mounted routes and checks live synthetic HTTP responses against these examples and the strict `SetupVM` schema. Legacy check/discover/save examples remain supported.

### T-0052 additive appearance contract (2026-10-10)

`OccupantVM.automaticLook` and `LayoutVM.agentsSeen[].automaticLook` optionally carry the durable automatic assignment in the same shape as `look`. Owner rules still determine the effective `look`; the additional field lets editor/Store previews reuse the automatic assignment after name/station edits, reset and owner overrides. Both 2.x and 3.0 include it; no new unauthenticated route is added.

Agent rules in `layout.data.agents[]` and `default.data.agents[]` may carry `appearance: 'auto' | 'manual'`. Both authoritative LayoutVM examples and the shipped seed explicitly show auto; the field is optional for legacy clients. Appearance edits explicitly set manual, including choosing the old seed style or no accessories. Name/station edits keep auto. Legacy exact owner rules and changed wildcard styles remain manual; untouched shipped seed styles use auto. Automatic allocation is stored once by canonical agent identity in `office_automatic_looks`, chooses a least-used installed family atomically, and persists through absence, seen-inventory retention, reloads and restarts. New installed families affect new assignments only. Hashes choose ties, variants and optional supported gear; no ID-specific runtime code is used. The existing inventory cap remains 200; OfficeVM roster rows are bounded separately at 64 with an explicit overflow count.


### Desk communication (T-0122)

Office occupants may carry nullable `communication: {id, mode: "desk"|"meeting", peerIds: string[], expiresAt: timestamp, screen: "message-sent"|"message-received", surface: "monitor"|"bubble", label: LabelRef}`. Only callers with sessions.read receive communication metadata; peers must be visible canonical occupants. The engine reads canonical sender identities from each occupant’s exact session transcript. It never inspects message text, guesses peers from names/providers/team membership, or carries transcript text in the scene. Evidence expires after two minutes; the server refreshes the VM at expiry.

`screenIntent: {screen: "message-sent"|"message-received"|"coding"|"terminal"|"browsing"|"writing"|"thinking"|"waiting"|"blocked"|null, surface: "monitor"|"bubble"|"none", label: LabelRef|null}` provides the display directly. A computer target uses the monitor; an occupant away from a computer uses an overhead marker. The browser only selects registered animation frames, respecting reduced motion and visibility.

Ordinary exchanges retain the supplied desk/home or current activity target. Optional persisted `layout.data.communicationMeetingPercent` (integer 0–100, default 10) deterministically samples a conversation by exact session and canonical peer identities. A physical meeting requires same-floor participants, no current activity, and two reachable registered table seats; no additional standing tiles or desks are invented. `sceneTarget` carries each authoritative meeting point; the home desk stays reserved. Each table hosts one pair, and expired communication restores normal backend targets.

### 3.16 Store navigation (OfficeStoreVM, v2/v3)

`GET /api/v{2,3}/views/office/store?floorId=1&section=mobilier&category=` requires both Store and Office read authority. It returns `{floorId, sectionId, categoryId, sections, categories, floors, itemIds}`. Each control is `{label:LabelRef, options:[{id,label:LabelRef,count:number|null}]}` in backend display order. `categories` is null when the section has no category filter; `floors` is null unless the selected section customizes a floor. `categoryId` is null when the category control is absent. Floor counts are null: no occupant identity/activity is exposed through the catalogue. The section IDs retain existing Store URL vocabulary (mobilier, decoration, personnages, couleurs, accessoires, themes). Invalid section/category/floor selections return 400.

The engine projects installed manifest entries, including lazy packs, into section/category options and ordered filtered item IDs. The VM supplies the current selected IDs and authoritative floor labels/order from the actor-scoped Office projection. An explicitly addressed valid floor is included even if currently empty/unoccupied. The browser sends its selection and renders the controls; it does not derive options, counts, category membership or floor visibility. Layout drafts, dirty navigation confirmation, save/version checks and floor-scoped transport remain the existing Layout API. The frontend uses a guarded one-shot GET (not a new SSE topic) and refreshes it with the Office topic revision. Example: `examples/office-store-vm.json`; v3 uses the same shape.

### OfficePaletteVM — Customize catalogue

`GET /api/v2/views/office/palette?floorId=1&category=&search=` (same v3 path) requires Office read. Bounded selection: valid floor id, category <=64 characters, search <=120. Invalid selections return 400. The engine projects all installed furniture and decoration, including lazy registrations, as `{floorId,categoryId,search,categories:{label:LabelRef,options:[{id,label:LabelRef,count}]},itemIds}`. Empty category means all. Category counts describe the full catalogue; search matches normalized registered names/label/id. The backend owns options, category order, counts, membership and item order. The browser sends selections and maps supplied item IDs to registered display assets only. This static catalogue has no occupant/session data; layout changes retain the existing authenticated floor-scoped write/version API. Examples: `office-palette-vm.json` (v2/v3).

### Project source access display (T-0167)

`ProjectVM.capabilityRows` is an optional backend-ordered collection of `{id, label: LabelRef, valueLabel: LabelRef}`. It describes the effective source/caller/store access after permission projection. Existing scalar `capabilities` remain the command policy flags. Desktop source-access popovers and phone access panes render these rows unchanged; they never infer availability, translate scalar values into labels, or reconstruct row order. An omitted collection renders no rows. Canonical examples: `project-vm.json` and `error-409-project.json`.

`ProjectVM.teamProject.defaultColumnId` optionally supplies the initial phone kanban stage: the first non-empty column in server order, or the first column when all are empty. The client applies this initial scroll position once per team; later user scrolling/selection is presentation state. It never chooses a default by inspecting tasks/counts. `teamProject.mobilePeopleLabel` is an optional backend LabelRef for the short phone action (for example Personnes · 6). Stage chips render the existing column labels/counts and only move the viewport. Canonical navigation fragment (not a standalone VM): `examples/fragments/team-project-navigation.json`; producers assert its two fields against their full TeamProjectVM. Older payloads may omit both; the renderer keeps its natural rail position and existing people label in that case.
