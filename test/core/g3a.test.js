'use strict';
// G3a (ADR-001 §12.2, §12.6, §12.7): the primary-agent resolver, the 2.x projection seam, MetaVM.primaryAgent/instance.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolvePrimaryAgent } = require('../../src/engine/derive/primary-agent');
const { project2x } = require('../../src/api/v2/project2x');
const { createEngine } = require('../../src/engine');
const { buildMetaVM } = require('../../src/api/v2/vm/meta');
const { normaliseAgents } = require('../../src/adapters/openclaw/normalise/agent');

const A = (id, isPrimary = false) => ({ id, name: id.toUpperCase(), isPrimary });

describe('G3a · the primary-agent resolver', () => {
  it('config → runtime flag → first listed (guessed) → null; an unlisted config is an issue', () => {
    assert.deepEqual(resolvePrimaryAgent([A('a'), A('b', true)], { primary: 'a' }), { agentId: 'a', source: 'config', issues: [] });
    const bad = resolvePrimaryAgent([A('a'), A('b', true)], { primary: 'zz' });
    assert.deepEqual([bad.agentId, bad.source, bad.issues.map((i) => i.code)], ['b', 'runtime', ['config.primary-invalid']]);
    const guessed = resolvePrimaryAgent([A('atlas'), A('b')], {});
    assert.deepEqual([guessed.agentId, guessed.source, guessed.issues.map((i) => i.code)], ['atlas', 'guessed', ['config.primary-guessed']]);
    assert.deepEqual(resolvePrimaryAgent([], {}), { agentId: null, source: null, issues: [] });
    assert.deepEqual(resolvePrimaryAgent(null, {}).agentId, null);
  });
  it('the OpenClaw normaliser no longer guesses main: no defaultId → no flag', () => {
    const agents = normaliseAgents({ agents: [{ id: 'main' }, { id: 'atlas' }] });
    assert.deepEqual(agents.map((a) => a.isPrimary), [false, false]);
    assert.deepEqual(normaliseAgents({ defaultId: 'atlas', agents: [{ id: 'main' }, { id: 'atlas' }] }).map((a) => a.isPrimary), [false, true]);
  });
  it('the engine: a foreign primary resolves without any main; a change is a LiveEvent; meta names it', () => {
    const engine = createEngine({ now: () => Date.UTC(2026, 9, 6) });
    const feed = (value) => engine.ingest({ source: 'gateway', channel: 'gw.rpc.agents.list', receivedAt: Date.UTC(2026, 9, 6), body: { kind: 'json', value } });
    feed({ defaultId: 'atlas', agents: [{ id: 'atlas', name: 'Atlas' }, { id: 'helper', name: 'Helper' }] });
    assert.deepEqual(engine.primaryAgent(), { id: 'atlas', name: 'Atlas', source: 'runtime' });
    feed({ defaultId: 'helper', agents: [{ id: 'atlas', name: 'Atlas' }, { id: 'helper', name: 'Helper' }] });
    assert.equal(engine.primaryAgent().id, 'helper');
    assert.ok(engine.liveEvents().some((e) => e.kind === 'agent.primary-changed'));
    const meta = buildMetaVM({ instance: 'test', readonly: false, readonlyStore: false, timeZone: 'Europe/Paris', instanceLocale: 'fr-CA' }, { engine, authenticated: true });
    assert.deepEqual(meta.primaryAgent, { id: 'helper', name: 'Helper', avatarUrl: null });
    assert.deepEqual(meta.instance, { timeZone: 'Europe/Paris', locale: 'fr-CA', configured: true });
  });
  it('a configured primary wins over the runtime; an unlisted one falls back with a warn issue', () => {
    const engine = createEngine({ now: () => Date.UTC(2026, 9, 6), primary: 'nobody' });
    engine.ingest({ source: 'gateway', channel: 'gw.rpc.agents.list', receivedAt: Date.UTC(2026, 9, 6), body: { kind: 'json', value: { defaultId: 'atlas', agents: [{ id: 'atlas' }] } } });
    assert.equal(engine.primaryAgent().id, 'atlas');
    assert.ok(engine.dataQuality().issues.some((i) => i.code === 'config.primary-invalid' && i.channel === 'config.primary'));
  });
});

describe('G3a · the 2.x projection is the identity on 2.x values (G3b maps 3.0 values back)', () => {
  it('2.x values pass through; the G3b vocabulary maps back to 2.x', () => {
    for (const v of ['main', 'subagent', 'cron', 'dm', 'channel']) assert.equal(project2x.occupantRole(v), v);
    for (const v of ['subagent', 'chat-direct', 'chat-group', 'explicit']) assert.equal(project2x.sessionKind(v), v);
    assert.deepEqual(['primary', 'scheduled', 'direct', 'group'].map(project2x.occupantRole), ['main', 'cron', 'dm', 'channel']);
    assert.equal(project2x.occupantId('primary'), 'main'); assert.equal(project2x.occupantId('subagent:x'), 'subagent:x');
    assert.deepEqual(['primary', 'scheduled', 'conversation-direct', 'conversation-group', 'conversation'].map(project2x.sessionKind), ['main', 'cron', 'chat-direct', 'chat-group', 'conversation']);   // T-0058: generic conversation is not a group
    assert.equal(project2x.occupantId('scheduled:j1'), 'cron:j1'); assert.equal(project2x.occupantId('direct:discord-user:1'), 'dm:discord-user:1');
    assert.equal(project2x.channelId('telegram'), 'unrecognized'); assert.equal(project2x.channelId('discord'), 'discord'); assert.equal(project2x.channelId(null), null);
  });
});

describe('G3a · no time-zone literal in the server', () => {
  it('America/Toronto is gone from src/', () => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
    const hits = walk(path.join(__dirname, '..', '..', 'src')).filter((f) => fs.readFileSync(f, 'utf8').includes('America/Toronto'));
    assert.deepEqual(hits, []);
  });
});
