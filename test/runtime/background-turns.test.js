'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bind } = require('../../src/adapters/openclaw/commands');
const { createMultiRuntimeController } = require('../../src/multi-runtime-controller');
const { definition, createDemoTeam } = require('../../src/adapters/demo');
const { scopedId } = require('../../src/runtime-ids');
const { EventEmitter } = require('node:events');
const { createRuntime } = require('../../src/adapters/openclaw');

test('every AO OpenClaw turn pins internal ingress and reply routing, including bare dashboard/summary refs', async () => {
  const calls = [];
  const command = bind({ parseJson: JSON.parse, async run(args) {
    if (args[0] === 'gateway') { const params = JSON.parse(args.find(a => a.startsWith('--params=')).slice(9));
      calls.push(args); return { ok: true, out: JSON.stringify({ ok: true, key: params.key, entry: { sendPolicy: 'deny' } }) }; }
    calls.push(args); return { ok: true, out: JSON.stringify({ result: { payloads: [{ text: 'Scratch reply' }] } }) };
  } });
  for (const sessionRef of ['portal-chat', 'portal-summary-prj_scratch', 'agent:artist:ao-projet-scratch']) {
    const reply = await command.agentTurn({ agentId: 'artist', text: 'Scratch input', sessionRef });
    assert.equal(reply.text, 'Scratch reply');
    const argv = calls.at(-1);
    const policy = JSON.parse(calls.at(-2).find(a => a.startsWith('--params=')).slice(9));
    assert.equal(policy.sendPolicy, 'deny');
    assert.equal(policy.key, sessionRef.startsWith('agent:') ? sessionRef : 'agent:artist:explicit:' + sessionRef);
    assert.ok(argv.includes('--session-key=' + policy.key));
    assert.ok(argv.includes('--channel=webchat'));
    assert.ok(argv.includes('--reply-channel=webchat'));
    assert.ok(!argv.some(arg => /^--(?:deliver|to|reply-to|reply-account)(?:=|$)/.test(arg)));
  }
});

test('a refused, stale or unconfirmed delivery fence never dispatches a turn', async () => {
  for (const result of [{ ok: false, refused: 'readonly' }, { ok: false, err: 'private error' },
    { ok: true, out: '{"ok":true,"key":"agent:other:session","entry":{"sendPolicy":"deny"}}' },
    { ok: true, out: '{"ok":true,"key":"agent:artist:explicit:project","entry":{"sendPolicy":"allow"}}' }, { ok: true, out: '{}' }]) {
    const calls = [], command = bind({ parseJson: text => { try { return JSON.parse(text); } catch { return null; } }, run: async args => { calls.push(args); return result; } });
    assert.ok((await command.agentTurn({ agentId: 'artist', text: 'Scratch', sessionRef: 'project' })).failed);
    assert.deepEqual(calls.map(a => a[0]), ['gateway']);
  }
});

function multi(t, { missing = false } = {}) {
  const calls = [], writers = {};
  const configs = { runtimeInstances: ['one', 'two'].map(id => ({ id, adapter: id, enabled: true, cfg: {} })), primaryAgent: scopedId('two', 'agent', 'nova') };
  const adapter = id => ({ definition: { ...definition, capabilities: () => ({ ...definition.capabilities(), chat: true }) }, createRuntime() {
    return { definition: this.definition, attach(engine) { if (!missing || id !== 'two') engine.ingestCanonical('agents', createDemoTeam().agents()); }, close() {},
      commands: writers[id] = { agentTurn: async input => { calls.push([id, input]); return { text: 'Scratch cover' }; } } };
  } });
  const controller = createMultiRuntimeController({ cfg: configs, resolveAdapter: adapter,
    store: { owner: null, persons: { senderPeople: () => [] }, quarantine: { loadAll: () => [] }, flushQuarantine() {} } });
  t.after(() => controller.close());
  return { controller, configs, calls, writers };
}

test('scoped project session dispatch resolves only the same owning instance', async t => {
  const h = multi(t), agentId = scopedId('two', 'agent', 'nova');
  let result = await h.controller.runtime.commands.agentTurn({ agentId, text: 'Summary', sessionRef: scopedId('one', 'session', 'agent:nova:ao-projet-scratch') });
  assert.equal(result.failed, 'wrong-runtime'); assert.deepEqual(h.calls, []);
  result = await h.controller.runtime.commands.agentTurn({ agentId, text: 'Summary', sessionRef: scopedId('two', 'session', 'agent:nova:ao-projet-scratch') });
  assert.equal(result.text, 'Scratch cover'); assert.equal(h.calls[0][1].sessionRef, 'agent:nova:ao-projet-scratch');
});

test('primary changes or cancellation while the delivery fence is pending prevent agent dispatch', async t => {
  for (const cancel of [false, true]) {
    const h = multi(t), signal = new AbortController(), calls = [];
    const cli = { parseJson: JSON.parse, async run(args) {
      calls.push(args);
      if (args[0] !== 'gateway') return { ok: true, out: '{"result":{"payloads":[]}}' };
      const params = JSON.parse(args.find(a => a.startsWith('--params=')).slice(9));
      if (cancel) signal.abort();
      else h.controller.apply({ ...h.configs, primaryAgent: scopedId('one', 'agent', 'nova') });
      return { ok: true, out: JSON.stringify({ ok: true, key: params.key, entry: { sendPolicy: 'deny' } }) };
    } };
    h.writers.two.agentTurn = bind(cli).agentTurn;
    const result = await h.controller.runtime.commands.agentTurn({ agentId: scopedId('two', 'agent', 'nova'), background: true, text: 'Cover', signal: signal.signal });
    assert.equal(result.failed, cancel ? 'killed-or-timeout' : 'wrong-runtime');
    assert.deepEqual(calls.map(a => a[0]), ['gateway']);
  }
});

test('policy and turn children use the selected gateway URL/token pair, clearing inherited password', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-bound-turn-')), calls = [];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(require('node:child_process'), 'execFile', (bin, args, opts, cb) => {
    calls.push({ bin, args, env: opts.env });
    const child = new EventEmitter();
    queueMicrotask(() => {
      const params = args[0] === 'gateway' ? JSON.parse(args.find(a => a.startsWith('--params=')).slice(9)) : null;
      cb(null, JSON.stringify(params ? { ok: true, key: params.key, entry: { sendPolicy: 'deny' } } : { result: { payloads: [] } }), '');
      child.emit('close', 0);
    }); return child;
  });
  const runtime = createRuntime({ gatewayUrl: 'ws://synthetic-selected.invalid:18789', gatewayToken: 'synthetic-selected-token',
    openclawHome: root, openclawBin: '/synthetic/openclaw', identityPath: path.join(root, 'missing-device'), stateDbPath: path.join(root, 'missing-db') },
    { cliEnv: { OPENCLAW_GATEWAY_URL: 'ws://synthetic-other.invalid', OPENCLAW_GATEWAY_TOKEN: 'synthetic-other-token', OPENCLAW_GATEWAY_PASSWORD: 'synthetic-other-password' } });
  t.after(() => runtime.close());
  assert.ok(!(await runtime.commands.agentTurn({ agentId: 'main', text: 'Scratch' })).failed);
  assert.deepEqual(calls.map(c => c.args[0]), ['gateway', 'agent']);
  for (const call of calls) {
    assert.equal(call.env.HOME, root);
    assert.equal(call.env.OPENCLAW_GATEWAY_URL, 'ws://synthetic-selected.invalid:18789');
    assert.equal(call.env.OPENCLAW_GATEWAY_TOKEN, 'synthetic-selected-token');
    assert.equal(call.env.OPENCLAW_GATEWAY_PASSWORD, '');
    assert.ok(!call.args.some(a => a.includes('synthetic-selected-token')));
  }
});
