# Sender identity across runtimes

Contract revisions 2.6 (`/api/v2`) and 3.1 (`/api/v3`) add the same neutral identity model. ADR-001's adapter boundary applies: the engine and browser consume Sender data, and each adapter owns runtime fields, session-key grammar, transport envelopes and injected metadata.

```ts
type Sender = {
  kind: 'human' | 'agent' | 'system' | 'tool';
  id: string;                 // stable within its channel/runtime; never a display name
  name: string | null;        // display name, then username; null means unresolved
  runtime: string;            // open runtime identifier
  channel: string | null;     // open channel identifier, independent of v2 ChannelId
  avatarHint: string | null;  // known avatar URL or person:<stored Person ID>
  delegation?: { sessionKey: string; label: string | null } | null; // delegated agents only
};
type Participant = Sender;
```

The authoritative schema and default helpers are in `src/engine/model/sender.js`. Canonical trace events and both versions of TraceEventVM carry `senderInfo`. The earlier nullable `user.sender` string stays as a compatibility projection of the resolved display name. SessionVM adds `participants: Participant[]`; canonical transcripts may provide a participant list from the entire fetched transcript, even when their displayed events are windowed. Older canonical adapters may omit identity fields: the VM supplies the generic role mapping. ChatVM messages also carry `senderInfo`, including pending/local messages and errors.

The name stays null when identity is unknown. The browser chooses « Utilisateur » or “User” from its locale; summaries do the same. A user ID, phone number, channel ID or room name never substitutes for a person's name. Unknown senders are not grouped by guessed identity. System/cron inputs and subagent task sources are classified separately from human inputs. Identity inferred from untrusted metadata is descriptive UI data and cannot authorize an action.

## Adapter hooks

An adapter exports pure hooks `resolveSender(rawMessage, sessionCtx): Sender` and `stripEnvelope(text): string`. Its transcript normalizer calls them before clipping displayed text and creating summary inputs. `sessionCtx` supplies the canonical session, session key, runtime, channel, configured agent, local operator, known people and optional profile lookup functions. It never supplies secrets. A canonical adapter can alternatively annotate its events directly with `senderInfo` and supply transcript `participants`.

For single-user CLI harnesses, use the default hooks from `src/engine/model/sender.js`: user → local operator supplied by the host, assistant/thinking → agent, tool/toolResult → tool, system → system; `stripEnvelope` is an identity function. Explicit neutral `rawMessage.senderInfo` supports multi-person transcripts. These defaults are usable by Claude Code, Codex, opencode, Cursor CLI and Hermes; this change does not implement their transports or register new runnable adapters.

The OpenClaw implementation is `src/adapters/openclaw/sender.js`. It reads per-message `__openclaw.senderId`, `senderName`, `senderUsername` and `senderIdentity`, earlier top-level sender fields and leading Conversation info/Sender JSON blocks (including the current nested `conversation.sender`). It consumes recognized transport envelopes and message ID suffixes, and uses a session's peer only for a direct conversation. Guild rooms/threads never supply a human identity. Portal chat uses the stored operator; cron is system; inter-session and subagent inputs are agents. Only recognized leading envelopes are removed. Malformed metadata and literal examples inside the user's body are preserved. Stripping happens before clipping, so metadata does not become a summary or preview snippet.

Stored Person identities and cached profiles resolve names and avatars consistently. The store projects `person_identities` into neutral `{channel, id}` entries for matching. Matching uses explicit IDs and these entries, not name equality or a guessed correspondence with the GitHub owner allow-list. `AO_PROJECTS_OWNERS` remains the configured code-host allow-list; it is not an identity registry. Human participants in linked transcripts also supply the project “Personnes impliquées” view and History sender names. Channel enrichers see group participants as well as the session's room.

Human avatars use initials plus a deterministic colour keyed by stable identity (or a linked stored Person hint), shared with project avatars. Consecutive messages from the same known ID group in Arbre. Chronologie keeps separate timed rows, each with its sender name and avatar. A session header counts humans and primary conversation agents once per stable identity. `SessionVM.subagents: Sender[]` separates delegated sessions from `participants`. Delegated senders carry optional `delegation: {sessionKey, label}`; adapters attach this metadata, or the core resolves it from canonical subagent sessions by exact ID. The browser never parses runtime session keys. It displays a separate expandable “+ N sous-agents” count, linking each entry to its session with its real label/task when available. Unresolved generic names are counted together rather than repeated. Three humans plus one primary agent is four participants, regardless of delegated sessions.

OpenClaw uses inter-session source keys, canonical session labels/display names, and successful `sessions_spawn` calls paired by exact tool call ID with their child session key. Spawn labels or tasks survive transcript windowing, including children that have not reported back. Parent task inputs and primary-agent inter-session messages remain primary agents; unrelated text cannot invent a delegate. Any other runtime can supply the same neutral delegation metadata and canonical parent/child relationships.

Conversation summaries and recent-message snippets flatten the shared safe Markdown AST to plain text before clipping; full traces retain Markdown rendering.

## Conformance gate and limitations

`test/helpers/sender-conformance.js` exports `senderConformance(runtime, {resolveSender, stripEnvelope, raw, context})`. Supply synthetic raw-message and context factories for the runtime. It exercises DM, three-human group, unknown, operator, agent/system/tool and envelope stripping. See `test/adapters/sender.test.js` for the OpenClaw and generic examples. Add this gate when introducing an adapter; run its targeted suite alongside that adapter's ingestion tests.

The backend-3 read-only investigation corrected backend-2's conclusion: current OpenClaw 2026.9.8 `sessions.get` responses expose producer sender facts inside `__openclaw` for many group messages. They were previously ignored by the adapter. Historical group messages without those facts or an exact captured mapping remain unknown. Live Telegram samples were unavailable; its mapping is tested synthetically. No runtime storage is modified, and no runtime is restarted by this feature.

## Optional sender capture

`Capabilities.senderCapture?: boolean` advertises optional attribution capture. Absence or false means the adapter supplies no capture service. Adapters may receive a runtime-neutral `senderCaptures` repository as the second argument of `createRuntime(cfg, {senderCaptures})`. It exposes `putMany([{runtime, sessionKey, eventKey, sender}])`, `get(runtime, sessionKey, eventKey)` and `prune()`. Each adapter owns extracting producer facts, obtaining exact message keys and resolving a lookup through its `resolveSender`; the engine and UI still consume only Sender/Participant. Runtime-specific schemas and keys never enter the core.

OpenClaw binds capture into its transcript normalizer and watches `session.message`/`chat` events when their message carries producer metadata. A `sessions.changed` notification for a group schedules one debounced `sessions.get` read, even when no session view is open. The pending read set is bounded at 32 keys; repeated changes coalesce while a read is pending. Timers stop on disconnect/close. The existing `sessions.subscribe` supplies change notifications; a global `sessions.messages.subscribe({})` is rejected by this runtime because it requires a session key. Capture does not depend on that subscription. It performs no additional polling, subscribes to no channel-provider socket, and never opens the runtime database.

Capture accepts visible external user turns with per-message producer metadata, checks identity/id/channel agreement, and maps a positively identified bot to the agent kind. Keys use the exact upstream `idempotencyKey` (including agreement between top-level and `__openclaw` copies), or the persisted `__openclaw.id` when no idempotency key exists. No matching by body, timestamp, name, owner flag, room or session participant summary is allowed. Current explicit metadata takes precedence over capture; cached identities still pass through fresh Person/profile enrichment. Model-only untrusted context can be parsed when actually present on the fetched message, but it is not guessed from the active room or model state.

The AO repository (`013_sender_captures`) stores only the runtime/session/event keys, neutral Sender identity with a null avatar hint, first capture time and byte accounting. It rejects oversized fields, removes expired entries and evicts oldest records to enforce 10,000 records and 8 MiB of UTF-8 identity/key data. Retention defaults to 30 days (`AO_SENDER_RETENTION_DAYS=1…365`); `AO_SENDER_CAPTURE=0` or `PORTAL_READONLY_STORE=1` disables capture and reports false. Runtime mutation protection (`PORTAL_READONLY=1`) does not prevent capture into the separate AO store. Replay cannot extend the TTL or replace the first attribution. Cache failures preserve explicit metadata and otherwise yield unknown. SQLite page/index overhead and the existing backups are outside the logical data cap.

Capture is best effort while Agent Office is running. Messages compacted or removed before it observes a producer-backed read/event, change events lost during disconnection, and excess simultaneous pending keys may be missed. Opening a surviving transcript can fill the cache later. No historical backfill is invented. Synthetic tests in `test/adapters/sender-capture.test.js`, `test/store/sender-captures.test.js` and `test/api/sender-capture.test.js` cover exact attribution, persistence, bounds, disabled capability and event lifecycle.
