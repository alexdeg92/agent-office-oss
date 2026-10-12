# ADR-005: Canonical execution lifecycle

- **Status:** Proposed — implementation is blocked on Critic and Security GO.
- **Date:** 2026-10-11. Task: T-0070, execution-lifecycle audit.
- **Inputs:** [ADR-001 runtime adapters](adr-001-runtime-adapters.md), [ADR-002 multi-user RBAC](adr-002-multi-user-rbac.md), [canonical data model](data-model.md), [storage](storage.md), and `docs/briefs/lifecycle-adr-1.md`.

## 1. Context

The current session registry merges list pages, change events and descriptions in arrival order. A delayed page can therefore replace a terminal run observation with an older `running` row. Claude Code transcript appends also produce a short-lived “working” signal; that is evidence of recent activity, not proof of an active execution or a completed run. Finally, lifecycle history is process-local, so a restart loses transitions and makes a fresh UI unable to distinguish “idle” from “not currently observable.”

This design treats runtime data as evidence. It keeps source health, presence, observed activity and execution state separate, preserves source identity and ordering, and projects only canonical data to the API and UI. Runtime-specific formats and capabilities remain inside adapters. No core or UI branch may depend on a provider name.

## 1.1 Findings verified against this checkout

The audit was checked against branch `t0070` at base `72794adc`. “Confirmed” means the stated design gap is visible in the current code; it does not claim a production trace was reproduced. “Partly confirmed” means an adjacent safeguard exists, but the lifecycle contract in the finding is still absent.

| # | Finding | Result and code evidence |
|---|---|---|
| 1 | A delayed snapshot can revive a terminal run. | **Confirmed (ordering gap; the race itself was not separately replayed here).** `src/engine/sessions-registry.js:34-36` keeps one pending snapshot and an arrival `seq`; `:40-52` selects the newer received row for run fields; `:83-116` resets/accepts pages and writes rows without a source revision or request generation. `:122-129` lets `sessions.changed` update that same registry. Therefore a response requested earlier but received later can win by arrival order. Complete-snapshot validation at `:98-114` protects deletion from incomplete walks, but does not fence stale row values. |
| 2 | Claude “working” is a 30-second transcript-activity lease, not verified execution. | **Confirmed.** `src/adapters/claude-code/index.js:63-70` reads a transcript and calls `setObservedActivity` only when `activityAt` is less than 30 seconds old. The cycle runs every two seconds at `:124-126`; recent tails are selected/capped at `:91-99`. `src/engine/index.js:155-165` validates and expires the observed lease separately from canonical run-state activity. This is useful evidence of recent transcript activity, but it does not establish a run start/end. |
| 3 | Lifecycle history is process-local. | **Confirmed for lifecycle transitions.** `src/engine/index.js:199-224` stores `liveEvents` and `liveSeq` in memory and caps the array; `:227-244` derives transition notifications from current sessions. Existing SQLite storage has general project history (`src/store/migrations/002_projects.sql:47-61`) and user sessions (`003_sessions.sql`), but no canonical run-event ledger or adapter source checkpoint in migrations `001`–`027`. |
| 4 | Transitions are keyed by session status, while display events are coalesced. | **Confirmed.** `src/engine/index.js:210-224` coalesces matching `LiveEvent`s within a time window; `:227-244` tracks only `runStatus: Map<key,status>` and emits starts/success/failure from that pair. The canonical `RunState` has `lastRunId`, but this transition tracker does not key by it (`src/engine/model/session.js:21-27`). |
| 5 | There is no honest unknown execution state, and source health must remain separate. | **Partly confirmed.** `src/engine/model/session.js:21-27` restricts run status to `idle|running|succeeded|failed`, with no `unknown`, `waiting`, `blocked`, or `cancelled`. However transport/source health is already tracked separately in `src/engine/index.js:100-127`, and observed transcript activity has its own map at `:147-165`. The ADR formalizes this separation and adds missing canonical lifecycle certainty; it does not claim source-health separation is wholly absent today. |
| 6 | Discovery, connection and observability need declared lifecycle capabilities. | **Partly confirmed.** Adapters already declare broad runtime/settings capabilities (`src/adapters/claude-code/index.js:11-15`; `src/engine/index.js:383-390` exposes runtime capabilities), and the registry is provider-neutral (`src/adapters/index.js:1-20`). Current capabilities do not declare run identity, evidence level, ordering, terminal-state authority, checkpoints or observation mode, and the engine has no shared validated lifecycle manifest. |

These checks identify the current gap and the specific legacy behavior each checkpoint must replace. The ordering regression will add a deterministic delayed-snapshot replay test before the registry behavior changes; no claim is made here that existing tests already reproduce it.

## 2. Decision

Adapters emit validated, versioned canonical observations and lifecycle events. The engine applies them to an append-only bounded ledger and a current-state projection. Both are committed with the adapter checkpoint in one store transaction. The API and SSE publish revisioned projections; UI coalescing may omit intermediate notifications but never changes ledger authority.

```text
adapter source
  → validated Observation / LifecycleEvent
  → dedupe + source-order check
  → [ledger event + projection + checkpoint] atomic commit
  → revisioned API/SSE projection
  → UI
```

The canonical entities are `RuntimeInstance`, `Agent`, `Session`, `Run`, `ToolInvocation`, `LifecycleEvent`, `Presence`, `SourceHealth`, and `Capability`. `Run` is distinct from `Session`: a session may contain many runs, and a sub-agent run may identify its parent run. Provider-native identifiers are held in a private external-reference map scoped by runtime instance and entity type. Canonical identifiers are opaque and stable. Provider additions belong under a validated, size-bounded namespace such as `extensions.<adapter-id>`; extensions are never required to interpret core state.

### 2.1 Lifecycle and evidence vocabulary

```ts
type ExecutionState =
  | 'unknown' | 'queued' | 'running' | 'waiting' | 'blocked'
  | 'succeeded' | 'failed' | 'cancelled';
type EvidenceLevel = 'verified' | 'observed' | 'unknown';
type PresenceState = 'present' | 'absent' | 'unknown';
type SourceHealthState = 'healthy' | 'degraded' | 'disconnected' | 'unknown';

interface Evidence {
  level: EvidenceLevel;
  sourceId: string;
  observedAt: number;
  expiresAt: number | null;
  basis: string; // canonical vocabulary, not raw provider text
}
```

`verified` means the source contract directly establishes the state (for example, an authoritative run-start/end event, or an explicit terminal status with documented semantics). `observed` means indirect evidence supports a current interpretation but does not establish execution lifecycle (for example, a transcript append or a heartbeat). `unknown` means there is no current evidence sufficient to state execution status. Each emitted state carries evidence; evidence is not inferred from UI polling time.

Transcript activity may project “recent activity observed” with `observedAt` and a bounded `expiresAt`. When it expires, the projection becomes `unknown`/not recently observed; it must not silently become verified `idle`, `succeeded`, or `failed`. An active lease may inform a presentation hint, but cannot override a verified terminal event for the same run. Only a source that explicitly supports and supplies a terminal state may establish completion. `waiting`, `blocked`, and `cancelled` are used only where an adapter capability and evidence substantiate them; otherwise the adapter maps to `unknown` or its documented canonical alternative.

Presence and source health are independent. An agent may be present while its source is disconnected; a run may retain a verified terminal result while the source is down. On disconnect, keep the last state and its evidence timestamp, mark the source health separately, and present the French/English equivalent of “last known state, not confirmed.” Do not turn a transport failure into an execution transition.

### 2.2 Canonical records

```ts
interface LifecycleEvent {
  id: string;                 // AO-minted stable event id
  runtimeInstanceId: string;
  sessionId: string;
  runId: string;
  parentRunId: string | null;
  kind: string;               // closed canonical event vocabulary
  state: ExecutionState | null;
  evidence: Evidence;
  sourceId: string;
  sourceEventId: string | null;
  sourceRevision: string | number | null;
  acquisitionGeneration: number;
  sourceSequence: number | null;
  occurredAt: number | null;  // source event time; nullable if unavailable
  observedAt: number;         // AO receipt time
  safeData: object;           // bounded canonical metadata only
}

interface RunProjection {
  runtimeInstanceId: string; sessionId: string; runId: string;
  parentRunId: string | null; state: ExecutionState; evidence: Evidence;
  startedAt: number | null; endedAt: number | null; lastEventId: string | null;
  revision: number; sourceHighWater: SourcePosition;
}

interface SourcePosition {
  acquisitionGeneration: number;
  sourceRevision: string | null;
  sourceSequence: number | null;
  ingestOrdinal: number; // monotonic AO order, only the final tie-breaker
}
```

`safeData` is an allowlisted canonical payload. By default it excludes transcript bodies, prompts, tool input/output, credentials, arbitrary filesystem paths, and raw provider objects. A future feature that needs sensitive content requires a separate privacy decision, explicit permission, dedicated storage, and retention rules; it cannot widen this ledger implicitly.

### 2.3 Ordering, snapshots and run-aware transitions

Wall-clock timestamps are descriptive, not an ordering authority. For each source, the adapter supplies a stable `sourceId`; when supported, it also supplies a monotonically comparable source revision/sequence and a stable event id. Each snapshot walk receives an engine-owned monotonically increasing `acquisitionGeneration`, unique for `(runtimeInstanceId, sourceId, entity scope)`. A snapshot page retains that generation and its snapshot watermark/cursor from request through completion. `occurredAt` is immutable source time and is preserved exactly (after validation); it may move backwards under clock skew and is never used as the projection high-water mark. The projection stores a separate `sourceHighWater` tuple (revision/sequence, else acquisition generation/page order, with monotonic ingest ordinal as the local tie-breaker). A stale event can therefore retain its original occurrence time in history while being refused as a projection update.

Ordering uses this precedence:

1. A comparable source revision or source sequence orders observations from that source and scope.
2. Without a source order token, the engine uses acquisition generation and per-generation page order. A complete snapshot is one atomic reconciliation candidate; a partial/failed walk cannot prove absence.
3. For a given `(runtimeInstanceId, sessionId, runId)`, a verified terminal transition is monotonic. A later-arriving observation from an older source revision or acquisition generation cannot revive that run. A newer verified event may correct a terminal state only when the adapter explicitly declares correction semantics and supplies a strictly newer source order token; all such corrections remain auditable.
4. A genuinely new run uses a distinct run identity, or an adapter-provided start identity that the adapter contract declares stable. A new run is never rejected just because an earlier run for the session is terminal. If an adapter cannot distinguish runs reliably, it emits a lower-confidence session observation and the canonical run stays unknown rather than fabricating a new run.

The registry must retain the current run identity independently from session-level status. A delayed list row for run A cannot overwrite run B. Snapshot absence can remove a session only after all pages pass validation and the snapshot watermark is not older than the latest accepted source position for that scope. Rejected rows, inconsistent totals, gaps, stale generations, cancellation, or timeout invalidate absence evidence. Monotonic projection fields such as `updatedAt` never move backwards, but timestamp comparison alone never defeats a source revision; immutable `occurredAt` always retains the source's original time, including under clock skew.

If the adapter has no source revision, the engine's acquisition generation prevents an older in-flight request from applying after a newer request. For event streams, a source without event IDs gets a bounded deterministic dedupe key from canonical identity, event kind, source sequence if available, and event time; if no stable identity is available, ingestion remains at-least-once and projection transition rules must be idempotent. The adapter manifest declares which guarantee applies.

### 2.4 Durable ledger, checkpoints and retention

The current migration directory ends at `src/store/migrations/027_linked_cookie_expiry.sql`, so the planned additive migration is **028** (reconfirm the next sequence at implementation time). Add tables equivalent to:

- `lifecycle_events`: append-only canonical events within the retention window, unique on `(runtime_instance_id, source_id, source_event_id)` when `source_event_id` exists; also stores the AO event id, entity/run keys, source order, evidence, timestamps and safe data JSON. Compaction may delete detail only while atomically preserving a summary baseline and checkpoint.
- `lifecycle_runs`: latest canonical projection per `(runtime_instance_id, session_id, run_id)` with state, evidence, parent linkage, projection revision and compacted-history boundary.
- `lifecycle_checkpoints`: last committed source cursor/revision/generation per `(runtime_instance_id, source_id, scope)` plus adapter contract version and update time.
- `runtime_external_refs`: private mapping `(runtime_instance_id, entity_type, source_id, native_id_hash)` to canonical id. Native IDs are not exposed in general-purpose VMs; if a raw value is needed to resume a source cursor, it is encrypted/owner-private and separately bounded.

Names and concrete columns may follow the existing store conventions, but the invariants below are mandatory. In one SQLite transaction, validate and dedupe an incoming event, append it, update the run/session projection and its revision, and advance the checkpoint. Any failure rolls the whole unit back. A checkpoint may never advance beyond data committed in the same transaction. Duplicate event delivery is a no-op. Replay uses persisted checkpoints and is idempotent; restart first loads the last committed projection, then resumes after its checkpoint. A source that cannot resume is reconciled with a generation-fenced snapshot; it does not clear stored state while disconnected.

Every persisted scalar has a byte ceiling enforced at validation and by SQLite `CHECK(length(CAST(value AS BLOB)) <= limit)` constraints (character count alone is insufficient). Exact ceilings, in UTF-8 bytes: `runtimeInstanceId` 128; `sourceId` and `adapterId` 64 each; `entityType` 32 (closed enum); canonical `sessionId`, `runId`, `parentRunId`, and entity IDs 256 each; AO `eventId` 128; `sourceEventId` 256; `sourceRevision` 128; `scope` 256; cursor 4,096 before encryption and 6,144 stored encrypted; event `kind` and evidence `basis` are closed enums with maximum encoded length 64; status/state enums 16; contract version 64. `occurredAt`/`observedAt` are non-negative signed 64-bit integer milliseconds; generation, source sequence and projection revision are non-negative signed 64-bit integers. Nullables remain null, not empty sentinel strings.

`safeData` is validated as JSON with depth ≤4, ≤32 object keys per object, keys ≤64 bytes from a canonical allowlist, strings ≤512 UTF-8 bytes, arrays ≤32 elements, and **serialized UTF-8 size ≤16,384 bytes**. Each complete serialized event is capped at 24,576 bytes; each run projection at 8,192 bytes; each checkpoint at 8,192 bytes including its encrypted cursor; each external-reference row at 1,024 bytes. Oversized data is rejected as a whole with a bounded `payload-too-large` category; it is never silently truncated because truncation could change evidence or identity. Adapters must normalize a known field to its canonical bounded form before submission or omit that optional field. Source checkpoint cursors that exceed the cap make that source non-resumable; use a generation-fenced fresh snapshot rather than storing a partial cursor.

The migration adds a `lifecycle_usage` row per runtime instance. It maintains `row_count` and `accounted_bytes` in the same transaction as ledger writes and compaction. Insert/update/delete triggers charge **512 bytes fixed per row + the UTF-8 byte length of every stored scalar and JSON/cursor payload + the UTF-8 byte length of each indexed key component once per index occurrence** (conservative logical accounting; repeated key bytes are intentionally counted again). Triggers reject any write that would exceed the per-table row caps, aggregate 200,000 rows, or 134,217,728 accounted bytes; deletes/compaction release exactly the corresponding charge. On startup, a consistency scan recomputes these counters and refuses new ingestion if persisted accounting disagrees. Because each component also has an enforced maximum, no event, key, cursor or index value can bypass the aggregate accounting bound. SQLite page fragmentation/WAL overhead is outside this logical-data budget and remains governed by existing store backup/checkpoint maintenance.

Retention is bounded across **all** lifecycle-owned tables per runtime instance, including projections, checkpoints, external references and indexed key material. The hard limits are **100,000 event rows, 50,000 run projections, 40,000 external-reference mappings, 4,096 source checkpoints, 128 MiB of transactionally accounted logical bytes, and 30 days of detailed event history**, whichever is reached first. The individual row ceilings sum to 194,096; a **200,000-row aggregate ceiling** also guards future lifecycle tables. These are code-enforced ceilings; configuration may lower them, never raise them. The exact byte-charge algorithm and per-field maxima below make the bound enforceable; SQLite page/WAL allocation remains governed by existing store maintenance.

Compaction runs transactionally before event admission and on maintenance. First delete expired non-active event detail and oldest non-active terminal-run projections; then compact active-run history by preserving each run's current projection, original start time/evidence, latest state/evidence, bounded aggregate counters, latest 8 event details, and a `historyCompactedBefore` boundary. Older active-run event detail is removed even while that run remains active. Terminal events are retained while room remains but may also be summarized when needed for the hard caps. A compacted summary is a replay baseline, not a claim that the intervening event history is complete. Checkpoints advance only with accepted event/projection writes; replay starts from the persisted projection and its checkpoint, never from pruned detail. API history reports the compaction/retention boundary and cannot paginate as if omitted events existed.

To bound the projection table, keep at most 50,000 run projections per instance; prune the oldest terminal projections after their event summary is recorded, and retain at most 10,000 active runs. If a new run would exceed the active-run or projection cap, or compaction cannot bring row/byte usage under limits, reject that observation atomically, do not advance its source checkpoint, and mark that source `degraded/capacity-limited` with a bounded counter. The adapter coordinator applies backpressure/retry with a bounded delay. Existing accepted state remains available and labeled stale/limited; the engine never silently drops an uncheckpointed transition. Re-admission retries compaction and then reprocesses the same source position. External-reference and checkpoint rows are capped too; inactive mappings can be pruned only after the associated canonical projection and replay cursor are no longer needed. No raw transcript/tool content is retained by this feature.

### 2.5 Adapter capability and observation contract

Extend the versioned adapter manifest rather than branching in core:

```ts
interface LifecycleCapabilities {
  discovery: 'none' | 'presence';
  execution: 'none' | 'passive' | 'instrumented';
  runIdentity: 'session-only' | 'stable-run';
  sourceOrdering: 'none' | 'generation' | 'revision' | 'sequence';
  toolInvocations: 'none' | 'observed' | 'verified';
  parentRuns: boolean;
  terminalStates: Array<'succeeded' | 'failed' | 'cancelled'>;
  waitingStates: Array<'queued' | 'waiting' | 'blocked'>;
  checkpointing: 'none' | 'cursor' | 'revision';
}

interface AdapterManifest {
  id: string; version: number; contractVersion: number;
  capabilities: LifecycleCapabilities;
  validate(raw): ValidatedObservation | ValidatedLifecycleEvent;
  discover?(ctx): Promise<PresenceObservation[]>;
  subscribe?(ctx, checkpoint): AsyncIterable<ValidatedLifecycleEvent>;
  snapshot?(ctx, generation, checkpoint): Promise<SnapshotPage[]>;
  stop?(ctx): Promise<void>;
}
```

Manifests are schema-validated at registration. Unknown versions, undeclared capabilities, unsupported values and invalid event envelopes fail closed into adapter health/quarantine; they do not crash the shared engine or claim the source is observable. Discovery means presence only, passive observation carries declared evidence limits, and optional instrumentation may provide exact lifecycle/tool boundaries. Hook-based instrumentation is an opt-in adapter capability, not a core assumption. Claude Code documents distinct session, turn, sub-agent and tool lifecycle hooks; for example, its official hooks reference defines `SessionStart`/`SessionEnd`, `Stop`/`StopFailure`, `PreToolUse`/`PostToolUse`, and sub-agent hooks. These events can support instrumentation only where installed and delivered; transcript parsing remains passive evidence ([Claude Code hooks reference](https://code.claude.com/docs/en/hooks)).

Each adapter declares source IDs, identity scope, ordering and checkpoint guarantees, which canonical states its source substantiates, whether evidence expires, and its privacy-safe normalisation rules. The shared engine validates and ingests these declarations uniformly. It contains no provider-specific status mapping, capability checks, or UI behavior.

### 2.6 API, UI, RBAC and projection revisions

The API returns execution state, confidence/evidence label, last observed time, source health and retention completeness as separate typed fields. User-facing French and English labels explain “verified,” “observed recently,” “unknown,” and “last known state, not confirmed”; raw evidence basis strings, native IDs and source cursors remain private. Existing role/permission projection is applied before both HTTP and SSE serialization. Transcript-derived summaries or details require the existing transcript-read permission; this ADR does not grant it.

Every persisted projection commit gets a monotonically increasing projection revision. The revision covers session/run state, counters and office character state so one API/SSE snapshot cannot show mismatched lifecycle and derived totals. SSE may coalesce notifications and send the newest revision, but clients ignore a revision older than the one already applied. The ledger remains authoritative and is not coalesced. Stream disconnect affects only `SourceHealth`; it does not rewrite the last execution state.

Diagnostics are owner-authenticated and expose release SHA, schema version, adapter manifest/contract version, source health, last checkpoint age, and bounded ingestion/quarantine/pruning counters. They never expose transcript content, raw native IDs, credentials, or private paths.

## 3. Migration and rollout

Migration 028 is additive and is loaded by the numbered migration runner in `src/store/db.js:16-26` (each migration is applied transactionally at `:32-36`). Store composition belongs in `src/store/index.js:11-24, 37-80`; domain persistence belongs in a new `src/store/repos/lifecycle.js`, following the existing repository boundary. Canonical runtime sessions and their run status are currently in engine memory; `src/store/repos/sessions.js` stores authenticated browser sessions and is not a source of runtime history. Therefore the migration starts with an empty lifecycle ledger and does not invent historical transitions. At first boot after migration, adapters publish an initial generation-fenced snapshot and create canonical run projections, with evidence no stronger than the source permits. The old `Session.run` contract in `src/engine/model/session.js:21-27` remains a compatibility projection until API consumers have moved. A feature flag may compare old and new projections in diagnostics, but only the canonical projection becomes authoritative after parity and migration checks pass.

Rollout order is deliberately split into reviewed checkpoints:

1. **Ordering:** replace arrival-only precedence in `src/engine/sessions-registry.js:28-148` and session-status tracking in `src/engine/index.js:227-244`; add out-of-order, multi-run and snapshot-generation cases beside `test/engine/sessions.test.js` and `test/engine/sessions-s31.test.js`.
2. **Evidence/state:** evolve `src/engine/model/session.js:21-27` and `src/engine/derive/activity.js`; keep `src/engine/index.js:100-165` source health and observed activity distinct; add FR/EN labels and API examples/contracts before UI consumption.
3. **Durability:** add migration `src/store/migrations/028_lifecycle_ledger.sql`, repository `src/store/repos/lifecycle.js`, and store composition in `src/store/index.js`; wire engine ingestion in `src/engine/index.js` so tests can assert event/projection/checkpoint atomicity, deduplication, caps, and restart/replay.
4. **Capabilities:** define and validate the lifecycle manifest at the adapter boundary (`src/adapters/index.js` plus shared engine contract); migrate `src/adapters/openclaw`, `src/adapters/claude-code`, and `src/adapters/codex` declarations. Keep source-specific parsing in each adapter.
5. **Coherent projections:** derive counters and office character state from the same lifecycle projection revision in the engine/view-model projection path; preserve `LiveEvent` coalescing in `src/engine/index.js:199-224` as notification-only, and verify it cannot alter durable events.
6. **Diagnostics:** extend the authenticated diagnostics route/VM and contract examples/tests with release SHA, schema version, adapter contract health and bounded counters; do not include private payloads or paths.

Each checkpoint is submitted for review before advancing. Adapter fixtures cover absent capabilities, stale/duplicate/out-of-order data, malformed manifests, disconnect/reconnect, unknown states and new runs after terminal runs. Multi-adapter tests verify namespaced identities, isolated failures and scale to at least 12 configured agents without provider-specific paths.

## 4. Security and privacy

The ledger is application data in the existing protected SQLite store. Read access follows the same per-user RBAC projection as sessions; mutation is service-only. Events contain minimal canonical lifecycle facts and do not retain transcript bodies, prompts, tool input/output, credentials, or arbitrary provider payloads. Native-reference mappings and resumable cursors are private adapter state, not API fields. Retention pruning is deterministic, transactional, and auditable through aggregate counters only. Invalid or over-cap input is rejected/quarantined with shape/category metadata, not raw payload samples. Adapter shutdown fences late callbacks so an old poll or subscription cannot commit after replacement or disconnect.

## 5. Consequences

- Delayed observations can no longer revive a terminal run, while a distinct new run remains admissible.
- The UI can honestly distinguish a verified execution from recent observed activity and from missing evidence.
- Restart no longer erases lifecycle transitions or allows a checkpoint to outrun its event data.
- Adapters with only discovery or passive transcript access remain useful without overstating certainty; instrumentation improves evidence without becoming mandatory.
- SQLite storage, migrations, projection schemas and API examples grow. They are implemented only after Critic and Security approve this ADR.
