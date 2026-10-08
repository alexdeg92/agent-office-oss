// The /v2 mocks match the authoritative contract examples (docs/architecture/examples/, api.md 2.3), checked on full
// envelopes from the mock server with the architect's strict checker: compareExample(name, body, { envelope: true })
// applies each example's sidecar (<name>.types.json: nullable, types, variants, opaque) and checks `meta` (architect-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareShape, compareExample, loadExample, loadSidecar } = require('../helpers/contract-shape.js');
const server = await import('../../public/v2/mock/server.js');
server.configure({ scenario: '1', standalone: true });
const call = async (method, path, body) => server.handle(method, path, body);

test('GET /views/projects/:id (every mock project) matches project-vm.json', async () => {
  const board = (await call('GET', '/api/v2/views/projects')).body.data;
  const ids = board.columns.flatMap((c) => c.cards.map((x) => x.id));
  assert.ok(ids.includes('prj_k3v9q2m8x1c4d7fz'), 'the example project is part of the mock data');
  for (const id of ids) {
    const r = await call('GET', '/api/v2/views/projects/' + id);
    assert.equal(r.status, 200);
    // project-vm.types.json lacks the sessionGroup ref variant {by:'keys', sessionKeys} that api.md §5.4 allows (asked
    // of architect in frontend-06): checked with that variant added; everything else exactly like compareExample.
    const sidecar = loadSidecar('project-vm');
    const opts = { ...sidecar, variants: { ...sidecar.variants, '$.sources[].ref': [...((sidecar.variants || {})['$.sources[].ref'] || []), { by: 'keys', sessionKeys: ['agent:main:explicit:x'] }] } };
    assert.deepEqual(compareShape(loadExample('project-vm').data, r.body.data, opts), [], id);
    assert.deepEqual(compareExample('project-vm', { ...r.body, data: loadExample('project-vm').data }, { envelope: true }), [], id + ' meta');
  }
});

test('GET /views/projects (all filters) matches board-vm.json', async () => {
  for (const f of ['', '?filter=at-risk', '?filter=with-timmy']) {
    const r = await call('GET', '/api/v2/views/projects' + f);
    assert.deepEqual(compareExample('board-vm', r.body, { envelope: true }), [], f || 'all');
  }
});

test('GET /views/projects/:id/history matches history-page.json', async () => {
  const first = (await call('GET', '/api/v2/views/projects/prj_portail')).body.data;
  const r = await call('GET', `/api/v2/views/projects/prj_portail/history?cursor=${first.historyNextCursor || btoa('5')}&limit=5`);
  assert.equal(r.status, 200);
  assert.deepEqual(compareExample('history-page', r.body, { envelope: true }), []);
});

test('GET /views/project-candidates matches candidates-vm.json; POST /projects/import matches import-result.json', async () => {
  const c = await call('GET', '/api/v2/views/project-candidates');
  assert.deepEqual(compareExample('candidates-vm', c.body, { envelope: true }), []);
  const keys = c.body.data.candidates.map((x) => x.key);
  for (const candidate of loadExample('candidates-vm').data.candidates) {
    assert.ok(keys.includes(candidate.key), 'the example candidates are part of the mock data');
  }
  const body = { keys: [keys[2], 'cle-inconnue'], overrides: { [keys[2]]: { name: 'Renommé', status: 'todo', labels: ['a'] } } };
  assert.deepEqual(compareExample('import-request', body), [], 'the body the UI sends');
  const r = await call('POST', '/api/v2/projects/import', body);
  assert.equal(r.status, 200);
  assert.deepEqual(compareExample('import-result', r.body, { envelope: true }), []);
  assert.deepEqual(r.body.data.result.skipped, [{ key: 'cle-inconnue', reason: 'unknown' }]);
});

test('GET /views/sessions/:key (example and invented sessions) matches session-vm.json', async () => {
  for (const key of ['agent:main:subagent:ffffffff-0001-4000-8000-000000000001', 'agent:main:discord:direct:guest', 'agent:main:main']) {
    const r = await call('GET', '/api/v2/views/sessions/' + encodeURIComponent(key));
    assert.equal(r.status, 200, key);
    assert.deepEqual(compareExample('session-vm', r.body, { envelope: true }), [], key);
  }
});

test('a stale project write answers like error-409-project.json', async () => {
  const r = await call('PUT', '/api/v2/projects/prj_lucie/status', { expectedRevision: 1, status: 'idea' });
  assert.equal(r.status, 409);
  assert.deepEqual(compareExample('error-409-project', r.body), []);
});

test('conform keeps LabelRef params even when the example item has none (regression)', async () => {
  const { conform, EXAMPLES } = await import('../../public/v2/mock/examples.js');
  const model = EXAMPLES.historyPage.data.items.find((i) => !i.text.params);
  const out = conform(model, { ...structuredClone(model), text: { key: 'historyKind.status', params: { from: { key: 'projectStatus.todo' } } } });
  assert.deepEqual(out.text.params, { from: { key: 'projectStatus.todo' } });
  const r = await call('GET', '/api/v2/views/projects/prj_k3v9q2m8x1c4d7fz');
  assert.ok(r.body.data.recentHistory.every((h) => h.kind === 'archived' || h.kind === 'project-created' || h.text.params), 'history params reach the client');
});

// Flows and access have no example file yet (architect adds flow-detail-vm / interlocutor-vm in S7); their api.md
// sections carry the JSON inline (§3.4, §3.5). Without a sidecar the strict checker can't know nullability, so these two
// run non-strict until the example files land; then they move to compareExample like the others.
function withVariants(example, arrayPath, kinds, from) {
  const ex = structuredClone(example);
  const arr = arrayPath.reduce((o, k) => o[k], ex);
  const model = arr.find((x) => x.kind === from);
  for (const k of kinds) if (!arr.some((x) => x.kind === k)) arr.push({ ...structuredClone(model), kind: k });
  return ex;
}
import { readFileSync } from 'node:fs';
function apiExample(section) {
  const md = readFileSync(new URL('../../docs/architecture/api.md', import.meta.url), 'utf8');
  const start = md.indexOf('\n### ' + section);
  const json = /```json\n([\s\S]*?)\n```/.exec(md.slice(start));
  return JSON.parse(json[1]);
}

test('GET /views/flows/:id (every mock flow) matches the api.md §3.4 example', async () => {
  // The example shows one variant of each union; add the others' shapes as api.md §3.4 types them
  // (diagram nodes are all {kind, label}).
  const ex = withVariants(apiExample('3.4'), ['data', 'diagram', 'nodes'], ['trigger', 'step', 'decision', 'output'], 'step');
  const runs = ex.data.runs;
  const job = ex.data.job;
  const list = (await call('GET', '/api/v2/views/flows')).body.data.flows;
  assert.ok(list.length >= 5);
  for (const f of list) {
    const r = await call('GET', '/api/v2/views/flows/' + f.id);
    assert.equal(r.status, 200, f.id);
    const d = r.body;
    const opaque = ['$.data.job.schedule', '$.data.job.payload'];   // unions by `kind`: checked below per variant
    // api.md §3.4 types these as nullable (no sidecar yet).
    const nullable = ['$.data.job.nextRunAt', '$.data.job.lastRunAt', '$.data.job.createdAt', '$.data.job.updatedAt', '$.data.runs[].durationMs', '$.data.runs[].nextRunAt',
      '$.data.runs[].model', '$.data.runs[].tokens', '$.data.runs[].error', '$.data.runs[].delivery.status', '$.data.runs[].delivery.delivered', '$.data.runs[].delivery.channel'];
    assert.deepEqual(compareShape(ex, d, { opaque, nullable, strict: false }), [], f.id);
    if (d.data.job.schedule.kind === 'cron') assert.deepEqual(compareShape(job.schedule, d.data.job.schedule, { strict: false }), [], f.id + ' schedule');
    if (d.data.job.payload.kind === 'agent-turn') assert.deepEqual(compareShape(job.payload, d.data.job.payload, { strict: false }), [], f.id + ' payload');
    for (const run of d.data.runs) assert.deepEqual(compareShape(runs[0], run, { strict: false, nullable: ['$.durationMs', '$.nextRunAt', '$.model', '$.tokens', '$.error', '$.delivery.status', '$.delivery.delivered', '$.delivery.channel'] }), [], f.id + ' run');
  }
});

test('GET /views/access and /views/interlocutors/:id match access-vm.json and interlocutor-vm.json (2.4 examples)', async () => {
  const access = await call('GET', '/api/v2/views/access');
  assert.deepEqual(compareExample('access-vm', access.body, { envelope: true }), []);
  for (const i of access.body.data.interlocutors) {
    const r = await call('GET', '/api/v2/views/interlocutors/' + encodeURIComponent(i.id));
    assert.equal(r.status, 200, i.id);
    assert.deepEqual(compareExample('interlocutor-vm', r.body, { envelope: true }), [], i.id);
  }
});

test('GET /views/health matches health-vm.json', async () => {
  const r = await call('GET', '/api/v2/views/health');
  assert.deepEqual(compareExample('health-vm', r.body, { envelope: true }), []);
  assert.ok(r.body.data.dataQuality.issues.every((i) => !('detail' in i) && !('sample' in i) && !('source' in i)), 'issues are value-free');
});

test('Discuter: GET /views/chat matches api.md §3.3; POST /chat/messages answers 202 { turnId }, a second one 409 turn-pending', async () => {
  const ex = apiExample('3.3');
  const nullable = ['$.data.turnPending', '$.data.messages[].meta', '$.data.messages[].meta.model', '$.data.messages[].meta.tokens', '$.data.messages[].meta.durationMs'];
  const r = await call('GET', '/api/v2/views/chat');
  assert.equal(r.status, 200);
  assert.deepEqual(compareShape(ex, r.body, { strict: false, nullable }), []);
  assert.ok(r.body.data.messages.every((m) => ['user', 'assistant', 'error'].includes(m.role)));
  const sent = await call('POST', '/api/v2/chat/messages', { text: 'Bonjour' });
  assert.equal(sent.status, 202);
  assert.equal(typeof sent.body.data.result.turnId, 'string');
  const again = await call('POST', '/api/v2/chat/messages', { text: 'Encore' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.details[0].issue, 'turn-pending');
  const pending = (await call('GET', '/api/v2/views/chat')).body.data;
  assert.deepEqual(Object.keys(pending.turnPending).sort(), ['since', 'turnId']);
  assert.ok(pending.messages.some((m) => m.id === 'pending_' + sent.body.data.result.turnId), 'the sent message shows as pending_<turnId> (§5.2)');
  const bad = await call('POST', '/api/v2/chat/messages', { text: '' });
  assert.equal(bad.status, 400);
});

test('frontend-26: comments follow architect-57 on v2/v3; commands send body only; summary accepts 202', async () => {
  for (const version of [2,3]) {
    const base='/api/v'+version;
    const r=await call('GET',base+'/views/projects/prj_portail/comments');
    assert.equal(r.status,200);
    assert.deepEqual(compareExample('comment-thread-vm',r.body,{envelope:true}),[]);
    const posted=await call('POST',base+'/projects/prj_portail/comments',{body:'Commentaire de validation'});
    assert.equal(posted.status,201);
    assert.equal(posted.body.data.result.comment.body,'Commentaire de validation');
    const cid=posted.body.data.result.comment.id;
    assert.equal((await call('PATCH',base+'/projects/prj_portail/comments/'+cid,{body:'Correction'})).status,200);
    assert.equal((await call('DELETE',base+'/projects/prj_portail/comments/'+cid)).body.data.result.comment.deleted,true);
    const projectId=version===2 ? 'prj_portail' : 'prj_veille';
    const project=(await call('GET',base+'/views/projects/'+projectId)).body.data;
    const summary=await call('POST',base+'/projects/'+projectId+'/summary/regenerate',{expectedRevision:project.revision});
    assert.equal(summary.status,202);
    assert.ok((await call('GET',base+'/views/projects/'+projectId+'/comments')).body.data.items.some((c)=>c.kind==='event'));
  }
});
