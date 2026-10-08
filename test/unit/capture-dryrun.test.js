'use strict';
// Runs scripts/capture-fixtures.js end to end against the FakeGateway + fake CLI (never the live
// gateway), writing into a throwaway folder under test/fixtures/local (R8-03: the only allowed root), and checks that the output is redacted and self-consistent.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');
const { loadScenario, makeFakeGateway } = require('../helpers/scenario');
const { scanLeaks } = require('../../scripts/lib/fixture-redact');

const ROOT = path.resolve(__dirname, '..', '..');

describe('capture-fixtures.js (dry run against fakes)', () => {
  let gw, tmp, out, createdLocal = false;
  const LOCAL = path.join(ROOT, 'test', 'fixtures', 'local');
  before(async () => {
    const sc = loadScenario('synthetic-basic');
    // feed it "real-looking" values to prove they get redacted
    // the live event is sent once the capture has SUBSCRIBED (a fixed timer raced a slow start under load and lost)
    const handlers = { 'agents.list': { agents: [{ id: 'main', name: 'Timmy', workspace: '/home/someone/.openclaw/workspace', model: { primary: 'p/m' } }] },
      'sessions.messages.subscribe': () => { setTimeout(() => gw.emit('session.message', { sessionKey: 'agent:main:discord:direct:123456789012345678', type: 'text', text: 'Bonjour Owner' }), 20); return { ok: true }; } };
    gw = await makeFakeGateway(sc, handlers).start();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-capture-'));
    if (!fs.existsSync(LOCAL)) { fs.mkdirSync(LOCAL, { recursive: true }); createdLocal = true; }
    out = fs.mkdtempSync(path.join(LOCAL, '_dryrun-'));
  });
  after(async () => { await gw.stop(); fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); });   // an empty, ignored local/ is left in place (parallel tests share it)

  it('writes redacted fixtures, a scenario and a report', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const idFile = path.join(tmp, 'device.json');
    fs.writeFileSync(idFile, JSON.stringify({ deviceId: 'dev', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
    const env = { PATH: path.join(ROOT, 'test', 'bin') + ':/usr/bin:/bin', HOME: tmp, OC_GATEWAY_URL: gw.url, OC_GATEWAY_TOKEN: 'dry-run-token-value', OC_IDENTITY: idFile,
      OC_BIN: path.join(ROOT, 'test', 'bin', 'openclaw'), FAKE_OC_SCENARIO: 'synthetic-basic' };
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'capture-fixtures.js'), '--label', 'dry-run', '--events-seconds', '1', '--out', out], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 0, stderr + stdout);
    assert.match(stdout, /# Redaction report: dry-run/);
    assert.ok(!stdout.includes('dry-run-token-value') && !stderr.includes('dry-run-token-value'));

    const sc = JSON.parse(fs.readFileSync(path.join(out, 'scenarios', 'dry-run.json'), 'utf8'));
    assert.equal(sc.openclawVersion, '2026.9.8');
    assert.ok(sc.rpc['sessions.list'] && Object.keys(sc.rpc['sessions.get'].files).length > 0);
    for (const f of [sc.rpc['sessions.list'], sc.cli['skills.list'], ...Object.values(sc.rpc['sessions.get'].files)]) assert.ok(fs.existsSync(path.join(out, f)), f);
    assert.ok(fs.existsSync(path.join(out, 'captures', 'dry-run.report.md')));
    const msgEvent = (sc.events.observed || []).find((f) => f.includes('session.message'));
    assert.ok(msgEvent, 'captured the live event');

    // nothing real-looking anywhere
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(out)) {
      const text = fs.readFileSync(f, 'utf8');
      assert.deepEqual(scanLeaks(text, f, ['dry-run-token-value']), [], f);
      assert.ok(!text.includes('Bonjour Owner') && !text.includes('/home/someone'), f);
    }
    // the transcript keys used in the scenario match the redacted sessions.list
    const list = JSON.parse(fs.readFileSync(path.join(out, sc.rpc['sessions.list']), 'utf8')).body.value.sessions.map((s) => s.key);
    for (const k of Object.keys(sc.rpc['sessions.get'].files)) assert.ok(list.includes(k), k);
  });
});
