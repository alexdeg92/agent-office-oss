'use strict';
/*
 * Scenario = one coherent set of fixtures (one capture, or one hand-written synthetic set).
 * Manifest: <root>/scenarios/<name>.json; every path in it is relative to that root. Two roots:
 *   test/fixtures/        committed, synthetic scenarios only;
 *   test/fixtures/local/  captured real-data scenarios: gitignored, never committed (PM, on review-06).
 * A scenario remembers its root (non-enumerable `fixturesDir`). Capture-based tests skip when absent.
 *
 * {
 *   "name": "synthetic-basic", "origin": "synthetic" | "capture", "openclawVersion": "2026.9.8",
 *   "now": <epoch ms the frozen clock uses>,
 *   "config": "config/openclaw/2026.9.8/synthetic-basic.json",          // optional (captures have none)
 *   "rpc":  { "<method>": "<file>" | { "param": "key", "files": { "<value>": "<file>" }, "default"?: "<file>" } },
 *   "events": { "onConnect": ["<file>"], "observed"?: ["<file>"] },
 *   "cli":  { "skills.list": "<file>", "skills.info": { "<name>": "<file>" }, "agent.turn"?: "<file>" },
 *   "host": { "df"?: "<file>" }
 * }
 *
 * Fixture files are envelopes: { "$fixture": {source, channel, origin, openclawVersion, params?}, "body": Body }
 * Body = { kind:'json', value } | { kind:'text', value, exitCode? } | { kind:'error', message, code? }
 */
const fs = require('fs');
const path = require('path');
const { FakeGateway } = require('./fake-gateway');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const LOCAL_FIXTURES_DIR = path.join(FIXTURES_DIR, 'local');

function readFixture(rel, root = FIXTURES_DIR) { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); }

const namesIn = (root) => { const d = path.join(root, 'scenarios'); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : []; };
const rootOf = (name) => (fs.existsSync(path.join(FIXTURES_DIR, 'scenarios', name + '.json')) ? FIXTURES_DIR
  : fs.existsSync(path.join(LOCAL_FIXTURES_DIR, 'scenarios', name + '.json')) ? LOCAL_FIXTURES_DIR : null);
const isLocalScenario = (name) => rootOf(name) === LOCAL_FIXTURES_DIR;
const hasScenario = (name) => rootOf(name) !== null;

function listScenarios() {
  // AO_SCENARIOS=a,b (test-only): restrict to some scenarios, e.g. when creating goldens for a new capture.
  const only = (process.env.AO_SCENARIOS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return [...new Set(namesIn(FIXTURES_DIR).concat(namesIn(LOCAL_FIXTURES_DIR)))].sort()
    .filter((n) => !only.length || only.includes(n)).map(loadScenario);
}

function loadScenario(name) {
  const root = rootOf(name);
  if (!root) throw new Error(`scenario ${name} not found (captured scenarios live in test/fixtures/local/, which is never committed)`);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', name + '.json'), 'utf8'));
  if (manifest.name !== name) throw new Error(`scenario ${name}: manifest name is ${manifest.name}`);
  Object.defineProperty(manifest, 'fixturesDir', { value: root, enumerable: false });
  return manifest;
}

// For capture-based tests: { skip } option for node:test when the local scenario is absent.
const skipUnlessLocal = (name) => (hasScenario(name) ? {} : { skip: `local capture ${name} absent (test/fixtures/local/ is never committed)` });

// Body → what the gateway RPC returns (payload or an error marker for FakeGateway).
function rpcResult(rel, root) {
  const b = readFixture(rel, root).body;
  if (b.kind === 'json') return b.value;
  if (b.kind === 'error') return FakeGateway.error(b.message, b.code);
  throw new Error(`${rel}: RPC fixture must be json or error, got ${b.kind}`);
}

function gatewayHandlers(sc) {
  const handlers = {};
  for (const [method, spec] of Object.entries(sc.rpc || {})) {
    if (typeof spec === 'string') { handlers[method] = () => rpcResult(spec, sc.fixturesDir); continue; }
    handlers[method] = (params) => {
      const file = spec.files[params[spec.param]] || spec.default;
      return file ? rpcResult(file, sc.fixturesDir) : FakeGateway.error('not found');
    };
  }
  // the portal always subscribes; accept like the real gateway
  for (const m of ['sessions.subscribe', 'sessions.messages.subscribe']) if (!handlers[m]) handlers[m] = () => ({ ok: true });
  // S7b: 2026.9.8 always has the (read-scoped) session-group catalog; a scenario without one has no groups
  if (!handlers['sessions.groups.list']) handlers['sessions.groups.list'] = () => ({ groups: [], sectionOrder: [] });
  return handlers;
}

function connectEvents(sc) {
  return ((sc.events && sc.events.onConnect) || []).map((rel) => {
    const f = readFixture(rel, sc.fixturesDir);
    return { event: f.$fixture.channel.replace(/^gw\.event\./, ''), payload: f.body.value };
  });
}

function helloPayload(sc) {
  const dir = path.join(sc.fixturesDir || FIXTURES_DIR, 'gw', 'hello', sc.openclawVersion || '');
  const f = path.join(dir, sc.name + '.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).body.value : { server: { version: sc.openclawVersion }, protocol: 4 };
}

function makeFakeGateway(sc, extraHandlers = {}) {
  return new FakeGateway({ handlers: Object.assign(gatewayHandlers(sc), extraHandlers), hello: helloPayload(sc), onConnectEvents: connectEvents(sc) });
}

module.exports = { FIXTURES_DIR, LOCAL_FIXTURES_DIR, readFixture, listScenarios, loadScenario, hasScenario, isLocalScenario, skipUnlessLocal, makeFakeGateway, gatewayHandlers };
