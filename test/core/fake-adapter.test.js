'use strict';
// G2 (ADR-001 §12.4): the core runs on an adapter with NO OpenClaw shapes: no raw schemas, no routes, no `gw.hello`.
// A fake adapter hands the engine canonical values through ingestCanonical(); sessions, agents and runtime facts
// reach the core VMs, and the typed reads follow the capabilities (false → capability-unavailable → 404).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { buildHealthVM, createHealthSeries } = require('../../src/api/v2/vm/health');
const { buildMetaVM } = require('../../src/api/v2/vm/meta');

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

function fakeAdapter({ caps = {} } = {}) {
  return {
    id: 'fake', name: 'Fake Runtime', gatewayLabel: 'Serveur factice', testedWith: null,
    schemas: {}, routes: {}, eventPrefix: 'fake.event.',
    // a canonical runtime: its rows are already Sessions, its classification is already done
    normalise: {
      session: (row) => ({ session: row }),
      runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }),
    },
    classifySession: () => ({ kind: 'unrecognized', ruleId: 'fake', agentId: null, channel: null, heartbeatOf: null, background: false, rawClassification: null }),
    capabilities: () => Object.assign({ sessions: true, transcripts: false, flows: { read: false }, skills: { detail: false } }, caps),
  };
}

const session = (key, over = {}) => Object.assign({
  key, sessionId: null,
  class: { kind: 'primary', ruleId: 'fake.main', agentId: 'helper', channel: null, heartbeatOf: null, background: false, rawClassification: null },
  displayName: 'Assistant', model: null, provider: null, usage: { total: 0, input: null, output: null }, updatedAt: NOW - 1000,
  run: { status: 'idle', endReason: null, evidence: 'none', startedAt: null, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null },
  costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null, interactive: true, group: null,
}, over);

describe('core · fake adapter without OpenClaw shapes (§12.4)', () => {
  it('sessions, agents and runtime facts reach the engine and the core VMs', () => {
    const engine = createEngine({ adapter: fakeAdapter(), now: () => NOW });
    assert.equal(engine.ingestCanonical('sessions.snapshot', [session('s:1'), session('s:2', { displayName: 'Autre' })]).ok, true);
    assert.equal(engine.ingestCanonical('agents', [{ id: 'helper', name: 'Helper', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: 's:1' }]).ok, true);
    assert.equal(engine.ingestCanonical('hello', { version: '1.2.3', protocol: 7, events: ['tick'] }).ok, true);
    engine.setGatewayConnected(true);

    assert.deepEqual(engine.sessions().map((s) => s.key), ['s:1', 's:2']);
    assert.deepEqual(engine.agents().map((a) => [a.id, a.isPrimary]), [['helper', true]]);
    assert.equal(engine.session('s:2').displayName, 'Autre');
    const rt = engine.runtime();
    assert.deepEqual({ adapterId: rt.adapterId, name: rt.name, gatewayLabel: rt.gatewayLabel, version: rt.version, protocol: rt.protocol, state: rt.state, connected: rt.connected },
      { adapterId: 'fake', name: 'Fake Runtime', gatewayLabel: 'Serveur factice', version: '1.2.3', protocol: 7, state: 'connected', connected: true });
    assert.equal(engine.latest('gw.hello'), undefined, 'no raw hello channel exists for this runtime');

    const vm = buildHealthVM({ engine, series: createHealthSeries({ engine, now: () => NOW }) });
    const card = vm.cards.find((c) => c.id === 'gateway');
    assert.equal(card.level, 'ok');
    assert.deepEqual(card.sub, { key: 'healthSub.protocol', params: { n: 7 } }, 'HealthVM reads the protocol from engine.runtime()');

    const meta = buildMetaVM({ instance: 'test', readonly: false, readonlyStore: false }, { engine, authenticated: true });
    assert.deepEqual(meta.runtime, { id: 'fake', name: 'Fake Runtime', gatewayLabel: 'Serveur factice' });
  });

  it('onboarding names apply to any canonical adapter without mutating its input or bypassing bad rows', () => {
    const engine = createEngine({ adapter: fakeAdapter(), now: () => NOW, agentNames: { helper: 'Orion' } });
    const row = { id: 'helper', name: null, workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: null };
    assert.equal(engine.ingestCanonical('agents', [row]).ok, true);
    assert.equal(engine.agents()[0].name, 'Orion'); assert.equal(row.name, null);
    assert.equal(engine.ingestCanonical('agents', [null]).ok, false);
    assert.equal(engine.agents()[0].name, 'Orion', 'last good list survives a bad row');
    const plain = createEngine({ adapter: fakeAdapter(), now: () => NOW });
    assert.equal(plain.ingestCanonical('agents', [{ ...row, id: 'constructor', name: 'Valid name' }]).ok, true);
    assert.equal(plain.agents()[0].name, 'Valid name', 'Object prototype properties are never names');
  });

  it('a complete snapshot deletes absent sessions; an upsert adds one; an invalid canonical row is quarantined, not admitted', () => {
    const engine = createEngine({ adapter: fakeAdapter(), now: () => NOW });
    engine.ingestCanonical('sessions.snapshot', [session('s:1'), session('s:2')]);
    engine.ingestCanonical('sessions.snapshot', [session('s:2')]);
    assert.deepEqual(engine.sessions().map((s) => s.key), ['s:2']);
    engine.ingestCanonical('sessions.upsert', session('s:3'));
    assert.deepEqual(engine.sessions().map((s) => s.key), ['s:2', 's:3']);

    engine.ingestCanonical('sessions.upsert', session('s:bad', { usage: { total: -1, input: null, output: null } }));
    assert.equal(engine.session('s:bad'), null);
    const issue = engine.dataQuality().issues.find((i) => i.channel === 'canonical.sessions.upsert');
    assert.ok(issue, 'recorded under the canonical channel');
    assert.equal(issue.code, 'shape.invalid');
  });

  it('wrong canonical input is rejected value-free; an unknown op throws', () => {
    const engine = createEngine({ adapter: fakeAdapter(), now: () => NOW });
    assert.equal(engine.ingestCanonical('agents', { not: 'a list' }).ok, false);
    assert.equal(engine.ingestCanonical('transcript', { key: 'x' }).ok, false, 'a keyed op needs { key }');
    assert.equal(engine.ingestCanonical('hello', { version: 3 }).ok, false, 'R13-03: an admission failure is a failed ingestion');
    assert.equal(engine.runtime().version, null, 'an invalid hello changes nothing');
    assert.ok(engine.dataQuality().issues.some((i) => i.channel === 'canonical.hello' && i.code === 'shape.invalid'));
    assert.throws(() => engine.ingestCanonical('gw.rpc.agents.list', []), /unknown op/);
    assert.ok(!JSON.stringify(engine.dataQuality()).includes('a list'), 'no payload value in data quality');
  });

  it('reads: capability false → capability-unavailable; true and present → the canonical value', async () => {
    const engine = createEngine({ adapter: fakeAdapter(), now: () => NOW });
    engine.ingestCanonical('sessions.snapshot', [session('s:1')]);
    const calls = [];
    engine.setReads({
      describeSession: async (key) => { calls.push(['describe', key]); engine.ingestCanonical('sessions.upsert', session(key, { displayName: 'Décrite' })); return { ok: true }; },
      transcript: async () => { calls.push(['transcript']); return { ok: true }; },
    });
    assert.deepEqual(await engine.request('transcript', 's:1'), { ok: false, category: 'capability-unavailable' }, 'capability false wins over a present read');
    assert.deepEqual(await engine.request('flowRuns', 'job'), { ok: false, category: 'capability-unavailable' });
    const d = await engine.request('describeSession', 's:1');
    assert.equal(d.ok, true); assert.equal(d.value.displayName, 'Décrite');
    assert.deepEqual(calls, [['describe', 's:1']]);
    await assert.rejects(() => engine.request('nope', 'x'), /unknown op/);

    const capable = createEngine({ adapter: fakeAdapter({ caps: { flows: { read: true } } }), now: () => NOW });
    assert.deepEqual(await capable.request('flowRuns', 'job'), { ok: false, category: 'capability-unavailable' }, 'capability true but no read → unavailable');
    capable.setReads({ flowRuns: async () => ({ ok: false, category: 'timeout' }) });
    assert.deepEqual(await capable.request('flowRuns', 'job'), { ok: false, category: 'timeout' });
  });

  it('a runtime that is not configured: source down with category not-configured, reads refused', async () => {
    const engine = createEngine({ adapter: fakeAdapter(), now: () => NOW });
    engine.setReads({ describeSession: async () => ({ ok: true }) });
    engine.setRuntimeNotConfigured('no-identity');
    assert.equal(engine.runtime().state, 'not-configured');
    assert.equal(engine.runtime().reason, 'no-identity');
    const gwSource = engine.sources().find((s) => s.id === 'gateway');
    assert.deepEqual([gwSource.state, gwSource.lastError], ['down', 'not-configured']);
    assert.deepEqual(await engine.request('describeSession', 's:1'), { ok: false, category: 'not-configured' });
    engine.setGatewayConnected(true);
    assert.equal(engine.runtime().state, 'connected');
    engine.setGatewayConnected(false);
    assert.equal(engine.sources().find((s) => s.id === 'gateway').lastError, 'not-connected');
  });
});
