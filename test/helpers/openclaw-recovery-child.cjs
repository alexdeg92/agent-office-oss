'use strict';
require('./scratch-home.cjs').requireScratchHome(__filename);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
// Opt-in compatibility proof against an explicitly supplied OpenClaw package.
// Imports run only inside a scratch HOME; never load the operator's runtime state.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = process.env.AO_RECOVERY_FIXTURE_ROOT;
assert.ok(root && root === process.env.HOME);
assert.equal(process.env.OPENCLAW_STATE_DIR, path.join(root, '.openclaw'));
assert.equal(require('node:os').homedir(), root);
const noNetwork = () => { throw Error('fixture forbids network'); };
global.fetch = noNetwork;
const net = require('node:net');
net.connect = net.createConnection = net.Socket.prototype.connect = noNetwork;
require('node:tls').connect = noNetwork;
const subprocess = require('node:child_process');
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  subprocess[method] = () => { throw Error('fixture forbids subprocesses'); };
}

(async () => {
  const packageRoot = process.argv[2], mode = process.argv[3], dist = path.join(packageRoot, 'dist');
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')));
  assert.equal(pkg.version, '2026.9.8', 'this compatibility fixture targets the reviewed OpenClaw build');
  async function moduleWith(prefix, name) {
    for (const file of fs.readdirSync(dist).filter(f => f.startsWith(prefix) && f.endsWith('.mjs'))) {
      const source = fs.readFileSync(path.join(dist, file), 'utf8');
      if (!source.includes('export {') || !source.includes(name)) continue;
      const mod = await import(pathToFileURL(path.join(dist, file)).href);
      if (Object.values(mod).some(value => typeof value === 'function' && value.name === name)) return mod;
    }
    throw Error('required OpenClaw build export absent: ' + name);
  }
  const named = (mod, name) => { const fn = Object.values(mod).find(v => typeof v === 'function' && v.name === name); assert.ok(fn, name); return fn; };
  const access = await moduleWith('session-accessor-', 'replaceSessionEntry');
  const recovery = await moduleWith('main-session-restart-recovery-', 'recoverRestartAbortedMainSessions');
  const state = process.env.OPENCLAW_STATE_DIR, storePath = path.join(state, 'agents/main/sessions/sessions.json');
  const cfg = { agents: { list: [{ id: 'main', default: true, workspace: path.join(root, 'workspace') }] } };
  if (mode === 'admit') {
    const shared = await moduleWith('delivery-context.shared-', 'normalizeSessionDeliveryState');
    const read = await moduleWith('delivery-context.read-', 'sessionDeliveryRoute');
    const argv = JSON.parse(fs.readFileSync(path.join(root, 'argv.json')));
    const option = key => argv.find(a => a.startsWith('--' + key + '='))?.slice(key.length + 3);
    const policy = argv[0] === 'gateway' ? JSON.parse(option('params')) : null;
    const ref = option('session-key');
    const sessionKey = policy?.key || (ref.startsWith('agent:') ? ref : 'agent:main:' + ref);
    const old = { deliveryContext: { channel: 'discord', to: 'discord:dm:synthetic' }, lastChannel: 'discord', lastTo: 'discord:dm:synthetic' };
    old.delivery = named(shared, 'normalizeSessionDeliveryState')({ context: old.deliveryContext });
    // These are the same OpenClaw routing helpers used by agent-session-patch.
    // Begin with a stale external route: deny must fence it even when it remains.
    const delivery = named(shared, 'normalizeSessionDeliveryState')({
      route: named(read, 'sessionDeliveryRoute')(old),
      context: named(shared, 'mergeDeliveryContext')(named(read, 'deliveryContextFromSession')(old), named(shared, 'normalizeDeliveryContext')({ channel: option('channel') })),
      origin: named(read, 'sessionDeliveryOrigin')(old),
    });
    const sessionId = 'scratch-session';
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    let entry = { sessionId, updatedAt: Date.now(), status: 'running', permissionMode: 'guarded', ...old, delivery };
    if (policy) {
      const patch = await moduleWith('sessions-patch-', 'projectSessionsPatchEntry');
      const result = await named(patch, 'projectSessionsPatchEntry')({ cfg, storeKey: sessionKey, agentId: 'main', existingEntry: entry, patch: policy });
      assert.equal(result.ok, true);
      entry = result.entry;
      assert.equal(entry.sendPolicy, 'deny');
    }
    await named(access, 'replaceSessionEntry')({ storePath, sessionKey }, entry);
    for (const message of [
      { role: 'user', provenance: { kind: 'external_user' }, content: [{ type: 'text', text: 'Generate scratch project work' }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'scratch-call', name: 'exec', arguments: { command: 'synthetic tool' } }], stopReason: 'toolUse' },
      { role: 'toolResult', toolCallId: 'scratch-call', toolName: 'exec', content: [{ type: 'text', text: 'Scratch file created' }], isError: false },
    ]) {
      const result = await named(access, 'appendTranscriptMessage')({ storePath, sessionKey, sessionId }, { cwd: root, message: { ...message, timestamp: Date.now() } });
      assert.notEqual(result?.ok, false);
    }
    fs.writeFileSync(path.join(root, 'session-key'), sessionKey);
    process.send({ ready: true, version: pkg.version, delivery, sendPolicy: entry.sendPolicy });
    setInterval(() => {}, 1000); // Parent kills the process during retained tool work.
  } else {
    const marked = await recovery.markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state });
    assert.equal(marked.marked, 1, JSON.stringify(marked));
    const dispatched = [], notices = [];
    const result = await recovery.recoverRestartAbortedMainSessions({ cfg, stateDir: state, gatewayRuntime: {
      prepareRestartRecovery() {}, async dispatchSessionMethod() {},
      async dispatchAgent(params, timeout, options) {
        dispatched.push({ sessionKey: params.sessionKey, deliver: params.deliver, channel: params.channel, to: params.to });
        options?.onStartOwner?.({ observe: () => ({ executionStarted: true, expiresAtMs: Date.now() + 60000 }), abort: () => false });
        options?.onAccepted?.({ runId: params.idempotencyKey }); options?.onExecutionStarted?.();
        return { runId: params.idempotencyKey, status: 'ok' };
      }, async waitForAgent() { return { status: 'ok' }; }, async sendRecoveryNotice(params) { notices.push({ channel: params.channel, to: params.to }); return { suppressed: false }; },
    } });
    assert.equal(dispatched.length, 1, JSON.stringify(result));
    process.send({ result, dispatched, notices, version: pkg.version }); process.exit(0);
  }
})().catch(error => { console.error(error); process.exit(1); });
