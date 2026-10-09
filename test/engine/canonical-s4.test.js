'use strict';
/*
 * S4: canonical output for agents, cron jobs/runs, skills (+details), channels, transcripts, config
 * and health is pinned per scenario, checked against independent invariants, and a corrupted
 * normaliser is proven to fail these checks (same discipline as R2-09 for sessions).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createEngine } = require('../../src/engine');
const { normaliseCronJobs } = require('../../src/adapters/openclaw/normalise/cron');
const { normaliseSkills } = require('../../src/adapters/openclaw/normalise/skill');
const { listScenarios, loadScenario, skipUnlessLocal } = require('../helpers/scenario');
const { feed } = require('../helpers/feed');
const { matchGolden, GOLDEN_DIR } = require('../helpers/golden');

function snapshot(e, sc) {
  const runs = Object.fromEntries(Object.keys((sc.rpc['cron.runs'] || {}).files || {}).map((id) => [id, (e.cronRuns(id) || { runs: null }).runs]));
  const infos = Object.fromEntries(Object.keys((sc.cli && sc.cli['skills.info']) || {}).map((n) => [n, e.skillInfo(n)]));
  const transcripts = Object.fromEntries(Object.keys((sc.rpc['sessions.get'] || {}).files || {}).map((k) => [k, e.transcript(k)]));
  const value = JSON.parse(JSON.stringify({ agents: e.agents(), cronJobs: e.cronJobs(), cronRuns: runs, skills: e.skills(), skillInfo: infos,
    channels: e.channels(), transcripts, config: e.config() }));
  // These legacy scenarios have instance-specific agent names. Keep newly added sender fields neutral in goldens;
  // the sender conformance and HTTP suites assert the actual configured names using generic synthetic fixtures.
  const neutral = (p) => p && p.kind === 'agent' && p.name ? { ...p, name: '<configured agent>' } : p;
  for (const t of Object.values(value.transcripts)) if (t) {
    t.participants = t.participants?.map(neutral) || null;
    for (const event of t.events) {
      if (event.kind === 'user' && event.senderInfo?.kind === 'agent' && event.senderInfo.name) event.sender = '<configured agent>';
      event.senderInfo = neutral(event.senderInfo);
    }
  }
  return value;
}

// Written from data-model.md, not from the normalisers.
function invariantViolations(x) {
  const out = []; const bad = (why) => out.push(why);
  if (x.agents.filter((a) => a.isPrimary).length > 1) bad('more than one primary agent');
  for (const j of x.cronJobs) {
    if (!['cron', 'every', 'at', 'unrecognized'].includes(j.schedule.kind)) bad(`${j.id}: schedule kind`);
    if (j.schedule.kind === 'cron' && typeof j.schedule.expr !== 'string') bad(`${j.id}: cron without expr`);
    if (j.health === 'failing' && j.lastRunStatus !== 'failed') bad(`${j.id}: failing without a failed last run`);
    if (j.payload && j.payload.kind !== 'agent-turn' && j.steps.length) bad(`${j.id}: steps without an agent-turn`);
  }
  for (const [id, runs] of Object.entries(x.cronRuns)) for (let i = 1; runs && i < runs.length; i++) if (runs[i - 1].at < runs[i].at) bad(`${id}: runs not newest first`);
  for (const s of x.skills) if ((s.status === 'disabled') === false && s.status === 'active' && s.missing && s.missing.bins.length) bad(`${s.name}: active with missing bins`);
  for (const c of x.channels) {
    if (c.health === 'not-configured' && c.configured) bad(`${c.rawId}: not-configured but configured`);
    if (c.id === 'wechat' && !['wechat', 'openclaw-weixin', 'weixin'].includes(c.rawId)) bad(`${c.rawId}: wechat alias`);
  }
  for (const [k, t] of Object.entries(x.transcripts)) {
    if (!t) continue;
    if (t.window.to !== t.messageCount || t.window.from > t.window.to) bad(`${k}: window`);
    // order = transcript (sequence) order, NOT timestamp order: real transcripts step back in time
    // (capture-20261005: a system message stamped 34 s after the user message that follows it)
    if (t.events.some((ev) => ev.kind === 'tool' && ev.durationMs !== null && ev.durationMs < 0)) bad(`${k}: negative tool duration`);
  }
  if (x.config && JSON.stringify(x.config).includes('token') && !JSON.stringify(x.config).includes('"token":"[secret]"')) bad('config token not a Secret');
  return out;
}

const goldenOf = (sc) => JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, 'engine-canonical', sc.name, 'canonical.json'), 'utf8'));
const differs = (sc, x) => { try { assert.deepStrictEqual(x, goldenOf(sc)); return false; } catch (_) { return true; } };

for (const sc of listScenarios()) {
  describe(`canonical S4 types · ${sc.name}`, () => {
    const e = feed(createEngine({ now: () => sc.now }), sc);
    const x = snapshot(e, sc);
    it('full canonical output matches golden', () => matchGolden('engine-canonical', sc.name, 'canonical', x));
    it('independent invariants hold', () => assert.deepEqual(invariantViolations(x), []));
    it('nothing failed the canonical contracts', () => {
      assert.deepEqual(e.quarantine.list().filter((i) => i.path && i.path.startsWith('$.canonical')).map((i) => `${i.path} ${i.detail}`), []);
    });
    it('a corrupted normaliser is caught (golden), a contract-breaking one is refused (contract)', () => {
      const wrongNames = feed(createEngine({ now: () => sc.now, overrides: { cronJobs: (v, i) => normaliseCronJobs(v, i).map((j) => Object.assign(j, { name: 'wrong' })) } }), sc);
      assert.equal(differs(sc, snapshot(wrongNames, sc)), true);
      const broken = createEngine({ now: () => sc.now, overrides: { skills: (v, i) => normaliseSkills(v, i).map((s) => Object.assign(s, { status: 'bogus' })) } });
      feed(broken, sc);
      assert.equal(broken.skills().length, 0);
      assert.ok(broken.quarantine.list().some((i) => i.path === '$.canonical.skill.status'));
    });
  });
}

describe('S4 engine behaviour', () => {
  const NOW = Date.UTC(2026, 9, 5);
  const env = (channel, value, extra) => Object.assign({ source: channel.split('.')[0] === 'config' ? 'config' : 'gateway', channel, receivedAt: NOW, body: { kind: 'json', value } }, extra);

  it('config: only the projection is kept; the token is a Secret that never serialises', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(env('config.openclaw', { gateway: { auth: { token: 'GW-SECRET-123' } }, channels: { discord: { token: 'BOT-SECRET-456', dmPolicy: 'pairing', guilds: { 1: { channels: { 100000000000000002: { enabled: true, requireMention: false } } } } } } }));
    const c = e.config();
    assert.equal(c.discord.token.reveal(), 'BOT-SECRET-456');
    const everything = JSON.stringify([c, e.latest('config.openclaw'), e.dataQuality(), e.health()]);
    assert.ok(!everything.includes('SECRET'), everything.slice(0, 300));
    assert.deepEqual(c.discord.channels, { 100000000000000002: { enabled: true, requireMention: false } });
  });

  it("'change' fires only for real changes (no traffic when a refresh brings nothing new)", () => {
    const e = createEngine({ now: () => NOW });
    let n = 0; e.on('change', () => n++);
    const agents = { agents: [{ id: 'main', name: 'Timmy' }] };
    e.ingest(env('gw.rpc.agents.list', agents)); e.ingest(env('gw.rpc.agents.list', agents)); e.ingest(env('gw.rpc.agents.list', agents));
    assert.equal(n, 1);
    e.ingest(env('gw.rpc.agents.list', { agents: [{ id: 'main', name: 'Timmy 2' }] }));
    assert.equal(n, 2);
  });

  it('gateway connection: state, freshness and LiveEvents', () => {
    const e = createEngine({ now: () => NOW });
    e.setGatewayConnected(true); e.setGatewayConnected(true); e.setGatewayConnected(false);
    assert.equal(e.gateway().connected, false);
    assert.equal(e.sources().find((s) => s.id === 'gateway').state, 'down');
    assert.deepEqual(e.liveEvents().map((l) => l.kind), ['gateway.disconnected', 'gateway.connected']);
    assert.equal(e.health().gateway.connected, false); assert.equal(e.health().level, 'alert');
  });

  it('a normaliser that throws is quarantined, never thrown', () => {
    const e = createEngine({ now: () => NOW, overrides: { agents: () => { throw new Error('boom'); } } });
    assert.doesNotThrow(() => e.ingest(env('gw.rpc.agents.list', { agents: [{ id: 'main' }] })));
    assert.ok(e.quarantine.list().some((i) => i.code === 'shape.invalid' && i.path === '$.canonical' && i.channel === 'gw.rpc.agents.list'));
  });

  it('health snapshot from a real capture: host, gateway, cron counts, sources', skipUnlessLocal('capture-20261005-active'), () => {
    const sc = loadScenario('capture-20261005-active');
    const e = feed(createEngine({ now: () => sc.now }), sc);
    e.ingest({ source: 'host', channel: 'host.metrics', receivedAt: sc.now, body: { kind: 'json', value: { cpuPct: 90, load1: 3.6, ncpu: 4, memUsed: 8e9, memTotal: 16e9, disk: { total: 100, used: 95 }, uptimeSec: 10, host: 'h' } } });
    e.setGatewayConnected(true);
    const h = e.health();
    assert.equal(h.cron.total, 10); assert.equal(h.host.disk.pct, 95); assert.equal(h.level, 'alert');
    assert.ok(h.sources.some((s) => s.id === 'gateway'));
  });
});
