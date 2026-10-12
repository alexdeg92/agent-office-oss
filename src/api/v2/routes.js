'use strict';
/*
 * API v2 routes (api.md, S6): meta, me, the health view and its topic, the mute command, the typed stream.
 * Every /api/v2 response is `no-store`, carries X-Request-Id, and errors use the one format (errors.js).
 * Write classes (§5.0) are declared here; http.js's read-only backstop asks `writeClassOf` so transport
 * control is never guarded and store writes follow `capabilities.storeWrites`.
 */
const express = require('express');
const { ApiError, invalid, errorMiddleware } = require('./errors');
const { okBody, MODEL_VERSION, CONTRACT_VERSION, CONTRACT_VERSION_V3 } = require('./envelope');
const { createVersionedTopics } = require('./topics');
const { project2x } = require('./project2x');
const { project3x } = require('./project3x');
const { createStreamHub } = require('./stream');
const { officeSignalFrame } = require('./office-signals');
const { buildHealthVM, createHealthSeries } = require('./vm/health');
const { buildMetaVM, buildMetaVM3, buildMeVM, capabilitiesOf } = require('./vm/meta');
const { mountProjects } = require('./projects');
const { createProjectThread } = require('./comments');
const { mountViews, officeTopicFor } = require('./views');
const { mountCommands } = require('./commands');
const { mountOfficeLayout } = require('./office-layout');
const { createVmCheck } = require('./vm/check');
const { resolveLocale } = require('../../i18n');
const { createCapturer, findChrome, shotPath } = require('../../capture/capturer');
const { createPublicUrls } = require('./urls');
const { every } = require('../../ops/timescale');
const readBuild = require('../ui-build').createBuildReader();

// (method, path) → 'transport' | 'store' | 'openclaw'
// G5: the same classes on /api/v2 and /api/v3
const WRITE_CLASSES = [
  { method: '*', re: /^\/api\/v3\/(users|roles)(\/.*)?$/i, cls: 'store' },
  { method: 'POST', re: /^\/api\/v3\/settings\/restart\/?$/i, cls: 'store' },
  { method: 'POST', re: /^\/api\/v3\/settings\/fix-all\/?$/i, cls: 'store' },
  { method: 'POST', re: /^\/api\/v3\/settings\/access\/apply\/?$/i, cls: 'store' },
  { method: 'POST', re: /^\/api\/v[23]\/stream\/[^/]+\/(topics|resync)\/?$/i, cls: 'transport' },
  { method: 'PUT', re: /^\/api\/v[23]\/health\/issues\/[^/]+\/muted\/?$/i, cls: 'store' },
  { method: 'POST', re: /^\/api\/v[23]\/health\/checks\/[^/]+\/fix\/?$/i, cls: 'store' },
  { method: 'POST', re: /^\/api\/v[23]\/health\/fix-all\/?$/i, cls: 'store' },
  // S7a, Projets: store writes, except the summary regeneration (an agent turn: OpenClaw class, refused read-only)
  { method: 'POST', re: /^\/api\/v[23]\/projects\/[^/]+\/comments\/[^/]+\/retry\/?$/i, cls: 'openclaw' },
  { method: 'POST', re: /^\/api\/v[23]\/projects\/[^/]+\/summary\/regenerate\/?$/i, cls: 'openclaw' },
  { method: '*', re: /^\/api\/v[23]\/projects(\/.*)?$/i, cls: 'store' },
  // S7c, OpenClaw commands (api.md §5.1, §5.2)
  { method: '*', re: /^\/api\/v[23]\/flows(\/.*)?$/i, cls: 'openclaw' },
  { method: 'PUT', re: /^\/api\/v[23]\/skills\/[^/]+\/enabled\/?$/i, cls: 'openclaw' },
  { method: 'POST', re: /^\/api\/v[23]\/gateway\/restart\/?$/i, cls: 'openclaw' },
  { method: 'POST', re: /^\/api\/v[23]\/chat\/messages\/?$/i, cls: 'openclaw' },
  // S14b: the office layout and the UI prefs (store)
  { method: 'PUT', re: /^\/api\/v[23]\/office\/layout(\/theme)?\/?$/i, cls: 'store' },
  { method: 'PATCH', re: /^\/api\/v[23]\/prefs\/?$/i, cls: 'store' },
];
// R22-08: the contract version is the mount path's, case-insensitively, as Express matches it (/API/V3 is v3, everywhere)
const apiVersionOf = (req) => (/^\/api\/v3$/i.test(String(req.baseUrl || '')) ? 3 : 2);
const writeClassOf = (method, p) => { const w = WRITE_CLASSES.find((x) => (x.method === method || x.method === '*') && x.re.test(p)); return w ? w.cls : null; };

/*
 * G5 (api-v3.md): ONE router mounted at /api/v2 AND /api/v3. req.apiVersion (2 | 3) comes from the mount path; routes,
 * on-demand reads, chat state and tickers are shared, and only the VM projection differs: the topics are versioned
 * (createVersionedTopics), each version has its own runtime check and its own stream hub.
 */
function mountV2(app, { auth, engine, cfg, store, runtime, enrichment = null, setup = null, settings = null, externalAccess = null, orchestratorTeams = null, sourcePrincipalFor = null, sessionsReadable: readable = null,
  enforceAuthorization = false, reauthenticationElapsed = undefined, log = (entry) => console.error(typeof entry === 'string' ? entry : JSON.stringify(entry)), now = () => Date.now() }) {
  // Internal integration switch only. Server boot keeps this off until the whole auth surface is reviewed.
  if(enforceAuthorization&&!store?.policy)throw new Error('authorization store required');
  const projector=enforceAuthorization?require('../../security/view-projection').createViewProjection({store,cfg}):null;
  const reauthentication=enforceAuthorization?require('../../security/reauthentication').createReauthentication({store,auth,now,elapsed:reauthenticationElapsed}):null;
  if(reauthentication)settings?.useAuthorization?.({reauthentication});
  const httpProjection=projector?require('../../security/http-projection').createHttpProjection({store,projector,reauthentication}):null;
  const series = createHealthSeries({ engine, now });
  // PM audit (B): runtime VM validation; throws on test/dev instances (or AO_STRICT_VM=1), falls back to the last good
  // VM with a quarantine issue elsewhere
  // the VM schemas' field names may appear in vm.invalid issue paths (the quarantine's privacy rule: schema names only)
  if (engine.declareFields) engine.declareFields(require('../../schema').declaredNames(Object.values(require('./vm/schemas').VM_SCHEMAS).concat(Object.values(require('./vm/schemas').VM_SCHEMAS_V3))));
  const vmMode = cfg.strictVm || cfg.instance === 'test' || cfg.instance === 'dev' ? 'throw' : 'fallback';
  const report = (i) => { try { engine.quarantine.record(i); } catch (_) { /* never breaks a response */ } };
  const resolveVmIssue = (channel, name) => {
    engine.quarantine.markClean(channel);
    // Older releases recorded the health topic under this alias. A healthy
    // validated view is evidence that those persisted schema errors are stale.
    if (name === 'health') engine.quarantine.markClean('core:vm.health');
  };
  const vms = { 2: createVmCheck({ mode: vmMode, report, resolve: resolveVmIssue, version: 2 }), 3: createVmCheck({ mode: vmMode, report, resolve: resolveVmIssue, version: 3 }) };
  const topics = createVersionedTopics({ 2: { P: project2x, check: (name, vm, id) => vms[2].check(name === 'office-scope' ? 'office' : name, require('./runtime-projection').projectLegacy(vm, name === 'office-scope' ? 'office' : name), id) }, 3: { P: project3x, check: (name, vm, id) => vms[3].check(name === 'office-scope' ? 'office' : name, vm, id) } }, {
    policyDeclarations:require('../../security/route-declarations').TOPICS,
    resourceRegistry:store?.registry || require('../../security/resources').createResourceRegistry(),
    onError: diagnostic => { try { log({ event: 'api.topic.build_failed', ...diagnostic }); } catch (_) { /* logging cannot break requests */ } },
  });
  topics.define('health', { build: (_, P) => buildHealthVM({ engine, series, P }) });
  const sourceSnapshot = () => orchestratorTeams?.getSnapshot?.() || null;
  const sourceScopes = new Map(), sourceScopesByPrincipal = new Map();
  const sourcePermissions = require('../../security/orchestrator-team-resources');
  const principalFromUser = user => user ? {
    id: user.id, role: user.role_id === 'rol_admin' ? 'admin' : 'custom',
    permissionRevision: user.permission_revision || 0,
    permissions: store?.policy?.permissions?.(user) || {},
  } : null;
  const sourcePrincipal = (req, reauthorize = false) => {
    if (reauthorize) req.authorize?.();
    if (!req.session) return null;
    if (sourcePrincipalFor) return sourcePrincipalFor({ session: req.session, req, store });
    const user = req.user || store?.users?.byId?.(req.session.userId);
    if (!user || user.status !== 'active' || (req.session.authGeneration ?? 0) !== user.auth_generation) return null;
    return principalFromUser(user);
  };
  const permissionFingerprint = principal => JSON.stringify([principal.id, principal.role, principal.permissionRevision || 0,
    Object.fromEntries(Object.keys(principal.permissions || {}).sort().map(key => [key, principal.permissions[key]]))]);
  const sourceTopic = (req, kind) => {
    const principal = sourcePrincipal(req, true);
    if (!principal || (kind !== 'office' && !sourcePermissions.allowsPrincipal(principal, kind, 'read'))) throw new ApiError('forbidden');
    const enabled = kind === 'orchestrators' ? !!orchestratorTeams?.hasHerdr : kind === 'teams' ? !!orchestratorTeams?.hasTeamStore : true;
    if (!enabled) throw new ApiError('not_found');
    const fingerprint = permissionFingerprint(principal);
    let token = sourceScopesByPrincipal.get(fingerprint);
    if (!token) {
      if (sourceScopes.size >= 256) {
        const candidate = [...sourceScopes.keys()].find(old => !['teams:', 'orchestrators:', 'office-scope:'].some(prefix => hubs[3].isSubscribed(prefix + old)));
        if (!candidate) throw new ApiError('rate_limited');
        const expired = sourceScopes.get(candidate);
        topics.of(3).forget('teams:' + candidate); topics.of(3).forget('orchestrators:' + candidate); topics.of(3).forget('office-scope:' + candidate);
        sourceScopes.delete(candidate); sourceScopesByPrincipal.delete(expired?.fingerprint);
      }
      token = require('node:crypto').randomBytes(18).toString('base64url');
      sourceScopes.set(token, { fingerprint, principal: JSON.parse(JSON.stringify(principal)) });
      sourceScopesByPrincipal.set(fingerprint, token);
    }
    return kind + ':' + token;
  };
  const authorizeSourceTopic = (topic, context) => {
    if (!['orchestrators', 'teams', 'office-scope'].includes(topic?.name)) return true;
    const principal = sourcePrincipal({ session: context?.session });
    const key = topic.params?.key;
    const scope = typeof key === 'string' ? sourceScopes.get(key) : null;
    if (!principal || !scope || permissionFingerprint(principal) !== scope.fingerprint) return false;
    if (topic.name !== 'office-scope' && !sourcePermissions.allowsPrincipal(principal, topic.name, 'read')) return false;
    if (topic.name === 'orchestrators' && !orchestratorTeams?.hasHerdr) return false;
    if (topic.name === 'teams' && !orchestratorTeams?.hasTeamStore) return false;
    return true;
  };
  const sourceChanged = () => { topics.invalidate('orchestrators'); topics.invalidate('teams'); topics.invalidate('office-scope'); };
  const offOrchestratorTeams = orchestratorTeams?.onChange?.(sourceChanged) || null;
  orchestratorTeams?.start?.();
  topics.of(3).define('orchestrators', { params: 'path', permission: { resource: 'orchestrators', level: 'read' }, build: ({ key }) => {
    const scope = sourceScopes.get(key); if (!scope) throw new ApiError('not_found');
    return require('../orchestrator-team-projection').projectOrchestrators(sourceSnapshot(), scope.principal,
      { sourceEnabled: true, runtimeAgents: engine.agents() });
  } });
  topics.of(3).define('teams', { params: 'path', permission: { resource: 'teams', level: 'read' }, build: ({ key }) => {
    const scope = sourceScopes.get(key), snapshot = sourceSnapshot();
    if (!scope || !snapshot?.team) throw new ApiError('not_found');
    const runtimeRows = [...(engine.runtimes?.() || [])];
    const active = engine.runtime?.();
    if (active?.definition) runtimeRows.push({ id: active.definition.id, adapter: active.definition.id,
      capabilities: active.definition.capabilities, mark: active.definition.mark });
    const adapterIds = new Set((snapshot.members || []).map(member => member?.runtimeKind).filter(id => typeof id === 'string'));
    for (const id of adapterIds) {
      if (runtimeRows.some(row => (row?.adapter || row?.adapterId || row?.id) === id)) continue;
      try {
        const adapter = require('../../adapters').adapterById(id);
        runtimeRows.push({ id, adapter: id, name: adapter.definition?.name || id, mark: adapter.definition?.mark,
          capabilities: adapter.definition?.capabilities });
      } catch (_) { /* unknown providers keep the neutral shared-brand fallback */ }
    }
    const seenBrands = new Set();
    const brands = runtimeRows.flatMap(row => {
      const id = row?.adapter || row?.adapterId || row?.id;
      const source = row?.capabilities?.brand || row?.definition?.capabilities?.brand || row?.brand || row?.mark || row?.definition?.mark;
      if (typeof id !== 'string' || !source || seenBrands.has(id)) return [];
      seenBrands.add(id);
      return [{ id, brand: { mark: source.mark || source.monogram || null, color: source.color || '#596579',
        foreground: source.foreground || '#ffffff', providerName: source.providerName || row.name || id,
        ...(typeof source.logo === 'string' ? { logo: source.logo } : {}), ...(typeof source.logoDark === 'string' ? { logoDark: source.logoDark } : {}) } }];
    });
    return require('../orchestrator-team-projection').projectTeamBoard(snapshot, scope.principal,
      { sourceEnabled: true, runtimeBrands: brands });
  } });
  const systemState = () => ({ gateway: engine.gateway().connected ? 'up' : 'down', capabilities: capabilitiesOf(cfg) });
  // agent-identity-1: who may read session-derived office fields. Today every cookie session is the owner's; a
  // machine principal or a missing session never is. RBAC (T-0031) replaces this with its logs:read check.
  const sessionsReadable = readable || (({ session, principal }) => !principal && !!session);
  const resolveTopic = (id, session) => {
    const ordinary = officeTopicFor({ session }, sessionsReadable, id);
    if (ordinary !== id || id !== 'office' || !(orchestratorTeams?.hasHerdr || orchestratorTeams?.hasTeamStore || orchestratorTeams?.detected)) return ordinary;
    try { return 'office-scope:' + sourceTopic({ session }, 'office').slice('office:'.length); }
    catch (_) { return ordinary; }
  };
  const admission = new Map(); // global/session caps span both API versions
  const warnings = new Set();
  const streamPolicies={};
  const streamSecurity=version=>projector?{
    authorizationEvents:store.authorizationEvents,
    security:streamPolicies[version]=require('../../security/stream-policy').createStreamPolicy({store,auth,topics:topics.of(version),now,
      project:(user,id,vm)=>projector.project(user,id,vm,{version}),
      filterFrame:(user,type,data)=>projector.frame(user,type,data,{version}),
      mayExposeSources:projector.mayExposeSources}),
  }:{};
  const hubs = {
    2: createStreamHub({ admission, warnings, log, resolveTopic, authorizeTopic: authorizeSourceTopic, topics: topics.of(2), engine, systemState, contractVersion: CONTRACT_VERSION, modelVersion: MODEL_VERSION, now, buildId: () => readBuild().buildId, ...streamSecurity(2) }),
    3: createStreamHub({ admission, warnings, log, resolveTopic, authorizeTopic: authorizeSourceTopic, topics: topics.of(3), engine, systemState, contractVersion: CONTRACT_VERSION_V3, modelVersion: MODEL_VERSION, now, buildId: () => readBuild().buildId, ...streamSecurity(3) }),
  };
  const hub = hubs[2];
  const hubOf = (req) => hubs[req.apiVersion] || hubs[2];

  // data changes → topics (coalesced); connection changes → system frames
  engine.on('ingested', () => topics.invalidate());
  engine.on('change', (c) => { if (c?.channel === 'settings') office?.refreshSettings(); topics.invalidate(); if (c && c.channel === 'gateway.connection') { hubs[2].broadcastSystem(); hubs[3].broadcastSystem(); } });
  const onOfficeLive = e => { for (const P of [project2x, project3x]) { const frame = officeSignalFrame(e, P); if (frame) hubs[P.version].broadcastOffice(frame); } };
  engine.on('live', onOfficeLive);
  const sampler = setInterval(() => { series.sample(); topics.invalidate('health'); }, every(60000));
  if (sampler.unref) sampler.unref();
  series.sample();
  auth.onRevoke((s) => { hubs[2].revokeSession(s); hubs[3].revokeSession(s); });

  const {trackMounts,exceptionMiddleware:except}=require('../../security/route-policy');
  const r = enforceAuthorization?trackMounts(express.Router()):express.Router();
  if(enforceAuthorization)require('../../security/route-policy').decorateRouter(r,require('../../security/route-declarations').ROUTES,{auth,store});
  r.use(except('api.version',(req, res, next) => { req.apiVersion = apiVersionOf(req); res.setHeader('Cache-Control', 'no-store'); next(); }));
  // S7d: an allowed token request (the gate set req.principal) is authenticated as the agent, never as a cookie session
  const authed = (req, res, next) => { if (req.principal||req.session) return next(); const s = auth.sessionOf(req); if (!s) return next(new ApiError('unauthorized')); req.session = s; next(); };
  const guard = (cls) => (req, res, next) => {
    const caps = capabilitiesOf(cfg);
    if ((cls === 'store' && !caps.storeWrites) || (cls === 'openclaw' && !caps.openclawWrites)) return next(new ApiError('readonly'));
    next();
  };
  // `name`: the VM checked for a response that isn't a topic (topics are checked when built)
  // G5: the response's contract version is its request's (res.req.apiVersion)
  const ok = (res, data, topic, name) => { const v = (res.req && res.req.apiVersion) || 2;
    if (v === 2) data = require('./runtime-projection').projectLegacy(data, name);
    const req=res.req,human=httpProjection&&req.principal?.kind!=='agent';
    if(human)data=httpProjection.data(req,data,{name,topic:topic?.id});
    const cohort=human?':'+store.rbac.fingerprint(req.user.id):'';
    res.json(okBody(name ? vms[v].check(name, data, 'route:' + name+cohort) : data, { engine:human&&!httpProjection.mayExposeSources(req)?null:engine, now: now(), topic })); };
  const noExtra = (body, allowed) => { for (const k of Object.keys(body || {})) if (!allowed.includes(k)) throw invalid(k, 'unexpected-field'); };

  const localeOf = (req) => resolveLocale({ explicit: typeof req.query.locale === 'string' ? req.query.locale : null, pref: store && store.office ? store.office.prefs().locale : null, acceptLanguage: req.headers['accept-language'], instance: cfg.instanceLocale });
  // G4 (api.md §5.7): on a configured instance the setup routes only say 'locked' (or 'readonly')
  if (setup) setup.mount(r);
  if (settings) require('../v3/settings').mountSettings({ r, settings, auth, authed, ok, reauthentication, externalAccess, check: vm => vms[3].check('settings',vm,'route:settings') });
  if(reauthentication)require('../v3/access-management').mountAccessManagement({r,store,reauthentication,readonly:()=>!!(cfg.readonly||cfg.readonlyStore)});
  const metadataIdentity=enforceAuthorization?require('../../security/route-policy').createRouteGuard(require('../../security/route-declarations').ROUTES.get('GET /me'),{auth,store}):null;
  r.get('/meta', (req,res,next)=>metadataIdentity&&!req.principal&&auth.sessionOf(req)?metadataIdentity(req,res,next):next(), (req, res) => {
    res.setHeader('Vary', 'Accept-Language, Cookie');
    const authenticated = !req.principal && !!auth.sessionOf(req);
    // Neither machine credentials nor an absent/expired owner session enrich bootstrap.
    const data = (req.apiVersion === 3 ? buildMetaVM3 : buildMetaVM)(cfg, { engine, locale: localeOf(req), authenticated });
    // Public envelopes also omit source inventory; no shared last-good private VM cache.
    let projected=req.apiVersion===2?require('./runtime-projection').projectLegacy(data,'meta'):data;
    if(httpProjection&&authenticated)projected=httpProjection.data(req,projected,{name:'meta'});
    const cohort=httpProjection&&authenticated?store.rbac.fingerprint(req.user.id):'owner';
    const checked = vms[req.apiVersion].check('meta',projected,authenticated?'route:meta:'+cohort:'route:meta:public');
    res.json(okBody(checked, { engine: authenticated&&(!httpProjection||httpProjection.mayExposeSources(req)) ? engine : null, now: now() }));
  });
  r.get('/me', authed, (req, res) => ok(res, buildMeVM({ session: req.session, cfg, engine, ownerName: () => (store && store.owner ? store.owner.name : null) }), null, 'me'));

  r.get('/design-system/access', authed, (req, res) => {
    const isOwner = require('../design-system-access').isOwnerSession(auth.sessionOf(req), { store, ownerEmail: cfg.loginEmail });
    if (!isOwner) throw new ApiError('not_found');
    res.json(okBody({ allowed: true }, { now: now() }));
  });

  r.get('/orchestrators', authed, (req, res) => {
    if (req.apiVersion !== 3) throw new ApiError('not_found');
    const topic = topics.current(sourceTopic(req, 'orchestrators'), 3);
    ok(res, topic.vm, { id: topic.id, rev: topic.rev }, 'orchestrators');
  });
  r.get('/teams', authed, (req, res) => {
    if (req.apiVersion !== 3) throw new ApiError('not_found');
    const topic = topics.current(sourceTopic(req, 'teams'), 3);
    ok(res, topic.vm, { id: topic.id, rev: topic.rev }, 'teams');
  });

  r.get('/views/health', authed, (req, res) => { const t = topics.current('health', req.apiVersion); ok(res, t.vm, { id: t.id, rev: t.rev }); });

  r.put('/health/issues/:id/muted', authed, guard('store'), (req, res) => {
    noExtra(req.body, ['muted']);
    if (typeof (req.body || {}).muted !== 'boolean') throw invalid('muted', 'invalid');
    let state;
    try { state = engine.setIssueMuted(req.params.id, req.body.muted); } catch (e) { if (e.code === 'error-not-mutable') throw invalid(null, 'error-not-mutable'); throw e; }
    if (state == null) throw new ApiError('not_found');
    if (store) store.flushQuarantine();
    topics.invalidate('health');
    ok(res, { ok: true, result: { state }, revision: null, vm: null });
  });

  r.post('/health/checks/:id/fix', authed, guard('store'), async (req, res, next) => {
    try {
      noExtra(req.body, []);
      const check = engine.healthChecks?.().find(row => row.id === req.params.id);
      if (!check || !check.active || check.remedy !== 'one-click') throw new ApiError('not_found');
      const result = await engine.runHealthRemedy(check.id);
      topics.invalidate('health');
      ok(res, { ok: true, result: { id: check.id, ok: result.ok, category: result.category || null }, revision: null, vm: null });
    } catch (error) { next(error); }
  });
  r.post('/health/fix-all', authed, guard('store'), async (req, res, next) => {
    try {
      noExtra(req.body, []);
      const checks = (engine.healthChecks?.() || []).filter(row => row.active && ['auto', 'one-click'].includes(row.remedy));
      const results = [];
      for (const check of checks) {
        const result = await engine.runHealthRemedy(check.id, { automatic: check.remedy === 'auto' });
        results.push({ id: check.id, ok: result.ok, category: result.category || null });
      }
      topics.invalidate('health');
      ok(res, { ok: true, result: { attempted: results.length, results }, revision: null, vm: null });
    } catch (error) { next(error); }
  });

  const views = mountViews({ configuredAgents: cfg.agentNames || {}, r, engine, topics, store, runtime, enrichment, orchestratorTeams,
    officePrincipalFor: key => sourceScopes.get(key)?.principal || null,
  officeTopicFor: req => (orchestratorTeams?.hasHerdr || orchestratorTeams?.hasTeamStore || orchestratorTeams?.detected) ? 'office-scope:' + sourceTopic(req, 'office').slice('office:'.length) : 'office',
    authed, ok, now, sessionsReadable, isSubscribed: (id,version) => version ? hubs[version].isSubscribed(id) : hubs[2].isSubscribed(id) || hubs[3].isSubscribed(id) });
  const commands = mountCommands({ r, engine, topics, store, runtime, authed, guard, ok, views, now, log });
  // S14b: the office layout and the UI prefs (store)
  const office = store ? mountOfficeLayout({ r, store, topics, authed, guard, ok, now, actorOf: views.actorOf, timeZone: () => cfg.timeZone,
    actorRefOf: req => require('../../security/request-actor').requestActor(req,store) }) : null;
  // S7d: the screenshot capturer for project images (null without a browser or a public https origin)
  const capturer = cfg.capture === false ? null : createCapturer({ chromeBin: findChrome(), dataDir: cfg.dataDir,
    publicUrls: createPublicUrls({ publicUrl: cfg.publicUrl, publicApiBase: cfg.publicApiBase }), log });
  r.get('/shots/:file', authed, (req, res) => {
    const f = shotPath(cfg.dataDir, req.params.file);
    if (!f) throw new ApiError('not_found');
    res.setHeader('Cache-Control', 'private, max-age=86400'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('png').sendFile(f);
  });
  // architect-57: the project threads (comments, agent replies, the summary request), on the projects module
  const dispatchAuthority=enforceAuthorization?require('../../security/dispatch-authority').createDispatchAuthority({store,now}):null;
  const thread = store && store.comments ? createProjectThread({ store, engine, runtime, topics, cfg, log, now, dispatchAuthority }) : null;
  const projects = store ? mountProjects(r, { capturer, store, engine, topics, cfg, runtime, authed, guard, ok, enrichment, log, thread, enforceAuthorization }) : null;
  if (thread) { thread.attach(projects); thread.mount(r, { authed, guard, ok }); }

  r.post('/stream/ticket',authed,(req,res)=>{
    if(!cfg.splitAuthEnabled||!store?.humanTokens||!cfg.apiPublicUrl)throw new ApiError('not_found');
    const body=req.body;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>k!=='topics')||!Array.isArray(body.topics)||body.topics.length<1||body.topics.length>32)throw invalid(null,'invalid-body');
    const session=auth.sessionOf(req),policy=streamPolicies[req.apiVersion];
    if(!policy||!session?.familyId||!session.origin||!session.audience||req.headers.origin!==session.origin)throw new ApiError('unauthorized');
    const binding=policy.capture(req),ids=[];
    for(const raw of body.topics) {
      const topic=topics.of(req.apiVersion).parse(raw);
      if(!topic||topic.id!==raw)throw invalid('topics','invalid-topic');
      if(!policy.can(binding,topic.id))throw new ApiError('forbidden',{details:[{issue:'permission-denied'}]});
      if(!ids.includes(topic.id))ids.push(topic.id);
    }
    const issued=store.humanTokens.createStreamTicket({userId:session.userId,familyId:session.familyId,sessionId:session.sid,origin:session.origin,audience:session.audience,
      topics:ids,fingerprint:binding.fingerprint,sessionExpiresAt:session.exp});
    if(!issued.ok){if(issued.issue==='limited')throw new ApiError('rate_limited');throw new ApiError('unauthorized');}
    const streamUrl=cfg.apiPublicUrl+'/api/v'+req.apiVersion+'/stream?ticket='+encodeURIComponent(issued.ticket);
    res.json(okBody({ticket:issued.ticket,expiresAt:issued.expiresAt,streamUrl}));
  });
  r.get('/stream', authed, (req, res) => hubOf(req).open(req, res));
  r.post('/stream/:streamId/topics', authed, (req, res) => hubOf(req).changeTopics(req, res));
  r.post('/stream/:streamId/resync', authed, (req, res) => hubOf(req).resync(req, res));

  r.use(except('api.notFound',(req, res, next) => next(new ApiError('not_found'))));
  if(httpProjection)r.use(except('api.projectionError',httpProjection.error));
  r.use(except('api.error',errorMiddleware(log)));
  if(enforceAuthorization)require('../../security/route-policy').assertRouteCoverage(r,store.registry);
  app.use(['/api/v2', '/api/v3'], r);
  app.use(['/api/v2', '/api/v3'], except('api.error',errorMiddleware(log)));   // errors raised before the router (body parsing)
  return { router:r, reauthentication, topics, hub, hubs, series, projects, thread, views, commands, office,
    close: () => { reauthentication?.close();engine.removeListener('live', onOfficeLive); clearInterval(sampler); views.close(); if (thread) thread.close(); if (office) office.close(); externalAccess?.close(); settings?.close(); topics.close(); hubs[2].closeAll(); hubs[3].closeAll(); if (projects) projects.close(); offOrchestratorTeams?.(); orchestratorTeams?.close?.(); } };
}

module.exports = { mountV2, writeClassOf, WRITE_CLASSES, apiVersionOf };
