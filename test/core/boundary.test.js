'use strict';
// G2 (ADR-001 §12.1, §12.4): the adapter boundary and runtime-home rules.
//   - lint: no VM reads a raw channel (`engine.latest(` in src/api/v2/**), and core never imports adapter internals;
//   - every OpenClaw path derives from one runtime home (no literal), each still overridable;
//   - the server boots and serves without an identity (foreign HOME), the gateway source down as `not-configured`.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const ROOT = path.join(__dirname, '..', '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// The rules, as functions over (file, text), so the mutation test below can prove they bite.
const RAW_READ = /\bengine\.latest\s*\(/;
const ADAPTER_INTERNAL = /require\(\s*['"][^'"]*\badapters\/[a-z0-9-]+\/[^'"]*['"]\s*\)/;
function violations(files) {
  const out = [];
  for (const { file, text } of files) {
    if (file.startsWith('src/api/v2/') && RAW_READ.test(text)) out.push(file + ': engine.latest( in a v2 VM/route');
    if (!file.startsWith('src/adapters/') && ADAPTER_INTERNAL.test(text)) out.push(file + ': imports adapter internals');
  }
  return out;
}

describe('core · adapter boundary lint (§12.4)', () => {
  const files = walk(path.join(ROOT, 'src')).map((p) => ({ file: rel(p), text: fs.readFileSync(p, 'utf8') }));

  it('no engine.latest( in src/api/v2; no adapter internals imported outside src/adapters (no exception since S16)', () => {
    assert.deepEqual(violations(files), []);
  });

  it('the lint bites (mutation): a raw read in a v2 VM and a deep adapter import are both reported', () => {
    const mutated = [
      { file: 'src/api/v2/vm/x.js', text: "const h = engine.latest('gw.hello');" },
      { file: 'src/engine/x.js', text: "const { Gateway } = require('../adapters/openclaw/transport');" },
      { file: 'src/projects/x.js', text: "require( \"../../adapters/openclaw/normalise/session\" )" },
      { file: 'src/engine/ok.js', text: "const { defaultAdapter } = require('../adapters');" },
      { file: 'src/api/routes/x.js', text: "require('../../adapters/openclaw/cli');" },
    ];
    assert.deepEqual(violations(mutated), [
      'src/api/v2/vm/x.js: engine.latest( in a v2 VM/route',
      'src/engine/x.js: imports adapter internals',
      'src/projects/x.js: imports adapter internals',
      'src/api/routes/x.js: imports adapter internals',
    ]);
  });

  it('no personal path or account literal in src (§12.1)', () => {
    const hits = files.filter(({ text }) => /\/home\/Owner\b|alexdeg92/.test(text)).map((f) => f.file);
    assert.deepEqual(hits, []);
  });
});

describe('config · one runtime home (§12.1)', () => {
  const { openclawPaths, loadConfig } = require('../../src/config');
  const required = { OC_GATEWAY_TOKEN: 't', PORTAL_EMAIL: 'a@b.c', PORTAL_PASSWORD: 'p', PORTAL_SECRET: 's' };

  it('derives identity, state DB, config and bin from HOME; OC_HOME wins; each path stays overridable', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-home-'));
    try {
      const p = openclawPaths({ HOME: home, PATH: '' });
      assert.deepEqual(p, {
        openclawHome: home,
        identityPath: path.join(home, '.openclaw', 'identity', 'device.json'),
        stateDbPath: path.join(home, '.openclaw', 'state', 'openclaw.sqlite'),
        openclawConfigPath: path.join(home, '.openclaw', 'openclaw.json'),
        openclawBin: path.join(home, '.npm-global', 'bin', 'openclaw'),
      });
      assert.equal(openclawPaths({ HOME: '/nowhere', OC_HOME: home, PATH: '' }).identityPath, path.join(home, '.openclaw', 'identity', 'device.json'));
      const o = openclawPaths({ HOME: home, PATH: '', OC_IDENTITY: '/x/id.json', OC_STATE_DB: '/x/s.sqlite', OC_CONFIG: '/x/c.json', OC_BIN: '/x/oc' });
      assert.deepEqual([o.identityPath, o.stateDbPath, o.openclawConfigPath, o.openclawBin], ['/x/id.json', '/x/s.sqlite', '/x/c.json', '/x/oc']);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('bin: the first executable `openclaw` on PATH, then <home>/.npm-global/bin/openclaw', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-bin-'));
    try {
      const a = path.join(tmp, 'a'), b = path.join(tmp, 'b');
      fs.mkdirSync(a); fs.mkdirSync(b);
      fs.writeFileSync(path.join(a, 'openclaw'), '');                       // not executable: skipped
      fs.writeFileSync(path.join(b, 'openclaw'), '#!/bin/sh\n', { mode: 0o755 });
      assert.equal(openclawPaths({ HOME: tmp, PATH: [a, b].join(path.delimiter) }).openclawBin, path.join(b, 'openclaw'));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('projects discovery is off until an owner or a workspace root is configured; no default owner or root', () => {
    const home = os.tmpdir();
    const none = loadConfig(Object.assign({ HOME: home, AO_ENV: 'test', AO_DATA_DIR: path.join(home, 'ao-x') }, required));
    assert.deepEqual([none.projectsDiscovery, none.projectsOwners, none.projectsRoot], [false, [], null]);
    const owners = loadConfig(Object.assign({ HOME: home, AO_ENV: 'test', AO_DATA_DIR: path.join(home, 'ao-x'), AO_PROJECTS_OWNERS: 'acme, beta' }, required));
    assert.deepEqual([owners.projectsDiscovery, owners.projectsOwners], [true, ['acme', 'beta']]);
    const root = loadConfig(Object.assign({ HOME: home, AO_ENV: 'test', AO_DATA_DIR: path.join(home, 'ao-x'), AO_PROJECTS_ROOT: '/srv/work' }, required));
    assert.deepEqual([root.projectsDiscovery, root.projectsRoot], [true, '/srv/work']);
    const off = loadConfig(Object.assign({ HOME: home, AO_ENV: 'test', AO_DATA_DIR: path.join(home, 'ao-x'), AO_PROJECTS_ROOT: '/srv/work', AO_PROJECTS_DISCOVERY: '0' }, required));
    assert.equal(off.projectsDiscovery, false);
  });
});

describe('transport · no identity is a state, not a crash (§12.1)', () => {
  const { Gateway, loadIdentity } = require('../../src/adapters/openclaw/transport');

  it('loadIdentity: missing files → no-identity; corrupt JSON or incomplete identity → identity-invalid', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-id-'));
    try {
      assert.deepEqual(loadIdentity({ identityPath: path.join(tmp, 'none.json'), stateDbPath: path.join(tmp, 'none.sqlite') }), { missing: 'no-identity' });
      fs.writeFileSync(path.join(tmp, 'bad.json'), '{');
      assert.deepEqual(loadIdentity({ identityPath: path.join(tmp, 'bad.json') }), { missing: 'identity-invalid' });
      fs.writeFileSync(path.join(tmp, 'partial.json'), JSON.stringify({ deviceId: 'd' }));
      assert.deepEqual(loadIdentity({ identityPath: path.join(tmp, 'partial.json') }), { missing: 'identity-invalid' });
      // a state DB without a primary identity
      const { DatabaseSync } = require('node:sqlite');
      const dbFile = path.join(tmp, 'state.sqlite');
      const db = new DatabaseSync(dbFile);
      db.exec('CREATE TABLE device_identities (identity_key TEXT, device_id TEXT, public_key_pem TEXT, private_key_pem TEXT)');
      db.close();
      assert.deepEqual(loadIdentity({ identityPath: path.join(tmp, 'none.json'), stateDbPath: dbFile }), { missing: 'no-identity' });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('the Gateway constructs without identity or token and never connects', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-gw-'));
    try {
      const none = new Gateway({ url: 'ws://127.0.0.1:9', gatewayToken: 't', identityPath: path.join(tmp, 'x.json'), stateDbPath: path.join(tmp, 'x.sqlite') });
      assert.equal(none.notConfigured, 'no-identity');
      const seen = [];
      none.on('not-configured', (r) => seen.push(r));
      none.start();
      assert.deepEqual(seen, ['no-identity']);
      assert.equal(none.ws, null, 'no socket opened');
      await assert.rejects(() => none.call('agents.list', {}), /not connected/);
      assert.equal(new Gateway({ url: 'ws://127.0.0.1:9', gatewayToken: '', identityPath: path.join(tmp, 'x.json') }).notConfigured, 'no-token');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('server · boots without an identity (foreign HOME, §12.1)', () => {
  const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

  it('serves the API; the gateway source is down with category not-configured', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-foreign-'));
    const port = await freePort();
    // From scratch: no OC_* at all, a HOME with neither the JSON identity nor the state DB, no openclaw on PATH.
    const env = { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', PORT: String(port), HOST: '127.0.0.1', NODE_OPTIONS: '',
      OC_GATEWAY_URL: 'ws://127.0.0.1:9', OC_GATEWAY_TOKEN: 'test-token', PORTAL_EMAIL: 'owner@example.invalid', PORTAL_PASSWORD: 'pw', PORTAL_SECRET: 'secret-for-test',
      AO_ENV: 'test', AO_DATA_DIR: path.join(home, 'data') };
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
    const base = `http://127.0.0.1:${port}`;
    try {
      let meta = null;
      for (let i = 0; i < 100 && !meta; i++) {
        try { const r = await fetch(base + '/api/v2/meta'); if (r.status === 200) meta = await r.json(); } catch (_) { /* not up yet */ }
        if (!meta) { if (child.exitCode !== null) break; await new Promise((r) => setTimeout(r, 100)); }
      }
      assert.ok(meta, 'server up\n' + output);
      assert.equal(meta.data.runtime, null, 'anonymous bootstrap omits private runtime metadata');

      const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.invalid', password: 'pw' }) });
      assert.equal(login.status, 200);
      const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
      const ownerMeta = await (await fetch(base + '/api/v2/meta', { headers: { cookie } })).json();
      assert.deepEqual(ownerMeta.data.runtime, { id: 'openclaw', name: 'OpenClaw', gatewayLabel: 'Passerelle OpenClaw' }, 'owner retains runtime metadata without a gateway identity');
      const health = await (await fetch(base + '/api/v2/views/health', { headers: { cookie } })).json();
      const gw = health.data.sources.find((s) => s.id === 'gateway');
      assert.deepEqual([gw.state, gw.lastError], ['down', 'not-configured']);
      assert.equal(health.data.cards.find((c) => c.id === 'gateway').level, 'alert');
      assert.match(output, /not configured \(no-identity\)/);
      assert.ok(!fs.existsSync(path.join(home, '.openclaw')), 'nothing created under the runtime home');
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
