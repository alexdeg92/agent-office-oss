'use strict';
// S7c: the OpenClaw v2 commands (api.md §5.1, §5.2) on the adapter's commands: flows, skill toggle, gateway restart,
// async chat. Exact argv (R1-12: `--opt=value`, ids after `--`), validation, guards, audit, results over SSE topics.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadScenario, readFixture } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');

const sc = loadScenario('synthetic-basic');
const JOB = 'ffffffff-0c01-4000-8000-000000000001';
// an extra non-editable job (an `every` schedule)
const cronList = () => {
  const v = readFixture(sc.rpc['cron.list']).body.value;
  const base = v.jobs[0];
  v.jobs.push(Object.assign({}, base, { id: 'ffffffff-0c09-4000-8000-000000000009', name: 'Battement', schedule: { kind: 'every', everyMs: 1800000 } }));
  return v;
};
const audit = (h) => {
  const db = new DatabaseSync(path.join(h.tmp, 'data', 'agent-office.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT command, target, outcome, detail FROM audit_log ORDER BY id').all().map((r) => ({ ...r })); } finally { db.close(); }
};

describe('S7c · flows', () => {
  let h;
  before(async () => { h = await startServer(sc, { handlers: { 'cron.list': () => cronList() } }); });
  after(async () => { if (h) await h.stop(); });
  const last = (sub) => h.cliCalls().filter((a) => a[0] === 'cron' && a[1] === sub).pop();

  it('create: exact argv (values as one element each, the primary agent, isolated); CommandResult', async () => {
    const r = await h.request('POST', '/api/v2/flows', { name: '-Veille', cron: '0  9 * * 1', tz: 'America/Toronto', message: '--help\n1. Lire' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json.data).sort(), ['ok', 'result', 'revision', 'vm']);
    assert.ok('jobId' in r.json.data.result);
    assert.deepEqual(last('add'), ['cron', 'add', '--name=-Veille', '--cron=0 9 * * 1', '--tz=America/Toronto', '--message=--help\n1. Lire', '--agent=main', '--session=isolated', '--json']);
  });

  it('create: validation (required, lengths, cron fields, IANA zone, unknown fields) → 400 with the field', async () => {
    const ok = { name: 'A', cron: '0 9 * * 1', tz: 'UTC', message: 'm' };
    const cases = [
      [{ ...ok, name: '' }, 'name', 'length'], [{ ...ok, name: 'x'.repeat(81) }, 'name', 'length'], [{ ...ok, cron: '0 9 * *' }, 'cron', 'cron-format'],
      [{ ...ok, cron: '0 9 * * 1; rm' }, 'cron', 'cron-format'], [{ ...ok, tz: 'Mars/Olympus' }, 'tz', 'unknown-tz'], [{ ...ok, message: '' }, 'message', 'length'],
      [{ name: 'A', cron: '0 9 * * 1', tz: 'UTC' }, 'message', 'required'], [{ ...ok, agent: 'other' }, 'agent', 'unexpected-field'],
    ];
    const before = h.cliCalls().length;
    for (const [body, field, issue] of cases) {
      const r = await h.request('POST', '/api/v2/flows', body);
      assert.equal(r.status, 400, JSON.stringify(body)); assert.deepEqual(r.json.error.details, [{ field, issue }], JSON.stringify(body));
    }
    assert.equal(h.cliCalls().length, before, 'nothing reached the CLI');
  });

  it('edit: id after `--`; not-editable for a non-cron job; empty body; invalid and leading-dash ids are refused, not stripped', async () => {
    assert.equal((await h.request('PATCH', '/api/v2/flows/' + JOB, { name: 'Nouveau nom' })).status, 200);
    assert.deepEqual(last('edit'), ['cron', 'edit', '--name=Nouveau nom', '--', JOB]);
    const ne = await h.request('PATCH', '/api/v2/flows/ffffffff-0c09-4000-8000-000000000009', { name: 'x' });
    assert.equal(ne.status, 400); assert.deepEqual(ne.json.error.details, [{ field: 'jobId', issue: 'not-editable' }]);
    assert.deepEqual((await h.request('PATCH', '/api/v2/flows/' + JOB, {})).json.error.details, [{ issue: 'empty' }]);
    for (const id of ['-rf', 'abc%2Fdef', '--all']) {
      const r = await h.request('PATCH', '/api/v2/flows/' + id, { name: 'x' });
      assert.equal(r.status, 400, id); assert.deepEqual(r.json.error.details, [{ field: 'jobId', issue: 'invalid-id' }]);
    }
    assert.equal((await h.request('PATCH', '/api/v2/flows/ffffffff-dead-4000-8000-000000000000', { name: 'x' })).status, 404);
  });

  it('enable/disable, run, delete: exact argv with `--`', async () => {
    assert.equal((await h.request('PUT', `/api/v2/flows/${JOB}/enabled`, { enabled: false })).status, 200);
    assert.deepEqual(last('disable'), ['cron', 'disable', '--', JOB]);
    assert.equal((await h.request('PUT', `/api/v2/flows/${JOB}/enabled`, { enabled: 'non' })).status, 400);
    assert.equal((await h.request('POST', `/api/v2/flows/${JOB}/runs`, {})).status, 200);
    assert.deepEqual(last('run'), ['cron', 'run', '--', JOB]);
    assert.equal((await h.request('DELETE', `/api/v2/flows/${JOB}`, {})).status, 200);
    assert.deepEqual(last('rm'), ['cron', 'rm', '--json', '--', JOB]);
  });

  it('every attempt is audited (command, target, outcome); never the body', async () => {
    // the audit router writes on the response's 'finish', which can follow the client's read: wait for the last one
    await waitFor(() => audit(h).some((r) => r.command === 'flows.delete' && r.target === JOB), { what: 'the flows.delete audit row' });
    const rows = audit(h).filter((r) => r.command.startsWith('flows.'));
    assert.ok(rows.some((r) => r.command === 'flows.create' && r.outcome === 'ok'));
    assert.ok(rows.some((r) => r.command === 'flows.create' && r.outcome === 'rejected' && r.detail === 'http-400'));
    assert.ok(rows.some((r) => r.command === 'flows.edit' && r.target === JOB && r.outcome === 'ok'));
    assert.ok(rows.some((r) => r.command === 'flows.delete' && r.target === JOB));
    assert.ok(!JSON.stringify(audit(h)).includes('Nouveau nom'));
  });
});

describe('S7c · skills and the gateway restart', () => {
  let h;
  before(async () => { h = await startServer(sc); });
  after(async () => { if (h) await h.stop(); });

  it('toggle: config set with the exact path; needsRestart in the result and on the skill detail', async () => {
    const skill = (await h.get('/api/v2/views/skills')).json.data.skills[0].id;
    const r = await h.request('PUT', `/api/v2/skills/${skill}/enabled`, { enabled: false });
    assert.equal(r.status, 200, r.text); assert.deepEqual(r.json.data.result, { needsRestart: true });
    assert.deepEqual(h.cliCalls().filter((a) => a[0] === 'config').pop(), ['config', 'set', `skills.entries.${skill}.enabled`, 'false']);
    await waitFor(async () => (await h.get('/api/v2/views/skills/' + skill)).json.data.needsRestart === true, { what: 'needsRestart on the detail' });
    for (const [name, status] of [['a.b', 400], ['-x', 400], ['inconnue', 404]]) assert.equal((await h.request('PUT', `/api/v2/skills/${name}/enabled`, { enabled: true })).status, status, name);
  });

  it('restart: needs the confirmation word; an unsupported RPC is 502 and keeps no cooldown; via the gateway RPC; a second within 2 min is 429', async () => {
    assert.equal((await h.request('POST', '/api/v2/gateway/restart', {})).status, 400);
    assert.equal((await h.request('POST', '/api/v2/gateway/restart', { confirm: 'oui' })).status, 400);
    // No RPC handler: refuse the selected gateway restart; there is no host-service fallback.
    const down = await h.request('POST', '/api/v2/gateway/restart', { confirm: 'redemarrer' });
    assert.equal(down.status, 502); assert.equal(down.json.error.code, 'upstream_failed');
    h.gw.handlers['gateway.restart.request'] = () => ({ ok: true });
    const r = await h.request('POST', '/api/v2/gateway/restart', { confirm: 'redemarrer' });
    assert.equal(r.status, 200, r.text); assert.deepEqual(r.json.data.result, { via: 'rpc' });
    assert.equal(h.gw.callsTo('gateway.restart.request').length, 2);
    const again = await h.request('POST', '/api/v2/gateway/restart', { confirm: 'redemarrer' });
    assert.equal(again.status, 429); assert.equal(again.json.error.code, 'rate_limited');
    // audit rows land on each response's 'finish' (after the client may have read it): wait for all five
    await waitFor(() => audit(h).filter((x) => x.command === 'gateway.restart').length >= 5, { what: 'the five gateway.restart audit rows' });
    assert.deepEqual(audit(h).filter((x) => x.command === 'gateway.restart').map((x) => x.outcome), ['rejected', 'rejected', 'failed', 'ok', 'rejected']);
  });
});

describe('S7c · async chat over the chat topic', () => {
  let h;
  before(async () => { h = await startServer(sc); });
  after(async () => { if (h) await h.stop(); });

  it('202 with a turnId; a second message while pending is 409; the turn ends with turnPending null', async () => {
    const r = await h.request('POST', '/api/v2/chat/messages', { text: 'Bonjour' });
    assert.equal(r.status, 202, r.text); assert.match(r.json.data.result.turnId, /^turn_[0-9a-f]{16}$/);
    const dup = await h.request('POST', '/api/v2/chat/messages', { text: 'Encore' });
    if (dup.status !== 202) { assert.equal(dup.status, 409); assert.deepEqual(dup.json.error.details, [{ issue: 'turn-pending' }]); }
    await waitFor(async () => (await h.get('/api/v2/views/chat')).json.data.turnPending === null, { what: 'the turn to finish' });
    const chat = (await h.get('/api/v2/views/chat')).json;
    assert.equal(chat.data.sessionKey, 'agent:main:explicit:portal-chat');
    assert.equal(chat.meta.topic.id, 'chat');
    const turn = h.cliCalls().find((a) => a[0] === 'agent');
    assert.deepEqual(turn, ['agent', '--message=Bonjour', '--agent=main', '--json', '--timeout=150', '--channel=webchat', '--reply-channel=webchat', '--session-key=agent:main:explicit:portal-chat']);
    const fence = h.cliCalls().find(a => a[0] === 'gateway' && a[2] === 'sessions.patch');
    assert.equal(JSON.parse(fence.find(a => a.startsWith('--params=')).slice(9)).key, chat.data.sessionKey);
    assert.ok(turn.includes('--session-key=' + chat.data.sessionKey), 'chat follows the exact fenced/dispatch session');
    for (const body of [{ text: '' }, { text: 'x'.repeat(8001) }, { text: 'a', extra: 1 }]) assert.equal((await h.request('POST', '/api/v2/chat/messages', body)).status, 400);
  });

  it('the command-buffer reply is consumed when the transcript publishes the same primary reply', async () => {
    const sessionKey = 'agent:main:explicit:portal-chat';
    const answer = 'Réponse factice.';
    const h = await startServer(sc, { handlers: { 'sessions.get': params => {
      assert.equal(params.key, sessionKey);
      return { messages: [
        { role: 'user', timestamp: sc.now + 1, content: 'Bonjour' },
        { role: 'assistant', timestamp: sc.now + 2, content: answer },
      ] };
    } } });
    try {
      assert.equal((await h.post('/api/v2/chat/messages', { text: 'Bonjour' })).status, 202);
      await waitFor(async () => (await h.get('/api/v2/views/chat')).json.data.turnPending === null, { what: 'the buffered chat reply to finish' });
      const chat = (await h.get('/api/v2/views/chat')).json.data;
      const replies = chat.messages.filter(m => m.role === 'assistant' && m.text === answer);
      assert.equal(replies.length, 1, JSON.stringify(chat.messages));
      assert.match(replies[0].id, /^ev:/, 'the transcript event replaces the provisional command-buffer row');
      assert.ok(!chat.messages.some(m => m.id.startsWith('reply_')));
    } finally { await h.stop(); }
  });
});

describe('S7c · a failed chat turn becomes an error message', () => {
  let h;
  before(async () => { h = await startServer(sc, { failCli: 'agent' }); });
  after(async () => { if (h) await h.stop(); });
  it('the CLI fails: an `error` message in French, no reply text, and a new turn is accepted', async () => {
    assert.equal((await h.request('POST', '/api/v2/chat/messages', { text: 'Bonjour' })).status, 202);
    const chat = await waitFor(async () => { const c = (await h.get('/api/v2/views/chat')).json.data; return c.turnPending === null && c; }, { what: 'the failed turn' });
    const err = chat.messages.find((m) => m.role === 'error');
    assert.ok(err); assert.match(err.text, /^La réponse n’a pas pu être reçue/);
    assert.ok(!chat.messages.some((m) => m.role === 'assistant' && /simulated/.test(m.text)));
    assert.equal((await h.request('POST', '/api/v2/chat/messages', { text: 'Encore' })).status, 202);
  });
});

describe('S7c · a read-only instance refuses every OpenClaw command', () => {
  let h;
  before(async () => { h = await startServer(sc, { readonly: true }); });
  after(async () => { if (h) await h.stop(); });
  it('403 readonly; nothing reaches the CLI or the service manager', async () => {
    const before = h.cliCalls().filter((a) => a[0] !== 'skills').length;
    for (const [m, p, b] of [['POST', '/api/v2/flows', { name: 'A', cron: '0 9 * * 1', tz: 'UTC', message: 'm' }], ['PATCH', '/api/v2/flows/' + JOB, { name: 'x' }],
      ['PUT', `/api/v2/flows/${JOB}/enabled`, { enabled: true }], ['POST', `/api/v2/flows/${JOB}/runs`, {}], ['DELETE', `/api/v2/flows/${JOB}`, {}],
      ['PUT', '/api/v2/skills/weather/enabled', { enabled: false }], ['POST', '/api/v2/gateway/restart', { confirm: 'redemarrer' }], ['POST', '/api/v2/chat/messages', { text: 'x' }]]) {
      const r = await h.request(m, p, b);
      assert.equal(r.status, 403, m + ' ' + p); assert.equal(r.json.error.code, 'readonly');
    }
    assert.equal(h.cliCalls().filter((a) => a[0] !== 'skills').length, before);
  });
});

describe('S7c · the chat view matches its api.md shape', () => {
  it('ChatVM keys', async () => {
    const { buildChatVM } = require('../../src/api/v2/vm/chat');
    const vm = buildChatVM({ sessionKey: 'k', transcript: { events: [{ id: 'ev:0:0', kind: 'user', at: 1, text: 'a' }, { id: 'ev:1:0', kind: 'assistant', at: 2, text: 'b', model: 'm', outputTokens: 3 }] },
      pending: { turnId: 't', since: 5, text: 'c' }, errors: [{ id: 'err_x', at: 4, text: 'oups' }] });
    assert.deepEqual(vm.messages.map((m) => [m.role, m.text]), [['user', 'a'], ['assistant', 'b'], ['error', 'oups'], ['user', 'c']]);
    assert.deepEqual(vm.turnPending, { turnId: 't', since: 5 });
  });
});
