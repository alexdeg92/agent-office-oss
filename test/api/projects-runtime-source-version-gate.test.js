'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { settingsFixture } = require('../helpers/settings-fixture');
const { openSse } = require('../helpers/sse-client');
const { hashPassword } = require('../../src/security/password');
const codex = require('../../src/adapters/codex');

const run = at => ({ status: 'idle', endReason: null, evidence: 'status-field', evidenceLevel: 'verified', observedAt: at,
  expiresAt: null, startedAt: at - 1000, endedAt: at, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null });

test('runtime projects are absent from legacy v2 board/detail/topics and open through v3', async t => {
  const source = { id: 'runtime-codex', adapter: 'codex', name: 'Codex', mark: codex.definition.mark,
    projectSource: codex.definition.projectSource };
  const h = await settingsFixture({ viewEngine: engine => new Proxy({}, { get(_target, key) {
    if (key === 'connectorOf') return sessionKey => sessionKey === 'codex:synthetic-project'
      ? source : engine.connectorOf(sessionKey);
    const value = engine[key]; return typeof value === 'function' ? value.bind(engine) : value;
  } }) });
  t.after(() => h.close());

  const v2Before = await h.get('/api/v2/views/projects');
  assert.equal(v2Before.status, 200, v2Before.text);
  const v3Before = await h.get('/api/v3/views/projects');
  assert.equal(v3Before.status, 200, v3Before.text);

  const at = Date.now();
  const accepted = h.engine.ingestCanonical('sessions.snapshot', [{ key: 'codex:synthetic-project', sessionId: 'fixture-session-id',
    class: { kind: 'conversation', ruleId: 'synthetic-codex', agentId: 'agent:synthetic-codex', channel: null,
      heartbeatOf: null, background: false, rawClassification: null }, displayName: null, summary: null,
    projectLabel: 'synthetic-workspace', projectRef: 'project:synthetic-ref', model: null, provider: 'codex',
    usage: { total: 3, input: 2, output: 1 }, tokensKnown: true, updatedAt: at, run: run(at), costUsd: null,
    parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: 2, interactive: true, group: null }]);
  assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
  h.api.topics.invalidate('projects');

  const v2After = await h.get('/api/v2/views/projects');
  const v3After = await h.get('/api/v3/views/projects');
  assert.equal(v2After.status, 200, v2After.text);
  assert.equal(v3After.status, 200, v3After.text);
  const runtimeCard = v3After.json.data.columns.flatMap(column => column.cards)
    .find(card => card.sourceDescriptors?.some(descriptor => descriptor.kind === 'runtime'));
  assert.ok(runtimeCard, 'v3 retains the T-0134 runtime project contract for the new UI');
  assert.equal(v2After.json.data.columns.flatMap(column => column.cards)
    .some(card => card.sourceDescriptors?.some(descriptor => descriptor.kind === 'runtime')), false);
  assert.equal(v2After.json.data.sourceFilters.some(row => row.source.kind === 'runtime'), false,
    'legacy counts and filters reveal no runtime project source');
  assert.equal(v2After.json.meta.topic.rev, v2Before.json.meta.topic.rev,
    'hidden runtime activity does not advance the legacy topic revision');
  assert.ok(v3After.json.meta.topic.rev > v3Before.json.meta.topic.rev,
    'v3 live topic includes runtime project changes');

  const detailV2 = await h.get(`/api/v2/views/projects/${encodeURIComponent(runtimeCard.id)}`);
  const absentV2 = await h.get('/api/v2/views/projects/runtimeprj_absent_fixture');
  assert.equal(detailV2.status, 404, detailV2.text);
  assert.equal(detailV2.json.error.code, 'not_found');
  assert.deepEqual([detailV2.json.error.code, detailV2.json.error.message], [absentV2.json.error.code, absentV2.json.error.message],
    'a known runtime ID is indistinguishable from an absent project in v2');
  const detailV3 = await h.get(`/api/v3/views/projects/${encodeURIComponent(runtimeCard.id)}`);
  assert.equal(detailV3.status, 200, detailV3.text);
  assert.equal(detailV3.json.data.id, runtimeCard.id);
  assert.equal(detailV3.json.data.name, 'synthetic-workspace');
  assert.equal(detailV3.json.data.sourceDescriptors[0].kind, 'runtime');
  assert.throws(() => h.api.topics.current('project:' + runtimeCard.id, 2), error => error.code === 'not_found',
    'the v2 live detail topic rejects a hidden runtime project');
  assert.deepEqual(h.api.topics.of(2).ids('project'), [], 'v2 never publishes a live revision for a runtime project');
  assert.ok(h.api.topics.current('project:' + runtimeCard.id, 3)?.vm,
    'the v3 detail topic is available through the same shared builder');
  assert.deepEqual(h.api.topics.of(3).ids('project'), ['project:' + runtimeCard.id]);
});

test('projects-only reader gets identical public not-found bodies for known and absent runtime projects', async t => {
  const source = { id: 'runtime-codex', adapter: 'codex', name: 'Codex', mark: codex.definition.mark,
    projectSource: codex.definition.projectSource };
  const h = await settingsFixture({ enforceAuthorization: true, viewEngine: engine => new Proxy({}, { get(_target, key) {
    if (key === 'connectorOf') return sessionKey => sessionKey === 'codex:private-workspace'
      ? source : engine.connectorOf(sessionKey);
    const value = engine[key]; return typeof value === 'function' ? value.bind(engine) : value;
  } }) });
  t.after(() => h.close());
  const at = Date.now();
  const accepted = h.engine.ingestCanonical('sessions.snapshot', [{ key: 'codex:private-workspace', sessionId: 'private-session-ref',
    class: { kind: 'conversation', ruleId: 'synthetic-codex', agentId: 'agent:synthetic-codex', channel: null,
      heartbeatOf: null, background: false, rawClassification: null }, displayName: null, summary: null,
    projectLabel: 'private-workspace', projectRef: 'project:private-ref', model: null, provider: 'codex',
    usage: { total: 3, input: 2, output: 1 }, tokensKnown: true, updatedAt: at, run: run(at), costUsd: null,
    parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: 2, interactive: true, group: null }]);
  assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
  h.api.topics.invalidate('projects');
  const board = await h.get('/api/v3/views/projects');
  const runtimeCard = board.json.data.columns.flatMap(column => column.cards)
    .find(card => card.sourceDescriptors?.some(descriptor => descriptor.kind === 'runtime'));
  assert.ok(runtimeCard, 'owner can initially discover a runtime project');

  const owner = h.store.users.owner(), context = { userId: owner.id, authGeneration: owner.auth_generation,
    requestId: 'req_runtime_project_reader', authorize: () => {} };
  const invite = h.store.userManagement.invite({ name: 'Projects reader', email: 'runtime-reader@example.invalid', roleId: 'rol_reader' }, context);
  h.store.userManagement.accept({ token: invite.token, purpose: 'invite', passwordHash: await hashPassword('synthetic-runtime-reader-password') },
    { requestId: 'req_runtime_project_accept' });
  const reader = h.store.users.byId(invite.user.id);
  for (const [resource, level] of [['projects', 'read'], ['logs', 'none'], ['settings.runtimes', 'none']]) {
    h.store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?)').run(reader.id, resource, level);
  }
  h.cookie = 'taco_sess=' + h.auth.signSession({ userId: reader.id, authGeneration: reader.auth_generation,
    sid: 'synthetic-runtime-reader-session', exp: Date.now() + 60_000 });

  const absentId = 'runtimeprj_never_existed';
  const publicError = async response => {
    assert.equal(response.status, 404, response.text);
    const body = structuredClone(response.json);
    delete body.error.requestId;
    return body;
  };
  const routes = [
    id => '/api/v3/views/projects/' + encodeURIComponent(id),
    id => '/api/v3/views/projects/' + encodeURIComponent(id) + '/comments',
    id => '/api/v3/views/projects/' + encodeURIComponent(id) + '/history',
  ];
  for (const route of routes) {
    const known = await h.get(route(runtimeCard.id)), absent = await h.get(route(absentId));
    assert.deepEqual(await publicError(known), await publicError(absent), 'known and absent project errors have the same public body');
  }

  const projectStreams = [];
  for (const id of [runtimeCard.id, absentId]) {
    const stream = openSse(h.base, '/api/v3/stream?topics=' + encodeURIComponent('project:' + id), { cookie: h.cookie });
    projectStreams.push(stream);
    await stream.next(frame => frame.event === 'hello');
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(projectStreams.map(stream => stream.frames.map(frame => frame.event)), [['hello'], ['hello']],
    'known and absent runtime project topics have the same restricted stream lifecycle');
  for (const stream of projectStreams) stream.close();

  const hiddenBoard = await h.get('/api/v3/views/projects');
  assert.equal(hiddenBoard.status, 200);
  assert.equal(hiddenBoard.json.data.columns.flatMap(column => column.cards).some(card =>
    card.sourceDescriptors?.some(descriptor => descriptor.kind === 'runtime')), false);
  assert.equal(hiddenBoard.json.data.sourceFilters.some(filter => filter.source?.kind === 'runtime'), false);
});

test('team project portraits require office.read in v2/v3 HTTP and SSE projections', async t => {
  const teamId = 'team:portrait-permission';
  const leadId = 'member:portrait-permission-lead';
  const observedAt = Date.now();
  const snapshot = { revision: 1, observedAt,
    team: { id: teamId, label: 'Portrait permission team', status: 'active', observedAt },
    members: [
      { id: leadId, teamId, name: 'Project Lead', roleKind: 'lead', parentMemberId: null,
        runtimeKind: 'openclaw', hostAgentId: null, status: 'idle' },
      { id: 'member:portrait-permission-child', teamId, name: 'Project Builder', roleKind: 'member', parentMemberId: leadId,
        runtimeKind: 'codex', hostAgentId: null, status: 'working' },
    ], tasks: [], reviews: [], diagnostics: { skippedTaskCount: 0, skippedMemberCount: 0 },
    privateMemberSessionKeys: {}, privateMemberSessionRefs: {} };
  const source = { detected: true, hasHerdr: false, hasTeamStore: true, enabled: true,
    teamCapabilities: { projectSource: { id: 'agent-team-pm', label: 'Agent Team PM' }, teamTasks: { write: false } },
    start() {}, close() {}, onChange: () => () => {}, getSnapshot: () => snapshot };
  const h = await settingsFixture({ enforceAuthorization: true, orchestratorTeams: source });
  t.after(() => h.close());

  h.api.topics.invalidate('projects');
  const ownerBoard = await h.get('/api/v3/views/projects');
  assert.equal(ownerBoard.status, 200, ownerBoard.text);
  const card = ownerBoard.json.data.columns.flatMap(column => column.cards).find(row => row.origin === 'orchestrator-team');
  assert.ok(card, 'the authorized owner sees the team project');
  const ownerDetail = await h.get(`/api/v3/views/projects/${encodeURIComponent(card.id)}`);
  assert.equal(ownerDetail.status, 200, ownerDetail.text);
  assert.ok(ownerDetail.json.data.teamProject.roster.members.some(row => row.portrait.look),
    'the owner with office.read sees the canonical Office portrait');

  const owner = h.store.users.owner();
  const context = { userId: owner.id, authGeneration: owner.auth_generation, requestId: 'req_portrait_reader', authorize: () => {} };
  const invite = h.store.userManagement.invite({ name: 'Project team reader', email: 'portrait-reader@example.invalid', roleId: 'rol_reader' }, context);
  h.store.userManagement.accept({ token: invite.token, purpose: 'invite', passwordHash: await hashPassword('synthetic-portrait-reader-password') },
    { requestId: 'req_portrait_reader_accept' });
  const reader = h.store.users.byId(invite.user.id);
  for (const [resource, level] of [['projects', 'read'], ['teams', 'read'], ['office', 'none']]) {
    h.store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?)').run(reader.id, resource, level);
  }
  h.cookie = 'taco_sess=' + h.auth.signSession({ userId: reader.id, authGeneration: reader.auth_generation,
    sid: 'synthetic-portrait-reader-session', exp: Date.now() + 60_000 });

  const assertNeutral = data => {
    const rows = data.teamProject.roster.members;
    assert.equal(rows.length, 2);
    for (const row of rows) assert.deepEqual(row.portrait, { look: null, avatarUrl: null },
      'a projects+teams reader without office.read receives no Office-derived portrait');
  };
  for (const version of [2, 3]) {
    const detail = await h.get(`/api/v${version}/views/projects/${encodeURIComponent(card.id)}`);
    assert.equal(detail.status, 200, detail.text);
    assertNeutral(detail.json.data);
    const stream = openSse(h.base, `/api/v${version}/stream?topics=${encodeURIComponent('project:' + card.id)}`, { cookie: h.cookie });
    try {
      const frame = await stream.next(event => event.event === 'snapshot' && event.data?.topic === 'project:' + card.id);
      assertNeutral(frame.data.data);
    } finally { stream.close(); }
  }
});
