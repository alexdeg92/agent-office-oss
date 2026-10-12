'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTeamStoreReader, projectSnapshot, TeamStoreReadError, LIMITS,
  MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS } = require('../../src/adapters/agent-team-pm/store-reader');

const NOW = Date.UTC(2026, 9, 10, 12);
async function withRoot(fn) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ao-team-store-fixture-'));
  try { await fs.promises.mkdir(path.join(root, 'tasks')); await fs.promises.mkdir(path.join(root, 'inbox')); return await fn(root); }
  finally { await fs.promises.rm(root, { recursive: true, force: true }); }
}
function task(overrides = {}) {
  return { id: 'T-0001', title: 'Visible task title', state: 'review', owner: 'builder-a', prio: 0,
    brief: 'private/brief.md', after: [], reviewers: { critic: 'go' }, created_by: 'pm', created: '2026-10-10T10:00:00',
    commit: 'abc123', report: 'private/report-secret.md', history: [{ ts: '2026-10-10T10:00:00', by: 'pm', event: 'private history text' }],
    updated: '2026-10-10T11:00:00', reviews: [{ ts: '2026-10-10T11:00:00', by: 'critic', verdict: 'go', note: 'private review note',
      report: 'private/review-secret.md', commit: 'deadbeef' }], ...overrides };
}
async function putTask(root, name = 'T-0001', value = task()) {
  await fs.promises.writeFile(path.join(root, 'tasks', `${name}.json`), JSON.stringify(value), { mode: 0o600 });
}

test('reads synthetic task and inbox metadata with opaque IDs and no source bodies or paths', async () => withRoot(async root => {
  await putTask(root);
  const inboxFile = path.join(root, 'inbox', 'builder-a.jsonl');
  const complete = JSON.stringify({ ts: '2026-10-10T11:30:00', from: 'pm', to: 'builder-a', text: 'private message body', task: 'T-0001' });
  await fs.promises.writeFile(inboxFile, `${complete}\n{"partial":`, { mode: 0o600 });
  await fs.promises.writeFile(path.join(root, 'tasks', 'T-0002.json.tmp'), '{"private":"ignored"}', { mode: 0o600 });
  const before = await fs.promises.readFile(inboxFile, 'utf8');
  const snapshot = projectSnapshot({ root, now: () => NOW, includeInbox: true });
  assert.equal(snapshot.team.status, 'active');
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].priority, 0);
  assert.equal(snapshot.tasks[0].messageCount, 1);
  assert.equal(snapshot.tasks[0].briefPresent, true);
  assert.equal(snapshot.tasks[0].reportPresent, true);
  assert.equal(snapshot.reviews.length, 1);
  assert.equal(snapshot.messages.length, 1, 'incomplete final JSONL line is ignored');
  assert.equal(snapshot.messages[0].bodyPresent, true);
  assert.deepEqual(snapshot.members, [], 'task and inbox names never become canonical members');
  assert.equal(snapshot.tasks[0].ownerMemberId, null);
  assert.deepEqual(snapshot.tasks[0].reviewerMemberIds, []);
  assert.equal(snapshot.reviews[0].reviewerMemberId, null);
  const serialized = JSON.stringify(snapshot);
  for (const secret of ['private/brief.md', 'private/report-secret.md', 'private/review-secret.md', 'private message body',
    'private review note', 'private history text', path.resolve(root), 'T-0001']) assert.equal(serialized.includes(secret), false, secret);
  assert.equal((await fs.promises.readFile(inboxFile, 'utf8')), before, 'reader made no source writes');
  assert.match(snapshot.tasks[0].id, /^task_[a-f0-9]{32}$/);
  assert.match(snapshot.messages[0].id, /^message_[a-f0-9]{32}$/);
}));

test('null reviewer verdicts project as pending and one malformed task is counted without hiding valid tasks', async () => withRoot(async root => {
  await putTask(root, 'T-0001', task({ reviewers: { critic: null }, reviews: [] }));
  await putTask(root, 'T-0002', { id: 'T-0002', title: '', state: 'working' });
  const events = [];
  const reader = createTeamStoreReader({ root, now: () => NOW, log: event => events.push(event) });
  const snapshot = await reader.refresh();
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].reviewerMemberIds.length, 0, 'an unregistered reviewer has no stable member ID');
  assert.equal(snapshot.reviews.length, 1);
  assert.equal(snapshot.reviews[0].verdict, 'pending');
  assert.equal(snapshot.reviews[0].reviewerMemberId, null);
  assert.equal(snapshot.diagnostics.skippedTaskCount, 1);
  assert.deepEqual(events, [{ event: 'team.tasks.partial', skippedTaskCount: 1 }], 'a redacted partial-read warning is emitted once per changed count');
  assert.equal(JSON.stringify(events).includes('T-0002'), false, 'log event excludes task identifiers');
  assert.equal(JSON.stringify(events).includes(root), false, 'log event excludes source paths');
  await reader.refresh();
  assert.equal(events.length, 1, 'repeated polling does not flood logs');
  reader.close?.();
}));

test('long CLI task titles and empty or large review notes are accepted within the source-file bound', async () => withRoot(async root => {
  const title = 'A legitimately long task title '.repeat(35).trimEnd();
  const note = 'review note '.repeat(2500);
  await putTask(root, 'T-0001', task({ title, reviews: [{ ts: '2026-10-10T11:00:00', by: 'critic', verdict: 'go', note: '' }] }));
  await putTask(root, 'T-0002', task({ id: 'T-0002', title: 'Large private note', reviews: [{ ts: '2026-10-10T11:00:00', by: 'critic', verdict: 'go', note }] }));
  const snapshot = projectSnapshot({ root, now: () => NOW });
  assert.equal(snapshot.tasks.length, 2);
  assert.equal(snapshot.diagnostics.skippedTaskCount, 0);
  assert.equal(snapshot.tasks.find(row => row.title === title)?.title, title);
  assert.equal(JSON.stringify(snapshot).includes(note), false, 'accepted review notes stay private');
}));

test('inbox files are not even inspected unless the owner explicitly enables inbox metadata', async () => withRoot(async root => {
  const inbox = path.join(root, 'inbox');
  const outside = path.join(path.dirname(root), `ao-inbox-private-${path.basename(root)}`);
  await fs.promises.rm(inbox, { recursive: true, force: true });
  await fs.promises.mkdir(outside);
  await fs.promises.writeFile(path.join(outside, 'pm.jsonl'), JSON.stringify({ ts: '2026-10-10T11:30:00', from: 'owner', text: 'private-inbox-canary' }) + '\n', { mode: 0o600 });
  await fs.promises.symlink(outside, inbox);
  try {
    await putTask(root, 'T-0001', task({ created_by: 'unregistered-pm', owner: 'unregistered-builder',
      reviewers: { 'unregistered-reviewer': null }, reviews: [{ ts: '2026-10-10T10:30:00', by: 'unregistered-reviewer', verdict: 'pending' }] }));
    const snapshot = projectSnapshot({ root, now: () => NOW });
    assert.equal(snapshot.team.status, 'active', 'default reader does not stat, enumerate, or read inbox');
    assert.equal(snapshot.messages.length, 0);
    assert.equal(JSON.stringify(snapshot).includes('private-inbox-canary'), false);
    assert.throws(() => projectSnapshot({ root, now: () => NOW, includeInbox: true }), TeamStoreReadError);
  } finally { await fs.promises.rm(outside, { recursive: true, force: true }); }
}));

test('reads stable member records and keeps exact pane/session/lineage references private', async () => {
  const ids = ['member:11111111-1111-4111-8111-111111111111', 'member:22222222-2222-4222-8222-222222222222', 'member:33333333-3333-4333-8333-333333333333'];
  await withRoot(async root => {
    await fs.promises.mkdir(path.join(root, 'members'));
    const rows = [
      { id: ids[0], name: 'pm', role: 'pm', runtime: 'claude', herdrPane: 'pane-pm', session: { source: 'herdr:claude', kind: 'agent_session', value: 'claude-session-pm' }, spawnedBy: null },
      { id: ids[1], name: 'builder', role: 'builder', runtime: 'codex', herdrPane: 'pane-builder', session: { source: 'herdr:codex', kind: 'agent_session', value: 'codex-session-builder' }, spawnedBy: ids[0] },
      { id: ids[2], name: 'critic', role: 'reviewer', runtime: 'cursor', herdrPane: 'pane-critic', session: { source: 'herdr:cursor', kind: 'agent_session', value: 'cursor-session-critic' }, spawnedBy: ids[0] },
    ];
    for (const row of rows) await fs.promises.writeFile(path.join(root, 'members', `${row.name}.json`), JSON.stringify(row), { mode: 0o600 });
    await putTask(root, 'T-0001', task({ created_by: 'unregistered-pm', owner: 'unregistered-builder',
      reviewers: { 'unregistered-reviewer': null }, reviews: [{ ts: '2026-10-10T10:30:00', by: 'unregistered-reviewer', verdict: 'pending' }] }));
    const snapshot = projectSnapshot({ root, now: () => NOW });
    assert.deepEqual(snapshot.members.map(row => row.id).sort(), [...ids].sort());
    assert.deepEqual(snapshot.members.map(row => row.name).sort(), ['builder', 'critic', 'pm']);
    assert.equal(snapshot.members.find(row => row.id === ids[0]).roleKind, 'lead');
    assert.equal(snapshot.members.find(row => row.id === ids[0]).roleLabel, 'pm');
    assert.equal(snapshot.members.find(row => row.id === ids[0]).runtimeKind, 'claude-code');
    assert.equal(snapshot.members.find(row => row.id === ids[1]).runtimeKind, 'codex');
    assert.equal(snapshot.members.find(row => row.id === ids[2]).runtimeKind, 'cursor');
    assert.equal(snapshot.members.find(row => row.id === ids[1]).parentMemberId, ids[0]);
    assert.deepEqual(snapshot.members.map(row => row.name).sort(), ['builder', 'critic', 'pm'], 'task names do not add phantom members');
    assert.equal(snapshot.tasks[0].ownerMemberId, null, 'unregistered owner remains unresolved');
    assert.deepEqual(snapshot.tasks[0].reviewerMemberIds, [], 'unregistered reviewer remains unresolved');
    assert.equal(snapshot.reviews[0].reviewerMemberId, null, 'unregistered reviewer remains unresolved');
    assert.equal(JSON.stringify(snapshot).includes('claude-session-pm'), false);
    assert.equal(JSON.stringify(snapshot).includes('pane-builder'), false);
    assert.equal(snapshot.privateMemberRefs[ids[1]].spawnedBy, ids[0]);
  });
});

test('keeps an identity-only member and counts a genuinely malformed member without discarding the team', async () => withRoot(async root => {
  const members = path.join(root, 'members'); await fs.promises.mkdir(members);
  const identityOnly = { id: 'member:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'connect-ux' };
  await fs.promises.writeFile(path.join(members, 'connect-ux.json'), JSON.stringify(identityOnly), { mode: 0o600 });
  await fs.promises.writeFile(path.join(members, 'broken.json'), JSON.stringify({ id: 'not-an-id', name: 'Malformed' }), { mode: 0o600 });
  const duplicated = { id: 'member:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Ambiguous record' };
  await fs.promises.writeFile(path.join(members, 'duplicate-a.json'), JSON.stringify(duplicated), { mode: 0o600 });
  await fs.promises.writeFile(path.join(members, 'duplicate-b.json'), JSON.stringify(duplicated), { mode: 0o600 });
  const events = [];
  const reader = createTeamStoreReader({ root, now: () => NOW, log: event => events.push(event) });
  try {
    const snapshot = await reader.refresh();
    assert.equal(snapshot.team.status, 'active', 'one incomplete record does not invalidate the source');
    assert.deepEqual(snapshot.members.map(row => ({ id: row.id, name: row.name, roleKind: row.roleKind, runtimeKind: row.runtimeKind,
      hostAgentId: row.hostAgentId })), [{ id: identityOnly.id, name: identityOnly.name, roleKind: 'unknown', runtimeKind: null, hostAgentId: null }]);
    assert.equal(snapshot.privateMemberRefs[identityOnly.id].session, null);
    assert.equal(snapshot.diagnostics.skippedMemberCount, 3, 'malformed and conflicting identity rows are counted');
    assert.deepEqual(events, [{ event: 'team.members.partial', skippedMemberCount: 3 }]);
    assert.equal(JSON.stringify(events).includes('broken.json'), false);
    assert.equal(JSON.stringify(events).includes(root), false);
  } finally { reader.stop(); }
}));

test('adapter derives an unlabelled lead only from stable parent/child structure', async () => withRoot(async root => {
  await fs.promises.mkdir(path.join(root, 'members'));
  const lead = 'member:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const child = 'member:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const common = { runtime: 'codex', session: { source: 'herdr:codex', kind: 'agent_session', value: 'opaque-session' } };
  await fs.promises.writeFile(path.join(root, 'members', 'coordinator.json'), JSON.stringify({ ...common, id: lead,
    name: 'Coordinator', herdrPane: 'pane-root', spawnedBy: null }));
  await fs.promises.writeFile(path.join(root, 'members', 'analyst.json'), JSON.stringify({ ...common, id: child,
    name: 'Analyst', herdrPane: 'pane-child', spawnedBy: lead }));
  const snapshot = projectSnapshot({ root, now: () => NOW });
  const byId = new Map(snapshot.members.map(member => [member.id, member]));
  assert.deepEqual({ roleKind: byId.get(lead).roleKind, roleLabel: byId.get(lead).roleLabel, roleEvidence: byId.get(lead).roleEvidence },
    { roleKind: 'lead', roleLabel: null, roleEvidence: 'derived-from-structure' });
  assert.deepEqual({ roleKind: byId.get(child).roleKind, roleLabel: byId.get(child).roleLabel, roleEvidence: byId.get(child).roleEvidence },
    { roleKind: 'member', roleLabel: null, roleEvidence: 'derived-from-structure' });
}));

test('stable record IDs do not depend on filenames and duplicate display names are never guessed', async () => withRoot(async root => {
  const members = path.join(root, 'members');
  await fs.promises.mkdir(members);
  await putTask(root, 'T-0001', task({ owner: 'shared', reviewers: { shared: 'pending' }, reviews: [] }));
  const records = [
    { id: 'member:11111111-1111-4111-8111-111111111111', name: 'shared', role: 'builder', runtime: 'codex', herdrPane: 'pane-a', session: { source: 'herdr:codex', kind: 'agent_session', value: 'session-a' } },
    { id: 'member:22222222-2222-4222-8222-222222222222', name: 'shared', role: 'reviewer', runtime: 'cursor', herdrPane: 'pane-b', session: { source: 'herdr:cursor', kind: 'agent_session', value: 'session-b' } },
  ];
  await fs.promises.writeFile(path.join(members, 'record-a.json'), JSON.stringify(records[0]), { mode: 0o600 });
  await fs.promises.writeFile(path.join(members, 'record-b.json'), JSON.stringify(records[1]), { mode: 0o600 });
  const snapshot = projectSnapshot({ root, now: () => NOW });
  assert.deepEqual(snapshot.members.filter(row => row.name === 'shared').map(row => row.id).sort(), records.map(row => row.id).sort());
  assert.equal(snapshot.tasks[0].ownerMemberId, null);
  assert.deepEqual(snapshot.tasks[0].reviewerMemberIds, []);
}));

test('configured root label is explicit and missing/empty task and inbox directories are handled safely', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ao-team-empty-fixture-'));
  try {
    const snapshot = projectSnapshot({ root, label: 'Selected workspace', now: () => NOW });
    assert.equal(snapshot.team.label, 'Selected workspace');
    assert.equal(snapshot.tasks.length, 0);
    assert.equal(snapshot.messages.length, 0);
    assert.equal(snapshot.members.length, 0);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('same source task IDs in separate selected roots produce distinct canonical IDs', async () => {
  const roots = await Promise.all([0, 1].map(() => fs.promises.mkdtemp(path.join(os.tmpdir(), 'ao-team-scope-fixture-'))));
  try {
    for (const root of roots) { await fs.promises.mkdir(path.join(root, 'tasks')); await fs.promises.mkdir(path.join(root, 'inbox')); await putTask(root); }
    const [a, b] = roots.map(root => projectSnapshot({ root, now: () => NOW }));
    assert.notEqual(a.team.id, b.team.id);
    assert.notEqual(a.tasks[0].id, b.tasks[0].id);
    assert.deepEqual(a.members, []);
    assert.deepEqual(b.members, []);
  } finally { await Promise.all(roots.map(root => fs.promises.rm(root, { recursive: true, force: true }))); }
});

test('default reader runs the synthetic store scan in an isolated worker and returns canonical entities', async () => withRoot(async root => {
  await putTask(root);
  const reader = createTeamStoreReader({ root, now: () => NOW });
  const snapshot = await reader.refresh();
  assert.equal(snapshot.team.status, 'active');
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].priority, 0);
  assert.equal(reader.current, snapshot);
  assert.equal(snapshot.team.constructor.name, 'Team');
}));

test('reader retains only a bounded stale snapshot, backs off, and clears after expiry', async () => withRoot(async root => {
  await putTask(root);
  let time = NOW; let fail = false;
  const reader = createTeamStoreReader({ root, now: () => time,
    scan: async options => { if (fail) throw new TeamStoreReadError('invalid_store'); return projectSnapshot({ root, now: () => options.nowMs }); } });
  const good = await reader.refresh();
  fail = true; time += 1500;
  const stale = await reader.refresh();
  assert.equal(stale.team.status, 'stale');
  assert.equal(stale.tasks.length, 1);
  assert.equal((await reader.refresh()).diagnostics.status, 'backoff');
  time += 120_000;
  const expired = await reader.refresh();
  assert.equal(expired.team, null);
  assert.equal(expired.tasks.length, 0);
  assert.notEqual(reader.current, good);
}));

test('team poll scheduler is clamped and disabled sources cannot restart', async () => withRoot(async root => {
  const reader = createTeamStoreReader({ root, now: () => NOW, scan: async options => projectSnapshot({ root, now: () => options.nowMs }) });
  assert.equal(reader.start({ intervalMs: 1 }), MIN_POLL_INTERVAL_MS);
  reader.disable();
  assert.equal(reader.start({ intervalMs: MAX_POLL_INTERVAL_MS + 1 }), false);
  reader.enable();
  assert.equal(reader.start({ intervalMs: MAX_POLL_INTERVAL_MS + 1 }), MAX_POLL_INTERVAL_MS);
  reader.stop();
}));

test('unknown source fields are counted, ignored, and never copied into canonical output', async () => withRoot(async root => {
  await putTask(root, 'T-0001', task({ prompt: 'unique-private-canary', reviews: undefined }));
  const snapshot = projectSnapshot({ root, now: () => NOW });
  assert.equal(snapshot.diagnostics.unknownFields, 1);
  assert.equal(JSON.stringify(snapshot).includes('unique-private-canary'), false);
  assert.equal(snapshot.tasks.length, 1, 'older task rows without review arrays are supported');
}));

test('an unsupported task is counted and skipped while the rest of the team snapshot remains available', async () => withRoot(async root => {
  await putTask(root);
  await putTask(root, 'T-0002', task({ id: 'T-0002', state: 'unknown-state' }));
  const reader = createTeamStoreReader({ root, now: () => NOW });
  const result = await reader.refresh();
  assert.equal(result.team.status, 'active');
  assert.equal(result.tasks.length, 1);
  assert.equal(result.diagnostics.skippedTaskCount, 1);
  assert.equal(reader.current, result);
}));

test('symlinked task files and source directories fail closed without following outside the selected root', async () => withRoot(async root => {
  const outside = path.join(path.dirname(root), `ao-outside-${path.basename(root)}.json`);
  try {
    await fs.promises.writeFile(outside, JSON.stringify(task()), { mode: 0o600 });
    await fs.promises.symlink(outside, path.join(root, 'tasks', 'T-0001.json'));
    const result = await createTeamStoreReader({ root, now: () => NOW }).refresh();
    assert.equal(result.team, null);
    assert.equal(result.diagnostics.status, 'unsafe_file');
  } finally { await fs.promises.rm(outside, { force: true }); }
}));

test('symlinked selected subdirectories are refused', async () => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ao-team-directory-fixture-'));
  const root = path.join(parent, 'root'); const outside = path.join(parent, 'outside');
  try {
    await fs.promises.mkdir(root); await fs.promises.mkdir(outside);
    await fs.promises.mkdir(path.join(root, 'inbox'));
    await fs.promises.symlink(outside, path.join(root, 'tasks'));
    const result = await createTeamStoreReader({ root, now: () => NOW }).refresh();
    assert.equal(result.team, null);
    assert.equal(result.diagnostics.status, 'unsafe_root');
  } finally { await fs.promises.rm(parent, { recursive: true, force: true }); }
});

test('oversized task files and over-deep JSON are refused before projection', async () => withRoot(async root => {
  const giant = task({ ignored: 'x'.repeat(LIMITS.taskBytes + 1) });
  await putTask(root, 'T-0001', giant);
  let result = await createTeamStoreReader({ root, now: () => NOW }).refresh();
  assert.equal(result.diagnostics.status, 'unsafe_file');
  await fs.promises.rm(path.join(root, 'tasks', 'T-0001.json'));
  const deep = JSON.parse('['.repeat(40) + '0' + ']'.repeat(40));
  await putTask(root, 'T-0001', task({ ignored: deep }));
  result = await createTeamStoreReader({ root, now: () => NOW }).refresh();
  assert.equal(result.diagnostics.status, 'depth_limit');
}));

test('aggregate read cap rejects a root before returning any rows', async () => withRoot(async root => {
  const padding = 'p'.repeat(950_000);
  for (let i = 1; i <= 9; i++) await putTask(root, `T-${String(i).padStart(4, '0')}`, task({
    id: `T-${String(i).padStart(4, '0')}`, title: `task-${i}`, reviews: [], ignored: padding,
  }));
  const result = await createTeamStoreReader({ root, now: () => NOW }).refresh();
  assert.equal(result.team, null);
  assert.equal(result.diagnostics.status, 'root_limit');
  assert.ok(LIMITS.rootBytes < 9 * LIMITS.taskBytes);
}));
