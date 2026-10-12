# ADR-001: Agent Office as a platform. Runtime adapters, open vocabularies, instance config

- **Status:** accepted (G1, 2026-10-05), **amended by G1.1** after the reviewer's portability audit R12 (§12 takes precedence where it differs). Implementation is G2–G5 (§10).
- **Decision source:** BRIEF decisions log, "on Owner's product direction" (2026-10-05), plus Owner's follow-ups the same day: **languages French + English** (§5.1), **packaging Docker + npm/npx** (§5.2), and the PM commits each approved step (agents never commit).
- **Affects:** api.md (**contract 3.0 draft**, §9), data-model.md, engine.md, storage.md, the migration plan, the test layout.

## 1. Context

Agent Office was built as a live dashboard for one installation: an OpenClaw installation, its `main` agent "Timmy", Discord/WhatsApp/WeChat, GitHub owner `alexdeg92`, paths under `/home/example`. The redesign (S1–S7) already separated **canonical types**, an **engine**, a **store** and **view models**. Runtime specifics are no longer scattered through the UI, but they still sit inside the core.

Owner's direction: Agent Office becomes a **platform**.
- It works with **any OpenClaw installed anywhere** (any agents, names, channels, providers, models, projects).
- It's **publishable as open source**.
- It **supports other agent runtimes later** (Hermes, …).

### 1.1 Inventory: what is specific today (tree at S7a)

| Kind | Where | Examples |
| --- | --- | --- |
| Runtime transport and protocol | `src/engine/sources/{gateway,cli,openclaw-config}.js`, `gateway.js`, `src/engine/tap.js` | OpenClaw WS protocol v4, device identity, `openclaw` CLI argv, `~/.openclaw/openclaw.json` |
| Raw schemas and normalisers | `src/engine/schemas/{gateway,cli}.v1.js`, `src/engine/normalise/*` | `sessions.list` rows, `cron.list` jobs, `skills list --agent main` |
| Classification | `src/engine/classify/session-kind.js`, `enums.js`, `redact.js` KEY_WORDS | key grammar `agent:<id>:discord:direct:<n>`, kinds `acp`, `explicit`, `dashboard` |
| Commands | `src/api/routes/v1-legacy.js`, `src/api/v2/projects.js` | `openclaw cron add …`, `openclaw agent -m … --agent main`, `config set skills.entries…` |
| **Closed external vocabularies** | `src/engine/model/{session,canonical}.js` | `ChannelId = discord \| whatsapp \| wechat`, `sessionTarget = isolated \| main`, `wakeMode`, `delivery.mode` |
| **The `main` agent assumed** | engine `agent.js` (`defaultId \|\| 'main'`), `occupants.js`, `cron.js` (`agentId \|\| 'main'`), projects `vm.js`/`people.js`, every `--agent main`, `ensureAgent('main','Timmy')` | ~15 sites |
| **"Timmy" as a literal** | `src/i18n/fr.js` (`kpi.idle`, `skillOutput.agent-reply`), projects (`involvesTimmy`, `with-timmy`, `TIMMY_HISTORY_KINDS`, messages), legacy views/runtime | labels, filter names, actor shorthand `'timmy'` |
| **Personal defaults** | `src/config.js` (`/home/example/.openclaw/…`, `/home/example/.npm-global/bin/openclaw`, `alexdeg92`), projects `DEFAULT_GITHUB_OWNERS`, v1 `tz \|\| 'America/Toronto'`, `CLAUDE.md` | paths, owners, time zone |
| Tests | `test/fixtures` (synthetic, but OpenClaw-shaped), `test/bin/openclaw`, assertions on `Timmy`/`main`/`discord` | synthetic-basic only |

The **core** that is already runtime-neutral: the schema DSL, quarantine, the change bus, the sessions registry mechanics, the store, the API envelope and errors, topics/SSE/deltas, projects' domain rules, the office layout rules, the UI shell.

## 2. Decision

1. **Runtime adapters.** Everything runtime-specific moves to `src/adapters/<runtime>/` behind one **connector interface** with **capability flags** (§3). `openclaw` is the first adapter. The core, the API and the UI never import adapter internals; they see canonical types, capabilities and adapter-supplied labels only.
2. **Open vocabularies.** External vocabularies are **open strings**: channels, providers, models, agent ids/names, tool names, session subtypes. A **label registry** (§4) maps them for display, with a graceful « autre » fallback. Our **own** vocabularies stay closed enums: run status, health levels, issue codes, project status, occupant states, ActorRef kinds.
3. **The primary agent is data.** It's discovered from the runtime (`isPrimary`) or configured (`agents.primary`), never assumed to be `main`. "Timmy" is that agent's **name** (from the runtime or config), never a literal in code, labels or filters.
4. **Instance config** (§5): one non-secret config file plus env for secrets; no personal defaults in code; a **first-run setup** screen writes the file.
5. **Portability is tested** (§6): a synthetic **foreign instance** (other agent names, a non-`main` primary, Telegram/Slack/Matrix channels, other providers, another code host owner, another time zone) runs end to end. Tests split into adapter contract tests, runtime-agnostic core tests, and local-only instance tests.
6. **Contract 3.0** (§9) carries the wire changes. 2.x stays served until the frontend has moved.

7. **French and English from the start** (French default). Every UI and server text is a translation key; the server serves labels per locale (§5.1).
8. **Packaging-neutral:** a Docker image and an npm/npx package, from the same code, configured by file + env, with a configurable data dir and no host-specific paths (§5.2).

Docs, licence and a second adapter come later (§10); the design must not block them.

## 3. The connector interface

```ts
interface RuntimeAdapter {
  id: string;                               // 'openclaw', later 'hermes', …  ([a-z][a-z0-9-]*)
  name: string;                             // display name, « OpenClaw »
  version(): string | null;                 // the connected runtime's version, once known
  testedWith: string[];                     // runtime versions its schemas were tested with (version.untested otherwise)
  capabilities(): Capabilities;             // may change after connect (e.g. advertised features)

  // Ingestion: the adapter owns transport and raw shapes; the core owns validation bookkeeping and the registry.
  schemas: Record<ChannelName, SchemaDef>;  // raw schemas per adapter channel ('openclaw.rpc.sessions.list', …)
  normalise: Partial<{                       // raw (validated) → canonical, per canonical type
    sessions(page, ctx): SessionPage;  sessionChanged(raw, ctx): SessionRow;  agents(raw, ctx): Agent[];
    flows(raw, ctx): Flow[];  flowRuns(raw, ctx): FlowRun[];  skills(raw, ctx): Skill[];  skillInfo(raw, ctx): SkillInfo;
    channels(raw, ctx): Channel[];  transcript(raw, ctx): Transcript;  config(raw, ctx): RuntimeConfigProjection;
    event(name, raw, ctx): CanonicalEvent | null;
  }>;
  classifySession(key: string, row?: unknown): SessionClassification;   // generic kinds + runtimeKind (§4.2)

  start(ctx: AdapterContext): Promise<void>;   // connect, then ctx.ingest(envelope) for every read
  stop(): Promise<void>;

  // Commands: present iff the matching capability is true. Each returns a CommandOutcome (never upstream text).
  commands: Partial<{
    flows: { create(i): Promise<CommandOutcome>; edit(id, i); setEnabled(id, on); run(id); remove(id) };
    skills: { setEnabled(name, on): Promise<CommandOutcome & { needsRestart: boolean }> };
    agentTurn(input: { agentId: AgentId; text: string; sessionRef?: string; timeoutMs: number;
      signal?: AbortSignal; background?: boolean; canDispatch?: () => boolean }): Promise<TurnResult>;
    restart(): Promise<CommandOutcome>;
  }>;

  labels?: (kind: VocabKind, raw: string, locale: string) => string | null;   // hints for its own vocabulary (§4.1)
}

interface Capabilities {
  sessions: true;                                   // the minimum an adapter must provide
  transcripts: boolean;
  senderCapture?: boolean;                       // optional exact-message attribution cache; absent means unavailable
  activity: 'run-state' | 'events' | 'none';        // what activity granularity the runtime can give (data-model §3)
  flows: { read: boolean; write: boolean; schedules: ('cron' | 'every' | 'at')[] };
  skills: { read: boolean; toggle: boolean; detail: boolean };
  channels: boolean;  interlocutors: boolean;       // per-channel identities (e.g. Discord users)
  chat: boolean;  restart: boolean;  costs: boolean;  subagents: boolean;
}
interface AdapterContext {
  ingest(env: RawEnvelope): IngestResult;  instance: InstanceConfig['runtime'];  secrets: SecretReader;
  now(): Ms;  log(category: string): void;          // categories only: no payload text (engine.md §5.3)
}
```

AO owns `agentTurn` replies, including background project work. The OpenClaw adapter confirms
`sessions.patch {key, sendPolicy: 'deny'}` before each turn, then passes that exact scoped native session
key with `--channel=webchat --reply-channel=webchat`. Bare AO refs use the existing
`agent:<id>:explicit:<ref>` mapping, so the chat reader follows the fenced/dispatch session.
A missing/refused/unconfirmed policy receipt
prevents dispatch. This persists across gateway recovery even when an older AO session retains an
external delivery route. The no-ref case uses `agent:<id>:ao-internal`, never the agent's main session.
Both policy and turn children receive the same selected `OPENCLAW_GATEWAY_URL`/`TOKEN` pair.

The multi-runtime controller limits automatic cover capability discovery to the saved/resolved primary
instance and returns scoped agent IDs. Background requests carry `background: true`; the controller
checks ownership at dispatch and supplies its internal `canDispatch` callback. An adapter with an
asynchronous preflight must check that callback immediately before starting the turn (OpenClaw does
so after confirming the policy receipt). Cancellation or a primary/source change cancels dispatch.
`canDispatch` is an in-process callback, never an HTTP request field.

**Rules:**
- **One adapter per instance** in 3.0. Several runtimes at once (one office, two runtimes) is a later decision; the interface doesn't prevent it, because every canonical id is prefixed by its adapter when it needs to be globally unique.
- **Channels are namespaced by adapter** (`openclaw.rpc.sessions.list`), so quarantine, freshness and topics stay unambiguous.
- **Capabilities drive the UI.** `MetaVM.runtime.capabilities` hides or disables pages and actions. *Flux de travail* without `flows.write` is read-only; *Discuter* without `chat` is hidden. They also drive the API: a command whose capability is false is 404 `not_found` (it doesn't exist on this instance), not 403.
- **The secret boundary stays in the adapter.** Tokens and device keys are read through `ctx.secrets` and never reach canonical types (engine.md §3.6).
- **The adapter supplies its own fixtures and contract tests** (§6.2), so a second runtime can be added without touching core tests.

### 3.1 Module map (G2)

| Today | After |
| --- | --- |
| `src/engine/sources/{gateway,cli,openclaw-config}.js`, `gateway.js`, `src/engine/tap.js` | `src/adapters/openclaw/{transport,cli,config,taps}.js` |
| `src/engine/schemas/{gateway,cli}.v1.js` | `src/adapters/openclaw/schemas/*.v1.js` |
| `src/engine/normalise/{session,agent,cron,skill,channel,transcript,config}.js` | `src/adapters/openclaw/normalise/*` |
| `src/engine/classify/session-kind.js`, OpenClaw `KEY_WORDS` in `redact.js` | `src/adapters/openclaw/classify.js` |
| v1/v2 command argv (`openclaw cron add`, `--agent main`, `config set …`) | `src/adapters/openclaw/commands.js` |
| `src/engine/{index,quarantine,sessions-registry}.js`, `derive/*`, `model/*` | stay in core (`src/engine`); canonical models are de-OpenClawed (§4) |
| `src/engine/sources/{host,discord}.js` | `src/sources/host.js` (core: the server's own host); Discord REST goes to a **channel enricher** `src/enrichers/discord.js` (optional, keyed by channel family, not by runtime) |
| ~~`src/legacy/*`, `src/api/routes/v1-legacy.js`~~ | deleted at S16 (architect-50); they called the openclaw adapter directly, as today |

## 4. Open vocabularies

### 4.1 The label registry

```
label(kind, raw, locale) =
    core dictionary   ('<kind>.<raw>' in src/i18n/<locale>.js)       e.g. channel.discord → Discord
 ?? adapter.labels(kind, raw, locale)                                  e.g. openclaw: channel 'openclaw-weixin' → WeChat
 ?? instance config labels (labels.<kind>.<raw>)                       e.g. Owner renames an agent's display
 ?? a humanised raw value ('matrix' → « Matrix », 'gpt-5.5' → « gpt-5.5 »)
```

The UI receives `LabelRef {key: '<kind>.<raw>'}` as today, plus `MetaVM.labels` entries for every raw value that has occurred, **served dynamically**. An unknown raw value is never an error and never dropped. It gets the generic chip and « autre » only where a closed grouping is needed (e.g. a filter with a fixed set of options).

### 4.2 Canonical changes

| Field | 2.x | 3.0 |
| --- | --- | --- |
| `Session.class.channel`, `Channel.id`, `CronDelivery.channel`, `LogRowVM.channel` | closed `discord \| whatsapp \| wechat \| unrecognized` | **`ChannelRef = string`** (the adapter's normalised slug: `discord`, `telegram`, `slack`, `matrix`, …) + `label`; `unrecognized` disappears |
| `Session.class.kind` | `main, subagent, cron, chat-direct, chat-group, dashboard, explicit, acp, unrecognized` | **generic** `primary, subagent, scheduled, conversation-direct, conversation-group, internal, unrecognized` + **`runtimeKind: string`** (`acp`, `dashboard`, `explicit`, … shown as a tag) |
| `Agent` | `isPrimary` from `defaultId \|\| 'main'` | `isPrimary` from the adapter, else `agents.primary` from config, else the first agent (+ a `config.primary-guessed` info issue) |
| `CronJob` (→ **`Flow`**) | `sessionTarget`, `wakeMode`, `delivery.mode` closed OpenClaw enums | cross-runtime fields stay (`schedule`, `enabled`, `agentId`, `payload` kinds, `delivery {channel, to}`); OpenClaw-only fields move to **`ext.openclaw`**, typed by the adapter and shown as details |
| Provider / model | strings already | unchanged; labelled through the registry |
| `OccupantRole` | `main, subagent, cron, dm, channel` | `primary, subagent, scheduled, direct, group`; `OccupantId` `main` → `primary` |
| Interlocutor ids | `discord-user:<sf>`, `discord-channel:<sf>` | `<channelRef>-user:<id>`, `<channelRef>-room:<id>` (opaque to the core); enrichment by the channel's enricher if one exists |

### 4.3 "Timmy" and "Owner" are data

- **Agents:** the primary agent's display name comes from the runtime (`Agent.name`) or config (`agents.names.<id>`).
- **Labels:** labels that mention the agent take it as a param, e.g. `kpi.idle: « {agent} au repos »` with `{agent: {key: 'agent.<id>'}}`.
- **Projects:**
  - `with-timmy` becomes `with-agent` (`?filter=with-agent&agent=<id>`, defaulting to the primary);
  - the actor shorthand `'timmy'` becomes the token principal's agent (S7d);
  - `TIMMY_HISTORY_KINDS` becomes `AGENT_HISTORY_KINDS`.
- **The owner:** the display name comes from config (`owner.displayName`), as `PORTAL_DISPLAY_NAME` does today (S6.1).
- **The office:** the taco character is a **default look**, not an identity. Layout rules reference `primary` (not `main`), and characters are assigned by config or the editor.

## 5. Instance config

**One file, non-secret:** `agent-office.config.json`, found through `$AO_CONFIG`, else `$XDG_CONFIG_HOME/agent-office/config.json`. It's validated by a schema at boot, and a bad field refuses to start with its path. **Runtime/session secrets live in env or a secret file only**: the runtime token and session secret. Legacy v1 stores its password hash in the secret file; v2 DB auth stores the owner email/hash in users, with no second credential copy. **Precedence:** env (secrets and overrides) → config file → built-in defaults, and **the defaults contain nothing personal**.

```jsonc
{
  "version": 2,
  "instance": { "name": "Office", "locale": "fr", "timeZone": "UTC" },
  "owner": { "displayName": "Operator", "email": "operator@example.invalid", "authSource": "database" },
  "runtime": { "adapter": "openclaw", "openclaw": { "gatewayUrl": "ws://127.0.0.1:18789" } },
  "agents": { "primary": "atlas", "names": { "openclaw": { "atlas": "Atlas" } }, "looks": {} },
  "integrations": { "projet": true }
}
```

The strict reader accepts v1 legacy file auth and v2 DB auth as distinct versions. v1 requires secrets.passwordHash; v2 secrets contains only version, sessionSecret and runtimeToken. Only a complete env login replaces file auth; every partial login environment is refused with variable names only, preserving stored DB authentication. These DB/config migrations are forward-only; rollback restores a private pre-upgrade DB/config/secrets backup. Setup owner/person/layout/status commit together; publication is reconciled by a stored config digest after a crash. A valid DB config with no owner opens fresh local code-protected recovery; a missing private secrets file serves locked setup with a restore-and-restart message, no setup code and no writes.

- **First run (G4):** with no config file and no setup lock, `/v2/` shows « Configuration » (instance name, owner, runtime connection test, code hosts, workspace roots). It's protected by a one-time setup token printed to the server log, and it writes the file (0600) atomically. **No setup over a read-only instance.**
- **Today's env variables keep working** (`OC_*`, `PORTAL_*`, `AO_*`) and override the file. A one-shot `scripts/config-from-env.js` writes the file from the current env for existing installs (Owner's).
- **Removed from code:**
  - `src/config.js`'s `/home/example/...` defaults become `~`-relative adapter defaults;
  - the `alexdeg92` defaults become config, with no default (discovery is off until an owner is set);
  - `'America/Toronto'` becomes `instance.timeZone`.

  `CLAUDE.md` and the systemd units stay instance-specific and outside the published package (§10).

### 5.1 Languages: French + English (Owner, 2026-10-05)
- **Dictionaries:** `src/i18n/fr.js` (the default, today's) and `src/i18n/en.js`, with **the same keys** (a parity test fails on a key missing in either, and on a `{param}` that differs). Adapters supply label hints per locale (§4.1).
- **Locale resolution, per request:** `UiPrefs.locale` (`'fr' | 'en' | 'system'`; a new prefs key) → `Accept-Language` (best of `fr`, `en`) → `instance.locale` → `fr`. Responses that depend on it carry `Content-Language` and `Vary: Accept-Language, Cookie`.
- **What is localised on the server:**
  - **(a)** `MetaVM.labels` for the resolved locale, plus `MetaVM.locale` and `MetaVM.locales: ['fr', 'en']`;
  - **(b)** `ApiError.message` (it's already a fixed phrase per code/issue, so it becomes a key lookup);
  - **(c)** nothing else. VMs keep carrying **keys and raw data** (LabelRef), never prose.
- **Exceptions to remove:**
  - projects' French strings (`CandidateVM.reason`, `ProjectError` messages, the summary prompt) become keys + params;
  - the v1 UI stays French until S16.
- **SSE:** labels are fetched through meta, not pushed, so a locale switch is a meta refetch on the client. The `system` frame needs no change.
- **Agent-written text** (summaries, chat) is whatever language the agent writes. The summary prompt asks for the user's locale.

### 5.2 Packaging: Docker image + npm/npx (Owner, 2026-10-05)
The same code, three ways to run it: from a checkout (today, systemd), `npx agent-office` (npm package, `bin: agent-office`), or the Docker image. Nothing in code knows which.

- **Inputs:**
  - the config file (`--config <path>` / `$AO_CONFIG`; default `$XDG_CONFIG_HOME/agent-office/config.json`);
  - env for secrets and overrides;
  - the data dir (`--data <dir>` / `$AO_DATA_DIR`; default `$XDG_DATA_HOME/agent-office`, `/data` in the image);
  - `PORT`/`HOST`.

  **No host-specific path in code or defaults:** `~` is resolved against the process's home at runtime.
- **The OpenClaw adapter in a container:** the gateway WebSocket works over the network (`runtime.openclaw.gatewayUrl`). The **CLI-backed features** (skills list/info/toggle, flow writes, agent turns, today run through `openclaw …`) need either the `openclaw` binary plus its home **mounted read-only** into the container, or gateway-RPC equivalents. The adapter **reports capabilities accordingly** (e.g. `skills.toggle: false` without a CLI), so the UI degrades instead of failing. Device identity and token come from secrets or the mounted home, never from the image.
- **Image:** multi-stage `node:24-slim`, `npm ci --omit=dev`, runs as a non-root user (uid 10001), `VOLUME /data`, config read from `/config`, `EXPOSE 18789`, and a `HEALTHCHECK` on `GET /api/v2/meta`. It contains no dev files, fixtures, local data or design sources (`.dockerignore`).

```dockerfile
# sketch (G4)
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
FROM node:24-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server.js gateway.js package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production AO_DATA_DIR=/data AO_CONFIG=/config/config.json HOST=0.0.0.0 PORT=18789
RUN useradd --uid 10001 --create-home ao && mkdir -p /data /config && chown ao /data
USER ao
VOLUME ["/data"]
EXPOSE 18789
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v2/meta').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
```

```yaml
# compose sketch (G4): the OpenClaw gateway runs on the host
services:
  agent-office:
    image: agent-office:latest
    ports: ["18789:18789"]
    volumes:
      - ao-data:/data
      - ./config.json:/config/config.json:ro
      # optional, enables the CLI-backed capabilities: the openclaw binary and its home, read-only
      # - /usr/local/bin/openclaw:/usr/local/bin/openclaw:ro
      # - ~/.openclaw:/home/ao/.openclaw:ro
    environment:
      AO_RUNTIME_TOKEN: ${AO_RUNTIME_TOKEN}       # the runtime's gateway token
      PORTAL_SECRET: ${PORTAL_SECRET}
      PORTAL_PASSWORD: ${PORTAL_PASSWORD}
    extra_hosts: ["host.docker.internal:host-gateway"]   # config: gatewayUrl ws://host.docker.internal:18793
volumes: { ao-data: {} }
```

- **npm/npx:** `package.json` gets `bin`, `files` (`server.js`, `gateway.js`, `src`, `public`), `engines.node >= 24`, and no `postinstall`. `npx agent-office --config ./config.json --data ./data` starts the server. `npx agent-office setup` runs the first-run setup in the terminal (the same schema as the web setup).
- **Not in the package:** `test/`, `design/`, `docs/` (published separately as the docs site), local fixtures, `CLAUDE.md`, systemd units, `.env*`.

## 6. Tests

### 6.1 The foreign instance (portability, G3)

A synthetic scenario `foreign-instance` (committed, synthetic origin), with a **different shape everywhere it can differ**:

| Aspect | Owner's instance | Foreign instance |
| --- | --- | --- |
| Agents | `main` « Timmy » (primary) + `scout` | `atlas` « Atlas » (**primary, not `main`**), `scribe`, `reviewer`; no agent named `main` |
| Channels | discord, whatsapp, openclaw-weixin | **telegram, slack, matrix** (no Discord: no enricher) |
| Providers / models | provider-a / model-a | `anthropic` / `claude-sonnet-5`, `mistral` / `mistral-large-3`, an unknown `acme-llm` / `acme-1` |
| Session keys | `agent:main:discord:direct:<sf>` | `agent:atlas:telegram:direct:<id>`, `agent:scribe:slack:channel:<id>`, `agent:atlas:matrix:group:<id>` |
| Code hosts | github `alexdeg92` | github `acme-labs`, one workspace root |
| Locale / time zone | fr-CA / America/Toronto | fr-CA / Europe/Paris |
| Owner | « Owner » | « Camille » |

**Acceptance:**
- **Ingestion:** the whole scenario goes through ingestion with **zero error/warn issues**, and every session classifies, with no `unrecognized` channel or kind.
- **VMs:** every VM matches its example shape (`compareExample`).
- **Office:** it shows « Atlas » as the primary occupant.
- **Projects:** the `with-agent` board filter works with `atlas`, and an agent turn targets `--agent atlas`.
- **Text:** no response contains `Timmy`, `main` as an agent id, `discord` or `alexdeg92`.
- **Labels:** labels resolve through the registry, and unknown values (`acme-llm`) display raw.

**A "no personal literals" lint test** greps `src/**` and the committed tests/fixtures for `alexdeg92`, `/home/example`, `Timmy`, `example` and `America/Toronto` (outside an explicit allow-list: v1 legacy until S16, and comments that cite history).

### 6.2 Layout

| Suite | Path | Inputs | Runs where |
| --- | --- | --- | --- |
| **Adapter contract** | `test/adapters/<runtime>/**` | the adapter's own synthetic fixtures; a shared `defineAdapterContract(adapter, fixtures)` (like projects' repository contract): canonical outputs valid, capabilities consistent with the commands present, classification total, schemas tested | committed, CI |
| **Core** | `test/core/**` (today's engine/api/store/schema tests, moved) | a **fake adapter** that emits canonical data directly (no OpenClaw shapes) | committed, CI |
| **Portability** | `test/portability/**` | `foreign-instance` through the openclaw adapter, and later through a second adapter's fixtures | committed, CI |
| **Instance (local)** | `test/instance/**` + `test/fixtures/local/` | Owner's captures, his config, live-shaped goldens | local only (already gitignored), skip with notice |

## 7. Consequences

- **Good:**
  - A second runtime is an adapter plus its fixtures.
  - The core's tests stop encoding one installation.
  - Publishing needs no scrub.
  - The privacy rules from S4.1 become structural for config too: no personal data in code.
- **Cost:** about one sprint of mechanical moves (G2) before new feature work continues, a 3.0 contract the frontend and office must follow (labels as data, generic kinds, roles), and dual-serving 2.x/3.0 during the switch.
- **Risks:**
  - Over-generalising before a second runtime exists. Mitigation: the interface is extracted from the working OpenClaw path, not designed in the abstract, and anything only one runtime has goes to `ext.<runtime>`.
  - Label drift. Mitigation: the coverage test (S6.1) extends to the dynamic registry.
- **Not changing:** the SSE/delta machinery and projects' domain rules (apart from the primary-agent resolver). ~~The store schema~~ **does change** (§12.5, R12-05): interlocutor ids and person identities. ~~The office layout engine~~ gains role aliases (§12.6, R12-06).

## 8. Alternatives considered

- **Keep one runtime and parameterise names only:** this fixes "Timmy" but not Hermes, and it leaves OpenClaw shapes in the core. Rejected: Owner's direction is explicitly multi-runtime.
- **Dynamic plugin loading (npm packages per runtime) now:** premature. In-tree adapters behind the same interface can be extracted into packages when the second one exists.
- **A generic protocol (e.g. one JSON event schema all runtimes must speak):** that would push work onto runtimes we don't control. Adapters translate instead.

## 9. Contract 3.0 (served on `/api/v3` since G5; `api-v3.md` is the contract, this was its draft)

**Breaking changes (consumers):**
1. **`MetaVM.runtime`** `{ id, name, version, capabilities }` (§3). The UI hides or disables by capability. `MetaVM.capabilities` (writes) is kept.
2. **Labels for open vocabularies are data.** `MetaVM.labels` gains dynamic `channel.*`, `provider.*`, `model.*` and `agent.*` entries. The client never assumes a closed list for those namespaces, and a missing key falls back to the raw value (not « autre »).
3. **Channels:** `ChannelRef` replaces `ChannelId` everywhere. `unrecognized` is removed.
4. **Session kinds:** `SessionKind` becomes `primary | subagent | scheduled | conversation-direct | conversation-group | internal | unrecognized`, plus `runtimeKind`. `MetaVM.enums.sessionKind` is updated.
5. **Office:** `OccupantRole` becomes `primary | subagent | scheduled | direct | group`, the primary's `OccupantId` is `primary`, and layout rules use `primary` / `*scheduled` / `*direct` / `*group` (office-dev, design/office schema).
6. **Projects:** `BoardVM.filter` `with-timmy` becomes `with-agent` (+ `agent` param), and the topic `projects?agent=<id>&filter=with-agent`. History actors are unchanged (`ActorVM`).
7. **Flows:** `FlowDetailVM.job.sessionTarget` / `wakeMode` move to `job.ext.openclaw`, shown as detail rows when present. Create gets `agentId` (any agent, default the primary) once the adapter declares multi-agent flows.
8. **Labels that named Timmy take `{agent}` params** (`kpi.idle`, `skillOutput.agent-reply`, `historyKind.*` texts that said « Timmy »).
9. **Setup:** `GET /api/v2/setup` (status: needed/locked) and `PUT /api/v2/setup` (first-run config, setup token). `MeVM.displayName` comes from config.
10. **Locale (§5.1):** `MetaVM.locale`, `MetaVM.locales`; labels per locale; `UiPrefs.locale`; `ApiError.message` localised; `CandidateVM.reason` becomes a `LabelRef`. (These are additive except the `reason` change, so they can also land on 2.x first, in G3b.)

**Additive:** `Agent.runtime`, `Session.runtimeKind`, `ext.<runtime>` bags (opaque to shapes; documented per adapter).

**Served side by side:** `/api/v2` stays on 2.x until the frontend and office switch; 3.0 is `contractVersion: '3.0'` on `/api/v3`, built from the same canonical core. The 2.x VMs are adapters from canonical 3.0 types (e.g. `ChannelRef` → the 2.x closed `ChannelId` with `unrecognized`), dropped at S16.

## 10. Plan (amended by G1.1; status as of 2026-10-06, see `status.md`)

| Step | Content | Status |
| --- | --- | --- |
| **G1**, **G1.1** | This ADR and the R12 amendments (§12) | done (architect-10, -11) |
| **G2** | The adapter split and the boundary of §12.4 (typed reads, canonical ingestion, `engine.runtime()`, the fake-adapter test) | done (architect-12) |
| **S7b–d** | The remaining read VMs, v2 commands, the agent's scoped token, the screenshot capturer | done (capturer off by default) |
| **GL** | Go-live: API-only, `/backend`, the production profile (`go-live.md`) | done; production runs engine-only |
| **G3a / G3b / G3c** | The 2.x projection and the primary resolver; open vocabularies, migration 007, the foreign instance and the lint; French + English | done (architect-28…33) |
| **G4** | Instance config, first-run setup, the time zone end to end, packaging | done; leftovers in `status.md` |
| **G5** | Contract 3.0 on `/api/v3` (`api-v3.md`, `examples/v3/`) | served (architect-34, -35); UI migration in progress |
| **G6** | A second adapter: `demo` (§13) | done (architect-39) |
| **G7** | Pluggable enrichers and channel grammars (§14) | done (architect-42) |
| **G8** | Operations: probes, backup and restore, retention (`operations.md`) | done (architect-44) |
| **G9** | The state map (`status.md`) and this index | done (architect-46) |
| **S16** | Remove v1 after the rollback window (`s16-v1-removal.md`); then `/api/v2` once the UI is on 3.0 | post go-live |
| later | Hermes (§13.3, after §13.2), docs site, licence, more locales | PM/Owner |

## 11. Answers (PM, on architect-10)
1. **Config:** JSON with a JSON Schema, plus a commented example in the docs.
2. **Multi-runtime per instance:** out of scope for 3.0.
3. **Discord enrichment:** an optional channel enricher keyed by channel family.
4. **2.x:** lives until S16; consumers migrate in G5 through their api layer.
5. **`en`** ships in 3.0.
6. **Licence:** later. Instance-specific files (Owner's config, units, CLAUDE.md, staging env) live outside the core (a gitignored `instance/` or `~/.config/agent-office/`), so the repo is always publishable.

## 12. Amendments after review R12 (G1.1)

### 12.1 Boot and discovery never select this machine's installation (R12-01)
- **One runtime home.** The OpenClaw adapter derives **every** path from `runtime.openclaw.home`, which defaults to **the server process's own home directory** (`os.homedir()`), never a literal:
  - `identityPath = <home>/.openclaw/identity/device.json`;
  - `stateDb = <home>/.openclaw/state/openclaw.sqlite`. The transport's identity fallback reads **this** path, not `process.env.OC_STATE_DB` or a literal;
  - `configPath = <home>/.openclaw/openclaw.json`;
  - `bin` = the first of `openclaw` on `PATH`, then `<home>/.npm-global/bin/openclaw`.

  Each path can still be overridden explicitly (config, or today's `OC_*` env). Owner's service runs as `Owner`, so the derived paths equal today's.
- **No identity → the server still boots.** Gateway construction never throws. A missing identity or token puts the runtime in a `not-configured` state: the source is down with category `not-configured`, the API serves, and G4's setup screen shows. Tested with a foreign `HOME` (temp dir) that has neither the JSON identity nor the DB.
- **Code-host discovery is off until configured.** There's no default owner (projects' `DEFAULT_GITHUB_OWNERS` and `AO_PROJECTS_OWNERS` lose `alexdeg92`), and there are no default workspace roots. Candidates answer with an empty list and the `discovery.not-configured` state until `projects.codeHosts` / `workspaceRoots` are set. Owner's instance sets them explicitly (env today, config in G4).
- **Out of scope here:** `df -B1`, the systemd restart and POSIX `cwd` are **host-platform** facts, not personal ones. The supported host for 3.0 is Linux (the Docker image and Linux hosts); macOS `df` and Windows are later. The systemd restart becomes the adapter's `restart` capability, false when no service manager is configured.

### 12.2 One primary-agent resolver drives everything (R12-02)
- **`resolvePrimaryAgent(agents, config) → { agentId, source }`** (core, pure), in this order:
  1. `config.agents.primary` if it names a listed agent; otherwise a warn issue `config.primary-invalid`, and the next rule applies;
  2. the adapter's `isPrimary` flag (OpenClaw: `defaultId`; **no `'main'` fallback**, so the normaliser stops guessing);
  3. the first agent in the adapter's listing order, with an info issue `config.primary-guessed`;
  4. before any agent list has arrived: `null`.
- **Consumers.** All of these read the resolver; none of them names an agent:
  - adapter commands (`agentTurn`, the skills reads per agent);
  - Persons: an agent Person is created from the listing, **never seeded as `main`/`Timmy`**;
  - projects' `with-agent` filter and its people ordering;
  - the office roster and primary occupant;
  - the LabelRef `{agent}` params;
  - the scoped-token principal: the agent id is stored on the token at creation.
- **With `null`:** commands that need an agent answer 503 `upstream_unavailable` (`issue:'agent-unknown'`), and views show no primary.
- **The primary changes** (config edit, or the runtime's `defaultId` changes): the pointer moves at the next listing, a LiveEvent `agent.primary-changed` is recorded, and existing Persons stay (history references them).
- **Reconciliation of existing rows:** on Owner's instance, the `main`/`Timmy` Person **is** the real agent, so nothing changes. A Person whose `agentId` is no longer listed is kept (history), marked `inactive`, and hidden from filters. **Not renamed:** the session-key suffix `agent:<id>:main` (OpenClaw's grammar) and character asset ids such as `Characters/timmy` (a look, not an identity).

### 12.3 Unfamiliar channels keep classification and office presence (R12-03)
- **An open channel family:** `ChannelRef` is any adapter-normalised slug (`^[a-z][a-z0-9-]{0,31}$`) through the adapter output, the canonical contracts (session, channel, delivery), classifiers, ids, filters, labels and VMs.
- **Generic conversation kinds:** a chat-shaped key with **any** channel classifies as `conversation-direct` (`direct`/`dm`), `conversation-group` (`group`/`channel`/`room`/`thread`), or, when the shape is chat-like but its scope is unknown, the generic **`conversation`**. All three are interactive and get office presence (role `direct`, `group` or `conversation`).
- **Tested** with **randomly generated slugs** (property test), not a longer closed table.
- **2.x projection (§12.6):**
  - `conversation-direct` → `chat-direct`, `conversation-group` and `conversation` → `chat-group`;
  - a non-2.x channel → `ChannelId 'unrecognized'` in 2.x (with its label), and its own slug in 3.0.

### 12.4 The adapter boundary covers on-demand reads; no raw transport reaches a VM (R12-04)
- **Typed pull reads,** added to the interface, each present iff its capability is true:

```ts
reads: Partial<{
  transcript(sessionKey: SessionKey, opts: { window: number }): Promise<ReadOutcome>;   // capability transcripts
  describeSession(sessionKey: SessionKey): Promise<ReadOutcome>;                        // sessions
  flowRuns(flowId: string, opts: { limit: number }): Promise<ReadOutcome>;               // flows.read
  skillInfo(name: string): Promise<ReadOutcome>;                                         // skills.detail
}>;
type ReadOutcome = { ok: true } | { ok: false; category: SourceErrorCategory };
```

  - A read **ingests through `ctx`** (validation, quarantine, last-good), then resolves. The caller reads the canonical value from the engine (`engine.transcript(key)`, …). This is the R6-07 pattern, generalised.
  - The core asks through **`engine.request(op, args)`**. An absent read or a false capability gives `capability-unavailable`. A view whose data *is* that read turns it into 404 `not_found`; a view that only enriches its own row with the read keeps serving and says so. The session view is the one case today: it returns 200 with `traceState: 'unavailable'` and no trace (api.md §3.6, R16-07/R17-02).
- **Canonical ingestion entry point:** `ctx.ingestCanonical(op, value, { key })` validates against the canonical contracts (not raw schemas) and goes through the same registry, quarantine and change path. A runtime whose SDK already returns structured objects uses it, and so does **the fake core adapter** in tests.
- **Runtime facts are a neutral projection:** **`engine.runtime()`** = `{ adapterId, name, version, protocol, connected, since }`, filled by the adapter's `hello`-like op. **HealthVM reads `engine.runtime()`**, never `engine.latest('gw.hello')`. A lint test forbids `engine.latest(` in `src/api/v2/**` (v1 keeps its exception until S16).
- **Tests:**
  - a fake adapter with no OpenClaw shapes and no `gw.hello` drives sessions, agents and runtime facts into core VMs;
  - capability false → the read is unavailable (404 for a view made of that read; the session view stays 200 with `traceState: 'unavailable'`); capability true → callable.

### 12.5 Interlocutor and person storage change, planned as migration 004 (R12-05)
The earlier "store schema unchanged" claim was wrong. **Migration 004 (G3b):**
- **`interlocutor_cache`:**
  - the id CHECK widens to `<family>-(user|room):<opaque>` (opaque: 1–128 chars, no control characters);
  - the existing `discord-user:` / `discord-channel:` rows are **kept as they are**: `discord-channel` stays a legal alias of `discord-room` for 2.x;
  - profiles are validated per family by the family's enricher schema (Discord keeps its snowflake schema), with a **generic profile `{ displayName, avatarUrl }`** for families without an enricher;
  - the repository's id regex follows the CHECK.
- **Person identities:** a new table `person_identities (person_id, family, external_id, UNIQUE(family, external_id))`. The migration copies every `persons.discord_user_id` into `family 'discord'`. The column stays readable until 3.0 cleanup and is no longer written.
- **Canonical:** `Session.class.interlocutorId` and the interlocutor derivation accept any family; Discord ids keep their exact current strings, so 2.x stays byte-identical for Discord.
- **Tests:** non-numeric ids (`telegram-user:foreign-user`), a no-enricher conversation end to end, and the Discord path unchanged (the compatibility mapping).

### 12.6 Identity changes land with or after the 2.x projection (R12-06)
- **G3 is split** so the projection exists **before** any canonical identity changes:
  - **G3a:** every v2 VM is built through explicit `project2x.*` functions from canonical types, which are still the 2.x values at that point, so the projection is the identity. The v2 golden diff is empty.
  - **G3b:** canonical values change behind the projection: `primary`, conversation kinds, `ChannelRef`, `with-agent`. The projection maps them back:
    - occupant `primary` → `main`;
    - `scheduled` → `cron`;
    - conversation kinds → `chat-*`;
    - `ChannelRef` → 2.x `ChannelId`;
    - the board filter `with-timmy` is accepted as an alias of `with-agent` for the primary;
    - the v2 golden diff is limited to the **listed** fields.
- **Office layout (with office-dev):**
  - `layout-rules.js` accepts both vocabularies (`main` ≡ `primary`, `*cron` ≡ `*scheduled`, `*dm` ≡ `*direct`, `*channel` ≡ `*group`, plus the new `*conversation`) and requires a rule for the primary under **either** name;
  - persisted layouts are not rewritten in place: they're normalised to 3.0 names **on save**, and served in the caller's contract version;
  - versioned examples: `examples/` is frozen as 2.x, and `examples/v3/` is added in G5.
- **What the foreign-instance gate checks (§12.8):** runtime identities must be `atlas` everywhere they are *data*: argv, Person links, LabelRef params, names, the token principal. The **2.x wire aliases** (`OccupantVM.id: 'main'` and the `occupantRole.main` role key for the primary) are allowed only in those listed v2 fields, never in 3.0.

### 12.7 The time zone is instance config with correct foreign behaviour (R12-08)
- **`instance.timeZone`** (IANA) is set at setup. Its default is **the server process's time zone** (`Intl.DateTimeFormat().resolvedOptions().timeZone`), never `America/Toronto`.
- **Exposed in 2.x additively** (G3a): `MetaVM.instance { timeZone, locale }`.
- **Wired through:**
  - server: the office theme resolution (`LayoutVM.theme`, already server-side), flow create defaults, schedule sentences, v1's `tz || …` default;
  - frontend: formatters in `fmt.js` are keyed by time zone and rebuilt when meta changes; the scene and editor read the instance time zone, not a constant (office-dev, frontend).
- **Test:** an instance in Europe/Paris at 20:00 UTC shows 22:00 and the night theme. The `America/Toronto` literal is gone from `src/` and `public/v2/` outside the lint's documented allowances.

### 12.8 A real foreign-instance test, and a lint that can't hide regressions (R12-09)
- **The integration test** (`test/portability/foreign-instance.test.js`) runs the real path end to end: the `foreign-instance` fixtures, the openclaw adapter, the engine, the SQL store and projects domain, the v2 VMs over HTTP, and the SSE. **It checks:**
  - the summary-regeneration argv has `--agent atlas`;
  - the agent Person links to `atlas`;
  - `with-agent` keeps an Atlas project;
  - occupant names: Atlas is the primary;
  - conversations on telegram/slack/matrix are classified and present in the office;
  - static LabelRefs carry `{agent}` params, not « Timmy »;
  - channel labels fall back to the raw value;
  - **no v2 or v3 response contains `Timmy`, `alexdeg92`, `/home/example` or `America/Toronto`**, and `main` appears only in the §12.6 alias fields.
- **The lint** (`test/portability/no-personal-literals.test.js`) scans `src/**`, `public/v2/**`, committed tests and fixtures:
  - **allowances are token-specific:** `{ file, token, exact match, reason }` exempts **that occurrence only, never the whole line**;
  - asset ids (`Characters/timmy`, look `timmy`) have narrowly scoped allowances;
  - **a mutation self-test** copies the tree to a temp dir, injects `'Timmy au repos'` on an allowed line and in a VM builder, and requires the lint **and** the integration test to fail.
- **The frontend's `platform.test.js`** stays as a focused unit test, with its whole-line exemption replaced by token-specific ones (frontend).

### 12.9 Also decided (R12-07, R12-10)
- **Labels (R12-07):** the resolution order becomes **instance labels** (overrides) → core dictionary → adapter hints → **the raw value**. A missing key never renders the key.
  - `MetaVM.primaryAgent { id, name }` is the single display projection, matching the frontend's current proposal (additive in 2.x, G3a).
  - Server labels that named Timmy take `{agent}`.
- **Workspace roots (R12-10):** **3.0 supports one root** (`projects.workspaceRoot`). Several roots with stable ids (`{ id, path }` and a `root` in the source ref) are a later, versioned change. Today's `{ path }` source refs map to that single root unchanged. The root is a **portal-side** path; a remote runtime's `cwd` is matched against it through an explicit `projects.cwdMappings: [{ runtimePrefix, portalRoot }]` (empty by default). Containment checks stay per root, `.git` metadata included.
- **frontend-06, approved by the PM:**
  - **`MetaVM.primaryAgent { id, name, avatarUrl | null }`**: the resolver's agent (§12.2), discovered or configured. It's additive in 2.x (G3a).
  - **`MetaVM.runtime { id, name, gatewayLabel }`**, supplied by the adapter: OpenClaw gives `{ id: 'openclaw', name: 'OpenClaw', gatewayLabel: 'Passerelle OpenClaw' }`, translated per locale in G3c. The UI never writes « OpenClaw » itself. It's additive in 2.x (G2: the adapter definition already carries id and name). Capabilities join it in 3.0 (§9).
  - **The `sessionGroup` ref variant** `{ by: 'keys', sessionKeys }` is declared in the `project-vm` / `error-409-project` sidecars (done in G1.1).
  - **`instance.publicUrl`** (absolute origin, e.g. `https://timmy.example.ca`): instance config (G4; env `AO_PUBLIC_URL` until then). The static web service writes `og:image` / `og:url` from it at deploy, and the API uses it for absolute links (screenshot URLs, §5.2). It's never derived from request headers.


## 13. Runtime evolution: Demo, future connectors, and multi-runtime

### 13.1 `demo`: the proof
`src/adapters/demo` is a complete runtime adapter with **no runtime behind it**: a synthesised small team (Nova as primary, Sage, Pixel; Telegram, Slack and web-chat conversations; three scheduled flows; four skills).
- **The canonical path is enough.** It hands the engine canonical values only (`ingestCanonical`: agents, sessions, flows, runs, skills, skill info, channels, transcripts, config, hello). It has no raw schemas, no routes, no gateway, no CLI and no network (tested: no socket is opened).
- **Deterministic:** a seeded PRNG plus a tick counter. The same seed and ticks give the same history (tested); wall-clock time only stamps it.
- **Live:** a tick every 4 s moves conversations, the primary's bursts, sub-agents, flow runs and transcripts. The office, journal, logs and flows move with it.
- **Clean:** zero data-quality issues over 200 ticks (tested), and no personal value.
- **Read-only for runtime writes:** no write capability, so `meta.readonly`, and flows, skill toggles, chat and restart don't exist on it (404 `not_found`, api-v3.md D1; R22-05). Store features (projects, layout) work, so people can try the product.
- **Setup capability:** `setup.connect: true` means the adapter can be selected and configured during setup. It does not imply a remote socket or connection fields: Demo supplies `fields: []` and `defaultGatewayUrl: null`, and its readiness check succeeds locally. Presence-only adapters declare `connect: false` and cannot be selected as transports. This setup descriptor flag is separate from the runtime feature capabilities.
- **Selected by:** `runtime: { adapter: 'demo', demo: { seed } }` in the instance config, `AO_RUNTIME=demo`, or choosing « Démo » in setup (no connection fields). v1 never mounts with it.

### 13.2 What the demo showed is still OpenClaw-flavoured in the core (to fix before a third adapter)
| Where | What | Direction |
| --- | --- | --- |
| `MetaVM.capabilities.openclawWrites` | the runtime-writes flag is named after OpenClaw | 3.x: `runtimeWrites` (keep the 2.x/3.0 name as an alias until the UI reads `runtime.capabilities`) |
| `Config` (canonical) | `discord` is a top-level field of the runtime config projection | `channels.<ref>.{policy…}` per channel, so access policies work for any channel family (AccessVM D5 already shows them null elsewhere) |
| Flows commands | create and edit take `cron` + `tz` (OpenClaw's `cron add` flags) | a `Schedule` input (`cron` / `every` / `at`), validated per `runtime.capabilities.flows.schedules` |
| Chat | the chat session is the runtime's explicit key (`sessionKeyFor(agent, 'portal-chat')`) | keep the hook, but let an adapter say it has no explicit sessions (chat then creates a conversation) |
| Setup | `ADAPTERS` (fields, default URL) is a list in `setup.js` | each adapter owns `detect(ctx)` and `setup = { connect, fields, defaultGatewayUrl, configSchema, config, env, overrideEnv?, credential?, probe?, discover }`; detect/discover return canonical `{id,name,nameSource,isPrimary,model}` rows. The core never calls runtime-specific listing RPCs. Presence-only detection is not a transport; multiple detected connectable transports require operator choice. |
| v1 | the legacy API and runtime are OpenClaw-only | deleted at S16 (`s16-v1-removal.md`) |
| Skill docs | `skillDoc(filePath)` reads a local file | an adapter read (`skillDoc(name)`), so a remote runtime can serve it |

### 13.3 What a Hermes adapter will need (to verify against Hermes's real API before G7)
This is the interface a second real runtime must meet. Each point is a question for Hermes's documentation or API, **not a claim about it**.
1. **Identity and transport:** how Agent Office connects (HTTP, WebSocket, a local socket or files), how it authenticates (token, device identity), and whether the connection pushes events or must be polled. → `definition.setup.probe`, `runtime.start`, capabilities `activity` (`events` vs `run-state` polling).
2. **Agents:** a listing with stable ids, display names, models, and which agent is the default. → canonical `Agent`; the resolver needs `isPrimary` or the config's `agents.primary`.
3. **Sessions and their kinds:** a list with stable keys, the agent, timestamps, token usage, and a run state (running, done or failed, with timestamps). Also how direct conversations, groups, scheduled runs and sub-agents are told apart, and whether a channel and peer id are available. → `Classification` (`conversation-direct` / `-group`, `scheduled`, `subagent`, `internal` + `runtimeKind`), `interlocutorId` `<channel>-user|room:<id>`.
4. **Transcripts:** paged messages, with roles, tool calls and outputs, and model metadata. → canonical `Transcript` (`TraceEvent` kinds).
5. **Scheduling:** whether Hermes has scheduled jobs; their schedule forms, history and next run; whether they can be created and edited. → `CronJob` / `CronRun`, capabilities `flows.{read, write, schedules, multiAgent}`, and the runtime's own fields in `ext.hermes`.
6. **Skills or tools:** a catalog with on/off state and requirements; whether toggling exists. → `Skill` / `SkillInfo`, `skills.{toggle, detail}`.
7. **Channels:** which messaging connectors exist and their health. → `Channel` with a `ChannelRef` slug and the adapter's label.
8. **Health and version:** a version string and a liveness signal. → `hello`, `runtimeHealth`.
9. **Writes:** sending a message as the owner (chat), and restarting. Each is a capability; anything absent is simply false (the demo proves the UI degrades cleanly).

**Plan:** a `hermes` adapter (a later step; G7 became the enrichers, §14) starts with a capture of a real Hermes instance (as `capture-fixtures.js` did for OpenClaw), written as committed synthetic fixtures plus a `hermes` foreign-instance scenario. It must pass the same gates: the foreign-instance test, the portability lint and the v3 examples. §13.2 is fixed first where it blocks Hermes.

### 13.4 Multi-runtime amendment (T-0022, 2026-10-10): design approved (critic-42, 88da2656)

**Review gate:** this amendment is the first deliverable of `multi-runtime-1`. No implementation starts before critic GO; implementation then goes through critic followed by security. It supersedes the one-active-adapter restriction in §§3, 5 and 13.1 and the single-runtime Settings restriction in `api-v3.md`. §§13.1–13.3 remain the historical rationale. Config version 3 is independent of API contract versions.

#### Config v3 and upgrade

An adapter **kind** identifies a registered connector definition. A runtime **instance ID** identifies one configured source and is stable across edits, restarts and disabling/re-enabling. Two instances may use the same kind. Neither a display name, list position, URL nor filesystem path supplies its identity. Optional `name` is human-editable instance metadata (1–80 characters, no controls), defaults to the adapter name, and is excluded from adapter options/checks; renaming preserves the running source.

```json
{
  "version": 3,
  "runtimes": [
    { "id": "legacy", "adapter": "openclaw", "enabled": true,
      "openclaw": { "gatewayUrl": "ws://127.0.0.1:18789" } },
    { "id": "cli-local", "adapter": "claude-code", "enabled": false,
      "claude-code": { "home": "/srv/runtime-fixtures/claude-config", "agentGrouping": "project",
        "projects": { "include": [], "exclude": [] } } }
  ],
  "agents": { "primary": null, "names": {}, "looks": {}, "hidden": {}, "configured": {} }
}
```

This is the runtime/agent fragment, not a complete config: existing required `instance`, `owner`, `network`, enrichers and integration settings survive. `home` is the Claude **config directory**, replacing `~/.claude`, not the OS home; the path above is illustrative synthetic data. Runtime IDs use `[a-z][a-z0-9-]{0,31}`, are unique, and cannot be renamed by a Settings update. The schema validates each entry through the adapter's declared config schema, including disabled entries; a presence-only connector cannot be enabled. An empty list or all-disabled list is valid and leaves the authenticated office/store available.

The v3 reader accepts v2 and produces a v3 effective config without writing during GET or startup. A v2 `runtime` becomes one enabled entry with ID `legacy`; its raw primary, looks and adapter-keyed names/hidden/configured records map to that instance using the identity codec below. Explicit null names remain null. Unrelated fields, owner database authentication, session secret and gateway credential remain unchanged. The v3 secrets file has `{version:3, sessionSecret, runtimes:{[runtimeId]:{runtimeToken}}}`; an adapter with no credential has none. A token is never shared across instances. Existing v1 authentication migration remains supported through its existing recovery path before v3 publication.

The first successful config mutation publishes v3 config **and** secrets through the existing unique safe publisher, revision lock and crash-recovery digest, with a private recoverable preimage. No second writer and no opportunistic rewrite. Namespace migration of persistent references is transactionally recorded in the AO database before the v3 publication becomes visible; an interrupted publication recovers to the matching config/database generation before serving. Readers accept mapped legacy references until migration completes. Existing Person IDs, project IDs, look asset IDs and history/audit IDs do not change; their agent/session links, scoped-token principals, office seen/layout references, sender-capture keys and keyed caches are migrated through typed mappings, never text substitution. A dry-run inventory of those repositories is an implementation gate; disabling an instance keeps historical links, removing it never reuses its ID for a different source.

Environment wins over file as today, but cannot broadcast credentials: legacy `AO_RUNTIME`, `AO_PRIMARY_AGENT`, adapter URL/token variables and `AO_AGENT_*` overrides target only the `legacy` instance. Without a file, they create the same single legacy entry. In v3 without that entry, legacy runtime overrides produce a declared configuration issue rather than targeting another instance. A kind-changing override requires that kind's explicit credential and does not reuse the old token. Configured environment values remain read-only in Settings. Additional instances are configured through v3/Settings; no new environment syntax is required in this step.

#### Identity, merge and routing

One core codec produces `rt:<runtimeId>:<entity>:<base64url(UTF-8 localId)>`, with entity tags `agent`, `session`, `flow`, `run`, `event`, `tool`, `sender`, `skill`, `channel`. Encoding is canonical and reversible; native IDs are never parsed as core grammar. A trace event's local identity includes its native session and block identity using a structured tuple, so message IDs reused in another session cannot collide. All relationship fields are mapped together: session agent/parent links, tool call/result pairing, Sender/delegation/participants, flow targets, project links and primary references. `Sender.runtime` is the stable instance ID, with adapter kind available as separate runtime metadata. Existing externally verified human Person identities may still link the same Person across runtimes; that does not merge agents or transcript events.

The supervisor owns isolated adapter instances and scoped engine ingestion contexts. Each adapter keeps local/native IDs; the core maps at the boundary and demaps only when routing a read/command to its owner. Unknown or wrong-instance references fail before adapter invocation. Contexts carry an immutable instance ID plus generation and reject late ingestion after close/replacement. Registered factories, config schemas, fields, reads, sender hooks and capabilities support subsequent Codex/Cursor connectors without a core adapter-name branch.

Scoped source admission validates native identity and relationship fields with the codec's nonempty, control-free, well-formed UTF-8 policy and 4,096-byte bound. Composed event/tool tuples must also fit that bound without truncation. Invalid snapshots are quarantined with declared field paths only and retain the last-good source data; rejected raw session snapshots cannot establish deletion. The shared union additionally contains unexpected pre-admitted/projection failures per row/source, so another source's agents, primary, metadata, office and Settings remain available. Settings discovery IDs use the same policy before encoding.

An adapter's full agents/sessions/flows snapshot replaces **only its own partition**. Partial pages/upserts are not deletion signals; a complete paginated snapshot commits atomically for that partition. The office unions canonical partitions and uses deterministic stable-ID tie breaks; identical native IDs or project names from different runtimes never deduplicate. A single core change bus assigns monotonic SSE sequence IDs after ingestion, with existing bounded replay/reset semantics; timestamps remain producer facts and cannot determine event uniqueness. Quarantine/source health, config, channels and skills are instance-scoped. No global last-write-wins runtime config.

`agents.primary` stores the canonical agent ID from any enabled instance. The shared resolver checks configured visible primary, then adapter primary flags in configured runtime order, then the first visible agent by stable ID; invalid config emits the existing primary issue. A transient outage retains the selected primary and marks its source unavailable rather than moving it to a healthy runtime. Explicit disable/removal re-resolves it; no enabled visible agent means null. The office's `primary` role/look alias stays a presentation alias, never a routing identity. Names/hidden/configured sets are instance-keyed and looks use canonical agent IDs.

API revisions are explicit: v3 **3.3** exposes canonical IDs and `MetaVM.runtimes[]` with `{id,adapter,name,enabled,connection,capabilities}`; entity provenance identifies its instance. v2 **2.7** projects existing `legacy` agent/session wire IDs where required for compatibility, while other instances use canonical IDs; projectors own every alias and resolve only the legacy partition. A collision with an alias fails validation, never misroutes. Compatibility singular `meta.runtime` describes the primary's runtime (or legacy/first enabled/null when no primary), not the office's sole runtime. Every command/read routes by entity provenance; create commands require an explicit runtime ID when more than one eligible source exists. Global read capability summaries may aggregate, but command availability is always checked against the target instance and entity. Unsupported operations retain the existing unavailable/404 policy; a healthy connector cannot grant writes to Claude Code.

Previously issued v2 aliases that resemble canonical IDs receive `409 ambiguous-runtime-id` before any read/write. Their SHA-256 refusal fingerprints are committed synchronously to the singleton `runtime_alias_policy` store table (migration 020) before forwarding legacy changes, and loaded before creating the first facade on cold boot. The ledger keeps at most 4,096 hashes; saturation permanently refuses parsed v2 aliases. Removal/disable, absence or outage of legacy, live-generation replacement and API restart cannot clear the policy. Invalid persisted history fails closed; a write failure refuses compatibility dispatch and retries persistence with the overflow policy. The repository merges monotonically in a store transaction and is excluded from ordinary retention. V3 canonical IDs keep their existing routing semantics.

#### Failure isolation and bounded work

Start/check/poll/stop/read failures are caught per instance. One rejected start or hanging read never prevents other starts, canonical ingestion, Settings, store views or SSE. Each operation has a timeout/abort and instance generation fence; teardown cannot wait indefinitely for an uncooperative adapter. Retries are per-source capped exponential backoff. An outage keeps its last-good partition with explicit stale health; a successful authoritative snapshot reconciles it. Runtime-disabled data is retained for history but excluded from live presence. Removing/pausing one instance closes only its resources. Supervisor/app restart remains the core-owned Settings operation coordinated with T-0020, not a gateway restart. The OpenClaw gateway restart capability is false for remote endpoints. Local gateway restart uses only that instance's RPC; no host-service association is declared, so the default systemd fallback is removed for every instance, including legacy. RPC refusal or a late rejection after timeout/replacement cannot initiate a host restart.

Admission limits are declared and observable, not silent truncation: maximum 32 configured instances; 2 outstanding local file reads per instance and 8 globally; fair round-robin source scheduling, at most 100 directory/stat entries or 256 KiB read per scheduling turn, then yield. Claude metadata index defaults to 2,000 sessions per instance, retains no transcript bodies, and reports `capacity-limited` if candidates exceed its cap. Directory enumeration is incremental/bounded rather than `readdir` of the entire tree into memory. Rescans reconcile in chunks; discovery order is deterministic and excess sessions stay excluded until capacity frees, with excluded count/continuation state visible.

At most 32 actively tailed sessions per instance, selected by recent activity or an opened transcript; idle candidates rotate through bounded stat checks so newly active sessions enter the tail set. No watcher or timer per session. Polling is the correctness path; directory watches, if supported, only prompt a bounded scan. The global pending-key queue is capped at 256 and coalesces instance+session refreshes; overflow triggers partition rescan, never an unbounded queue. Transcript cache is at most 16 sessions/8 MiB per instance and 32 MiB globally, with LRU eviction. Tail bootstrap reads at most 256 KiB, skips an initial partial line and reports a clipped window; explicit older-history reads are paged and bounded. A line is capped at 1 MiB, nesting at 32 and blocks at 256; oversize lines are discarded to the next newline without accumulating them. Limits cover intermediate buffers and failed parsing, not just final cache values. Limits are proposed defaults verified by the synthetic scale gate, not claims of measured performance yet.

#### Claude Code: documented facts and compatibility boundary

Official sources consulted 2026-10-10:

| Source | Documented fact used here |
| --- | --- |
| [Claude Code sessions](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored) | Default local storage is `~/.claude/projects/<project>/<session-id>.jsonl`; project directory naming can be overridden. The local entry format is internal and can change between versions. Storage location, retention and persistence are configurable. |
| [Claude Code hooks](https://code.claude.com/docs/en/hooks#common-input-fields) | Hook input identifies session, transcript path, cwd and event. User/tool/stop/session/subagent events describe lifecycle. SubagentStop distinguishes the main and nested subagent transcript paths. |
| [Claude Code settings](https://code.claude.com/docs/en/settings) and [settings examples](https://code.claude.com/docs/en/settings-example) | Settings have user/project/local/managed scope and precedence. `cleanupPeriodDays` controls deletion of old session data. The connector must tolerate deletion and must not edit these settings as a consequence of enabling reads. |
| [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions#list-and-read-sessions) | SDKs offer supported listing/reading functions (`listSessions`/`getSessionMessages`, with Python equivalents). This is a future alternative to maintaining a local-format parser; this task adds no SDK dependency or CLI invocation. |
| [Agent SDK streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output#message-flow) | Assistant output can arrive as separate content blocks sharing a message ID; streaming deltas and complete messages differ. This informs block identity and avoiding duplicates, but does **not** document the local JSONL envelope. |

**Decision despite the internal format:** the requested read-only local transport is a bounded compatibility parser, not a claim that Claude guarantees a transcript API. Versioned adapter schema profiles and synthetic fixtures describe recognized local envelopes; unknown structural variants fail that session/profile with category `unsupported-format`, preserving last-good data and all other runtimes. Extra metadata may be ignored only when the recognized message structure remains valid. `testedWith` lists fixture/profile coverage honestly, not an installed Claude version inferred by executing it. Supported SDK/CLI streaming formats are not silently treated as the on-disk format.

The initial compatibility profile recognizes a JSONL record's `type`, `sessionId`, `uuid`, `parentUuid`, `timestamp`, `cwd` and `message.{role,content,model,usage}` as **profile assumptions**, not documented stable fields. Session ID from a validated filename must agree with a present envelope ID. Native record UUID + content block index/type (or tool-use ID when available) gives event identity; missing UUID falls back to file-generation+byte-offset, never body/time matching. Parent linkage and known compaction markers constrain the active branch; ambiguous ancestry is shown as a partial trace, without inventing a linear conversation. Duplicate/replayed UUIDs and identical assistant message IDs with distinct blocks are tested separately.

In project grouping, the default display name is the basename of the first validated absolute `cwd` in an accepted transcript window, retained for that file generation. Discovery and live publication use the same bounded reader and label policy; a chosen Settings name overrides detection. Only that basename leaves the adapter as display metadata: canonical agent workspace and session cwd remain null, and cwd is never opened or used for identity or authorization. Invalid/missing cwd keeps the opaque digest fallback. The [documented storage key](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored) loses non-alphanumeric characters and can be truncated or overridden, so it cannot be reversed reliably to recover the project name. The JSONL cwd remains a compatibility-profile assumption. A clipped tail may start after a working-directory change; without a recognized project cwd in the available window the owner can correct the display name in Settings.

Display metadata is private, including project basenames and chosen Settings names. Both API versions expose a request-aware `/meta`: absent, invalid, expired or revoked owner cookies receive static bootstrap labels, null primary/runtime, no instance name, an empty runtime list on v3 and no source inventory. A valid owner session receives the existing enriched metadata; scoped bearer credentials cannot inherit it. Public and owner VM validation fallback caches are separate. Bootstrap keeps versions, capabilities, locale/time zone, the configured gate and process-lifetime bootId for login/setup/restart. The client clears private metadata synchronously on logout/401, refreshes after login and Settings changes, and invalidates in-flight metadata/language responses across auth transitions. No private dictionary is persisted in browser storage.

| Recognized profile content | Canonical projection / safeguards |
| --- | --- |
| Top-level main transcript | The adapter's declared `agentGrouping` setting is `project` by default, or `runtime`. In project mode, all sessions in the same opaque project directory key belong to **one agent**, with local agent ID `project:<SHA-256(relative-project-key)>`; in runtime mode, every project/session belongs to **one agent**, local ID `runtime`. A native session UUID identifies a session only, never an agent. IDs are scoped by the configured instance, independent of labels and session count. Session class is generic `conversation`, channel null, with `runtimeKind: 'cli'` only where the contract permits it. Project directory is never a reconstructed trusted cwd or filesystem permission. Opening old history does not create a live agent. |
| Assistant `text` / `thinking` block | `assistant` / `thinking` trace, agent Sender, safe Markdown path. Model/usage come only from validated fields; absent cost/usage stays null. No inferred billing or hidden reasoning extraction. |
| Assistant `tool_use` block | `tool` trace with validated name/input and exact call ID. Tool call evidence yields generic `working` activity, without guessing an OpenClaw-specific animation/tool taxonomy. |
| User `tool_result` block | `toolResult` trace paired by `tool_use_id`, tool Sender. It is never a human user turn; error flag describes that tool result, not automatically the whole session. |
| User text / synthetic input | Human only for a recognized visible prompt. Known injected/delegated/system inputs get system/agent Sender; ambiguous input is system/unknown, never attributed from role alone. Local operator attribution requires an explicit configured ownership binding; otherwise human name remains null. |
| Known system/compaction/summary metadata | Safe canonical system/observation or bounded metadata as appropriate; internal summaries are not new human prompts. Unknown metadata is skipped without emitting payload diagnostics. |
| Verified parent/subagent relation | Canonical parent/child links and delegated Sender use scoped IDs. A nested file is admitted only under the approved root and known parent; a name or tool-input string cannot invent delegation. |

The adapter applies [sender identity rules](sender-identities.md) before previews, participants and project summaries: identity is descriptive, never authorization; payload text cannot identify the owner. No raw record, prompt, thinking text, tool arguments/output, unknown key, filename, cwd or exception message is logged or quarantined. Diagnostics contain declared category/counter and scoped opaque keys only; opaque project keys use a digest, and raw project paths are limited to authenticated Settings configuration. Transcript bodies stay in bounded memory and authorized trace responses, not an added database archive. Canonical Sender capture remains bounded, optional and subject to its existing policy. Deletion invalidates cached content at reconciliation; the connector does not reconstruct removed transcripts from summaries or backups.

`home` is explicitly configured before enabling; there is no automatic activation based on `.claude` or binary detection. An empty include list means all project directory keys **within that approved root**; otherwise exact directory keys are included, then excludes win. There are no executable globs, traversal components or client-supplied transcript paths. Only regular JSONL files under `<home>/projects` (and recognized nested subagent locations) are opened, with containment, no-follow/symlink checks and descriptor identity checks; credentials, settings, arbitrary cwd paths, memories and unrelated files are never read. Rotation/replacement/truncation creates a new file generation, resets offsets/partial buffers and reconciles the session; a trailing incomplete UTF-8/JSON line waits for newline. Shutdown closes descriptors and cancels pending reads. The connector creates no sockets, launches no processes and writes nothing to Claude storage.

Changing `agentGrouping` is an explicit revision-checked adapter setting update. New grouping IDs resolve the current sessions; previous agent identities and historical Person/project links remain intact and inactive, never renamed or reused. A primary pointing at an old grouping follows the shared invalid-primary policy; Settings previews the affected primary before save. Discovered project agents use explicit chosen names or a safe project label, never transcript/prompt content as their name. One new transcript under an existing project cannot mint another agent.

Activity is **inferred** from newly appended validated conversation/tool blocks: `working` for a 30-second observed-activity lease, then idle/unknown; bootstrap/history replay and metadata-only file touches never start work. An agent is working while **any** of its sessions has an unexpired lease; an idle session cannot overwrite another active session. Canonical activity gains neutral `source: 'transcript'` and evidence/expiry, leaving the required canonical `run` record idle with `evidence:none` and null terminal fields (no verified run). An inactivity timeout never emits `run.succeeded`/`run.failed` or proves the process ended. Claude capabilities: sessions/transcripts and inferred activity; chat, runtime restart, flows writes, skills toggle, costs and sender capture false unless separately implemented with evidence. Projects/layout/store capabilities remain independent.

Hooks are an optional future evidence source through an adapter integration descriptor. This phase ships transcript inference with hook integration `unsupported` and a reason; toggling a read-only connector does not install hooks. A later reviewed installation must use Settings plan/apply with explicit confirmation, owned-file backup/rollback and a bounded local event sink, never network telemetry. Even then Stop means a turn boundary, not session completion; SessionEnd is separate and duplicate/stale events require scoped deduplication. No arbitrary command from transcript/config data is executable.

#### Settings contract and implementation coordination

Backend-codex owns `/settings` and T-0020's integration descriptor/core restart work. Before changing its service, fixtures or publisher interfaces, agree the patch boundary and incorporate that task's reviewed commit. Keep adapter-owned `settings.resolve/probe/discover/integrationAgents/projectTag`, server-owned integration targets, optimistic revision, five-minute reauth, CSRF, URL/credential pairing, write-only token fields, environment source locks, null names, transactional publication and minimal Settings SSE. The ADR alone changes none of these surfaces.

Settings 3.3 lists registry kinds plus configured instances. A row gains `adapter`, stable instance `id`, and `enabled`; `selected` remains an enabled alias during transition. Presence-only kinds have no configured instance and cannot toggle on: FR « Détecté · connecteur à venir » / EN “Detected · connector coming”, plus a translated one-line reason. Detection is presence, never activation. Registered local read connectors have declared path/include/exclude fields and a read-only check instead of a gateway URL. Claude also declares the grouping choice: FR « Un agent par projet » (default) / « Un agent pour ce moteur », EN “One agent per project” / “One agent for this runtime”. Their status/check categories distinguish missing root, access denied, unsupported format and capacity limits. GET performs no probe or scan.

Add `PUT /api/v3/settings/runtimes` with `{expectedRevision,runtimes:[{id,adapter,enabled,name?,...adapterFields}]}` to publish a complete set atomically. Prepare/check only changed enabled instances; a failed check preserves the previous config/live generation. Explicitly disabling a failed source requires no successful probe. Existing `PUT /settings/runtime` remains a single-instance compatibility operation only when the effective config contains just `legacy`; otherwise return 409 with a translated use-multi-runtime reason, never replace the office's whole set. Check/discover/agents/plan operations use explicit instance scope; unsaved checks carry an explicit adapter candidate, and saved credential lookup requires both matching instance and endpoint. Raw agent IDs stay adapter-local in Settings actions; the primary selection is a separate canonical scoped reference. Publish changes restart only affected source generations. Integration support/status is per instance/target, supplied by its descriptor; an instance's unsupported integration cannot hide another's supported one.

Frontend renders registry fields and translated reasons without adapter-specific branching. Connection rows use on/off toggles, per-row check/status, and no one-runtime wording. It follows [layout frames](layout-frames.md): no document scroll, one body scroller, anchored frame footer, one topbar title; this task does not edit shared layout files in parallel. Existing v2/v3 Settings SSE payload stays `{revision,changed,restartRequired}` without credential, path or transcript values.

#### Required synthetic gates and rollout

1. **Upgrade/identity:** v2 read with no write; v3 publication/reload/recovery; environment precedence; exact credentials/null names/auth preservation; migration of every inventoried persisted reference; same native IDs in two instances, two instances of one kind, codec delimiter/Unicode/adversarial round trips, cross-instance command rejection and primary on either source.
2. **Merge/isolation:** snapshots/pages/upserts scoped to owner; healthy runtime ingests while another start/read/stop throws or never resolves; stale health, late-generation rejection, fair backpressure/overflow rescan, deterministic SSE order/replay, independent target capabilities and disable/re-enable teardown.
3. **Claude fixtures:** text/thinking/tool use/result, multiple blocks sharing a message ID, sender conformance, compaction/branch/subagent, malformed/unknown profiles, partial JSON/UTF-8, oversized line/depth/block count, deletion/truncate/rotation, path escape/symlink/descriptor race, source read-only/no-process/no-network assertions and no content/path in diagnostics. All runtime homes are temporary synthetic directories; tests and development never touch real `~/.claude`, `~/.codex` or `~/.openclaw`.
4. **Scale/grouping:** exactly 1,000 synthetic main sessions across 20 project keys (50 sessions each) must yield **20 Claude agents** in default project mode and **one Claude agent** in runtime mode, never 1,000 agents. This also exercises 12+ office agents. Adding another transcript under a known project preserves agent IDs/count; two instances with identical project keys remain distinct; changing grouping preserves historical links. With large transcripts, both idle and hot churn, assert queue/cache/descriptor/byte/scan budgets and an event-loop progress sentinel, then prove a newly hot idle session eventually enters the tail set, a second runtime continues updating, and activity aggregates across sessions without an idle sibling hiding work. Report measured runtime and memory separately from proposed limits; no full-suite run for this task.
5. **Contracts/UI:** v2 compatibility and v3 3.3 examples/schema docs; FR+EN, generic registry reasons, multiple Connection rows, explicit scoped changes/checks/primary, independent integration status, frame/mobile browser evidence; targeted release/budget/portability tests. Critic then security review before PM integration; implementation report records limitations, measurements and reviewed commit.

## 14. Enrichers and channel grammars are pluggable (G7)
Discord was wired into the core in four places:
- the composition root built it;
- the views and the source loop called its methods;
- the access VM mapped raw Discord profiles (incl. channel-type numbers);
- the cache repository held its profile schemas.

The OpenClaw classifier also hard-coded Discord's interlocutor-id rule. Two plug-in kinds replace that, each with a registry like the adapters'.

### 14.1 Channel grammars (static, always on)
How a channel family names its interlocutors, so the id of a conversation partner is stable data, never config.
```ts
interface ChannelGrammar {
  family: ChannelRef;                                   // 'discord'
  // → the interlocutor id of a conversation, or null when this channel has none for it
  interlocutorIdOf(c: { kind: 'conversation-direct' | 'conversation-group' | 'conversation'; scope: string; peer: string }): string | null;
}
```
- **Registry:** `src/channels/index.js`. A family without a grammar uses the **generic** one: `<family>-user:<peer>` for direct conversations, `<family>-room:<peer>` for groups, and none for an unknown scope (opaque peer, 1–128 chars, no control characters).
- **Discord's grammar:** bare snowflakes only. Direct → `discord-user:<sf>`; scope `channel` → `discord-channel:<sf>`; others none. These are its exact 2.x ids.
- **Adapters ask the registry** (`interlocutorIdOf(channel, …)`) and never import a channel package. Grammars are **not** configurable: disabling an enricher never changes an id.

### 14.2 Enrichers (selected by the instance config)
What can be learnt about an interlocutor beyond its id: names, avatars, room details.
```ts
interface EnricherDefinition {
  id: string;                                           // 'discord'
  families: ChannelRef[];                               // the interlocutor-id families it resolves
  cacheProfiles: Record<string, Schema>;                // id prefix → stored profile schema (interlocutor_cache validates with it)
  create(deps: { secret(name: string): string | null; cache: InterlocutorCache | null; now(): number; log(m: string): void }): Enricher;
}
interface Enricher {
  peek(id: string): { resolution: 'pending' | 'resolved' | 'failed'; profile: InterlocutorProfile | null };   // cached only, synchronous
  resolve(id: string): Promise<void>;                   // on demand (the interlocutor page)
  resolveAll(ids: string[]): Promise<boolean>;          // background, after each full refresh; true if it ran
  onChange(fn: () => void): void;                       // after every lookup (views refresh their names)
}
// What the core sees: already the InterlocutorVM profile variants. No raw provider field reaches a VM.
type InterlocutorProfile =
  | { displayName: string | null; username: string | null; avatarUrl: string | null; isBot: boolean; createdAt: number }   // a user
  | { name: string | null; type: string; topic: string; guildName: string | null; createdAt: number };                   // a room
```
- **Registry:** `src/enrichers/index.js`. `createEnrichment({ ids, deps })` picks the selected enrichers and routes each interlocutor id by its family.
- **No enricher for a family → `resolution: 'unresolvable'`**, with a null profile. 3.0 shows it; 2.x only shows Discord's, and reads `'unresolvable'` as `'pending'`, its old meaning for "no lookup will come".
- **Selection:** instance config `enrichers: string[]`, or `AO_ENRICHERS` (comma-separated; empty = none). The default is `['discord']`, so an existing install is unchanged.
- **Secrets:** asked by name (`secret('discord.token')`). The composition root answers from the runtime config (OpenClaw's Discord bot token, as today). An enricher never reads a file or the env itself.
- **The cache:** `interlocutor_cache` validates each row with the schema its enricher declares for that id prefix. Families without one keep the generic `{ displayName, avatarUrl }`. Rows stay as they are (no migration).

### 14.3 Discord, the first implementation (no behaviour change)
`src/enrichers/discord.js` keeps its REST lookups, pacing, cache, TTLs and preload, and adds the definition: families `['discord']`, its cache profiles, and the mapping from Discord's raw profiles to `InterlocutorProfile`. That mapping is display name, avatar URL, bot flag and creation time for users; name, channel-type slug, topic and guild name for rooms, and it moves here from the access VM. The v1 legacy routes keep using its legacy methods until S16.

**Gate:** v2 and v3 byte-identical over the golden corpus before and after; a foreign family gets a grammar-derived id and an `unresolvable` profile with Discord selected or not; with `enrichers: []`, Discord interlocutors are `unresolvable` (v3) or `pending` (v2), and no lookup is made.

## Sender identity amendment (2026-10-08)

Per-message identity belongs to the canonical engine model, not to a runtime or a channel-specific frontend. See [sender-identities.md](sender-identities.md) for the neutral Sender/Participant schemas, adapter hooks, generic CLI defaults and shared conformance gate. Runtime envelope parsing stays inside its adapter.
