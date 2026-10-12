'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectAgentSettings, readAgentSettings } = require('../../src/adapters/openclaw/agent-settings');
const { normaliseAgents } = require('../../src/adapters/openclaw/normalise/agent');
const { createRuntime } = require('../../src/adapters/openclaw');
const { createEngine } = require('../../src/engine');
const { buildAccessVM } = require('../../src/api/v2/vm/access');
const { schemasFor } = require('../../src/api/v2/vm/schemas');
const { validate } = require('../../src/schema');
const { validateVM } = require('../../public/v2/generated/vm-schemas.js');
const row = (id, rest = {}) => ({ id, model: { primary: 'vendor/effective' }, ...rest });
const settings = projectAgentSettings({ agents: { defaults: { model: 'vendor/effective', agentRuntime: { id: 'openclaw' } }, list: [
  { id: 'explicit', model: 'vendor/effective' }, // same as the default still counts as an explicit override
  { id: 'object', model: { primary: 'vendor/object', fallbacks: ['vendor/fallback'] } },
  { id: 'inherited', model: { fallbacks: ['vendor/fallback'] } },
  { id: 'harness', runtime: { type: 'acp', acp: { agent: 'foreign-harness', backend: 'acpx', cwd: '/private' } } },
  { id: 'unknown-harness', runtime: { type: 'acp' } },
] } });

test('adapter distinguishes overrides from effective defaults, including ACP and an open CLI runtime id', () => {
  const agents = normaliseAgents({ agents: [row('explicit'), row('object'), row('inherited'), row('harness', { agentRuntime: { id: 'openclaw' } }),
    row('unknown-harness'), row('cli', { agentRuntime: { id: 'vendor-cli' } })] }, settings);
  assert.deepEqual(agents.map(a => [a.modelSource, a.runtime]), [
    ['explicit', null], ['explicit', null], ['inherited', null], ['inherited', 'foreign-harness'], ['inherited', 'ACP'], ['inherited', 'vendor-cli'],
  ]);
  const reported = normaliseAgents({ agents: [row('explicit', { modelSource: 'inherited', agentRuntime: { id: 'another-runtime' } })] }, settings)[0];
  assert.equal(reported.modelSource, 'inherited');
  assert.equal(reported.runtime, 'another-runtime');
  assert.equal(normaliseAgents({ agents: [row('harness', { agentRuntime: { id: 'active-env-harness' } })] }, settings)[0].runtime, 'active-env-harness');
  assert.equal(normaliseAgents({ agents: [row('unknown')] })[0].modelSource, null);
});

test('OpenClaw configured agent role and description provide a runtime-neutral summary', () => {
  const configured = projectAgentSettings({ agents: { list: [{ id: 'configured', name: 'Mira', role: 'Researcher', description: 'Finds relevant sources' }] } });
  const [agent] = normaliseAgents({ agents: [row('configured', { name: 'Mira' })] }, configured);
  assert.equal(agent.name, 'Mira');
  assert.equal(agent.displayName, 'Mira');
  assert.equal(agent.summary, 'Finds relevant sources');
});

test('OpenClaw configured identity text goes through the shared redactor', () => {
  const configured = projectAgentSettings({ agents: { list: [{ id: 'leaky', role: 'Ops', description: 'Deploys with password=synthetic-secret-canary via https://u:synthetic-secret-canary@example.test' }] } });
  const [agent] = normaliseAgents({ agents: [row('leaky', { name: 'Ops bot token=synthetic-secret-canary' })] }, configured);
  assert.equal(agent.summary, 'Deploys with password=… via https://example.test');
  assert.equal(agent.displayName, 'Ops bot token=…');
});

test('bound adapter refreshes the private projection and fails to unknown on missing or malformed config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-execution-'));
  const file = path.join(dir, 'config.json');
  const rt = createRuntime({ openclawConfigPath: file, openclawHome: dir, readonly: true });
  try {
    const normalise = () => rt.definition.normalise.agents({ agents: [row('worker')] })[0];
    assert.equal(normalise().modelSource, null);
    fs.writeFileSync(file, JSON.stringify({ secret: 'never-exported', agents: { list: [{ id: 'worker', model: 'vendor/a',
      runtime: { type: 'acp', acp: { agent: 'harness-z', cwd: '/secret', command: 'private-command' } } }] } }));
    assert.deepEqual([normalise().modelSource, normalise().runtime], ['explicit', 'harness-z']);
    assert.doesNotMatch(JSON.stringify(readAgentSettings(file)), /never-exported|private-command|secret|cwd/);
    fs.writeFileSync(file, JSON.stringify({ agents: { list: [{ id: 'worker' }] } }));
    assert.deepEqual([normalise().modelSource, normalise().runtime], ['inherited', null]);
    fs.writeFileSync(file, '{truncated');
    assert.equal(normalise().modelSource, null);
    fs.writeFileSync(file, JSON.stringify({ agents: { list: [{ id: 'worker', model: 42 }] } }));
    assert.equal(normalise().modelSource, null);
  } finally { rt.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('12+ agents from a foreign canonical adapter preserve neutral signals through both VM contracts', () => {
  const engine = createEngine({ adapter: { id: 'foreign', name: 'Foreign', schemas: {}, routes: {},
    normalise: { session: row => ({ session: row }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) },
    classifySession: () => { throw Error('unused'); }, capabilities: () => ({}) } });
  const agents = Array.from({ length: 15 }, (_, i) => ({ id: 'worker-' + i, name: 'Worker ' + i, workspace: null,
    model: { primary: 'vendor/' + i, provider: 'vendor' }, modelSource: i % 2 ? 'explicit' : 'inherited',
    runtime: i % 3 === 0 ? 'unlisted-harness-' + i : null, fallbackModels: [], isPrimary: i === 0, mainSessionKey: null }));
  assert.equal(engine.ingestCanonical('agents', agents).ok, true);
  const vm = buildAccessVM({ agents: engine.agents(), sessions: [], config: null, peek: () => { throw Error('unused'); } });
  assert.deepEqual(vm.agents.map(a => [a.modelSource, a.runtime]), agents.map(a => [a.modelSource, a.runtime]));
  for (const version of [2, 3]) {
    assert.equal(validate(schemasFor(version).access, vm).ok, true);
    assert.equal(validateVM('access', vm, version).ok, true);
    const bad = { ...vm, agents: [{ ...vm.agents[0], modelSource: 'guessed' }] };
    assert.equal(validate(schemasFor(version).access, bad).ok, false);
    assert.equal(validateVM('access', bad, version).ok, false);
  }
  assert.equal(engine.ingestCanonical('agents', [{ ...agents[0], modelSource: 'guessed' }]).ok, false);
});

test('typed gateway runtime metadata is projected; malformed metadata cannot reach the canonical list', () => {
  const engine = createEngine();
  const ingest = (agents) => engine.ingest({ source: 'gateway', channel: 'gw.rpc.agents.list', receivedAt: Date.now(), body: { kind: 'json', value: { agents } } });
  ingest([row('cli', { agentRuntime: { id: 'foreign-cli', source: 'provider' } })]);
  assert.equal(engine.agents()[0].runtime, 'foreign-cli');
  ingest([row('bad', { agentRuntime: { id: { injected: true } } })]);
  assert.equal(engine.agents().length, 0);
  assert.ok(engine.dataQuality().issues.some(i => i.path === '$.agents[].agentRuntime.id'));
});
