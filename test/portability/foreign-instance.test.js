'use strict';
/*
 * ADR-001 §6.1 / §12.8 (G3b): the whole real path on a FOREIGN instance. The committed synthetic `foreign-instance`
 * scenario has a primary `atlas` (no agent named main), Telegram/Slack/Matrix (no Discord, so no enricher), an unknown
 * provider `acme-llm`, owner Camille, locale en, Europe/Paris. Same people as test/projects/foreign-instance.test.js.
 * Runs: fixtures → openclaw adapter → engine → SQL store and projects → v2 VMs over HTTP → SSE.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadScenario } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');
const { openSse } = require('../helpers/sse-client');
const { createTokensRepo } = require('../../src/store/repos/tokens');

const sc = loadScenario('foreign-instance');
const ENV = { AO_TIME_ZONE: 'Europe/Paris', TZ: 'Europe/Paris', AO_LOCALE: 'en', PORTAL_DISPLAY_NAME: 'Camille', AO_PROJECTS_OWNERS: 'acme-labs' };
// Words of Owner's instance that must never reach a foreign one
const { TOKENS } = require('./personal-literals');
const PERSONAL = new RegExp(TOKENS.map((t) => t.replace(/[/.]/g, '\\$&')).join('|'));
// §12.6: 'main' may appear ONLY in the listed 2.x alias fields; these paths are where each alias is allowed
// occupants[].ruleId: the shipped default layout names its primary rule 'main' until layout-rules takes both vocabularies
// (office-dev, §12.6)
// LayoutVM: the layout's primary rule key and role ('main' ≡ 'primary'), the manifest's character roles and agentsSeen
// carry the 2.x occupant vocabulary until layout-rules accepts both (office-dev, §12.6)
const MAIN_ALIASES = [/^\$\.(layout|default)\.data\.agents\[\d+\]\.(agentId|match\.kind)$/, /^\$\.manifest\.characters\[\d+\]\.role$/, /^\$\.agentsSeen\[\d+\]\.(id|role)$/,
  /^\$\.occupants\[\d+\]\.(id|role|ruleId)$/, /^\$\.items\[\d+\]\.kind$/, /^\$\.kind$/, /^\$\.journal\[\d+\]\.occupantId$/, /^\$\.(rows|occupants)\[\d+\]\.roleLabel\.key$/];
function mainOutsideAliases(value, at = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => mainOutsideAliases(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) mainOutsideAliases(v, `${at}.${k}`, out);
  else if (value === 'main' && !MAIN_ALIASES.some((re) => re.test(at))) out.push(at);
  return out;
}

describe('portability · a foreign instance end to end (ADR-001 §12.8)', () => {
  let h; const seen = [];
  const get = async (p) => { const r = await h.get(p); assert.equal(r.status, 200, `${p}: ${r.text}`); seen.push([p, r.json]); return r.json.data; };
  before(async () => { h = await startServer(sc, { env: ENV }); });
  after(async () => { if (h) await h.stop(); });

  it('ingestion: no error or warn data-quality issue; every session classified on its own channel', async () => {
    const health = await get('/api/v2/views/health');
    assert.deepEqual(health.dataQuality.issues.filter((i) => i.severity !== 'info').map((i) => i.code), []);
    const logs = await get('/api/v2/views/logs?limit=200&heartbeat=include');
    assert.equal(logs.items.length, 7);
    assert.deepEqual(logs.items.filter((x) => x.kind === 'unrecognized'), [], 'no unrecognized kind');
    // 2.x has no telegram/slack/matrix ChannelId: they project to 'unrecognized' (the 3.0 wire has the slug).
    // Unknown people get a localized User title without an opaque ID suffix, consistently across channels.
    const tg = logs.items.find((x) => x.id === 'agent:atlas:telegram:direct:foreign-user');
    assert.deepEqual([tg.kind, tg.channel, tg.title], ['chat-direct', 'unrecognized', { key: 'sessionTitle.user', params: { id: '' } }]);
  });

  it('meta: Atlas is the primary; the instance time zone and locale are the configured ones', async () => {
    const meta = await get('/api/v2/meta');
    assert.deepEqual(meta.primaryAgent, { id: 'atlas', name: 'Atlas', avatarUrl: null });
    assert.deepEqual(meta.instance, { timeZone: 'Europe/Paris', locale: 'en', configured: true });
    assert.equal(meta.locale, 'en', 'no saved preference, no browser language → the instance locale');
  });

  it('office: Atlas is the primary occupant; the Telegram and Slack conversations are present; Paris night theme', async () => {
    const office = await get('/api/v2/views/office');
    const primary = office.occupants[0];
    assert.deepEqual([primary.id, primary.role], ['main', 'main'], 'the listed 2.x wire aliases (§12.6)');
    assert.equal(primary.name, 'Atlas');
    const keys = office.occupants.map((o) => o.sessionKey);
    assert.ok(keys.includes('agent:atlas:telegram:direct:foreign-user') && keys.includes('agent:scribe:slack:channel:C0ACME'), JSON.stringify(keys));
    const layout = await get('/api/v2/office/layout');
    assert.equal(layout.theme.resolved, 'night', 'NOW is 21:00 in Paris (15:00 in Toronto)');
  });

  it('flows: a job without an agent runs on Atlas, not "main"', async () => {
    const flows = await get('/api/v2/views/flows');
    const sweep = flows.flows.find((f) => f.name === 'Inbox sweep');
    assert.equal((await get('/api/v2/views/flows/' + encodeURIComponent(sweep.id))).job.agentId, 'atlas');
  });

  it('chat and the project summary turn run on --agent=atlas, in the instance language', async () => {
    const r = await h.request('POST', '/api/v2/chat/messages', { text: 'Hello' });
    assert.equal(r.status, 202, r.text);
    await waitFor(async () => (await h.get('/api/v2/views/chat')).json.data.turnPending === null, { what: 'the chat turn' });
    assert.ok(h.cliCalls().find((a) => a[0] === 'agent').includes('--agent=atlas'));
    const p = await h.request('POST', '/api/v2/projects', { name: 'Ledger', status: 'in-progress', priority: 'P2', summary: '' });
    assert.equal(p.status, 200, p.text);
    const id = p.json.data.vm.id;
    const g = await h.request('POST', `/api/v2/projects/${id}/summary/regenerate`, { expectedRevision: p.json.data.vm.revision });
    assert.ok([200, 202].includes(g.status), g.text);
    await waitFor(() => h.cliCalls().filter((a) => a[0] === 'agent').length >= 2, { what: 'the summary turn' });
    const turn = h.cliCalls().filter((a) => a[0] === 'agent').pop();
    assert.ok(turn.includes('--agent=atlas'), JSON.stringify(turn));
    const message = turn.find((a) => a.startsWith('--message='));
    assert.doesNotMatch(message, /français/, 'an English instance asks for an English summary');
  });

  it('the agent token principal is the resolver primary: an atlas token passes the gate, a main token is out of scope', async () => {
    // the server's store, opened with a busy timeout (h.withStore): deterministic under load
    const { atlas, main } = h.withStore((db) => { const t = createTokensRepo(db); return { atlas: t.create({ agentId: 'atlas' }).token, main: t.create({ agentId: 'main' }).token }; });
    const put = (token) => fetch(h.base + '/api/v2/projects/prj_doesnotexist000/status', { method: 'PUT',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, status: 'paused' }) });
    assert.equal((await put(atlas)).status, 404, 'atlas: through the gate (unknown project)');
    assert.equal((await put(main)).status, 403, 'main: no such agent here');
  });

  it('SSE: the office topic streams with Atlas as the primary', async () => {
    const sse = openSse(h.base, '/api/v2/stream?topics=office', { cookie: h.cookie });
    try {
      const ev = await sse.next((e) => e.data && e.data.topic === 'office');
      const text = JSON.stringify(ev.data);
      assert.match(text, /"Atlas"/);
      assert.doesNotMatch(text, PERSONAL);
    } finally { sse.close(); }
  });

  it('text: no response carries a personal literal; "main" only in the listed 2.x alias fields', async () => {
    for (const p of ['/api/v2/me', '/api/v2/views/access', '/api/v2/views/skills', '/api/v2/views/projects', '/api/v2/views/sessions/' + encodeURIComponent('agent:atlas:telegram:direct:foreign-user')]) await get(p);
    for (const [p, json] of seen) {
      const text = JSON.stringify(p === '/api/v2/meta' ? Object.assign({}, json.data, { labels: null, enums: null }) : json);   // the label dictionary is static text
      assert.doesNotMatch(text, PERSONAL, p);
      assert.doesNotMatch(text, /discord/i, p);
      assert.deepEqual(mainOutsideAliases(p === '/api/v2/meta' ? Object.assign({}, json.data, { labels: null, enums: null }) : json.data), [], p);   // 2.x enums list 2.x members
    }
  });
});
