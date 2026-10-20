'use strict';
/*
 * Projets on API v2 (S7a; api.md §3.9, §3.14, §5.4; projects.md "Service facade").
 *   - The projects module's createProjectService runs over the store's SQL repository (one transaction per
 *     command); this file only speaks HTTP: body allowlists, the actor, error mapping, topics.
 *   - Topics `projects`, `projects?filter=<f>` and `project:<id>` are built by the service views; a committed
 *     write publishes `{ topics }`, and exactly those topic ids are invalidated (no guessing here).
 *   - Store-class writes (§5.0) except « Régénérer le résumé », which runs an agent turn (OpenClaw class):
 *     202 + turnId, then the reply lands through commands.edit as the primary agent.
 *   - Engine changes (sessions, cron, agents) and a 10-minute timer call service.refresh (repo refresh,
 *     activity linking, risks).
 */
const crypto = require('crypto');
const dns = require('dns');
const { execFile } = require('child_process');
const { createProjectService, ProjectError } = require('../../projects');
const { createProjectsRepository } = require('../../store/repos/projects');
const { ApiError, invalid } = require('./errors');
const { labelsFor, resolveLocale } = require('../../i18n');
const { projectEvents, participantsOf } = require('../../engine/model/sender');
const { capabilitiesOf } = require('./vm/meta');

const REFRESH_EVERY_MS = 10 * 60 * 1000;
const PROJECT_TYPES = new Set(['Session', 'CronRun', 'CronJob', 'Transcript', 'Activity', 'Agent', 'Repo', 'ProjectHint']);   // ProjectHint: architect-56

// ProjectError → the one error format. Its messages are fixed French phrases (projects.md); a 409 with a
// revision carries `current` (projectConflictBody).
function toApiError(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof ProjectError || (err && err.name === 'ProjectError')) {
    const code = ['validation_failed', 'not_found', 'conflict', 'upstream_failed', 'internal', 'rate_limited', 'readonly'].includes(err.code) ? err.code : 'internal';
    // A repository miss and a runtime project hidden by the caller's grants must
    // have the same public response. ProjectError's normal not-found message
    // ("Projet introuvable.") would otherwise disclose that a formerly visible
    // runtime project still exists after permissions are revoked.
    if (code === 'not_found') return new ApiError('not_found');
    const current = err.body && err.body.error && err.body.error.current ? err.body.error.current : undefined;
    const details = Array.isArray(err.details) ? err.details.map((d) => Object.assign(d.field ? { field: String(d.field) } : {}, { issue: String(d.issue || code) })) : undefined;
    return new ApiError(code, { message: err.message, details, current, status: err.status });
  }
  return new ApiError('internal');
}

// The engine, as the service's `engineRegistry` (Maps, read at call time).
// architect-57 · a session as the project history shows it: who (agent, sub-agent, channel, person), the message count,
// what it did (src/projects/session-summary.js, deterministic) and the tokens. Labels are LabelRefs (historySession.*).
const CHANNEL_NAMES = { discord: 'Discord', whatsapp: 'WhatsApp', wechat: 'WeChat', slack: 'Slack', telegram: 'Telegram', signal: 'Signal', matrix: 'Matrix', email: 'e-mail' };
function sessionInfoOf(engine, { enrichment = null, runtime = null, locale = 'fr' } = {}) {
  const { conversationSummary, messageCountOf } = require('../../projects/session-summary');
  const hidden = runtime && runtime.definition && typeof runtime.definition.hiddenTraceEvent === 'function' ? runtime.definition.hiddenTraceEvent : null;
  return (key) => {
    const s = engine.session(key);
    if (!s) return null;
    const c = s.class || {};
    const rawTranscript = engine.transcript(key);
    const senderContext = { runtime: runtime?.definition?.id || 'generic', sessionKey: key,
      people: engine.senderPeople?.() || [], nameOf: (id) => enrichment?.nameOf(id), avatarOf: (id) => enrichment?.peek(id)?.profile?.avatarUrl };
    const transcript = rawTranscript ? { ...rawTranscript, events: projectEvents(rawTranscript.events, senderContext) } : null;
    const participants = participantsOf([
      ...projectEvents((rawTranscript?.participants || []).map((senderInfo) => ({ senderInfo })), senderContext),
      ...(transcript?.events || []),
    ]);
    const agent = (engine.agents().find((a) => a.id === c.agentId) || {}).name || c.agentId || '';
    const person = (c.interlocutorId && enrichment ? enrichment.nameOf(c.interlocutorId) : null) ||
      (c.kind === 'conversation-direct' ? transcript?.events?.find((e) => e.kind === 'user' && e.sender)?.sender : null);
    const room = s.channelName ? s.channelName.replace(/^#?/, '#') : null;
    const channel = CHANNEL_NAMES[c.channel] || c.channel || null;
    let label;
    if (c.kind === 'subagent') label = { key: 'historySession.subagent', params: { agent } };
    else if (c.kind === 'primary') label = { key: 'historySession.primary', params: { agent } };
    else if (c.kind === 'scheduled') label = { key: 'historySession.scheduled', params: { agent, job: (engine.cronJobs().find((j) => j.id === c.cronJobId) || {}).name || '' } };
    else if (/^conversation/.test(c.kind || '') && (person || room)) label = channel ? { key: 'historySession.conversation', params: { agent, channel, who: person || room } } : { key: 'historySession.withWho', params: { agent, who: person || room } };
    else if (s.label || s.displayName) label = { key: 'historySession.other', params: { agent, name: s.label || s.displayName } };
    else label = { key: 'historySession.primary', params: { agent } };
    const tokens = s.usage && Number.isInteger(s.usage.total) ? s.usage.total : 0;
    const people = [];
    if (c.agentId) people.push({ id: `agent:${c.agentId}${c.subagentId ? ':subagent:' + c.subagentId : ''}`, kind: 'agent', name: agent,
      avatarUrl: null, state: null });
    for (const p of participants) if (p.kind === 'human') people.push({ id: p.avatarHint?.startsWith('person:') ? p.avatarHint.slice(7) : p.id, kind: 'human', name: p.name || (locale === 'en' ? 'User' : 'Utilisateur'), avatarUrl: /^https?:\/\//.test(p.avatarHint || '') ? p.avatarHint : null, state: null });
    return { label, people, channel, messages: messageCountOf(s, transcript, engine.conversationMessageCount?.(key)), summary: conversationSummary(transcript, { agent, locale, hidden }), tokens };
  };
}

function engineRegistry(engine, opts = {}) {
  return {
    sessionInfo: sessionInfoOf(engine, opts),
    connectorOf: key => engine.session?.(key) ? engine.connectorOf?.(key) || null : null,
    connectorById: id => engine.connectorById?.(id) || (!Array.isArray(engine.instances) && engine.connectorOf?.()?.id===id ? engine.connectorOf() : null),
    get defaultConnector() { return Array.isArray(engine.instances) ? null : engine.connectorOf?.() || null; },
    get connectors() { return Array.isArray(engine.instances) ? engine.instances.map(row=>engine.connectorById?.(row.id)).filter(Boolean) : [engine.connectorOf?.()].filter(Boolean); },
    get sessionGroups() { return engine.sessionGroups?.() || []; },
    get sessions() { return new Map(engine.sessions().map((s) => [s.key, s])); },
    get cronJobs() { return new Map(engine.cronJobs().map((j) => [j.id, j])); },
    get agents() { return new Map(engine.agents().map((a) => [a.id, a])); },
    get projectHints() { return typeof engine.projectHints === 'function' ? engine.projectHints() : []; },   // architect-54
    get cronRuns() { const m = new Map(); for (const j of engine.cronJobs()) { const r = engine.cronRuns(j.id); if (r) m.set(j.id, r); } return m; },
  };
}

// S7b: the runtime's session groups as candidate input ({groupId, name, sessionKeys, lastActivityAt}; empty groups left out).
// PM decision 2026-10-06: projects link a group by {by:'group', groupId, name}; sessionKeys is the {by:'keys'} fallback.
// Runtime data, so it's there whether or not code-host discovery is configured. [] before the first catalog read.
// architect-54: plus what the conversations already say (rooms, ticket keys, working directories), with no change to
// the agent: src/projects/sources/conversations.js.
function sessionGroupsOf(engine, cfg = {}) {
  const { conversationGroups } = require('../../projects/sources/conversations');
  return () => (engine.sessionGroups() || []).filter((g) => g.sessionKeys.length)
    .map((g) => ({ groupId: g.id, name: g.name, sessionKeys: g.sessionKeys.slice(0, 100), lastActivityAt: g.lastActivityAt }))
    .concat(conversationGroups({ sessions: engine.sessions(), flows: engine.cronJobs(), roots: cfg.projectsRoot ? [cfg.projectsRoot] : [], home: cfg.openclawHome || null,
      hints: typeof engine.projectHints === 'function' ? engine.projectHints() : [] }));
}

// Read-only gh/git for discovery and repo refresh: argv arrays only, a timeout, an output cap, owners allow-listed
// by the projects module. Off when cfg.projectsDiscovery is false (tests, or an instance without gh).
function liveSources(cfg, engine, log = () => {}) {
  if (!cfg.projectsDiscovery) return { sessionGroups: sessionGroupsOf(engine, cfg) };
  const exec = (argv) => new Promise((resolve) => {
    const [bin, ...args] = argv;
    if (bin !== 'gh' && bin !== 'git') { resolve({ stdout: '', stderr: '', code: 126 }); return; }
    execFile(bin, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) },
      (err, stdout, stderr) => resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? (Number.isInteger(err.code) ? err.code : 1) : 0 }));
  });
  return { exec, log, owners: cfg.projectsOwners, owner: cfg.projectsOwners[0], root: cfg.projectsRoot, sessionGroups: sessionGroupsOf(engine, cfg),
    resolve: (host) => dns.promises.lookup(host, { all: true }).then((r) => r.map((x) => x.address)) };
}

function mountProjects(r, { store, engine, topics, cfg, runtime, authed, guard, ok, capturer = null, enrichment = null, log = () => {}, thread = null, enforceAuthorization = false, orchestratorTeams = null, chatBackend = null, officeTopicFor = null }) {
  const owner = store.owner;
  const primaryAgentId = () => { const agent = engine.primaryAgent(); return agent ? agent.id : null; };
  const teamProjectModule = require('../../projects/orchestrator-teams');
  const runtimeProjectModule = require('../../projects/runtime-sources');
  const teamSnapshot = () => orchestratorTeams?.getSnapshot?.() || null;
  // Team-project avatars reuse the exact OfficeVM appearance selected for the
  // linked runtime session/Herdr pane. These lookups stay private to this
  // server-side join; only the canonical portrait descriptor enters ProjectVM.
  const teamPortraitForMember = (member, snapshot) => {
    const office = topics.current('office', 3)?.vm || null;
    const { officeDefaults } = require('./vm/office');
    const index = officeDefaults().index;
    const assignMemberAppearances = store?.office?.memberAppearances
      ? (ids, portraitIndex, options) => store.office.memberAppearances(ids, portraitIndex, options) : null;
    return teamProjectModule.officePortraitForMember(member, snapshot, office, { index, assignMemberAppearances });
  };
  const teamRuntimeOf = adapterId => {
    const rows = engine.runtimes?.() || [];
    const row = rows.find(value => value?.adapter === adapterId || value?.id === adapterId) || null;
    let definition = null;
    try { definition = require('../../adapters').adapterById(adapterId)?.definition || null; } catch (_) { /* unknown adapter */ }
    const name = row?.name || definition?.name || null;
    const mark = row?.mark || definition?.mark || null;
    return name || mark ? { providerName: mark?.providerName || name || null, brand: mark } : null;
  };
  const teamProjectOptions = { portraitForMember: teamPortraitForMember, runtimeOf: teamRuntimeOf };
  const runtimeProjects = () => runtimeProjectModule.collectRuntimeProjects({ sessions: engine.sessions(), agents: engine.agents(),
    connectorOf: key => engine.connectorOf?.(key) || engine.connectorOf?.() || null, idKey: cfg.sessionSecret });
  const repository = createProjectsRepository(store.db, { persons: [], ownerPersonId: owner.id, timmyPersonId: null, primaryAgentId,
    githubOwners: cfg.projectsOwners, onInvalid: () => engine.quarantine.record({ channel: 'store.projects', code: 'store.invalid', severity: 'warn', path: null }) });
  let covers = null;
  const service = createProjectService({ log,
    additionalProjects: ({ includeRuntime = false } = {}) => [
      ...teamProjectModule.teamProjects(teamSnapshot(), orchestratorTeams?.teamCapabilities),
      ...(includeRuntime ? runtimeProjects().projects : []),
    ],
    additionalPersons: () => runtimeProjects().persons,
    coverOf: (id) => covers && covers.vm(id),
    onProjectChanged: (project) => { if (covers) covers.observe(project); },
    repository, clock: () => Date.now(), ids: { mint: (p) => p + '_' + crypto.randomBytes(10).toString('hex') },
    primaryAgentId, sources: liveSources(cfg, engine, log), capturer, engineRegistry: engineRegistry(engine, { enrichment, runtime, locale: (cfg && cfg.instanceLocale) || 'fr' }),
    // G5: a board change also reaches the 3.0 board topics (their ids differ: projects?agent=…&filter=with-agent)
    publish: (change) => { const ids = (change && change.topics) || []; topics.invalidateIds(ids); if (ids.some((x) => /^projects(\?|$)/.test(String(x)))) topics.invalidate('projects'); },
  });

  const publicUrls = require('./urls').createPublicUrls({ publicUrl: cfg.publicUrl, publicApiBase: cfg.publicApiBase });
  covers = require('../../projects/covers/engine').createCoverEngine({
    dataDir: cfg.dataDir, getProject: (id) => repository.getProject(id), writable: capabilitiesOf(cfg).storeWrites,
    log,
    urlFor: (p) => publicUrls.forApi(p) || (cfg.publicApiBase || '') + p,
    onChange: (id) => { topics.invalidate('projects'); topics.invalidateIds(['project:' + id]); },
  });
  for (const project of repository.listProjects({ archived: 'all' })) covers.observe(project);

  // engine → projects (debounced), and the periodic repo/risk refresh
  // A change that arrives while a refresh runs is NOT dropped: one follow-up refresh runs afterwards (a full one).
  let pending = null, running = false, again = false;
  const runRefresh = (changeSet) => {
    if (running) { again = true; return; }
    running = true;
    Promise.resolve().then(() => service.refresh(changeSet)).catch((e) => log('projects: refresh failed (' + (e && e.code || 'error') + ')'))
      .finally(() => { running = false; if (again) { again = false; runRefresh({}); } });
  };
  engine.on('change', (c) => {
    if (!c || !PROJECT_TYPES.has(c.type)) return;
    if (c.type === 'Transcript' || c.type === 'Session') { topics.invalidate('project'); topics.invalidate('projects'); }
    if (pending) return;
    pending = setTimeout(() => { pending = null; runRefresh({ changes: [{ type: c.type }] }); }, 1000);
    if (pending.unref) pending.unref();
  });
  if (enrichment) enrichment.onChange(() => topics.invalidate('project'));
  const timer = setInterval(() => runRefresh({}), REFRESH_EVERY_MS);
  if (timer.unref) timer.unref();
  const offTeamSource = orchestratorTeams?.onChange?.(() => { topics.invalidate('projects'); topics.invalidate('project'); }) || null;

  // G5 (api-v3.md D8): 3.0 says 'with-agent' (+ agent, default the primary) and has no 'with-timmy'; 2.x is unchanged
  topics.define('projects', { params: ['filter', 'agent', 'source', 'search', 'stage'], queryValueLimits: {
    filter: 32, agent: 256, source: 256, search: 120, stage: 32,
  }, build: (p, P) => {
    const sourceFilterId = p.source || null;
    const filter = p.filter || 'all';
    if (P.version !== 3) {
      if (p.agent !== undefined) throw invalid('agent', 'unexpected-field');
      if (p.search !== undefined || p.stage !== undefined) throw invalid(p.search !== undefined ? 'search' : 'stage', 'unexpected-field');
      return service.views.board({ filter, sourceFilterId, allowUnknownSourceFilter: true, includeRuntime: false });
    }
    if (filter === 'with-timmy' || !['all', 'at-risk', 'with-agent', 'archived'].includes(filter)) throw invalid('filter', 'invalid');
    const primary = primaryAgentId();
    if (p.agent !== undefined && filter !== 'with-agent') throw invalid('agent', 'unexpected-field');
    // projects' board selects by the PRIMARY agent today; another agent needs their builder to take it (relayed)
    if (p.agent !== undefined && p.agent !== primary) throw invalid('agent', 'unsupported');
    if (p.search !== undefined && (typeof p.search !== 'string' || p.search.length > 120)) throw invalid('search', 'invalid');
    if (p.stage !== undefined && p.stage !== 'all' && !require('../../projects/constants').PROJECT_STATUSES.includes(p.stage)) throw invalid('stage', 'invalid');
    const vm = service.views.board({ filter: filter === 'with-agent' ? 'with-timmy' : filter, sourceFilterId, allowUnknownSourceFilter: true,
      includeRuntime: true, search: p.search, stage: p.stage, apiVersion: 3 });
    // Keep the non-enumerable boardAccess metadata attached by buildBoardVM.
    // It is consumed by the authorization projection to subtract restricted
    // rows from pre-stage counts, and intentionally stays off the wire.
    vm.filter = filter;
    vm.agent = filter === 'with-agent' ? primary : null;
    return vm;
  } });
  topics.define('project', { params: 'path', build: (p, P) => teamProjectModule.buildTeamProjectVM(teamSnapshot(), p.key,
    orchestratorTeams?.teamCapabilities, teamProjectOptions) || service.views.project({ id: p.key, includeRuntime: P.version === 3 }) });

  const body = (req, allowed) => {
    const b = req.body || {};
    if (typeof b !== 'object' || Array.isArray(b)) throw invalid(null, 'invalid');
    for (const k of Object.keys(b)) if (!allowed.includes(k)) throw invalid(k, 'unexpected-field');
    return b;
  };
  const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(toApiError(e)); } };
  // the cookie is the owner Person (an ActorRef; G3b: no personal shorthand); the agent token is { kind: 'agent', agentId } (G3a)
  const actorOf = (req) => {
    return require('../../security/request-actor').requestActor(req,store);
  };
  const kickoffRepo=store.projectKickoffs||null;
  const kickoffHash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const coverAuthority=req=>({write:req.authorize,generate:req.authorize?()=>{
    req.authorize();
    if(!require('../../security/comment-provenance').PROJECT_CONTEXT_READS.every(r=>store.policy.can(req.user,r.resource,r.level)))throw new ApiError('forbidden',{details:[{issue:'permission-denied'}]});
  }:null});
  const run = (name, fields, map) => wrap(async (req, res) => {
    const b = body(req, fields);
    const input = Object.assign({}, b, map ? map(req) : {}, { actor: actorOf(req), requestId: req.requestId });
    const result = await covers.withAuthority(coverAuthority(req),()=>service.commands[name](input));
    ok(res, result);
  });
  const id = (req) => ({ id: req.params.id });

  // ---- views ----
  r.get('/views/project-create', authed, wrap((req,res)=>{
    if(req.apiVersion!==3||!chatBackend?.projectCreateVM)throw new ApiError('not_found');
    const vm=chatBackend.projectCreateVM(req);ok(res,vm,null,'projectCreate');
  }));
  r.get('/views/projects', authed, wrap((req, res) => {
    const filter = typeof req.query.filter === 'string' ? req.query.filter : 'all';
    if (req.apiVersion !== 3 && (req.query.search !== undefined || req.query.stage !== undefined)) {
      throw invalid(req.query.search !== undefined ? 'search' : 'stage', 'unexpected-field');
    }
    if (req.apiVersion === 3 && req.query.search !== undefined && (typeof req.query.search !== 'string' || req.query.search.length > 120)) throw invalid('search', 'invalid');
    if (req.apiVersion === 3 && req.query.stage !== undefined && typeof req.query.stage !== 'string') throw invalid('stage', 'invalid');
    const q = [];
    if (typeof req.query.agent === 'string') q.push('agent=' + encodeURIComponent(req.query.agent));
    if (filter !== 'all') q.push('filter=' + encodeURIComponent(filter));
    if (typeof req.query.source === 'string') q.push('source=' + encodeURIComponent(req.query.source));
    if (req.apiVersion === 3 && typeof req.query.search === 'string') q.push('search=' + encodeURIComponent(req.query.search));
    if (req.apiVersion === 3 && typeof req.query.stage === 'string') q.push('stage=' + encodeURIComponent(req.query.stage));
    const t = topics.current(q.length ? 'projects?' + q.join('&') : 'projects', req.apiVersion);
    if (!t) throw invalid('filter', 'invalid');
    ok(res, t.vm, { id: t.id, rev: t.rev });
  }));
  r.get('/views/projects/:id/history', authed, wrap((req, res) => {
    const limit = req.query.limit == null ? undefined : Number(req.query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw invalid('limit', 'invalid');
    ok(res, service.views.history({ id: req.params.id, cursor: req.query.cursor || undefined, limit }), null, 'history');
  }));
  r.get('/views/projects/:id', authed, wrap((req, res) => {
    const t = topics.current('project:' + req.params.id, req.apiVersion);
    let vm = t.vm;
    // A team project is shared across viewers, but the OfficeVM join is
    // principal-scoped. Resolve its portraits against the same scoped Office
    // projection the Bureau serves when this principal can obtain it. A team
    // reader may lack Office access; keep the already projected/persisted
    // portrait in that case rather than failing the project detail read.
    const officeReadable = !enforceAuthorization || !!req.user && store?.policy?.can(req.user, 'office', 'read');
    if (vm?.teamProject && officeReadable && typeof officeTopicFor === 'function') {
      let office = null;
      try {
        const officeTopic = officeTopicFor(req);
        office = officeTopic ? topics.current(officeTopic, req.apiVersion)?.vm : null;
      } catch (error) {
        if (error?.code !== 'forbidden') throw error;
      }
      if (office) {
        const snapshot = teamSnapshot();
        const members = new Map((snapshot?.members || []).map(member => [member.id, member]));
        const roster = vm.teamProject.roster;
        vm = { ...vm, teamProject: { ...vm.teamProject, roster: { ...roster, members: roster.members.map(row => {
          const member = members.get(row.id);
          if (!member) return row;
          return { ...row, portrait: teamProjectModule.officePortraitForMember(member, snapshot, office, {
            index: require('./vm/office').officeDefaults().index,
            assignMemberAppearances: store?.office?.memberAppearances
              ? (ids, portraitIndex, options) => store.office.memberAppearances(ids, portraitIndex, options) : null,
          }) || row.portrait };
        }) } } };
      }
    }
    ok(res, vm, { id: t.id, rev: t.rev });
  }));
  r.get('/views/project-candidates', authed, wrap(async (req, res) => {
    req.authorize?.();
    const requirements=require('../../security/comment-provenance').PROJECT_CONTEXT_READS;
    if(req.authorize&&!requirements.every(r=>store.policy.can(req.user,r.resource,r.level)))return ok(res,{scannedAt:Date.now(),candidates:[]},null,'candidates');
    const authorize=req.authorize?()=>{
      req.authorize();
      if(!requirements.every(r=>store.policy.can(req.user,r.resource,r.level)))throw new ApiError('forbidden',{details:[{issue:'permission-denied'}]});
    }:null;
    ok(res,await require('../../security/dispatch-context').runAuthorized(authorize,()=>service.views.candidates({...(authorize?{authorize}:{})})),null,'candidates');
  }));

  r.get('/project-covers/:file', authed, require('../../projects/covers/store').serveCover(covers.store,{authorize:req=>{
    req.authorize?.();
    if(req.authorize&&!require('../../security/comment-provenance').PROJECT_CONTEXT_READS.every(r=>store.policy.can(req.user,r.resource,r.level))&&!covers.store.isUploadFile(req.params.file))throw new ApiError('forbidden',{details:[{issue:'permission-denied'}]});
  }}));

  // ---- commands (store class) ----
  const store_ = guard('store');
  r.post('/projects', authed, store_, wrap(async(req,res)=>{
    const allowed=req.apiVersion===3?['name','status','priority','summary','sources','targetAgentId']:['name','status','priority','summary','sources'];
    const b=body(req,allowed);
    if(b.targetAgentId===undefined){
      const result=await covers.withAuthority(coverAuthority(req),()=>service.commands.create(Object.assign({},b,{actor:actorOf(req),requestId:req.requestId})));
      return ok(res,result);
    }
    if(req.apiVersion!==3||typeof b.targetAgentId!=='string'||!kickoffRepo||!chatBackend?.createProjectKickoff)throw invalid('targetAgentId','invalid');
    chatBackend.authorizeProjectKickoff(req);
    const key=req.get('Idempotency-Key');
    if(typeof key!=='string'||!/^[A-Za-z0-9._~-]{16,128}$/.test(key))throw invalid('Idempotency-Key','invalid');
    const scope=chatBackend.scopeOf(req);
    const normalized={name:b.name,status:b.status??null,priority:b.priority??null,summary:b.summary??null,sources:b.sources??[],targetAgentId:b.targetAgentId};
    const requestHash=kickoffHash(normalized),previous=kickoffRepo.byKey(scope,key);
    if(previous){
      if(previous.requestHash!==requestHash)throw new ApiError('conflict',{details:[{issue:'idempotency-conflict'}]});
      const vm=service.views.project({id:previous.projectId,includeRuntime:true});
      const {projectId:_projectId,...kickoff}=chatBackend.projectKickoffVM(req,previous);
      return ok(res,{ok:true,result:{projectId:previous.projectId,sessionId:previous.sessionId,turnId:previous.turnId},revision:vm.revision,vm:{...vm,kickoff}});
    }
    const selected=chatBackend.resolveProjectTarget(req,b.targetAgentId);
    const generatedGroup='kickoff_'+crypto.randomBytes(18).toString('base64url');
    let accepted,record,dispatch;
    store.withTx(()=>{
      const created=service.commands.create({name:b.name,status:b.status,priority:b.priority,summary:b.summary,
        sources:[...(b.sources||[]),{kind:'sessionGroup',ref:{by:'group',groupId:generatedGroup,name:String(b.name||'').trim().slice(0,200)||'Project'}}],
        actor:actorOf(req),requestId:req.requestId});
      const projectId=created.vm.id;
      // The engine's canonical agent person is already seeded in the shared
      // persons table. Reuse that identity instead of inserting another row
      // with the same unique agent_id (the runtime-specific fallback is only
      // for adapters whose agents have not been seeded into the owner store).
      const existingAgentPerson=repository.listPersons().find(person=>person.kind==='agent'
        &&person.links?.agentId===selected.agent.id&&!person.links?.subagentId);
      const personId=existingAgentPerson?.id||runtimeProjectModule.personId(selected.connectorId||('runtime:'+selected.target.runtime_id),selected.agent.id);
      if(!existingAgentPerson)repository.upsertPerson({id:personId,kind:'agent',name:String(selected.agent.name||'Agent').trim().slice(0,80)||'Agent',avatarUrl:null,
        links:{agentId:selected.agent.id}});
      accepted=service.commands.setPersonOverride({id:projectId,expectedRevision:created.revision,personId,role:'owner',added:true,
        actor:actorOf(req),requestId:req.requestId});
      if(selected.connectorId){
        const sources=repository.sources.get(projectId)||[];
        repository.sources.set(projectId,sources.map(source=>source.kind==='sessionGroup'&&source.ref?.groupId===generatedGroup
          ? {...source,connectorIds:[selected.connectorId]}:source));
      }
      const kickoff=chatBackend.createProjectKickoff({req,targetId:b.targetAgentId,project:{id:projectId,name:accepted.vm.name,
        summary:accepted.vm.summary,status:accepted.vm.status,priority:accepted.vm.priority,
        url:'/projets/'+encodeURIComponent(projectId)},idempotencyKey:key,requestHash});
      record=kickoffRepo.create({projectId,principalScope:scope,idempotencyKey:key,requestHash,targetId:b.targetAgentId,
        sessionId:kickoff.sessionId,turnId:kickoff.turnId,connectorId:kickoff.connectorId,createdAt:Date.now()});
      dispatch=kickoff.dispatch;
    });
    dispatch();
    const {projectId:_projectId,...kickoff}=chatBackend.projectKickoffVM(req,record);
    ok(res,{...accepted,vm:{...accepted.vm,kickoff}});
  }));
  r.get('/projects/:id/kickoff',authed,wrap((req,res)=>{
    if(req.apiVersion!==3||!kickoffRepo||!chatBackend?.projectKickoffVM)throw new ApiError('not_found');
    const record=kickoffRepo.byProject(chatBackend.scopeOf(req),req.params.id);
    if(!record)throw new ApiError('not_found');
    ok(res,chatBackend.projectKickoffVM(req,record),null,'projectKickoff');
  }));
  r.post('/projects/:id/kickoff/retry',authed,store_,wrap((req,res)=>{
    if(req.apiVersion!==3||!kickoffRepo||!chatBackend?.retryProjectKickoff)throw new ApiError('not_found');
    if(Object.keys(req.body||{}).length)throw invalid(null,'unexpected-field');
    const record=kickoffRepo.byProject(chatBackend.scopeOf(req),req.params.id);
    if(!record)throw new ApiError('not_found');
    const result=chatBackend.retryProjectKickoff(req,record);res.status(202);ok(res,{ok:true,result,revision:null,vm:null});
  }));
  const coverProject = (req, b) => {
    const project = repository.getProject(req.params.id);
    if (!project) throw new ApiError('not_found');
    if (!Number.isInteger(b.expectedRevision)) throw invalid('expectedRevision', 'required');
    if (project.revision !== b.expectedRevision) throw new ApiError('conflict', { current: { revision: project.revision, vm: service.views.project({ id: project.id }) } });
    return project;
  };
  r.post('/projects/:id/cover/regenerate', authed, store_, wrap((req, res) => {
    const b = body(req, ['expectedRevision']); const project = coverProject(req, b);
    const queued = covers.withAuthority(coverAuthority(req),()=>covers.regenerate(project.id));
    res.status(202); ok(res, { ok: true, result: { queued }, revision: project.revision, vm: service.views.project({ id: project.id }) });
  }));
  r.put('/projects/:id/cover', authed, store_, wrap(async (req, res) => {
    const b = body(req, ['expectedRevision', 'image']); const project = coverProject(req, b);
    if (typeof b.image !== 'string' || b.image.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.image)) throw invalid('image', 'invalid');
    const bytes = Buffer.from(b.image, 'base64');
    if (!require('../../projects/covers/raster').rasterKind(bytes)) throw invalid('image', 'invalid');
    try { await covers.withAuthority(coverAuthority(req),()=>covers.upload(project.id, bytes)); } catch (e) { if(e instanceof ApiError)throw e;throw new ApiError('upstream_failed'); }
    ok(res, { ok: true, result: null, revision: repository.getProject(project.id).revision, vm: service.views.project({ id: project.id }) });
  }));
  r.post('/projects/import', authed, store_, run('importCandidates', ['keys', 'overrides']));
  r.patch('/projects/:id', authed, store_, run('edit', ['expectedRevision', 'name', 'summary', 'priority'], id));
  r.put('/projects/:id/status', authed, store_, run('setStatus', ['expectedRevision', 'status'], id));
  r.put('/projects/:id/archived', authed, store_, run('setArchived', ['expectedRevision', 'archived'], id));
  r.post('/projects/:id/flags', authed, store_, run('addFlag', ['expectedRevision', 'kind', 'label', 'key'], id));
  r.delete('/projects/:id/flags/:kind/:key', authed, store_, run('removeFlag', ['expectedRevision'], (req) => ({ id: req.params.id, kind: req.params.kind, key: req.params.key })));
  r.put('/projects/:id/flags/risk/:key/ack', authed, store_, run('ackRisk', ['expectedRevision', 'ack'], (req) => ({ id: req.params.id, key: req.params.key })));
  r.post('/projects/:id/sources', authed, store_, run('linkSource', ['expectedRevision', 'source'], id));
  r.delete('/projects/:id/sources/:sourceId', authed, store_, run('unlinkSource', ['expectedRevision'], (req) => ({ id: req.params.id, sourceId: req.params.sourceId })));
  r.put('/projects/:id/people/:personId', authed, store_, run('setPersonOverride', ['expectedRevision', 'role', 'hidden'], (req) => ({ id: req.params.id, personId: req.params.personId })));
  r.post('/projects/:id/history', authed, store_, wrap(async (req, res) => {
    const b = body(req, Object.keys(req.body || {}).filter((k) => k !== 'actor'));   // payload fields are the kind's (validated by the module)
    if ((req.body || {}).actor !== undefined) throw invalid('actor', 'unexpected-field');
    ok(res, await service.commands.appendHistory(Object.assign({}, b, { id: req.params.id, actor: actorOf(req), requestId: req.requestId })));
  }));

  // ---- « Régénérer le résumé »: an agent turn (OpenClaw class), 202 ----
  r.post('/projects/:id/summary/regenerate', authed, guard('store'), guard('openclaw'), wrap(async (req, res) => {
    const b = body(req, ['expectedRevision']);
    const primary = engine.primaryAgent();
    const input = { id: req.params.id, expectedRevision: b.expectedRevision, requestId: req.requestId, actor: actorOf(req) };
    const useThread = thread && primary && capabilitiesOf(cfg).storeWrites;
    req.authorize?.();
    const accepted = useThread ? thread.startSummary(input, primary.id, actorOf(req),req) : service.commands.regenerateSummary(input);
    res.status(202);ok(res,accepted);
    const vm = accepted.vm;
    // G3b: the turn asks in the INSTANCE language (AO_LOCALE), not a fixed French
    const L = labelsFor(resolveLocale({ instance: cfg && cfg.instanceLocale }), 'server');
    const prompt = L['prompt.projectSummary'].replace(/\{(\w+)\}/g, (_, k) => ({ name: vm.name, status: vm.status,
      sources: vm.sources.map((s) => s.label).join(', ') || L['prompt.noSources'] })[k]);
    // the runtime adapter runs the turn (G2) with the primary agent (G3a replaces this lookup with the resolver)
    const turnId = accepted.result && accepted.result.turnId;
    // R13-05: a failed or empty turn releases the pending regeneration (so it can be retried) when projects exposes it
    const release = () => { if (typeof service.commands.abandonSummary === 'function') { try { service.commands.abandonSummary({ id: vm.id, turnId }); } catch (_) { /* already settled */ } } };
    if (!primary) return release();
    if (useThread) return;
    const runTurn = () => require('../../security/dispatch-context').runAuthorized(req.authorize,()=>runtime.commands.agentTurn({ agentId: primary.id, text: prompt,
      sessionRef: 'portal-summary-' + vm.id, timeoutMs: 150000 }));
    Promise.resolve().then(runTurn)
      .then((out) => {
        const text = out && !out.failed && out.text ? out.text.trim() : '';
        if (!text) { if (out && out.failed) log('projects: summary turn failed (' + out.failed + ')'); return release(); }
        const summaryActor = { kind: 'agent', agentId: primary.id };
        const done = service.commands.completeSummary({
          id: vm.id, turnId, expectedRevision: accepted.revision, summary: text.slice(0, 4000), actor: summaryActor,
        });
        if (done.result && done.result.applied === false) return release();
        return done;
      })
      .catch((e) => { log('projects: summary turn failed (' + (e && e.code || 'error') + ')'); release(); });
  }));

  return { service, repository,
    teamProjectById: id => teamProjectModule.buildTeamProjectVM(teamSnapshot(), id, orchestratorTeams?.teamCapabilities),
    // Only entities supported by the comment thread can authorize that topic.
    // Runtime-derived projects declare comments unsupported and are not resolved
    // by projectForRequest, so treating them as existing here would create a
    // separate existence oracle for hidden runtime projects.
    projectExistsById: id => !!repository.getProject(id) || !!teamProjectModule.buildTeamProjectVM(teamSnapshot(), id, orchestratorTeams?.teamCapabilities),
    covers, close: () => { offTeamSource?.(); covers.close(); clearInterval(timer); if (pending) clearTimeout(pending); } };
}

module.exports = { sessionGroupsOf, mountProjects, toApiError, engineRegistry };
