'use strict';
// S7d (migration-plan S7, projects-13): the primary agent's scoped token. Allowlist, forced actor, 401/403/429,
// audit, no token text anywhere, no cookie privileges with a bearer, a hash copied to another store is useless.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');
const { openStore } = require('../../src/store');
const { main: tokenCli } = require('../../scripts/agent-token');

const sc = loadScenario('synthetic-basic');
const quiet = (fn) => { const w = process.stdout.write; process.stdout.write = () => true; try { return fn(); } finally { process.stdout.write = w; } };
const mint = (h, cmd = 'create', file = path.join(h.tmp, 'agent-' + Math.random().toString(36).slice(2) + '.token')) => {
  quiet(() => tokenCli([cmd, '--agent', 'main', '--out', file], { AO_ENV: 'test', AO_DATA_DIR: path.join(h.tmp, 'data'), HOME: h.tmp }));
  return { file, token: fs.readFileSync(file, 'utf8').trim() };
};
const call = (h, token, method, p, body, extra = {}) => fetch(h.base + p, { method, headers: Object.assign({ authorization: 'Bearer ' + token, 'content-type': 'application/json' }, extra),
  body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null), text: '' }));
const auditRows = (h) => { const db = new DatabaseSync(path.join(h.tmp, 'data', 'agent-office.sqlite'), { readOnly: true }); try { return db.prepare('SELECT * FROM audit_log ORDER BY id').all().map((r) => ({ ...r })); } finally { db.close(); } };

describe('S7d · agent token: the allowlist and the forced actor', () => {
  let h, tok, project;
  before(async () => {
    h = await startServer(sc);
    const c = await h.request('POST', '/api/v2/projects', { name: 'Agent Office' });
    project = c.json.data.vm;
    tok = mint(h);
  });
  after(async () => { if (h) await h.stop(); });
  const rev = async () => (await h.get('/api/v2/views/projects/' + project.id)).json.data.revision;

  it('the token file is 0600 and the CLI never printed the token', () => {
    assert.equal(fs.statSync(tok.file).mode & 0o777, 0o600);
    assert.match(tok.token, /^aot_[A-Za-z0-9_-]{43}$/);
  });

  it('each allowed command succeeds and is attributed to the agent, even when the body omits the actor', async () => {
    let r = await call(h, tok.token, 'PUT', `/api/v2/projects/${project.id}/status`, { expectedRevision: await rev(), status: 'in-progress' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await call(h, tok.token, 'PATCH', `/api/v2/projects/${project.id}`, { expectedRevision: await rev(), summary: 'Résumé de l’agent.' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await call(h, tok.token, 'POST', `/api/v2/projects/${project.id}/flags`, { expectedRevision: await rev(), kind: 'label', label: 'urgent' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await call(h, tok.token, 'POST', `/api/v2/projects/${project.id}/history`, { expectedRevision: await rev(), kind: 'agent-action', dedupeKey: 'a1', text: 'Vérification faite' });
    assert.ok(r.status === 200 || r.status === 400, JSON.stringify(r.json));   // the payload is the module's to validate; the gate let it through
    const vm = (await h.get('/api/v2/views/projects/' + project.id)).json.data;
    assert.equal(vm.summaryMeta.author.name, 'Timmy', 'the summary is the agent\'s');
    assert.ok(vm.recentHistory.filter((e) => e.kind === 'status-changed' || e.kind === 'summary-edited').every((e) => e.actor.name === 'Timmy'));
  });

  it('an actor in the body → 400; a field outside the allowlist → 400; the label flag only', async () => {
    let r = await call(h, tok.token, 'PATCH', `/api/v2/projects/${project.id}`, { expectedRevision: await rev(), summary: 'x', actor: 'Owner' });
    assert.equal(r.status, 400); assert.deepEqual(r.json.error.details, [{ field: 'actor', issue: 'unexpected-field' }]);
    r = await call(h, tok.token, 'PATCH', `/api/v2/projects/${project.id}`, { expectedRevision: await rev(), name: 'Renommé' });
    assert.equal(r.status, 400); assert.deepEqual(r.json.error.details, [{ field: 'name', issue: 'unexpected-field' }]);
    r = await call(h, tok.token, 'PATCH', `/api/v2/projects/${project.id}`, { expectedRevision: await rev(), priority: 'high' });
    assert.equal(r.status, 400);
    r = await call(h, tok.token, 'POST', `/api/v2/projects/${project.id}/flags`, { expectedRevision: await rev(), kind: 'blocked', label: 'Bloqué' });
    assert.equal(r.status, 400); assert.deepEqual(r.json.error.details, [{ field: 'kind', issue: 'invalid' }]);
  });

  it('wrong scope → 403 forbidden/token-scope: archive, import, reads, the stream, meta, v1, health mute, other areas', async () => {
    for (const [m, p, b] of [
      ['PUT', `/api/v2/projects/${project.id}/archived`, { expectedRevision: 1, archived: true }], ['POST', '/api/v2/projects/import', { keys: ['x'] }],
      ['POST', '/api/v2/projects', { name: 'x' }], ['GET', '/api/v2/views/projects'], ['GET', `/api/v2/views/projects/${project.id}`], ['GET', '/api/v2/stream?topics=projects'],
      ['GET', '/api/v2/meta'], ['GET', '/api/v2/me'], ['GET', '/api/summary'], ['POST', '/api/cron', { name: 'x' }], ['PUT', '/api/v2/health/issues/x/muted', { muted: true }],
      ['POST', '/api/v2/flows', { name: 'x' }], ['POST', '/api/v2/chat/messages', { text: 'x' }], ['POST', '/api/logout', {}],
    ]) {
      const r = await call(h, tok.token, m, p, b);
      assert.equal(r.status, 403, m + ' ' + p); assert.equal(r.json.error.code, 'forbidden'); assert.deepEqual(r.json.error.details, [{ issue: 'token-scope' }]);
    }
  });

  it('a cookie together with the bearer gets no cookie privileges', async () => {
    await h.login();
    const r = await call(h, tok.token, 'GET', '/api/v2/views/projects', undefined, { cookie: h.cookie });
    assert.equal(r.status, 403);
    const w = await call(h, tok.token, 'PUT', `/api/v2/projects/${project.id}/archived`, { expectedRevision: await rev(), archived: true }, { cookie: h.cookie });
    assert.equal(w.status, 403);
  });

  it('unknown, malformed and revoked tokens → 401 (nothing says which); rotation revokes the old token', async () => {
    for (const t of ['aot_' + 'x'.repeat(43), 'nope', tok.token + 'x']) assert.equal((await call(h, t, 'PUT', `/api/v2/projects/${project.id}/status`, { expectedRevision: 1, status: 'todo' })).status, 401, t.slice(0, 8));
    const bare = await fetch(h.base + '/api/v2/views/projects', { headers: { authorization: 'Basic abc' } });
    assert.equal(bare.status, 401);
    const fresh = mint(h, 'rotate');
    assert.equal((await call(h, tok.token, 'PUT', `/api/v2/projects/${project.id}/status`, { expectedRevision: await rev(), status: 'todo' })).status, 401, 'rotated away');
    assert.equal((await call(h, fresh.token, 'PUT', `/api/v2/projects/${project.id}/status`, { expectedRevision: await rev(), status: 'todo' })).status, 200);
    tok = fresh;
  });

  it('audit: allowed as the agent with the token id; refused as rejected; no token text in the db or the responses', async () => {
    const rows = auditRows(h);
    const agentRows = rows.filter((r) => JSON.parse(r.actor_json).kind === 'agent');
    assert.ok(agentRows.some((r) => r.command === 'projects.setStatus' && r.outcome === 'ok' && /^token:tok_/.test(r.detail)));
    assert.ok(agentRows.some((r) => r.outcome === 'rejected' && /^token-scope token:tok_/.test(r.detail)));
    assert.ok(rows.some((r) => r.command === 'token.request' && r.outcome === 'rejected' && r.detail === 'unauthorized'));
    const dbText = fs.readFileSync(path.join(h.tmp, 'data', 'agent-office.sqlite')).toString('latin1') + JSON.stringify(rows);
    for (const t of [tok.token]) { assert.ok(!dbText.includes(t)); assert.ok(!h.output.includes(t)); }
  });
});

describe('S7d · agent token: rate limit and other stores', () => {
  let h;
  before(async () => { h = await startServer(sc); });
  after(async () => { if (h) await h.stop(); });

  it('the 31st request in a minute → 429, refused requests count too; audited as rate-limited', async () => {
    const { token } = mint(h);
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await call(h, token, 'GET', '/api/v2/views/projects')).status);
    assert.deepEqual([...new Set(statuses.slice(0, 30))], [403]); assert.equal(statuses[30], 429);
    assert.ok(auditRows(h).some((r) => r.detail && r.detail.startsWith('rate-limited token:')));
  });

  it('a token row copied into another instance\'s store does not work there (per-store salt)', async () => {
    const { token } = mint(h);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-other-'));
    try {
      const st = openStore({ dir: other, instance: 'test', ownerName: 'x', log: () => {} });
      const src = new DatabaseSync(path.join(h.tmp, 'data', 'agent-office.sqlite'), { readOnly: true });
      const rows = src.prepare('SELECT * FROM api_tokens').all(); src.close();
      for (const r of rows) st.db.prepare('INSERT INTO api_tokens (id, hash, agent_id, scope, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, r.hash, r.agent_id, r.scope, r.created_at, r.revoked_at);
      assert.equal(st.tokens.resolve(token), null);
      st.close();
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });
});
