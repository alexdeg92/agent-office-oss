'use strict';
const path = require('node:path'), os = require('node:os');
const s = require('../../schema');
const { createFiles, MAX_META } = require('./files');
const { PROFILE } = require('./profile');
const { runFromTranscript, unknownRun, chooseTailsByAgent } = require('../transcript-execution');
const label = key => ({ key: 'settings.cursor.' + key });
const POLL_INTERVAL_MS = 60000, WATCH_DEBOUNCE_MS = 350;
const filters = s.array(s.string().min(1).max(256).refine(v => !/[\x00-\x1f/\\]/.test(v) && !['.', '..'].includes(v), 'project directory key')).max(2000);
const optionsSchema = s.object({
  home: s.string().min(1).max(4096).refine(v => path.isAbsolute(v) && !/[\x00-\x1f]/.test(v), 'absolute directory'),
  include: filters, exclude: filters, agentGrouping: s.enumOf(['project', 'runtime']),
}, { extra: 'reject' });
const brand = { mark: 'CU', color: '#26251e', foreground: '#ffffff', providerName: 'Cursor', logo: 'assets/connectors/cursor-light.svg', logoDark: 'assets/connectors/cursor-dark.svg' };
const definition = {
  id: 'cursor', name: 'Cursor',
  runtimePresentation: { label: { key: 'team.runtime.cursor' }, aliases: [] },
  identity: { sessionRef: 'chats/<workspaceHash>/<chatId> directory name; private cross-source matching only' },
  projectSource: { kind: 'runtime', projectRefField: 'projectRef', projectLabelField: 'projectLabel', capabilities: { read: true, write: false, comments: 'unsupported', history: 'unsupported', repository: 'unsupported' } },
  mark: { monogram: 'CU', color: '#26251e', providerName: 'Cursor', logo: brand.logo, logoDark: brand.logoDark },
  gatewayLabel: 'Cursor CLI', eventPrefix: 'cursor.', schemas: {}, routes: {},
  normalise: { session: x => ({ session: x }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) },
  classifySession: () => ({ kind: 'unrecognized', agentId: null }), presence: 'agents',
  transcriptBounds: { sessions: 16, bytes: 8 * 1024 * 1024 },
  capabilities: () => ({ agents: true, sessions: true, transcripts: true, flows: { read: false, write: false }, skills: { list: false, detail: false, toggle: false },
    channels: false, interlocutors: false, chat: false, restart: false, costs: false, subagents: false, sessionGroups: false }),
};
const paths = env => ({ cursorHome: env.CURSOR_HOME || path.join(env.HOME || os.homedir(), '.cursor') });
const values = cfg => {
  const v = { home: cfg.runtimeConfig?.cursor?.home || cfg.cursorHome || path.join(os.homedir(), '.cursor'), include: [], exclude: [], agentGrouping: 'project' };
  return { ...v, ...cfg.runtimeConfig?.cursor, ...(cfg.cursorHome ? { home: cfg.cursorHome } : {}) };
};
const resolve = (input, saved = {}) => {
  const v = { ...values({}), ...saved, ...input };
  for (const key of ['include', 'exclude']) v[key] = typeof v[key] === 'string' ? v[key].split(/\r?\n/).map(x => x.trim()).filter(Boolean) : v[key];
  const { adapter, ...options } = v, result = s.validate(optionsSchema, options);
  if (!result.ok) throw Object.assign(new Error('invalid Cursor options'), { field: 'home' });
  return { adapter: 'cursor', ...options };
};
function createRuntime(cfg, { now = Date.now, pollIntervalMs = POLL_INTERVAL_MS } = {}) {
  const options = { home: path.join(os.homedir(), '.cursor'), include: [], exclude: [], agentGrouping: 'project', ...(cfg.runtimeConfig?.cursor || { home: cfg.cursorHome }) };
  options.home = options.home || path.join(os.homedir(), '.cursor');
  const files = createFiles({ ...options, now });
  let engine = null, timer = null, debounceTimer = null, closed = false, cycling = false, lastPublishedSignature = null;
  const loaded = new Map(), loadedSignatures = new Map(), pendingChangePaths = new Set();
  let pendingFullScan = false;
  const signature = row => `${row.dev}:${row.ino}:${row.size}:${row.mtime}:${row.ctime}`;
  function agents(rows) {
    const grouped = new Map();
    for (const row of rows) {
      if (!row.agentId) continue;
      const prev = grouped.get(row.agentId);
      if (!prev || prev.mtime < row.mtime) grouped.set(row.agentId, row);
    }
    engine.ingestCanonical('agents', [...grouped.values()].map(row => ({
      id: row.agentId, name: row.projectName || 'Cursor project', workspace: null, model: null, fallbackModels: [], isPrimary: false, mainSessionKey: row.key,
    })));
  }
  // Session title is meta.title with summarySource runtime (Claude ai-title / Codex thread name): never the project label.
  function publish(rows) {
    agents(rows);
    engine.ingestCanonical('sessions.snapshot', rows.map(row => {
      const title = row.displayName || null;
      return {
        key: row.key, sessionId: row.sessionId, class: { kind: 'conversation', ruleId: PROFILE, agentId: row.agentId || null, channel: null, heartbeatOf: null, background: false, rawClassification: null },
        displayName: title, summarySource: title ? 'runtime' : null,
        projectLabel: row.projectName ? row.projectName.slice(0, 120) : null, projectRef: row.projectId || null,
        model: null, provider: 'cursor', usage: { total: 0, input: null, output: null }, tokensKnown: false,
        updatedAt: row.mtime ? Math.round(row.mtime) : null, run: row.execution ? runFromTranscript(row.execution, typeof now === 'function' ? now() : now) : unknownRun(),
        costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null, interactive: true, group: null,
      };
    }));
  }
  async function load(row) {
    try {
      const value = await files.read(row.key);
      const latest = files.rows().find(item => item.key === row.key);
      if (!value || closed) {
        loaded.set(row.key, latest?.loadedSize ?? row.size);
        loadedSignatures.set(row.key, latest ? signature(latest) : signature(row));
        engine.forgetTranscript?.(row.key, { activity: true });
        return false;
      }
      engine.ingestCanonical('transcript', value, { key: row.key });
      loaded.set(row.key, latest?.loadedSize ?? row.size);
      loadedSignatures.set(row.key, latest ? signature(latest) : signature(row));
      return true;
    } catch (error) {
      if (error.code === 'EUNSAFEPATH') engine.setSourceDown('transcripts', true, 'unreadable');
      throw error;
    }
  }
  async function cycle(change = null) {
    if (closed || cycling) return;
    cycling = true;
    try {
      const changedKey = change?.path ? files.keyForPath(change.path) : null;
      const changedRow = changedKey ? await files.refresh(changedKey) : null;
      const rows = changedRow ? await files.filterRows(files.rows()) : await files.filterRows(await files.scan());
      if (closed) return;
      engine.setSourceDown('capacity', !!rows.capacityLimited || !!files.stats.truncated, 'capacity-limited');
      const keys = new Set(rows.map(r => r.key));
      for (const key of loaded.keys()) if (!keys.has(key)) { loaded.delete(key); loadedSignatures.delete(key); engine.forgetTranscript?.(key, { activity: true }); }
      const candidates = rows.filter(r => (r.size !== loaded.get(r.key) || signature(r) !== loadedSignatures.get(r.key)));
      const due = chooseTailsByAgent((changedKey ? candidates.filter(row => row.key === changedKey) : candidates).sort((a, b) => b.mtime - a.mtime || a.key.localeCompare(b.key)), 32);
      if (due.length) {
        engine.setIdentitySessionRefs?.(rows.map(row => ({ sessionKey: row.key, sessionRef: row.identitySessionRef, agentId: row.agentId || null })));
        publish(rows);
      }
      engine.setGatewayConnected(true);
      for (const row of due) {
        if (closed) break;
        try { await load(row); } catch { continue; }
      }
      if (!closed) {
        const visible = new Set(files.rows().map(r => r.key)), current = rows.filter(r => visible.has(r.key));
        const stamp = JSON.stringify(current.map(r => [r.key, signature(r), r.agentId, r.projectName, r.loadedSize, r.displayName || null]));
        if (due.length || stamp !== lastPublishedSignature) {
          engine.setIdentitySessionRefs?.(current.map(row => ({ sessionKey: row.key, sessionRef: row.identitySessionRef, agentId: row.agentId || null })));
          publish(current);
          lastPublishedSignature = stamp;
        }
      }
    } catch (error) {
      if (error.code === 'EUNSAFEPATH') engine.setSourceDown('transcripts', true, 'unreadable');
    } finally { cycling = false; }
  }
  const reads = {
    transcript: async key => {
      const row = files.rows().find(r => r.key === key);
      if (!row) return { ok: false, category: 'not-found' };
      return await load(row) ? { ok: true } : { ok: false, category: 'not-found' };
    },
    describeSession: async key => ({ ok: !!engine.session(key), category: 'not-found' }),
  };
  function scheduleWatchFlush(hooks, delay = WATCH_DEBOUNCE_MS) {
    if (closed) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { void flushWatchChanges(hooks); }, delay);
    debounceTimer.unref?.();
  }
  async function flushWatchChanges(hooks) {
    if (closed) return;
    if (cycling) { scheduleWatchFlush(hooks, 25); return; }
    if (pendingFullScan) { pendingFullScan = false; await cycle(); }
    else {
      const paths = [...pendingChangePaths].slice(0, 32);
      for (const file of paths) { pendingChangePaths.delete(file); await cycle({ path: file }); if (closed) return; }
    }
    if (!closed) try { hooks.refreshed?.(); } catch { /* ignore */ }
    if (pendingFullScan || pendingChangePaths.size) scheduleWatchFlush(hooks, 25);
  }
  function refresh(hooks, change = null) {
    if (closed) return;
    if (cycling) { pendingFullScan = true; scheduleWatchFlush(hooks, 25); return; }
    void cycle(change).then(() => { if (!closed) try { hooks.refreshed?.(); } catch { /* ignore */ } }).catch(() => {});
  }
  return {
    definition, files, commands: {}, reads,
    projectDirectoryHints() {
      return [...new Set(files.rows().slice(0, 128).flatMap(row => typeof row.projectPath === 'string' && row.projectPath.length <= 4096 ? [row.projectPath] : []))].map(cwd => ({ cwd }));
    },
    attach(value) { engine = value; engine.setReads(reads); },
    start(value, hooks = {}) {
      engine = value;
      if (closed) return;
      files.watch(change => {
        if (change?.path && pendingChangePaths.size < files.bounds.sessions) pendingChangePaths.add(change.path);
        else pendingFullScan = true;
        scheduleWatchFlush(hooks);
      });
      timer = setInterval(() => refresh(hooks), pollIntervalMs);
      timer.unref?.();
      setImmediate(() => refresh(hooks));
    },
    cycle, close() { closed = true; clearInterval(timer); clearTimeout(debounceTimer); files.close(); engine?.close(); },
    refreshFlows: async () => {}, refreshSkills: async () => {},
  };
}
async function discover({ runtime = {}, env = {} } = {}) {
  const files = createFiles({ ...values({ runtimeConfig: { cursor: runtime } }), home: runtime.home || paths(env).cursorHome });
  try {
    const rows = await files.filterRows(await files.scan()), out = [];
    for (const row of rows.slice(0, 32)) {
      try {
        const value = await files.read(row.key);
        if (value) out.push({ id: value.agentId, name: value.projectName, workspace: null, model: null });
      } catch { /* ignore */ }
    }
    return [...new Map(out.map(a => [a.id, a])).values()];
  } finally { files.close(); }
}
const fields = [
  { id: 'home', label: label('home'), type: 'text', required: true, writeOnly: false, options: [] },
  ...['include', 'exclude'].map(id => ({ id, label: label(id), type: 'textarea', control: 'chips', required: false, writeOnly: false, options: [] })),
  { id: 'agentGrouping', label: label('grouping'), type: 'select', required: true, writeOnly: false, options: ['project', 'runtime'].map(value => ({ value, label: label(value) })) },
];
const setup = {
  connect: true, agentsOptional: true, name: 'Cursor', fields: fields.map(f => f.id), defaultGatewayUrl: null,
  capabilities: { autoAddDefault: true, brand },
  configSchema: s.object({ adapter: s.literal('cursor'), cursor: optionsSchema }, { extra: 'reject' }),
  env: ({ runtime }) => ({ CURSOR_HOME: runtime.cursor.home }),
  config: rt => ({ adapter: 'cursor', cursor: { home: rt.home, include: rt.include, exclude: rt.exclude, agentGrouping: rt.agentGrouping } }),
  agents: () => [], discover,
  settings: {
    detectionIdentity: ({ cfg, detection }) => ({ paths: [detection?.home || cfg?.cursorHome || cfg?.runtimeConfig?.cursor?.home || path.join(os.homedir(), '.cursor')] }),
    fields, envKeys: { home: 'CURSOR_HOME' }, values, resolve, secret: () => null,
    detectedValues: (d = {}, env = {}) => ({ home: d.home || paths(env).cursorHome, include: '', exclude: '', agentGrouping: 'project' }),
    async probe({ runtime }) {
      const files = createFiles({ ...values({ runtimeConfig: { cursor: runtime } }), home: runtime.home || path.join(os.homedir(), '.cursor') });
      try {
        const scanned = await files.scan();
        const rows = await files.filterRows(scanned);
        let recognized = 0, storesOk = 0;
        for (const row of scanned.slice(0, 32)) {
          try {
            if (await files.read(row.key)) recognized++;
            if (await files.verifyStore(row)) storesOk++;
          } catch { /* ignore */ }
        }
        const visible = files.rows();
        const projects = new Set(visible.filter(r => r.projectId).map(r => r.projectId)).size;
        const base = {
          status: rows.capacityLimited || files.stats.truncated || scanned.length > 32 ? 'capacity-limited' : 'connected',
          reasonCode: null, protocol: null, latencyMs: null, projectCount: projects,
          fileCount: Math.min(Math.max(scanned.length, visible.length), 32), ignoredLineCount: files.stats.malformedMeta, unknownKeyCount: files.stats.unknownKeys,
        };
        if (scanned.length && !recognized) return { ...base, status: 'unsupported-format', reasonCode: 'no-recognizable-session-meta' };
        if (recognized && storesOk === 0 && files.stats.unsupportedStores) return { ...base, status: 'unsupported-format', reasonCode: 'store-schema-unrecognized' };
        return base;
      } catch (error) {
        return {
          status: error.code === 'ENOENT' ? 'not-configured' : 'refused',
          reasonCode: error.code === 'ENOENT' ? 'chats-directory-not-found' : 'probe-failed',
          protocol: null, latencyMs: null, projectCount: 0, fileCount: 0, ignoredLineCount: 0, unknownKeyCount: files.stats.unknownKeys,
        };
      } finally { files.close(); }
    },
  },
};
module.exports = {
  definition, createRuntime, setup, paths,
  doctor: async ctx => ctx.add('runtime', 'runtime.cursor', 'info', 'runtime.cursor'),
  BOUNDS: { sessions: 2000, tails: 32, readBytes: MAX_META, filterBytes: require('./files').MAX_FILTER_BYTES },
};
