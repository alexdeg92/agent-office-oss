'use strict';
// review-22 (G4/G5 NO-GO) R22-01…08: each written to fail before its fix. R22-09 is a documentation correction.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const IC = require('../../src/instance-config');
const { hashPassword } = require('../../src/security/password');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');
const { openSse } = require('../helpers/sse-client');

const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const CONFIG = (name) => ({ version: 1, instance: { name, locale: 'en', timeZone: 'UTC' }, owner: { displayName: name, email: name.toLowerCase() + '@example.invalid' },
  runtime: { adapter: 'openclaw', openclaw: { gatewayUrl: 'ws://127.0.0.1:9' } }, agents: { primary: null, looks: {} } });
let SECRETS;
before(async () => { SECRETS = (token) => ({ version: 1, sessionSecret: 's'.repeat(48), passwordHash: HASH, runtimeToken: token }); HASH = await hashPassword('a-long-password-123'); });
let HASH;

// A child process that takes the publication lock and holds it (still "initialising": it has written nothing) until
// told to go on or killed. → { child, ready } ; it prints 'held' once it holds the lock.
function holder(dir) {
  const child = spawn(process.execPath, ['-e', `
    const IC = require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'instance-config.js'))});
    const release = IC.acquirePublishLock(${JSON.stringify(dir)});
    process.stdout.write('held\\n');
    process.stdin.once('data', () => { release(); process.stdout.write('released\\n'); process.exit(0); });`], { stdio: ['pipe', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => { child.stdout.once('data', (d) => (String(d).includes('held') ? resolve() : reject(new Error(String(d))))); child.once('exit', (c) => reject(new Error('holder exited ' + c))); });
  return { child, ready };
}

describe('R22-01 · the publication lock is atomic and can never be taken from a live owner (cross-process)', () => {
  it('while another LIVE process holds the lock (having written nothing yet), a publication is refused (EBUSY) and writes nothing', async () => {
    const d = tmpDir('ao-r22-lock-'), paths = { file: path.join(d, 'config.json'), secrets: path.join(d, 'secrets.json') };
    const h = holder(d);
    try {
      await h.ready;
      assert.throws(() => IC.writeInstanceConfig(paths, CONFIG('Bea'), SECRETS('bea')), (e) => e.code === 'EBUSY');
      assert.ok(!fs.existsSync(paths.file) && !fs.existsSync(paths.secrets));
      h.child.stdin.write('go\n');
      await new Promise((r) => h.child.once('exit', r));
      IC.writeInstanceConfig(paths, CONFIG('Bea'), SECRETS('bea'));
      assert.equal(JSON.parse(fs.readFileSync(paths.secrets, 'utf8')).runtimeToken, 'bea');
    } finally { h.child.kill('SIGKILL'); fs.rmSync(d, { recursive: true, force: true }); }
  });
  it('a holder that DIES (SIGKILL, mid-publication) frees the lock by itself: the next publication proceeds', async () => {
    const d = tmpDir('ao-r22-dead-'), paths = { file: path.join(d, 'config.json'), secrets: path.join(d, 'secrets.json') };
    const h = holder(d);
    try {
      await h.ready;
      h.child.kill('SIGKILL');
      await new Promise((r) => h.child.once('exit', r));
      IC.writeInstanceConfig(paths, CONFIG('Cy'), SECRETS('cy'));
      const config = JSON.parse(fs.readFileSync(paths.file, 'utf8')), secrets = JSON.parse(fs.readFileSync(paths.secrets, 'utf8'));
      assert.deepEqual([config.instance.name, secrets.runtimeToken], ['Cy', 'cy'], 'a matching pair');
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  it('two processes racing to publish: exactly one pair is committed, and its secrets belong to its config', { timeout: 60000 }, async () => {
    const d = tmpDir('ao-r22-race-'), paths = { file: path.join(d, 'config.json'), secrets: path.join(d, 'secrets.json') };
    const writer = (name) => new Promise((resolve) => {
      const c = spawn(process.execPath, ['-e', `
        const IC = require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'instance-config.js'))});
        const cfg = ${JSON.stringify(CONFIG(name))}, sec = ${JSON.stringify(SECRETS(name.toLowerCase()))};
        // load-independent (PM after office-dev-16): retry while busy until a deadline, not a fixed count of instant tries
        const until = Date.now() + 30000, pause = new Int32Array(new SharedArrayBuffer(4));
        let out = 'EBUSY'; while (Date.now() < until) { try { IC.writeInstanceConfig(${JSON.stringify(paths)}, cfg, sec); out = 'ok'; break; } catch (e) { out = e.code || e.message; if (e.code !== 'EBUSY') break; Atomics.wait(pause, 0, 0, 2); } }
        process.stdout.write(out);`]);
      let o = '', err = ''; c.stdout.on('data', (x) => { o += x; }); c.stderr.on('data', (x) => { err += x; });
      c.once('exit', (code) => resolve(o || `exit ${code}: ${err.slice(0, 300)}`));
    });
    try {
      const results = await Promise.all([writer('Ana'), writer('Ben'), writer('Cleo')]);
      assert.equal(results.filter((r) => r === 'ok').length, 1, results.join());
      assert.ok(results.every((r) => r === 'ok' || r === 'EEXIST'), results.join());
      const config = JSON.parse(fs.readFileSync(paths.file, 'utf8')), secrets = JSON.parse(fs.readFileSync(paths.secrets, 'utf8'));
      assert.equal(secrets.runtimeToken, config.instance.name.toLowerCase(), 'the committed config and secrets are one writer\'s');
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

describe('R22-02 · an undeclared key never appears in a diagnostic, dots included (count only)', () => {
  it('dotted, nested and plain undeclared keys: a declared parent path and a count, no key text at all', () => {
    const d = tmpDir('ao-r22-key-');
    try {
      const file = path.join(d, 'config.json');
      const c = CONFIG('Dee'); c.instance['SECRET.prefix.segment'] = 'x'; c.instance['also.hunter2'] = 1; c['TOP.SECRET'] = true;
      fs.writeFileSync(file, JSON.stringify(c));
      assert.throws(() => IC.readInstanceConfig({ AO_CONFIG: file, HOME: d }), (e) => {
        for (const leak of ['SECRET', 'prefix', 'segment', 'hunter2', 'also', 'TOP']) assert.ok(!e.message.includes(leak), `${leak} in ${e.message}`);
        assert.match(e.message, /\$\.instance: 2 undeclared fields/); assert.match(e.message, /\$: 1 undeclared field\b/);
        return true;
      });
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

describe('R22-03 · a fresh instance serves the v3 bootstrap (meta and setup) before configuration', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('foreign-instance'), { setupMode: true }); });
  after(async () => { if (h) await h.stop(); });
  it('GET /api/v3/meta → a 3.0 MetaVM with configured:false; /api/v3/setup works like v2', async () => {
    const meta = await h.get('/api/v3/meta');
    assert.equal(meta.status, 200, meta.text);
    assert.deepEqual([meta.json.data.apiVersion, meta.json.data.contractVersion, meta.json.data.instance.configured], [3, '3.2', false]);
    const setup = await h.get('/api/v3/setup');
    assert.equal(setup.status, 200); assert.equal(setup.json.data.state, 'open');
    assert.equal((await h.get('/api/v3/views/office')).status, 503, 'everything else waits for configuration');
  });
});

describe('R22-04 · the seen-agent inventory is kept whatever contract the client uses', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('foreign-instance')); });
  after(async () => { if (h) await h.stop(); });
  it('a v3-only client: office occupants reach office_agents_seen and /api/v3/office/layout agentsSeen', async () => {
    const office = (await h.get('/api/v3/views/office')).json.data;
    assert.ok(office.occupants.length >= 2);
    const stored = h.withStore((db) => db.prepare('SELECT count(*) AS n FROM office_agents_seen').get().n);
    assert.equal(stored, office.occupants.length);
    const seen = (await h.get('/api/v3/office/layout')).json.data.agentsSeen;
    assert.deepEqual(seen.map((x) => x.id).sort(), office.occupants.map((o) => o.id).sort(), '3.0 ids');
    const seen2 = (await h.get('/api/v2/office/layout')).json.data.agentsSeen;
    assert.ok(seen2.some((x) => x.id === 'main') && !seen2.some((x) => x.id === 'primary'), '2.x ids on v2');
  });
});

describe('R22-05 · a command whose capability is declared false is 404, even if the adapter has the function', () => {
  let h;
  // a preload changes only the adapter's DECLARATION; the OpenClaw command functions all stay callable
  before(async () => {
    const pre = path.join(tmpDir('ao-r22-caps-'), 'caps.cjs');
    fs.writeFileSync(pre, `const d = require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'adapters', 'openclaw'))}).definition;
const caps = d.capabilities; d.capabilities = () => Object.assign(caps(), { flows: { read: true, write: false, schedules: ['cron'], multiAgent: false }, skills: { read: true, toggle: false, detail: true }, chat: false, restart: false });`);
    h = await startServer(loadScenario('synthetic-basic'), { env: { NODE_OPTIONS: '--require ' + pre } });
  });
  after(async () => { if (h) await h.stop(); });
  it('flows, skill toggle, chat and restart: 404 not_found on v3 and v2; nothing reaches the CLI', async () => {
    const job = 'ffffffff-0c01-4000-8000-000000000001';
    const before = h.cliCalls().length;
    for (const v of ['v2', 'v3']) {
      for (const [m, p, b] of [['POST', '/flows', { name: 'x', cron: '0 9 * * *', tz: 'UTC', message: 'x' }], ['PATCH', `/flows/${job}`, { name: 'y' }], ['PUT', `/flows/${job}/enabled`, { enabled: false }],
        ['POST', `/flows/${job}/runs`, {}], ['DELETE', `/flows/${job}`, undefined], ['PUT', '/skills/weather/enabled', { enabled: false }],
        ['POST', '/chat/messages', { text: 'hi' }], ['POST', '/gateway/restart', { confirm: 'redemarrer' }]]) {
        const r = await h.request(m, `/api/${v}${p}`, b);
        assert.equal(r.status, 404, `${v} ${m} ${p}: ${r.text}`); assert.equal(r.json.error.code, 'not_found');
      }
    }
    assert.equal(h.cliCalls().length, before, 'no command reached the CLI');
  });
});

describe('R22-06 · a v3 layout save takes 3.0 names only', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('synthetic-basic')); });
  after(async () => { if (h) await h.stop(); });
  it('a 2.x rule name or match kind in a v3 save is 400 (and *conversation is fine)', async () => {
    const l3 = (await h.get('/api/v3/office/layout')).json.data;
    const legacy = JSON.parse(JSON.stringify(l3.layout.data));
    legacy.agents.find((a) => a.agentId === 'primary').agentId = 'main';
    const r = await h.request('PUT', '/api/v3/office/layout', { expectedRevision: l3.layout.revision, data: legacy });
    assert.equal(r.status, 400, r.text); assert.deepEqual(r.json.error.details, [{ field: 'agents.main', issue: 'v2-name' }]);
    const kind = JSON.parse(JSON.stringify(l3.layout.data));
    kind.agents.find((a) => a.agentId === '*scheduled').match.kind = 'cron';
    assert.deepEqual((await h.request('PUT', '/api/v3/office/layout', { expectedRevision: l3.layout.revision, data: kind })).json.error.details, [{ field: 'agents.*scheduled', issue: 'v2-name' }]);
  });
});

describe('R22-07 · chat never invents the agent "main" when no primary is resolved', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('foreign-instance'), { demo: true, handlers: { 'agents.list': () => ({ agents: [] }) } }); });
  after(async () => { if (h) await h.stop(); });
  it('no primary: GET chat is 503 agent-unknown (like POST), never agent:main', async () => {
    assert.equal((await h.get('/api/v3/meta')).json.data.primaryAgent, null);
    for (const v of ['v2', 'v3']) {
      const r = await h.get(`/api/${v}/views/chat`);
      assert.equal(r.status, 503, r.text); assert.deepEqual(r.json.error.details, [{ issue: 'agent-unknown' }]);
      assert.ok(!r.text.includes('agent:main'));
    }
  });
});

describe('R22-08 · mount aliases in another case pick the version their path names, everywhere', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('synthetic-basic')); });
  after(async () => { if (h) await h.stop(); });
  it('/API/V3 and /api/V3 are 3.0 (meta, office, stream hello, transport POSTs); /API/v2 is 2.5', async () => {
    for (const p of ['/API/V3/meta', '/api/V3/meta']) assert.equal((await h.get(p)).json.data.apiVersion, 3, p);
    assert.equal((await h.get('/API/v2/meta')).json.data.apiVersion, 2);
    assert.equal((await h.get('/API/V3/views/office')).json.data.occupants[0].id, 'primary');
    const s = openSse(h.base, '/API/V3/stream?topics=office', { cookie: h.cookie });
    try {
      const hello = await s.next((e) => e.event === 'hello');
      assert.equal(hello.data.contractVersion, '3.2');
      const r = await h.request('POST', `/API/V3/stream/${hello.data.streamId}/topics`, { add: ['health'] });
      assert.equal(r.status, 200, 'the stream id is found in the v3 hub: ' + r.text);
    } finally { s.close(); }
  });
});
