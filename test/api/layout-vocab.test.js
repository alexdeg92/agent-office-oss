'use strict';
/*
 * G5 · D4 completed (office-dev's dual vocabulary landed): every layout SAVE is normalised to the 3.0 rule names with
 * office-dev's own toVocabulary (layout-rules.js), and every read is served in the caller's contract version. The 2.x
 * wire stays as it was: names, the office's ruleId, agentsSeen.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

const stored = (h) => h.withStore((db) => JSON.parse(db.prepare('SELECT data_json FROM office_layouts WHERE active = 1').get().data_json));
const ids = (data) => data.agents.map((a) => [a.agentId, a.match && a.match.kind]);

describe('G5 · layouts are stored in 3.0 names and served per version', () => {
  let h, v2Before;
  before(async () => {
    h = await startServer(loadScenario('synthetic-basic'));
    v2Before = (await h.get('/api/v2/office/layout')).json.data;
  });
  after(async () => { if (h) await h.stop(); });

  it('a 2.x save is normalised to 3.0 names in the store; v2 still reads 2.x names, v3 reads 3.0', async () => {
    const data = JSON.parse(JSON.stringify(v2Before.layout.data));
    data.agents.find((a) => a.agentId === '*cron').variant = 'teal';
    const r = await h.request('PUT', '/api/v2/office/layout', { expectedRevision: v2Before.layout.revision, data });
    assert.equal(r.status, 200, r.text);
    const st = stored(h);
    assert.ok(ids(st).some(([id, k]) => id === 'primary' && k === 'primary') && ids(st).some(([id]) => id === '*scheduled'), JSON.stringify(ids(st)));
    assert.ok(!ids(st).some(([id]) => ['main', '*cron', '*dm', '*channel'].includes(id)), 'no 2.x name is stored');
    const v2 = (await h.get('/api/v2/office/layout')).json.data;
    assert.deepEqual(ids(v2.layout.data), ids(v2Before.layout.data), 'the 2.x wire keeps its names');
    assert.equal(v2.layout.data.agents.find((a) => a.agentId === '*cron').variant, 'teal');
    assert.deepEqual(v2.layout.data, data, 'a 2.x client reads back exactly what it saved');
    const v3 = (await h.get('/api/v3/office/layout')).json.data;
    assert.ok(ids(v3.layout.data).some(([id]) => id === '*scheduled'));
  });

  it('the office keeps 2.x rule ids on v2 and 3.0 ids on v3 over the normalised store', async () => {
    const o2 = (await h.get('/api/v2/views/office')).json.data, o3 = (await h.get('/api/v3/views/office')).json.data;
    assert.equal(o2.occupants[0].ruleId, 'main'); assert.equal(o3.occupants[0].ruleId, 'primary');
    for (const o of o2.occupants) assert.ok(o.ruleId == null || !/^(primary|\*scheduled|\*direct|\*group)$/.test(o.ruleId), o.ruleId);
  });

  it('a 3.0 save may add *conversation; v2 sees it under the name it has (no 2.x one)', async () => {
    const v3 = (await h.get('/api/v3/office/layout')).json.data;
    const data = JSON.parse(JSON.stringify(v3.layout.data));
    data.agents.push({ agentId: '*conversation', match: { kind: 'conversation' }, character: 'subagent', variant: 'sage', name: null, role: null, station: 'auto' });
    const r = await h.request('PUT', '/api/v3/office/layout', { expectedRevision: v3.layout.revision, data });
    assert.equal(r.status, 200, r.text);
    assert.ok(ids((await h.get('/api/v2/office/layout')).json.data.layout.data).some(([id]) => id === '*conversation'));
  });

  it('old durable 3.x/session and team-role seen rows are projected safely in both LayoutVM versions', async () => {
    const at = Date.now();
    h.withStore(db => {
      // Simulate rows written by older deployments before the current role
      // CHECK constraint; those durable rows must remain readable on rollback.
      db.exec('PRAGMA ignore_check_constraints=ON');
      const put = db.prepare(`INSERT OR REPLACE INTO office_agents_seen (occupant_id, role, name, last_seen_at, automatic_look_json)
        VALUES (?, ?, ?, ?, NULL)`);
      for (const [id, role, name] of [
        ['session:legacy-coding', 'session', 'Coding session'],
        ['conversation:legacy-chat', 'conversation', 'Conversation'],
        ['direct:legacy-peer', 'direct', 'discord-user:123456789012345678'],
        ['team-host:legacy-pm', 'team-host', 'Project lead'],
        ['team-member:legacy-builder', 'team-member', 'Builder'],
      ]) put.run(id, role, name, at);
    });
    const cached = await h.get('/api/v2/office/layout');
    const invalidated = await h.request('PUT', '/api/v2/office/layout', {
      expectedRevision: cached.json.data.layout.revision, data: cached.json.data.layout.data,
    });
    assert.equal(invalidated.status, 200, invalidated.text);
    const v2 = await h.get('/api/v2/office/layout');
    const v3 = await h.get('/api/v3/office/layout');
    assert.equal(v2.status, 200, v2.text);
    assert.equal(v3.status, 200, v3.text);
    const seen2 = v2.json.data.agentsSeen;
    const seen3 = v3.json.data.agentsSeen;
    assert.equal(seen2.find(row => row.name === 'Coding session')?.role, 'channel', JSON.stringify({ v2: seen2, v3: seen3 }));
    assert.equal(seen2.find(row => row.name === 'Conversation').role, 'channel');
    assert.equal(seen2.find(row => row.id === 'dm:legacy-peer').name, 'Conversation');
    assert.equal(seen3.find(row => row.id === 'direct:legacy-peer').name, 'Conversation');
    assert.equal(seen2.find(row => row.name === 'Project lead').role, 'agent');
    assert.equal(seen2.find(row => row.name === 'Builder').role, 'subagent');
    assert.equal(seen3.find(row => row.name === 'Project lead').role, 'agent');
    assert.equal(seen3.find(row => row.name === 'Builder').role, 'subagent');
  });
});
