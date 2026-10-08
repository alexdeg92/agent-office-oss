# Tests

`npm test` runs every `test/**/*.test.js` with the built-in `node:test` runner. There are no dependencies, and nothing touches the live gateway, the real `openclaw` binary, `~/.openclaw` or systemd.

| Path | What |
| --- | --- |
| `api/` | The v2/v3 API on the real server: views, commands, the typed stream, auth on every route (`auth.test.js`, checked against the declared routes), setup, contracts. (v1's characterisation goldens went with v1 at S16.) |
| `engine/` | The canonical engine, its quarantine and the golden canonical corpora (`golden/engine-*`). |
| `ops/`, `e2e/` | Health probes, backup/restore, doctor; the captured-traffic soak (local captures only). |
| `store/` | The store (S5): migrations, boot guards, backups, repositories, quarantine persistence, the Discord cache; server-level restart, audit and instance-guard tests. Each test uses its own `mkdtemp()` data dir (`AO_ENV=test`). |
| `unit/` | The redactor, the fake gateway and fake CLI, a capture-script dry run, and fixture hygiene (leak scan, envelope shape, scenario references). |
| `helpers/fake-gateway.js` | An in-process OpenClaw gateway (protocol v4 frames). Answers RPCs from a handler map and pushes events with `emit()`. |
| `helpers/harness.js` | `startServer(scenario)`: spawns `server.js` with a frozen clock, a temp `HOME` and data dir (`AO_DATA_DIR`), test credentials, the FakeGateway and the fake CLI. |
| `helpers/freeze-env.js` | Preloaded into the server under test; freezes `Date` and the `os` metrics. |
| `bin/openclaw`, `bin/df`, `bin/systemctl` | Fake binaries. `systemctl` refuses everything. |
| `fixtures/` | Scenario manifests plus envelope files (`{ $fixture, body }`); see `helpers/scenario.js` for the format. |
| `golden/` | Expected outputs. |

## Commands
- **`npm test`:** run everything.
- **`npm run test:golden`:** rewrite the goldens. Review the diff: in S1–S7 a golden diff is either a bug or a deliberate change that must be listed.
- **`npm run fixtures:synthetic`:** regenerate the hand-written `synthetic-basic` scenario.
- **`node scripts/capture-fixtures.js --label <name>`:** capture a real, redacted scenario. **The PM runs this** on the host and reviews the printed redaction report. Each new scenario is picked up by the golden-based engine tests automatically; run `npm run test:golden` once to create its goldens.
