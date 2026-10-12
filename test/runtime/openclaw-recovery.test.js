'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const { bind } = require('../../src/adapters/openclaw/commands');
const packageRoot = process.env.AO_TEST_OPENCLAW_PACKAGE;

async function recover(t, argv) {
  // A scratch base is the child's TMPDIR and HOME is a directory inside it, so the scratch-HOME guard
  // (HOME strictly inside the temp directory) admits it; nothing points at the invoking user's HOME.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-recovery-')), root = path.join(base, 'home');
  fs.mkdirSync(root); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'argv.json'), JSON.stringify(argv));
  const env = { HOME: root, AO_TEST_SCRATCH_HOME: root, AO_RECOVERY_FIXTURE_ROOT: root, OPENCLAW_STATE_DIR: path.join(root, '.openclaw'), OPENCLAW_CONFIG_PATH: path.join(root, '.openclaw/openclaw.json'),
    TMPDIR: base, PATH: path.join(root, 'empty-bin'), NODE_ENV: 'test', OPENCLAW_NO_RESPAWN: '1' };
  async function child(mode) {
    const p = spawn(process.execPath, [path.join(__dirname, '../helpers/openclaw-recovery-child.cjs'), packageRoot, mode], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = ''; p.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); }); p.stdout.resume();
    t.after(() => { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); });
    const exit = once(p, 'exit');
    const message = await Promise.race([once(p, 'message').then(([msg]) => msg), exit.then(([code, signal]) => { throw Error('scratch child failed: ' + code + '/' + signal + ': ' + stderr); })]);
    return { p, message, exit };
  }
  const first = await child('admit'); assert.equal(first.message.ready, true);
  first.p.kill('SIGKILL'); assert.deepEqual(await first.exit, [null, 'SIGKILL']);
  const second = await child('recover'); assert.deepEqual(await second.exit, [0, null]);
  return { admission: first.message, recovery: second.message };
}

test('real OpenClaw cold recovery of interrupted AO work cannot deliver to a stale owner route', { skip: !packageRoot, timeout: 30000 }, async t => {
  let argv;
  const command = bind({ parseJson: JSON.parse, async run(args) {
    if (args[0] === 'gateway') {
      const p = JSON.parse(args.find(a => a.startsWith('--params=')).slice(9)); argv = args;
      return { ok: true, out: JSON.stringify({ ok: true, key: p.key, entry: { sendPolicy: 'deny' } }) };
    }
    if (!argv) argv = args; // Old implementation: retain its actual unprotected argv.
    return { ok: true, out: '{"result":{"payloads":[]}}' };
  } });
  await command.agentTurn({ agentId: 'main', text: 'Scratch cover/summary', sessionRef: 'agent:main:ao-projet-scratch' });
  const result = await recover(t, argv);
  assert.equal(result.admission.delivery.kind, 'external', 'old canonical Discord metadata deliberately remains present');
  assert.equal(result.admission.sendPolicy, 'deny');
  assert.equal(result.recovery.dispatched[0].deliver, false);
  assert.equal(result.recovery.dispatched[0].channel, undefined);
  assert.equal(result.recovery.dispatched[0].to, undefined);
  assert.deepEqual(result.recovery.notices, []);
});

test('real OpenClaw interruption control reproduces the old unbound external recovery', { skip: !packageRoot, timeout: 30000 }, async t => {
  const result = await recover(t, ['agent', '--agent=main', '--session-key=agent:main:ao-projet-scratch']);
  assert.equal(result.recovery.dispatched[0].deliver, true);
  assert.equal(result.recovery.dispatched[0].channel, 'discord');
  assert.equal(result.recovery.dispatched[0].to, 'discord:dm:synthetic');
});
