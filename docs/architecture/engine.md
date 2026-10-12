# Ingestion engine

Status: contract 2.2 (2026-10-05; see the api.md changelog).

The engine is the only code that reads raw data. Its inputs are:
- gateway RPC results and events;
- CLI JSON;
- `openclaw.json`;
- Discord REST, the `gh` CLI, host metrics and the store.

It validates, classifies and normalises every input into the canonical types of [data-model.md](data-model.md), keeps them in one in-memory **registry**, and emits typed **change sets**. The view-model layer (api.md) consumes nothing else.

Its one rule: **nothing is silently dropped.** Every input either becomes canonical objects or produces a quarantine issue that is counted, persisted and shown on *Santé système*.

## 1. Why: what goes wrong today

| Today (file:line) | Problem | Engine answer |
| --- | --- | --- |
| `safeCall()` server.js:104 returns `null` on any error | an RPC failure looks like "no data"; nobody knows | source status + issue `rpc.failed` |
| `JSON.parse(stdout.slice(i))` in `try {} catch (_) {}` server.js:128 | a CLI format change makes the Compétences page empty (this happened after the 2026.9 upgrade) | issue `parse.failed` (value-free, §5.3); the previous good snapshot is kept and marked stale |
| `classifySession()` regexes server.js:157 | new key shapes fall into `other` and vanish from the office | ordered rule table, `unrecognized` + issue `session.unclassified` |
| `animForEvent()` substring sniffing server.js:67 | any payload with "text" in its type is "writing" | `(event, type)` mapping table + issue `activity.unmapped` |
| `p.key \|\| p.sessionKey \|\| p.session…` server.js:65 | guesses at field names | one schema per event, versioned |
| `buildTrace()` `\|\|` chains server.js:618 | accepts any message shape | per-role message schemas |
| `catOf`, `statOf`, `cronSteps`, `skillSteps`, `outputTags` in app.js | business logic in the browser | moved to normalisers / view models |
| hard-coded colours in `pushEvent`, `buildHealth` | presentation mixed into data | types carry keys; tokens are chosen on the client |

## 2. Module layout

```
src/
  engine/
    index.js          Engine: wires sources → pipeline → registry; owns timers
    pipeline.js       decode → validate → normalise → classify → commit
    registry.js       typed in-memory collections + change sets
    quarantine.js     issue store (memory + store persistence), redaction
    redact.js         error categories, version and key-shape helpers (S4.1: issues carry no samples)
    sources/
      gateway.js      (today's gateway.js, unchanged protocol) + RPC/event envelopes
      cli.js          execFile wrapper; enforces --agent main; JSON-from-first-'{'
      config.js       openclaw.json reader (subset projection, Secret wrapper)
      host.js         os + df
      discord.js      REST resolver, rate-limited
      github.js       gh api wrapper
    schemas/
      gw/             one file per RPC result / event, e.g. sessions.list.v1.js
      cli/            skills.list.v1.js, skills.info.v1.js, agent.turn.v1.js
      config/         openclaw.v1.js (only the fields we read)
      discord/, github/
    normalise/        raw-validated → canonical, one file per type
    classify/
      session-kind.js rule table (§6.1)
      activity.js     event → ActivityKind table (§6.2)
      enums.js        raw→canonical enum tables (cron status, channel type, skill source…)
    derive/
      occupants.js    Session + Activity + layout → OfficeOccupant[]
      interlocutors.js
      risks.js        risk monitor (§7)
      health.js
  schema/             the in-house schema DSL (§4), no dependencies
  model/types.js      JSDoc typedefs mirroring data-model.md
```

Everything is CommonJS (like today), uses `'use strict'`, and only depends on Node built-ins plus `ws`.

## 3. Sources

A **source** produces `RawEnvelope`s and reports its own status.

```ts
type SourceId = 'gateway' | 'cli.skills' | 'cli.agent' | 'config' | 'host' | 'discord' | 'github' | 'store';

interface RawEnvelope {
  source: SourceId;
  channel: string;          // schema family, e.g. 'gw.rpc.sessions.list', 'gw.event.session.tool', 'cli.skills.list'
  receivedAt: Ms;
  context: { openclawVersion: string | null; request?: unknown };  // request params, for on-demand calls
  body: { kind: 'json'; value: unknown } | { kind: 'text'; value: string } | { kind: 'error'; message: string; code?: string };
  outcome?: { ok: boolean; exitCode: number | null; stderr: boolean };   // CLI only (R1-05): a failed process is a failure even if stdout parses
}
```

### 3.1 Gateway (`src/adapters/openclaw/transport.js`)
- The device-signed handshake, protocol v4 and `operator.read` scope don't change. The connect response (hello) is captured to learn the **OpenClaw version** and protocol; it falls back to `health.server.version`.
- **RPC refresh** every 10 s while connected: `agents.list`, `sessions.list` (**every page**: `{limit:300, offset}` until `hasMore` is false, at most 20 pages; snapshot rules in data-model §2), `cron.list`, `channels.status`. `sessions.usage` is dropped (nothing reads it).
- **Reconnect:** transport failures use 1 second ×1.7, capped at 30 seconds. An explicit `connect` response with `ok:false` uses 30 seconds, doubling up to 10 minutes, and one value-free rejection log per unsuccessful streak. It keeps trying so a transient refusal during runtime restart self-heals. Socket close/timeouts are transport failures, not authentication refusals. A successful handshake resets both schedules and re-runs the full snapshot/subscription refresh.
- **Connection changes:** `runtime.updateConnection({url, gatewayToken})` requires an explicit URL/token pair, cancels the old retry, resolves pending calls as closed, invalidates old socket callbacks and reconnects immediately when started. An unchanged pair keeps its existing schedule. The transport never implicitly carries the old token to a changed URL. File/environment configuration is still loaded at dashboard boot; this hook does not add configuration watching or a public credential endpoint. `runtime.close()` cancels gateway retries too.
- **On-demand RPCs:** `sessions.get`, `sessions.describe`, `cron.runs`.
- **Events:** subscribe on open (`sessions.subscribe`, `sessions.messages.subscribe`).
  - **Seen on 2026.9.8** (capture-20261005-active), each with a v1 schema: `sessions.changed` (the full session row keyed `sessionKey` + `reason` + `activitySummary`; it upserts the session), `chat.metadata.changed` (`{agentId, usageUpdatedAt, modelCatalogChanged, authChanged}`), `health` and `tick`; plus `cron` (legacy). **Not sent:** `session.tool`, `session.message`, `session.operation`, `agent`; the legacy path that listens for them is dead in production and is removed with the v1 runtime (S7/S16).
  - Every `gwevent` becomes an envelope on channel `gw.event.<name>`.
  - `connect.challenge` stays internal.
  - Unknown event names are **not** an error. They're counted as info issues (`event.unknown`), so a new OpenClaw event shows up on Santé système instead of being thrown away (`broadcast('gwevent', {event})` today).
- A failed RPC produces a `body.kind:'error'` envelope (issue `rpc.failed`, source → `stale`). It does not produce `null`.

### 3.2 CLI (`cli.js`)
- The single wrapper around `execFile(OC_BIN, …)`. It sets `HOME`, a timeout, and `maxBuffer` 8 MB.
- **Per-agent commands require `--agent`:** the wrapper takes `{agent: 'main'}` as a required argument for `skills list` and `skills info`, and refuses to run without it. That turns the CLAUDE.md gotcha into a type error.
- **Output decoding:** take the text from the first `{` (kept, per CLAUDE.md). The prefix text is kept in the envelope for diagnosis. A missing `{` or a parse failure → issue `parse.failed`. `{ok:false}` → issue `cli.not-ok` with the CLI's message.
- **Write commands** (`cron add/edit/enable/disable/run/rm`, `config set skills.entries.<name>.enabled`, `agent -m`) also go through this wrapper. They are not ingestion: they return a `CommandOutcome` (api.md §5), and the engine schedules an immediate refresh of the affected source.

### 3.3 Config (`config.js`)
- Reads `~/.openclaw/openclaw.json` every 60 s, read-only.
- **Projection, not passthrough:** the schema lists only what we use:
  - `channels.discord.{dmPolicy, groupPolicy, guilds.*.channels.*.{enabled, requireMention}}`;
  - `tools.exec.security`;
  - `skills.entries.*.enabled`;
  - `channels.discord.token`, as a Secret (§3.6).

  The rest of the file is never loaded into the registry.
- A change in the file's mtime triggers an immediate re-read.

### 3.4 Host (`host.js`)
`os.loadavg/cpus/totalmem/freemem/uptime/hostname` and `df -B1 /` every 5 s. `df` output is parsed with a schema too (a column count check), so a different `df` doesn't produce `NaN` cards.

### 3.5 Discord, GitHub
- **Discord:**
  - resolves `discord-user` and `discord-channel` ids with the bot token (users, channels, guilds endpoints);
  - one request every 120 ms, at most 5 concurrent ids;
  - results are cached in the store; a 404 → `resolution:'failed'` with no retry for 24 h.
- **GitHub:** `gh api repos/{owner}/{repo}`, `…/commits?per_page=10`, `…/actions/runs?per_page=1`, and the OpenGraph image URL. Agent Office stores no token; it uses the host's `gh` auth. Every 10 min per linked repo.

### 3.6 Secrets
`Secret` is a class whose `toJSON()`, `toString()` and `util.inspect` all return `'[secret]'`. Its value is reachable only through `.reveal()`, and only the Discord adapter calls that. The gateway token and device key stay inside `gateway.js` as today. Errors become fixed categories (`redact.js`) before they're stored or sent; issues carry no values at all (§5.3).

## 4. Schema DSL (no new dependency)

A small combinator library in `src/schema/` (target ≤ 300 lines). It's used for raw schemas, store JSON columns and API request bodies.

```js
const s = require('../schema');
const SessionRowV1 = s.object({
  key: s.string().min(1),
  sessionId: s.string().optional(),
  updatedAt: s.ms().optional(),
  totalTokens: s.int().min(0).optional(),
  model: s.string().optional(),
  modelProvider: s.string().optional(),
  hasActiveRun: s.boolean().optional(),
  hasActiveSubagentRun: s.boolean().optional(),
  status: s.string().optional(),            // mapped by enums.js, not here
  startedAt: s.ms().optional(),
  endedAt: s.ms().optional(),
}, { extra: 'count' });                     // unknown keys: allowed, reported as 'shape.extra-field' (info)
const SessionsListV1 = s.object({ sessions: s.array(SessionRowV1, { perItem: true }), totalCount: s.int().optional() });
```

- **Primitives:**
  - `string`, `int`, `number`, `boolean`, `ms` (a non-negative integer that is plausible epoch ms, after 2020);
  - `snowflake`, `literal`, `enumOf`, `nullable`, `optional`, `array`, `record`, `object`;
  - `union` and `discriminated(key, {…})`;
  - `transform(fn)` for the rare in-schema coercion. One example: `model: string | {primary}`.
- **`object` options:**
  - `extra: 'count' | 'reject' | 'ignore'`. Raw schemas use `count`, so drift is visible without being fatal. Store and API schemas use `reject`.
  - `perItem` arrays validate each element on its own. A bad element is quarantined and the good ones are admitted.
- **Result:** `{ ok: true, value, notes: Issue[] } | { ok: false, issues: Issue[] }`. Issues carry a JSON path (`sessions[12].updatedAt`), an expected type and the actual type (never the value; see redaction).
- **Generated docs:** `node scripts/schemas-doc.js` prints every schema as a table into `docs/architecture/generated/raw-schemas.md`, so field-level docs never drift from code.

**Alternative:** `zod` would give the same result with a dependency; `ajv` with JSON Schema. Both are well-known, but the needed subset is small, and the brief's dependency rule favours the in-house DSL. If the PM prefers zod, only `src/schema/` changes.

## 5. Quarantine

### 5.1 Issue

```ts
type IssueCode =
  | 'rpc.failed' | 'cli.failed' | 'cli.not-ok' | 'parse.failed'      // transport
  | 'shape.invalid'            // required field missing / wrong type → record quarantined
  | 'shape.extra-field'        // unknown field present → record admitted (info)
  | 'shape.item-dropped'       // perItem array: one invalid element dropped, the rest admitted (warn)
  | 'enum.unmapped'            // raw enum value not in the table → 'unrecognized' or rule fall-through
  | 'session.unclassified'     // no SessionKind rule matched
  | 'activity.unmapped'        // live event type not in the activity table
  | 'event.unknown'            // gateway event name we don't handle
  | 'version.untested'         // OpenClaw version outside every schema's tested range
  | 'store.invalid'            // a stored JSON column failed its schema on read
  | 'schema.missing'           // a non-event channel reached the engine without a schema (warn; a wiring bug)
  | 'quarantine.overflow';     // more than 500 distinct fingerprints; further ones are counted here

type IssueSeverity = 'error' | 'warn' | 'info';
// error: data is missing from the UI (record or payload rejected)
// warn:  data shown with a fallback ('unrecognized', fall-through)
// info:  drift with no user impact (extra field, unknown event)

interface Issue {        // S4.1 (PM decision on review-06): value-free by construction, nothing else exists
  fingerprint: string;   // sha1 of the SANITISED channel|code|path only (16 hex), so it encodes nothing else
  code: IssueCode;
  severity: IssueSeverity;
  channel: string;       // §5.3
  path: string | null;   // a schema path, '$.sessions[].updatedAt'; records '{}', arrays '[]' (§5.3)
  count: number;
  firstSeenAt: Ms; lastSeenAt: Ms;
  state: 'open' | 'resolved' | 'muted';
}
```

### 5.2 Behaviour
- **Dedup:** issues are grouped by fingerprint. `count` and `lastSeenAt` increase on each occurrence.
- **Auto-resolve:** an open issue is marked `resolved` after its channel delivers 10 clean envelopes in a row. It reopens if seen again, unless it is muted: **a mute survives recurrence** (S5), and only the count and `lastSeenAt` move.
- **Mute:** Owner can mute an `info` or `warn` fingerprint from Santé système (api.md). `error` issues can't be muted.
- **Persistence (S5):** in the store table `quarantine` (storage.md §5). `record()`, auto-resolve and pruning mark fingerprints dirty, and the store flushes them every 5 s and on SIGTERM/SIGINT. At boot, `restore()` loads them as stored: they were sanitised before they were written, and sanitising twice would re-hash the placeholders. A row that fails validation on read is skipped and raises `store.invalid` on `store.<table>`. Resolved issues not seen for 30 days are pruned daily.
- **Payload-level failure** (`parse.failed`, `shape.invalid` at the root): the registry keeps the last good snapshot for that channel, and the source becomes `stale`. Views show the data with a *Données en cache* marker (EmptyState "stale" pattern).
- **Visibility:**
  - the Santé système page gets a *Qualité des données* section: open issues by severity, each with code, channel, path, count, first and last seen;
  - a badge on the Plus/Santé nav item when an `error` issue is open;
  - `HealthSnapshot.dataQuality` feeds the overall health level (`error` open → `warn`).

### 5.3 Diagnostics carry no values (S4.1)
History: default-deny sanitising in S2.1 (R1-01/R2-01), then the PM's field-name rule in S4 (review-05). Review R6 found a third round of leaks through the exceptions, so the PM **changed the approach** (BRIEF decisions log, on review-06): **"no values, ever; paths come from schemas."** An issue record carries only `fingerprint`, `code`, `severity`, `channel`, `path`, `count`, `firstSeenAt`, `lastSeenAt` and `state`. There is no sample, no detail, no version and no source text, so there is nothing left to redact.

**Central enforcement:** `quarantine.record()` keeps only those fields, whatever a caller passes, and re-derives each one:

| Field | Allowed content |
| --- | --- |
| `code`, `severity` | closed lists; anything else becomes `schema.missing` / `error` |
| `channel` | one of our channel ids (schemas + `store.*`); an unknown gateway event keeps its name only if the gateway **advertised** it (`hello.features.events`) **and** it matches `^[a-z][a-z0-9._-]{0,63}$` (PM rule on review-08, R8-02), else `gw.event.<unadvertised>` |
| `path` | a DSL path whose segments are **declared** schema names; record/map entries are `{}`, array elements `[]`; any other segment (an extra or unexpected payload key) is `<undeclared>`. A path that isn't a DSL path is dropped (`null`): e.g. `session.unclassified` uses `$.sessions[].key` |
| `fingerprint` | sha1 of the sanitised `channel|code|path` |

Source freshness (§5.4) still carries a fixed error **category** per channel (`timeout`, `payload-rejected`, `exit-<n>`, …), never a message.

**What is lost, deliberately:** the names of new protocol fields (drift now shows as `$.agents[].<undeclared>`, enough to look at a capture locally) and distinct unknown events (they share `gw.event.<unadvertised>`).

**Tests:** `test/engine/diagnostics-privacy.test.js` seeds credentials, names, money, emails, snowflakes, composite session keys and free text through every input path, plus the R5/R6 reviewer seeds (`private-client`, `alice-private-model`, the `privateclient` map key and event, a record key spelling a declared name, the direct-gate `detail:'rosebud'` with `{accountNumber:12345678, enabled:true}`). Assertions are on the **entire** serialised `dataQuality()`, `/api/data-quality` and `/api/health` responses, with fixed needles. A pinned test fixes the exact field set of an issue.

**Ignored events (S6.1):** every event OpenClaw 2026.9.8 can send that Agent Office doesn't consume (its `GATEWAY_EVENTS`, plus six broadcasts it doesn't advertise: `board.changed`, `board.command`, `chat.send_timing`, `chat.side_result`, `config.changed`, `sessions.catalog.host`) has an opaque schema in `gateway.v1.js` (`IGNORED_EVENTS`) and is never reported. Activity-bearing events (`session.tool`, `session.message`, `session.operation`, `agent`, `chat`) are deliberately not ignored: if they start arriving, `event.unknown` says so.

**Fixtures (PM decision on review-06):** captured real-data scenarios and every golden derived from them live in `test/fixtures/local/` and `test/golden/local/`, which are gitignored and never committed or published. **S6.2 (R8-03): writing a capture-derived file anywhere else is impossible:** `scripts/lib/local-roots.js` `assertLocal()` (filesystem identity, symlinks followed, git-ignored check) guards the capture `--out`, the re-redactor's `--fixtures` and every file written, and goldens route by provenance (only committed synthetic scenarios get committed goldens). The committed suite runs on synthetic scenarios, and capture-based tests skip with a notice when the local files are absent (`skipUnlessLocal`). `test/unit/fixtures-hygiene.test.js` proves no committable file is capture-derived. The redactor stays as defence in depth (R6-02 exact model ids, R6-03 secret fields of any type) but is no longer the repo's privacy boundary.

### 5.4 Source freshness (R1-03)
Status is kept **per channel** (`gw.rpc.cron.list`, `cli.skills.list`, …) and aggregated per source:
- `down` while the transport is down (the gateway `close` sets it, `open` clears it);
- else `stale` if any channel's last outcome was a failure (one channel's success never hides another's failure);
- else `fresh`.

`lastError` is the newest failing channel's category. `dataQuality().sources[].channels` lists every channel.

### 5.5 Version support (R1-04)
While the running OpenClaw version is not in a schema's `testedWith`, `version.untested` is recorded on **every** envelope of that channel. It stays open and never auto-resolves, across reconnects, until the version becomes supported.

## 6. Classification

### 6.1 SessionKind rules
An ordered table; the **first match wins**. Each rule declares the fixtures it must match, and the test suite checks two things:
- every fixture key matches its declared rule and no earlier one;
- no rule is dead (no fixtures).

Implemented in `src/engine/classify/session-kind.js` (S3). The real data reversed the original plan of "structured fields first":
- **Raw `kind` is `direct` for almost everything,** including dashboard, subagent and cron sessions, so it can't identify chats.
- **Raw `channel` is the last delivery channel:** `agent:main:main` says `whatsapp`.
- **`spawnedBy` is also set on dashboard and ACP sessions.**

So **the key grammar is the primary signal**, and only `isMain` and `subagentRole` are used as structured evidence.

| order | rule | kind | matches |
| --- | --- | --- | --- |
| 0 | (variant) | — | `<base>:heartbeat` → classify `<base>` with the **base's** row when known, set `heartbeatOf`; the variant's own row is never used |
| 1 | `is-main` | main | row `isMain === true` |
| 2 | `main-key` | main | `agent:<a>:main` |
| 3 | `subagent` | subagent | `agent:<a>:subagent:<id>` |
| 4 | `subagent-role` | subagent | row `subagentRole` present; `subagentId` = key without `agent:<id>:` |
| 5 | `cron` | cron | `agent:<a>:cron:<jobId>` |
| 6 | `dashboard` | dashboard | `agent:<a>:dashboard:<uuid>` |
| 7 | `acp` | acp | `agent:<a>:acp:<uuid>` |
| 8 | `explicit` | explicit | `agent:<a>:explicit:<key>` |
| 9 | `chat-direct` | chat-direct | `agent:<a>:<channel>:(direct\|dm):<peer>` |
| 10 | `chat-group` | chat-group | `agent:<a>:<channel>:(channel\|group\|thread\|slash):<peer>` |

- **Channels** (canonical ChannelId, closed): `discord`, `whatsapp`, `wechat` (raw `wechat`, `weixin` and `openclaw-weixin`; 2.2). Chat keys on any other channel are `unrecognized`.
- **Interlocutors are only assigned for Discord,** and only when the peer is a bare snowflake: `direct` → `discord-user:<sf>`, `channel` → `discord-channel:<sf>`. Slash-command sessions and the nested `channel:agent:…:direct:<sf>` shape found in the capture get none.
- **Tests:**
  - every rule has a hand-made first-match case;
  - every fixture key (both scenarios) must classify;
  - a fuzz test;
  - a per-scenario classification table golden.

  The real capture classifies all 175 sessions with 0 `unrecognized`.

- The issue is value-free (`$.sessions[].key`, S4.1); a new key format is investigated on a local capture.
- Adding a kind means adding a union member in data-model.md, a rule, fixtures, the i18n label, and the occupant role mapping. The test `session-kind.exhaustive.test.js` fails if any of those is missing.

### 6.2 Activity (revised in C1)
The `(event, type)` mapping table is **withdrawn**. On OpenClaw 2026.9.8 no per-tool or per-message events exist (capture-20261005-active: only `sessions.changed`, `chat.metadata.changed`, `health` and `tick` during a live run). Activity is derived from the canonical RunState (data-model §3): a running session has Activity `working` (`source: 'run-state'`). `sessions.changed` events upsert the session immediately, so the office reacts at event speed. The `activity.unmapped` code is kept for a future protocol and currently never fires.

### 6.3 Enum tables
`classify/enums.js` holds every raw→canonical map in one place:
- cron run status, delivery status, session target;
- skill source;
- Discord channel type (the numeric `CHTYPE`);
- channel id;
- CI state;
- run status.

Each table has a `known` list, and a miss yields `enum.unmapped` (warn) plus `'unrecognized'`.

## 7. Derivations
These run after every commit, only for the types whose inputs changed, debounced 250 ms.

| Derivation | Inputs | Output |
| --- | --- | --- |
| `occupants.js` | Sessions, Activities, gateway connected, active OfficeLayout | `OfficeOccupant[]`, cues (`delegating`, `celebrating` on run success), LiveEvents `occupant.joined/left` |
| `interlocutors.js` | Sessions (chat-* on Discord), config policies, Discord cache | `Interlocutor[]` + resolver queue |
| `health.js` | host, gateway health event, channels eventLoop, source statuses, quarantine | `HealthSnapshot` |
| `risks.js` (risk monitor) | CronJob.health, CronRuns, Repo.ci, project activity, links | raises/clears risk Flags and writes `risk-raised/cleared` history (store) |
| `project-activity.js` | Sessions and CronRuns matched to project sources; Repo commits | idempotent HistoryEvents (`dedupeKey`), `lastActivityAt` |

**Store writes from derivations (R3-19).** Two derivations write durable data, the risk monitor (`applyProjectRisks`) and project activity (`ingestActivity`). **Both write only through the projects repository methods** (projects.md, `REPOSITORY_METHODS`), exactly like API commands:
- **Domain rules:** the projects module (`plan.*`).
- **Transaction:** the store repository (`withTx`), which inserts the history rows and updates `last_activity_at`.
- **Change event:** published by the store after commit (§8).

Nothing else writes project data. Activity ingestion is idempotent by `dedupeKey`, so re-running a derivation never duplicates history. Derived events that persist: `commit`, `flow-run`, `cron-run`, `session`, `agent-action`, and the `risk-*` events. Live occupants and LiveEvents are never persisted.

## 8. Registry and change sets

```ts
interface Registry {
  agents: Map<AgentId, Agent>;
  sessions: Map<SessionKey, Session>;
  activities: Map<SessionKey | '_', Activity>;
  occupants: Map<OccupantId, OfficeOccupant>;
  cronJobs: Map<CronJobId, CronJob>;
  cronRuns: Map<CronJobId, { fetchedAt: Ms; runs: CronRun[] }>;
  skills: Map<string, Skill>;
  channels: Map<ChannelId, Channel>;
  interlocutors: Map<InterlocutorId, Interlocutor>;
  health: HealthSnapshot;
  liveEvents: RingBuffer<LiveEvent>;
  gateway: { connected: boolean; since: Ms | null; openclawVersion: string | null };
  sources: Map<SourceId, SourceStatus>;
}

interface ChangeSet {
  seq: number;                                // monotonic
  at: Ms;
  changes: { type: CanonicalTypeName; op: 'upsert' | 'remove'; id: string }[];
  liveEvents: LiveEvent[];
  cues: { occupantId: OccupantId; cue: OccupantCue }[];
}
```
- **Single writer:** only `pipeline.commit()` mutates the registry. Objects are frozen (`Object.freeze`, deep in tests only) so view models can't mutate them.
- **Change detection:** an upsert is emitted only if the normalised object differs from the previous one (a structural compare of the canonical JSON). The 10-second refresh therefore produces no traffic when nothing changed. Today every refresh broadcasts `refresh` and every client refetches `/api/summary`.
- **One change bus (R3-19).** The engine and the store publish on the same bus, and the API's topic manager subscribes to it alone:
  ```ts
  type Change =
    | { source: 'engine'; type: CanonicalTypeName; op: 'upsert' | 'remove'; id: string }
    | { source: 'store'; type: 'Project' | 'HistoryEvent' | 'OfficeLayout' | 'UiPrefs' | 'Person' | 'QuarantineState'; op: 'upsert' | 'remove'; id: string; projectId?: ProjectId };
  bus.publish(changes: Change[])                 // engine: per commit; store: after each committed transaction
  ```
  The store publishes **after commit**, never inside a transaction, with one batch per transaction (a project command typically yields `Project` upsert + `HistoryEvent` upserts). The topic manager maps each change to the topics it can affect:
  - `Project`/`HistoryEvent` → `projects*`, `project:<id>`;
  - `OfficeLayout` → `layout`, `office`;
  - `UiPrefs` → `prefs`;
  - `QuarantineState` → `health`;
  - engine types → their VMs.

  It then rebuilds and diffs those VMs (api.md §4).

## 9. Versioning

- **Schema ids:** `gw.rpc.sessions.list@1`, `cli.skills.list@1`, … Each schema file exports `{ id, version, testedWith: ['2026.9.8'], schema, normalise }`.
- **Selection:** for each channel, the engine picks the highest version whose `accepts(openclawVersion)` range includes the running version. If none matches, it uses the highest version and raises `version.untested` (warn) once per version.
- **When OpenClaw changes a shape:** add `…@2` beside `@1`, add fixtures captured from the new version, and have both normalise to the same canonical type. The canonical model only changes when the meaning changes.
- **`MODEL_VERSION`** (data-model.md) is independent. It's bumped when a canonical type changes incompatibly, and the API exposes it (`/api/v2/meta`, SSE `hello`) so an open tab reloads instead of misreading data.

## 10. Fixtures and tests

### 10.1 Fixtures
```
test/fixtures/
  gw/rpc/sessions.list/2026.9.8/{basic,empty,discord-mix,unknown-key,bad-row}.json
  gw/event/session.tool/2026.9.8/*.json
  cli/skills.list/2026.9.8/{ok,not-ok,prefixed-text,truncated}.txt
  config/openclaw/2026.9.8/{min,full}.json          (synthetic; never a copy of the real file)
  discord/users/*.json, github/repos/*.json
  expected/<same path>.canonical.json                 (golden output)
```
- **Capture:** `scripts/capture-fixtures.js` runs on the host. It uses the gateway with the read-only scope, and runs the CLI read commands (`skills list/info --agent main --json`). Everything passes through `scripts/lib/fixture-redact.js`, which is **default-deny for identities** (R1-02). Values are kept only through allowlists:
  - protocol ids (`main`, `default`), session-key grammar words, OpenClaw built-in tool names, public (bundled/extra) skill names, cron expressions and IANA time zones;
  - **object keys (PM rule, S4):** declared field names (the engine's `declaredFieldNames()`) and a short structural key vocabulary are kept; every other key becomes `k_<hash>`;
  - **enum values (PM rule, S4):** only **exact** per-field vocabularies (status, kind, role, `stopReason`, …), protocol lists (methods, events, scopes…) and public model ids/providers (pattern + list) are kept; anything else in an enum-like field is faked;
  - every other id, custom skill, job or agent name, dynamic map key and URL path segment is faked or hashed (same input → same fake);
  - free text becomes lorem of the same shape;
  - token counts and costs are rounded.

  **The report is scanned too.** If anything is flagged, nothing is written and only counts are printed. Existing captures are re-redacted deterministically with `scripts/re-redact-fixtures.js` (no recapture); `capture-20261005` was re-redacted this way in S2.1 and again in S4 (from the original files, fixed salt). A capture whose original isn't available is re-redacted with `--already-redacted`: values shaped exactly like our own fakes map to themselves, so ids stay stable across passes (`capture-20261005-active` in S4).

  The PM runs it and reviews the diff before anything is committed. It never reads `openclaw.json` directly; config fixtures are hand-written from the projection schema.
- **Edge-case fixtures** are hand-made from the captured ones: a missing field, a wrong type, an extra field, an unknown enum value, an unknown key shape, an empty list, and CLI output with a text prefix.

### 10.2 Tests (`node:test`, no dependency)
- **Golden:** for every fixture, run `pipeline(raw)` and compare against `expected/*.canonical.json`. `UPDATE_GOLDEN=1 node --test` rewrites the files, and the diff is reviewed.
- **Quarantine:** each edge fixture asserts the exact issue (code, severity, path) and that the other records were admitted.
- **Classifier:** the exhaustiveness and dead-rule tests from §6.1, plus a property test: random key mutations never throw and always yield exactly one kind.
- **Redaction:** fixtures seeded with fake secrets (`token: 'SECRET-xyz'`, PEM blocks) assert that nothing secret-like appears in issues or logs.
- **Engine integration:** a `FakeGateway` (a `ws` server in the test process speaking the protocol-v4 frames, without signature checking) replays fixtures and events. The tests assert registry contents, change sets and occupant derivations, including timing (activity TTL 6 s, occupant linger) with mocked timers (`node:test` `mock.timers`).
- **Characterisation (migration step 0):** the current `build*()` outputs for the same fixtures are recorded first, so the module split (step 1) can be proven to be behaviour-preserving.
- **Run:** `npm test` (= `node --test test/`). The staging deploy runs it first, and a failure blocks the restart.

## 11. Performance budget
- Full refresh (300 sessions + jobs + agents + channels) through validate, normalise and derive: under 15 ms on the host.
- Memory: registry plus a 200-event ring under 20 MB.
- Schemas are compiled once at boot, and validation is allocation-light: no cloning of valid input; the normaliser builds the canonical object directly.
