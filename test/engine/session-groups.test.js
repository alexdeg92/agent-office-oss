'use strict';
// S7b (PM): OpenClaw session groups. The read-scoped catalog (sessions.groups.list) + each row's `category`
// → engine.sessionGroups() → the projects candidate input. Also the catalog-only sessions.changed event.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createEngine } = require('../../src/engine');
const { createRuntime } = require('../../src/adapters/openclaw');
const { sessionGroupsOf } = require('../../src/api/v2/projects');
const { readFixture, loadScenario } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');

const sc = loadScenario('synthetic-basic');
const NOW = sc.now;
const rows = () => readFixture(sc.rpc['sessions.list']).body.value;
const SUB = 'agent:main:subagent:ffffffff-0001-4000-8000-000000000001';
const env = (channel, value, extra = {}) => Object.assign({ source: 'gateway', channel, receivedAt: NOW, body: { kind: 'json', value } }, extra);
// the synthetic list with two sessions in « Netzach » (main and the first subagent)
function groupedList() {
  const v = rows();
  for (const r of v.sessions) if (r.key === 'agent:main:main' || r.key === SUB) r.category = 'Netzach';
  return v;
}
const CATALOG = { groups: [{ name: 'Automations', position: 1 }, { name: 'Netzach', position: 0 }, { name: 'Vide', position: 2 }], sectionOrder: [] };

describe('session groups · engine (S7b)', () => {
  it('catalog in position order, members from the rows, last activity; no issue', () => {
    const engine = createEngine({ now: () => NOW });
    assert.equal(engine.sessionGroups(), null, 'null until the catalog has been read');
    assert.equal(engine.ingest(env('gw.rpc.sessions.list', groupedList(), { context: { offset: 0 } })).ok, true);
    assert.equal(engine.ingest(env('gw.rpc.sessions.groups.list', CATALOG)).ok, true);
    const groups = engine.sessionGroups();
    assert.deepEqual(groups.map((g) => [g.name, g.position, g.sessionKeys]), [
      ['Netzach', 0, ['agent:main:main', SUB].sort()], ['Automations', 1, []], ['Vide', 2, []]]);
    assert.deepEqual(groups.map((g) => g.id), ['Netzach', 'Automations', 'Vide'], 'OpenClaw: the stable id is the name');
    const netzach = engine.sessions().filter((s) => s.group === 'Netzach').map((s) => s.updatedAt);
    assert.equal(groups[0].lastActivityAt, Math.max(...netzach));
    assert.equal(engine.session('agent:main:main').group, 'Netzach');
    assert.equal(engine.dataQuality().issues.filter((i) => i.severity !== 'info').length, 0);
  });

  it('a row leaving its group (category null) leaves the members; an invalid catalog entry is dropped, value-free', () => {
    const engine = createEngine({ now: () => NOW });
    engine.ingest(env('gw.rpc.sessions.list', groupedList(), { context: { offset: 0 } }));
    engine.ingest(env('gw.rpc.sessions.groups.list', CATALOG));
    const row = groupedList().sessions.find((r) => r.key === SUB);
    const { key, ...rest } = row;
    engine.ingest(env('gw.event.sessions.changed', Object.assign(rest, { sessionKey: key, category: null, updatedAt: NOW })));
    assert.deepEqual(engine.sessionGroups()[0].sessionKeys, ['agent:main:main']);
    engine.ingest(env('gw.rpc.sessions.groups.list', { groups: [{ name: 'Secret-name', position: -1 }, { name: 'Ok', position: 0 }] }));
    assert.deepEqual(engine.sessionGroups().map((g) => g.name), ['Ok']);
    assert.ok(!JSON.stringify(engine.dataQuality()).includes('Secret-name'), 'no group name in data quality');
  });

  it('the catalog-only sessions.changed ({reason: groups}, no sessionKey) is accepted and changes no session', () => {
    const engine = createEngine({ now: () => NOW });
    engine.ingest(env('gw.rpc.sessions.list', groupedList(), { context: { offset: 0 } }));
    const before = JSON.stringify(engine.sessions());
    const r = engine.ingest(env('gw.event.sessions.changed', { reason: 'groups', ts: NOW }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.issues.filter((i) => i.severity !== 'info'), []);
    assert.equal(JSON.stringify(engine.sessions()), before);
  });

  it('projects input: non-empty groups as {name, sessionKeys, lastActivityAt}; [] before the first read', () => {
    const engine = createEngine({ now: () => NOW });
    assert.deepEqual(sessionGroupsOf(engine)(), []);
    engine.ingest(env('gw.rpc.sessions.list', groupedList(), { context: { offset: 0 } }));
    engine.ingest(env('gw.rpc.sessions.groups.list', CATALOG));
    const input = sessionGroupsOf(engine)();
    assert.deepEqual(input.map((g) => [g.groupId, g.name, g.sessionKeys.length]), [['Netzach', 'Netzach', 2]]);
    assert.equal(typeof input[0].lastActivityAt, 'number');
  });
});

describe('session groups · adapter read and refresh (S7b)', () => {
  // A transport stand-in: records calls, answers the catalog, emits like the Gateway.
  function fakeGw() {
    const gw = new EventEmitter();
    gw.connected = true; gw.calls = [];
    gw.call = async (method) => { gw.calls.push(method); if (method === 'sessions.groups.list') return CATALOG; throw new Error('unknown method: ' + method); };
    return gw;
  }
  it('capability true; engine.request(sessionGroups) reads sessions.groups.list through the taps and returns the catalog', async () => {
    const { definition } = require('../../src/adapters/openclaw');
    assert.equal(definition.capabilities().sessionGroups, true);
    const gw = fakeGw();
    const engine = createEngine({ now: () => NOW });
    const { tapGateway } = require('../../src/adapters/openclaw/taps');
    tapGateway(gw, engine);
    engine.setReads(require('../../src/adapters/openclaw/reads').bind({ gw, cli: { run: async () => ({ ok: false }) } }));
    const r = await engine.request('sessionGroups');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.map((g) => g.name), ['Netzach', 'Automations', 'Vide']);
    assert.deepEqual(gw.calls, ['sessions.groups.list']);
  });

  it('createRuntime().attach: refresh on open, on {reason: groups} (500 ms debounce), not on a row event', async () => {
    const { Gateway } = require('../../src/adapters/openclaw/transport');
    const orig = Gateway.prototype.call;
    const calls = [];
    Gateway.prototype.call = async function (method) { calls.push(method); if (method === 'sessions.groups.list') return CATALOG; throw new Error('unknown method'); };
    const rt = createRuntime({ gatewayUrl: 'ws://127.0.0.1:9', gatewayToken: 't', identityPath: '/nonexistent', stateDbPath: '/nonexistent', openclawBin: '/bin/false', openclawHome: '/tmp', readonly: true });
    try {
      const engine = createEngine({ now: () => NOW });
      rt.attach(engine);
      rt.gw.connected = true;
      rt.gw.emit('open', null);
      await waitFor(() => engine.sessionGroups() !== null, { timeoutMs: 2000, what: 'catalog after open' });
      assert.equal(calls.filter((m) => m === 'sessions.groups.list').length, 1);
      rt.gw.emit('gwevent', 'sessions.changed', { sessionKey: 'agent:main:main', reason: 'updated' });
      rt.gw.emit('gwevent', 'sessions.changed', { reason: 'groups' });
      rt.gw.emit('gwevent', 'sessions.changed', { reason: 'groups' });
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(calls.filter((m) => m === 'sessions.groups.list').length, 2, 'one more read for two catalog events, none for the row event');
    } finally { rt.close(); Gateway.prototype.call = orig; }
  });
});

describe('session groups · live path to Projets (S7b, R13-15)', () => {
  it('a catalog group is a NAMED ref {by:group}; imported, a session filed into the group later joins the project', async () => {
    // OpenClaw's list and its events agree: once the DM session is filed into « Netzach », both carry the category
    const DM = 'agent:main:discord:direct:100000000000000001';
    let joined = false;
    const list = () => { const v = groupedList(); if (joined) for (const r of v.sessions) if (r.key === DM) Object.assign(r, { category: 'Netzach', updatedAt: NOW }); return v; };
    const h = await startServer(sc, { handlers: { 'sessions.list': () => list(), 'sessions.groups.list': () => CATALOG } });
    try {
      const c = await waitFor(async () => {
        const r = await h.get('/api/v2/views/project-candidates');
        return r.json && r.json.data.candidates.find((x) => x.sources.some((s) => s.kind === 'sessionGroup'));
      }, { what: 'a session-group candidate' });
      const src = c.sources.find((s) => s.kind === 'sessionGroup');
      assert.deepEqual(src.ref, { by: 'group', groupId: 'Netzach', name: 'Netzach' }, 'never the frozen keys fallback for a catalog group');
      assert.equal(c.name, 'Netzach');
      const dq = (await h.get('/api/v2/views/health')).json.data.dataQuality;
      assert.equal(dq.issues.filter((i) => i.channel === 'gw.rpc.sessions.groups.list').length, 0);

      const imp = await h.request('POST', '/api/v2/projects/import', { keys: [c.key] });
      assert.equal(imp.status, 200, imp.text);
      const id = imp.json.data.result.created[0].id;
      // a linked session lands in the project's history as a `session` event (architect-57: its key is item.session.key;
      // params.session is now its human label)
      const linked = async () => {
        const items = (await h.get('/api/v2/views/projects/' + id + '/history?limit=100')).json.data.items;
        return new Set(items.filter((x) => x.kind === 'session' && x.session).map((x) => x.session.key));
      };
      await waitFor(async () => { const k = await linked(); return k.has('agent:main:main') && k.has(SUB); }, { what: 'the two members linked' });
      assert.ok(!(await linked()).has(DM), 'not a member yet');
      // a third session is filed into « Netzach » after the import (a live row event, as OpenClaw sends it)
      joined = true;
      const { key, ...rest } = list().sessions.find((r) => r.key === DM);
      h.gw.emit('sessions.changed', Object.assign(rest, { sessionKey: key }));
      await waitFor(async () => (await linked()).has(DM), { what: 'the later member linked without reimport' });
    } finally { await h.stop(); }
  });

  it('without a catalog (a runtime without groups) the keys fallback still works in the projects input', () => {
    const engine = createEngine({ now: () => NOW });
    engine.ingest(env('gw.rpc.sessions.list', groupedList(), { context: { offset: 0 } }));
    assert.deepEqual(sessionGroupsOf(engine)(), [], 'no catalog → no group input (projects then uses keys refs for manual groups)');
  });
});
