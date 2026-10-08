'use strict';
// S7b: the read views on the adapter interface (api.md §3.2–3.7). Live routes against the authoritative examples
// (strict shape checker, envelope mode), topics, errors; plus the pure builders and the R1-11 SKILL.md containment.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');
const { compareExample } = require('../helpers/contract-shape');
const { cronSentence, isoDuration, buildFlowDetailVM } = require('../../src/api/v2/vm/flows');
const { flowOf } = require('../../src/api/v2/vm/skills');
const { buildLogsPage, parseLogsQuery, sessionLabel } = require('../../src/api/v2/vm/logs');
const { createStateTracker } = require('../../src/api/v2/vm/office');
const { createSkillDocReader, MAX_BYTES } = require('../../src/adapters/openclaw/skill-doc');
const { LABELS } = require('../../src/i18n/fr');

const sc = loadScenario('synthetic-basic');

describe('S7b views · live routes match the examples', () => {
  let h;
  before(async () => { h = await startServer(sc); });
  after(async () => { if (h) await h.stop(); });
  const body = async (p) => { const r = await h.get(p); assert.equal(r.status, 200, p + ': ' + r.text.slice(0, 200)); return r.json; };

  it('office, flows, flow detail, logs, session, access, interlocutor, skills, skill detail', async () => {
    const office = await body('/api/v2/views/office');
    assert.deepEqual(compareExample('office-vm', office, { envelope: true }), []);
    assert.equal(office.meta.topic.id, 'office');
    const flows = await body('/api/v2/views/flows');
    assert.deepEqual(compareExample('flow-list-vm', flows, { envelope: true }), []);
    const id = flows.data.flows[0].id;
    const flow = await body('/api/v2/views/flows/' + id);
    assert.deepEqual(compareExample('flow-detail-vm', flow, { envelope: true }), []);
    assert.equal(flow.meta.topic.id, 'flow:' + id);
    assert.ok(flow.data.runs.length > 0, 'runs read on demand through engine.request');
    const logs = await body('/api/v2/views/logs');
    assert.deepEqual(compareExample('logs-page', logs, { envelope: true }), []);
    assert.equal(logs.meta.topic.id, 'logs');
    const key = logs.data.items.find((x) => x.kind === 'subagent').id;
    const session = await body('/api/v2/views/sessions/' + encodeURIComponent(key));
    assert.deepEqual(compareExample('session-vm', session, { envelope: true }), []);
    assert.ok(session.data.events.every((e) => /^ev:\d+:\d+$/.test(e.id)));
    const access = await body('/api/v2/views/access');
    assert.deepEqual(compareExample('access-vm', access, { envelope: true }), []);
    const inter = await body('/api/v2/views/interlocutors/' + encodeURIComponent(access.data.interlocutors[0].id));
    assert.deepEqual(compareExample('interlocutor-vm', inter, { envelope: true }), []);
    const skills = await body('/api/v2/views/skills');
    assert.deepEqual(compareExample('skill-list-vm', skills, { envelope: true }), []);
    const skill = await body('/api/v2/views/skills/' + skills.data.skills[0].id);
    assert.deepEqual(compareExample('skill-detail-vm', skill, { envelope: true }), []);
    assert.ok(h.cliCalls().some((a) => a[0] === 'skills' && a[1] === 'info' && a.includes('--agent')), 'skills info with --agent');
  });

  it('errors: unknown ids 404, invalid ids and queries 400; a non-default page has no topic', async () => {
    for (const p of ['/api/v2/views/flows/ffffffff-dead-4000-8000-000000000000', '/api/v2/views/sessions/' + encodeURIComponent('agent:main:nope'),
      '/api/v2/views/skills/nope', '/api/v2/views/interlocutors/discord-user%3A123456789012345678', '/api/v2/views/interlocutors/nope']) {
      const r = await h.get(p); assert.equal(r.status, 404, p); assert.equal(r.json.error.code, 'not_found');
    }
    for (const p of ['/api/v2/views/flows/-rf', '/api/v2/views/logs?kind=nope', '/api/v2/views/logs?limit=0', '/api/v2/views/logs?cursor=%%%', '/api/v2/views/logs?heartbeat=yes']) {
      const r = await h.get(p); assert.equal(r.status, 400, p); assert.equal(r.json.error.code, 'validation_failed');
    }
    const r = await h.get('/api/v2/views/logs?limit=2');
    assert.equal(r.json.data.items.length, 2); assert.equal(r.json.meta.topic, undefined); assert.equal(typeof r.json.data.nextCursor, 'string');
    const next = await h.get('/api/v2/views/logs?limit=2&cursor=' + r.json.data.nextCursor);
    assert.notDeepEqual(next.json.data.items.map((x) => x.id), r.json.data.items.map((x) => x.id));
    const anon = await fetch(h.base + '/api/v2/views/office');
    assert.equal(anon.status, 401);
  });

  it('every label key a view emits exists in MetaVM.labels', async () => {
    const keys = new Set();
    const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (typeof v.key === 'string' && Object.keys(v).every((k) => k === 'key' || k === 'params')) { keys.add(v.key); if (v.params) Object.values(v.params).forEach(walk); } else Object.values(v).forEach(walk); } };
    for (const p of ['/api/v2/views/office', '/api/v2/views/flows', '/api/v2/views/logs']) walk((await h.get(p)).json.data);
    const missing = [...keys].filter((k) => k !== 'custom' && !LABELS[k]);
    assert.deepEqual(missing, []);
  });
});

describe('S7b builders', () => {
  it('cron sentences and ISO durations', () => {
    assert.deepEqual(cronSentence('0 9 * * 1'), { key: 'schedule.weekly', params: { day: { key: 'weekday.1' }, time: '09:00' } });
    assert.deepEqual(cronSentence('30 7 * * *'), { key: 'schedule.daily', params: { time: '07:30' } });
    assert.deepEqual(cronSentence('0 2 * * 1-5'), { key: 'schedule.weekdays', params: { time: '02:00' } });
    assert.deepEqual(cronSentence('0 9 * * 7'), { key: 'schedule.weekly', params: { day: { key: 'weekday.0' }, time: '09:00' } }, 'Sunday as 7');
    assert.deepEqual(cronSentence('*/5 * * * *'), { key: 'schedule.cron', params: { expr: '*/5 * * * *' } });
    assert.deepEqual(cronSentence('nonsense'), { key: 'schedule.cron', params: { expr: 'nonsense' } });
    assert.equal(isoDuration(30 * 60000), 'PT30M'); assert.equal(isoDuration(90061000), 'P1DT1H1M1S'); assert.equal(isoDuration(0), 'PT0S'); assert.equal(isoDuration(86400000), 'P1D');
  });

  it('flow detail: editable only for cron + agent-turn; runs newest first, at most 25; decisions in the diagram', () => {
    const job = { id: 'j', name: 'n', description: '', enabled: true, schedule: { kind: 'every', everyMs: 60000, anchorAt: null }, health: 'ok', nextRunAt: null, lastRunAt: null,
      agentId: 'main', sessionTarget: null, wakeMode: 'now', payload: { kind: 'agent-turn', message: 'x', model: null, timeoutSeconds: null, toolsAllow: null, lightContext: false },
      steps: ['Lire', 'Si urgent, prévenir'], createdAt: null, updatedAt: null, delivery: { mode: 'announce', channel: 'discord', to: null } };
    const runs = { fetchedAt: 0, runs: Array.from({ length: 30 }, (_, i) => ({ id: 'r' + i, jobId: 'j', at: i, status: 'succeeded', durationMs: 1, nextRunAt: null, model: null, usage: null,
      delivery: { status: null, delivered: null, channel: null }, summary: '', error: null })) };
    const vm = buildFlowDetailVM(job, runs);
    assert.equal(vm.editable, false);
    assert.equal(vm.job.sessionTarget, 'unrecognized');
    assert.equal(vm.runs.length, 25); assert.equal(vm.runs[0].id, 'r29');
    assert.deepEqual(vm.diagram.nodes.map((n) => n.kind), ['trigger', 'step', 'decision', 'output']);
    assert.equal(vm.diagram.nodes[3].label, 'Message');
    assert.equal(buildFlowDetailVM(Object.assign({}, job, { schedule: { kind: 'cron', expr: '0 9 * * 1', tz: null } }), null).editable, true);
    assert.equal(buildFlowDetailVM(null, null), null);
  });

  it('skill flow: numbered steps (code blocks ignored), else headings; outputs from the text', () => {
    assert.deepEqual(flowOf('# X\n```\n1. not a step\n```\n1. Lire la ville\n2. Envoyer le message', ''), { steps: ['Lire la ville', 'Envoyer le message'], outputs: ['message'] });
    assert.deepEqual(flowOf('## Préparer\n## Écrire le fichier', '').steps, ['Préparer', 'Écrire le fichier']);
    assert.deepEqual(flowOf('', 'Fait des calculs.').outputs, ['agent-reply']);
  });

  it('logs: heartbeats hidden unless asked, kind filter, order, query validation', () => {
    const s = (key, kind, updatedAt, extra = {}) => ({ key, updatedAt, model: null, provider: null, usage: { total: 1 }, run: { status: 'idle' }, displayName: null,
      class: Object.assign({ kind, heartbeatOf: null, channel: null }, extra) });
    const all = [s('a', 'primary', 5), s('a:heartbeat', 'primary', 9, { heartbeatOf: 'a' }), s('b', 'subagent', 7, { subagentId: 'abcd1234' }), s('c', 'subagent', 7, { subagentId: 'ffff' })];
    assert.deepEqual(buildLogsPage(all).items.map((x) => x.id), ['b', 'c', 'a']);
    assert.deepEqual(buildLogsPage(all, { heartbeat: true }).items.map((x) => x.id), ['a:heartbeat', 'b', 'c', 'a']);
    assert.deepEqual(buildLogsPage(all, { kind: 'main' }).items.map((x) => [x.id, x.kind]), [['a', 'main']], 'G3b: a 2.x kind filter selects the canonical kind; rows carry the 2.x kind');
    assert.deepEqual(buildLogsPage(all, { kind: 'subagent' }).items.map((x) => x.label), ['Sous-agent abcd', 'Sous-agent ffff']);
    assert.equal(sessionLabel(all[1]), 'Session principale · battement');
    assert.deepEqual(parseLogsQuery({ kind: 'cron', heartbeat: 'include', limit: '10' }), { kind: 'cron', heartbeat: true, offset: 0, limit: 10 });
    assert.deepEqual(parseLogsQuery({ limit: '201' }).error, { field: 'limit', issue: 'invalid' });
  });

  it('office: stateSince holds while the state holds, resets on change, forgets occupants that left', () => {
    const t = createStateTracker();
    assert.equal(t.since('main', 'idle', 100), 100);
    assert.equal(t.since('main', 'idle', 200), 100);
    assert.equal(t.since('main', 'working', 300), 300);
    t.keep(new Set());
    assert.equal(t.since('main', 'working', 400), 400);
  });
});

describe('R1-11 · SKILL.md read only inside approved roots', () => {
  let tmp, home, outside, reader;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-skilldoc-'));
    home = path.join(tmp, 'home'); outside = path.join(tmp, 'outside');
    const ok = path.join(home, '.openclaw', 'skills', 'meteo'); fs.mkdirSync(ok, { recursive: true });
    fs.writeFileSync(path.join(ok, 'SKILL.md'), '---\nname: meteo\n---\n# Météo\n1. Lire');
    fs.writeFileSync(path.join(ok, 'notes.md'), 'pas un SKILL.md');
    fs.mkdirSync(path.join(outside, 'x'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'x', 'SKILL.md'), 'SECRET outside');
    fs.symlinkSync(path.join(outside, 'x'), path.join(home, '.openclaw', 'skills', 'escape'));           // a dir symlink out of the root
    fs.symlinkSync(path.join(outside, 'x', 'SKILL.md'), path.join(ok, 'link.md'));
    const big = path.join(home, '.openclaw', 'skills', 'big'); fs.mkdirSync(big);
    fs.writeFileSync(path.join(big, 'SKILL.md'), 'x'.repeat(MAX_BYTES + 1));
    const ws = path.join(tmp, 'ws', 'skills', 'notes'); fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'SKILL.md'), '# Notes');
    reader = createSkillDocReader({ home, bin: null, workspaces: () => [path.join(tmp, 'ws')] });
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('reads a SKILL.md in a root (frontmatter split) and in an agent workspace', () => {
    assert.deepEqual(reader.read(path.join(home, '.openclaw', 'skills', 'meteo', 'SKILL.md')), { markdown: '# Météo\n1. Lire', frontmatter: { name: 'meteo' } });
    assert.equal(reader.read(path.join(tmp, 'ws', 'skills', 'notes', 'SKILL.md')).markdown, '# Notes');
  });
  it('refuses: another basename, a symlinked escape, outside every root, too big, relative or missing paths', () => {
    for (const p of [path.join(home, '.openclaw', 'skills', 'meteo', 'notes.md'), path.join(home, '.openclaw', 'skills', 'escape', 'SKILL.md'),
      path.join(outside, 'x', 'SKILL.md'), path.join(home, '.openclaw', 'skills', 'big', 'SKILL.md'), 'skills/meteo/SKILL.md', path.join(home, 'nope', 'SKILL.md'), null]) {
      assert.deepEqual(reader.read(p), { markdown: '', frontmatter: {} }, String(p));
    }
  });
});
