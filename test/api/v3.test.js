'use strict';
/*
 * G5 · /api/v3 served (api-v3.md): every view matches its 3.0 example, speaks only the 3.0 vocabularies and carries no
 * personal value; inbound values are per version; each version has its own stream; flows take agentId; layouts are
 * read and written in 3.0 names; the agent token works on v3. /api/v2's byte-identity is proven separately (report).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadScenario } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');
const { compareExample } = require('../helpers/contract-shape');
const { openSse } = require('../helpers/sse-client');
const { createTokensRepo } = require('../../src/store/repos/tokens');
const { TOKENS } = require('../portability/personal-literals');

const ENV = { AO_TIME_ZONE: 'Europe/Paris', TZ: 'Europe/Paris', AO_LOCALE: 'en', PORTAL_DISPLAY_NAME: 'Camille', AO_PROJECTS_OWNERS: 'acme-labs' };
const TG = 'agent:atlas:telegram:direct:foreign-user';
const walkValues = (v, at, out, pred) => {
  if (Array.isArray(v)) v.forEach((x, i) => walkValues(x, `${at}[${i}]`, out, pred));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walkValues(x, `${at}.${k}`, out, pred);
  else if (pred(v, at)) out.push(at);
  return out;
};

describe('G5 · /api/v3 on a foreign instance', () => {
  let h; const seen = [];
  const get = async (p) => { const r = await h.get(p); assert.equal(r.status, 200, `${p}: ${r.text}`); seen.push([p, r.json]); return r.json.data; };
  before(async () => { h = await startServer(loadScenario('foreign-instance'), { env: ENV }); });
  after(async () => { if (h) await h.stop(); });

  it('every view matches its 3.0 example (or the unchanged 2.x one)', async () => {
    const flows = await get('/api/v3/views/flows');
    const sweep = flows.flows.find((f) => f.name === 'Inbox sweep');
    const cases = [['meta-vm', '/api/v3/meta'], ['office-vm', '/api/v3/views/office'], ['logs-page', '/api/v3/views/logs'],
      ['session-vm', '/api/v3/views/sessions/' + encodeURIComponent(TG)], ['access-vm', '/api/v3/views/access'],
      ['interlocutor-vm', '/api/v3/views/interlocutors/' + encodeURIComponent('telegram-user:foreign-user')], ['health-vm', '/api/v3/views/health'],
      ['flow-list-vm', '/api/v3/views/flows'], ['flow-detail-vm', '/api/v3/views/flows/' + encodeURIComponent(sweep.id)], ['skill-list-vm', '/api/v3/views/skills'],
      ['board-vm', '/api/v3/views/projects?filter=with-agent'], ['layout-vm', '/api/v3/office/layout']];
    for (const [ex, p] of cases) assert.deepEqual(compareExample(ex, await get(p), { version: 3 }).filter((m) => !/^\$\.manifest/.test(m)), [], `${ex} ${p}`);
  });

  it('3.0 vocabularies: ids, roles, kinds, channels, interlocutors, flows, board, labels', async () => {
    const meta = await get('/api/v3/meta');
    assert.deepEqual([meta.apiVersion, meta.contractVersion, meta.instance.locale, meta.runtime.capabilities.flows.multiAgent], [3, '3.5', 'en', true]);
    assert.ok(!('channel' in meta.enums) && meta.enums.sessionKind.includes('internal'));
    assert.equal(meta.labels['sessionKind.main'], undefined); assert.ok(meta.labels['sessionKind.primary']);
    assert.equal(meta.labels['channel.telegram'], 'Telegram', 'the adapter\'s channel label, as data');
    assert.equal(meta.labels['provider.acme-llm'], 'acme-llm', 'an unknown provider labels as its raw value');
    assert.equal(meta.labels['agent.atlas'], 'Atlas');
    const office = await get('/api/v3/views/office');
    assert.deepEqual([office.occupants[0].id, office.occupants[0].role, office.occupants[0].roleLabel.key], ['primary', 'primary', 'occupantRole.primary']);
    assert.ok(office.occupants.some((o) => o.role === 'direct' && o.id.startsWith('direct:')), 'the Telegram conversation is in the office');
    const logs = await get('/api/v3/views/logs?limit=200');
    const tg = logs.items.find((x) => x.id === TG);
    assert.deepEqual([tg.kind, tg.runtimeKind, tg.channel], ['conversation-direct', null, 'telegram']);
    assert.ok(logs.items.every((x) => x.channel !== 'unrecognized'));
    const access = await get('/api/v3/views/access');
    assert.deepEqual(access.interlocutors.map((i) => [i.id, i.kind, i.channel, i.resolution]).sort(),
      [['matrix-room:!ops:example.org', 'room', 'matrix', 'unresolvable'], ['slack-room:C0ACME', 'room', 'slack', 'unresolvable'], ['telegram-user:foreign-user', 'user', 'telegram', 'unresolvable']]);
    assert.ok(access.interlocutors.every((i) => i.access.policy === null), 'no Discord policy leaks onto another channel');
    const health = await get('/api/v3/views/health');
    assert.deepEqual(health.channels.map((c) => c.id), ['telegram', 'slack', 'matrix']);
    const sweep = (await get('/api/v3/views/flows')).flows.find((f) => f.name === 'Inbox sweep');
    const job = (await get('/api/v3/views/flows/' + encodeURIComponent(sweep.id))).job;
    assert.deepEqual([job.agentId, job.ext.openclaw.sessionTarget, 'sessionTarget' in job], ['atlas', 'isolated', false]);
    const board = await get('/api/v3/views/projects?filter=with-agent');
    assert.deepEqual([board.filter, board.agent], ['with-agent', 'atlas']);
  });

  it('inbound values are per version: kinds, filters, the agent param', async () => {
    assert.equal((await get('/api/v3/views/logs?kind=internal')).items.map((x) => x.runtimeKind).join(), 'explicit');
    for (const [p, field] of [['/api/v3/views/logs?kind=chat-direct', 'kind'], ['/api/v2/views/logs?kind=internal', 'kind'], ['/api/v3/views/projects?filter=with-timmy', 'filter'],
      ['/api/v3/views/projects?filter=with-agent&agent=scribe', 'agent'], ['/api/v2/views/projects?filter=with-timmy&agent=atlas', 'agent']]) {
      const r = await h.get(p);
      assert.equal(r.status, 400, p); assert.equal(r.json.error.details[0].field, field, p);
    }
    assert.equal((await h.get('/api/v2/views/projects?filter=with-timmy')).status, 200, '2.x keeps its alias');
    assert.equal((await h.get('/api/v3/views/interlocutors/' + encodeURIComponent('telegram-user:foreign-user'))).status, 200);
    assert.equal((await h.get('/api/v2/views/interlocutors/' + encodeURIComponent('telegram-user:foreign-user'))).status, 404, '2.x shows Discord interlocutors only');
  });

  it('each version has its own stream: hello says the contract, and the same topic carries that version\'s VM', async () => {
    const s3 = openSse(h.base, '/api/v3/stream?topics=office', { cookie: h.cookie });
    const s2 = openSse(h.base, '/api/v2/stream?topics=office', { cookie: h.cookie });
    try {
      const hello3 = await s3.next((e) => e.event === 'hello'), hello2 = await s2.next((e) => e.event === 'hello');
      assert.equal(hello3.data.contractVersion, '3.5'); assert.equal(hello2.data.contractVersion, '2.8');
      const o3 = await s3.next((e) => e.data && e.data.topic === 'office'), o2 = await s2.next((e) => e.data && e.data.topic === 'office');
      assert.equal(o3.data.data.occupants[0].id, 'primary'); assert.equal(o2.data.data.occupants[0].id, 'main');
    } finally { s3.close(); s2.close(); }
  });

  it('flows: 3.0 may name the agent (multiAgent); 2.x may not; an unknown agent is refused', async () => {
    const body = { name: 'Notes', cron: '0 8 * * *', tz: 'Europe/Paris', message: 'Write the notes.' };
    const r = await h.request('POST', '/api/v3/flows', Object.assign({ agentId: 'scribe' }, body));
    assert.equal(r.status, 200, r.text);
    assert.ok(h.cliCalls().filter((a) => a[0] === 'cron' && a[1] === 'add').pop().includes('--agent=scribe'));
    assert.deepEqual((await h.request('POST', '/api/v3/flows', Object.assign({ agentId: 'nobody' }, body))).json.error.details, [{ field: 'agentId', issue: 'unknown-agent' }]);
    assert.deepEqual((await h.request('POST', '/api/v2/flows', Object.assign({ agentId: 'scribe' }, body))).json.error.details, [{ field: 'agentId', issue: 'unexpected-field' }]);
  });

  it('layout: read and written in 3.0 names on v3, still 2.x on v2', async () => {
    const l3 = await get('/api/v3/office/layout');
    assert.ok(l3.layout.data.agents.some((a) => a.agentId === 'primary' && a.match.kind === 'primary'));
    assert.ok(!JSON.stringify(l3.layout.data.agents).includes('"main"'));
    const data = JSON.parse(JSON.stringify(l3.layout.data));
    data.agents.find((a) => a.agentId === '*scheduled').variant = 'teal';
    const put = await h.request('PUT', '/api/v3/office/layout', { expectedRevision: l3.layout.revision, data });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.data.vm.layout.data.agents.find((a) => a.agentId === '*scheduled').variant, 'teal');
    const l2 = await get('/api/v2/office/layout');
    assert.equal(l2.layout.data.agents.find((a) => a.agentId === '*cron').variant, 'teal', 'stored once, served per version');
    // office-dev's dual vocabulary landed: a 3.0-only rule is accepted (test/api/layout-vocab.test.js covers storage)
    data.agents.push({ agentId: '*conversation', match: { kind: 'conversation' }, character: 'subagent', variant: null, name: null, role: null, station: 'auto' });
    assert.equal((await h.request('PUT', '/api/v3/office/layout', { expectedRevision: l2.layout.revision, data })).status, 200);
  });

  it('the agent token works on v3 paths (an atlas token passes the gate; a stranger is out of scope)', async () => {
    const atlas = h.withStore((db) => createTokensRepo(db).create({ agentId: 'atlas' }).token);   // busy timeout: deterministic under load
    const r = await fetch(h.base + '/api/v3/projects/prj_doesnotexist000/status', { method: 'PUT', headers: { authorization: 'Bearer ' + atlas, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, status: 'todo' }) });
    assert.equal(r.status, 404);
    const meta = await fetch(h.base + '/api/v3/meta', { headers: { authorization: 'Bearer ' + atlas } });
    assert.equal(meta.status, 403, 'outside the allowlist on v3 too');
  });

  it('no 3.0 response carries a personal value or a 2.x alias', async () => {
    for (const [p, json] of seen.filter(([q]) => q.startsWith('/api/v3/'))) {
      const data = p === '/api/v3/meta' ? Object.assign({}, json.data, { labels: null }) : json.data;
      const text = JSON.stringify(data);
      for (const t of TOKENS) assert.ok(!text.includes(t), `${p}: ${t}`);
      assert.deepEqual(walkValues(data, '$', [], (v, at) => (v === 'main' || v === 'with-timmy' || v === 'unrecognized' && /channel/.test(at)) && !/^\$\.manifest/.test(at)), [], p);
    }
  });
});

describe('G5 · /api/v3 on the home-instance scenario', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('synthetic-basic')); });
  after(async () => { if (h) await h.stop(); });
  it('internal sessions carry their runtimeKind; Discord interlocutors are user/room on discord; WeChat is a ChannelRef', async () => {
    const logs = (await h.get('/api/v3/views/logs?limit=200&heartbeat=include')).json.data.items;
    assert.deepEqual([...new Set(logs.filter((x) => x.kind === 'internal').map((x) => x.runtimeKind))].sort(), ['acp', 'dashboard', 'explicit']);
    assert.ok(logs.some((x) => x.kind === 'primary') && !logs.some((x) => ['main', 'cron', 'chat-direct', 'chat-group'].includes(x.kind)));
    const access = (await h.get('/api/v3/views/access')).json.data;
    assert.deepEqual(access.interlocutors.map((i) => [i.kind, i.channel]).sort(), [['room', 'discord'], ['room', 'wechat'], ['user', 'discord']]);
    const health = (await h.get('/api/v3/views/health')).json.data;
    assert.ok(health.channels.some((c) => c.id === 'wechat') && !health.channels.some((c) => c.id.startsWith('raw:')));
    await waitFor(async () => (await h.get('/api/v3/views/office')).json.data.occupants[0].id === 'primary', { what: 'the v3 office' });
  });
});
