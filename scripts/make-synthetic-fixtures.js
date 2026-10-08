#!/usr/bin/env node
'use strict';
/*
 * Writes the hand-written "synthetic-basic" scenario under test/fixtures/. No live data is used:
 * every id is a fake (snowflakes start with 100000, uuids with ffffffff-), every name is invented.
 * Shapes follow what server.js reads today; real shapes come from scripts/capture-fixtures.js.
 *
 *   node scripts/make-synthetic-fixtures.js      (idempotent; review the diff)
 */
const fs = require('fs');
const path = require('path');

const FIX = path.resolve(__dirname, '..', 'test', 'fixtures');
const NAME = 'synthetic-basic';
const V = '2026.9.8';
const NOW = Date.UTC(2026, 9, 5, 18, 0, 0);      // 2026-10-05 14:00 America/Toronto
const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

const files = {};
const env = (source, channel, body, params) => ({ $fixture: { source, channel, origin: 'synthetic', openclawVersion: V, params }, body });
const json = (value) => ({ kind: 'json', value });
const put = (rel, obj) => { files[rel] = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n'; return rel; };
const rpc = (method, value, suffix, params) => put(`gw/rpc/${method}/${V}/${NAME}${suffix ? '-' + suffix : ''}.json`, env('gateway', 'gw.rpc.' + method, json(value), params));

// ---------- ids ----------
const SUB1 = 'ffffffff-0001-4000-8000-000000000001';
const SUB2 = 'ffffffff-0002-4000-8000-000000000002';
const JOB1 = 'ffffffff-0c01-4000-8000-000000000001';
const JOB2 = 'ffffffff-0c02-4000-8000-000000000002';
const JOB3 = 'ffffffff-0c03-4000-8000-000000000003';
const USER1 = '100000000000000001';
const CHAN1 = '100000000000000002';
const CHAN2 = '100000000000000004';
const GUILD = '100000000000000009';

// Key shapes follow capture-20261005 (docs/architecture/capture-findings.md).
const DASH = 'ffffffff-da5b-4000-8000-000000000001';
const ACP = 'ffffffff-acb0-4000-8000-000000000001';
const K = {
  main: 'agent:main:main',
  heartbeat: 'agent:main:main:heartbeat',
  sub1: `agent:main:subagent:${SUB1}`,
  sub2: `agent:main:subagent:${SUB2}`,
  cron1: `agent:main:cron:${JOB1}`,
  dm: `agent:main:discord:direct:${USER1}`,
  dash: `agent:main:dashboard:${DASH}`,
  chan: `agent:main:discord:channel:${CHAN1}`,
  portal: 'agent:main:explicit:portal-chat',
  wa: 'agent:main:wechat:group:fake-group',
  acp: `agent:claude:acp:${ACP}`,
  chanHb: `agent:main:discord:channel:${CHAN1}:heartbeat`,
};

// ---------- gateway RPCs ----------
put(`gw/hello/${V}/${NAME}.json`, env('gateway', 'gw.hello', json({ protocol: 4, server: { version: V } })));

rpc('agents.list', {
  defaultId: 'main',
  agents: [
    { id: 'main', name: 'Timmy', workspace: '/srv/fake/workspace-main', model: { primary: 'provider-a/model-a' } },
    { id: 'scout', name: 'Scout', workspace: '/srv/fake/workspace-scout', model: 'provider-b/model-b' },
  ],
});

const sess = (key, o) => Object.assign({ key, sessionId: 'ffffffff-5e55-4000-8000-' + String(Object.keys(K).indexOf(Object.keys(K).find((k) => K[k] === key))).padStart(12, '0') }, o);
const base = { kind: 'direct', isBackground: false, agentId: 'main' };
rpc('sessions.list', {
  totalCount: 12, count: 12, hasMore: false, nextOffset: null, limitApplied: 300,
  sessions: [
    sess(K.main, { ...base, isMain: true, channel: 'whatsapp', updatedAt: NOW - 2 * M, totalTokens: 52300, model: 'model-a', modelProvider: 'provider-a', hasActiveRun: false, status: 'done' }),
    sess(K.heartbeat, { ...base, isBackground: true, updatedAt: NOW - 1 * M, totalTokens: 900, model: 'model-a', modelProvider: 'provider-a', status: 'done' }),
    sess(K.sub1, { ...base, isBackground: true, subagentRole: 'worker', spawnedBy: K.main, updatedAt: NOW - 30 * S, totalTokens: 8100, model: 'model-a', modelProvider: 'provider-a', hasActiveRun: true, status: 'active' }),
    sess(K.sub2, { ...base, isBackground: true, subagentRole: 'worker', spawnedBy: K.main, updatedAt: NOW - 3 * H, totalTokens: 4200, model: 'model-a', status: 'complete', startedAt: NOW - 3 * H - 5 * M, endedAt: NOW - 3 * H }),
    sess(K.cron1, { ...base, isBackground: true, updatedAt: NOW - 20 * S, totalTokens: 1500, modelProvider: 'provider-a', status: 'active' }),
    sess(K.dm, { ...base, channel: 'discord', updatedAt: NOW - 1 * M, totalTokens: 3300, model: 'model-a', startedAt: NOW - 60 * S }),
    sess(K.dash, { ...base, spawnedBy: K.main, updatedAt: NOW - 9 * D, totalTokens: 700, model: 'model-a', status: 'done' }),
    sess(K.chan, { ...base, kind: 'group', channel: 'discord', updatedAt: NOW - 2 * D, totalTokens: 12000, model: 'model-a', status: 'done' }),
    sess(K.portal, { ...base, updatedAt: NOW - 10 * M, totalTokens: 2100, model: 'model-a', status: 'done' }),
    sess(K.wa, { ...base, kind: 'group', channel: 'wechat', updatedAt: NOW - 5 * H, totalTokens: 400, model: 'model-a', status: 'timeout', startedAt: NOW - 5 * H - M }),
    sess(K.acp, { ...base, agentId: 'claude', isBackground: true, spawnedBy: K.main, updatedAt: NOW - 4 * H, totalTokens: 600, model: 'model-b', status: 'killed', endedAt: NOW - 4 * H }),
    sess(K.chanHb, { ...base, kind: 'group', channel: 'discord', isBackground: true, updatedAt: NOW - 3 * M, totalTokens: 100, model: 'model-a', status: 'done' }),
  ],
});

rpc('cron.list', {
  jobs: [
    { id: JOB1, name: 'Veille hebdomadaire', description: 'Résumé des nouveautés de la semaine.', enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * 1', tz: 'America/Toronto' }, agentId: 'main', sessionTarget: 'isolated', wakeMode: 'now',
      payload: { kind: 'message', message: '1. Cherche les nouveautés\n2. Résume en français\n3. Publie le résumé' },
      createdAtMs: NOW - 30 * D, updatedAtMs: NOW - 2 * D },
    { id: JOB2, name: 'Rapport du matin', enabled: false,
      schedule: { kind: 'cron', expr: '30 7 * * *', tz: 'America/Toronto' }, agentId: 'main', sessionTarget: 'isolated', wakeMode: 'now',
      payload: { kind: 'message', message: 'VEILLE: lire les flux\nRAPPORT: envoyer un message' },
      createdAtMs: NOW - 20 * D, updatedAtMs: NOW - 20 * D },
    { id: JOB3, name: 'Vérification rapide', description: '', enabled: true,
      schedule: { kind: 'cron', expr: '*/15 * * * *' }, agentId: 'main', sessionTarget: 'main', wakeMode: 'next-heartbeat',
      payload: { kind: 'message', message: 'Vérifie la file.' },
      createdAtMs: NOW - 5 * D, updatedAtMs: NOW - 5 * D },
  ],
});

rpc('channels.status', {
  ts: NOW,
  channelOrder: ['discord', 'whatsapp', 'openclaw-weixin'],
  channelLabels: { discord: 'Discord', whatsapp: 'WhatsApp', 'openclaw-weixin': 'Weixin' },
  channelDetailLabels: { discord: 'Bot Discord', whatsapp: 'WhatsApp Web', 'openclaw-weixin': 'Weixin' },
  channelSystemImages: { discord: 'bubble', whatsapp: 'phone' },
  channelMeta: [{ id: 'discord', label: 'Discord', detailLabel: 'Bot Discord', systemImage: 'bubble' }],
  eventLoop: { degraded: false, degradedSinceMs: null, reasons: [], intervalMs: 1000, delayP99Ms: 12.6, delayMaxMs: 30.1, utilization: 0.12, cpuCoreRatio: 0.08,
    cpuBreakdown: { mainThreadCoreRatio: 0.05, hostUtilization: 0.2, hostCpuCount: 4, workerCoreRatio: 0.01, otherThreadsCoreRatio: 0.02 } },
  channels: {
    discord: { configured: true, running: true, lastStartAt: NOW - 3 * D, lastStopAt: null, lastError: null, tokenSource: 'config', lastProbeAt: null },
    'openclaw-weixin': { configured: false },
    whatsapp: { configured: true, statusState: 'unlinked', linked: false, running: false, connected: false, reconnectAttempts: 0, lastError: null, lifecycle: 'stopped', healthState: 'idle', busy: false },
  },
  channelAccounts: {
    discord: [{ accountId: 'default', enabled: true, lastStartAt: NOW - 3 * D, lifecycle: 'running', busy: true, activeRuns: 1, lastInboundAt: NOW - 1 * M, lastOutboundAt: NOW - 50 * S,
      tokenSource: 'config', tokenStatus: 'ok', bot: { id: '100000000000000008', username: 'timmy-bot' }, groupPolicy: 'allowlist', guildsConfigured: 1, configured: true }],
  },
});

rpc('sessions.usage', { totals: { totalTokens: 85500 } });

// sessions.get / describe for a few keys
const getFiles = {}, descFiles = {};
const transcript = {
  [K.main]: { messages: [
    { role: 'user', content: 'Quel temps fera-t-il demain ?', timestamp: NOW - 3 * M, senderName: 'Owner' },
    { role: 'assistant', timestamp: NOW - 3 * M + 2 * S, model: 'model-a', provider: 'provider-a', usage: { output_tokens: 120 },
      content: [{ type: 'text', text: 'Je regarde la météo.' }, { type: 'toolCall', id: 'call_1', name: 'web_search', arguments: { query: 'météo demain' } }] },
    { role: 'toolResult', toolCallId: 'call_1', toolName: 'web_search', isError: false, timestamp: NOW - 3 * M + 5 * S, content: [{ type: 'text', text: 'Ensoleillé, 18 °C.' }] },
    { role: 'assistant', timestamp: NOW - 3 * M + 7 * S, model: 'model-a', provider: 'provider-a', usage: { output_tokens: 40 }, content: [{ type: 'text', text: 'Demain : ensoleillé, 18 °C.' }] },
  ] },
  [K.sub1]: { messages: [
    { role: 'user', content: [{ type: 'text', text: 'Analyse le dépôt.' }], timestamp: NOW - 2 * M },
    { role: 'assistant', timestamp: NOW - 2 * M + S, content: [{ type: 'tool_use', id: 'tu_1', name: 'exec', input: { cmd: 'ls' } }] },
    { role: 'tool', content: [{ toolUseId: 'tu_1', content: 'README.md\nserver.js' }], isError: true, timestamp: NOW - 2 * M + 3 * S },
  ] },
  [K.dm]: { messages: [
    { role: 'user', content: 'Salut Timmy', timestamp: NOW - 60 * S, senderLabel: 'Guest' },
    { role: 'assistant', content: 'Bonjour Guest !', timestamp: NOW - 55 * S },
  ] },
};
let n = 0;
for (const [key, value] of Object.entries(transcript)) {
  n++;
  getFiles[key] = rpc('sessions.get', value, String(n), { key });
  descFiles[key] = rpc('sessions.describe', { session: { key, displayName: key === K.main ? 'Session principale' : null, kind: key === K.main ? 'main' : 'direct', model: 'model-a', modelProvider: 'provider-a', updatedAt: NOW - M } }, String(n), { key });
}

const run = (o) => Object.assign({ action: 'finished', model: 'model-a', provider: 'provider-a', deliveryStatus: 'delivered', delivery: { intended: { channel: 'discord' } } }, o);
const runFiles = {
  [JOB1]: rpc('cron.runs', { entries: [
    run({ runAtMs: NOW - 7 * D, status: 'ok', durationMs: 128000, nextRunAtMs: NOW, usage: { input_tokens: 3000, output_tokens: 800, total_tokens: 3800 }, summary: 'Résumé publié.' }),
    run({ runAtMs: NOW - 14 * D, status: 'error', durationMs: 45000, nextRunAtMs: NOW - 7 * D, usage: { totalTokens: 900 }, deliveryStatus: 'skipped', error: 'Délai dépassé', summary: '' }),
  ] }, '1', { jobId: JOB1 }),
  [JOB2]: rpc('cron.runs', { entries: [] }, '2', { jobId: JOB2 }),
  [JOB3]: rpc('cron.runs', { runs: [run({ ts: NOW - 15 * M, status: 'ok', durationMs: 4000 })] }, '3', { jobId: JOB3 }),
};

// ---------- events ----------
const health = put(`gw/event/health/${V}/${NAME}-1.json`, env('gateway', 'gw.event.health', json({
  ok: true, server: { version: V }, eventLoop: { degraded: false, delayP99Ms: 12.6 }, plugins: { loaded: ['discord', 'whatsapp', 'memory'] },
})));
// 2026.9.8 sends no session.tool/message/operation events (capture-20261005-active); sessions.changed carries the row.
// keyed sessions.changed carries the FULL session row (OpenClaw session-change-event), keyed sessionKey
const changedRow = (key, o) => { const { key: k, ...rest } = sess(key, o); return Object.assign({ sessionKey: k }, rest); };
const changedEvt = put(`gw/event/sessions.changed/${V}/${NAME}-1.json`, env('gateway', 'gw.event.sessions.changed', json(changedRow(K.sub1, {
  reason: 'run-started', agentId: 'main', kind: 'direct', isBackground: true, subagentRole: 'worker', spawnedBy: K.main,
  status: 'active', startedAt: NOW - 40 * S, updatedAt: NOW - 30 * S, totalTokens: 8100, model: 'model-a', modelProvider: 'provider-a',
  activitySummary: { state: 'updating', updatedAt: NOW - 30 * S, canEnsure: true, text: 'Analyse en cours' },
}))));
const chatMetaEvt = put(`gw/event/chat.metadata.changed/${V}/${NAME}-1.json`, env('gateway', 'gw.event.chat.metadata.changed', json({ agentId: 'main', usageUpdatedAt: NOW - 20 * S, modelCatalogChanged: false, authChanged: false })));
const cronEvt = put(`gw/event/cron/${V}/${NAME}-1.json`, env('gateway', 'gw.event.cron', json({ jobId: JOB1, name: 'Veille hebdomadaire', action: 'started' })));
// S6.1 (live drift on S6 staging), shapes from OpenClaw 2026.9.8 server-cron / session-change-event:
// a run end with the protocol's explicit-null tombstones, a finished cron run, and two unadvertised broadcasts.
const changedEndEvt = put(`gw/event/sessions.changed/${V}/${NAME}-2.json`, env('gateway', 'gw.event.sessions.changed', json(changedRow(K.sub1, {
  ...base, reason: 'update', runId: 'run_synthetic_1', ts: NOW - 5 * S, isBackground: true, subagentRole: 'worker', spawnedBy: K.main,
  status: 'done', startedAt: NOW - 40 * S, endedAt: NOW - 6 * S, runtimeMs: 34000, lastRunId: null, hasActiveRun: false,
  updatedAt: NOW - 6 * S, totalTokens: 9100, model: 'model-a', modelProvider: 'provider-a',
}))));
const changedNullsEvt = put(`gw/event/sessions.changed/${V}/${NAME}-3.json`, env('gateway', 'gw.event.sessions.changed', json(changedRow(K.main, {
  ...base, isMain: true, channel: 'whatsapp', reason: 'update', ts: NOW - 4 * S, catalogChanged: false, totalTokens: 52300, model: 'model-a',
  modelProvider: 'provider-a', hasActiveRun: false, status: 'done', startedAt: null, endedAt: null, runtimeMs: null, lastRunId: null, updatedAt: NOW - 2 * M,
}))));
const cronDoneEvt = put(`gw/event/cron/${V}/${NAME}-2.json`, env('gateway', 'gw.event.cron', json({
  jobId: JOB1, action: 'finished', status: 'ok', completionStatus: 'completed', summary: 'Résumé publié.', error: null,
  runId: 'run_synthetic_2', sessionKey: K.cron1, sessionId: 'ffffffff-0005-4000-8000-000000000001', runAtMs: NOW - 2 * M, durationMs: 4200,
  nextRunAtMs: NOW + 6 * D, delivered: false, deliveryStatus: 'not-requested', deliveryError: null, model: 'model-a', provider: 'provider-a',
  usage: { input_tokens: 900, output_tokens: 300, total_tokens: 1200 }, diagnostics: { summary: 'ok' },
  job: { id: JOB1, name: 'Veille hebdomadaire', enabled: true },
})));
const unadvertised1 = put(`gw/event/config.changed/${V}/${NAME}-1.json`, env('gateway', 'gw.event.config.changed', json({ ts: NOW - 3 * S })));
const unadvertised2 = put(`gw/event/board.changed/${V}/${NAME}-1.json`, env('gateway', 'gw.event.board.changed', json({ ts: NOW - 2 * S })));

// ---------- CLI ----------
const skill = (o) => Object.assign({ emoji: '', description: '', disabled: false, eligible: true, source: 'openclaw-bundled', bundled: true,
  modelVisible: true, commandVisible: false, userInvocable: false, homepage: '', missing: { bins: [], anyBins: [], env: [], config: [], os: [] } }, o);
const skills = [
  skill({ name: 'weather', emoji: '⛅', description: 'Prévisions météo.', homepage: 'https://example.invalid/weather', userInvocable: true }),
  skill({ name: 'github', emoji: '🐙', description: 'Dépôts GitHub.', disabled: true, source: 'openclaw-extra', bundled: false }),
  skill({ name: 'nano-pdf', description: 'Édition de PDF.', eligible: false, missing: { bins: ['nano-pdf'], anyBins: [], env: [], config: [], os: [] } }),
  skill({ name: 'workspace-notes', description: 'Notes du projet.', source: 'openclaw-workspace', bundled: false, commandVisible: true }),
];
const cliText = (channel, text, argv, exitCode) => env('cli', channel, { kind: 'text', exitCode: exitCode || 0, value: text }, { argv });
const skillsList = put(`cli/skills.list/${V}/${NAME}.json`, cliText('cli.skills.list', '🦞 OpenClaw ' + V + '\n' + JSON.stringify({ skills }, null, 2) + '\n', ['skills', 'list', '--agent', 'main', '--json']));
const info = (s, filePath) => ({
  name: s.name, description: s.description, source: s.source, bundled: s.bundled, filePath, baseDir: filePath ? filePath.replace(/\/SKILL\.md$/, '') : undefined,
  skillKey: s.name, always: false, disabled: s.disabled, blockedByAllowlist: false, eligible: s.eligible, emoji: s.emoji, homepage: s.homepage,
  missing: s.missing, configChecks: [], blockedByAgentFilter: false, platformIncompatible: false, modelVisible: s.modelVisible, userInvocable: s.userInvocable,
  commandVisible: s.commandVisible, requirements: { bins: s.missing.bins, anyBins: [], env: [], config: [], os: [] },
  install: s.missing.bins.length ? [{ id: 'brew', kind: 'brew', label: 'Installer avec Homebrew', bins: s.missing.bins }] : [],
});
const infoFiles = {
  weather: put(`cli/skills.info/${V}/${NAME}-1.json`, cliText('cli.skills.info', JSON.stringify(info(skills[0], '{{FIXTURES_DIR}}/files/skills/weather/SKILL.md'), null, 2) + '\n', ['skills', 'info', '<name>', '--agent', 'main', '--json'])),
  github: put(`cli/skills.info/${V}/${NAME}-2.json`, cliText('cli.skills.info', JSON.stringify(info(skills[1], null), null, 2) + '\n', ['skills', 'info', '<name>', '--agent', 'main', '--json'])),
  'nano-pdf': put(`cli/skills.info/${V}/${NAME}-3.json`, cliText('cli.skills.info', 'Warning: binary missing\n' + JSON.stringify(info(skills[2], null)) + '\n', ['skills', 'info', '<name>', '--agent', 'main', '--json'])),
};
put('files/skills/weather/SKILL.md', [
  '---', 'name: weather', 'description: Prévisions météo pour une ville.', 'homepage: https://example.invalid/weather', '---', '',
  '# Météo', '', 'Donne la météo actuelle et les prévisions.', '', '## Quand l\'utiliser', '', '- La personne demande la météo.', '',
  '## Étapes', '', '1. Trouver la ville', '2. Appeler l\'API', '3. Répondre avec un résumé', '', '## Sortie', '', 'Un message court avec la température.', '',
].join('\n'));

// ---------- config (synthetic; never a copy of the real openclaw.json) ----------
const config = put(`config/openclaw/${V}/${NAME}.json`, {
  channels: { discord: { dmPolicy: 'pairing', groupPolicy: 'allowlist',
    guilds: { [GUILD]: { channels: { [CHAN1]: { enabled: true, requireMention: true }, [CHAN2]: { enabled: false } } } } } },
  tools: { exec: { security: 'allowlist' } },
  skills: { entries: { github: { enabled: false } } },
});

put(`host/df/${NAME}.json`, env('host', 'host.df', { kind: 'text', value: 'Filesystem 1B-blocks Used Available Use% Mounted on\n/dev/disk0 500000000000 200000000000 300000000000 40% /\n' }));

put(`scenarios/${NAME}.json`, {
  name: NAME, origin: 'synthetic', openclawVersion: V, now: NOW, config,
  rpc: {
    'agents.list': `gw/rpc/agents.list/${V}/${NAME}.json`,
    'sessions.list': `gw/rpc/sessions.list/${V}/${NAME}.json`,
    'cron.list': `gw/rpc/cron.list/${V}/${NAME}.json`,
    'channels.status': `gw/rpc/channels.status/${V}/${NAME}.json`,
    'sessions.usage': `gw/rpc/sessions.usage/${V}/${NAME}.json`,
    'sessions.get': { param: 'key', files: getFiles },
    'sessions.describe': { param: 'key', files: descFiles },
    'cron.runs': { param: 'jobId', files: runFiles },
  },
  events: { onConnect: [health], observed: [health, changedEvt, chatMetaEvt, cronEvt, changedEndEvt, changedNullsEvt, cronDoneEvt, unadvertised1, unadvertised2] },
  cli: { 'skills.list': skillsList, 'skills.info': infoFiles },
  host: { df: `host/df/${NAME}.json` },
  notes: ['Hand-written. Shapes follow server.js reads; confirm against a real capture.'],
});

for (const [rel, content] of Object.entries(files)) {
  const abs = path.join(FIX, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
console.log(`wrote ${Object.keys(files).length} files under test/fixtures/`);
