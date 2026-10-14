'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { settingsFixture } = require('../helpers/settings-fixture');
const { openSse } = require('../helpers/sse-client');
const { hashPassword } = require('../../src/security/password');
const codex = require('../../src/adapters/codex');

async function projectsOnlyReader(h) {
  const owner = h.store.users.owner(), context = { userId: owner.id, authGeneration: owner.auth_generation,
    requestId: 'req_projects_reader_invite', authorize: () => {} };
  const invite = h.store.userManagement.invite({ name: 'Projects-only reader', email: 'project-reader@example.invalid', roleId: 'rol_reader' }, context);
  h.store.userManagement.accept({ token: invite.token, purpose: 'invite', passwordHash: await hashPassword('synthetic-project-reader-password') },
    { requestId: 'req_projects_reader_accept' });
  const reader = h.store.users.byId(invite.user.id);
  for (const [resource, level] of [['projects', 'read'], ['teams', 'none'], ['logs', 'none'], ['settings.runtimes', 'none']]) {
    h.store.db.prepare('INSERT INTO user_overrides(user_id,resource,level) VALUES (?,?,?)').run(reader.id, resource, level);
  }
  h.cookie = 'taco_sess=' + h.auth.signSession({ userId: reader.id, authGeneration: reader.auth_generation,
    sid: 'synthetic-project-reader-session', exp: Date.now() + 60_000 });
  return reader;
}

test('projects-only HTTP and SSE mask restricted team detail existence on v2 and v3', async t => {
  const at = Date.now();
  const source = { detected: true, hasHerdr: false, hasTeamStore: true, enabled: true,
    start() {}, close() {}, onChange: () => () => {},
    getSnapshot: () => ({ revision: 1, observedAt: at, hosts: [], orchestrators: [], agents: [], identityLinks: [],
      team: { id: 'team:restricted-fixture', label: 'Restricted fixture', status: 'active' },
      members: [{ id: 'member:restricted-lead', name: 'Restricted lead', roleKind: 'lead', roleLabel: 'lead',
        status: 'active', runtimeKind: 'codex', parentMemberId: null, hostAgentId: null }],
      tasks: [], reviews: [], diagnostics: { skippedTaskCount: 0, skippedMemberCount: 0, skippedCount: 0, quality: 'complete' } }) };
  const h = await settingsFixture({ enforceAuthorization: true, orchestratorTeams: source });
  t.after(() => h.close());
  const ownerCookie = h.cookie;
  const board = await h.get('/api/v3/views/projects');
  assert.equal(board.status, 200, board.text);
  const teamId = board.json.data.columns.flatMap(row => row.cards).find(row => row.origin === 'orchestrator-team')?.id;
  assert.ok(teamId, 'owner sees the synthetic team project');

  await projectsOnlyReader(h);

  const unknownId = 'teamprj_unknown_fixture';
  const errorPair = async route => {
    const known = await h.get(route(teamId)), absent = await h.get(route(unknownId));
    assert.equal(known.status, 404, known.text); assert.equal(absent.status, 404, absent.text);
    assert.equal(known.json.error.code, 'not_found'); assert.equal(absent.json.error.code, 'not_found');
  };
  for (const version of [2, 3]) {
    await errorPair(id => `/api/v${version}/views/projects/${encodeURIComponent(id)}`);
    await errorPair(id => `/api/v${version}/views/projects/${encodeURIComponent(id)}/comments`);
    await errorPair(id => `/api/v${version}/views/projects/${encodeURIComponent(id)}/history`);

    const projectStreams = [];
    for (const id of [teamId, unknownId]) {
      const stream = openSse(h.base, `/api/v${version}/stream?topics=${encodeURIComponent('project:' + id)}`, { cookie: h.cookie });
      projectStreams.push(stream);
      await stream.next(frame => frame.event === 'hello');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(projectStreams.map(stream => stream.frames.map(frame => frame.event)), [['hello'], ['hello']],
      `v${version} restricted and absent detail streams have the same observable lifecycle`);
    for (const stream of projectStreams) stream.close();

    const commentStreams = [];
    for (const id of [teamId, unknownId]) {
      const stream = openSse(h.base, `/api/v${version}/stream?topics=${encodeURIComponent('comments:' + id)}`, { cookie: h.cookie });
      commentStreams.push(stream);
      const hello = await stream.next(frame => frame.event === 'hello');
      assert.deepEqual(hello.data.rejected, [{ topic: 'comments:' + id, issue: 'permission-denied' }], `v${version} comments stream denies the subscription`);
    }
    for (const stream of commentStreams) stream.close();
  }
  h.cookie = ownerCookie;
});

test('hidden Codex project activity does not change projects-only revisions or SSE delivery', async t => {
  const h = await settingsFixture({ enforceAuthorization: true });
  t.after(() => h.close());
  await projectsOnlyReader(h);
  h.engine.connectorOf = () => ({ id: 'runtime-codex', adapter: 'codex', name: 'Codex', mark: codex.definition.mark,
    projectSource: codex.definition.projectSource });
  const sessionsTopic = version => `projects?source=${encodeURIComponent('runtime:runtime-codex')}`;
  const absentTopic = version => `projects?source=${encodeURIComponent('runtime:runtime-absent')}`;
  const baseTopic = 'projects';
  const snapshotsFor = (stream, topic) => stream.frames.filter(frame => frame.event === 'snapshot' && frame.data.topic === topic);
  const streams = [];
  for (const version of [2, 3]) {
    const base = await h.get(`/api/v${version}/views/projects`);
    const selected = await h.get(`/api/v${version}/views/projects?source=${encodeURIComponent('runtime:runtime-codex')}`);
    assert.equal(base.status, 200, base.text); assert.equal(selected.status, 200, selected.text);
    assert.equal(selected.json.data.columns.flatMap(row => row.cards).length, 0);
    const baseRevision = base.json.meta.topic.rev, selectedRevision = selected.json.meta.topic.rev;
    const topics = [baseTopic, sessionsTopic(version), absentTopic(version)].join(',');
    const stream = openSse(h.base, `/api/v${version}/stream?topics=${encodeURIComponent(topics)}`, { cookie: h.cookie });
    streams.push({ version, stream, baseRevision, selectedRevision });
    await stream.next(frame => frame.event === 'hello');
    for (const topic of [baseTopic, sessionsTopic(version), absentTopic(version)]) {
      const frame = await stream.next(frame => frame.event === 'snapshot' && frame.data.topic === topic);
      if (topic === sessionsTopic(version)) assert.equal(frame.data.rev, selectedRevision,
        `v${version} initial SSE revision matches the selected HTTP projection`);
    }
  }

  const at = Date.now(), session = { key: 'codex:private-project-session', sessionId: 'private-session-ref',
    class: { kind: 'conversation', ruleId: 'synthetic-codex-project', agentId: null, channel: null, heartbeatOf: null, background: false, rawClassification: null },
    displayName: null, projectLabel: 'Private Codex workspace', projectRef: 'project:private-ref', model: null, provider: 'codex',
    usage: { total: 1, input: 1, output: 0 }, tokensKnown: true, updatedAt: at,
    run: { status: 'idle', endReason: null, evidence: 'status-field', evidenceLevel: 'verified', observedAt: at, expiresAt: null,
      startedAt: at - 1000, endedAt: at, hasActiveSubagentRun: false, runtimeMs: null, lastRunId: null, lastError: null },
    costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: 1, interactive: true, group: null };
  const accepted = h.engine.ingestCanonical('sessions.snapshot', [session]);
  assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
  h.api.topics.invalidate('projects');
  await new Promise(resolve => setTimeout(resolve, 650));

  try {
    for (const { version, stream, baseRevision, selectedRevision } of streams) {
      const base = await h.get(`/api/v${version}/views/projects`);
      const selected = await h.get(`/api/v${version}/views/projects?source=${encodeURIComponent('runtime:runtime-codex')}`);
      const absent = await h.get(`/api/v${version}/views/projects?source=${encodeURIComponent('runtime:runtime-absent')}`);
      assert.equal(base.status, 200, base.text); assert.equal(selected.status, 200, selected.text); assert.equal(absent.status, 200, absent.text);
      assert.equal(base.json.meta.topic.rev, baseRevision, `v${version} base HTTP revision tracks its unchanged visible payload`);
      assert.equal(selected.json.meta.topic.rev, selectedRevision, `v${version} selected hidden source keeps its HTTP revision`);
      assert.equal(absent.json.meta.topic.rev, selectedRevision, `v${version} known/absent source filters have indistinguishable revision`);
      assert.deepEqual(base.json.data, stream.frames.find(frame => frame.event === 'snapshot' && frame.data.topic === baseTopic).data.data);
      assert.equal(snapshotsFor(stream, baseTopic).length, 1, `v${version} hidden source activity emits no base-board snapshot`);
      assert.equal(snapshotsFor(stream, sessionsTopic(version)).length, 1, `v${version} hidden source activity emits no selected-filter snapshot`);
      assert.equal(snapshotsFor(stream, absentTopic(version)).length, 1, `v${version} absent-filter stream stays indistinguishable`);
    }
  } finally { for (const { stream } of streams) stream.close(); }
});
