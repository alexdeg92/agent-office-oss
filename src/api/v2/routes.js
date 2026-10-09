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
const { mountViews } = require('./views');
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
  { method: 'POST', re: /^\/api\/v[23]\/stream\/[^/]+\/(topics|resync)\/?$/i, cls: 'transport' },
  { method: 'PUT', re: /^\/api\/v[23]\/health\/issues\/[^/]+\/muted\/?$/i, cls: 'store' },
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
function mountV2(app, { auth, engine, cfg, store, runtime, enrichment = null, setup = null, log = () => {}, now = () => Date.now() }) {
  const series = createHealthSeries({ engine, now });
  // PM audit (B): runtime VM validation; throws on test/dev instances (or AO_STRICT_VM=1), falls back to the last good
  // VM with a quarantine issue elsewhere
  // the VM schemas' field names may appear in vm.invalid issue paths (the quarantine's privacy rule: schema names only)
  if (engine.declareFields) engine.declareFields(require('../../schema').declaredNames(Object.values(require('./vm/schemas').VM_SCHEMAS).concat(Object.values(require('./vm/schemas').VM_SCHEMAS_V3))));
  const vmMode = cfg.strictVm || cfg.instance === 'test' || cfg.instance === 'dev' ? 'throw' : 'fallback';
  const report = (i) => { try { engine.quarantine.record(i); } catch (_) { /* never breaks a response */ } };
  const vms = { 2: createVmCheck({ mode: vmMode, report, version: 2 }), 3: createVmCheck({ mode: vmMode, report, version: 3 }) };
  const topics = createVersionedTopics({ 2: { P: project2x, check: vms[2].check }, 3: { P: project3x, check: vms[3].check } });
  topics.define('health', { build: (_, P) => buildHealthVM({ engine, series, P }) });
  const systemState = () => ({ gateway: engine.gateway().connected ? 'up' : 'down', capabilities: capabilitiesOf(cfg) });
  const hubs = {
    2: createStreamHub({ topics: topics.of(2), engine, systemState, contractVersion: CONTRACT_VERSION, modelVersion: MODEL_VERSION, now, buildId: () => readBuild().buildId }),
    3: createStreamHub({ topics: topics.of(3), engine, systemState, contractVersion: CONTRACT_VERSION_V3, modelVersion: MODEL_VERSION, now, buildId: () => readBuild().buildId }),
  };
  const hub = hubs[2];
  const hubOf = (req) => hubs[req.apiVersion] || hubs[2];

  // data changes → topics (coalesced); connection changes → system frames
  engine.on('ingested', () => topics.invalidate());
  engine.on('change', (c) => { topics.invalidate(); if (c && c.channel === 'gateway.connection') { hubs[2].broadcastSystem(); hubs[3].broadcastSystem(); } });
  const onOfficeLive = e => { for (const P of [project2x, project3x]) { const frame = officeSignalFrame(e, P); if (frame) hubs[P.version].broadcastOffice(frame); } };
  engine.on('live', onOfficeLive);
  const sampler = setInterval(() => { series.sample(); topics.invalidate('health'); }, every(60000));
  if (sampler.unref) sampler.unref();
  series.sample();
  auth.onRevoke((s) => { hubs[2].revokeSession(s); hubs[3].revokeSession(s); });

  const r = express.Router();
  r.use((req, res, next) => { req.apiVersion = apiVersionOf(req); res.setHeader('Cache-Control', 'no-store'); next(); });
  // S7d: an allowed token request (the gate set req.principal) is authenticated as the agent, never as a cookie session
  const authed = (req, res, next) => { if (req.principal) return next(); const s = auth.sessionOf(req); if (!s) return next(new ApiError('unauthorized')); req.session = s; next(); };
  const guard = (cls) => (req, res, next) => {
    const caps = capabilitiesOf(cfg);
    if ((cls === 'store' && !caps.storeWrites) || (cls === 'openclaw' && !caps.openclawWrites)) return next(new ApiError('readonly'));
    next();
  };
  // `name`: the VM checked for a response that isn't a topic (topics are checked when built)
  // G5: the response's contract version is its request's (res.req.apiVersion)
  const ok = (res, data, topic, name) => { const v = (res.req && res.req.apiVersion) || 2;
    res.json(okBody(name ? vms[v].check(name, data, 'route:' + name) : data, { engine, now: now(), topic })); };
  const noExtra = (body, allowed) => { for (const k of Object.keys(body || {})) if (!allowed.includes(k)) throw invalid(k, 'unexpected-field'); };

  const localeOf = (req) => resolveLocale({ explicit: typeof req.query.locale === 'string' ? req.query.locale : null, pref: store && store.office ? store.office.prefs().locale : null, acceptLanguage: req.headers['accept-language'], instance: cfg.instanceLocale });
  // G4 (api.md §5.7): on a configured instance the setup routes only say 'locked' (or 'readonly')
  if (setup) setup.mount(r);
  r.get('/meta', (req, res) => { res.setHeader('Vary', 'Accept-Language'); ok(res, (req.apiVersion === 3 ? buildMetaVM3 : buildMetaVM)(cfg, { engine, locale: localeOf(req) }), null, 'meta'); });
  r.get('/me', authed, (req, res) => ok(res, buildMeVM({ session: req.session, cfg, engine, ownerName: () => (store && store.owner ? store.owner.name : null) }), null, 'me'));

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

  const views = mountViews({ configuredAgents: cfg.agentNames || {}, r, engine, topics, store, runtime, enrichment, authed, ok, now, isSubscribed: (id) => hubs[2].isSubscribed(id) || hubs[3].isSubscribed(id) });
  const commands = mountCommands({ r, engine, topics, store, runtime, authed, guard, ok, views, now, log });
  // S14b: the office layout and the UI prefs (store)
  const office = store ? mountOfficeLayout({ r, store, topics, authed, guard, ok, now, actorOf: views.actorOf, timeZone: cfg.timeZone,
    actorRefOf: () => ({ kind: 'human', personId: store.owner.id }) }) : null;
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
  const thread = store && store.comments ? createProjectThread({ store, engine, runtime, topics, cfg, log, now }) : null;
  const projects = store ? mountProjects(r, { capturer, store, engine, topics, cfg, runtime, authed, guard, ok, enrichment, log, thread }) : null;
  if (thread) { thread.attach(projects); thread.mount(r, { authed, guard, ok }); }

  r.get('/stream', authed, (req, res) => hubOf(req).open(req, res));
  r.post('/stream/:streamId/topics', authed, (req, res) => hubOf(req).changeTopics(req, res));
  r.post('/stream/:streamId/resync', authed, (req, res) => hubOf(req).resync(req, res));

  r.use((req, res, next) => next(new ApiError('not_found')));
  r.use(errorMiddleware(log));
  app.use(['/api/v2', '/api/v3'], r);
  app.use(['/api/v2', '/api/v3'], errorMiddleware(log));   // errors raised before the router (body parsing)
  return { topics, hub, hubs, series, projects, thread, views, commands, office,
    close: () => { engine.removeListener('live', onOfficeLive); clearInterval(sampler); views.close(); if (thread) thread.close(); if (office) office.close(); topics.close(); hubs[2].closeAll(); hubs[3].closeAll(); if (projects) projects.close(); } };
}

module.exports = { mountV2, writeClassOf, WRITE_CLASSES, apiVersionOf };
