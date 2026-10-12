# ADR-004: Host orchestrators and agent teams

- **Status:** Accepted — exact candidate `c6785afcd392eb3789172336f1d2c0e136f940da`, merged at `baf510e1ec05e705e5464f69965f9e4e2d2e1bae` after Critic, Security, and scoped Designer GO.
- **Date:** 2026-10-10. Owner: backend-codex. Task: T-0045.
- **Inputs:** task input `docs/briefs/orchestrators-teams-1.md` (provided outside this baseline), [ADR-001 runtime adapters](adr-001-runtime-adapters.md), [ADR-002 RBAC](adr-002-multi-user-rbac.md), [canonical data model](data-model.md).
- **Inspection baseline:** `6767a0907310967852893d32882076fbd6d59c65` plus local Herdr 0.9.3 CLI and the installed `agent-team-pm` store writer. This is a target contract; no adapter or UI implementation is included.

## 1. Decision

Add optional, read-only host-orchestrator and team-store sources to the existing adapter platform. Herdr contributes the agents it currently recognizes in its panes, independent of the runtime (Claude Code, Codex, OpenClaw, or another recognized agent). The `agent-team-pm` store contributes its teams, members, tasks, reviews, and message metadata. Both are projected through canonical types; the office, team board, API, and RBAC do not branch on `herdr` or `agent-team-pm` in presentation code.

These sources enrich the same office rather than create a second runtime identity system. An observation from a host source can be linked to a runtime `Agent` only with an exact, explicit stable identity match. Pane proximity, display name, cwd, workspace, terminal title, or similar-looking session IDs are not identity. An unlinked observation remains a host-observed agent with its own scoped canonical ID. Reconciliation is deterministic, reversible, and records its evidence/source; it never merges transcript, session, or person histories.

The sources are strictly read-only. They cannot send keys/prompts, focus or move panes, change Herdr state, claim/edit team tasks, send team messages, install integrations, or operate runtime sessions. Settings integration installation is a separate owner-confirmed plan/apply flow which installs only the reviewed add-on/integration files and requires re-auth; reading data never implies permission to mutate its source.

## 2. Canonical additions and identity

The existing `Agent` remains the identity of a runtime-configured agent. It gains an optional nullable `hostObservations` collection containing only `hostAgentId`, `hostId`, open `runtimeKind`, closed `role`, and closed `status`; old adapters omit it and are admitted with an empty collection. `HostAgent` is the independently keyed canonical pane observation. It exists even when no runtime agent matches and does not create another runtime `Agent`. Titles, pane references, and runtime session references stay inside the source adapter and private identity resolver; none enters the canonical model. A validated `IdentityLink` joins the two only when the evidence rule below succeeds; its permitted fields may then populate `Agent.hostObservations`. There is no reverse list of host IDs on `Agent` to treat as authority.

```ts
type HostId = string;             // AO-minted opaque id for one configured host source
type OrchestratorId = string;     // AO-minted, instance-scoped id, e.g. herdr local session
type TeamId = string;             // opaque, scoped to one team-store root
type TeamMemberId = string;       // opaque, scoped to one team-store root
type TaskId = string;             // source task id scoped to TeamId (not globally unique)
type ReviewId = string;           // AO-minted from source task id + stable review ordinal/key
type HostAgentId = string;        // AO-minted, scoped to host + orchestrator + pane identity

// Additive per-pane projection on existing Agent; omitted by older adapters and admitted as [].
interface AgentHostObservation {
  hostAgentId: HostAgentId; hostId: HostId; runtimeKind: string | null; role: 'primary' | 'delegate' | 'unknown';
  status: 'working' | 'blocked' | 'done' | 'idle' | 'unknown';
}
interface Agent {
  // Existing data-model.md §1 fields, plus this additive collection:
  hostObservations?: AgentHostObservation[];
}

interface Host {
  id: HostId;
  label: string | null;           // owner-selected; never a machine/user/path default
  platform: 'linux' | 'macos' | 'windows' | 'container' | 'unknown';
  sourceStatus: 'available' | 'unavailable' | 'unsupported' | 'stale';
  observedAt: Ms | null;
}
interface Orchestrator {
  id: OrchestratorId;
  hostId: HostId;
  kind: string;                   // open vocabulary, e.g. 'herdr'
  label: string | null;
  sourceStatus: 'available' | 'unavailable' | 'unsupported' | 'stale';
  observedAt: Ms | null;
}
interface HostAgent {
  id: HostAgentId;
  hostId: HostId;
  orchestratorId: OrchestratorId;
  name: string | null;            // source label, sanitized and length-bounded
  runtimeKind: string | null;     // open source vocabulary, e.g. 'claude', 'codex'
  role: 'primary' | 'delegate' | 'unknown';
  status: 'working' | 'blocked' | 'done' | 'idle' | 'unknown';
  observedAt: Ms;
  staleAfter: Ms;
}
interface IdentityLink {
  hostAgentId: HostAgentId;
  agentId: AgentId;
  evidence: 'shared-runtime-session-ref' | 'explicit-runtime-identity';
  confidence: 'exact';
}
interface Team {
  id: TeamId; storeId: string; label: string; status: 'active' | 'stale'; observedAt: Ms;
}
interface TeamMember {
  id: TeamMemberId; teamId: TeamId; name: string; roles: ('pm' | 'builder' | 'reviewer' | 'other')[];
  roleEvidence: 'explicit' | 'derived-from-task-assignments' | 'unknown';
  sourceAgentName: string | null; hostAgentId: HostAgentId | null; status: 'active' | 'inactive' | 'unknown';
}
interface Task {
  id: TaskId; teamId: TeamId; title: string; state: 'open' | 'claimed' | 'working' | 'review' | 'done' | 'blocked';
  priority: 0 | 1 | 2 | 3 | null; ownerMemberId: TeamMemberId | null; reviewerMemberIds: TeamMemberId[];
  createdAt: Ms | null; updatedAt: Ms | null; commit: string | null; reportPresent: boolean;
  briefPresent: boolean; messageCount: number;
}
interface Review {
  id: ReviewId; taskId: TaskId; reviewerMemberId: TeamMemberId | null;
  verdict: 'go' | 'no-go' | 'pending' | 'unknown'; createdAt: Ms | null; reportPresent: boolean;
}
interface TeamMessage {
  id: string; teamId: TeamId; taskId: TaskId | null; fromMemberId: TeamMemberId | null;
  toMemberId: TeamMemberId | null; createdAt: Ms | null; bodyPresent: boolean;
}
type SourceStatus = 'available' | 'unavailable' | 'unsupported' | 'stale';
interface MemberRef { id: TeamMemberId; name: string; roles: TeamMember['roles'] }
interface TaskCounts { open: number; claimed: number; working: number; review: number; done: number; blocked: number }
interface TeamMemberVM { id: TeamMemberId; name: string; roles: TeamMember['roles']; status: TeamMember['status']; hostAgentId: HostAgentId | null }
interface ReviewVM { id: ReviewId; reviewer: MemberRef | null; verdict: Review['verdict']; createdAt: Ms | null; reportPresent: boolean;
  reportRef?: { id: string; displayName: LabelRef } }
```

All IDs are scoped by source instance/root before global canonical ID encoding; source strings never become global IDs without the existing codec. A team task's short source ID such as `T-0001` is not an agent ID. Canonical `Task` and `Review` do not contain message bodies, task brief bodies, inbox text, terminal scrollback, prompts, arguments, environment values, raw file paths, or secrets. They contain only `reportPresent`; source report path strings and basenames remain adapter-private. A private resolver maps eligible reports to AO-issued opaque IDs. A `teams.read` board shows presence only; a `teams.report.resolve` principal may receive `{id, displayName: LabelRef}` with a generic localized name, never a basename or path, and open it through an authorized endpoint. Lookup state retains the source path privately, is discarded when its root is disabled, and is validated for containment/file identity with safe-fs at resolution. The opaque ID is not a URL and cannot encode a path. Herdr pane references, terminal titles and runtime session refs also remain adapter-private and are never returned to a client.

### 2.1 Reconcile host observations with runtime agents

The Herdr adapter may use a runtime-owned opaque `runtimeSessionRef` and a corresponding exact reference for a canonical runtime `Agent` or `Session`; both raw values stay inside the adapter's private reconciliation map and never enter canonical models. Link only when `(hostId, normalized runtimeKind, exact stable ref)` uniquely resolves through the runtime adapter to one canonical `AgentId`. Alternatively, a source may supply an explicit immutable native runtime-agent identity that the runtime adapter itself has mapped to the same canonical agent. Both routes produce `IdentityLink` with one concrete evidence value and are covered by collision tests. Multiple pane observations can link to the same runtime agent; this does not merge or replace their distinct runtime sessions or transcripts. `Agent.hostObservations` is a collection because one runtime agent may be active in several panes. When evidence is missing, ambiguous, stale, or disagrees across adapters, do not link; retain the separate host observation and surface no guessed identity. Names and cwd never upgrade evidence.

The Claude connector and Herdr must not independently mint competing `Agent` rows for one Claude Code process. Claude Code remains the runtime owner of sessions/transcripts; Herdr remains the host owner of pane/status observations. The Claude adapter exposes a reconciliation hook which may return an exact native session/agent reference only when the source actually supplies one. Herdr does not reverse-engineer Claude session keys. If no stable common reference exists, retain separate observations marked `identity: unlinked`; never merge them by display name. This avoids collapsing two concurrent panes running the same agent or merging a Claude session with a restarted process that reused a pane.

Agent Office IDs are stable across polls for the same configured source and source-local key. A deleted/replaced pane receives a new identity if Herdr's pane reference changes; reuse of an opaque pane ref after restart is guarded by the Herdr session/orchestrator scope. Links are recomputed from current exact evidence, never persisted as a manual guess. Stale host snapshots retain their last rows only for the bounded stale window; after expiry they are removed and marked unavailable at source level.

## 3. Read contracts from real sources

### 3.1 Herdr

The authoritative snapshot contract is the installed Herdr CLI JSON response from `herdr agent list`, as documented by Herdr's [agent guide](https://herdr.dev/agent-guide.md), [agents documentation](https://herdr.dev/docs/agents/), and [CLI reference](https://herdr.dev/docs/cli-reference/). In Herdr 0.9.3, the response envelope is `{id, result:{type, agents:[...]}}`; the observed row contains `pane_id`, `agent`, `name`, `agent_status`, `agent_session`, `workspace_id`, `tab_id`, `terminal_id`, `cwd`, `foreground_cwd`, focus/revision sequence fields and terminal title fields. `agent_session` contains `kind`, `agent`, `source`, and `value`. The adapter allowlists only pane identity, runtime kind, display name, status, and an opaque session reference when a supported source documents that it is stable. It discards cwd, foreground cwd, terminal titles, focused state, terminal IDs, and unrecognized fields by default. The CLI has no `--json` option because list already returns JSON.

Poll `herdr agent list` at a configurable but bounded interval (default 5 seconds, minimum 2 seconds, maximum 30 seconds), one in-flight call, 10-second process timeout, bounded output (2 MiB), at most 2,000 rows, and at most 120 seconds of stale retention. Parse/validate each response atomically; malformed, timed-out, absent, or incompatible Herdr never blocks runtime adapters or removes a newer good snapshot. Back off exponentially to a 60-second cap after repeated failures and reset on a valid snapshot. Start only if the configured path/capability is available; do not search PATH on every poll. `sourceStatus` and freshness are visible. The source is read-only: only spawn the known `herdr` binary with fixed argv, no shell, no inherited secrets beyond an allowlisted environment, and no user-provided command or path interpolation.

Herdr identifies agents it recognizes from foreground processes, screen manifests, or installed agent integrations; states include working, blocked, done, idle, unknown. It can observe agents of many runtimes, but it is not a transcript/session provider. Herdr 0.9.3 also documents `events.subscribe` over its local socket API, including `pane.agent_detected`, `pane.agent_status_changed`, pane lifecycle events, bounded ordered delivery, no durable history, and `events_lost`. The source uses these only as invalidations; it bootstraps/reconciles through an authoritative `agent list` snapshot and refreshes after any invalidation or `events_lost`. Subscriptions are re-established after disconnect and bounded queues are coalesced to one refresh. No terminal output/title/scroll/focus subscriptions are needed. If subscription cannot be safely or portably established, polling remains authoritative and no feature is lost. Herdr's `session.snapshot` is the documented socket bootstrap alternative, but v1 uses one snapshot format to avoid dual parsers.

### 3.2 agent-team-pm store

Use the actual installed `agent-team-pm` CLI source as the store contract. Its writer stores plain files below `$TEAM_DIR`, else `<git common dir>/team`, else `~/.local/share/agent-team/default`. `team board --json` is not implemented by the inspected CLI. This adapter therefore reads the versioned-on-disk formats directly from a configured repository root or explicit team root; it does not execute the CLI or infer a store by scanning unrelated projects. The reader recognizes `tasks/T-*.json`, `inbox/<member>.jsonl`, and the stable `members/<name>.json` records; `.lock` and `.read` are writer/reader coordination metadata, not records. It opens a bounded snapshot without taking the writer lock and tolerates atomic replacement; partial JSONL final lines are ignored until a later poll.

The current task JSON writer emits `id,title,state,owner,prio,brief,after,reviewers,created_by,created,commit,report,history,updated`; history entries are `{ts,by,event}`; review rows in `reviews` are `{ts,by,verdict,note,report,commit}`. Task states are `open|claimed|working|review|done|blocked`. Inbox JSONL records are `{ts,from,to,text,task}`. Reader schemas are strict per supported version: validate bounded IDs, enum values, field sizes, counts, timestamps and path containment; unknown fields are ignored only at the source parser boundary and produce a source diagnostic, never copied into canonical data. A newer incompatible format degrades that root to `unsupported` while preserving other roots and runtime data.

`Team`, `TeamMember`, `Task`, and `Review` are derived from task rows, member records, reviewer/owner names, and review/history metadata. Stable member records provide the authoritative member ID, role, runtime, Herdr pane, session reference, and optional `spawnedBy` member ID; task-only legacy members may still derive descriptive role badges from assignments. These roles are never authorization. `sourceAgentName` is metadata only and cannot establish an identity link. Member-to-pane joins use `herdrPane`; lineage follows the stable `spawnedBy` member ID to the parent's `herdrPane`, then an exact session/agent identity. Names are display-only and never join runtime identities. Pane/session refs stay private. Inbox files supply `TeamMessage` metadata only. The default projection reports whether a brief/body exists, message count, and safe routing/timestamp metadata, not its content. Task titles are shown only in team-authorized views after bounded sanitization; task briefs, review notes, message text, agent prompts and histories may contain user or credential data and remain private. Full contents require a future explicit owner-controlled privacy setting and separate review. The first release never exposes message bodies or task briefs in office/board VMs, logs, search, SSE, metrics, or error reports. Read only configured team roots; do not resolve arbitrary paths stored inside task JSON.

Polling defaults to 10 seconds (bounded 5–60 seconds), one scan in flight per root, with maximum 5,000 tasks, 2,000 member records, 100,000 inbox lines per member, 1 MiB per task file, 64 KiB per member record, 8 MiB aggregate per root, and 120-second stale retention. Read files using safe-fs pinned directory handles, no symlink following, regular-file checks, file identity checks, byte caps before parse, and no writes. Ignore `.tmp` files and only admit filenames matching the exact task/member filename grammar. Roots come from explicit configuration for repositories; cap at 20 roots per installation and deduplicate by canonical directory identity. No automatic recursive search of home directories or repositories.

### 3.3 Settings integration and install plan

Settings → Connexion exposes a provider card for the read-only `herdr` source, with its official local logo and a dedicated activation/test page. T-0083: the source adapter declares `capabilities.autoEnableDefault: true`. A shared, provider-independent activation policy probes a detected executable when `sources.herdr` is absent and enables the source only after a valid response. Detection uses an absolute `AO_HERDR_BIN` path or a bounded PATH lookup that ignores relative directories; presence alone does not enable the source. A later read failure affects connection health, not the activation preference. A saved `sources.herdr: false` always preserves the owner's opt-out, including across restarts; a missing executable never starts a reader. An unrelated runtime save omits an untouched `herdrEnabled` flag, preserving the automatic preference. No add-on is installed by activation. The separate `agent-team-pm` store remains opt-in through an explicit repository root and read-access grant. The Office remains useful if either source is missing, stale, unsupported, malformed, or denied by policy.

Installation is an explicit owner-confirmed plan/preview/apply operation through the existing safe publisher. It uses server-owned packaged assets or an owner-selected, validated repository source; shows every target file and current ownership/hash/status before mutation; backs up preimages; writes atomically with private modes; and supports rollback/uninstall only for unchanged files it owns. Herdr's supported `herdr integration install <target>` writes per-agent hook/extension files and can provide session restore and, for some agents, lifecycle reporting; integration targets and files are defined per runtime by the Herdr integration manifest. Settings must not invoke it for a runtime without explicitly showing the exact targets and requesting owner consent. Before enabling this path, the implementation must establish a safe publisher contract against those manifests; if it cannot preview, preserve, and restore existing files safely, the Settings action is unavailable and directs the owner to Herdr's own documented integration UI. The `agent-team-pm` skill/add-on is installed from the reviewed packaged copy or configured repository copy. No host-level packages, shell profiles, runtime permissions, agent configuration, hooks, or network services are modified implicitly. Re-auth is required for each apply/uninstall. Install state and source-read state are separate: successful installation does not imply healthy/available data.

## 4. Office, board and API projection

Canonical host observations live in the separate orchestrators collection. Without `orchestrators.read`, an office occupant is byte-for-byte the existing runtime projection: no host ID, host label, source status, role, status, badge, title, pane reference, session reference, or host-derived count. If the principal also has `orchestrators.read`, a linked occupant may add only opaque `hostAgentId`, the closed `role`, and closed `status`; it still omits title, pane/session references and host identity details. Unlinked host agents appear only in the authorized orchestrators collection, not as office occupants. A resolved identity link does not add another participant. Team views project team membership, status totals, task titles/states, owner/reviewer labels, and links among `Team`, `Task`, `Review`, and `HostAgent` only where the `IdentityLink` is exact and both resources are authorized. `TeamMessage` and task content bodies are excluded by design. Host/team data are separate canonical collections with independent revision/staleness; an unavailable optional source cannot make the office view fail.

The API uses the existing adapter and versioned VM patterns, with collections paginated and source status included. The proposed canonical API additions are:

```ts
interface HostVM { id: string; label: string | null; platform: string; status: SourceStatus; observedAt: Ms | null }
interface HostAgentVM {
  id: string; hostId: string; orchestratorId: string; name: string | null; runtimeKind: string | null;
  role: 'primary' | 'delegate' | 'unknown'; status: HostAgent['status']; observedAt: Ms;
  linkedAgentId: AgentId | null; // an opaque canonical AgentId; never a native session reference
  identity: 'exact' | 'unlinked';
}
interface TeamVM { id: string; label: string; status: 'active' | 'stale'; members: TeamMemberVM[]; counts: TaskCounts }
interface TeamBoardVM { teamId: string; tasks: TaskVM[]; nextCursor: string | null; revision: number }
interface TaskVM {
  id: TaskId; title: string; state: Task['state']; priority: number | null; owner: MemberRef | null;
  reviewers: MemberRef[]; createdAt: Ms | null; updatedAt: Ms | null; briefPresent: boolean; messageCount: number;
  reportPresent: boolean; reportRef?: { id: string; displayName: LabelRef }; // emitted only to teams.report.resolve principals
  reviews: ReviewVM[];
}
```

Only opaque canonical IDs cross the API; `paneRef`, runtime/session refs, raw filesystem paths, team root paths, filenames, full inbox records, and body content do not. IDs reveal no usernames, paths, hostnames, process arguments, or native runtime keys. `reportPresent` is part of the `teams.read` board projection. An opaque `reportRef` with generic localized `displayName` is returned only when the caller additionally has `teams.report.resolve`; no source basename is exposed in a board row. The server omits fields the caller lacks permission to read before caching/serialization. HTTP snapshots and SSE use the same projection, revision and authorization filter.

## 5. Privacy, authorization, portability, scale and failure isolation

### 5.1 Privacy

Treat pane labels, runtime session refs, titles, task titles, member names, branch/commit/report metadata, and team roots as potentially sensitive. Canonical records and errors are allowlisted; logs contain only source ID, status, counts, bounded error code and request/scan correlation ID—never raw command output, file contents, argv, environment, credentials, paths, title/body snippets, or task IDs tied to a person. Do not persist raw source snapshots or inbox bodies. Filesystem paths are used only inside the private adapter and are not returned in diagnostics. The operator explicitly enables each source and selects team roots. Task titles are visible only to `teams.read` principals; message and brief bodies remain private in v1 even for admins.

### 5.2 RBAC

Extend ADR-002's resource registry with `orchestrators` (host inventory/source status) and `teams` (team/task/review metadata). All new resources and every child action start at `none` for every non-admin role, including built-in editor/reader and custom roles. Admin access follows ADR-002's immutable-admin rule. `orchestrators.read` authorizes host/orchestrator/host-agent inventory; `teams.read` authorizes team/task/review metadata. There are no write routes/actions for these sources in this ADR. Future mutations require separately declared child resources (`orchestrators.integration.install`, `.uninstall`, `teams.source.configure`, etc.) and must default-deny until an explicit, audited grant; they do not inherit parent grants. `teams.report.resolve` is a separately declared sensitive read child, defaults to none for all non-admin roles, and permits only the authorized owner/admin to resolve an opaque `ReportRef` within its configured root. Read permission and source enablement are both required. A user denied `teams.read` sees no team counts, existence, names or revisions; denied `orchestrators.read` sees no host inventory or source status. Avoid shared view caches across users/policy fingerprints.

Installation remains under ADR-002's existing `settings.integrations` resource and recent re-auth/confirmed plan gates. It does not imply `orchestrators.read` or `teams.read`, and neither read resource grants installation. Add-on source configuration is installation-scoped and owner/admin-only under that existing Settings policy; if later exposed to delegated roles, declare a new child action and leave its default at none.

### 5.3 Any environment and scale

Linux, macOS, Windows, and Docker are first-class. Host/platform/root/executable paths come from validated configuration and capability descriptors; never hard-code `$HOME`, `~/.claude`, a shell, or a runtime-specific path in core. A container without a Herdr socket/CLI or mounted team root reports unavailable and otherwise behaves normally. Runtime kind/role vocabularies remain open external strings where provided by a source; canonical state/verdict/source statuses remain closed enums with explicit `unknown`/`unsupported` fallbacks. Canonical IDs and roots are source-scoped so N hosts, N orchestrators, N team roots and N runtimes do not collide.

Pollers have one bounded worker and queue per source instance; coalesce invalidations instead of accumulating snapshots, cancel/release work on disable, cap CPU, bytes, rows and open descriptors, and use jittered backoff. A slow or hostile source never blocks gateway/Claude ingestion or the UI request loop. Immutable snapshot swaps give readers a consistent revision. Metrics are aggregate counts/durations/error categories only. Root-level capability and status are independent so one bad repository cannot hide another.

## 6. Alternatives and consequences

- **Treat Herdr as a runtime adapter:** rejected. Herdr observes processes and status but does not own runtime transcripts or runtime commands; this would duplicate/confuse runtime authority.
- **Merge rows by display name, cwd, workspace, or pane label:** rejected. These values collide, change, and may be sensitive. Only exact source identity can link.
- **Execute `team board --json`:** rejected for v1; the inspected CLI does not expose that flag or a machine-readable board protocol. Read the documented-by-writer files under an explicitly selected root with a strict parser.
- **Expose inbox/task content to make the board richer:** rejected for v1. These fields can contain secrets and arbitrary prompts; metadata gives a useful board without that disclosure.
- **Write to source stores to mirror app state:** rejected. Agent Office is a consumer here. Source mutations would need new contracts, consent, rollback, idempotency and per-action RBAC.

The cost is duplicate-looking rows when exact identity is unavailable, and delayed updates due to polling. Those are preferable to false merges or an unbounded event pipeline. The design permits a future source event stream and explicit owner-approved content scopes without changing the existing read-only default.

## 7. Implementation gate and required regressions

No implementation begins until Critic and Security both say GO on this exact ADR commit. Any contract change requires a new exact review. Then implementation proceeds in independently reviewable steps: canonical schemas/registry and pure identity reconciliation; Herdr reader; team-store reader; read-only API/RBAC/SSE; Settings install plan; finally office/team board views under the designer gate.

Required tests before implementation is considered complete:

1. Herdr fixture contract tests for the actual `{id,result:{type,agents}}` envelope, unknown/missing fields, every status, empty list, bad JSON, output/row/timeout bounds, unsupported version, disappearing binary, stale snapshot/backoff, disable cancellation, and concurrent-poll suppression. Assert no shell and no non-allowlisted environment.
2. Team-store fixtures generated by the real writer for task states, reviewers, history, inbox JSONL, atomic `.tmp` replacement, truncated final line, invalid JSON, unsupported values, symlink swap, directory escape, non-regular files, giant/deep files, aggregate caps, duplicate roots, permission errors, concurrent updates and root isolation. Assert the adapter never writes and never executes `team`.
3. Identity matrix: exact shared reference links once; two identical names in separate panes do not link; same runtime in two panes does not link absent exact evidence; reused pane ref with a new orchestrator scope does not link; ambiguous/mismatched/stale IDs remain unlinked; Claude session/agent history is never duplicated or merged; link loss unlinks on next immutable snapshot.
4. Privacy regressions seed task titles, briefs, messages, paths, process args, report basenames and session refs with unique canaries: task titles may appear only in authorized team views; no brief/message body, filename, path, argv, environment value, credential, or session ref appears in canonical/public VMs, unauthorized HTTP/SSE, logs, metrics, errors, screenshots outside an authorized team view, or export paths. With `office:read` but without `orchestrators.read`, both HTTP snapshot and SSE delta contain none of the host canaries (host ID, role/status, pane ref, title, session ref, source status); with `orchestrators.read`, a linked occupant may contain only opaque hostAgentId, role and closed status, and the title/session ref remain absent. With `teams.read`, a report shows only `reportPresent`; a canary filename does not appear in HTTP/SSE. `teams.report.resolve` receives only an opaque ID plus generic localized display name, and resolution rechecks root containment and file identity. Owner consent/config boundaries and policy-cache isolation are tested.
5. RBAC exhaustiveness across registry, HTTP, VM, SSE snapshot/delta/replay, logs and settings frames: no grants for editor/reader/custom by default; admin read works; unknown resource/child denies; source disabled denies reads; `teams.read` and `orchestrators.read` do not grant any future mutation; cache keys include user and policy revision.
6. Multi-root/host scale, pagination/cursor/revision consistency, bounded worker/queue/memory, failure isolation and recovery. Portability runs on Linux/macOS/Windows/Docker fixtures and never reads real home/config data.
7. Integration plan/apply/uninstall tests use temporary homes and fake adapters only, require recent re-auth and explicit target consent, show exact plan, preserve modes, safely back up, roll back on failure, and remove only unchanged owned files/directories when empty. No test probes or modifies a real user home or host runtime.

This ADR has not run implementation tests; it records contracts and acceptance evidence required of later commits.
