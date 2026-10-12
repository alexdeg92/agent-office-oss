'use strict';
// agent-identity-1 (security-112, critic-164): the MOUNTED office route and stream apply the sessions read gate and
// redact summaries. Synthetic engine and loopback only; no runtime home, gateway or real transcript.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { mountV2 } = require('../../src/api/v2/routes');
const { createApp } = require('../../src/api/http');
const { openSse } = require('../helpers/sse-client');

const NOW = Date.now();
const SECRET = 'synthetic-secret-canary';
const TRANSCRIPT_FIELDS = ['summary', 'model', 'project', 'runtime', 'startedAt', 'lastActivityAt', 'tokensKnown', 'exchanges'];

function engineWithCanaries() {
  const adapter = { id: 'synthetic', name: 'Synthetic', schemas: {}, routes: {}, normalise: { session: row => ({ session: row }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) },
    classifySession: () => ({ kind: 'unrecognized' }), capabilities: () => ({ sessions: true }) };
  const e = createEngine({ adapter, now: () => NOW, primary: 'main' });
  const agents = [
    { id: 'main', name: 'Main', displayName: `Private title password=${SECRET}`, workspace: null, model: { primary: 'model-synthetic', provider: 'test' }, fallbackModels: [], isPrimary: true, mainSessionKey: 'synthetic:main' },
    { id: 'helper', name: 'Helper', displayName: null, summary: `Configured https://user:${SECRET}@example.test/x`, workspace: null, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: null },
  ];
  const run = { status: 'running', endReason: null, evidence: 'status-field', evidenceLevel: 'verified', observedAt: NOW, expiresAt: null, startedAt: NOW - 5000, endedAt: null, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null };
  const session = (key, agentId, kind, extra) => ({ key, sessionId: null, class: { kind, ruleId: 'synthetic', agentId, channel: null, heartbeatOf: null, background: false, rawClassification: null, ...(kind === 'explicit' ? { explicitKey: key } : {}) },
    displayName: null, summary: null, summarySource: null, projectLabel: 'synthetic-project', tokensKnown: true, model: { id: 'model-synthetic', provider: null }, provider: null,
    usage: { total: 42, input: null, output: null }, updatedAt: NOW, run, costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null, interactive: true, group: null, ...extra });
  assert.equal(e.ingestCanonical('agents', agents).ok, true);
  assert.equal(e.ingestCanonical('sessions.snapshot', [
    session('synthetic:main', 'main', 'primary', { summary: `Fix login https://user:${SECRET}@example.test/repo` }),
    session('synthetic:helper', 'helper', 'explicit', { summary: null, label: `Deploy with token=${SECRET}` }),
  ]).ok, true);
  e.setGatewayConnected(true);
  return e;
}

async function mounted(t, sessionsReadable) {
  const engine = engineWithCanaries();
  let api;
  const app = createApp({ apiOnly: true, mountRoutes: (a) => { api = mountV2(a, { engine, sessionsReadable, runtime: { commands: {}, refreshFlows: async () => {}, refreshSkills: async () => {} },
    auth: { onRevoke() {}, sessionOf: () => ({ sid: 'synthetic-viewer', email: 'viewer@example.test', exp: NOW + 600000 }) },
    cfg: { instance: 'test', capture: false, readonly: false, readonlyStore: false, agentNames: { helper: 'Helper' } } }); } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const streams = [];
  t.after(async () => { for (const s of streams) s.close?.(); api.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); engine.close?.(); });
  const get = async (path) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };
  const stream = (path) => { const s = openSse(base, path); streams.push(s); return s; };
  return { api, engine, get, stream };
}

const primaryOf = (vm) => vm.occupants.find(o => o.id === 'primary' || o.id === 'main');
function assertLimited(vm, where) {
  const text = JSON.stringify(vm);
  assert.ok(!text.includes(SECRET), where + ': no canary');
  assert.ok(!text.includes('Private title') && !text.includes('Fix login') && !text.includes('Deploy with'), where + ': no transcript-derived title or summary');
  for (const o of vm.occupants) {
    for (const f of TRANSCRIPT_FIELDS) assert.equal(o[f], undefined, `${where}: ${o.id}.${f}`);
    assert.equal(o.sessionKey, null, where + ': session key');
  }
  assert.deepEqual(vm.journal, [], where + ': journal');
  for (const id of ['runs', 'subagents', 'tokens']) assert.equal(vm.kpis.find(k => k.id === id)?.value ?? null, null, `${where}: kpi ${id}`);
  assert.equal(primaryOf(vm).name, 'Main', where + ': the non-transcript name');
}

for (const version of [2, 3]) {
  test(`v${version}: running without evidence stays unknown on the mounted production office path`, async (t) => {
    const h = await mounted(t, () => true);
    const main = h.engine.session('synthetic:main');
    assert.equal(h.engine.ingestCanonical('sessions.upsert', { ...main,
      run: { ...main.run, status: 'running', evidence: 'none', evidenceLevel: 'unknown', observedAt: null, expiresAt: null } }).ok, true);
    h.api.topics.invalidate('office');
    const response = await h.get(`/api/v${version}/views/office`);
    assert.equal(response.status, 200);
    const primary = primaryOf(response.body.data);
    assert.equal(primary.execution.status, 'unknown');
    assert.equal(primary.state, 'unknown');
    assert.equal(response.body.data.kpis.find(k => k.id === 'active').value, null);
  });

  test(`v${version}: a live transcript run is Working on the mounted production office path`, async (t) => {
    const h = await mounted(t, () => true);
    const main = h.engine.session('synthetic:main');
    assert.equal(h.engine.ingestCanonical('sessions.upsert', { ...main,
      run: { ...main.run, status: 'running', evidence: 'live-activity', evidenceLevel: 'observed', observedAt: NOW - 1000, expiresAt: NOW + 29000 } }).ok, true);
    h.api.topics.invalidate('office');
    const response = await h.get(`/api/v${version}/views/office`);
    assert.equal(response.status, 200);
    const primary = primaryOf(response.body.data);
    assert.equal(primary.state, 'working', 'live observed execution is not presented as Unknown or Activity observed');
    assert.equal(primary.execution.status, 'running');
    assert.deepEqual(primary.execution.evidence, { level: 'observed', observedAt: NOW - 1000, expiresAt: NOW + 29000 });
  });

  test(`v${version}: without the sessions read grant, HTTP and SSE office carry names and states only`, async (t) => {
    const h = await mounted(t, () => false);
    const r = await h.get(`/api/v${version}/views/office`);
    assert.equal(r.status, 200);
    assert.equal(r.body.meta?.topic?.id ?? 'office', 'office', 'the wire topic stays `office`');
    assertLimited(r.body.data, 'HTTP');

    const s = h.stream(`/api/v${version}/stream?topics=office`);
    const snap = await s.next(f => f.event === 'snapshot' && f.data.topic === 'office');
    assertLimited(snap.data.data, 'SSE snapshot');
    // a later change reaches the stream through the same limited projection; session cues never do
    h.api.hubs[version].broadcastOffice({ type: 'cue', occupantId: 'primary', cue: 'talking', at: NOW, signal: { id: 'le_synthetic', kind: 'activity', at: NOW, count: 1 } });
    assert.equal(h.engine.ingestCanonical('sessions.upsert', { ...h.engine.session('synthetic:main'), summary: `Second ${SECRET}`,
      run: { ...h.engine.session('synthetic:main').run, status: 'failed', endReason: 'error', endedAt: NOW } }).ok, true);
    h.api.topics.invalidate('office');
    const later = await s.next(f => f !== snap && (f.event === 'delta' || f.event === 'snapshot') && f.data.topic === 'office');
    assert.ok(!JSON.stringify(later.data).includes(SECRET), 'SSE change: no canary');
    assert.ok(!s.frames.some(f => f.event === 'cue'), 'no session cue frames');
    // asking for the limited view explicitly is allowed; any other view value is not a topic
    assert.equal((await h.get(`/api/v${version}/views/office`)).body.data.occupants.length, r.body.data.occupants.length);
    assert.throws(() => h.api.topics.current('office?view=full', version), { code: 'not_found' });
  });

  test(`v${version}: with the sessions read grant, OfficeVM omits transcript summaries on HTTP and SSE`, async (t) => {
    const h = await mounted(t, () => true);
    const r = await h.get(`/api/v${version}/views/office`);
    assert.equal(r.status, 200);
    const text = JSON.stringify(r.body.data);
    assert.ok(!text.includes(SECRET) && !text.includes('user:'), 'HTTP: canaries redacted');
    const main = primaryOf(r.body.data);
    assert.equal(main.summary, undefined);
    assert.equal(main.name, 'Main');
    const helper = r.body.data.occupants.find(o => /helper/.test(o.id));
    assert.equal(helper.summary, undefined);
    assert.ok(!text.includes('Fix login') && !text.includes('Deploy with') && !text.includes('Private title'));

    const s = h.stream(`/api/v${version}/stream?topics=office`);
    const snap = await s.next(f => f.event === 'snapshot' && f.data.topic === 'office');
    assert.ok(!JSON.stringify(snap.data).includes(SECRET), 'SSE: canaries redacted');
    assert.equal(primaryOf(snap.data.data).summary, undefined);
    assert.ok(!JSON.stringify(snap.data).includes('Fix login'));
    h.api.hubs[version].broadcastOffice({ type: 'cue', occupantId: 'primary', cue: 'talking', at: NOW, signal: { id: 'le_synthetic', kind: 'activity', at: NOW, count: 1 } });
    await s.next(f => f.event === 'cue');
  });
}

test('the default policy fails closed for a machine principal or a missing session', () => {
  const { officeTopicFor, OFFICE_LIMITED } = require('../../src/api/v2/views');
  const owner = ({ session, principal }) => !principal && !!session;
  assert.equal(officeTopicFor({ session: { sid: 's' } }, owner), 'office');
  assert.equal(officeTopicFor({ session: null }, owner), OFFICE_LIMITED);
  assert.equal(officeTopicFor({ session: { sid: 's' }, principal: { kind: 'agent' } }, owner), OFFICE_LIMITED);
  assert.equal(officeTopicFor({ session: null }, owner, 'flows'), 'flows', 'other topics are untouched');
});
