# Data model: canonical types

Status: **contract 2.3** (2026-10-10; additive orchestrator/team types). Model version: `MODEL_VERSION = 1` (unchanged; additions are backward-compatible). Only the architect edits this file.

Every piece of data Agent Office shows is one of the types below. Raw inputs (gateway RPC and events, CLI JSON, `openclaw.json`, Discord REST, GitHub, host metrics) never reach a view: the engine ([engine.md](engine.md)) turns them into these types, or quarantines them. The API ([api.md](api.md)) builds view models only from these types.

Notation is TypeScript. The backend stays plain JavaScript; these definitions are mirrored as JSDoc `@typedef`s in `src/model/types.js` and enforced at runtime by the schema DSL (see engine.md §4).

## 0. Conventions

```ts
type Ms = number;            // epoch milliseconds, UTC. Every field named *At is Ms.
type DurationMs = number;    // non-negative integer. Every field named *Ms is a duration.
type Tokens = number;        // non-negative integer.
type Url = string;           // absolute https URL.
type Slug = string;          // /^[a-z0-9][a-z0-9-]{0,47}$/
type Snowflake = string;     // Discord id, /^\d{17,20}$/. Always a string, never a number.

// Who did something. Used by history, flags, audit and live events.
type ActorRef =
  | { kind: 'human'; personId: PersonId }        // Owner, a Discord user
  | { kind: 'agent'; personId: PersonId }        // Timmy, a sub-agent
  | { kind: 'system'; component: 'engine' | 'risk-monitor' | 'scheduler' };
```

Rules that apply to every type:
- **No `any`, no open records.** Each field has one type. Optional fields are `?:`; a field that can be "known to be absent" is `T | null`, and the doc says what `null` means.
- **No display strings in canonical objects**, except names that come from a source (`name`, `label` from OpenClaw or Discord). French labels for enums live in one dictionary (`src/i18n/fr.js`) and are served by `GET /api/v2/meta`.
- **No relative times** (`"il y a 3 min"`) anywhere on the server. The current API sends `ageLabel` and `lastSeenLabel`; those go away.
- **Ids are opaque strings with a prefix** where Agent Office mints them (`prj_`, `per_`, `evt_`, `lay_`). Ids that come from a source keep the source's value (`AgentId`, `SessionKey`, `CronJobId`, `Snowflake`).
- **Enums are closed.** Where the source can send a value we don't know yet and we must still keep the record, the enum has an explicit `'unrecognized'` member. Producing it always raises a quarantine issue (engine.md §5), so it's counted and visible, never silent.
- **Secrets never enter the model.** The Discord bot token, gateway token and device key stay in the source adapters (engine.md §3.6).

---

## 1. Agent

A configured OpenClaw agent (`agents.list`). Sub-agents and conversations are **not** Agents; they are Sessions and Office occupants.

```ts
type AgentId = string;  // OpenClaw agent id, e.g. 'main'

interface Agent {
  id: AgentId;
  name: string;               // OpenClaw name; display override lives in OfficeLayout.agents
  workspace: string | null;   // absolute path of the agent's workspace; null if not configured
  model: { primary: string; provider: string | null } | null;
  modelSource: 'explicit' | 'inherited' | null; // null = adapter cannot establish provenance
  runtime: string | null;     // external harness id/name; null = native or unknown execution
  spawnedBy?: Lineage | null; // optional, exact adapter/orchestrator evidence only
  isPrimary: boolean;         // exactly one agent has true: id === agents.list defaultId ('main')
  mainSessionKey: SessionKey | null;   // agents.list mainKey (capture 2026-10-05); never hard-code 'agent:main:main'
  fallbackModels: string[];   // model.fallbacks
  personId: PersonId;         // its Person (kind 'agent'), created on first sight
  hostObservations: HostAgentObservation[]; // empty unless exact host/runtime identity evidence links a pane
}
```
- **Source:** `agents.list` (gateway). The raw `model` is a string or `{primary, fallbacks}`; the engine normalises it. The 2026-10-05 capture has two agents, `main` and `claude-code`; the second one owns the ACP sessions.
- **T-0008:** model provenance and external harness identity are adapter-owned, runtime-neutral signals. OpenClaw projects only agent model/runtime settings from its local config; unavailable/invalid config leaves provenance null. `agents.list.modelSource`, when reported, takes precedence. Its effective model alone cannot establish provenance. Optional canonical inputs for older adapters become explicit nulls on admission; AccessVM always carries both fields.
- **Invariants:** ids unique; exactly one `isPrimary`.
- **Lifecycle:** replaced as a whole on every `agents.list` refresh (10 s). An agent missing from a later list is removed and a `LiveEvent` of kind `agent.removed` is emitted.

An identity-linked host observation is metadata only; it never changes the Agent's runtime identity, primary status, transcript, or Person. Host fields are projected only through `orchestrators.read` per ADR-004 §5.2. Pane refs, titles and runtime session refs remain inside their source adapters.

## 14. Orchestrators and teams (ADR-004)

These optional source records are additive to existing runtime data. All source-scoped identifiers become opaque Agent Office IDs before they reach views. Raw paths, report filenames, pane refs, terminal titles, native runtime session refs, team task briefs, review notes and inbox message bodies are excluded from canonical records.

```ts
type HostId = string;
type OrchestratorId = string;
type HostAgentId = string;
type TeamId = string;
type TeamMemberId = string;
type TaskId = string;
type ReviewId = string;
type SourceStatus = 'available' | 'unavailable' | 'unsupported' | 'stale';
type HostAgentStatus = 'working' | 'blocked' | 'done' | 'idle' | 'waiting' | 'unknown';
type HostAgentRole = 'primary' | 'delegate' | 'unknown';
interface Lineage {
  agentId: AgentId | null; sessionKey: SessionKey | null;
  via: string; label: string | null; // bounded, redacted source-provided role/task label
}

interface HostAgentObservation {
  hostAgentId: HostAgentId;
  hostId: HostId;
  runtimeKind: string | null; // open source vocabulary
  role: HostAgentRole;
  status: HostAgentStatus;
}
interface Host {
  id: HostId; label: string | null; // owner-selected, not a machine/user/path default
  platform: 'linux' | 'macos' | 'windows' | 'container' | 'unknown';
  sourceStatus: SourceStatus; observedAt: Ms | null;
}
interface Orchestrator {
  id: OrchestratorId; hostId: HostId; kind: string; // open vocabulary, e.g. 'herdr'
  label: string | null; sourceStatus: SourceStatus; observedAt: Ms | null;
}
interface HostAgent {
  id: HostAgentId; hostId: HostId; orchestratorId: OrchestratorId;
  name: string | null; runtimeKind: string | null; role: HostAgentRole; status: HostAgentStatus;
  observedAt: Ms; staleAfter: Ms;
  spawnedBy?: Lineage | null; // linked from the owner's stable team-member record when known
}
interface IdentityLink {
  hostAgentId: HostAgentId; agentId: AgentId;
  evidence: 'shared-runtime-session-ref' | 'explicit-runtime-identity'; confidence: 'exact';
}
interface Team {
  id: TeamId; storeId: string; label: string; status: 'active' | 'stale'; observedAt: Ms;
}
interface TeamMember {
  id: TeamMemberId; teamId: TeamId; name: string; roleKind: 'lead' | 'member' | 'unknown';
  roleLabel: string | null; // bounded, source-native display label; never used for authorization or core branching
  roleEvidence: 'explicit' | 'derived-from-structure' | 'unknown';
  sourceAgentName: string | null; hostAgentId: HostAgentId | null; parentMemberId?: TeamMemberId | null;
  status: 'active' | 'inactive' | 'unknown';
  spawnedBy?: Lineage | null;
}
interface Task {
  id: TaskId; teamId: TeamId; title: string; state: 'open' | 'claimed' | 'working' | 'review' | 'done' | 'blocked';
  priority: 0 | 1 | 2 | 3 | null; ownerMemberId: TeamMemberId | null; reviewerMemberIds: TeamMemberId[];
  createdAt: Ms | null; updatedAt: Ms | null; commit: string | null;
  reportPresent: boolean; briefPresent: boolean; messageCount: number;
}
interface Review {
  id: ReviewId; taskId: TaskId; reviewerMemberId: TeamMemberId | null;
  verdict: 'go' | 'no-go' | 'pending' | 'unknown'; createdAt: Ms | null; reportPresent: boolean;
}
interface TeamMessage {
  id: string; teamId: TeamId; taskId: TaskId | null; fromMemberId: TeamMemberId | null;
  toMemberId: TeamMemberId | null; createdAt: Ms | null; bodyPresent: boolean;
}
```

The runtime adapter privately reconciles host pane observations to exactly one canonical `AgentId` using `(host, normalized runtime kind, exact stable runtime session reference)` or an explicit adapter-mapped runtime identity. The source references are compared inside the adapter and never stored in `IdentityLink`. Name, cwd, workspace, terminal title and pane proximity are not identity. A missing/ambiguous match leaves the HostAgent unlinked; multiple panes may link to one Agent without merging their Sessions or transcripts. Host observations are separate from the runtime Agents collection.

`Lineage` names one known spawner by canonical agent and/or session ID; unknown lineage is absent/null. Adapters scope native references through their runtime instance. For `agent-team-pm`, stable `members/<name>.json` IDs are authoritative: a child’s `spawnedBy` member ID resolves to that member record’s exact `herdrPane`, then to the parent’s exact runtime session/agent reference. Names are display metadata and never participate in pane/runtime identity reconciliation. Herdr session values, pane IDs, and member source references stay private; only canonical scoped IDs and closed lineage metadata are projected to authorized views.

Task/review report paths are private resolver state and are not canonical fields. Canonical tasks/reviews expose `reportPresent`; an authorized `teams.report.resolve` operation may use a short-lived opaque reference with a generic label. The raw basename/path stays private, is contained under the explicitly configured root, and is revalidated at resolution. Team message and brief bodies are metadata-only (`bodyPresent` / `briefPresent`) in v1.

## 2. Session

One OpenClaw conversation context (`sessions.list`, `sessions.describe`).

```ts
type SessionKey = string;   // OpenClaw key, opaque, e.g. 'agent:main:main'

// G3b (ADR-001 §4.2, §12.3): the CANONICAL kinds are generic. The 2.x wire still says main, cron, chat-direct and
// chat-group: src/api/v2/project2x.js maps primary→main, scheduled→cron, conversation-direct→chat-direct,
// conversation-group and conversation→chat-group (and the logs ?kind= filter back).
type SessionKind =
  | 'primary'           // the agent's main session (isMain / agents.list mainKey)   [2.x: 'main']
  | 'dashboard'         // Control UI / dashboard chat ('…:dashboard:<uuid>'); 50 of 175 sessions in the capture
  | 'subagent'          // spawned sub-agent run ('…:subagent:<id>'; subagentRole, spawnedBy, parentSessionKey)
  | 'scheduled'         // isolated cron session ('…:cron:<jobId>')                    [2.x: 'cron']
  | 'conversation-direct' // a direct conversation on ANY channel: '…:<channel>:direct|dm:<peer>'   [2.x: 'chat-direct']
  | 'conversation-group'  // group/channel/room/thread/slash on any channel                         [2.x: 'chat-group']
  | 'conversation'        // chat-shaped key ('…:<channel>:<scope>:<peer>') with a scope we don't know [2.x: 'chat-group']
  | 'acp'               // ACP session of a coding agent ('agent:claude:acp:<uuid>')
  | 'explicit'          // caller-chosen key ('…:explicit:<key>'); the Discuter page's 'portal-chat' is expected here
  | 'unrecognized';     // see Conventions; always quarantined as 'session.unclassified'
// Heartbeats are NOT a kind: '<base key>:heartbeat' is a background variant of another session
// (main, dashboard, discord direct/channel in the capture) → SessionClassification.heartbeatOf.

interface SessionClassification {
  kind: SessionKind;
  ruleId: string;                 // which classifier rule matched (engine.md §6.1), for debugging
  agentId: AgentId | null;        // parsed from 'agent:<id>:…'
  subagentId?: string;            // kind 'subagent'
  cronJobId?: CronJobId;          // kind 'scheduled'
  interlocutorId?: InterlocutorId;// conversation-direct/-group: Discord 'discord-user:<sf>' | 'discord-channel:<sf>' (unchanged);
                                  // any other channel '<channel>-user:<peer>' | '<channel>-room:<peer>' (peer opaque, 1–128 chars)
  channel: ChannelRef | null;     // from the KEY grammar (openclaw-weixin/weixin → 'wechat'); null for internal kinds
  heartbeatOf: SessionKey | null; // set when the key ends in ':heartbeat'
  background: boolean;            // raw isBackground
  rawClassification: string | null; // raw `classification` (9 values; enumerated after the next capture)
}

interface Session {
  key: SessionKey;
  sessionId: string | null;       // OpenClaw's internal id when sent
  spawnedBy?: Lineage | null;     // exact adapter-normalized creator; null/absent means unknown
  class: SessionClassification;
  displayName: string | null;     // from sessions.describe; null until described
  model: { id: string; provider: string | null } | null;   // id required: a provider without a model id gives model null
  provider: string | null;        // raw modelProvider, kept even when there is no model id (S3.1)
  usage: { total: Tokens; input: Tokens | null; output: Tokens | null };
  updatedAt: Ms | null;
  run: RunState;                  // see §3
  costUsd: number | null;         // estimatedCostUsd
  parentKey: SessionKey | null;   // parentSessionKey ?? spawnedBy
  childKeys: SessionKey[];        // childSessions
  goal: { objective: string; status: string; tokensUsed: Tokens; tokenBudget: Tokens | null } | null;
  cwd: string | null;             // 2.1 (PM): raw workspaceDir, else spawnedCwd; normalised: absolute POSIX only, dot segments
                                  // resolved, no trailing '/', control characters → null. projects' linker uses it
  messageCount: number | null;    // 2.1 (PM): raw messageCount, else contextBudgetStatus.messageCount (2026.9.8 rows), else null
  interactive: boolean;           // derived: kind in {subagent, cron, chat-*, dashboard, explicit} and not heartbeatOf
  group: SessionGroupId | null;   // S7b: the runtime's session group (OpenClaw: the row's `category`, a sessions.groups.list name)
  channelName?: string | null;    // architect-54: the room's name as the runtime shows it (OpenClaw: `groupChannel`, '#PIVOT-2735'); project inference only
  label?: string | null;          // architect-54: the session's label (a spawn's or an operator's); project inference only
}
// S7b: the runtime's session-group catalog (OpenClaw sessions.groups.list, read scope, path-free; capability sessionGroups).
interface SessionGroup { id: SessionGroupId; name: string; position: number }   // display order = position; members: Session.group === id
// SessionGroupId: the runtime's stable group id, opaque, 1–200 chars. OpenClaw 2026.9.8 keys its catalog by name (no id
// column), so there id === name, and a RENAME yields a new id (the old one disappears from the catalog).
// engine.sessionGroups() → { id, name, position, sessionKeys, lastActivityAt }[] | null (null until the catalog is read).
// Refreshed on connect, every 60 s, and after a catalog-only sessions.changed ({reason: 'groups'}, no sessionKey).
```
- **Replaces `classifySession()`'s regexes** (server.js:157). Classification is a declared, ordered rule table with fixtures for every rule (engine.md §6.1). The 2026-10-05 capture confirmed structured fields: `isMain`, `kind` (`direct`/`group`), `channel`, `classification`, `isBackground`, `subagentRole`, `spawnedBy`/`parentSessionKey` and `origin.*` ([capture-findings.md](capture-findings.md)). Rules read those first and the key grammar second.
- **Heartbeats:** today `isHeartbeatKey()` lumps heartbeats and `main` together for "is working" checks. Heartbeats are now a variant (`heartbeatOf`) of their base session, and "never shown as working" applies to them in the occupant builder. `main` is a normal kind. A heartbeat is classified with its **base row's** structured evidence when the base is known (never with its own `isMain`).
- **Structured fallback sub-agents** (rule `subagent-role`, no `subagent:` key segment) get `subagentId` = the key without its `agent:<id>:` prefix, so two of them stay distinct (S3.1).
- **Invariants:** `key` unique; `class.kind === 'unrecognized'` ⇔ an open quarantine issue exists for that key; usage, durations and cost ≥ 0 (negative raw counts are rejected at the schema). Every normalised Session is validated at runtime against this contract (`src/engine/model/session.js`); a violation is quarantined (`$.canonical.*`) and the session is not admitted.
- **Lifecycle** (S3.1, review R2-02/R2-05):
  - **Snapshots:** the poller walks every page (`hasMore`/`nextOffset`). Rows are upserted as pages arrive. A session is **removed only when a complete snapshot** (every page, in order, starting at offset 0) doesn't contain it. A failed, rejected, out-of-order or stalled page invalidates the snapshot, so nothing is deleted from it.
  - **Descriptions:** `sessions.describe` results merge into the canonical Session. The more recently *received* of list row and description wins field by field (arrival order, not wall-clock time), and the other fills gaps, so a described `displayName` survives later lists without one. Timestamps (`updatedAt`, `lastActivityAt`, `lastInteractionAt`) never move backwards. A description received before the session is listed is applied when it appears.

### 2.1 Transcript

The trace of one session (`sessions.get`). Today `buildTrace()` (server.js:618) does this with permissive `||` chains; the engine does it with a schema per message role.

```ts
// 2.1 (PM, on frontend-03): every TraceEvent has a stable id 'ev:<messageIndex>:<partIndex>' — the index of the raw message
// in the full transcript (not the window) and of the part inside it (0 for single-part messages) — so appends are upserts.
type TraceEvent = { id: string } & (
  | { kind: 'system';    at: Ms; text: string; truncated: boolean }
  | { kind: 'thinking';  at: Ms; text: string; truncated: boolean }                 // assistant 'thinking' parts
  | { kind: 'observation'; at: Ms; text: string; truncated: boolean }              // 'observation' parts (meaning to confirm)
  | { kind: 'user';      at: Ms; sender: string | null; text: string; truncated: boolean }
  | { kind: 'subagent-result'; at: Ms; senderInfo: Sender; title: string | null;
      status: 'completed' | 'failed' | 'running' | 'unknown'; body: string; text: string; truncated: boolean } // verified delegated output; Markdown is preserved
  | { kind: 'assistant'; at: Ms; model: string | null; provider: string | null; outputTokens: Tokens | null; text: string; truncated: boolean;
      stopReason: 'stop' | 'toolUse' | 'error' | 'unrecognized' | null; error: string | null }   // errorMessage
  | { kind: 'tool';      at: Ms; callId: string; name: string; toolKind: ToolKind;
      input: string; output: string; isError: boolean; durationMs: DurationMs | null; truncated: boolean } );

type ToolKind = 'search' | 'web' | 'browser' | 'exec' | 'file-read' | 'file-write' | 'memory' | 'message' | 'image' | 'other';

interface Transcript {
  sessionKey: SessionKey;
  fetchedAt: Ms;
  messageCount: number;      // raw message count before the 120-message window
  window: { from: number; to: number };
  events: TraceEvent[];      // transcript (sequence) order; timestamps can step backwards (seen in capture-20261005)
}
```
- **Raw content part types in the capture:** `text`, `thinking`, `toolCall`, `observation`, `openai_responses_terminal`, `agent`. Legacy `buildTrace` drops all but `text` and `toolCall`. `openai_responses_terminal` and `agent` parts map to `assistant` metadata until the next capture shows their content; any other type raises `enum.unmapped`.
- `ToolKind` replaces the frontend's `TOOLICON` substring table (app.js:42); the icon is chosen by kind on the client. `'other'` is a real member here (an unknown tool name is normal, not a data error), so it raises no issue.
- Not cached in the registry. It's fetched on demand and cached for 30 s per key.

## 3. Run and Activity

```ts
type RunStatus = 'unknown' | 'idle' | 'running' | 'succeeded' | 'failed';

interface RunState {
  status: RunStatus;
  startedAt: Ms | null;
  endedAt: Ms | null;
  hasActiveSubagentRun: boolean;
  evidence: 'gateway-flag' | 'status-field' | 'start-without-end' | 'live-activity' | 'none';
  evidenceLevel?: 'verified' | 'observed' | 'unknown';
  observedAt?: Ms | null;
  expiresAt?: Ms | null;
}
```
- **Derivation**: `hasActiveRun` or `hasActiveSubagentRun` → running/`gateway-flag`; raw `status` in a mapped set → that status/`status-field`; `startedAt && !endedAt` → observed running/`start-without-end` with a bounded lease; absent lifecycle evidence → unknown/`none`. An expired observation becomes unknown and never implies idle or completion.
- The status table is read with **own-property** lookups (a status like `constructor` is unmapped, not inherited), and an unknown status is reported even when a gateway flag decides the state (S3.1).
- **Raw `status` values** (capture 2026-10-05): `done`, `complete`, `failed`, `active`, `killed`, `timeout`, `budget_limited`. They're mapped by table:
  - `active` → running;
  - `done`, `complete` → succeeded;
  - `failed`, `timeout`, `killed`, `budget_limited` → failed, with `endReason` set to the raw value.

  An unmapped value raises `enum.unmapped` and the rule falls through.
- `RunState` also gains `endReason: 'error' | 'timeout' | 'killed' | 'budget-limited' | null`, `runtimeMs: DurationMs | null`, `lastRunId: string | null` and `lastError: string | null`.

**Activity on OpenClaw 2026.9.8 (C1, from capture-20261005-active).** During a live run, the gateway sent **no** `session.tool`, `session.message`, `session.operation` or `agent` events. The only events were `sessions.changed`, `chat.metadata.changed`, `health` and `tick`. The legacy live-activity path (handleGwEvent → liveActivity → office animations) therefore never fires in production.
- `sessions.changed` carries the **full session row** (keyed `sessionKey`), plus `reason` and `activitySummary {state, updatedAt, canEnsure, text}`. The engine upserts the session from it immediately (no deletion; only complete snapshots delete, §2).
- **Activity is derived from the run state,** not from per-tool events:

```ts
type ActivityKind = 'thinking' | 'writing' | 'calling' | 'researching' | 'working';   // kept for forward compatibility

interface Activity {
  sessionKey: SessionKey;
  kind: ActivityKind;              // 2026.9.8: always 'working' (no finer signal exists)
  source: 'run-state' | 'event';   // 'run-state' today; 'event' only if a future OpenClaw sends per-tool events
  since: Ms;                       // run.startedAt, else the sessions.changed time
}
```
- **Rule:** a session whose canonical `run.status === 'running'` has Activity `{kind: 'working', source: 'run-state'}`. It ends when the run ends (`sessions.changed` with an end, or the next snapshot). There's no TTL guesswork.
- **Office consequence:** on 2026.9.8 the office shows `working`, `idle`, `error` and `offline` from real data. `thinking`, `writing`, `calling` and `researching` have no source. They stay in the union (and in the art) for a future protocol and are never invented.
- **Option for a PM decision (not built):** infer a finer kind from the transcript tail of a running session (last part `thinking` / `toolCall` / `text`) by polling `sessions.get` (rate-limited, e.g. every 5 s, only while running). It's more traffic, and the inference is heuristic.
- **Open (capture tooling fixed in C1):** that capture kept only 2 `sessions.changed` events, because its sampling grouped events by a too-coarse signature, so the run-start event may simply be missing from the fixture. The capture script now samples by `type|kind|operation|tool|status|reason|activitySummary.state|hasActiveRun` (up to 4 per signature, 16 per event). The `reason` vocabulary stays scrambled under R1-02's default-deny; ask for a reviewed exception if it's needed.
- The `(event, type)` mapping table of engine.md §6.2 is withdrawn. Unknown event names are still quarantined generically as `event.unknown`; no event-specific placeholders remain.

## 4. OfficeOccupant

Who is on stage in the office, where, and in what state. The server decides this; the client only animates it.

```ts
type AgentState = 'unknown' | 'observed' | 'idle' | 'thinking' | 'working' | 'researching' | 'writing' | 'calling' | 'waiting' | 'error' | 'offline';
// The nine animated states map 1:1 to --bu-state-* tokens and poses; unknown/observed are confidence labels, not poses.

type OccupantRole = 'primary' | 'agent' | 'subagent' | 'scheduled' | 'direct' | 'group' | 'conversation' | 'session';   // canonical (G3b); session is an OfficeVM display role for channel-less runtime sessions
// SessionKind → role: primary→primary, subagent→subagent, scheduled→scheduled, conversation-direct→direct,
// conversation-group→group, conversation→conversation. Occupant id 'primary' (else '<role>:<subject>').
// 2.x wire and layout.schema.json agents[].match.kind (project2x): primary→main, scheduled→cron, direct→dm,
// group and conversation→channel; ids get the projected role prefix ('scheduled:j' → 'cron:j').
// dashboard / explicit / acp sessions add no occupant: their activity is attributed to the owning agent.

type OccupantCue = 'delegating' | 'talking' | 'celebrating';           // transient, sent as SSE 'cue' events, never stored

// Peers: agent:<agentId> (role agent). Delegates: subagent:<subjectId>; identities never overlap.
type OccupantId = string;   // 'main' | `${role}:${subjectId}`, e.g. 'subagent:4f2a…', 'dm:1234…'

interface OfficeOccupant {
  id: OccupantId;
  role: OccupantRole;
  personId: PersonId;
  name: string;                 // after layout override (OfficeLayout.agents[].name), else source name
  roleLabelKey: string;         // i18n key, e.g. 'occupant.role.subagent' → « Sous-agent »
  state: AgentState;
  stateSince: Ms;
  sessionKey: SessionKey | null;
  stationUid: string | null;    // OfficeLayout item uid this occupant sits at; null = overflow, no free eligible station (§12)
  look: { character: string; variant: string | null; accessories: string[] };  // resolved from layout rules
  tokens: Tokens;
  lastSeenAt: Ms | null;
  order: number;                // roster order; main = 0
}
```
- **Who:** the main agent always; plus one occupant per *interactive* session that is running now, deduplicated by `(role, subjectId)`, newest first, capped at the number of stations (today 7, from `DESKS`).
- **Also on stage:** a session that **failed in the last 60 s** stays in `error` (S3.1).
- **State derivation** (replaces the `w.base` code in `buildRoster()`), in order:
  1. gateway disconnected → `offline`;
  2. run failed in the last 60 s → `error` (main included; this beats activity recorded before the failure);
  3. a live Activity → its kind;
  4. main with other occupants on stage, or a running run → `working`, plus a one-shot `delegating` cue when a new sub-agent appears;
  5. non-main → per-role default (subagent `working`, dm/channel `writing`, cron `researching`);
  6. else `idle`.
- **Internal sessions:** `dashboard`, `explicit` and `acp` sessions of the main agent add no occupant. Their live activity and running state are attributed to the main occupant (S3.1).
- **Not states:** `talking`, `delegating`, `celebrating` are cues; 15 of the old 25 `STATES` in office.js (`coffee`, `printing`, `dancing`…) were decorative and are dropped.
- **Invariants:** exactly one `role: 'main'`; `stationUid` unique among occupants and present in the active layout; `order` is a permutation of `0..n-1`.
- **Lifecycle:** recomputed after every registry change (debounced 250 ms). An occupant that leaves is kept for `OCCUPANT_LINGER_MS = 8000` in state `idle` so the client can play an exit, then removed.

## 5. CronJob and CronRun

```ts
type CronJobId = string;

type CronSchedule =
  | { kind: 'cron'; expr: string; tz: string | null }
  | { kind: 'every'; everyMs: DurationMs; anchorAt: Ms | null }      // raw everyMs, anchorMs
  | { kind: 'at'; at: Ms }                                          // raw ISO string
  | { kind: 'unrecognized'; rawKind: string };

type SessionTarget = 'isolated' | 'main' | 'unrecognized';
type WakeMode = 'now' | 'next-heartbeat' | 'unrecognized';
type CronPayload =
  | { kind: 'agent-turn'; message: string; timeoutSeconds: number | null; model: string | null; toolsAllow: string[] | null; lightContext: boolean }  // raw 'agentTurn'
  | { kind: 'heartbeat' }
  | { kind: 'command'; argv: string[] }
  | { kind: 'unrecognized'; rawKind: string };
type CronDelivery = { mode: 'none' | 'announce' | 'unrecognized'; channel: ChannelRef | 'last' | null; to: string | null };

interface CronJob {              // executable contract: src/engine/model/canonical.js (S4)
  id: CronJobId;
  name: string;                  // displayName ?? name
  description: string;           // '' when absent (the field is optional in OpenClaw)
  enabled: boolean;
  schedule: CronSchedule;
  agentId: AgentId;
  sessionTarget: SessionTarget | null;
  wakeMode: WakeMode | null;
  payload: CronPayload | null;
  delivery: CronDelivery | null;
  steps: string[];               // derived from an agent-turn message (was cronSteps() in app.js); [] otherwise
  createdAt: Ms | null;
  updatedAt: Ms | null;
  nextRunAt: Ms | null;
  lastRunAt: Ms | null;
  lastRunStatus: CronRunStatus | string | null;     // a CronRunStatus when mapped; the RAW value while the vocabulary is unconfirmed (info issue)
  lastRunError: string | null;
  lastDeliveryStatus: DeliveryStatus | string | null; // mapped (table below); an unknown raw value is kept raw (info issue)
  deleteAfterRun: boolean;
  sessionKey: SessionKey | null;
  health: 'ok' | 'failing' | 'never-run';           // failing ⇔ lastRunStatus 'failed'; never-run when no run is known
}

type CronRunStatus = 'succeeded' | 'failed' | 'skipped' | 'running' | 'unrecognized';
type DeliveryStatus = 'delivered' | 'not-delivered' | 'skipped' | 'none';
// raw delivered → delivered, not-delivered → not-delivered, not-requested → none, skipped → skipped (confirmed S4 staging, 2026-10-05)

interface CronRun {              // executable contract: src/engine/model/canonical.js (S4)
  id: string;                    // raw runId when present (capture: on some entries), else `${jobId}@${at}`
  jobId: CronJobId;
  sessionKey: SessionKey | null;
  at: Ms;                        // raw runAtMs, else ts
  action: string | null;         // raw action, passed through
  status: CronRunStatus;         // raw ok → succeeded, error → failed, skipped, running; else unrecognized (warn)
  completionStatus: string | null;   // raw, vocabulary unconfirmed (info issue)
  durationMs: DurationMs | null;
  nextRunAt: Ms | null;
  model: { id: string | null; provider: string | null } | null;
  usage: { total: Tokens; input: Tokens; output: Tokens } | null;
  delivery: { status: DeliveryStatus | string | null /* mapped; unknown raw kept */; delivered: boolean | null; channel: string | null /* may be 'last' */ };
  summary: string;               // summary ?? diagnostics.summary ?? ''
  error: string | null;
}
// Runs are newest first.
type CronRunSummary = Pick<CronRun, 'at' | 'status' | 'durationMs'>;
```
- `humanCron()` (server.js:337) becomes the API's job: the schedule stays structured here, and the French sentence (*chaque lundi à 09:00*) is rendered by the view model.
- **Raw values confirmed by the 2026-10-05 capture:**
  - run `status` `ok`/`error` → succeeded/failed; `action` `finished`;
  - `sessionTarget` `isolated`/`main`;
  - `wakeMode` `now`/`next-heartbeat`;
  - `delivery.mode` `none`/`announce`.

  - delivery status (job `lastDeliveryStatus`, run `deliveryStatus`): `delivered`, `not-delivered`, `not-requested`, `skipped` (S4 staging and the active capture).

  `completionStatus` and `lastRunStatus` values were scrambled and are enumerated after the next capture. The mapping tables start with the values above, and anything else is counted.
- The French schedule sentence must cover `every` (*toutes les 30 min*) and `at` (*le 6 oct. à 13:00*). Legacy `humanCron` returns `''` for both.
- **Lifecycle:** jobs replaced on `cron.list` refresh and on every `cron` gateway event; runs fetched on demand (`cron.runs`, newest 25) and on a `cron` event for that job, cached 60 s.

## 6. Skill

```ts
type SkillSource = 'bundled' | 'extra' | 'workspace' | 'workshop' | 'custodian' | 'unrecognized';
// raw 'openclaw-<x>' (capture: bundled 49, workspace 9, workshop 8, extra 5, custodian 4); catOf() in app.js knew only 3

type SkillStatus = 'active' | 'disabled' | 'unavailable';  // statOf() in app.js, moved to the server

interface Requirements { bins: string[]; anyBins: string[]; env: string[]; config: string[]; os: string[] }

interface Skill {                // executable contract: src/engine/model/canonical.js (S4)
  name: Slug;
  emoji: string | null;
  description: string;
  source: SkillSource;
  rawSource: string | null;     // the raw 'openclaw-…' value, for diagnostics
  bundled: boolean;
  status: SkillStatus;          // disabled ? 'disabled' : eligible ? 'active' : 'unavailable'
  visibility: { model: boolean; command: boolean; user: boolean };
  homepage: Url | null;         // canonical bounded HTTP(S); api.md §3.7 (list or info metadata)
  missing: Requirements | null; // not in `skills list` items (capture); only `skills info` has it
}
// `skills info` → SkillInfo, kept per name in the engine (engine.skillInfo(name)), on demand:
interface SkillInfo {
  name: Slug; filePath: string | null; always: boolean; source: SkillSource;
  blockedBy: { allowlist: boolean; agentFilter: boolean; platform: boolean };
  requirements: Requirements | null; missing: Requirements | null;
  install: { id: string; kind: string; label: string; bins: string[] }[];
  homepage: Url | null;         // same navigation policy as Skill.homepage
}
// The SKILL.md body, front matter and the derived flow (steps/outputs) are VIEW data: SkillDetailVM (api.md §3.7)
// reads the file at render time, with realpath containment (R1-11, S7).
type SkillOutputKind = 'files' | 'message' | 'tool-actions' | 'agent-reply';
```
- **Source:** `openclaw skills list --agent main --json` (120 s) and `skills info <name> --agent main --json` (on demand, 30 s cache). Both **must** pass `--agent main` (CLAUDE.md gotcha); the adapter enforces it.
- **Invariant:** `status` is derived and never stored. A toggle is a command (api.md §5), not a field write.

## 7. Channel

```ts
type ChannelRef = string;   // G3b (ADR §12.3): any adapter-normalised slug /^[a-z][a-z0-9-]{0,31}$/ (discord, telegram, slack, matrix…);
                            // 'unrecognized' only for a raw id that isn't a slug. Canonical Session.class.channel, Channel.id,
                            // CronDelivery.channel are ChannelRefs.
type ChannelId = 'discord' | 'whatsapp' | 'wechat' | 'unrecognized';   // the 2.x WIRE union (project2x.channelId: any other ref → 'unrecognized')
// Aliases: channels.status says 'openclaw-weixin', session keys say 'wechat' (capture) → 'wechat'. Labels: Discord, WhatsApp, WeChat.
// Superseded in G3b (ADR §12.3; was S3.1/R2-07): chat keys on ANY channel classify, with no issue; only the 2.x wire
// shows a channel outside this union as 'unrecognized' (Health cards keep the id 'raw:<rawId>').

type ChannelHealth = 'connected' | 'running' | 'stopped' | 'error' | 'not-configured';

interface Channel {
  id: ChannelId;
  rawId: string;                 // the key in channels.status, kept for 'unrecognized'
  label: string;                 // channels.status channelLabels[id]
  configured: boolean;
  health: ChannelHealth;         // derived: !configured → not-configured; lastError → error; connected → connected; running → running; else stopped
  lastError: string | null;
  lastStartAt: Ms | null;
  lastInboundAt: Ms | null;
  accounts: ChannelAccount[];
  policy: { dm: string | null; group: string | null };  // from openclaw.json (Discord only today)
}

interface ChannelAccount {
  accountId: string;
  enabled: boolean;
  lifecycle: 'ready' | 'stopped' | 'running' | 'starting' | 'stopping' | 'unrecognized' | null;   // ready/stopped seen; others reserved; unknown → info issue
  busy: boolean;
  activeRuns: number;
  lastInboundAt: Ms | null;
  lastOutboundAt: Ms | null;
  bot: { id: Snowflake; username: string } | null;
}
```
- `channels.status` also returns `eventLoop`; the engine routes it to `HealthSnapshot`, not here.
- `tokenSource`/`tokenStatus` are dropped on ingestion (they describe secrets and aren't needed).

## 8. Interlocutor

A human or place Timmy talks to on Discord.

```ts
type InterlocutorId = `discord-user:${Snowflake}` | `discord-channel:${Snowflake}`;

type DiscordChannelType = 'text' | 'dm' | 'voice' | 'group-dm' | 'category' | 'announcement'
  | 'announcement-thread' | 'public-thread' | 'private-thread' | 'stage' | 'forum' | 'unrecognized';
// from the numeric type (CHTYPE in server.js:181)

interface DiscordUserProfile {
  id: Snowflake; username: string | null; globalName: string | null;
  displayName: string | null;     // globalName ?? username
  isBot: boolean; avatarUrl: Url | null; createdAt: Ms;   // createdAt from the snowflake
}
interface DiscordChannelProfile {
  id: Snowflake; name: string | null; type: DiscordChannelType; topic: string;
  guild: { id: Snowflake; name: string | null } | null; parentId: Snowflake | null;
  nsfw: boolean; createdAt: Ms;
}

type Interlocutor = {
  id: InterlocutorId;
  personId: PersonId | null;      // users only
  resolution: 'pending' | 'resolved' | 'failed';
  stats: { sessionCount: number; totalTokens: Tokens; firstSeenAt: Ms | null; lastSeenAt: Ms | null };
  primarySessionKey: SessionKey | null;   // most recently updated
} & (
  | { kind: 'discord-user';    profile: DiscordUserProfile | null;    access: { policy: string | null } }
  | { kind: 'discord-channel'; profile: DiscordChannelProfile | null; access: { policy: string | null; enabled: boolean | null; requireMention: boolean | null } }
);
```
- **Created** when a conversation session with an interlocutor id is classified: on Discord (bare snowflakes), and since G3b on any channel (`<channel>-user:` / `<channel>-room:`). **2.x shows Discord's only** (InterlocutorVM.kind is closed); other families are 3.0. Only Discord has an enricher; others keep the generic cache profile `{displayName, avatarUrl}`. **Resolved** by the Discord adapter (rate-limited, 120 ms spacing as today) and cached in the store (`interlocutor_cache`) so a restart doesn't refetch everything. `failed` is retried after 1 h.
- **Invariant:** `stats` is always derived from the Sessions with that `interlocutorId`; never stored.

## 9. Projects

### 2.2 ProjectHint (architect-54)
The project tag: a no-op tool call the agent makes (`projet.js tag <slug> <statut> <P0-P9> ["titre"] [note]`, see `docs/guide/project-tag.md`). The adapter finds it in a transcript's tool events, never in message text (`definition.projectHints(transcript)`, OpenClaw: `src/adapters/openclaw/project-hint.js`). The engine keeps each session's last 20, merged across reads, and serves them as `engine.projectHints()`. They are not in any view.
```ts
interface ProjectHint {
  sessionKey: string; id: TraceEventId; at: Ms | null;
  slug: string;                                   // [a-z0-9][a-z0-9-]{1,63}
  status: ProjectStatus | null;                   // idee | a-faire | en-cours | en-revue | livre → idea … shipped
  statusIssue: 'unknown' | null;                  // a status outside the vocabulary (never its value)
  priority: 'P0' | … | 'P9' | null;               // the board's own scale
  title: string | null;                           // ≤ 80 code points: a new project's name
  note: string | null;                            // ≤ 200 code points
}
```

### 9.1 Project

```ts
type ProjectId = `prj_${string}`;
type ProjectStatus = 'idea' | 'todo' | 'in-progress' | 'in-review' | 'shipped';
// UI: Idée → À faire → En cours → En revue → Livré; the same keys are used by data-project-status in the design
type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9';   // P0 the most urgent and important (architect-55)

interface Project {
  id: ProjectId;
  name: string;                    // 1..80 chars
  status: ProjectStatus;
  priority: Priority;
  summary: string;                 // markdown, ≤ 4000 chars, may be ''
  summaryMeta: { author: ActorRef; at: Ms } | null;
  sources: ProjectSource[];
  repo: Repo | null;               // derived from the first github source
  flags: Flag[];                   // stored label/risk/feature flags + the derived priority flag
  people: ProjectPerson[];         // derived (§9.5) + manual overrides
  lastActivityAt: Ms;              // max(at) over MEANINGFUL history kinds only (below); createdAt if none
  createdAt: Ms;
  revision: number;                // optimistic concurrency; rules below (R3-04)
  repoStatus: { state: 'pending' | 'ok' | 'error'; lastAttemptAt: Ms | null; lastError: SourceErrorCategory | null } | null;   // null iff no github source (R3-20)
  archivedAt: Ms | null;
}
```
History is not a field of `Project`; it is queried (`HistoryEvent` by `projectId`, paged), because it grows without bound.

- **Invariants:**
  - exactly one flag of kind `priority`, equal to `priority`, derived, never stored;
  - at most one flag per `(kind, key)`;
  - `repo !== null` ⇒ at least one `github` source and `repoStatus.state === 'ok'`. With a github source, `repo` is `null` until the first successful fetch (`repoStatus.state` is `'pending'`, or `'error'` if every attempt failed). The VM shows « Dépôt lié, récupération en cours… » (R3-20, PM decision on projects-01). After a later failed refresh, `repo` keeps the last good data and `repoStatus.state` is `'error'`;
  - every user/agent command writes its history events in the same transaction (§9.6 table);
  - `revision` strictly increases.
- **Revision (R3-04; adopts projects.md):**
  - starts at 1 on create;
  - **+1 per committed command transaction that changes something**, however many fields or events it writes (a compound PATCH is +1);
  - a no-op is +0 with no history;
  - user/agent commands must present `expectedRevision`;
  - the risk monitor is +1 when the card changes;
  - activity ingestion and repo/workspace/session caches are **+0** and never check a revision;
  - 2.1: the feature-flag scanner (`replaceFeatureFlags`) is +1 when the key/state set changes and never checks a revision, like the risk monitor; Timmy's `appendHistory` checks `expectedRevision` but is +0 (a note never 409s a drag).
- **Meaningful activity (R3-06):** `lastActivityAt` = the max `at` over these history kinds only:
  - `project-created`, `renamed`, `priority`, `summary-edited`, `status`, `source-linked` and `source-unlinked`, and `flag-added` / `flag-removed` **for a label only** (2.1, from projects: setting or removing Bloqué is risk bookkeeping) (user/agent commands; `at` = command time);
  - `commit`, `flow-run`, `cron-run`, `session` and `agent-action` (ingested, at their own event time).

  `risk-raised`, `risk-cleared`, `risk-acked`, `risk-unacked`, `archived`, `restored`, `people-override` and `flags-updated` **never** move it, so the `stale` risk can't reset itself, and bookkeeping doesn't reorder cards.
- **Lifecycle:** `created` (manual, or proposed from a source and accepted) → status moves in any direction (drag and drop, or Timmy later through the API) → `archived` (hidden from the board, kept with history). No hard delete from the UI.
- **Card order** (computed by the view model, never stored): priority P0 → P9, then `lastActivityAt` descending, then `id`.

### 9.1.1 Generated cover (view enrichment, covers-1)

The project/card VM carries `cover: null | {url, thumbUrl, source: 'agent'|'code'|'upload', generatedAt: Ms}`.
It is persisted by the cover engine in the instance data directory, separate from canonical project
revision/history. `upload` is the explicit manual override and wins over automatic generation.
The full image is 480×270 (≤25 KiB); the thumbnail is 160×90 (≤6 KiB). Code covers are self-contained SVG;
agent/upload covers are normalized WebP when a local rasterizer is available. Generated covers supersede
the monogram in the VM (`thumb.kind: 'cover'`), and mobile cards consume `cover.thumbUrl`.
See `projects.md` → Project covers for the engine, queue, capability discovery and media API.

### 9.2 ProjectSource

```ts
type ProjectSource = { id: `src_${string}`; addedAt: Ms; addedBy: ActorRef } & (
  | { kind: 'github';       ref: { owner: string; repo: string } }            // alexdeg92/* chosen by the user
  | { kind: 'workspace';    ref: { path: string } }                           // relative to the main agent's workspace; no '..'
  | { kind: 'sessionGroup'; ref: { by: 'interlocutor'; interlocutorId: InterlocutorId }
                               | { by: 'keys'; sessionKeys: SessionKey[] } }
  | { kind: 'manual';       ref: null }
);
```
- **Invariants:** `(kind, ref)` unique per project; a github `(owner, repo)` belongs to at most one non-archived project (case-insensitive); `workspace.path` must resolve inside the workspace.
- **`ProjectSourceInput`** (R3-12, the API request type) is the same union without `id`, `addedAt` and `addedBy`. The server mints those from the authenticated actor and its clock, and never accepts them from a client.

### 9.3 Repo

```ts
interface Repo {
  url: Url;
  owner: string; name: string;
  defaultBranch: string;
  image: { kind: 'opengraph' | 'screenshot' | 'generated'; url: Url | null };  // generated → client draws the cover from id
  ci: { state: 'passing' | 'failing' | 'running' | 'none' | 'unrecognized'; at: Ms | null; url: Url | null };
  commits: { sha: string; at: Ms; author: { name: string; personId: PersonId | null }; message: string }[];  // newest 10
  fetchedAt: Ms;
}
```
Fetched with the `gh` CLI (already authenticated on the host; no token in Agent Office) every 10 min per linked repo, and cached in the store.

### 9.4 Flag (four kinds)

```ts
type RiskKey = 'blocked' | 'flow-failing' | 'cron-failing' | 'ci-red' | 'stale';
type Severity = 'high' | 'medium' | 'low';

type Flag =
  | { kind: 'label';    key: Slug; label: string; addedBy: ActorRef; addedAt: Ms }
  | { kind: 'risk';     key: RiskKey; severity: Severity; origin: 'auto' | 'manual';
      evidence: { kind: 'cron-run' | 'ci' | 'session' | 'manual' | 'inactivity'; ref: string; at: Ms } | null;
      staleDays?: number;                            // key 'stale' only (« Inactif depuis N j »)
      raisedAt: Ms; clearedAt: Ms | null;
      ack: { by: ActorRef; at: Ms } | null }
  | { kind: 'feature';  key: string; state: 'on' | 'off' | 'unknown';
      foundIn: { path: string; line: number | null }; scannedAt: Ms }
  | { kind: 'priority'; key: Priority };             // derived from Project.priority
```
- **label:** free tags, manual only. `key` is the slugified label.
- **risk:** raised and cleared by the risk monitor (engine.md §7), except `blocked`, which Owner or Timmy can also set manually.
  - Defaults: `blocked` high; `cron-failing` and `flow-failing` high; `ci-red` medium; `stale` low, after 14 days without activity.
  - An auto risk clears itself when its condition goes away (`clearedAt` set, kept in history). An **ack** hides the risk from the card but keeps it on the detail page; a new evidence event after the ack un-acks it.
- **feature:** found by scanning the linked repo/workspace for known feature-flag patterns (open question 4); read-only.
- **priority:** never stored.
- **Who may change what (R3-13):**
  - **labels:** added and removed by users;
  - **`blocked`:** set and removed by users (origin `manual`);
  - **any uncleared risk:** acked and un-acked by users;
  - **auto risks:** raised and cleared only by the risk monitor; users can never delete them;
  - **feature flags:** written only by the scanner (one `flags-updated` system event when the set changes); `state` is part of the flag and of `FlagVM`;
  - **priority flag:** derived, never a mutation target.

  The API's error `issue` values are `flag-not-writable` and `flag-not-removable` (api.md §5.4).
- **Display order** (LabelChip README): priority, risk, feature, label.

### 9.5 Person and ProjectPerson

```ts
type PersonId = `per_${string}`;

interface Person {
  id: PersonId;
  kind: 'human' | 'agent' | 'git';
  name: string;
  avatarUrl: Url | null;
  links: { agentId?: AgentId; subagentId?: string; discordUserId?: Snowflake; gitEmailHash?: string; isOwner?: boolean };
}

interface ProjectPerson {
  personId: PersonId;
  role: string | null;             // free text, e.g. « Client », « Revue »
  origin: 'derived' | 'manual';
  liveState: AgentState | null;    // agents only; joined from the matching OfficeOccupant at view time
  commitCount: number | null;      // git only
}
```
- **Identity merging:** one Person per real identity. Owner is a single `human` Person with `isOwner`, linked to his Discord id and git email hash. A git author whose email hash matches a known human merges into that human.
- `gitEmailHash` is SHA-256 of the lowercased email. Raw emails are not stored.
- **Derived membership:** git authors of the repo's recent commits; agents seen in linked session groups; Discord users of linked session groups. Manual overrides can add a person, set a role, or hide a derived person.

### 9.6 HistoryEvent

Append-only. The text is **not** stored; the view model renders the French sentence from the structured payload (HistoryTimeline README patterns).

```ts
type HistoryEvent = {
  id: `evt_${string}`;
  projectId: ProjectId;
  at: Ms;
  actor: ActorRef;
  dedupeKey: string | null;        // idempotent ingestion of derived events (commit sha, cron run id…)
} & (
  | { kind: 'project-created' }
  | { kind: 'status';         from: ProjectStatus; to: ProjectStatus }
  | { kind: 'priority';       from: Priority; to: Priority }
  | { kind: 'commit';         branch: string; shas: string[] }
  | { kind: 'flow-run';       jobId: CronJobId; runId: string; status: CronRunStatus; durationMs: DurationMs | null }
  | { kind: 'cron-run';       jobId: CronJobId; runId: string; status: CronRunStatus; durationMs: DurationMs | null }
  | { kind: 'session';        sessionKey: SessionKey; messages: number; tokens: Tokens }
  | { kind: 'risk-raised';    key: RiskKey; severity: Severity }
  | { kind: 'risk-cleared';   key: RiskKey }
  | { kind: 'risk-acked';     key: RiskKey }
  | { kind: 'flag-added';     flagKind: 'label' | 'risk'; key: string; label: string }
  | { kind: 'flag-removed';   flagKind: 'label' | 'risk'; key: string }
  | { kind: 'summary-edited' }
  | { kind: 'source-linked';  source: ProjectSource['kind']; ref: string }
  | { kind: 'source-unlinked';source: ProjectSource['kind']; ref: string }
  | { kind: 'agent-action';   action: 'delegated' | 'commented'; subjectPersonId: PersonId | null; note: string }
  // added on projects-01 (PM decision):
  | { kind: 'renamed';        from: string; to: string }
  | { kind: 'risk-unacked';   key: RiskKey }                    // manual un-ack, or new evidence dropping an ack
  | { kind: 'archived' }
  | { kind: 'restored' }
  | { kind: 'people-override'; personId: PersonId; role: string | null; hidden: boolean }   // 2.1: both always written
  | { kind: 'flags-updated';  flags: { key: string; state: 'on' | 'off' | 'unknown' }[] }  // 2.1 (projects): the full sorted set, one system event when key/state changes
);
```
- The HistoryTimeline README says unknown kinds fall back to raw text; with this closed union that fallback becomes dead code, and the store rejects unknown kinds (CHECK constraint).
- `flow-run` vs `cron-run`: today both come from `cron.runs`. A "flow" is a cron job linked to the project; a plain `cron-run` is a run of any other job whose session touches the project. Kept separate because the designs style them differently.

## 10. HealthSnapshot

```ts
type HealthLevel = 'ok' | 'warn' | 'alert';

interface HealthSnapshot {
  at: Ms;
  level: HealthLevel;              // worst of the parts below
  gateway: { connected: boolean; version: string | null; connectedSince: Ms | null; pluginsLoaded: number | null;
             eventLoop: { degraded: boolean; delayP99Ms: number | null; utilization: number | null } | null };
  host: { hostname: string; cpuPct: number; load1: number; cores: number;
          mem: { used: number; total: number }; disk: { used: number; total: number } | null; uptimeSec: number };
  cron: { enabled: number; total: number; failing: number };
  sources: SourceStatus[];         // one per engine source (engine.md §3)
  dataQuality: { openIssues: number; byCode: Record<IssueCode, number>; lastIssueAt: Ms | null };
}

interface SourceStatus {           // R3-09: per-channel, value-free (engine.md §5.3–5.4)
  id: SourceId;                    // 'gateway', 'cli', 'config', 'host', 'discord', 'github', 'store'
  state: 'fresh' | 'stale' | 'down';   // down: transport down (gateway closed); stale: ≥1 channel's last outcome failed; else fresh
  lastOkAt: Ms | null;             // newest success over its channels; null: never succeeded
  lastErrorAt: Ms | null;          // newest failure over its channels; null: never failed
  lastError: SourceErrorCategory | null;   // 'not-connected' while down; else the newest failing channel's category; null when fresh
  channels: ChannelStatus[];       // sorted by channel id; [] before any envelope
}
interface ChannelStatus { channel: string; state: 'fresh' | 'stale'; lastOkAt: Ms | null; lastErrorAt: Ms | null; lastError: SourceErrorCategory | null }
type SourceErrorCategory = 'timeout' | 'not-connected' | 'connection-closed' | 'connection-refused' | 'unknown-method' | 'not-found'
  | 'permission-denied' | 'invalid-json' | 'invalid-output' | 'unreadable' | 'missing-agent' | 'not-ok' | 'payload-rejected'
  | 'killed-or-timeout' | `exit-${number}` | 'error';
```
- Thresholds (today hard-coded in `buildHealth()` and `healthState()`) become named constants in `src/health/thresholds.js`: CPU warn 55, alert 85; memory warn 75, alert 90; disk warn 75, alert 90; event loop degraded → alert.
- Colours are no longer sent; the client maps `level` to `--bu-*` tokens.
- **Lifecycle:** recomputed every 5 s (host tick) and on gateway `health` events. The last 24 h are kept in memory at 1-minute resolution for sparklines.

## 11. LiveEvent

The office journal (*Journal des événements · en direct*). Replaces `liveEvents` and its hard-coded colours.

```ts
type LiveEventKind =
  | 'gateway.connected' | 'gateway.disconnected'
  | 'activity'                 // a session started thinking/writing/calling…
  | 'run.started' | 'run.succeeded' | 'run.failed'
  | 'cron.fired'
  | 'occupant.joined' | 'occupant.left'
  | 'agent.removed'
  | 'project.status' | 'project.risk';

interface LiveEvent {
  id: string;                  // monotonic, `le_${seq}`
  at: Ms;
  kind: LiveEventKind;
  actor: ActorRef;
  occupantId: OccupantId | null;
  sessionKey: SessionKey | null;
  activity?: ActivityKind;     // kind 'activity'
  cronJobId?: CronJobId;       // kind 'cron.fired'
  projectId?: ProjectId;       // kinds 'project.*'
  count: number;               // S4.1: ≥ 1; coalesced occurrences (below)
}
```
- In memory, ring buffer of 200; the view model renders the French sentence (`verbFor()` today).
- **Executable contract (S4.1, R6-06):** `C.LiveEvent` in `src/engine/model/canonical.js`; every row carries `occupantId`/`sessionKey` (null when n/a). `run.started` / `run.succeeded` / `run.failed` come from run-state transitions (`sessions.changed`, lists, descriptions); first sightings during the initial snapshot emit nothing.
- **Coalescing:** events with the same **identity** (session key + activity kind; job for cron fires; kind + session for run events) within 10 s merge into one row wherever it is in the window. The merged row moves to the top with a `count`. Display names never decide a merge, so two sessions with the same label stay separate (S3.1, R2-06). Connection events never merge.

## 12. OfficeLayout and customization

**2.1:** office-dev's proposals are adopted (api.md §3.13): rule identity is the `OccupantId` verbatim (`main`, `subagent:<id>`, …; defaults `*<role>`), with `OccupantVM.ruleId`; work homes are desks allocated explicit-first, then in layout order, else overflow (`stationUid: null`). Lounges remain activity destinations and legacy references, not work-home capacity. The theme lives only in `data.theme` and gains `season`; the inventory of agents seen in 30 days is persisted (`office_agents_seen`, storage.md). The one implementation of these rules is `public/v2/office/layout-rules.js`.

The schema is already specified in `design/office/layout.schema.json` (layout) and `manifest.schema.json` (assets). The canonical type mirrors the layout schema exactly, plus storage metadata:

```ts
type LayoutId = `lay_${string}`;

interface OfficeLayout {
  id: LayoutId;
  name: string;                         // « Bureau principal »
  revision: number;
  active: boolean;                      // exactly one active layout
  updatedAt: Ms;
  updatedBy: ActorRef;
  data: OfficeLayoutDataV1;             // = layout.schema.json (version: 1)
}

// Abbreviated; layout.schema.json is authoritative.
interface OfficeLayoutDataV1 {
  version: 1;
  manifestVersion: number;
  room: string;
  theme: { mode: 'auto' | 'fixed'; fixed?: string; day?: string; night?: string; nightFrom?: string; nightTo?: string; season?: string | null };
  items: ({ uid: Slug; asset: string; label?: string } & ({ x: number; y: number; orientation?: 'sw' | 'se' } | { wall: 'left' | 'right'; offset: number }))[];
  agents: { agentId: string; match?: { kind: OccupantRole }; character: string; variant?: string | null;
            accessories?: string[]; appearance?: 'auto' | 'manual'; name?: string | null; role?: string | null; station?: string }[];
}
```
- **Invariants:** checked on the server at save time, not only by JSON Schema:
  - every asset id exists in the manifest of `manifestVersion`;
  - floor footprints don't overlap and stay within `cols × rows`;
  - each station's `blocks` tiles (extra non-walkable tiles relative to the item, e.g. the chair tile) stay within `cols × rows` and don't overlap another item's footprint or blocks (office-dev's manifest test checks the same rule);
  - at most one accessory per slot;
  - every `station` is either **`'auto'` / omitted** (automatic allocation) or references an item that has a `station` in the manifest (R3-07). The shipped default layout uses `'auto'` and must pass these same checks; a test validates it;
  - at least one `desk` station exists for the main agent.
- **Resolution:** `OfficeOccupant.look`, `.name` and `.stationUid` are resolved on the server from the active layout. Rule order is first match wins; `*` default rules rotate variants by occupant order. The client never re-implements this.
  - **Automatic stations (T-0158):** occupants without a fixed desk take the first free desk in layout item order. A legacy saved lounge assignment is treated as a preference that is migrated to a desk; lounges remain interaction/activity destinations. When no desk is free, `stationUid` is `null` (overflow: the renderer places the character in a standing area).
  - **Accessories precedence (R3-08, server-side, decided here):** a rule **omitting** `accessories` gets the variant's manifest `defaultAccessories`. An explicit **`[]`** means none. A non-empty list replaces the defaults. The resolved list in `OccupantVM.look.accessories` is final, and the renderer adds nothing. Manifest encoding of layers and facing: pending office-dev and artist.
- **Display-only rule:** layout names and roles are never written back to OpenClaw.
- **Lifecycle:** a default layout (from `layout.example.json`) is seeded on first boot. Saves use `revision` for conflicts (api.md §5). The last 20 revisions are kept for *Annuler*/reset.

```ts
// Per-user UI preferences that the server must remember (not layout).
interface UiPrefs {
  uiTheme: 'system' | 'dark' | 'light';
}
// C1 / R3-17 (interim until office-dev's proposal): officeTheme is REMOVED from UiPrefs. The active layout's
// `theme` is the only owner of the office theme; the server resolves it (LayoutVM.theme) and pushes at nextChangeAt.
```
The UI theme is stored server-side, so it follows Owner across devices. That keeps the frontend stateless; `localStorage` may cache it only to avoid a flash on load.

---

## 13. Type → source map

| Type | Raw sources | Refresh |
| --- | --- | --- |
| Agent | `agents.list` | 10 s |
| Session, RunState | `sessions.list {limit:300}`, `sessions.describe`, events `sessions.changed` | 10 s + events |
| Transcript | `sessions.get` | on demand, 30 s cache |
| Activity | events `session.tool`, `session.message`, `session.operation`, `agent` | live |
| OfficeOccupant | derived (Session, Activity, OfficeLayout, gateway status) | on change |
| CronJob | `cron.list`, event `cron` | 10 s + events |
| CronRun | `cron.runs {jobId}` | on demand / on `cron` event |
| Skill | CLI `skills list/info --agent main --json`, SKILL.md file | 120 s / on demand |
| Channel | `channels.status`, `openclaw.json` (policies) | 10 s / 60 s |
| Interlocutor | derived from Sessions + Discord REST + `openclaw.json` (guild channel config) | on new id; cache |
| Project, Flag, HistoryEvent, Person, OfficeLayout, UiPrefs | Agent Office store | on write |
| Repo | `gh api` | 10 min |
| HealthSnapshot | `os`, `df`, event `health`, engine source status | 5 s |
| LiveEvent | derived from the above | live |
| Host, Orchestrator, HostAgent | Herdr `agent list` snapshot and bounded pane-agent lifecycle/status events | 5 s snapshot + invalidation events |
| Team, TeamMember, Task, Review, TeamMessage | explicitly configured `agent-team-pm` team-store files | 10 s |

`sessions.usage` is fetched today but never read; it's dropped unless a view needs it.

## Open questions (for the PM)
1. ~~**Kanban keys**~~ — resolved 2026-10-05: the design now uses the canonical English keys (`idea`, `todo`, `in-progress`, `in-review`, `shipped`).
2. ~~**`wakeMode`, `lifecycle`, CronRun `status`**~~: resolved by the 2026-10-05 capture (see [capture-findings.md](capture-findings.md)). Still open: `classification`, `completionStatus`, `lastRunStatus`, `deliveryStatus` and the activity event names. These need the next capture, with the extended keep list, taken while Timmy is working.
3. **Sub-agent identity:** a sub-agent has a session id but no stable name. Should a recurring sub-agent role (e.g. "Scout") become a named Person? That needs an OpenClaw field we haven't seen yet.
4. **Feature flags:** which patterns count (env vars like `FEATURE_*`, a `flags.json`, LaunchDarkly-style calls)? Needs Owner's convention.
