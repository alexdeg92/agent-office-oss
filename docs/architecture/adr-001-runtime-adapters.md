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
    agentTurn(input: { agentId: AgentId; text: string; sessionRef?: string; timeoutMs: number }): Promise<TurnResult>;
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


## 13. A second adapter: `demo` (G6), and what Hermes will need

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
