'use strict';
const path = require('node:path'), os = require('node:os');
const s = require('../../schema');
const { createFiles, BOUNDS } = require('./files');
const { PROFILE } = require('./profile');
const { runFromTranscript, unknownRun, chooseTailsByAgent } = require('../transcript-execution');
const label = key => ({ key: 'settings.claude.' + key });
const defaults = ({ home = path.join(os.homedir(), '.claude'), include = [], exclude = [], agentGrouping = 'project' } = {}) => ({ home, include, exclude, agentGrouping });
const filters = s.array(s.string().min(1).max(256).refine(v => !/[\x00-\x1f/\\]/.test(v) && !['.', '..'].includes(v), 'project directory key')).max(2000);
const optionsSchema = s.object({ home: s.string().min(1).max(4096).refine(v => path.isAbsolute(v) && !/[\x00-\x1f]/.test(v), 'absolute directory'),
  include: filters, exclude: filters, agentGrouping: s.enumOf(['project', 'runtime']) }, { extra: 'reject' });
const definition = { id: 'claude-code', name: 'Claude Code', identity: { sessionRef: 'transcript session id; private cross-source matching only' }, mark: { monogram: 'CC', color: '#a34a2c', providerName: 'Claude Code', logo: 'assets/connectors/claude-code.svg' }, gatewayLabel: 'Transcripts', eventPrefix: 'claude.', schemas: {}, routes: {},
  normalise: { session: x => ({ session: x }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) }, classifySession: () => ({ kind: 'unrecognized', agentId: null }), presence: 'agents',
  transcriptBounds: { sessions: BOUNDS.cacheSessions, bytes: BOUNDS.cacheBytes },
  capabilities: () => ({ agents: true, sessions: true, transcripts: true, flows: { read: false, write: false }, skills: { list: false, detail: false, toggle: false },
    channels: false, interlocutors: false, chat: false, restart: false, costs: false, subagents: true, sessionGroups: false }) };
const agentName = (row, options, files) => options.agentGrouping === 'runtime' ? 'Claude Code' : row.projectName || 'Project ' + files.agentId(row.project).slice(8, 20);
const fileSignature = row => `${row.dev}:${row.ino}:${row.size}:${row.mtime}`;
function createRuntime(cfg, { now = Date.now } = {}) {
  const options = defaults(cfg.runtimeConfig?.claudeCode || { home: cfg.claudeHome }), files = createFiles({ ...options, now });
  let engine, timer, closed = false, cycling = false, retryAt = 0, scanFailures = 0, overflowSeen = 0, healthFailure = null, failureTarget = null;
  const failures = new Set();
  const last = new Map();
  const loaded = new Set();
  const readRetries = new Map();
  const report = error => { healthFailure = error.code === 'EFORMAT' ? 'format' : error.code === 'ENOENT' ? 'missing' : 'unreadable'; engine?.notifyHealth?.(); };
  function publishAgents(rows) {
    const grouped = new Map();
    // a project's agent is named and keyed by its own sessions; sub-agent transcripts only count when nothing else does
    const main = rows.filter(r => !r.subagent);
    for (const row of [...main, ...rows.filter(r => r.subagent && !main.some(m => m.agentId === r.agentId))]) {
      const group = grouped.get(row.agentId) || { latest: row, named: null };
      if (group.latest.mtime < row.mtime) group.latest = row;
      if (row.projectName && (!group.named || group.named.mtime < row.mtime)) group.named = row;
      grouped.set(row.agentId, group);
    }
    engine.ingestCanonical('agents', [...grouped.values()].map(({ latest: r, named }) => ({ id: r.agentId, name: agentName(named || r, options, files),
      displayName: r.displayName || null, summary: r.summary || null,
      workspace: null, model: r.model ? { primary: r.model, provider: null } : null, fallbackModels: [], isPrimary: false, mainSessionKey: r.key })));
  }
  function publish(rows) {
    publishAgents(rows);
    engine.setIdentitySessionRefs?.(rows.filter(r => !r.subagent).map(r => ({ sessionKey: r.key, sessionRef: r.sessionId })));
    // T-0062: a sub-agent transcript is a canonical `subagent` session of its parent conversation: parentKey/childKeys,
    // spawnedBy (the parent session and project agent) and, when the parent's tool call is known, its description.
    const byKey = new Map(rows.map(r => [r.key, r]));
    const children = new Map();
    for (const r of rows) if (r.subagent && byKey.has(r.parentKey)) children.set(r.parentKey, [...(children.get(r.parentKey) || []), r.key]);
    engine.ingestCanonical('sessions.snapshot', rows.map(r => {
      const parent = r.subagent ? byKey.get(r.parentKey) || null : null;
      const task = r.subagent ? parent?.spawns?.find(x => x.agentId === r.subagent)?.description || null : null;
      // sessionId stays the runtime's own session id, unique per conversation (exact cross-source dedupe); a sub-agent has none
      return { key: r.key, sessionId: r.subagent ? null : r.sessionId,
        class: { kind: r.subagent ? 'subagent' : 'conversation', ruleId: PROFILE, agentId: r.agentId, channel: null, heartbeatOf: null, background: false, rawClassification: null,
          ...(r.subagent ? { subagentId: r.subagent } : {}) },
        displayName: r.summarySource === 'title' ? r.displayName || null : task || r.displayName || null, summary: r.summary || null, summarySource: r.summarySource === 'title' ? 'runtime' : r.summary ? 'transcript' : null, projectLabel: r.projectName ? r.projectName.slice(0, 120) : null,
        model: r.model ? { id: r.model, provider: null } : null, provider: null, usage: { total: 0, input: null, output: null },
        updatedAt: r.at || Math.round(r.mtime), run: r.execution ? runFromTranscript(r.execution, now()) : unknownRun(), costUsd: null, parentKey: parent ? r.parentKey : null, childKeys: children.get(r.key) || [], goal: null, cwd: null,
        messageCount: null, interactive: !!r.subagent /* data-model: subagent sessions are interactive */, group: null,
        spawnedBy: r.subagent ? { agentId: r.agentId, sessionKey: parent ? r.parentKey : null, via: 'subagent-tool', label: task || r.summary || null } : null };
    }));
  }
  async function load(key, refresh = false) {
    try {
      const value = await files.read(key, { refresh }); if (!value || closed) return { ok: false, category: 'not-found' };
      engine.ingestCanonical('transcript', value, { key });
      loaded.add(key);
      const row = files.rows().find(r => r.key === key);
      if (row?.activityAt && row.activityAt <= now() && now() - row.activityAt < 30000) engine.setObservedActivity(key, { kind: 'working', source: 'transcript', since: row.activityAt, expiresAt: row.activityAt + 30000 });
      failures.delete(key); readRetries.delete(key); if (!failures.size) { healthFailure = null; failureTarget = null; engine.setSourceDown('transcripts', false); engine.notifyHealth?.(); }
      return { ok: true };
    } catch (error) {
      const count=(readRetries.get(key)?.count || 0)+1, row = files.rows().find(item => item.key === key);
      const terminal = error.code === 'EFORMAT' && row?.coverageComplete && !row.recognizable;
      readRetries.set(key,{count,at:terminal ? Infinity : now()+Math.min(30000,2000*2**Math.min(4,count-1)),signature:row ? fileSignature(row) : null});
      failures.add(key); report(error); return { ok: false, category: error.code === 'EFORMAT' ? 'unsupported-format' : 'unreadable' };
    }
  }
  async function cycle() {
    if (closed || cycling) return;
    engine.expireObservedActivity(); if (now()<retryAt) return;
    cycling = true;
    try {
      const rows = await files.scan(); if (closed) return;
      retryAt=0;scanFailures=0;
      for (const row of rows) { const retry = readRetries.get(row.key); if (retry?.signature && retry.signature !== fileSignature(row)) readRetries.delete(row.key); }
      engine.setSourceDown('capacity', !!files.stats.truncated || (files.stats.queueOverflow || 0)>overflowSeen, 'capacity-limited');overflowSeen=files.stats.queueOverflow || 0;
      const keys = new Set(rows.map(r => r.key));
      for (const key of new Set([...last.keys(), ...loaded, ...failures])) if (!keys.has(key)) { last.delete(key); loaded.delete(key); failures.delete(key); readRetries.delete(key); engine.forgetTranscript(key,{activity:true}); }
      if (!failures.size && healthFailure) { healthFailure = null; failureTarget = null; engine.notifyHealth?.(); }
      // Metadata only for the full index; recent tails are fair, bounded and lazy.
      const dueRows = rows.filter(r => (r.mtime >= now() - 30000 || `${r.dev}:${r.ino}:${r.size}:${r.mtime}` !== last.get(r.key))
        && now()>=(readRetries.get(r.key)?.at || 0))
        .sort((a, b) => Number(b.mtime >= now() - 30000) - Number(a.mtime >= now() - 30000) || b.mtime - a.mtime || a.key.localeCompare(b.key));
      const due = chooseTailsByAgent(dueRows, BOUNDS.tails);
      publish(rows); engine.setGatewayConnected(true);
      for (const r of due) { if (closed) break; if ((await load(r.key, true)).ok) last.set(r.key, `${r.dev}:${r.ino}:${r.size}:${r.mtime}`); }
      // reads refresh titles, summaries and sub-agent tool-call links (T-0062): republish the whole snapshot
      if (!closed && due.length) publish(rows);
    } catch (error) { retryAt=now()+Math.min(30000,2000*2**Math.min(4,scanFailures++));report(error); } finally { cycling = false; }
  }
  const reads = { transcript: key => load(key), describeSession: async key => ({ ok: !!engine.session(key), category: 'not-found' }) };
  const boundDefinition = { ...definition, health: {
    checks: () => healthFailure ? [{ id: 'transcript-scan', severity: 'warn', causeCode: healthFailure, textKey: `healthCheck.transcript.${healthFailure}`,
      impactKey: 'healthImpact.transcripts', remedy: 'auto', actionId: 'rescan', target: failureTarget }] : [],
    remedies: { rescan: async () => {
      // Retry the exact failed tails. A general scan is capacity-limited and can be
      // in backoff, so it may otherwise report success without touching this file.
      await files.scan();
      let lastFailure = null;
      for (const key of [...failures].slice(0, BOUNDS.tails)) {
        const row = files.rows().find(item => item.key === key);
        // HealthVM is readable without transcript permission. Never expose project paths or
        // transcript/session filenames here; the UI translates this generic safe target.
        failureTarget = 'transcript';
        const result = await load(key, true);
        if (!result.ok) lastFailure = result.category;
      }
      if (failures.size) return { ok: false, category: lastFailure || healthFailure || 'unreadable', target: failureTarget };
      await cycle();
      return { ok: !healthFailure, category: healthFailure || null };
    } },
  } };
  return { definition: boundDefinition, files, commands: {}, reads,
    attach(value) { engine = value; engine.setReads(reads); },
    async start(value, hooks = {}) { engine = value; await cycle(); if (closed) return; hooks.refreshed?.(); timer = setInterval(() => { cycle().then(() => hooks.refreshed?.()); }, 2000); timer.unref?.(); },
    cycle, close() { closed = true; clearInterval(timer); files.close(); engine?.close(); }, refreshFlows: async () => {}, refreshSkills: async () => {} };
}
const fields = [{ id: 'home', label: label('home'), type: 'text', required: true, writeOnly: false, options: [] },
  ...['include', 'exclude'].map(id => ({ id, label: label(id), type: 'textarea', control: 'chips', required: false, writeOnly: false, options: [] })),
  { id: 'agentGrouping', label: label('grouping'), type: 'select', required: true, writeOnly: false,
    options: ['project', 'runtime'].map(value => ({ value, label: label(value) })) }];
const values = cfg => { const v = defaults(cfg.runtimeConfig?.claudeCode || { home: cfg.claudeHome }); return { ...v, include: v.include.join('\n'), exclude: v.exclude.join('\n') }; };
const resolve = (input, saved = {}) => {
  const v = { ...defaults(), ...saved, ...input };
  for (const key of ['include', 'exclude']) v[key] = typeof v[key] === 'string' ? v[key].split(/\r?\n/).map(x => x.trim()).filter(Boolean) : v[key];
  const { adapter, ...options } = v, result = s.validate(optionsSchema, options);
  if (!result.ok) throw Object.assign(new Error('invalid transcript options'), { field: 'home' });
  return { adapter: 'claude-code', ...options };
};
async function discover({runtime={},env={}}={}) {
  const options=defaults({...runtime,home:runtime.home || paths(env).claudeHome}), files=createFiles(options);
  try {
    const rows = (await files.scan()).sort((a, b) => b.mtime - a.mtime || a.key.localeCompare(b.key)), groups = new Map();
    for (const row of rows) if (!groups.has(row.agentId)) groups.set(row.agentId, row);
    // One recent bounded window per project, within the existing tail cap.
    // Unsupported sessions keep an opaque fallback and cannot break discovery.
    for (const row of [...groups.values()].slice(0, BOUNDS.tails)) { try { await files.read(row.key); } catch {} }
    return [...groups.values()].map(row => ({ id: row.agentId, name: agentName(row, options, files), displayName: row.displayName || null, summary: row.summary || null, workspace: null, model: null }));
  }
  finally { files.close(); }
}
const setup = { connect: true, name: 'Claude Code', fields: fields.map(f => f.id), defaultGatewayUrl: null, capabilities: { autoAddDefault: true, brand: { mark: 'CC', color: '#b8753e', foreground: '#20130b', providerName: 'Claude Code', logo: 'assets/connectors/claude-code.svg' } },
  configSchema: s.object({ adapter: s.literal('claude-code'), claudeCode: optionsSchema }, { extra: 'reject' }),
  env: ({ runtime }) => ({ AO_CLAUDE_HOME: runtime.claudeCode.home }),
  config: rt => ({ adapter: 'claude-code', claudeCode: defaults(rt) }),
  agents: () => [], discover,
  settings: { detectionIdentity: ({ cfg, detection }) => ({ paths: [detection ? detection.home || detection.checkedPaths?.[0] : cfg.claudeHome || cfg.runtimeConfig?.claudeCode?.home] }), fields, envKeys: { home: 'AO_CLAUDE_HOME' }, values, resolve, secret: () => null,
    detectedValues: (d = {}) => {
      const home = d.home || d.checkedPaths?.find(p => path.basename(p) === '.claude') || paths({}).claudeHome;
      return { ...values({ runtimeConfig: { claudeCode: { home } } }), home };
    },
    async probe({ runtime }) {
      const files = createFiles({ ...defaults(runtime), readFromStart: true });
      try {
        const rows = (await files.scan()).sort((a, b) => b.mtime - a.mtime || a.key.localeCompare(b.key));
        const sample = rows.slice(0, BOUNDS.tails), unsupportedRows = new Set();
        const counts = fileCount => ({ fileCount, ignoredLineCount: files.stats.ignoredLines,
          unknownLineTypeCount: files.stats.unknownLineTypes, unknownKeyCount: files.stats.unknownKeys,
          unknownContentBlockCount: files.stats.unknownContentBlocks });
        for (const row of sample) {
          let budget = BOUNDS.probeBytes, first = true;
          while (!row.recognizable && !row.coverageComplete && budget > 0) {
            const before = row.offset || 0;
            try { await files.read(row.key, { refresh: !first }); }
            catch (error) { if (error.code !== 'EFORMAT') throw error; unsupportedRows.add(row.key); }
            first = false;
            const consumed = Math.max(0, (row.offset || 0) - before); budget -= consumed;
            if (!consumed) break;
          }
          if (row.coverageComplete && !row.recognizable) unsupportedRows.add(row.key);
        }
        const recognized = sample.filter(row => row.recognizable), fileCount = sample.length;
        const projectCount = new Set(rows.map(row => row.project)).size;
        if (recognized.length) return { status: files.stats.truncated || rows.length > BOUNDS.tails ? 'capacity-limited' : 'connected', protocol: null,
          latencyMs: null, projectCount, ...counts(fileCount) };
        if (!rows.length) return { status: 'connected', protocol: null, latencyMs: null, projectCount: 0, ...counts(0) };
        if (!files.stats.truncated && sample.length === rows.length && unsupportedRows.size === sample.length) return { status: 'unsupported-format',
          reasonCode: 'no-recognizable-session-lines', protocol: null, latencyMs: null, projectCount, ...counts(fileCount) };
        return { status: 'not-verified', reasonCode: sample.length < rows.length ? 'probe-file-limit' : 'probe-byte-limit',
          protocol: null, latencyMs: null, projectCount, ...counts(fileCount) };
      } catch (error) {
        return { status: error.code === 'EFORMAT' ? 'unsupported-format' : error.code === 'ENOENT' ? 'not-configured' : 'refused',
          reasonCode: error.code === 'EFORMAT' ? 'no-recognizable-session-lines' : error.code === 'ENOENT' ? 'project-directory-not-found' : 'probe-failed',
          protocol: null, latencyMs: null, projectCount: 0, fileCount: 0, ignoredLineCount: files.stats.ignoredLines,
          unknownLineTypeCount: files.stats.unknownLineTypes, unknownKeyCount: files.stats.unknownKeys,
          unknownContentBlockCount: files.stats.unknownContentBlocks };
      } finally { files.close(); }
    } } };
const paths = env => ({ claudeHome: env.AO_CLAUDE_HOME || path.join(env.HOME || os.homedir(), '.claude') });
module.exports = { definition, createRuntime, setup, paths, doctor: async ctx => ctx.add('runtime', 'runtime.claude', 'info', 'runtime.claude') };
