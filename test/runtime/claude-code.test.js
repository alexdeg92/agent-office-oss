'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const A = require('../../src/adapters/claude-code'), { createFiles, BOUNDS } = require('../../src/adapters/claude-code/files');
const { createEngine } = require('../../src/engine');
const { buildOfficeVM, createStateTracker } = require('../../src/api/v2/vm/office');
const { project3x } = require('../../src/api/v2/project3x');
const NOW = 1791600000000;
const record = (id, text = 'Synthetic transcript', extra = {}) => ({ type: 'user', uuid: id + '-event', sessionId: id,
  timestamp: new Date(NOW - 1000).toISOString(), message: { role: 'user', content: text }, ...extra });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-claude-synthetic-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = (project, id, rows = [record(id)]) => { const dir = path.join(home, 'projects', project); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, id + '.jsonl'); fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); return f; };
  return { home, file };
}
test('detected Claude settings prefill the detected home directory', t => {
  const h = fixture(t), values = A.setup.settings.detectedValues({ checkedPaths: [path.join(h.home, '.claude')] });
  assert.equal(values.home, path.join(h.home, '.claude'));
  assert.equal(values.include, '');
  assert.equal(values.exclude, '');
});

test('real-shaped synthetic transcripts skip unknown Claude records and keys, retain known content and probe as connected', async t => {
  const h = fixture(t), home = path.join(h.home, 'home', '.claude');
  const project = path.join(home, 'projects', 'encoded-synthetic-project'); fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, 'synthetic-real-shaped-session.jsonl'), at = new Date(NOW).toISOString();
  const metadataTypes = ['attachment', 'mode', 'permission-mode', 'atis-latch', 'last-prompt', 'ai-title', 'queue-operation'];
  const rows = metadataTypes.map((type, i) => ({ type, sessionId: 'synthetic-real-shaped-session', timestamp: at,
    uuid: `metadata-${i}`, futureTopLevelKey: { privateButSynthetic: true }, attachment: { id: `attachment-${i}` },
    ...(type === 'last-prompt' ? { lastPrompt: 'SYNTHETIC_PRIVATE_PROMPT' } : {}),
    ...(type === 'ai-title' ? { title: 'SYNTHETIC_PRIVATE_TITLE' } : {}) }));
  rows.push({ type: 'assistant', sessionId: 'synthetic-real-shaped-session', session_id: 'synthetic-real-shaped-session',
    timestamp: at, parentUuid: null, isSidechain: false, uuid: 'assistant-1', userType: 'external', entrypoint: 'cli',
    cwd: '/synthetic/private/project-name', version: '1.0.0', gitBranch: 'synthetic-branch', apiBlockIndex: 0,
    requestId: 'synthetic-request', advisorModel: 'synthetic-model', effort: 'medium', perTurnEffort: 'low',
    rendered: true, renderedRole: 'assistant', promptId: 'synthetic-prompt', wireToolInputs: {}, toolUseResult: null,
    sourceToolAssistantUUID: null, thinkingDurationMs: 3, permissionMode: 'default', mode: 'normal', atis: {}, lastPrompt: 'synthetic private prompt',
    futureTopLevelKey: { ignored: true }, message: { role: 'assistant', type: 'message', model: 'synthetic-model', id: 'synthetic-message',
      content: [ { type: 'thinking', thinking: 'Synthetic private reasoning', futureBlockKey: 'ignored' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/synthetic/project/file.txt' } },
        { type: 'future-rich-block', payload: 'synthetic ignored payload' },
        { type: 'text', text: 'Synthetic assistant reply', citations: [] } ],
      container: null, stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
      usage: { input_tokens: 2, output_tokens: 3, futureUsageKey: 9 }, input_transformations: [], diagnostics: [], context_management: {}, futureMessageKey: true } });
  rows.push({ type: 'system', sessionId: 'synthetic-real-shaped-session', timestamp: at, uuid: 'system-1', parentUuid: 'assistant-1',
    message: { role: 'system', content: [{ type: 'text', text: 'Synthetic system notice' }] } });
  rows.push({ type: 'user', session_id: 'synthetic-real-shaped-session', timestamp: at, uuid: 'user-1', parentUuid: 'system-1',
    cwd: '/synthetic/private/project-name', isSidechain: true, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'Synthetic tool result' }, { type: 'image', source: { data: 'synthetic' } }], is_error: false },
      { type: 'text', text: 'Synthetic follow-up' } ], futureMessageKey: 'ignored' } });
  rows.push({ type: 'future-line-type', futurePayload: 'synthetic ignored record' });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const files = createFiles({ home }); t.after(() => files.close());
  await files.scan(); const sessionKey = files.rows()[0].key, trace = await files.read(sessionKey);
  assert.equal(files.rows()[0].displayName, 'SYNTHETIC_PRIVATE_TITLE');
  assert.equal(files.rows()[0].summary, 'SYNTHETIC_PRIVATE_TITLE');
  assert.ok(trace.events.some(event => event.text === 'Synthetic assistant reply'));
  assert.ok(trace.events.some(event => event.text === 'Synthetic private reasoning'));
  const call = trace.events.find(event => event.kind === 'tool');
  assert.equal(call?.output, 'Synthetic tool result');
  assert.equal(call?.isError, false);
  assert.ok(trace.events.some(event => event.text === 'Synthetic system notice' && event.kind === 'system'));
  assert.ok(trace.events.some(event => event.text === 'Synthetic follow-up' && event.kind === 'system'), 'sidechain prompts stay system content');
  assert.equal(JSON.stringify(trace).includes('SYNTHETIC_PRIVATE_PROMPT'), false);
  assert.equal(JSON.stringify(trace).includes('SYNTHETIC_PRIVATE_TITLE'), false);
  assert.equal(files.stats.metadataLines, metadataTypes.length);
  assert.equal(files.stats.unknownLineTypes, 1);
  assert.ok(files.stats.unknownKeys >= 4);
  assert.equal(files.stats.unknownContentBlocks, 2);
  assert.equal(files.stats.recognizedLines, 3);
  const probe = await A.setup.settings.probe({ runtime: { home } });
  assert.equal(probe.status, 'connected'); assert.equal(probe.projectCount, 1); assert.equal(probe.fileCount, 1);
});

test('Claude agent summaries use ai-title or only the first line of the first prompt', async t => {
  const h = fixture(t), titleFile = h.file('synthetic-title-project', 'title-session', [
    { type: 'user', sessionId: 'title-session', uuid: 'u1', timestamp: new Date(NOW - 3000).toISOString(), cwd: '/private/title-project', message: { role: 'user', content: 'First prompt line\nsecond line must not leak' } },
    { type: 'ai-title', sessionId: 'title-session', timestamp: new Date(NOW - 1000).toISOString(), title: 'Plan de migration' },
  ]);
  const fallbackFile = h.file('synthetic-fallback-project', 'fallback-session', [
    { type: 'user', sessionId: 'fallback-session', uuid: 'u2', timestamp: new Date(NOW - 1000).toISOString(), cwd: '/private/fallback-project', message: { role: 'user', content: 'Résumé synthétique password=synthetic-secret\nNEVER SHOW THIS SECOND LINE' } },
  ]);
  const files = createFiles({ home: h.home }); t.after(() => files.close()); await files.scan();
  for (const row of files.rows()) await files.read(row.key);
  const rows = files.rows();
  assert.equal(rows.find(r => r.file === titleFile).displayName, 'Plan de migration');
  assert.equal(rows.find(r => r.file === titleFile).summary, 'Plan de migration');
  const fallback = rows.find(r => r.file === fallbackFile);
  assert.equal(fallback.displayName, null);
  assert.equal(fallback.summary, 'Résumé synthétique password=…');
  assert.ok(!fallback.summary.includes('NEVER SHOW'));
});

test('Claude connection probe counts projects independently of runtime agent grouping', async t => {
  const h = fixture(t), home = h.home;
  h.file('synthetic-project-one', 'session-one');
  h.file('synthetic-project-two', 'session-two');
  const probe = await A.setup.settings.probe({ runtime: { home, agentGrouping: 'runtime' } });
  assert.equal(probe.status, 'connected');
  assert.equal(probe.projectCount, 2);
  assert.equal(probe.fileCount, 2);
});

test('a synthetic folder with no recognizable session lines reports a private reason code and checked file count', async t => {
  const h = fixture(t), home = path.join(h.home, 'home', '.claude');
  const project = path.join(home, 'projects', 'encoded-synthetic-project'); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'metadata-only.jsonl'), [
    { type: 'mode', mode: 'synthetic-private-mode', privatePrompt: 'SYNTHETIC_PRIVATE_SENTINEL' },
    { type: 'future-line-type', futurePayload: 'SYNTHETIC_PRIVATE_SENTINEL' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const probe = await A.setup.settings.probe({ runtime: { home } });
  assert.equal(probe.status, 'unsupported-format');
  assert.equal(probe.reasonCode, 'no-recognizable-session-lines');
  assert.equal(probe.fileCount, 1);
  assert.equal(JSON.stringify(probe).includes('SYNTHETIC_PRIVATE_SENTINEL'), false);
});

test('automatic transcript remediation retries the failed file directly, then reports a terminal target without looping', async t => {
  const h = fixture(t), bad = h.file('synthetic-unrecognized-project', 'unsupported-synthetic-session', [
    { type: 'future-line-type', privatePayload: 'SYNTHETIC_PRIVATE_SENTINEL' },
  ]);
  const runtime = A.createRuntime({ runtimeConfig: { claudeCode: { home: h.home } } }, { now: () => NOW });
  const engine = createEngine({ adapter: runtime.definition, now: () => NOW });
  t.after(() => runtime.close()); runtime.attach(engine); await runtime.start(engine);
  const check = engine.healthChecks().find(row => row.active && row.causeCode === 'format');
  assert.ok(check, 'the unsupported synthetic tail becomes a health check');
  const first = await engine.runHealthRemedy(check.id, { automatic: true });
  assert.equal(first.ok, false);
  const stopped = engine.healthChecks().find(row => row.id === check.id);
  assert.equal(stopped.remedy, 'none');
  assert.equal(stopped.target, 'transcript', 'the health target is a safe generic label, never filesystem metadata');
  const attemptsBytes = runtime.files.stats.reads;
  await runtime.cycle(); await runtime.cycle();
  assert.equal(runtime.files.stats.reads, attemptsBytes, 'known unsupported content is not reread on every adapter cycle');
  await engine.startHealthLoop(10000);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(engine.healthAudit().length, 1, 'scheduled health scans do not launch another repair');
  assert.equal(fs.existsSync(bad), true);
  assert.ok(!JSON.stringify(engine.healthChecks()).includes('SYNTHETIC_PRIVATE_SENTINEL'));
});

test('a corrected synthetic transcript invalidates terminal format state and the targeted remedy succeeds', async t => {
  const h = fixture(t), file = h.file('synthetic-repaired-project', 'repairable-synthetic-session', [
    { type: 'future-line-type', privatePayload: 'SYNTHETIC_PRIVATE_SENTINEL' },
  ]);
  const runtime = A.createRuntime({ runtimeConfig: { claudeCode: { home: h.home } } }, { now: () => NOW });
  const engine = createEngine({ adapter: runtime.definition, now: () => NOW });
  t.after(() => runtime.close()); runtime.attach(engine); await runtime.start(engine);
  const check = engine.healthChecks().find(row => row.active && row.causeCode === 'format');
  assert.ok(check);
  fs.writeFileSync(file, JSON.stringify(record('repairable-synthetic-session', 'Now readable synthetic content')) + '\n');
  const result = await engine.runHealthRemedy(check.id, { automatic: true });
  assert.equal(result.ok, true);
  assert.equal(engine.healthChecks().some(row => row.id === check.id && row.active), false);
});

test('the bounded synthetic probe completes a multi-window file before calling its format unsupported', async t => {
  const h = fixture(t), home = path.join(h.home, 'home', '.claude'), project = path.join(home, 'projects', 'synthetic-large-project');
  fs.mkdirSync(project, { recursive: true });
  const rows = Array.from({ length: 11000 }, () => ({ type: 'future-line-type', privatePayload: 'x'.repeat(96) }));
  fs.writeFileSync(path.join(project, 'synthetic-large-session.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const probe = await A.setup.settings.probe({ runtime: { home } });
  assert.equal(probe.status, 'unsupported-format');
  assert.equal(probe.reasonCode, 'no-recognizable-session-lines');
  assert.equal(probe.fileCount, 1);
  assert.equal(probe.unknownLineTypeCount, rows.length);
});

test('project labels use only a validated cwd basename, keep opaque identity, and discovery agrees with live agents', async t => {
  const h = fixture(t), privateRoot = '/srv/private-owner-sentinel';
  const cwd = privateRoot + '/agent-office-portal';
  const file = h.file('custom-storage-key', 'label-main', [record('label-main', 'Synthetic', { cwd })]);
  h.file('another-storage-key', 'label-other', [record('label-other', 'Synthetic', { cwd: '/different-private-root/agent-office-portal' })]);
  h.file('windows-key', 'label-windows', [record('label-windows', 'Synthetic', { cwd: 'C:\\synthetic-private-root\\windows-project\\' })]);
  for (const [n, invalid] of [null, {}, 'relative/project', '/', '/srv/..', '/srv/bad\nname', '/srv/' + 'x'.repeat(256)].entries())
    h.file('invalid-key-' + n, 'invalid-' + n, [record('invalid-' + n, 'Synthetic', { cwd: invalid })]);
  const discovered = await A.setup.discover({ runtime: { home: h.home } });
  const runtime = A.createRuntime({ runtimeConfig: { claudeCode: { home: h.home } } }, { now: () => NOW });
  const engine = createEngine({ adapter: runtime.definition, now: () => NOW });
  t.after(() => runtime.close()); runtime.attach(engine); await runtime.start(engine);
  const labels = rows => rows.map(a => [a.id, a.name]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(labels(engine.agents()), labels(discovered));
  const portals = engine.agents().filter(a => a.name === 'agent-office-portal');
  assert.equal(portals.length, 2); assert.notEqual(portals[0].id, portals[1].id, 'same basename never merges project identities');
  assert.ok(engine.agents().some(a => a.name === 'windows-project'));
  assert.equal(engine.agents().filter(a => /^Project [a-f0-9]{12}$/.test(a.name)).length, 7, 'unknown cwd uses a safe fallback');
  assert.ok(!JSON.stringify([engine.agents(), engine.sessions()]).includes(privateRoot));
  assert.ok(engine.agents().every(a => a.workspace === null)); assert.ok(engine.sessions().every(s => s.cwd === null));
  const id = portals.find(a => a.mainSessionKey === runtime.files.rows().find(r => r.sessionId === 'label-main').key).id;
  fs.appendFileSync(file, JSON.stringify(record('label-main', 'Changed working directory', { uuid: 'cwd-change', cwd: cwd + '/src' })) + '\n');
  await runtime.cycle(); assert.equal(engine.agents().find(a => a.id === id).name, 'agent-office-portal', 'later cwd changes do not rename the project');
  fs.renameSync(file, file + '.old'); fs.writeFileSync(file, JSON.stringify(record('label-main', 'New generation', { cwd: privateRoot + '/renamed-project' })) + '\n');
  await runtime.cycle(); assert.equal(engine.agents().find(a => a.id === id).name, 'renamed-project', 'rotation resets label metadata, keeping identity');
});
test('Claude JSONL maps transcript run evidence, stable trace IDs, and an open read turn as researching', async t => {
  const h = fixture(t), id = 'session-a';
  const file=h.file('project-one', id, [record(id), record(id, '', { type: 'assistant', uuid: 'assistant-event', message: { role: 'assistant', model: 'synthetic-model',
    content: [{ type: 'thinking', thinking: 'Synthetic thought' }, { type: 'tool_use', id: 'call-one', name: 'Read', input: { path: 'synthetic.txt' } }] } })]);
  const runtime = A.createRuntime({ runtimeConfig: { claudeCode: { home: h.home } } }, { now: () => NOW }), engine = createEngine({ adapter: runtime.definition, now: () => NOW });
  t.after(() => runtime.close()); runtime.attach(engine); await runtime.start(engine);
  const session = engine.sessions()[0]; assert.deepEqual([session.run.status, session.run.evidence, session.run.evidenceLevel], ['running', 'live-activity', 'observed']);
  assert.equal(session.run.expiresAt, NOW - 1000 + 30000, 'open transcript turns carry the bounded recency lease');
  const office = buildOfficeVM({ engine, canReadSessions: true, now: NOW, tracker: createStateTracker(), actorOf: x => x, P: project3x });
  assert.ok(office.occupants.some(o => o.state === 'researching'), 'an open Read tool turn renders its safe rich activity in Office');
  assert.ok(office.occupants.every(o => o.state !== 'unknown'), 'sessions with transcript state do not render Unknown');
  assert.ok(office.occupants.some(o => o.execution.status === 'running' && o.execution.evidence.level === 'observed'));
  let trace = engine.transcript(session.key); assert.equal(trace.events.length, 3); assert.equal(trace.events.find(e => e.kind === 'tool').output, '');
  fs.appendFileSync(file, JSON.stringify(record(id, '', { uuid: 'result-event', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-one', content: 'Synthetic result' }] } })) + '\n');
  await runtime.cycle();
  const completedRead = buildOfficeVM({ engine, canReadSessions: true, now: NOW, tracker: createStateTracker(), actorOf: x => x, P: project3x });
  assert.ok(completedRead.occupants.some(o => o.state === 'thinking'), 'a completed tool result returns the agent to thinking');
  trace = engine.transcript(session.key); assert.equal(trace.events.length, 3); assert.equal(trace.events.find(e => e.kind === 'tool').output, 'Synthetic result');
  assert.equal(trace.events.find(e => e.kind === 'tool').callId, 'call-one'); assert.equal(trace.events[0].senderInfo.name, null);
  assert.equal(engine.quarantine.counts().open.error, 0);
  const before = trace.events.map(e => e.id); assert.equal((await engine.request('transcript', session.key)).ok, true);
  assert.deepEqual(engine.transcript(session.key).events.map(e => e.id), before);
  fs.appendFileSync(file,JSON.stringify(record(id,'New synthetic turn',{uuid:'new-turn'}))+'\n'); await runtime.cycle();
  assert.equal(engine.activity(session.key).source,'transcript');
});

test('Claude transcript activity maps safe thinking/tool/permission evidence into both Office contracts', async t => {
  const { mapRecord } = require('../../src/adapters/claude-code/profile');
  const assistant = (kind, name = null) => ({ type: 'assistant', sessionId: 'synthetic-activity-session', uuid: `event-${kind}-${name || ''}`,
    timestamp: new Date(NOW - 1000).toISOString(), message: { role: 'assistant', stop_reason: null, content: kind === 'thinking'
      ? [{ type: 'thinking', thinking: 'SYNTHETIC_PRIVATE_REASONING' }]
      : [{ type: 'tool_use', id: 'synthetic-call', name, input: { file_path: '/private/synthetic-secret' } }] } });
  const cases = [
    [assistant('thinking'), 'thinking'], [assistant('tool', 'Read'), 'researching'], [assistant('tool', 'Edit'), 'writing'], [assistant('tool', 'Bash'), 'executing'],
    [{ type: 'system', subtype: 'user_input_request', sessionId: 'synthetic-activity-session', uuid: 'event-wait', timestamp: new Date(NOW - 1000).toISOString(), message: { role: 'system', content: 'Synthetic request' } }, 'waiting'],
    [{ type: 'system', subtype: 'permission_request', sessionId: 'synthetic-activity-session', uuid: 'event-block', timestamp: new Date(NOW - 1000).toISOString(), message: { role: 'system', content: 'Synthetic approval' } }, 'blocked'],
  ];
  for (const [row, kind] of cases) {
    const parsed = mapRecord(row, { sessionKey: 'synthetic-activity-session', agentId: 'synthetic-agent', fallbackId: row.uuid });
    assert.equal(parsed.activity?.kind, kind);
    assert.equal(JSON.stringify(parsed.activity).includes('/private'), false, 'activity contains no tool arguments or paths');
    assert.equal(JSON.stringify(parsed.activity).includes('SYNTHETIC_PRIVATE'), false, 'activity contains no transcript text');
  }

  let clock = NOW;
  const h = fixture(t), rows = [assistant('thinking')];
  const file = h.file('synthetic-activity-project', 'synthetic-activity-session', rows);
  const runtime = A.createRuntime({ runtimeConfig: { claudeCode: { home: h.home } } }, { now: () => clock });
  const engine = createEngine({ adapter: runtime.definition, now: () => clock });
  t.after(() => runtime.close()); runtime.attach(engine);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Claude activity refresh timed out')), 5000);
    runtime.start(engine, { refreshed: () => { clearTimeout(timer); resolve(); } });
  });
  const session = engine.sessions()[0]; assert.ok(session); assert.equal(engine.activity(session.key)?.kind, 'thinking');
  for (const version of [2, 3]) {
    const vm = buildOfficeVM({ engine, canReadSessions: true, configuredAgents: { [engine.agents()[0].id]: 'Synthetic agent' }, now: clock, tracker: createStateTracker(), actorOf: () => ({ kind: 'system', name: 'System' }), ...(version === 3 ? { P: project3x } : {}) });
    assert.ok(vm.occupants.some(row => row.state === 'thinking'), `v${version} projects adapter-derived thinking`);
    const { VM_SCHEMAS, VM_SCHEMAS_V3 } = require('../../src/api/v2/vm/schemas');
    const validation = require('../../src/schema').validate((version === 3 ? VM_SCHEMAS_V3 : VM_SCHEMAS).office, vm);
    assert.equal(validation.ok, true, `v${version} schema-valid: ${JSON.stringify(validation.issues)}`);
  }
  clock += 11_000; engine.expireObservedActivity();
  assert.equal(engine.activity(session.key)?.kind, 'working', 'tool detail expires but the separate live run lease remains');
  const staleVM = buildOfficeVM({ engine, canReadSessions: true, configuredAgents: { [engine.agents()[0].id]: 'Synthetic agent' }, now: clock,
    tracker: createStateTracker(), actorOf: () => ({ kind: 'system', name: 'System' }) });
  assert.equal(staleVM.occupants.find(row => row.name === 'Synthetic agent')?.state, 'working', `stale detail degrades to generic running state: ${JSON.stringify(staleVM.occupants.map(({ id, role, name, state }) => ({ id, role, name, state })))}`);
  clock += 20_000; engine.expireObservedActivity();
  assert.equal(engine.activity(session.key), null, 'running evidence also expires at its longer lease');
  const expiredVM = buildOfficeVM({ engine, canReadSessions: true, configuredAgents: { [engine.agents()[0].id]: 'Synthetic agent' }, now: clock,
    tracker: createStateTracker(), actorOf: () => ({ kind: 'system', name: 'System' }) });
  assert.equal(expiredVM.occupants.some(row => ['thinking', 'researching', 'writing', 'executing', 'working'].includes(row.state)), false,
    'runtime detail and its longer running lease expire without leaving a false active state');

  const questionAt = new Date(clock - 1000).toISOString();
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant',
    sessionId: 'synthetic-activity-session', uuid: 'synthetic-final-question', timestamp: questionAt,
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'PRIVATE_CANARY Should I continue?' }] } }) + '\n');
  await runtime.cycle();
  assert.equal(engine.activity(session.key)?.kind, 'waiting', 'a completed question enters the waiting state');
  for (const version of [2, 3]) {
    const vm = buildOfficeVM({ engine, canReadSessions: true, configuredAgents: { [engine.agents()[0].id]: 'Synthetic agent' }, now: clock,
      tracker: createStateTracker(), actorOf: () => ({ kind: 'system', name: 'System' }), ...(version === 3 ? { P: project3x } : {}) });
    const waiting = vm.occupants.find(row => row.name === 'Synthetic agent');
    assert.equal(waiting?.state, 'waiting', `v${version} projects adapter-derived waiting`);
    const { VM_SCHEMAS, VM_SCHEMAS_V3 } = require('../../src/api/v2/vm/schemas');
    assert.equal(require('../../src/schema').validate((version === 3 ? VM_SCHEMAS_V3 : VM_SCHEMAS).office, vm).ok, true, `v${version} waiting OfficeVM schema-valid`);
  }
  clock += 15 * 60_000;
  engine.expireObservedActivity();
  assert.equal(engine.activity(session.key), null, 'waiting expires at its bounded reply window');
});

test('Claude end-of-turn questions and background commands project bounded waiting without copying message text', () => {
  const { mapRecord } = require('../../src/adapters/claude-code/profile');
  const at = new Date(NOW - 1000).toISOString();
  const assistant = (content, stop_reason = 'end_turn') => mapRecord({ type: 'assistant', sessionId: 'synthetic-await', uuid: 'await-event', timestamp: at,
    message: { role: 'assistant', stop_reason, content } }, { sessionKey: 'synthetic-await', agentId: 'synthetic-agent', fallbackId: 'await-event' });
  const question = assistant([{ type: 'text', text: 'PRIVATE_AWAIT_CANARY Can you review this?' }]);
  assert.equal(question.activity?.kind, 'waiting', 'a completed question remains waiting for a reply');
  assert.equal(question.execution?.status, 'idle', 'waiting is separate from active execution');
  assert.equal(JSON.stringify(question.activity).includes('PRIVATE_AWAIT_CANARY'), false);
  assert.equal(assistant([{ type: 'text', text: 'The operation is complete.' }]).activity, null,
    'a completed statement with no pending signal remains idle');
  const background = assistant([{ type: 'tool_use', id: 'background-1', name: 'Bash', input: { run_in_background: true, command: 'PRIVATE_COMMAND_CANARY' } }]);
  assert.equal(background.activity?.kind, 'waiting', 'a background process handed off at end-of-turn is waiting');
  assert.equal(JSON.stringify(background.activity).includes('PRIVATE_COMMAND_CANARY'), false);
  const completed = mapRecord({ type: 'system', subtype: 'task_notification', sessionId: 'synthetic-await', uuid: 'background-done',
    task_id: 'background-1', timestamp: at, message: { role: 'system', content: 'Background command completed PRIVATE_COMMAND_CANARY' } },
    { sessionKey: 'synthetic-await', agentId: 'synthetic-agent', fallbackId: 'background-done', pendingBackgroundIds: ['tool:background-1'], now: () => NOW });
  assert.equal(completed.backgroundPending, false, 'completion clears the pending process flag');
  assert.equal(completed.activity, null, 'completion does not retain a waiting signal');
  const completionWhileAwaiting = mapRecord({ type: 'system', subtype: 'task_notification', sessionId: 'synthetic-await', uuid: 'background-done-again',
    timestamp: at, message: { role: 'system', content: 'Background command completed' } },
    { sessionKey: 'synthetic-await', agentId: 'synthetic-agent', fallbackId: 'background-done-again', awaitingReply: true, awaitingReplyAt: NOW - 1000, now: () => NOW });
  assert.equal(completionWhileAwaiting.activity?.kind, 'waiting', 'an unrelated completion cannot erase the outstanding user reply wait');
  assert.equal(JSON.stringify({ activity: completed.activity, execution: completed.execution }).includes('PRIVATE_COMMAND_CANARY'), false,
    'command output is never copied to activity metadata');
});

test('Claude completion of one background job preserves its concurrent sibling through a real transcript read', async t => {
  let clock = NOW;
  const h = fixture(t), at = new Date(NOW - 1000).toISOString(), file = h.file('synthetic-parallel', 'parallel-session', []);
  const assistant = (uuid, content, stop_reason = 'tool_use') => ({ type: 'assistant', sessionId: 'parallel-session', uuid, timestamp: at,
    message: { role: 'assistant', stop_reason, content } });
  fs.writeFileSync(file, [assistant('spawned', [
    { type: 'tool_use', id: 'background-a', name: 'Bash', input: { run_in_background: true, command: 'PRIVATE_A' } },
    { type: 'tool_use', id: 'background-b', name: 'Bash', input: { run_in_background: true, command: 'PRIVATE_B' } },
  ]), assistant('handoff', [{ type: 'text', text: 'Two jobs are running.' }], 'end_turn')].map(row => JSON.stringify(row)).join('\n') + '\n');
  const runtime = A.createRuntime({ runtimeConfig: { claudeCode: { home: h.home } } }, { now: () => clock });
  const engine = createEngine({ adapter: runtime.definition, now: () => clock }); t.after(() => runtime.close()); runtime.attach(engine);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Claude parallel background refresh timed out')), 5000);
    runtime.start(engine, { refreshed: () => { clearTimeout(timer); resolve(); } });
  });
  const key = engine.sessions()[0].key;
  assert.equal(engine.activity(key)?.kind, 'waiting');
  fs.appendFileSync(file, JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'background-a', sessionId: 'parallel-session',
    uuid: 'finished-a', timestamp: at, message: { role: 'system', content: 'Background command completed PRIVATE_A' } }) + '\n');
  await runtime.cycle();
  assert.equal(engine.activity(key)?.kind, 'waiting', 'finishing task A leaves task B pending through the runtime projection');
  assert.deepEqual(runtime.files.rows()[0].backgroundPendingIds, ['tool:background-b']);
  fs.appendFileSync(file, [
    { type: 'system', subtype: 'task_notification', task_id: 'background-a', sessionId: 'parallel-session', uuid: 'duplicate-a', timestamp: at, message: { role: 'system', content: 'Duplicate completion' } },
    { type: 'system', subtype: 'task_notification', task_id: 'unknown-x', sessionId: 'parallel-session', uuid: 'unknown-x', timestamp: at, message: { role: 'system', content: 'Unrelated completion' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await runtime.cycle();
  assert.equal(engine.activity(key)?.kind, 'waiting', 'duplicate A and unknown X cannot retire still-live B');
  assert.deepEqual(runtime.files.rows()[0].backgroundPendingIds, ['tool:background-b']);
  for (const version of [2, 3]) {
    const vm = buildOfficeVM({ engine, canReadSessions: true, configuredAgents: { [engine.agents()[0].id]: 'Synthetic agent' }, now: clock,
      tracker: createStateTracker(), actorOf: () => ({ kind: 'system', name: 'System' }), ...(version === 3 ? { P: project3x } : {}) });
    assert.equal(vm.occupants.find(row => row.name === 'Synthetic agent')?.state, 'waiting', `v${version} retains waiting while task B is live`);
    const { VM_SCHEMAS, VM_SCHEMAS_V3 } = require('../../src/api/v2/vm/schemas');
    assert.equal(require('../../src/schema').validate((version === 3 ? VM_SCHEMAS_V3 : VM_SCHEMAS).office, vm).ok, true, `v${version} VM validates`);
  }
  assert.equal(JSON.stringify(runtime.files.rows()[0]).includes('PRIVATE_'), false, 'private command details never enter adapter status');
  fs.appendFileSync(file, JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'background-b', sessionId: 'parallel-session',
    uuid: 'finished-b', timestamp: at, message: { role: 'system', content: 'Background command completed' } }) + '\n');
  await runtime.cycle();
  assert.equal(engine.activity(key), null, 'the exact final completion retires its obligation');
});

test('Claude pending-job overflow stays conservatively pending and reply expiry is never renewed by completion', () => {
  const { mapRecord } = require('../../src/adapters/claude-code/profile');
  const at = NOW - 1000;
  const toolCalls = Array.from({ length: 65 }, (_, index) => ({ type: 'tool_use', id: `bounded-${index}`, name: 'Bash', input: { run_in_background: true } }));
  let record = mapRecord({ type: 'assistant', sessionId: 'bounded-session', uuid: 'many', timestamp: new Date(at).toISOString(),
    message: { role: 'assistant', stop_reason: 'end_turn', content: toolCalls } },
    { sessionKey: 'bounded-session', agentId: 'synthetic', fallbackId: 'many', now: () => NOW });
  assert.equal(record.backgroundPendingIds.length, 64);
  assert.equal(record.pendingBackgroundOverflow, true, 'the 65th live job sets an uncertainty sentinel rather than dropping work');
  for (let index = 0; index < 64; index++) record = mapRecord({ type: 'system', subtype: 'task_notification', task_id: `bounded-${index}`,
    sessionId: 'bounded-session', uuid: `complete-${index}`, timestamp: new Date(at + index).toISOString(), message: { role: 'system', content: 'Done' } },
    { sessionKey: 'bounded-session', agentId: 'synthetic', fallbackId: `complete-${index}`, pendingBackground: record.backgroundPending,
      pendingBackgroundIds: record.backgroundPendingIds, pendingBackgroundOverflow: record.pendingBackgroundOverflow, now: () => NOW });
  assert.equal(record.pendingBackgroundOverflow, true);
  assert.equal(record.backgroundPending, true, 'unknown overflow work remains represented until source reset');
  const question = mapRecord({ type: 'assistant', sessionId: 'reply-session', uuid: 'question', timestamp: new Date(at).toISOString(),
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Can you confirm?'}] } },
    { sessionKey: 'reply-session', agentId: 'synthetic', fallbackId: 'question', now: () => NOW });
  const lateAt = at + 20 * 60_000;
  const late = mapRecord({ type: 'system', subtype: 'task_notification', task_id: 'unknown', sessionId: 'reply-session', uuid: 'late-completion',
    timestamp: new Date(lateAt).toISOString(), message: { role: 'system', content: 'Done' } },
    { sessionKey: 'reply-session', agentId: 'synthetic', fallbackId: 'late-completion', awaitingReply: question.awaitingReply,
      awaitingReplyAt: question.awaitingReplyAt, now: () => lateAt });
  assert.equal(question.awaitingReplyAt, at);
  assert.equal(late.awaitingReply, false, 'an old reply obligation expires before an unrelated completion');
  assert.equal(late.activity, null, 'late completion does not create fresh waiting evidence');
});

test('Claude completion preserves the original reply-wait timestamp for cached-reader expiry', () => {
  const { mapRecord } = require('../../src/adapters/claude-code/profile');
  const questionAt = NOW - 11 * 60_000;
  const question = mapRecord({ type: 'assistant', sessionId: 'reply-lease', uuid: 'question', timestamp: new Date(questionAt).toISOString(),
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Can you confirm?'}] } },
    { sessionKey: 'reply-lease', agentId: 'synthetic', fallbackId: 'question', now: () => NOW });
  assert.equal(question.activity.since, questionAt);
  const completedAt = questionAt + 10 * 60_000;
  const completion = mapRecord({ type: 'system', subtype: 'task_notification', task_id: 'unrelated', sessionId: 'reply-lease', uuid: 'completion',
    timestamp: new Date(completedAt).toISOString(), message: { role: 'system', content: 'Completed' } },
    { sessionKey: 'reply-lease', agentId: 'synthetic', fallbackId: 'completion', awaitingReply: question.awaitingReply,
      awaitingReplyAt: question.awaitingReplyAt, now: () => completedAt });
  assert.equal(completion.activity.since, questionAt, 'completion cannot restart the reply deadline at minute ten');
  const cachedReadAt = questionAt + 20 * 60_000;
  const cachedRefresh = mapRecord({ type: 'system', subtype: 'task_notification', task_id: 'later-unrelated', sessionId: 'reply-lease', uuid: 'later',
    timestamp: new Date(cachedReadAt).toISOString(), message: { role: 'system', content: 'Later' } },
    { sessionKey: 'reply-lease', agentId: 'synthetic', fallbackId: 'later', awaitingReply: completion.awaitingReply,
      awaitingReplyAt: completion.awaitingReplyAt, now: () => cachedReadAt });
  assert.equal(cachedRefresh.activity, null, 'cached reader reaches the original 15-minute expiry');
});

test('Claude persisted reply timestamps expire across a later unrelated completion', async t => {
  let clock = NOW;
  const h = fixture(t), questionAt = NOW - 1000;
  const file = h.file('reply-expiry-project', 'reply-expiry-session', [
    { type: 'assistant', sessionId: 'reply-expiry-session', uuid: 'old-question', timestamp: new Date(questionAt).toISOString(),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Can you confirm?'}] } },
  ]);
  const runtime = A.createRuntime({ runtimeConfig: { claudeCode: { home: h.home } } }, { now: () => clock });
  const engine = createEngine({ adapter: runtime.definition, now: () => clock });
  t.after(() => runtime.close()); runtime.attach(engine);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Claude reply-expiry refresh timed out')), 5000);
    runtime.start(engine, { refreshed: () => { clearTimeout(timer); resolve(); } });
  });
  const session = engine.sessions()[0];
  assert.equal(engine.activity(session.key)?.kind, 'waiting');
  assert.equal(runtime.files.rows()[0].awaitingReplyAt, questionAt, 'the persisted obligation retains its original timestamp');

  clock = questionAt + 20 * 60_000;
  fs.appendFileSync(file, JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'unknown-task',
    sessionId: 'reply-expiry-session', uuid: 'late-completion', timestamp: new Date(clock).toISOString(),
    message: { role: 'system', content: 'Unrelated completion' } }) + '\n');
  await runtime.cycle();
  assert.equal(runtime.files.rows()[0].awaitingReply, false, 'the stale persisted reply wait expires');
  assert.equal(runtime.files.rows()[0].awaitingReplyAt, null);
  assert.equal(engine.activity(session.key), null, 'the late completion cannot renew the expired lease');
  for (const version of [2, 3]) {
    const vm = buildOfficeVM({ engine, canReadSessions: true, now: clock, tracker: createStateTracker(),
      actorOf: () => ({ kind: 'system', name: 'System' }), ...(version === 3 ? { P: project3x } : {}) });
    assert.notEqual(vm.occupants.find(row => row.sessionKey === session.key)?.state, 'waiting', `v${version} does not show expired waiting evidence`);
  }
});

test('a fresh Claude permission wait remains observed after an older Bash run lease expires', async t => {
  let clock = NOW;
  const h = fixture(t), id = 'synthetic-delayed-permission';
  const at = delta => new Date(NOW + delta).toISOString();
  h.file('synthetic-delayed-project', id, [
    { type: 'user', sessionId: id, uuid: 'old-user', timestamp: at(-26_000), message: { role: 'user', content: 'Synthetic task' } },
    { type: 'assistant', sessionId: id, uuid: 'old-bash', timestamp: at(-25_000), message: { role: 'assistant', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'synthetic-bash', name: 'Bash', input: { command: 'synthetic command' } }] } },
    { type: 'system', sessionId: id, uuid: 'fresh-permission', subtype: 'permission_request', timestamp: at(-1_000),
      message: { role: 'system', content: 'Synthetic permission request' } },
  ]);
  const runtime = A.createRuntime({ runtimeConfig: { claudeCode: { home: h.home } } }, { now: () => clock });
  const engine = createEngine({ adapter: runtime.definition, now: () => clock });
  t.after(() => runtime.close()); runtime.attach(engine); await runtime.start(engine);
  const session = engine.sessions()[0];
  assert.ok(session);
  assert.equal(engine.activity(session.key)?.kind, 'blocked');
  clock += 6_000;
  engine.expireObservedActivity();
  assert.equal(engine.activity(session.key)?.kind, 'blocked', 'the rich lease outlives the older 30-second run evidence');
  const agent = engine.agents()[0];
  const vm = buildOfficeVM({ engine, canReadSessions: true, configuredAgents: { [agent.id]: 'Synthetic agent' }, now: clock,
    tracker: createStateTracker(), actorOf: () => ({ kind: 'system', name: 'System' }) });
  const occupant = vm.occupants.find(row => row.sessionKey === session.key || row.name === 'Synthetic agent');
  assert.equal(occupant?.state, 'blocked');
  assert.deepEqual(occupant?.execution, { status: 'running', evidence: { level: 'observed', observedAt: NOW - 1_000, expiresAt: NOW + 9_000 } });
});

test('old closed Claude transcript stays in history but its unconfigured project agent leaves the office', async t => {
  const h = fixture(t), id = 'completed-session', at = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();
  h.file('agent-office-portal', id, [
    { type: 'user', sessionId: id, uuid: 'prompt', timestamp: at, cwd: '/synthetic/projects/agent-office-portal', message: { role: 'user', content: 'Synthetic request' } },
    { type: 'assistant', sessionId: id, uuid: 'answer', timestamp: at, cwd: '/synthetic/projects/agent-office-portal', message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic completed response' }], stop_reason: 'end_turn' } },
  ]);
  const empty = h.file('synthetic-no-session-project', 'metadata-only', []);
  fs.writeFileSync(empty, JSON.stringify({ type: 'ai-title', timestamp: at, title: 'Synthetic title only' }) + '\n');
  const runtime = A.createRuntime({ runtimeConfig: { claudeCode: { home: h.home } } }, { now: () => NOW });
  const engine = createEngine({ adapter: runtime.definition, now: () => NOW });
  t.after(() => runtime.close()); runtime.attach(engine); await runtime.start(engine);
  const completed = engine.sessions().find(s => s.sessionId === id);
  assert.deepEqual([completed.run.status, completed.run.evidenceLevel], ['idle', 'observed']);
  const office = buildOfficeVM({ engine, canReadSessions: true, now: NOW, tracker: createStateTracker(), actorOf: x => x, P: project3x });
  const portalAgent = engine.agents().find(a => a.name === 'agent-office-portal');
  assert.ok(portalAgent, 'the project remains in the transcript-backed agent catalog');
  assert.equal(office.occupants.some(o => o.id === 'agent:' + portalAgent.id), false, 'an old closed transcript does not create an office desk');
  assert.ok(engine.sessions().some(s => s.sessionId === id), 'the transcript remains available in session history');
  const noEvidence = engine.sessions().find(s => s.sessionId === 'metadata-only');
  assert.deepEqual([noEvidence.run.status, noEvidence.run.evidenceLevel], ['unknown', 'unknown'], 'metadata without session events cannot mint execution evidence');
});
test('partial UTF-8/JSON lines wait for newline, rotation resets generation, unknown records retain last good, deletion invalidates', async t => {
  const h = fixture(t), file = h.file('p', 'session-a'), files = createFiles({ home: h.home, now: () => NOW }); t.after(() => files.close());
  await files.scan(); const key = files.rows()[0].key, before = await files.read(key);
  const next = Buffer.from(JSON.stringify(record('session-a', 'Synthetic 宇宙', { uuid: 'next-event' })) + '\n');
  const split = next.indexOf(Buffer.from('宇')) + 1;
  fs.appendFileSync(file, next.subarray(0, split));
  assert.deepEqual((await files.read(key, { refresh: true })).events, before.events);
  fs.appendFileSync(file, next.subarray(split)); assert.equal((await files.read(key, { refresh: true })).events.length, 2);
  fs.renameSync(file, file + '.old'); fs.writeFileSync(file, JSON.stringify(record('session-a', 'Rotated', { uuid: 'rotated-event' })) + '\n');
  await files.scan();
  assert.equal((await files.read(key, { refresh: true })).events[0].text, 'Rotated');
  fs.appendFileSync(file, JSON.stringify({ type: 'unrecognised', private: 'PRIVATE_SENTINEL' }) + '\n');
  assert.equal((await files.read(key, { refresh: true })).events[0].text, 'Rotated');
  assert.ok(files.stats.unknownLineTypes > 0);
  assert.equal(JSON.stringify(files.stats).includes('PRIVATE_SENTINEL'), false);
  fs.unlinkSync(file); await files.scan(); assert.equal(await files.read(key), null); assert.deepEqual(files.cached(), []);
});
test('filters and containment refuse symlink roots, project links and transcript links without reading their targets', async t => {
  const h = fixture(t); h.file('included', 'a'); h.file('excluded', 'b');
  const target = h.file('outside', 'c'); fs.symlinkSync(target, path.join(h.home, 'projects', 'included', 'linked.jsonl'));
  fs.symlinkSync(path.join(h.home, 'projects', 'outside'), path.join(h.home, 'projects', 'linked-project'));
  const files = createFiles({ home: h.home, include: ['included', 'excluded'], exclude: ['excluded'] }); t.after(() => files.close());
  const rows = await files.scan(); assert.equal(rows.length, 1); assert.equal(rows[0].sessionId, 'a'); assert.ok(!rows[0].key.includes('included'));
  const linked = path.join(h.home, 'aliased'); fs.symlinkSync(h.home, linked); const bad = createFiles({ home: linked }); t.after(() => bad.close());
  await assert.rejects(bad.scan(), { code: 'EUNSAFEPATH' });
});
test('1000 synthetic sessions yield during indexing, keep bounded tails/cache, and produce 20 project agents or one runtime agent', async t => {
  const h = fixture(t);
  for (let p = 0; p < 20; p++) for (let n = 0; n < 50; n++) h.file('project-' + p, 'session-' + p + '-' + n);
  let yielded = false; setImmediate(() => { yielded = true; });
  for (const agentGrouping of ['project', 'runtime']) {
    const runtime = A.createRuntime({ runtimeConfig: { claudeCode: { home: h.home, agentGrouping } } }, { now: () => NOW });
    const engine = createEngine({ adapter: runtime.definition, now: () => NOW }); runtime.attach(engine);
    try {
      const started=performance.now(),memoryBefore=process.memoryUsage();
      await runtime.start(engine); assert.equal(yielded, true); assert.equal(engine.sessions().length, 1000);
      const memoryAfter=process.memoryUsage();
      t.diagnostic(JSON.stringify({grouping:agentGrouping,indexMs:Math.round(performance.now()-started),heapDeltaBytes:memoryAfter.heapUsed-memoryBefore.heapUsed,rssDeltaBytes:memoryAfter.rss-memoryBefore.rss}));
      assert.equal(engine.agents().length, agentGrouping === 'project' ? 20 : 1);
      assert.ok(runtime.files.stats.peakReads <= BOUNDS.reads); assert.ok(runtime.files.cached().length <= BOUNDS.cacheSessions);
      assert.ok(runtime.files.cacheBytes() <= BOUNDS.cacheBytes); assert.ok(runtime.files.stats.yields >= 10);
      const office = buildOfficeVM({ engine, canReadSessions: true, now: NOW, tracker: createStateTracker(), actorOf: x => x, P: project3x });
      assert.deepEqual(office.occupants.map(o => o.id), ['primary'], 'empty transcript metadata does not create project desks');
      const cached=runtime.files.rows().find(r=>runtime.files.cached().includes(r.key));
      fs.appendFileSync(cached.file,JSON.stringify(record(cached.sessionId,'New synthetic activity',{uuid:'new-scale-turn-'+agentGrouping}))+'\n');
      await runtime.cycle();
      const live=buildOfficeVM({engine,canReadSessions:true,now:NOW,tracker:createStateTracker(),actorOf:x=>x,P:project3x});
      t.diagnostic(JSON.stringify({grouping:agentGrouping,observed:engine.activity(cached.key),file:runtime.files.rows().find(r=>r.key===cached.key)?.activityAt,states:live.occupants.map(o=>o.state)}));
      assert.ok(live.occupants.some(o=>o.state==='working' && o.execution.evidence.level==='observed'), 'fresh transcript activity is Working with observed confidence retained: ' + JSON.stringify(live.occupants.map(o=>[o.id,o.state,o.execution])));
      t.diagnostic(JSON.stringify({grouping:agentGrouping,sessions:engine.sessions().length,agents:engine.agents().length,cacheSessions:runtime.files.cached().length,cacheBytes:runtime.files.cacheBytes(),...runtime.files.stats}));
    } finally { runtime.close(); }
  }
});

test('branch ancestry, replay, missing UUID offsets and injected prompts remain descriptive', async t => {
  const h=fixture(t), file=h.file('synthetic-private-directory','branch',[
    record('branch','Root',{uuid:'root'}), record('branch','Obsolete',{uuid:'old',parentUuid:'root'}),
    record('branch','Current',{uuid:'current',parentUuid:'root'}), record('branch','Current',{uuid:'current',parentUuid:'root'}),
    record('branch','Injected',{uuid:'injected',parentUuid:'current',isMeta:true}),
    record('branch','Offset identity',{uuid:undefined,parentUuid:'injected'})]);
  const files=createFiles({home:h.home});t.after(()=>files.close()); await files.scan(); const row=files.rows()[0];
  const first=await files.read(row.key); assert.deepEqual(first.events.map(e=>e.text),['Root','Current','Injected','Offset identity']);
  assert.equal(first.events[2].kind,'system'); assert.equal(first.events[2].senderInfo.kind,'system');
  assert.ok(!JSON.stringify(first).includes('synthetic-private-directory'));
  assert.deepEqual((await files.read(row.key,{refresh:true})).events.map(e=>e.id),first.events.map(e=>e.id));
  fs.appendFileSync(file,JSON.stringify(record('branch','New ambiguous branch',{uuid:'ambiguous',parentUuid:'unavailable-parent'}))+'\n');
  const next=await files.read(row.key,{refresh:true}); assert.deepEqual(next.events.map(e=>e.text),['New ambiguous branch']); assert.equal(files.rows()[0].partial,true);
});
test('capacity selection is bounded and deterministic; deleting a retained session admits another candidate', async t => {
  const h=fixture(t); for(let n=0;n<BOUNDS.sessions+2;n++) h.file('p','s-'+String(n).padStart(5,'0'));
  const files=createFiles({home:h.home});t.after(()=>files.close()); const rows=await files.scan();
  assert.equal(rows.length,BOUNDS.sessions); assert.equal(files.stats.excluded,2); assert.equal(files.stats.truncated,true);
  fs.unlinkSync(rows[0].file); const next=await files.scan(); assert.equal(next.length,BOUNDS.sessions); assert.equal(files.stats.excluded,1); assert.ok(!next.some(r=>r.key===rows[0].key));
});

test('deleting an on-demand transcript clears the admitted engine cache even when it was outside the tail set',async t=>{
  const h=fixture(t);for(let n=0;n<BOUNDS.tails+2;n++)h.file('p','session-'+n);
  const runtime=A.createRuntime({runtimeConfig:{claudeCode:{home:h.home}}}),engine=createEngine({adapter:runtime.definition});
  t.after(()=>runtime.close());runtime.attach(engine);await runtime.start(engine);
  const opened=runtime.files.rows().find(r=>!engine.transcript(r.key));assert.ok(opened);
  assert.equal((await engine.request('transcript',opened.key)).ok,true);assert.ok(engine.transcript(opened.key));
  fs.unlinkSync(opened.file);await runtime.cycle();assert.equal(engine.transcript(opened.key),null);assert.equal(engine.session(opened.key),null);
});

test('partial transcript history does not take a live source down', async t => {
  const h = fixture(t), file = h.file('partial-project', 'partial-session', [
    record('partial-session', 'Root', { uuid: 'root' }),
    record('partial-session', 'Unrelated branch', { uuid: 'branch', parentUuid: 'missing-parent' }),
  ]);
  const runtime = A.createRuntime({ runtimeConfig: { claudeCode: { home: h.home } } });
  const engine = createEngine({ adapter: runtime.definition });
  t.after(() => runtime.close()); runtime.attach(engine); await runtime.start(engine);
  assert.equal(runtime.files.rows()[0].partial, true);
  assert.ok(engine.sources().every(source => source.id !== 'transcript-history'), 'incomplete archive history is not a failed live feed');
  assert.equal(engine.sources().find(source => source.id === 'transcripts')?.state, 'fresh');
  assert.ok(fs.existsSync(file));
});

test('recently written transcripts are polled ahead of the bounded tail and keep fresh activity alive', async t => {
  const h = fixture(t);
  for (let n = 0; n < BOUNDS.tails; n++) h.file('active-project', `active-${String(n).padStart(2, '0')}`);
  const runtime = A.createRuntime({ runtimeConfig: { claudeCode: { home: h.home } } });
  const engine = createEngine({ adapter: runtime.definition });
  t.after(() => runtime.close()); runtime.attach(engine); await runtime.start(engine);
  const row = [...runtime.files.rows()].filter(r => runtime.files.cached().includes(r.key)).sort((a, b) => a.mtime - b.mtime)[0];
  for (let n = 0; n < 8; n++) h.file('new-project', `new-${String(n).padStart(2, '0')}`);
  const at = Date.now();
  fs.appendFileSync(row.file, JSON.stringify(record(row.sessionId, 'Current synthetic turn', { uuid: 'current-turn', timestamp: new Date(at).toISOString() })) + '\n');
  const current = new Date(); fs.utimesSync(row.file, current, current);
  let targetReads = 0; const read = runtime.files.read;
  runtime.files.read = (key, options) => { if (key === row.key) targetReads++; return read(key, options); };
  await runtime.cycle();
  assert.equal(targetReads, 1, 'the recently written file is re-read even when outside the previous 32-file slice');
  assert.equal(engine.activity(row.key)?.kind, 'working');
  await runtime.cycle();
  assert.equal(targetReads, 2, 'recently modified transcripts are refreshed every cycle');
  assert.equal(engine.activity(row.key)?.kind, 'working', 'the observation lease survives the regular poll cadence');
});

test('concurrent sources share the global read and queue bounds without retaining failed work',async t=>{
  const h=fixture(t);for(let n=0;n<100;n++)h.file('p','queue-'+n);
  const sources=Array.from({length:4},()=>createFiles({home:h.home}));t.after(()=>sources.forEach(s=>s.close()));
  for(const source of sources)await source.scan();
  const results=await Promise.allSettled(sources.flatMap(source=>source.rows().map(row=>source.read(row.key))));
  assert.ok(results.some(r=>r.status==='rejected' && r.reason.code==='EBUSY'));
  assert.ok(results.some(r=>r.status==='fulfilled' && r.value?.events.length));
  for(const source of sources){assert.ok((source.stats.peakReads||0)<=BOUNDS.reads);assert.ok((source.stats.peakGlobalReads||0)<=BOUNDS.globalReads);assert.ok(source.cacheBytes()<=BOUNDS.cacheBytes);}
  assert.ok((await sources[3].read(sources[3].rows()[0].key)).events.length,'overflow does not poison a later retry');
  t.diagnostic(JSON.stringify(sources.map(source=>source.stats)));
});

test('large recent windows remain bounded across sources and oversized lines do not accumulate',async t=>{
  const h=fixture(t),text='Synthetic bounded window '.repeat(1200);
  for(let n=0;n<24;n++)h.file('p','large-'+n,Array.from({length:24},(_,e)=>record('large-'+n,text,{uuid:'event-'+e})));
  const sources=Array.from({length:4},()=>createFiles({home:h.home}));t.after(()=>sources.forEach(s=>s.close()));
  const budget=require('../../src/engine/transcript-budget');
  for(const source of sources){await source.scan();for(const row of source.rows())await source.read(row.key);assert.ok(source.cacheBytes()<=BOUNDS.cacheBytes);assert.ok(budget.bytes()<=budget.MAX_BYTES);}
  const source=sources[0],row=source.rows()[0];
  await source.read(row.key);
  fs.appendFileSync(row.file,'x'.repeat(BOUNDS.lineBytes+50)+'\n'+JSON.stringify(record(row.sessionId,'After oversized line',{uuid:'after-oversized'}))+'\n');
  // A read has a byte budget, so the skipped line can span several operations.
  for(let n=0;n<7;n++)await source.read(row.key,{refresh:true});
  const trace=await source.read(row.key);assert.ok(trace.events.some(e=>e.text==='After oversized line'));
  assert.ok(source.stats.oversizeLines>0);assert.ok(budget.bytes()<=budget.MAX_BYTES);
  t.diagnostic(JSON.stringify({accountedBytes:budget.bytes(),limitBytes:budget.MAX_BYTES,cacheBytes:sources.map(s=>s.cacheBytes())}));
});
