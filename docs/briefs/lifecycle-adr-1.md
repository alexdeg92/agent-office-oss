# lifecycle-adr-1: ADR-005 execution lifecycle (from Timmy's architecture audit, owner-approved 2026-10-11)

## Audit findings to address (verify each in code first)
1. A delayed snapshot can flip a finished run back to running (src/engine/sessions-registry.js ~36/94/124): need source revision watermarks / acquisition generations; older observations never overwrite a newer terminal state of the same run; genuinely new runs still allowed.
2. Claude "working" is a 30 s lease from transcript appends (src/adapters/claude-code/index.js ~16-65): separate verified execution from recent observed activity; store evidence source, observed-at and expiry; completion only when the source establishes it.
3. Execution history is in memory (src/store, src/engine ~198-230): add a bounded, durable canonical lifecycle ledger with source checkpoints; event, projection update and checkpoint committed together; no private transcript bodies by default.
4. Transitions are tracked by session status (src/engine ~203-239): track by session + run id + lifecycle state; keep authoritative lifecycle events separate from UI-coalesced notifications.
5. No honest unknown (src/engine/model/session.js ~22-24): add unknown; distinguish source health from execution state; when disconnected show « dernier état connu, non confirmé »; waiting/blocked/cancelled where providers substantiate them.
6. Discovered ≠ connected ≠ observable: validated adapter manifests with capabilities; shared discovery/subscription/reconciliation contract; no provider-specific conditionals in engine/UI.

## Target model
Adapters → validated, versioned observations/events → durable ledger + state projections → typed API/SSE → UI.
Entities: RuntimeInstance, Agent, Session, Run (parent-run linkage), ToolInvocation, Event (source id/revision, occurredAt, observedAt, evidence), Presence (separate from working), Capability. Native ids in external-reference mappings scoped by runtime + entity type. Provider extras in namespaced extensions.
Three integration levels: discovery (presence only), passive observation (APIs/transcripts, with stated evidence limits), optional instrumentation (hooks/telemetry for exact run/tool start/end, e.g. Claude Code hooks installable via the agent-team-pm skill / Intégrations).

## Deliverables (order)
1. docs/architecture/adr-005-execution-lifecycle.md: the model, evidence/confidence vocabulary (verified/observed/unknown), ledger schema + retention bounds, checkpoints, ordering rules, restart/replay semantics, migration plan, adapter manifest/capability contract, RBAC/privacy. Critic + security GO before code.
2. Then in checkpoints: (a) snapshot ordering + run-aware transitions with out-of-order regression tests; (b) honest observed/verified/unknown states end to end (UI labels in FR/EN); (c) durable ledger + idempotent ingestion + restart/replay tests; (d) adapter manifests/capabilities; (e) counters and character states from the same revisioned projection; (f) release SHA, schema version and adapter health in authenticated diagnostics.
