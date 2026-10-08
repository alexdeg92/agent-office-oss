# Agent Office API, contract 3.0 (`/api/v3`)

**Status:** served on `/api/v3` (G5, architect-35; ADR-001 §9 and §12). Examples: `examples/v3/`. The runtime check validates every 3.0 VM against the 3.0 schemas (`VM_SCHEMAS_V3`; the frontend's `validateVM(name, vm, 3)`).

**What 3.0 is:** the same API as 2.5 (api.md), on **`/api/v3`**, with the **open vocabularies as the canonical names** and **no personal value or field name**. Every route, method, body, envelope, error code, SSE frame and rule of api.md 2.5 applies unchanged, **except the deltas D1–D10 below**. A VM not listed here has the same shape and values as in 2.5 (its example is `examples/<name>.json`). The v3 examples are written for a foreign instance (primary agent `atlas` « Atlas », Telegram, Europe/Paris), so none of them carries a home-instance value.

**2.x stays.** `/api/v2` keeps serving 2.5, **byte-identical**, from the same canonical core through the 2.x projection (`project2x`), until the frontend and office have moved (then S16 removes it). Both versions share one engine, one store, one set of runtime reads and one chat state; only the VM projection differs. A client uses ONE version for everything (views, commands, stream): a v3 topic is never sent on a v2 stream, nor the reverse.

## D1 · MetaVM
- `apiVersion: 3`, `contractVersion: '3.0'` (also in the stream's `hello`).
- **`runtime`**: `{ id, name, gatewayLabel, version: string | null, capabilities }`. `capabilities` is the adapter's declaration (ADR §3): `sessions`, `transcripts`, `activity`, `flows {read, write, schedules}`, `skills {read, toggle, detail}`, `channels`, `interlocutors`, `chat`, `restart`, `costs`, `subagents`, `sessionGroups`. **The UI hides or disables by capability**; a command whose capability is false is 404 `not_found`.
- **`instance`**: `{ name: string | null, timeZone, locale, configured }` (`name` from setup or `AO_INSTANCE_NAME`).
- **`locales`**: `['fr', 'en']`.
- **`labels`** has the 3.0 keys (`sessionKind.primary`, `occupantRole.direct`, `runtimeKind.*`, `interlocutorKind.*`, …) and no 2.x-only key. It also has **dynamic** entries for open vocabularies: `channel.<ref>`, `provider.<id>`, `model.<id>`, `agent.<id>`, for every value that occurred (the adapter's label, else the raw value). **A client never assumes a closed list in those namespaces**, and a missing key renders the raw value (never « autre », never the key).
- **`enums`**: `sessionKind` (D2), `occupantRole` (D3) and `interlocutorKind` (D5) are the 3.0 lists; **`channel` is removed** (open).

## D2 · Session kinds and channels (`LogRowVM`, `SessionVM`, logs query)
- `kind`: `'primary' | 'subagent' | 'scheduled' | 'conversation-direct' | 'conversation-group' | 'conversation' | 'internal' | 'unrecognized'`.
  - `conversation` = a chat-shaped key whose scope the adapter doesn't know (still interactive, still in the office).
  - `internal` = a runtime's own session (OpenClaw: dashboard, ACP, explicit keys).
- **`runtimeKind: string | null`** (new, after `kind`): the runtime's own kind for an `internal` session (`dashboard`, `acp`, `explicit`), else null. Labelled `runtimeKind.<x>` (raw fallback).
- `channel`: a **`ChannelRef`** (`^[a-z][a-z0-9-]{0,31}$`: `discord`, `telegram`, `slack`, `matrix`…) or null. **`unrecognized` doesn't exist in 3.0.**
- `GET /api/v3/views/logs?kind=` takes a 3.0 kind (`internal` included); a 2.x kind is 400. Topics `logs?kind=<3.0 kind>`.
- Conversation titles: `sessionTitle.user` / `sessionTitle.channel` with `{id}` = the interlocutor's id within its channel (Discord: the last 6 digits, as 2.x).

## D3 · OfficeVM (and the office's journal)
- `OccupantRole`: `'primary' | 'subagent' | 'scheduled' | 'direct' | 'group' | 'conversation'`; `roleLabel` is `occupantRole.<role>`.
- `OccupantId`: **`'primary'`** for the primary agent, else `'<role>:<subject>'` (`scheduled:<jobId>`, `direct:<interlocutorId or key>`…). The same ids in `journal[].occupantId`, cues and LiveEvents.
- `ruleId`: the layout rule's id (3.0 layout names, D4).

## D4 · LayoutVM and the layout commands
- Layout rules use the 3.0 names: `agents[].agentId` `'primary'`, `'*subagent'`, `'*scheduled'`, `'*direct'`, `'*group'`, `'*conversation'`; `match.kind` the D3 roles. `agentsSeen[]` ids and roles too.
- Stored layouts are **not rewritten in place**: they are read in either vocabulary, **normalised to 3.0 names on save**, and served in the caller's version (`/api/v2` gets 2.x names). `PUT /api/v3/office/layout` accepts 3.0 names only.
- **`layout.data.presence`** `{ seenMinutes: 0–1440 }` (optional, office-dev O8): how long an occupant stays in the editor's seen inventory. 2.x reads don't show it, and a 2.x save keeps the stored value (operations.md §4).
- `manifest` is unchanged (office-dev's opaque art data; its character `role`s are asset metadata, not occupant roles).
- **Office-dev dependency:** `layout-rules.js` accepts both vocabularies (ADR §12.6) before the office moves to v3.

## D5 · AccessVM, InterlocutorVM
- Interlocutors of **every** channel (2.x shows Discord's only).
- `kind`: **`'user' | 'room'`**, plus **`channel: ChannelRef`** (after `kind`). Ids stay opaque and unchanged (`discord-user:<sf>`, `discord-channel:<sf>`, `telegram-user:<id>`, `matrix-room:<id>`); route ids are those.
- `resolution` adds **`'unresolvable'`**: the channel has no enricher (no name or avatar will come). `name`/`avatarUrl` are then null.
- `access` fields are null where the runtime config has no policy for that channel. `InterlocutorVM.profile` is the channel enricher's (Discord: as 2.5) or null.

## D6 · HealthVM
- `channels[].id` is the `ChannelRef` (2.x prefixed unknown ones `raw:<id>`); `label` is the adapter's label.

## D7 · Flows
- `FlowDetailVM.job.agentId`: the agent that runs the job: the job's own agent, or **the primary** when the runtime's job names none. Never a guess.
- **`job.ext.openclaw`** `{ sessionTarget, wakeMode }`: OpenClaw-only fields move to the adapter bag (`job.ext.<runtime>`, opaque to shape checks, documented per adapter). `job.sessionTarget` / `job.wakeMode` are gone. Shown as detail rows when present.
- `runs[].delivery.channel`: a `ChannelRef` or null.
- `POST /api/v3/flows` accepts an optional **`agentId`** (a listed agent; default the primary) when `runtime.capabilities.flows.multiAgent` is true; otherwise it's 400 `unexpected-field`.

## D8 · Projects
- `BoardVM.filter`: `'all' | 'at-risk' | 'with-agent' | 'archived'`, plus **`BoardVM.agent: AgentId | null`** (after `filter`): the agent of `with-agent` (default the primary), else null.
- `GET /api/v3/views/projects?filter=with-agent[&agent=<id>]`; topics `projects?agent=<id>&filter=with-agent`. **`with-timmy` is 400 on v3** (on v2 it stays, meaning `with-agent` for the primary).
- History actors are unchanged (`ActorVM`, names are data).

## D9 · Labels that name an agent
- Every label that named the home agent takes `{agent}` (already true in 2.5: `kpi.idle`, `skillOutput.agent-reply`, `liveEvent.*`). 3.0 adds no key with a personal name, and the lint (`test/portability`) keeps it so.

## D10 · Not in 3.0
- The v1 API (`/api/*` without a version) was removed at S16; only `/api/login`, `/api/logout` and `/api/me` remain (the `/v2` UI signs in through them).
- 2.x-only label keys (`sessionKind.main`, `occupantRole.dm`, …) and the `channel` enum.

## Commands, stream, errors
- Every 2.5 command exists on `/api/v3` with the same path, body and result, except D4's layout names and D7's `agentId`. CSRF, the agent token (§5.6, with its v3 paths), setup (§5.7) and the read-only rules are identical.
- `GET /api/v3/stream` and its transport POSTs work as §4, with v3 topic VMs and `contractVersion: '3.0'` in `hello`.

## Changelog
| Version | Date | Changes |
| --- | --- | --- |
| 3.0 | 2026-10-06 | First 3.0 contract (G5): D1–D10. Examples `examples/v3/` (`meta-vm`, `office-vm`, `logs-page`, `session-vm`, `access-vm`, `interlocutor-vm`, `health-vm`, `flow-detail-vm`, `board-vm`, `layout-vm`), held to these deltas by `test/api/contract-v3-examples.test.js`. |
