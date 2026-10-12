'use strict';
// T-0058: Journaux for several connectors and agents, through the MOUNTED routes (v2 and v3) on a multi-runtime
// engine. Synthetic adapters and sessions only; loopback; no runtime home.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { createMultiEngine } = require('../../src/engine/multi');
const { scopedId } = require('../../src/runtime-ids');
const { mountV2 } = require('../../src/api/v2/routes');
const { createApp } = require('../../src/api/http');
const { buildSessionVM } = require('../../src/api/v2/vm/logs');

const NOW = Date.now();
const SECRET = 'synthetic-secret-canary';
const base = (key, agentId, kind, extra = {}) => ({ key, sessionId: null,
  class: { kind, ruleId: 'synthetic', agentId, channel: null, heartbeatOf: null, background: false, rawClassification: null, ...(extra.class || {}) },
  displayName: null, model: { id: 'model-synthetic', provider: null }, provider: null, usage: { total: 0, input: null, output: null }, updatedAt: NOW - 1000,
  run: { status: 'idle', endReason: null, evidence: 'none', startedAt: null, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null },
  costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null, interactive: true, group: null, ...extra, ...(extra.class ? { class: { kind, ruleId: 'synthetic', agentId, channel: null, heartbeatOf: null, background: false, rawClassification: null, ...extra.class } } : {}) });

function adapter(id, name, mark) {
  return { id, name, ...(mark ? { mark } : {}), schemas: {}, routes: {}, normalise: { session: row => ({ session: row }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) },
    classifySession: () => ({ kind: 'unrecognized' }), capabilities: () => ({ sessions: true }) };
}

async function mounted(t) {
  const chat = createEngine({ adapter: adapter('synthetic-chat', 'Chat Runtime', { monogram: 'CR', color: '#0b7285' }), now: () => NOW, runtimeId: 'legacy' });
  chat.ingestCanonical('agents', [{ id: 'atlas', name: 'Atlas', displayName: 'Atlas', workspace: null, model: null, fallbackModels: [], isPrimary: true, mainSessionKey: 'agent:atlas:main' }]);
  chat.ingestCanonical('sessions.snapshot', [
    base('agent:atlas:main', 'atlas', 'primary', { usage: { total: 1200, input: null, output: null }, tokensKnown: true }),
    base('agent:atlas:group:unnamed', 'atlas', 'conversation-group', { class: { channel: 'discord', interlocutorId: 'discord-channel:100000000000000002' }, usage: { total: 300, input: null, output: null }, tokensKnown: true }),
    base('agent:atlas:named', 'atlas', 'explicit', { class: { explicitKey: 'named' }, displayName: 'Atlas named session' }),
    // security-155: an operator-named session whose name is credential-shaped, with no display name or summary
    base(`agent:atlas:token=${SECRET}`, 'atlas', 'explicit', { class: { explicitKey: `token=${SECRET}` } }),
    base('agent:atlas:ghp_SYNTHETIC0123456789abcdefghij', 'atlas', 'explicit', { class: { explicitKey: 'ghp_SYNTHETIC0123456789abcdefghij' } }),
  ]);
  chat.setGatewayConnected(true);
  const coder = createEngine({ adapter: adapter('synthetic-coder', 'Coder'), now: () => NOW, runtimeId: 'coder' });
  coder.ingestCanonical('agents', [{ id: 'proj', name: 'proj', displayName: 'Projet synthétique', workspace: null, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: null }]);
  coder.ingestCanonical('sessions.snapshot', [
    base('rt-session-titled', 'proj', 'conversation', { displayName: `Plan de migration token=${SECRET}`, updatedAt: NOW,
      run: { status: 'running', endReason: null, evidence: 'start-without-end', evidenceLevel: 'observed', observedAt: NOW, expiresAt: NOW + 30_000,
        startedAt: NOW - 1000, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null } }),
    base('rt-session-prompt', 'proj', 'conversation', { summary: 'Réparer le test du bureau' }),
    base('rt-session-bare', 'proj', 'conversation'),
  ]);
  coder.setGatewayConnected(true);
  const engine = createMultiEngine({ instances: [{ id: 'legacy', adapter: 'synthetic-chat', enabled: true, engine: chat }, { id: 'coder', adapter: 'synthetic-coder', name: 'Coder', enabled: true, engine: coder }], primary: scopedId('legacy', 'agent', 'atlas') });
  let api;
  const app = createApp({ apiOnly: true, mountRoutes: (a) => { api = mountV2(a, { engine, runtime: { commands: {}, refreshFlows: async () => {}, refreshSkills: async () => {} },
    auth: { onRevoke() {}, sessionOf: () => ({ sid: 'synthetic-owner', email: 'owner@example.test', exp: NOW + 600000 }) },
    cfg: { instance: 'test', capture: false, readonly: false, readonlyStore: false, agentNames: {} } }); } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { api.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); engine.close?.(); });
  const get = async (path) => { const r = await fetch('http://127.0.0.1:' + server.address().port + path); return { status: r.status, body: await r.json() }; };
  return { get, api, engine };
}

const titleText = (row) => JSON.stringify(row.title);

for (const version of [2, 3]) {
  test(`v${version}: each row names its connector (adapter mark) and agent; titles are canonical, never raw keys`, async (t) => {
    const h = await mounted(t);
    const r = await h.get(`/api/v${version}/views/logs`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = r.body.data.items;
    const byId = (key) => rows.find(x => [key, scopedId('coder', 'session', key), scopedId('legacy', 'session', key)].includes(x.id));
    assert.ok(!JSON.stringify(rows.map(({ id, ...shown }) => shown)).includes(SECRET), 'titles, labels and names are redacted (the id is the session key, only used to navigate)');

    const titled = byId('rt-session-titled');
    assert.deepEqual(titled.connector, { id: 'coder', adapter: 'synthetic-coder', name: 'Coder', mark: titled.connector.mark });
    assert.match(titled.connector.mark.color, /^#[0-9a-f]{6}$/); assert.equal(titled.connector.mark.monogram, 'C');
    assert.equal(titled.agent.name, 'Projet synthétique');
    assert.equal(titled.title.params.name, 'Plan de migration token=…');
    assert.equal(titled.kind, 'conversation', 'a coding-agent conversation is never « Group »');
    assert.equal(titled.tokensKnown, false, 'unknown tokens are marked unknown');
    assert.equal(titled.execution.status, 'running');
    assert.equal(titled.execution.evidence.level, 'observed', 'an indirect run never becomes verified');
    const detail = buildSessionVM(h.engine.session(titled.id), null, {}, 'unavailable');
    assert.deepEqual(detail.run.evidence, { level: 'observed', observedAt: NOW, expiresAt: NOW + 30_000 });
    assert.equal(byId('rt-session-prompt').title.params.name, 'Réparer le test du bureau');
    assert.deepEqual(byId('rt-session-bare').title, { key: 'sessionTitle.named', params: { name: 'Projet synthétique' } }, 'falls back to the agent, not the key');

    const main = byId('agent:atlas:main');
    assert.deepEqual(main.connector.mark, { monogram: 'CR', color: '#0b7285' });
    assert.equal(main.agent.name, 'Atlas'); assert.equal(main.tokensKnown, true);
    const group = byId('agent:atlas:group:unnamed');
    assert.equal(group.title.key, 'sessionTitle.groupUnnamed');
    assert.deepEqual(group.title.params.platform, { key: 'channel.discord' });
    for (const row of rows) assert.ok(!titleText(row).includes(row.id), `${row.id}: no raw key in the title`);
    // security-155: every title fallback is redacted; the secret never appears in a title or the French label
    const leaky = byId(`agent:atlas:token=${SECRET}`), token = byId('agent:atlas:ghp_SYNTHETIC0123456789abcdefghij');
    assert.deepEqual(leaky.title, { key: 'sessionTitle.explicit', params: { id: 'token=…' } });
    assert.deepEqual(token.title, { key: 'sessionTitle.explicit', params: { id: '…' } });
    for (const row of rows) assert.ok(!JSON.stringify([row.title, row.label]).includes(SECRET) && !JSON.stringify(row.title).includes('ghp_'), `${row.id}: redacted title`);

    const facets = r.body.data.facets;
    assert.deepEqual(facets.connectors.map(c => [c.name, c.id, c.count]), [['Chat Runtime', 'legacy', 5], ['Coder', 'coder', 3]]);
    assert.deepEqual(facets.agents.map(a => a.name), ['Atlas', 'Projet synthétique']);
  });

  test(`v${version}: connector and agent filters work on HTTP and are distinct topics`, async (t) => {
    const h = await mounted(t);
    const coder = await h.get(`/api/v${version}/views/logs?connector=coder`);
    assert.equal(coder.status, 200);
    assert.ok(coder.body.data.items.length === 3 && coder.body.data.items.every(x => x.connector.id === 'coder'));
    assert.equal(coder.body.meta.topic.id, 'logs?connector=coder');
    assert.equal(coder.body.data.facets.connectors.length, 2, 'facets ignore the connector filter (menus keep every option)');
    const agentId = coder.body.data.items[0].agent.id;
    const byAgent = await h.get(`/api/v${version}/views/logs?agent=${encodeURIComponent(agentId)}&connector=coder`);
    assert.equal(byAgent.body.meta.topic.id, `logs?agent=${encodeURIComponent(agentId)}&connector=coder`);
    assert.ok(byAgent.body.data.items.every(x => x.agent.id === agentId));
    assert.equal((await h.get(`/api/v${version}/views/logs?connector=nobody`)).body.data.items.length, 0);
    assert.equal((await h.get(`/api/v${version}/views/logs?connector=${'x'.repeat(600)}`)).status, 400);
    const conv = await h.get(`/api/v${version}/views/logs?kind=conversation`);
    assert.equal(conv.status, 200); assert.ok(conv.body.data.items.length === 3 && conv.body.data.items.every(x => x.kind === 'conversation'));
  });
}

test('v2: chat-group no longer includes generic conversations', async (t) => {
  const h = await mounted(t);
  const groups = await h.get('/api/v2/views/logs?kind=chat-group');
  assert.deepEqual(groups.body.data.items.map(x => x.kind), ['chat-group']);
});
