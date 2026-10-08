# Runtime adapters

Agent Office talks to an agent runtime through one adapter per instance. Two ids are registered: `openclaw` (the default) and `demo` (a synthesised team, no network). The contract is [ADR-001](../architecture/adr-001-runtime-adapters.md). The core, the API, and the UI see canonical types and capability flags. Transport, raw schemas, and runtime commands stay behind the adapter.

## Choosing an adapter

The instance config field `runtime.adapter` is applied as `AO_RUNTIME`. When that variable is unset, the id is `openclaw`. Any other id exits at boot. `demo` needs no gateway token and no runtime binary.

## What an operator sets for OpenClaw

Secrets and the gateway address stay in the environment ([config.md](config.md)):

| Variable | Role |
| --- | --- |
| `OC_GATEWAY_TOKEN` | Gateway credential. Required for a live OpenClaw connection. The process still boots without it and the adapter reports not configured. |
| `OC_GATEWAY_URL` | Gateway WebSocket. Default `ws://127.0.0.1:18793`. From Docker on the same host, `ws://host.docker.internal:18793`. |
| `OC_HOME` | Runtime home. Default `~/.openclaw`. |
| `OC_BIN` | Optional path to the `openclaw` binary. |

CLI-backed features need the runtime binary and its home visible to the process. The Docker compose file does not mount them. Without that mount, those capabilities stay off.

Do not put a token, a password, or a private key in the image, the formula, or the npm package.

## Writing an adapter

Add `src/adapters/<id>/index.js` and register it in `src/adapters/index.js`:

```js
const ADAPTERS = {
  openclaw: () => require('./openclaw'),
  demo: () => require('./demo'),
};
```

The id matches `[a-z][a-z0-9-]*`. The module exports `definition` and `createRuntime(cfg)`. `server.js` loads it with `adapterById` and never imports the adapter's other files.

`definition` is static. Both registered adapters set:

| Field | Role |
| --- | --- |
| `id`, `name` | Registry id and display name. |
| `testedWith` | Runtime versions the schemas were checked against, or `null` when there is no runtime. |
| `schemas` | Raw JSON schemas keyed by channel. Empty when the adapter ingests canonical values only. |
| `routes` | Channel to canonical operation (`op`, optional `prep` and `key`). Empty for a canonical-only adapter. |
| `eventPrefix` | Prefix for an event name the core does not know. |
| `gatewayLabel`, `gatewayLabels` | French and English names for this runtime's transport. |
| `sessionKeyFor(agentId, ref)` | Session key for an explicit conversation. |
| `normalise` | Raw value to a canonical value, per operation. A canonical-only adapter can pass the row through. |
| `classifySession` | Session key to `{ kind, ruleId, agentId, ... }`. |
| `capabilities()` | What this runtime can do. The UI hides actions this returns false. A command whose capability is false is not offered. |

`createRuntime(cfg)` is the connection. It returns `attach(engine)`, `start(engine, hooks)`, `close()`, `reads`, `commands`, `skillDoc`, `refreshFlows`, and `refreshSkills`. `gw` and `cli` are the transports, or `null` when there is no process to talk to.

OpenClaw (`src/adapters/openclaw/index.js`) is the transport adapter. It validates raw gateway, CLI, and config bodies, normalises them, and ingests through the taps. Its channel ids are the historical `gw.*`, `cli.*`, and `config.openclaw` names because those ids are already on the wire. A new adapter namespaces its channels with its own id.

`demo` (`src/adapters/demo/index.js`) is the proof that the interface is enough. It calls `engine.ingestCanonical(...)` with canonical values only: no gateway, no CLI, no network. `capabilities()` leaves writes off, and `commands` is empty. Tests drive it from `test/adapters/demo.test.js`.

Rules for a new id:

- One adapter per instance. Do not branch the core on the runtime name.
- Tokens, device keys, and command output stay inside the adapter. They do not appear on canonical types.
- Do not invent a canonical field. Producers follow `docs/architecture/examples`.
- Ship fixtures and a contract test with the adapter. The demo test is the pattern: deterministic, no live binary, both locales when the adapter emits text.
- User-facing labels go through `gatewayLabels` and the i18n files, French and English.
