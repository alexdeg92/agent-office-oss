# Agent Office API, contract 3.5 (`/api/v3`)

**Status:** served on `/api/v3` (G5, architect-35; ADR-001 §9 and §12). Examples: `examples/v3/`. The runtime check validates every 3.0 VM against the 3.0 schemas (`VM_SCHEMAS_V3`; the frontend's `validateVM(name, vm, 3)`).

**3.5 changelog (2026-10-12):** TeamsVM members use canonical roleKind (`lead|member|unknown`) and a bounded source-native roleLabel; leadership derives from source roles or parent/child structure, never provider labels in core.

**3.4 changelog (2026-10-10):** HealthVM adds canonical adapter-declared checks and bounded remedy audit records; generic remediation routes run one-click or every safe remedy without provider-specific core/UI branches. **T-0053 additive:** `OccupantVM.isNew?: boolean` marks an auto-added agent during its first 24 hours.

**3.3 changelog (2026-10-10):** Config v3 enables multiple independent runtime instances. Canonical IDs carry instance provenance, `MetaVM.runtimes` declares per-source capabilities and status, Settings adds full-set `PUT /settings/runtimes`, per-instance fields/checks and multiline filters. Claude Code is a bounded local read-only transcript connector. Config v2 reads remain supported; v2 wire aliases resolve only in the legacy source. The core-owned Settings restart and boot identity contracts remain unchanged.

**3.2 changelog (2026-10-09):** AccessVM agents add neutral nullable `modelSource` (`explicit|inherited`) and external `runtime` harness metadata (T-0008), shared with 2.7; locked missing-secrets setup and named partial-login boot errors; the setup/owner recovery, config v2 and safe installation contracts of api.md 2.7 apply on v3 too. Peer occupants add role `agent` and id `agent:<agentId>`; delegates retain their own identity/KPI. Setup fixtures are shared across v2/v3.

**What 3.0 is:** the same API as 2.8 (api.md), on **`/api/v3`**, with the **open vocabularies as the canonical names** and **no personal value or field name**. Every route, method, body, envelope, error code, SSE frame and rule of api.md 2.8 applies unchanged, **except the deltas D1–D10 below**. A VM not listed here has the same shape and values as in 2.8 (its example is `examples/<name>.json`). The v3 examples are written for a foreign instance (primary agent `atlas` « Atlas », Telegram, Europe/Paris), so none of them carries a home-instance value.

**2.x stays.** `/api/v2` serves revision 2.8, from the same canonical core through the 2.x projection (`project2x`), until the frontend and office have moved (then S16 removes it). Both versions share one engine, one store, one set of runtime reads and one chat state; only the VM projection differs. A client uses ONE version for everything (views, commands, stream): a v3 topic is never sent on a v2 stream, nor the reverse.

## D1 · MetaVM
- `apiVersion: 3`, `contractVersion: '3.5'` (also in the stream's `hello`).
- **`runtimes`**: configured instance descriptors `{id,adapter,name,enabled,connection,capabilities}`, including disabled instances. Singular `runtime` describes the primary's source (or first enabled source), and is null when none are enabled. Entity IDs carry provenance; runtime command capability comes from that entity's source.
- **`runtime`**: `{ id, name, gatewayLabel, version: string | null, capabilities }`. `capabilities` is the adapter's declaration (ADR §3): `sessions`, `transcripts`, `activity`, `flows {read, write, schedules}`, `skills {read, toggle, detail}`, `channels`, `interlocutors`, `chat`, `restart`, `costs`, `subagents`, `sessionGroups`. **The UI hides or disables by capability**; a command whose capability is false is 404 `not_found`.
- **`instance`**: `{ name: string | null, timeZone, locale, configured }` (`name` from setup or `AO_INSTANCE_NAME`).
- **`locales`**: `['fr', 'en']`.
- **`labels`** has the 3.0 keys (`sessionKind.primary`, `occupantRole.direct`, `runtimeKind.*`, `interlocutorKind.*`, …) and no 2.x-only key. For an authenticated owner it also has **dynamic** entries for open vocabularies: `channel.<ref>`, `provider.<id>`, `model.<id>`, `agent.<id>`, for every value that occurred (the adapter's label, else the raw value). **A client never assumes a closed list in those namespaces**, and a missing key renders the raw value (never « autre », never the key).
- **`enums`**: `sessionKind` (D2), `occupantRole` (D3) and `interlocutorKind` (D5) are the 3.0 lists; **`channel` is removed** (open).

## D2 · Session kinds and channels (`LogRowVM`, `SessionVM`, logs query)
- `kind`: `'primary' | 'agent' | 'subagent' | 'scheduled' | 'conversation-direct' | 'conversation-group' | 'conversation' | 'internal' | 'unrecognized'`.
  - `conversation` = a chat-shaped key whose scope the adapter doesn't know (still interactive, still in the office).
  - `internal` = a runtime's own session (OpenClaw: dashboard, ACP, explicit keys).
- **`runtimeKind: string | null`** (new, after `kind`): the runtime's own kind for an `internal` session (`dashboard`, `acp`, `explicit`), else null. Labelled `runtimeKind.<x>` (raw fallback).
- `channel`: a **`ChannelRef`** (`^[a-z][a-z0-9-]{0,31}$`: `discord`, `telegram`, `slack`, `matrix`…) or null. **`unrecognized` doesn't exist in 3.0.**
- `GET /api/v3/views/logs?kind=` takes a 3.0 kind (`internal` included); a 2.x kind is 400. Topics `logs?kind=<3.0 kind>`.
- Conversation titles use a known person name for DMs; unknown people use `sessionTitle.user` with an empty `{id}`. Room titles may retain their channel identifier.

## D3 · OfficeVM (and the office's journal)
- `OccupantRole`: `'primary' | 'agent' | 'subagent' | 'scheduled' | 'direct' | 'group' | 'conversation' | 'session'`; `session` labels a runtime session when its source has no chat-channel concept and uses `occupantRole.session` with a provider name. Layout matching treats it as a conversation. `roleLabel` is `occupantRole.<role>`.
- `OccupantId`: **`'primary'`** for the primary agent, else `'<role>:<subject>'` (`scheduled:<jobId>`, `direct:<interlocutorId or key>`…). The same ids in `journal[].occupantId`, cues and LiveEvents.
- `ruleId`: the layout rule's id (3.0 layout names, D4).
- `isNew?: boolean`: true for an auto-added agent during its first 24 hours; otherwise omitted.
- `rosterFloors[].mobileLabelIds`: ordered, backend-selected IDs for up to three non-conversation occupants per floor whose names remain visible on the mobile map. Active-work occupants come first, followed by canonical team roots and roster order; each ID is also in that floor's `occupantIds`.
- Optional `homeTarget` and `sceneTarget` carry the backend-reserved home and current destination. `activity` carries the stable selected activity/spot and start time; `sceneTravel` carries stable doorway endpoints for a floor transition. The backend owns threshold, spot and capacity selection and the return-to-home decision; the browser animates only.

## D4 · LayoutVM and the layout commands

The additive `allowNoDesk?: boolean` is backend-provided editor validation policy. Floor-scoped layout reads/topics, writes, theme changes and version reads use `floorId` with the same backend projection/merge as v2 (api.md §3.10); canonical v3 identity rules and permission/redaction checks remain unchanged.
- Layout rules use the 3.0 names: `agents[].agentId` `'primary'`, `'*subagent'`, `'*scheduled'`, `'*direct'`, `'*group'`, `'*conversation'`; `match.kind` the D3 roles. `agentsSeen[]` ids and roles too.
- `layout.data.agents[].appearance` and `default.data.agents[].appearance` optionally declare `'auto' | 'manual'` (T-0052): auto uses the persisted first-sight assignment; manual uses the owner's chosen character/variant/accessories. Legacy rules without the field remain accepted. Both authoritative LayoutVM examples include auto on the shipped seed rules.
- Stored layouts are **not rewritten in place**: they are read in either vocabulary, **normalised to 3.0 names on save**, and served in the caller's version (`/api/v2` gets 2.x names). `PUT /api/v3/office/layout` accepts 3.0 names only.
- **`layout.data.presence`** `{ seenMinutes: 0–1440 }` (optional, office-dev O8): how long an occupant stays in the editor's seen inventory. 2.x reads don't show it, and a 2.x save keeps the stored value (operations.md §4).
- **`layout.data.idleRelocationMinutes`** `{ 1–1440 }` (optional): idle duration before an occupant may be assigned to a declared activity spot. Defaults to 15 minutes when absent; this value is persisted in the office layout, not instance configuration.
- `manifest` is unchanged (office-dev's opaque art data; its character `role`s are asset metadata, not occupant roles).
- **Office-dev dependency:** `layout-rules.js` accepts both vocabularies (ADR §12.6) before the office moves to v3.

## D5 · AccessVM, InterlocutorVM
- Interlocutors of **every** channel (2.x shows Discord's only).
- `kind`: **`'user' | 'room'`**, plus **`channel: ChannelRef`** (after `kind`). Ids stay opaque and unchanged (`discord-user:<sf>`, `discord-channel:<sf>`, `telegram-user:<id>`, `matrix-room:<id>`); route ids are those.
- `resolution` adds **`'unresolvable'`**: the channel has no enricher (no name or avatar will come). `name`/`avatarUrl` are then null.
- `access` fields are null where the runtime config has no policy for that channel. `InterlocutorVM.profile` is the channel enricher's (Discord: as 2.5) or null.

## D6 · HealthVM
- `channels[].id` is the `ChannelRef` (2.x prefixed unknown ones `raw:<id>`); `label` is the adapter's label.
- Adds `healthChecks[]` (`HealthCheckVM`) with canonical severity, cause and localization keys, remedy kind and resolved time; adds `healthAudit[]`. The same fields are served on v2 contract 2.8.

## D7 · Flows
- `FlowDetailVM.job.agentId`: the agent that runs the job: the job's own agent, or **the primary** when the runtime's job names none. Never a guess.
- **`job.ext.openclaw`** `{ sessionTarget, wakeMode }`: OpenClaw-only fields move to the adapter bag (`job.ext.<runtime>`, opaque to shape checks, documented per adapter). `job.sessionTarget` / `job.wakeMode` are gone. Shown as detail rows when present.
- `runs[].delivery.channel`: a `ChannelRef` or null.
- `POST /api/v3/flows` accepts optional **`runtimeId`** (required when several eligible sources exist) and **`agentId`** (a listed agent; default the primary) when `runtime.capabilities.flows.multiAgent` is true; otherwise it's 400 `unexpected-field`.

## D8 · Projects
- `BoardVM.filter`: `'all' | 'at-risk' | 'with-agent' | 'archived'`, plus **`BoardVM.agent: AgentId | null`** (after `filter`): the agent of `with-agent` (default the primary), else null.
- `GET /api/v3/views/projects?filter=with-agent[&agent=<id>]`; topics `projects?agent=<id>&filter=with-agent`. **`with-timmy` is 400 on v3** (on v2 it stays, meaning `with-agent` for the primary).
- History actors are unchanged (`ActorVM`, names are data).

## D9 · Labels that name an agent
- Every label that named the home agent takes `{agent}` (already true in 2.5: `kpi.idle`, `skillOutput.agent-reply`, `liveEvent.*`). 3.0 adds no key with a personal name, and the lint (`test/portability`) keeps it so.

## D10 · Not in 3.0
- The v1 API (`/api/*` without a version) was removed at S16; only `/api/login`, `/api/logout` and `/api/me` remain (the `/v2` UI signs in through them).
- 2.x-only label keys (`sessionKind.main`, `occupantRole.dm`, …) and the `channel` enum.

## D11 · Orchestrator and team read projections (T-0045)
- `GET /api/v3/orchestrators` → `Ok<OrchestratorsVM>` and a principal-scoped `orchestrators:<opaque-scope>` topic. Requires the current principal's `orchestrators.read` grant and an enabled Herdr source (owner-enabled or detected and responding with its declared default); absent or disabled sources return `404 not_found` without a source inventory.
- `OrchestratorsVM` contains `hosts`, `orchestrators`, `agents`, a source `revision`, independent `hostRevision` / `teamRevision`, and `observedAt`. Rows contain opaque canonical IDs and allowlisted platform, kind, label, runtime kind, role, status and timestamps only. Pane/session refs, terminal titles, paths and command output never cross the API.
- `GET /api/v3/teams` → `Ok<TeamsVM>` and a principal-scoped `teams:<opaque-scope>` topic. Requires the current principal's `teams.read` grant and an explicitly selected team-store root; no configured root returns `404 not_found`.
- `TeamsVM` contains one selected `team`, registered `members`, `tasks`, safe read diagnostics and `revision`. Task rows contain title/state/priority, opaque owner/reviewer IDs, timestamps, report/brief presence and message count, plus review verdict metadata. `diagnostics.skippedTaskCount` and `diagnostics.skippedMemberCount` report bounded counts of malformed source rows skipped; `diagnostics.skippedCount` is their server-computed total, `diagnostics.partialLabel` is its localized `LabelRef` or null, and `diagnostics.quality` is `partial` when the total is nonzero, otherwise `complete`. The client renders these fields without recomputing the total or message. The service emits value-free warnings when either source count changes; it never logs task or member IDs, filenames, contents, or the selected source path. Briefs, review notes, inbox/message bodies, source paths and report basenames are never returned. Report resolution remains a separately authorized future operation; the read board emits no source-derived report reference.
- Member roles are canonical `roleKind: lead | member | unknown` plus a bounded `roleLabel` retained for display. Each source adapter maps its native role vocabulary; if it supplies no role, the source adapter derives leadership only from parent/child structure. Core projections branch only on `roleKind`, never a provider or harness label.
- A board member may include `runtimeKind` (the adapter's open canonical runtime identifier), an adapter-declared `brand`, `parentMemberId` (the stable opaque ID from the selected team store), `sessionStatus` (`known` or `unknown` for the private member-to-Herdr session comparison), and `spawnedBy: {agentId,sessionKey,via,label}` or null. The presentation uses the shared connector-brand component for the declared mark; it never invents provider badges. `parentMemberId` supports grouping without comparing names; `spawnedBy` is canonical runtime lineage, with runtime-scoped IDs, source-declared `via`, and redacted `label`. A pane-linked registered member appears in the office once: an exact runtime session link reuses that occupant, otherwise the exact team-member/pane reference supplies its office identity. A stale member session ref keeps the registered member visible with `sessionStatus: "unknown"` and does not create a second Herdr avatar. A resolved parent reference groups it under the PM. An exact Herdr/runtime link removes that pane from the Herdr `agents` list; ambiguous or unlinked observations remain there and never join by name.
- Stable team records are read-only: `members/<name>.json` (or `team member list --json`) supplies opaque `member:<uuid>` IDs, `herdrPane`, native `session`, and stable `spawnedBy` member IDs. Link the launcher pane through the referenced member's `herdrPane`; use exact session IDs to reconcile connector sessions across runtimes. Names remain display-only.
- Topic scopes bind the user ID and permission revisions/fingerprint; their cached VMs never cross principals. The v3 stream resolves the current principal on open/add/resync/resume and rechecks it before emitting source-topic changes. Source snapshots use the same allowlist as HTTP before VM validation or serialization; source refresh invalidates only the corresponding v3 topics. The shared v2 office topic is unchanged and carries no host-derived fields.
- Examples: `examples/v3/orchestrators-vm.json` and `teams-vm.json`; the server validates both with `VM_SCHEMAS_V3`.

## Commands, stream, errors
- Every 2.5 command exists on `/api/v3` with the same path, body and result, except D4's layout names and D7's `agentId`. CSRF, the agent token (§5.6, with its v3 paths), setup (§5.7) and the read-only rules are identical.
- `GET /api/v3/stream` and its transport POSTs work as §4, with v3 topic VMs and `contractVersion: '3.5'` in `hello`.

## Changelog
| Version | Date | Changes |
| --- | --- | --- |
| 3.5 | 2026-10-12 | TeamsVM members add canonical roleKind and source-native roleLabel; core team projections are provider-neutral. |
| 3.4 | 2026-10-10 | Canonical HealthCheckVM rows and adapter-driven remedies; health action routes and audit records. |
| 3.0 | 2026-10-06 | First 3.0 contract (G5): D1–D10. Examples `examples/v3/` (`meta-vm`, `office-vm`, `logs-page`, `session-vm`, `access-vm`, `interlocutor-vm`, `health-vm`, `flow-detail-vm`, `board-vm`, `layout-vm`), held to these deltas by `test/api/contract-v3-examples.test.js`. |
| 3.3 | 2026-10-10 | T-0045 adds owner-gated, read-only orchestrator and team board collections/topics (D11); examples and runtime schemas cover the allowlisted projections. |

## Sender extension · revision 3.1

The shared [Sender/Participant contract](sender-identities.md) also applies on `/api/v3`: `senderInfo` on trace and chat messages, a `participants` collection for humans and primary agents plus `subagents` for delegated sessions on SessionVM, and metadata-free prose. Its runtime/channel fields are open identifiers. SSE hello advertises 3.5. Version 2 advertises 2.8 and retains its compatibility sender string.

## Settings extension · `/api/v3/settings` (T-0016)

Authenticated instance settings are a v3-only extension, updated for multi-runtime in contract 3.3. They do not reopen first-run setup. Cookie owner sessions only; scoped agent tokens cannot read settings or execute their commands. Every response is `no-store` and uses `Ok<T>`. Every write, including check/detect/reauth/plan, requires the existing CSRF guard. Examples and shape sidecar: `examples/settings/`; server schema: `VM_SCHEMAS_V3.settings` (`SettingsVM`).

### SettingsVM

`GET /api/v3/settings` → `Ok<SettingsVM>`. A read does not launch a detector, binary, external network probe, or gateway check. Cached results start as `not-configured`/not checked until explicitly checked or detected; live connection status is available immediately for the selected runtime.

```ts
type Source = 'env' | 'file' | 'default';
type Field = { value: string | number | boolean | null; source: Source;
  editable: boolean; reason: LabelRef | null };
type FieldDefinition = { id: string; label: LabelRef;
  type: 'text' | 'textarea' | 'url' | 'secret' | 'number' | 'boolean' | 'select';
  required: boolean; writeOnly: boolean; options: {value: string; label: LabelRef}[] };
type ConnectionField = Field & { tokenSet?: boolean };
type HerdrCheckStatus = 'not-checked' | 'available' | 'unavailable' | 'unsupported' | 'stale' | 'not-detected';
interface DiagnosticFix {
  id: string; // opaque, server-declared selection ID; never parse it for routing
  kind: 'integration.install' | 'integration.update' | 'integration.review'
    | 'runtime.enable' | 'runtime.configure' | 'agent.configure' | 'instance.restart' | 'client.reload';
  target: { runtime: string | null; agentId: string | null; integration: string | null };
  label: LabelRef; detail: LabelRef | null;
  automatic: boolean; requiresInput: boolean; requiresConsent: boolean;
  requiresReauth: boolean; requiresRestart: boolean;
}
interface SettingsVM {
  revision: number; readonly: boolean; disabledReason: LabelRef | null;
  reauth: { expiresAt: number | null; windowMs: 300000 };
  restart: { supported: boolean; command: string | null; reason: LabelRef | null };
  instance: { name: Field; locale: Field; timeZone: Field };
  owner: { displayName: Field; email: Field; passwordChangeEnabled: boolean; reason: LabelRef | null };
  network: { mode: Field; host: Field; port: Field; publicUrl: Field; cookieSecure: Field;
    active: {mode: string; host: string; port: number; publicUrl: string | null; cookieSecure: boolean};
    restartRequired: boolean };
  herdr: { found: boolean; enabled: boolean; active: boolean; status: HerdrCheckStatus; checkedAt: number | null; brand?: Brand | null };
  // The source adapter declares autoEnableDefault: true. With sources.herdr absent,
  // detection AND a valid response enable the source; presence alone stays off.
  // Explicit sources.herdr=false persists the owner's opt-out; active is the running reader.
  runtimes: Collection<{ id: string; adapter: string; enabled: boolean; candidate: boolean; name: string; optional?: boolean; found: boolean; supported: boolean; selected: boolean;
    detection?: {status:"not-checked"|"detected"|"not-detected"|"unreadable"|"enabled", checkedAt:number|null};
    confidence: string; reason: LabelRef; checkedPaths: string[];
    fields: Collection<FieldDefinition>; values: Record<string, ConnectionField>;
    connection: { status: 'connected' | 'unreachable' | 'refused' | 'unauthorized' | 'not-configured' | 'unsupported' | 'unsupported-format' | 'capacity-limited';
      protocol: number | null; latencyMs: number | null; checkedAt: number | null } }>;
  agents: Collection<{ id: string; agentId: string; runtime: string; name: string | null;
    detectedName: string | null; nameSource: string | null; configured: boolean; hidden: boolean;
    isPrimary: boolean; model: string | null; lookRoute: string | null;
    integrations: Collection<{id: string; status: 'installed' | 'outdated' | 'modified' | 'missing' | 'unsupported'}> }>;
  diagnostics: Collection<{id: string; level: 'error' | 'warning' | 'info' | 'ok'; label: LabelRef;
    detail: LabelRef | null; section: 'diagnostic' | 'runtimes' | 'connection' | 'integrations' | 'instance' | 'account'; fix: DiagnosticFix | null}>;
}
```

Each adapter declares its own field definitions and owns reading, validation, detection, check, discovery, connection pair matching, environment overrides, and integration targets. Clients render `fields` and `values`, without testing an adapter id. A presence-only runtime is visible with `supported:false`, empty fields, and an informational reason; it cannot be selected for a live connection. Several configured instances may be enabled together, including several of the same adapter. `id` is the stable configured instance ID; `adapter` names the implementation. A candidate is catalogue/discovery data, not a saved instance. `selected` is a compatibility alias for `enabled`. Agent row ids use the canonical `rt:<instance>:agent:<base64url(nativeId)>` codec; commands use the separate native `agentId` together with the instance ID in `runtime`. The editable instance `name` defaults to the adapter name; opaque instance IDs are routing data, not card text. `optional:true` lets inactive demonstration connectors collapse their fields/check while keeping the enable toggle. Presence-only entries show « Détecté · connecteur à venir » or « Non détecté · connecteur à venir » according to `found` (English parity), plus a reason. They cannot be enabled.

Write-only field values are **always null**, with only `tokenSet:boolean` for whether a credential exists. An omitted token preserves the saved credential only for the same instance ID, adapter and URL. New instance IDs require explicit credentials even for the same endpoint. A different URL or adapter requires an explicit credential (where the adapter declares it required). The service never pairs a saved local token with a remote URL. Detector tokens remain server-side; neither detection output nor SettingsVM contains them.

`source:'env'` means the effective value is imposed by the process environment, so `editable:false` and `reason:{key:'settings.envOverride',params:{variable:<declared env name>}}`. A command attempting to change such a field fails 403 `forbidden` `{issue:'env-override',field:<declared field name>}`; it never saves an ineffectual alternative. Derived network fields are also not editable. Environment-only/legacy owner credentials cannot be changed from the UI; the account section gives the reason. `readonly` includes the instance or Store write restriction; all mutations and re-auth are disabled with 403 `readonly`.

`name:null` means no name was found/chosen (render « Nom à choisir »); the id stays visible. `detectedName` and `nameSource` explain discovery independently of a chosen name. `lookRoute` is app-relative, e.g. `/boutique?onglet=personnages&agent=primary` or `agent=agent%3Ascribe`; the UI rebuilds it through its router to preserve the deployment mount prefix. `network.active` is the listener configuration of this process; editable network fields show the desired configuration. Their difference sets `restartRequired`. Diagnostics include selected runtime status/protocol/latency, runtime and agent presence/configuration/integration, config/secrets permissions, stale-build and pending restart, with section links.

Runtime diagnostics include selected or found instances. Detection merges into the matching configured instance through the single adapter-identity association shared with runtime/agent rows (normalized local config identity or gateway), never through adapter kind alone. Distinct instances of the same adapter remain separate. Absent inactive catalogue entries produce no warning.

The Diagnostics v2 extension (T-0028) uses one severity source: `error` prevents operation, `warning` needs owner action, `info` has nothing required to fix, `ok` is healthy. Only error/warning count as attention. Unsupported connectors and unsupported integrations are info with `fix:null`; healthy configured agents are ok. Missing/outdated supported owned integrations are warning and declare automatic install/update. Modified or foreign files require manual review, never automatic overwrite. Single-row buttons use the same `fix` data as Fix all.

`fix.target.runtime` is an instance ID (or candidate ID for a configure link), paired with native `agentId` and declared integration ID where applicable. It contains no filesystem paths or credentials. Labels use the normal LabelRef dictionary. Read-only VMs declare no actionable fixes. Unconfigured agents and connection/configuration actions declare manual links. Disabled saved runtime instances can declare `runtime.enable` with `automatic:false`, `requiresConsent:true`, `requiresInput:false`, and a privacy explanation. Unconfigured candidates declare `runtime.configure` with `requiresInput:true`; a credential is never silently taken from detection to enable a runtime. All runtime.enable selections start unchecked.

`settings-fixall-vm.json` illustrates automatic install/update, manual review/configuration and explicit runtime consent. `fix-all-request.json`, `fix-all-result.json`, and `fix-all-partial-result.json` illustrate selection and outcomes. Integration actions retain their existing `settings.diagnostic.integration.<status>` / `integrationDetail.<status>` labels (missing/outdated/modified/unsupported).

### Commands

`CommandResult` is the existing `{ok:true,result,revision:number|null,vm:SettingsVM|null}`. Configuration saves require `expectedRevision` from the current VM; mismatches return 409 `conflict` `{issue:'settings-revision'}`. Successful saves return the new revision and fresh VM, including source/read-only reasons. A failed check is a 200 result with `ok:false`.

| Route | Body | `result` / behavior |
| --- | --- | --- |
| `POST /settings/reauth` | `{password:string}` | `{expiresAt:number}`. Confirm the current owner password. Shared login throttle; failure is 401 `unauthorized` with `{issue:'current-password'}`, throttled/busy is 429. A wrong confirmation does not revoke the session; the client can suppress its generic session-expired notification for this request. No configuration change. |
| `POST /settings/check` | `{runtime:{id?,adapter,...adapter fields}}` | `{ok,status,protocol,latencyMs}` plus adapter-owned safe diagnostics such as `projectCount`, `fileCount`, `ignoredLineCount`, and a value-free `reasonCode`. Same adapter-owned one-attempt check as setup. When testing an edited URL/credential, re-auth is required before any connection. Check/discovery clients close in `finally`; no retry loop. |
| `POST /settings/detect` | `{}` | `{runtimes,agents}` plus fresh VM/revision. Re-run adapter detectors for every runtime, then discover agents through the enabled instances. Does not publish detected values or silently change the active connection. |
| `POST /settings/herdr/check` | `{}` | Read-only one-shot `herdr agent list` check. Returns only `{found,status,agentCount}`; pane names, refs, terminal metadata, and contents are not returned. |
| `PUT /settings/agents` | `{expectedRevision,runtime,primary:string|null,agents:[{id,name:string|null,hidden:boolean}]}` | `{changed,restartRequired:false}`. Replace the chosen instance's configured agent set; adding, renaming, hiding, removing, and primary selection use this one operation. Ids unique; primary must be a listed visible agent. Runtime-found removed agents remain visible as `configured:false` after detection. Live office names/primary/presence refresh immediately. |
| `PUT /settings/runtime` | `{expectedRevision,runtime:{adapter,...adapter fields}}` | `{changed,restartRequired:false}`. Re-auth required for connection/credential changes. Check the candidate first; failed connection is 502 `upstream_failed` with a closed status reason and leaves config/live runtime unchanged. Compatibility operation for a lone legacy instance; it cannot erase a collection (409) or change an existing ID's adapter (400 `instance-id-required`). Use the full-set operation for a new adapter ID. |
| `PUT /settings/runtimes` | `{expectedRevision,runtimes:[{id,adapter,enabled,name?,...adapter fields}],herdrEnabled?:boolean}` | `{changed,restartRequired:false}`. Replace the full configured set (maximum 32), with recent re-auth. Optional `name` is trimmed, 1–80 characters without control characters; omission preserves a saved name. Omitting `herdrEnabled` preserves the automatic/explicit source preference. `herdrEnabled` explicitly opts the read-only Herdr source in or out; enabling requires successful Herdr detection. Changed enabled runtime sources pass their adapter check before publication; disabled sources require no connection. Herdr reads presence/status metadata only and starts or stops without a process restart. Files, source state and revision publish together. |
| `PUT /settings/instance` | `{expectedRevision,name?,locale?,timeZone?}` | `{changed,restartRequired:false}`. Name 1–80, locale fr/en, IANA time zone. |
| `PUT /settings/network` | `{expectedRevision,mode,port,publicUrl}` | `{changed,restartRequired:boolean}`. Re-auth required. Same validation/derived host/cookie policy as setup. Save desired values; current listener/cookie/CSRF origin remains unchanged until restart. |
| `PUT /settings/owner` | `{expectedRevision,displayName?,email?}` | `{changed,restartRequired:false}`. Database owner only; displayName 1–80, valid email. Email change requires re-auth; owner Person and DB account remain consistent. |
| `POST /settings/password` | `{password:string}` | `{changed:['owner.password'],restartRequired:false}` plus VM/revision. Database owner only; re-auth required, 12–1024 characters. Invalidates other owner sessions and consumes the confirmation window. The current session remains usable. |
| `POST /settings/integrations/plan` | `{runtime,locale?}` | Existing setup plan `{planId,agents:[{id,status,files,uninstallFiles}],backupDir}`; status retains setup's `installed/absent/outdated/conflict/unsupported` vocabulary. Server-owned targets only, no client paths; ten-minute expiry; plan writes nothing. |
| `POST /settings/integrations/apply` | `{planId,agentIds,confirmed:true,action?:'install'|'uninstall'}` | Existing setup apply `{agents:[{id,status,changed,backup,reason}]}` plus fresh VM/revision. Re-auth required before every mutation. Repair uses `install` on an outdated owned installation. All selected targets apply or restore together; no forced overwrite of a foreign/modified installation. |
| `POST /settings/fix-all` | `{expectedRevision,confirmed:true,items:[{id,consent?:true}]}` | Run only currently declared selected fixes through existing reviewed commands. Unique IDs, 1–100 items. One recent owner re-auth covers the batch, checked before each mutation. Runtime enable additionally requires that item's explicit consent. Result `{items:[{id,status:'applied'|'failed'|'input-required',changed:string[],error:{code,issue}|null,restartRequired}],restartRequired}` with fresh VM/revision. No automatic restart. |
| `POST /settings/restart` | `{expectedRevision,bootId,confirmed:true}` | `{accepted:true,bootId}`; current revision, `vm:null`. Owner session, CSRF and recent re-auth required. The owning Agent Office process exits with dedicated restart status 75 only after the successful response has flushed; its host supervisor restarts it. Never a gateway command. |

Bodies reject unknown fields; missing/invalid values return 400 `validation` with declared field names, never input values. Re-auth expires after **five elapsed minutes**, is bound to the signed owner session, is checked again after asynchronous work and before mutation, and is cleared on logout/password change. Missing/expired confirmation is 403 `forbidden` `{issue:'reauth-required'}`. Revoked/expired/non-owner sessions are 401. Token, URL, network, password and integration changes cannot use an agent principal or another session's confirmation.

Setup and settings call one shared publisher: lock, pinned parent, unpredictable exclusive no-follow temporary file, writes through the descriptor, 0600, durable publication and config digest. A failed two-file update restores both reviewed preimages; no second `config.json` writer. Configuration mutation and DB owner amendment are serialized and use the expected revision. Audit entries contain **declared changed field names only**, no values, credentials, password, gateway URL or request body.

### Fix all orchestration (T-0028)

The batch is an explicit list of the latest VM's opaque fix IDs; it is not a write API for arbitrary kind/target/path/adapter/token fields. Unknown fields, duplicates, unknown IDs, missing confirmation, or invalid selections reject the entire request before mutation. Expected revision pins the reviewed state; stale revision is 409. Owner cookie, CSRF, non-readonly store and recent per-session re-auth are required, including a batch containing only manual links. `runtime.enable` without per-item `consent:true` is rejected before any mutation. The server never includes runtime enable in automatic selection.

Automatic integration install/update calls the same integration plan then confirmed apply commands, with server-owned workspaces, fingerprints, backups, symlink safeguards and per-item transactional restore. Explicit runtime enable calls the existing full-set runtime command, retaining every other runtime's private options/credentials and checking the enabled source before publication. Manual configuration, agent configuration, review, reload and restart fixes return `input-required` without mutation; the UI routes through their declared target/section or existing restart flow.

Execution is sequential. Each selection is revalidated against current declared fixes after asynchronous work; external revisions produce a conflict for the affected item, never a blind overwrite. A failure is reported for that item and successful earlier writes remain committed; every requested item gets a result in request order. No silent skip and no transaction spanning different items. An expired/revoked confirmation prevents subsequent writes. Closed error codes/issues contain no paths, content, credentials or request values. Every automatic item uses existing command auditing with declared field names; the batch produces one result per item.

`result.restartRequired` is the final effective network pending flag, including a pending change that existed before this batch. Integration file refresh and live runtime enabling do not manufacture a host restart requirement. The sheet offers the separate existing Restart action when this flag is true, and after a new boot reloads and reads Diagnostics again. A failed or partial batch can still need a restart; successful prior changes are retained. The endpoint never exits a process or issues a gateway restart by itself.

### Restart and process identity (T-0020)

Both `GET /api/v2/meta` and `GET /api/v3/meta` include top-level `data.bootId`, a nonempty opaque identifier stable for this process lifetime and different after a new boot (not the frontend build id). The UI reads it before restart and uses the accepted result's bootId as its polling baseline. Poll meta without cache until bootId differs, then reload. A timeout retains manual guidance and offers polling retry only; never automatically repeat the restart POST.

The public metadata projection is bootstrap-only: static labels, null primary/runtime/instance name, empty runtimes and no source inventory. A valid owner cookie enriches the same endpoint with private names and dynamic labels. Invalid/expired/revoked sessions get public bootstrap; bearer privileges do not mix with cookies. Both projections retain the same process bootId. See [api.md §3.1](api.md#31-metavm-mevm) for cache and client auth-transition rules.

`SettingsVM.restart` is a host capability, independent of runtime adapters. With an explicit supervisor restart-policy declaration, `supported:true`, `command:null`; standalone instances expose `supported:false`, a command to start Agent Office and a reason LabelRef. Read-only instances disable the action. The fallback command is displayed as text, never executed by the API. Only the process owning the config exits (the API unit in a split API/web deployment).

Restart requires explicit confirmation and the current revision and bootId. Stale revision returns 409 `settings-revision`; a different boot returns 409 `boot-changed`; missing confirmation is 400, missing/expired re-auth is 403. Accepted restarts consume confirmations and are globally limited to one per 60 seconds, persisted across process boots; rejected attempts return 429 with `Retry-After`. Unsupported hosts return 403 `restart-unsupported`. Responses are no-store, and attempts are audited as `settings.restart` with no command or credentials. A disconnected request before response finish does not exit the process. Examples: `restart-request.json`, `restart-result.json`, `settings-restart-manual-vm.json`.

### Stream refresh

The owner-authenticated v2 and v3 streams both add event `settings` with `{revision,changed:string[],restartRequired:boolean}`. It contains no SettingsVM and no credentials or session-specific re-auth state. The payload is identical across versions (it contains no projected VM), so Settings tabs using the app’s default v2 stream refresh too. Clients refetch `GET /api/v3/settings`; agent/instance updates also invalidate meta/office and relevant views so open tabs see renamed/added/hidden agents. Settings commands do not require a running gateway to edit instance/account/network or plan local integration recovery.

### Config v3 and Claude Code (T-0022)

Config v2 remains readable. Startup/GET use an in-memory v3 upgrade and do not rewrite the files; the first successful mutation publishes config and secrets v3 through the shared publisher. Migration 019 maps typed persistent agent/session references, preserving Person IDs, token hashes, owner authentication and unrelated data. Legacy-only v2 wire aliases never fan out to another source. See ADR-001 §13 for the codec and repository inventory.

Claude Code declares `home`, multiline exact project-directory `include`/`exclude` filters, and `agentGrouping` (`project` or `runtime`). It reads local main JSONL transcripts only, without CLI execution, network or writes. Canonical agents belong to projects (opaque stable hashes), never session UUIDs. New validated appended activity has a 30-second observed lease; bootstrap is idle. The required run record remains `idle` with `evidence:none`: no successful/failed terminal state is inferred. Tool results update the corresponding tool call by exact native call ID. Costs, chat, restart, flows and skills are unsupported. **Sub-agents (T-0062):** the one recognized nested location `<project>/<session>/subagents/agent-<id>.jsonl` (no symlinks, same containment and descriptor checks, at most 64 per session) is a canonical `subagent` session of its parent conversation: `parentKey`/`childKeys`, `class.subagentId`, `spawnedBy { sessionKey: parent, agentId: project agent, via: 'subagent-tool', label }`, `interactive: true`. Its title is the parent's sub-agent tool call description when the parent's tool result records the spawned agent id, else its own first prompt (redacted). A sub-agent session has `sessionId: null`, so the native session id stays unique to the conversation. The connector declares `capabilities.subagents: true`.

The initial connector exposes a bounded recent trace window, with partial-history diagnostics; it does not offer older-history pagination. Transcript layout is an internal format and the parser is a declared synthetic-tested profile, not a claim of compatibility with an installed CLI version. Unknown formats retain the last good window with a value-free diagnostic. See the implementation report for measured caps, scale evidence and browser captures.

#### Runtime identity and restart isolation (T-0022 / security-34)

V3 canonical IDs continue to dispatch to their encoded owner. At the v2 boundary, raw aliases resolve only to `legacy`; scoped-looking legacy native IDs retain their encoded legacy representation on new responses. Previously issued ambiguous aliases return 409 `conflict`, detail `ambiguous-runtime-id`, before reads, capability lookup or mutation. Session, flow and skill detail topics and their refreshes use the same version-aware resolver. A value-free ledger (at most 4,096 SHA-256 identity fingerprints) remembers unsafe aliases across disable/removal/live-generation replacement; saturation refuses scoped v2 references rather than forgetting an alias. This compatibility ledger is process-local, not a persisted alias inventory.

OpenClaw advertises gateway restart only for local loopback endpoints. Restart calls that bound gateway's RPC only. Remote instances are not restartable from here. There is no systemd/default-service fallback on RPC rejection, including late rejection after the request timed out or its source was replaced. Supervisor/app restart remains the separate Settings command.


### Runtime detection snapshots

Settings restores the last bounded discovery snapshot from migration 021's private `runtime_detection` singleton before serving its VM. The server triggers a local discovery pass at boot and schedules another pass five minutes after the previous pass finishes. GET never runs discovery; the owner refresh button uses the same single-flight coordinator. A failed pass retains the last real evidence and timestamp. Shutdown cancels scheduling and prevents late publication. The cache stores only discovery metadata, never credentials or transcript content, and is ignored when detection roots change.

Real discovery runs in a cancellable worker with a five-second deadline and bounded heap. Local reads use nonblocking opens, require regular files on the opened descriptor, and read into fixed-size buffers; FIFO identities and concurrent growth/replacements cannot block the HTTP event loop. Each pass permits at most 1 MiB per file/result, 8 MiB of aggregate read allocation, 2,048 read/probe budget units and 1,024 roster agents. Capacity/deadline failures retain the last snapshot. Shutdown aborts active discovery, and worker termination completes before its single flight is released.

Every live runtime row includes `detection`; it is optional in the schema to keep older 3.3 examples/clients compatible. `not-checked` with a null timestamp is distinct from a completed negative result (`not-detected`). `unreadable` is inconclusive, and `enabled` identifies an enabled synthetic runtime. Both badge and reason derive from this state. `checkedAt` is the time the retained discovery pass completed, separate from connection-probe timestamps.

Cards, detected agents and diagnostics share the adapter-owned instance association. A detector matches a configured instance by its normalized config path or gateway (gateway match first). The stable configured ID is retained. Another installation stays a candidate; its agents are not attached to an unrelated configured source. Disabled optional/demo runtimes are omitted. Detection never enables a runtime, changes the configured primary, or increments the owner configuration revision.

T-0052 additive appearance fields: `OccupantVM.automaticLook` and `LayoutVM.agentsSeen[].automaticLook` optionally carry `{ character, variant, accessories }`. Agent rules accept `appearance: 'auto' | 'manual'`; owner appearance edits mark manual. Canonical IDs key durable assignments; 2.x reads share the same assignment. See api.md's T-0052 contract and the updated example sidecars.

The same occupant can carry both its durable `automaticLook` and the optional session-derived `summary`, `model`, `project`, `runtime`, `startedAt`, `lastActivityAt` and `tokensKnown` fields from agent-identity-1. The limited office projection retains automatic appearance and owner names while omitting session-derived fields, as described in api.md §3.2. These additive fields are recorded together in `examples/v3/office-vm.types.json`.
