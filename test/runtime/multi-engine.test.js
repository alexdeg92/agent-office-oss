'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { createMultiEngine } = require('../../src/engine/multi');
const { createMultiRuntimeController } = require('../../src/multi-runtime-controller');
const { definition, createDemoTeam } = require('../../src/adapters/demo');
const { scopedId } = require('../../src/runtime-ids');
const NOW = Date.UTC(2026, 9, 10);
function partition(id) {
  const team = createDemoTeam({ now: () => NOW });
  const engine = createEngine({ adapter: definition, now: () => NOW });
  engine.ingestCanonical('agents', team.agents()); engine.ingestCanonical('sessions.snapshot', team.sessionList());
  return { id, adapter: 'demo', enabled: true, engine, team };
}
test('two instances with identical native identities merge independent partitions and primary', t => {
  const one = partition('one'), two = partition('two');
  const engine = createMultiEngine({ instances: [one, two], primary: scopedId('two', 'agent', 'sage') }); t.after(() => engine.close());
  assert.equal(engine.agents().length, 6); assert.equal(new Set(engine.agents().map(a => a.id)).size, 6);
  assert.equal(engine.primaryAgent().id, scopedId('two', 'agent', 'sage'));
  const twoKeys = engine.sessions().filter(s => s.key.startsWith('rt:two:')).map(s => s.key);
  one.engine.ingestCanonical('sessions.snapshot', []);
  assert.deepEqual(engine.sessions().map(s => s.key), twoKeys);
  assert.equal(engine.session(twoKeys[0]).class.agentId.startsWith('rt:two:agent:'), true);
  assert.equal(engine.session('unscoped-native-key'), null, 'native IDs never fan out to unrelated sources');
});
test('read timeout leaves another partition updating and preserves failed source last good data', async t => {
  const one = partition('one'), two = partition('two'), engine = createMultiEngine({ instances: [one, two], timeoutMs: 20 }); t.after(() => engine.close());
  const native = one.engine.sessions()[0].key, key = scopedId('one', 'session', native);
  one.engine.setReads({ transcript: () => new Promise(() => {}) });
  const result = await engine.request('transcript', key);
  assert.equal(result.ok, false); assert.equal(result.category, 'timeout');
  assert.ok(engine.session(key));
  two.engine.ingestCanonical('agents', two.team.agents().slice(0, 1));
  assert.equal(engine.agents().filter(a => a.id.startsWith('rt:two:')).length, 1);
  assert.equal(engine.runtimes().find(r => r.id === 'one').connection, 'timeout');
});
test('transcript identity includes source/session and sender/delegation/tool ownership', t => {
  const one = partition('one'), two = partition('two'), engine = createMultiEngine({ instances: [one, two] }); t.after(() => engine.close());
  const native = one.engine.sessions()[0].key;
  for (const source of [one, two]) {
    const transcript = { sessionKey: native, fetchedAt: NOW, messageCount: 1, window: { from: 0, to: 1 },
      participants: [{ kind: 'agent', id: 'nova', name: 'Nova', runtime: 'demo', channel: null, avatarHint: null }],
      events: [{ id: 'ev:0:0', kind: 'tool', at: NOW, callId: 'shared-call', name: 'Read', toolKind: 'file-read',
        input: '{}', output: 'synthetic result', isError: false, durationMs: null, truncated: false,
        senderInfo: { kind: 'tool', id: 'shared-call', name: 'Read', runtime: 'demo', channel: null, avatarHint: null } }] };
    assert.equal(source.engine.ingestCanonical('transcript', transcript, { key: native }).ok, true);
  }
  const first = engine.transcript(scopedId('one', 'session', native)), second = engine.transcript(scopedId('two', 'session', native));
  assert.notEqual(first.sessionKey, second.sessionKey);
  assert.equal(first.events.length, 1);
  assert.notEqual(first.events[0].id, second.events[0].id);
  assert.notEqual(first.events[0].callId, second.events[0].callId);
  assert.equal(first.events[0].senderInfo.runtime, 'one');
  assert.equal(second.participants[0].runtime, 'two');
});
test('quarantine namespaces persist, retry, mute and prune independently', t => {
  const one = partition('one'), two = partition('two'), engine = createMultiEngine({ instances: [one, two] }); t.after(() => engine.close());
  for (const source of [one, two]) source.engine.quarantine.record({ channel: 'canonical.agents', code: 'shape.invalid', severity: 'warn', path: '$.canonical.agent' });
  const rows = engine.quarantine.list().filter(i => i.code === 'shape.invalid');
  assert.equal(rows.length, 2); assert.notEqual(rows[0].fingerprint, rows[1].fingerprint);
  assert.match(rows[0].fingerprint, /^[0-9a-f]{16}$/);
  const dirty = engine.quarantine.takeDirty(); engine.quarantine.requeue(dirty);
  assert.deepEqual(engine.quarantine.takeDirty(), dirty);
  assert.equal(engine.quarantine.counts().open.warn, 2);
  engine.setIssueMuted(rows[0].fingerprint, true); assert.equal(engine.quarantine.counts().open.warn, 1);
});
test('valid multi-runtime health envelopes resolve restored legacy VM errors and persist the resolution', t => {
  const source = partition('legacy');
  source.engine.quarantine.restore([{ fingerprint: '0123456789abcdef', code: 'vm.invalid', severity: 'error', channel: 'core:vm.health',
    path: '$.health.level', count: 1, firstSeenAt: NOW - 1000, lastSeenAt: NOW - 1000, state: 'open' }]);
  const engine = createMultiEngine({ instances: [source] }); t.after(() => engine.close());
  assert.equal(engine.quarantine.list().find(row => row.code === 'vm.invalid').state, 'open');
  for (let i = 0; i < 10; i++) engine.quarantine.markClean('core:vm.health');
  assert.equal(engine.quarantine.list().find(row => row.code === 'vm.invalid').state, 'resolved');
  const dirty = engine.quarantine.takeDirty();
  assert.equal(dirty.upserts[0].state, 'resolved');

  const restored = partition('legacy'), reopened = createMultiEngine({ instances: [restored] }); t.after(() => reopened.close());
  reopened.quarantine.restore(dirty.upserts);
  assert.equal(reopened.quarantine.list().find(row => row.code === 'vm.invalid').state, 'resolved', 'the resolved state survives persistence and restart');
});
test('repeated diagnostic source rows merge to unique scoped issues for health projection', t => {
  const source = partition('same'), engine = createMultiEngine({ instances: [source, source] }); t.after(() => engine.close());
  source.engine.quarantine.record({ channel: 'canonical.agents', code: 'shape.invalid', severity: 'warn', path: '$.canonical.agent' });
  const rows = engine.dataQuality().issues;
  assert.equal(rows.length, 1);
  assert.equal(new Set(rows.map(row => row.fingerprint)).size, rows.length);
  assert.equal(engine.dataQuality().total, 1);
  assert.deepEqual(engine.dataQuality().open, { error: 0, warn: 1, info: 0 });
});
test('a failed adapter constructor/start cannot prevent another start; close fences late ingestion', async t => {
  const taps = new Map();
  const fake = id => ({ definition,
    createRuntime() {
      if (id === 'bad') throw new Error('synthetic private failure');
      return { definition, commands: {}, attach(engine) { taps.set(id, engine); },
        start(engine) { if (id === 'hung') return new Promise(() => {}); engine.ingestCanonical('agents', createDemoTeam({ now: () => NOW }).agents()); }, close() {} };
    } });
  const specs = ['bad', 'hung', 'good'].map(id => ({ id, adapter: id, enabled: true, cfg: {} }));
  const controller = createMultiRuntimeController({ cfg: { runtimeInstances: specs }, timeoutMs: 20, resolveAdapter: fake,
    store: { owner: null, persons: { senderPeople: () => [] }, quarantine: { loadAll: () => [] }, flushQuarantine() {} } }); t.after(() => controller.close());
  controller.runtime.start(controller.engine);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(controller.engine.agents().length, 3);
  assert.equal(controller.engine.runtimes().find(r => r.id === 'bad').connection, 'upstream-failed');
  assert.equal(controller.engine.runtimes().find(r => r.id === 'hung').connection, 'timeout');
  controller.close();
  const after = taps.get('good').ingestCanonical('agents', []);
  assert.equal(after.category, 'source-replaced');
  assert.equal(controller.engine.agents().length, 3);
});

test('merged invalid primary emits the existing neutral issue and falls back without losing the healthy partition',t=>{
  const one=partition('one'),core=createEngine({adapter:definition}),engine=createMultiEngine({instances:[one],primary:scopedId('one','agent','missing'),core});t.after(()=>engine.close());
  assert.equal(engine.primaryAgent().id,scopedId('one','agent','nova'));
  assert.ok(engine.quarantine.list().some(r=>r.code==='config.primary-invalid' && r.channel==='core:config.primary'));
});

test('write commands bind to one instance and reject conflicting ownership without calling either adapter',async t=>{
  const calls=[],caps={...definition.capabilities(),chat:true,restart:true,flows:{read:true,write:true}};
  const writable={...definition,capabilities:()=>caps};
  const resolveAdapter=id=>({definition:writable,createRuntime(){return{definition:writable,attach(engine){engine.ingestCanonical('agents',createDemoTeam({now:()=>NOW}).agents());},start(){},async close(){throw Error('synthetic close');},commands:{flowCreate:async body=>{calls.push([id,body]);return{ok:true,jobId:'same-native-flow'};},flowRun:async key=>{calls.push([id,key]);return{ok:true};}}};}});
  const controller=createMultiRuntimeController({cfg:{runtimeInstances:['one','two'].map(id=>({id,adapter:id,enabled:true,cfg:{}}))},resolveAdapter,
    store:{owner:null,persons:{senderPeople:()=>[]},quarantine:{loadAll:()=>[]},flushQuarantine(){}}});t.after(()=>controller.close());
  let result=await controller.runtime.commands.flowCreate({runtimeId:'one',agentId:scopedId('two','agent','nova')});assert.equal(result.ok,false);assert.deepEqual(calls,[]);
  result=await controller.runtime.commands.flowCreate({runtimeId:'two',agentId:scopedId('two','agent','nova')});assert.equal(result.jobId,scopedId('two','flow','same-native-flow'));assert.equal(calls[0][0],'two');assert.equal(calls[0][1].agentId,'nova');assert.equal(calls[0][1].runtimeId,undefined);
  await controller.runtime.commands.flowRun(scopedId('one','flow','same-native-flow'));assert.deepEqual(calls[1],['one','same-native-flow']);
});

test('adapter project-session identity maps the canonical agent to its native session and scopes the result', t => {
  const runtimeDefinition = { ...definition };
  const store = { owner: null, persons: { senderPeople: () => [] }, quarantine: { loadAll: () => [] }, flushQuarantine() {} };
  const controller = createMultiRuntimeController({ cfg: { primaryAgent: scopedId('two', 'agent', 'nova'), runtimeInstances: ['one', 'two'].map(id => ({
    id, adapter: 'demo', enabled: true, config: { adapter: 'demo' }, cfg: { agentNames: {}, hiddenAgents: [], configuredAgents: null },
  })) }, store, resolveAdapter: () => ({ definition: runtimeDefinition, createRuntime: () => ({ definition: runtimeDefinition, attach() {}, close() {} }) }) });
  t.after(() => controller.close());
  const agentId = scopedId('two', 'agent', 'nova');
  const key = controller.runtime.definition.sessionKeyFor(agentId, 'ao-projet-world-weather', { purpose: 'project' });
  assert.equal(key, scopedId('two', 'session', 'demo:nova:ao-projet-world-weather'));
});

test('a rejected start retries independently with capped backoff while another source stays live',async t=>{
  let attempts=0;
  const resolveAdapter=id=>({definition,createRuntime(){return{definition,attach(){},close(){},async start(engine){if(id==='flaky' && ++attempts===1)throw Error('synthetic');engine.ingestCanonical('agents',createDemoTeam({now:()=>NOW}).agents());}};}});
  const controller=createMultiRuntimeController({cfg:{runtimeInstances:['flaky','healthy'].map(id=>({id,adapter:id,enabled:true,cfg:{}}))},resolveAdapter,
    store:{owner:null,persons:{senderPeople:()=>[]},quarantine:{loadAll:()=>[]},flushQuarantine(){}}});t.after(()=>controller.close());
  controller.runtime.start(controller.engine);await new Promise(r=>setImmediate(r));
  assert.equal(controller.engine.agents().filter(a=>a.id.startsWith('rt:healthy:')).length,3);
  await new Promise(r=>setTimeout(r,2100));assert.equal(attempts,2);assert.equal(controller.engine.agents().length,6);
});

test('canonical transfer into a native adapter preserves model/run/class and subsequent raw refresh stays valid',t=>{
  const {feed}=require('../helpers/feed'),{loadScenario}=require('../helpers/scenario');
  const sc=loadScenario('foreign-instance'),before=feed(createEngine({now:()=>NOW}),sc),after=createEngine({now:()=>NOW});
  t.after(()=>{before.close();after.close();});
  const snapshot=structuredClone(before.sessions());
  assert.equal(after.ingestCanonical('sessions.snapshot',snapshot).ok,true);
  assert.deepEqual(JSON.parse(JSON.stringify(after.sessions())),snapshot);
  const renamed={...snapshot[0],displayName:'Transferred synthetic session'};
  assert.equal(after.ingestCanonical('sessions.upsert',renamed).ok,true);
  assert.equal(after.session(renamed.key).displayName,renamed.displayName);
  assert.deepEqual(after.session(renamed.key).model,snapshot[0].model);
  feed(after,sc);
  assert.deepEqual(JSON.parse(JSON.stringify(after.sessions())),snapshot);
  assert.ok(after.sources().every(s=>s.state==='fresh'));
  const bad={...snapshot[0],model:{id:42,provider:null}};
  assert.equal(after.ingestCanonical('sessions.snapshot',[bad]).ok,false);
  assert.equal(after.sessions().length,snapshot.length,'a rejected transfer cannot delete last-good sessions');
});
