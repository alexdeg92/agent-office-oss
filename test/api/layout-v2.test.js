'use strict';
// S14b: the office layout on the store (api.md §3.10, §3.13, §5.5) and the UI prefs (§5.3).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadScenario } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');
const { openSse } = require('../helpers/sse-client');
const { compareExample } = require('../helpers/contract-shape');
const { resolveTheme, structural } = require('../../src/api/v2/office-layout');

const sc = loadScenario('synthetic-basic');

describe('S14b · LayoutVM and the editor commands', () => {
  let h, vm;
  before(async () => { h = await startServer(sc); vm = (await h.get('/api/v2/office/layout')).json; });
  after(async () => { if (h) await h.stop(); });
  const clone = (x) => JSON.parse(JSON.stringify(x));

  it('GET: the seeded default layout matches layout-vm.json; topic layout; office layoutRevision follows it', async () => {
    assert.deepEqual(compareExample('layout-vm', vm, { envelope: true }), []);
    assert.equal(vm.meta.topic.id, 'layout');
    assert.equal(vm.data.layout.revision, 1); assert.equal(vm.data.layout.name, 'Bureau principal');
    assert.deepEqual(vm.data.layout.updatedBy, { kind: 'system', name: 'Système' });
    assert.deepEqual(vm.data.layout.data, vm.data.default.data);
    assert.equal((await h.get('/api/v2/views/office')).json.data.layoutRevision, 1);
  });

  it('save: a new revision as the owner; stale → 409 with current {revision, vm}; the office follows', async () => {
    const data = clone(vm.data.layout.data);
    data.agents.find((a) => a.agentId === 'main').name = 'Robot';
    const r = await h.request('PUT', '/api/v2/office/layout', { expectedRevision: 1, data });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.revision, 2); assert.equal(r.json.data.vm.layout.updatedBy.kind, 'human');
    assert.deepEqual(r.json.data.vm.revisions.map((x) => x.revision), [2, 1]);
    const stale = await h.request('PUT', '/api/v2/office/layout', { expectedRevision: 1, data });
    assert.equal(stale.status, 409); assert.equal(stale.json.error.current.revision, 2);
    assert.deepEqual(compareExample('layout-vm', { data: stale.json.error.current.vm, meta: vm.meta }, { envelope: true }), []);
    const office = (await h.get('/api/v2/views/office')).json.data;
    assert.equal(office.layoutRevision, 2);
    assert.equal(office.occupants.find((o) => o.id === 'main').name, 'Robot', 'the exact main rule names the occupant');
  });

  it('validation: structural (400 with the field) and semantic (the shared validator\'s issues, never its messages)', async () => {
    const dup = clone(vm.data.layout.data); dup.items.push(Object.assign({}, dup.items[0]));
    let r = await h.request('PUT', '/api/v2/office/layout', { expectedRevision: 2, data: dup });
    assert.equal(r.status, 400); assert.ok(r.json.error.details.some((d) => d.issue === 'duplicate-uid' && d.field === 'items.' + dup.items[0].uid));
    assert.ok(r.json.error.details.every((d) => Object.keys(d).every((k) => k === 'issue' || k === 'field')));
    const noMain = clone(vm.data.layout.data); noMain.agents = noMain.agents.filter((a) => a.agentId !== 'main');
    r = await h.request('PUT', '/api/v2/office/layout', { expectedRevision: 2, data: noMain });
    assert.equal(r.status, 400); assert.ok(r.json.error.details.some((d) => d.issue === 'no-main'));
    for (const [data, field] of [[null, 'data'], [Object.assign(clone(vm.data.layout.data), { version: 2 }), 'version'], [Object.assign(clone(vm.data.layout.data), { extra: 1 }), 'extra'],
      [Object.assign(clone(vm.data.layout.data), { theme: { mode: 'auto', nightFrom: '25:00' } }), 'theme']]) {
      r = await h.request('PUT', '/api/v2/office/layout', { expectedRevision: 2, data });
      assert.equal(r.status, 400, field); assert.equal(r.json.error.details[0].field, field);
    }
    r = await h.request('PUT', '/api/v2/office/layout', { data: vm.data.layout.data });
    assert.deepEqual(r.json.error.details, [{ field: 'expectedRevision', issue: 'required' }]);
  });

  it('theme toggle replaces only data.theme; revisions are readable; reset is a normal save of default.data', async () => {
    const r = await h.request('PUT', '/api/v2/office/layout/theme', { expectedRevision: 2, theme: { mode: 'fixed', fixed: 'night', season: null } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.data.vm.theme, { resolved: 'night', mode: 'fixed', nextChangeAt: null, season: null });
    assert.equal(r.json.data.vm.layout.data.agents.find((a) => a.agentId === 'main').name, 'Robot', 'nothing but the theme changed');
    const rev1 = await h.get('/api/v2/office/layout/revisions/1');
    assert.equal(rev1.status, 200); assert.deepEqual(rev1.json.data.data, vm.data.default.data);
    assert.equal((await h.get('/api/v2/office/layout/revisions/99')).status, 404);
    assert.equal((await h.get('/api/v2/office/layout/revisions/x')).status, 400);
    const reset = await h.request('PUT', '/api/v2/office/layout', { expectedRevision: 3, data: vm.data.default.data });
    assert.equal(reset.status, 200); assert.equal(reset.json.data.revision, 4);
  });

  it('prefs: GET defaults, PATCH validates; the agents seen inventory fills from the office view', async () => {
    assert.deepEqual((await h.get('/api/v2/prefs')).json.data, { uiTheme: 'system', locale: null });
    assert.equal((await h.request('PATCH', '/api/v2/prefs', { uiTheme: 'sombre' })).status, 400);
    assert.equal((await h.request('PATCH', '/api/v2/prefs', { other: 1 })).status, 400);
    const r = await h.request('PATCH', '/api/v2/prefs', { uiTheme: 'dark' });
    assert.deepEqual(r.json.data.result, { uiTheme: 'dark', locale: null });
    assert.deepEqual((await h.get('/api/v2/prefs')).json.data, { uiTheme: 'dark', locale: null });
    await h.get('/api/v2/views/office');
    const seen = (await h.get('/api/v2/office/layout')).json.data.agentsSeen;
    assert.ok(seen.some((x) => x.id === 'main' && x.role === 'main'));
  });

  it('every write is audited; the layout topic streams a change after a save', async () => {
    const A = openSse(h.base, '/api/v2/stream?topics=layout', { cookie: h.cookie });
    try {
      await A.next((f) => f.event === 'snapshot' && f.data.topic === 'layout');
      const cur = (await h.get('/api/v2/office/layout')).json.data;
      await h.request('PUT', '/api/v2/office/layout/theme', { expectedRevision: cur.layout.revision, theme: { mode: 'auto', day: 'day', night: 'night', nightFrom: '19:00', nightTo: '07:00', season: null } });
      await waitFor(() => A.frames.some((f) => (f.event === 'delta' || f.event === 'snapshot') && f.data.topic === 'layout' && f.data.rev > 1), { what: 'a layout change frame' });
    } finally { A.close(); }
    const db = new DatabaseSync(path.join(h.tmp, 'data', 'agent-office.sqlite'), { readOnly: true });
    const rows = db.prepare("SELECT command, outcome FROM audit_log WHERE command LIKE 'office.%' OR command = 'prefs.update'").all().map((x) => x.command + ':' + x.outcome);
    db.close();
    for (const x of ['office.saveLayout:ok', 'office.saveLayout:rejected', 'office.setTheme:ok', 'prefs.update:ok', 'prefs.update:rejected']) assert.ok(rows.includes(x), x);
  });
});

describe('S14b · read-only store', () => {
  let h;
  before(async () => { h = await startServer(sc, { env: { PORTAL_READONLY_STORE: '1' } }); });
  after(async () => { if (h) await h.stop(); });
  it('layout and prefs writes → 403 readonly; reads work', async () => {
    assert.equal((await h.get('/api/v2/office/layout')).status, 200);
    for (const [m, p, b] of [['PUT', '/api/v2/office/layout', { expectedRevision: 1, data: {} }], ['PUT', '/api/v2/office/layout/theme', { expectedRevision: 1, theme: {} }], ['PATCH', '/api/v2/prefs', { uiTheme: 'dark' }]]) {
      const r = await h.request(m, p, b); assert.equal(r.status, 403, p); assert.equal(r.json.error.code, 'readonly');
    }
  });
});

describe('S14b · theme resolution (instance time zone)', () => {
  const at = (iso) => Date.parse(iso);
  const auto = { mode: 'auto', day: 'day', night: 'night', nightFrom: '19:00', nightTo: '07:00', season: 'hiver' };
  it('day and night, a window wrapping midnight, the next change, fixed mode, season passthrough', () => {
    assert.deepEqual(resolveTheme(auto, at('2026-10-06T16:00:00Z'), 'America/Toronto'), { resolved: 'day', mode: 'auto', nextChangeAt: at('2026-10-06T23:00:00Z'), season: 'hiver' });   // 12:00 EDT
    assert.deepEqual(resolveTheme(auto, at('2026-10-07T02:30:00Z'), 'America/Toronto'), { resolved: 'night', mode: 'auto', nextChangeAt: at('2026-10-07T11:00:00Z'), season: 'hiver' });   // 22:30 EDT
    assert.equal(resolveTheme({ mode: 'auto', nightFrom: '01:00', nightTo: '05:00' }, at('2026-10-06T07:00:00Z'), 'America/Toronto').resolved, 'night');
    // ADR §12.7: the INSTANCE time zone, not a constant: Europe/Paris at 20:00 UTC is 22:00 → night
    assert.equal(resolveTheme(auto, at('2026-10-06T20:00:00Z'), 'Europe/Paris').resolved, 'night');
    assert.equal(resolveTheme(auto, at('2026-10-06T20:00:00Z'), 'America/Toronto').resolved, 'day', 'the same instant is 16:00 in Toronto');
    assert.equal(resolveTheme(auto, at('2026-10-06T16:00:00Z'), 'Europe/Paris').resolved, 'day');   // 03:00 EDT
    assert.deepEqual(resolveTheme({ mode: 'fixed', fixed: 'night' }, at('2026-10-06T16:00:00Z')), { resolved: 'night', mode: 'fixed', nextChangeAt: null, season: null });
  });
  it('structural check names the first bad field', () => {
    assert.equal(structural({ version: 1, manifestVersion: 2, room: 'r', theme: { mode: 'auto' }, items: [{ uid: 'a', asset: 'b' }], agents: [] }), 'items');
    assert.equal(structural({ version: 1, manifestVersion: 2, room: 'r', theme: { mode: 'auto' }, items: [], agents: [{ agentId: 'main', character: 'c', accessories: 'x' }] }), 'agents');
  });
});
