'use strict';
// Prod outage 2026-10-12: a coding-agent session stored in office_agents_seen with role 'conversation'
// made the v2 LayoutVM fail its schema (enum main|agent|subagent|cron|dm|channel), so the Bureau never loaded.
// The v2 layout must serve it as 'channel', like the v2 OfficeVM does.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

describe('LayoutVM agentsSeen · a stored conversation occupant', () => {
  let h;
  const id = 'conversation:rt:codex:session:c3ludGhldGlj';
  before(async () => {
    h = await startServer(loadScenario('synthetic-basic'));
    h.withStore((db) => db.prepare('INSERT INTO office_agents_seen (occupant_id, role, name, last_seen_at) VALUES (?, ?, ?, ?)')
      .run(id, 'conversation', 'Session synthétique', Date.now()));
  });
  after(async () => { if (h) await h.stop(); });

  it('v2 serves it as channel and the layout is valid', async () => {
    const res = await h.get('/api/v2/office/layout');
    assert.equal(res.status, 200, JSON.stringify(res.json && res.json.error));
    const seen = res.json.data.agentsSeen.find((x) => x.id.endsWith(':rt:codex:session:c3ludGhldGlj'));
    assert.ok(seen, 'the conversation occupant is listed');
    assert.equal(seen.role, 'channel');
  });

  it('v3 keeps the canonical conversation role', async () => {
    const res = await h.get('/api/v3/office/layout');
    assert.equal(res.status, 200, JSON.stringify(res.json && res.json.error));
    const seen = res.json.data.agentsSeen.find((x) => x.id === id);
    assert.ok(seen, 'the conversation occupant is listed');
    assert.equal(seen.role, 'conversation');
  });
});
