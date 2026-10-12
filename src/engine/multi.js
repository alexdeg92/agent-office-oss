'use strict';
// Isolated canonical partitions; each existing engine still validates its own
// adapter input. This facade maps identities once, after admission, before views.
const { EventEmitter } = require('node:events');
const { scopedId, parseId } = require('../runtime-ids');
const { resolvePrimaryAgent } = require('./derive/primary-agent');
const {checkDispatchAuthority}=require('../security/dispatch-context');
const {ApiError}=require('../api/v2/errors');
const plain = value => value?.toJSON ? value.toJSON() : value;
const { normaliseLineage } = require('./model/lineage');
function createMultiEngine({ instances, primary = null, now = Date.now, timeoutMs = 5000, liveState = { rows: [], sequence: 0 }, core, persistAliases = null }) {
  const events = new EventEmitter(), live = liveState.rows, listeners = [];
  let closed = false, selected = primary, primaryIssue = null;
  // Value-free compatibility history is loaded before this facade is exposed.
  // Commit new fingerprints synchronously before forwarding source changes.
  const aliases=liveState.compatAliases ||= {seen:new Set(),overflow:false};
  const aliasHash=(kind,value)=>require('node:crypto').createHash('sha256').update(kind+'\0'+value).digest('hex');
  function rememberLegacyAliases() {
    const source=instances.find(i=>i.id==='legacy' && i.engine)?.engine;
    let dirty = aliases.pending || false;
    if (source) for(const [kind,values] of [['flow',source.cronJobs().map(r=>r.id)],['session',source.sessions().map(r=>r.key)],['skill',source.skills().map(r=>r.name)],['agent',source.agents().map(r=>r.id)]]) {
      for(const value of values)if(parseId(value)) {
        const hash=aliasHash(kind,value);if(aliases.seen.has(hash))continue;
        if(aliases.seen.size>=4096){if(!aliases.overflow)dirty=true;aliases.overflow=true;break;}
        aliases.seen.add(hash);dirty=true;
      }
    }
    if (dirty && persistAliases) {
      try { const saved=persistAliases([...aliases.seen],aliases.overflow);aliases.seen=saved.seen;aliases.overflow=saved.overflow;aliases.pending=false; }
      catch { aliases.overflow=true;aliases.pending=true;(core || source)?.quarantine.record({channel:'store.runtime_aliases',code:'store.invalid',severity:'error',path:null}); }
    }
  }
  rememberLegacyAliases();
  const enabled = () => instances.filter(i => i.enabled && i.engine);
  const id = (i, kind, local) => local == null ? null : scopedId(i.id, kind, local);
  function projectionIssue(i, type) {
    i.engine.quarantine.record({channel:'canonical.' + ({agent:'agents',session:'sessions.snapshot',cronJob:'flows',cronRun:'flowRuns',skill:'skills',channel:'channels'}[type] || type),
      code:'shape.invalid',severity:'error',path:'$.canonical.' + type});
  }
  function projectRow(i, type, row, map) {
    if (row == null) return null;
    try {
      if (require('./runtime-identities').identityIssue(type, plain(row))) { projectionIssue(i,type); return null; }
      return map(i,row);
    } catch { projectionIssue(i,type); return null; }
  }
  function rowsOf(i, method, type, map) {
    try { return (i.engine[method]() || []).map(row=>projectRow(i,type,row,map)).filter(row=>row != null); }
    catch { projectionIssue(i,type); return []; }
  }
  const union = (method, type, map) => () => enabled().flatMap(i=>rowsOf(i,method,type,map));
  const owner = (key, kind) => {
    const parsed = parseId(key, kind);
    if (parsed) return { instance: enabled().find(i => i.id === parsed.runtime), local: parsed.local };
    // Explicit legacy compatibility only. A native key is never looked up in N sources.
    return { instance: enabled().find(i => i.id === 'legacy'), local: key };
  };
  const sender = (i, raw) => raw && { ...raw, runtime: i.id,
    id: raw.kind === 'agent' ? 'agent:' + id(i, 'agent', raw.id.replace(/^agent:/, '')) : raw.kind === 'human' && i.engine.senderPeople().some(p => p.id === raw.id) ? raw.id : id(i, raw.kind === 'tool' ? 'tool' : 'sender', raw.id),
    ...(raw.delegation ? { delegation: { ...raw.delegation, sessionKey: id(i, 'session', raw.delegation.sessionKey) } } : {}) };
  const lineage = (i, v) => (v === undefined ? {} : { spawnedBy: normaliseLineage(v, { scope: { instance: i.id } }) });
  const agent = (i, raw) => ({ ...plain(raw), id: id(i, 'agent', raw.id), mainSessionKey: id(i, 'session', raw.mainSessionKey), ...lineage(i, raw.spawnedBy) });
  const agents = union('agents','agent',agent);
  function primaryAgent() {
    const all = agents();
    const resolved = resolvePrimaryAgent(all.some(a => a.isPrimary) ? all : all.sort((a,b)=>a.id.localeCompare(b.id)), {primary:selected});
    const stamp = JSON.stringify([selected,resolved.issues]);
    if (core && stamp !== primaryIssue) {
      primaryIssue = stamp;
      for (const issue of resolved.issues) core.quarantine.record({channel:'config.primary',...issue});
    }
    if (!resolved.issues.length) core?.quarantine.markClean('config.primary');
    const row=all.find(a=>a.id===resolved.agentId);
    return row ? {...row,source:resolved.source} : null;
  }
  const session = (i, raw) => {
    if (!raw) return null;
    const row = plain(raw), cls = { ...row.class,
      agentId: id(i, 'agent', row.class.agentId), heartbeatOf: id(i, 'session', row.class.heartbeatOf) };
    for (const [field, kind] of [['subagentId', 'agent'], ['cronJobId', 'flow']]) if (cls[field]) cls[field] = id(i, kind, cls[field]);
    if (cls.kind === 'primary' && cls.agentId !== primaryAgent()?.id) cls.kind = 'dashboard';
    return { ...row, key: id(i, 'session', row.key), sessionId: id(i, 'session', row.sessionId), class: cls, run: { ...row.run, lastRunId: id(i, 'run', row.run.lastRunId) },
      parentKey: id(i, 'session', row.parentKey), childKeys: row.childKeys.map(k => id(i, 'session', k)), ...lineage(i, row.spawnedBy),
      group: id(i, 'session', row.group) };
  };
  const flow = (i, raw) => ({ ...plain(raw), id: id(i, 'flow', raw.id), agentId: id(i, 'agent', raw.agentId), sessionKey: id(i, 'session', raw.sessionKey) });
  const trace = (i, raw) => raw && { ...plain(raw), sessionKey: id(i, 'session', raw.sessionKey),
    participants: raw.participants?.map(p => sender(i, p)), events: raw.events.map(e => ({ ...e,
      id: id(i, 'event', JSON.stringify([raw.sessionKey, e.id])), senderInfo: sender(i, e.senderInfo),
      ...(e.callId != null ? { callId: id(i, 'tool', JSON.stringify([raw.sessionKey, e.callId])) } : {}) })) };
  function fault(instance, category) {
    instance.failure = category;
    instance.engine?.setSourceDown('runtime', true, category);
    events.emit('change', { type: 'Runtime', runtime: instance.id });
  }
  async function bounded(instance, fn) {
    let timer;
    try {
      const result = await Promise.race([Promise.resolve().then(()=>{checkDispatchAuthority();return fn();}), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('runtime operation timed out'), { code: 'ETIMEOUT' })), timeoutMs);
      })]);
      if (result?.ok !== false) { instance.failure = null; instance.engine?.setSourceDown('runtime', false); }
      return result;
    } catch (error) { if(error instanceof ApiError)throw error;fault(instance, error?.code === 'ETIMEOUT' ? 'timeout' : 'upstream-failed'); return { ok: false, category: instance.failure }; }
    finally { clearTimeout(timer); }
  }
  const diagnosticSources = () => {
    const seen = new Set();
    return (core ? [...enabled(), { id: 'core', engine: core }] : enabled()).filter(source => {
      if (seen.has(source.id)) return false;
      seen.add(source.id); return true;
    });
  };
  const fingerprint = row => require('node:crypto').createHash('sha1').update([row.channel, row.code, row.path || ''].join('|')).digest('hex').slice(0, 16);
  const issueOwners = new Map();
  const scopedIssue = (i, row) => {
    const scoped = { ...row, channel: `${i.id}:${row.channel}` };
    scoped.fingerprint = fingerprint(scoped);
    issueOwners.set(scoped.fingerprint, { instance: i, native: row.fingerprint });
    return scoped;
  };
  const scopedIssues = () => {
    const merged = new Map();
    for (const i of diagnosticSources()) for (const row of i.engine.quarantine.list()) {
      const issue = scopedIssue(i, row), previous = merged.get(issue.fingerprint);
      if (!previous) { merged.set(issue.fingerprint, issue); continue; }
      // Repeated reports of the same scoped issue must remain one diagnostic row (HealthVM IDs
      // are fingerprints). Preserve the aggregate bounds without multiplying a duplicate source.
      previous.count = Math.max(previous.count, issue.count);
      previous.firstSeenAt = Math.min(previous.firstSeenAt, issue.firstSeenAt);
      previous.lastSeenAt = Math.max(previous.lastSeenAt, issue.lastSeenAt);
      if (issue.state === 'open') previous.state = 'open';
      else if (previous.state !== 'open' && issue.state === 'muted') previous.state = 'muted';
    }
    const severity = { error: 0, warn: 1, info: 2 };
    return [...merged.values()].sort((a, b) => severity[a.severity] - severity[b.severity] || b.lastSeenAt - a.lastSeenAt || a.fingerprint.localeCompare(b.fingerprint));
  };
  const quarantine = {
    list: scopedIssues,
    counts: () => {
      const rows = scopedIssues(), open = { error: 0, warn: 0, info: 0 };
      for (const row of rows) if (row.state === 'open') open[row.severity]++;
      return { open, total: rows.length, lastIssueAt: Math.max(0, ...rows.map(r => r.lastSeenAt || 0)) || null };
    },
    record: value => (core || enabled()[0]?.engine).quarantine.record(value),
    // Valid VM envelopes are global evidence: advance the matching native channel in
    // every partition so persisted quarantine rows can resolve in a multi-runtime setup.
    markClean: channel => diagnosticSources().forEach(i => i.engine.quarantine.markClean(channel)),
    restore: rows => {
      for (const i of diagnosticSources()) i.engine.quarantine.restore(rows.filter(r => r.channel.startsWith(i.id + ':')).map(r => {
        const native = { ...r, channel: r.channel.slice(i.id.length + 1) };
        native.fingerprint = r.code === 'quarantine.overflow' ? 'overflow' : fingerprint(native);
        issueOwners.set(r.fingerprint, { instance: i, native: native.fingerprint });
        return native;
      }));
    },
    takeDirty: () => {
      const batch = { upserts: [], deletes: [] };
      for (const i of diagnosticSources()) {
        const local = i.engine.quarantine.takeDirty();
        batch.upserts.push(...local.upserts.map(row => scopedIssue(i, row)));
        for (const native of local.deletes) for (const [key, ref] of issueOwners) if (ref.instance === i && ref.native === native) batch.deletes.push(key);
      }
      return batch;
    },
    requeue: batch => {
      for (const i of diagnosticSources()) i.engine.quarantine.requeue({
        upserts: batch.upserts.filter(r => issueOwners.get(r.fingerprint)?.instance === i).map(r => ({ ...r, fingerprint: issueOwners.get(r.fingerprint).native })),
        deletes: batch.deletes.filter(k => issueOwners.get(k)?.instance === i).map(k => issueOwners.get(k).native) });
    },
    prune: (...args) => diagnosticSources().forEach(i => i.engine.quarantine.prune(...args)),
  };
  for (const i of enabled()) for (const name of ['change', 'ingested', 'live']) {
    const fn = value => {
      if (closed || !i.enabled) return;
      if((name==='ingested' || name==='change') && i.id==='legacy')rememberLegacyAliases();
      if (name === 'live') {
        let row;
        try { row = { ...plain(value), id: `le_${++liveState.sequence}`, sessionKey: id(i, 'session', value.sessionKey),
          occupantId: value.occupantId === 'primary' ? (i.engine.primaryAgent() && primaryAgent()?.id === id(i, 'agent', i.engine.primaryAgent().id) ? 'primary' : i.engine.primaryAgent() ? 'agent:' + id(i, 'agent', i.engine.primaryAgent().id) : null) : (() => { const v=value.occupantId; if (!v?.includes(':')) return v; const cut=v.indexOf(':'), role=v.slice(0,cut), kind=({agent:'agent',subagent:'agent',scheduled:'flow',conversation:'session'})[role]; return kind ? role+':'+id(i,kind,v.slice(cut+1)) : v; })(),
          ...(value.cronJobId ? { cronJobId: id(i, 'flow', value.cronJobId) } : {}),
          actor: value.actor?.kind === 'agent' ? { ...value.actor, personId: value.actor.personId } : value.actor }; }
        catch { projectionIssue(i,'liveEvent'); return; }
        live.unshift(row); if (live.length > 200) live.pop(); events.emit(name, row);
      } else events.emit(name, name === 'ingested' ? { ok: value.ok, issues: [], runtime: i.id } : { ...value, runtime: i.id });
    };
    i.engine.on(name, fn); listeners.push([i.engine, name, fn]);
  }
  const routed = (method, kind, map, type = kind) => key => {
    const { instance: i, local } = owner(key, kind); if(!i)return null;
    try { return projectRow(i,type,i.engine[method](local),map); } catch { projectionIssue(i,type); return null; }
  };
  const healthItems = () => (core ? [...enabled(), { id: 'core', engine: core }] : enabled()).flatMap(i => {
    try { return i.engine.healthChecks().map(row => ({ ...row, id: `${i.id}|${row.id}` })); } catch { return []; }
  });
  const runtimeRows = () => instances.map(i => ({ id: i.id, adapter: i.adapter, enabled: i.enabled,
    ...(i.engine?.runtime() || {}), ...(i.name ? {name:i.name} : {}), connection: !i.enabled ? 'disabled' : i.failure || (i.engine?.runtime().connected ? 'connected' : 'not-configured') }));
  const preferred = () => enabled().find(i => i.id === parseId(primaryAgent()?.id, 'agent')?.runtime) || enabled()[0];
  const facade = {
    legacyAliasConflict(kind,value) {rememberLegacyAliases();return aliases.overflow || aliases.seen.has(aliasHash(kind,value));},
    on: events.on.bind(events), removeListener: events.removeListener.bind(events), quarantine, instances,
    agents, detectedAgents: union('detectedAgents','agent',agent), primaryAgent,
    identityAgents: hostId => enabled().flatMap(i => (i.engine.identityAgents?.(hostId) || []).map(row => ({ ...row, id: id(i, 'agent', row.id) }))),
    identitySessions: hostId => enabled().flatMap(i => (i.engine.identitySessions?.(hostId) || []).map(row => ({ ...row,
      id: id(i, 'session', row.id), sessionKey: id(i, 'session', row.sessionKey), agentId: id(i, 'agent', row.agentId) }))),
    sessions: union('sessions','session',session),
    session: routed('session', 'session', session), classify: key => facade.session(key)?.class || { kind: 'unrecognized', agentId: null },
    transcript: routed('transcript', 'session', trace,'transcript'), conversationMessageCount: routed('conversationMessageCount', 'session', (_, n) => n,'count'),
    cronJobs: union('cronJobs','cronJob',flow),
    cronRuns: routed('cronRuns', 'flow', (i, value) => ({ ...value, runs: value.runs.map(r=>projectRow(i,'cronRun',r,(i,r)=>({ ...plain(r), id:id(i,'run',r.id),jobId:id(i,'flow',r.jobId),sessionKey:id(i,'session',r.sessionKey) }))).filter(Boolean) }),'runs'),
    skills: union('skills','skill',(i,s)=>({ ...plain(s), name:id(i,'skill',s.name) })),
    skillInfo: routed('skillInfo', 'skill', (i, value) => ({ ...plain(value), name:id(i,'skill',value.name) }),'skillInfo'),
    channels: union('channels','channel',(i,c)=>({ ...plain(c), id:id(i,'channel',c.id) })),
    sessionGroups: union('sessionGroups','sessionGroup',(i,g)=>({ ...plain(g),id:id(i,'session',g.id),...(g.sessionKeys?{sessionKeys:g.sessionKeys.map(k=>id(i,'session',k))}:{}) })),
    projectHints: union('projectHints','hint',(i,h)=>({ ...h,sessionKey:id(i,'session',h.sessionKey) })),
    activity: routed('activity', 'session', (i, a) => ({ ...a,sessionKey:id(i,'session',a.sessionKey) }),'activity'),
    agentPresence: key => { const i = owner(key, 'agent').instance; return !!i && (i.engine.agentPresence() || i.engine.agents().some(a => a.mainSessionKey)); },
    activities: union('activities','activity',(i,a)=>({ ...a,sessionKey:id(i,'session',a.sessionKey) })),
    runtime: () => preferred()?.engine.runtime() || null,
    runtimes: runtimeRows, runtimeFor: key => owner(key, parseId(key)?.entity).instance?.engine.runtime() || null,
    // T-0058: the connector instance that owns a session (its id, adapter, name and adapter-declared mark)
    connectorOf: key => { const i = owner(key, 'session').instance; if (!i?.engine) return null; const c = i.engine.connectorOf(); return { ...c, id: i.id, adapter: i.adapter || c.adapter, name: i.name || c.name }; },
    runtimeForInstance: key => enabled().find(i => i.id === key)?.engine.runtime() || null,
    config: () => preferred()?.engine.config() || null, host: () => core?.host() || preferred()?.engine.host() || null,
    gateway: () => ({ ...(preferred()?.engine.gateway() || {}), connected: enabled().some(i => i.engine.gateway().connected) }),
    health: () => require('./derive/health').deriveHealth({ now: now(), host: facade.host(), runtime: preferred()?.engine.health()?.gateway || null, gateway: facade.gateway(), cronJobs: facade.cronJobs(), sources: facade.sources(), quality: quarantine.counts() }), liveEvents: () => live.slice(),
    healthChecks: healthItems,
    healthAudit: () => (core ? [...enabled(), { id: 'core', engine: core }] : enabled()).flatMap(i => (i.engine.healthAudit?.() || []).map(row => ({ ...row, checkId: `${i.id}|${row.checkId}` }))).slice(0, 50),
    async runHealthRemedy(key, options = {}) {
      const sep = typeof key === 'string' ? key.indexOf('|') : -1; if (sep < 1) return { ok: false, category: 'remedy-unavailable' };
      const runtimeId = key.slice(0, sep), local = key.slice(sep + 1);
      const instance = runtimeId === 'core' ? { id: 'core', engine: core } : enabled().find(i => i.id === runtimeId);
      if (!instance?.engine?.runHealthRemedy) return { ok: false, category: 'remedy-unavailable' };
      return instance.engine.runHealthRemedy(local, options);
    },
    startHealthLoop: (...args) => (core ? [...enabled(), { id: 'core', engine: core }] : enabled()).forEach(i => i.engine.startHealthLoop?.(...args)),
    sources: () => diagnosticSources().flatMap(i => i.engine.sources().map(s => ({ ...s, id: i.id + ':' + s.id }))),
    dataQuality: () => ({ openclawVersion: null, sources: facade.sources(), ...quarantine.counts(), issues: scopedIssues() }),
    sessionsMeta: () => ({ totalCount: facade.sessions().length, hasMore: false }),
    registryKeys: () => enabled().flatMap(i => i.engine.registryKeys().map(k => i.id + ':' + k)),
    senderPeople: () => preferred()?.engine.senderPeople() || [],
    declareFields: fields => enabled().forEach(i => i.engine.declareFields(fields)),
    setIssueMuted: (key, muted) => { scopedIssues(); const ref = issueOwners.get(key); const row = ref?.instance.engine.setIssueMuted(ref.native, muted); return row ? scopedIssue(ref.instance, row) : null; },
    updatePrimary(value) { selected = value; events.emit('change', { type: 'Agent' }); },
    ingest: env => core ? core.ingest(env) : preferred()?.engine.ingest(env),
    async request(op, key, options = {}) {
      const kind = ({ transcript: 'session', describeSession: 'session', flowRuns: 'flow', skillInfo: 'skill' })[op];
      const { instance: i, local } = kind ? owner(key, kind) : { instance: preferred(), local: key };
      if (!i) return { ok: false, category: 'capability-unavailable' };
      const result = await bounded(i, () => i.engine.request(op, local, options));
      return result.ok ? { ...result, value: op === 'transcript' ? facade.transcript(key) : op === 'describeSession' ? facade.session(key) : result.value } : result;
    },
    fault, bounded, owner,
    close() { closed = true; for (const [e, name, fn] of listeners) e.removeListener(name, fn); },
  };
  return facade;
}
module.exports = { createMultiEngine };
