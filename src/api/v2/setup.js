'use strict';
/*
 * G4 first-run setup (api.md §5.7, ADR-001 §5). Mounted in BOTH modes:
 *   - setup mode (nothing configured): state 'open'; a one-time code is printed to the server log at boot;
 *   - configured (by the files OR by env, PM on architect-33): state 'locked' forever, every write 403 `{issue:'locked'}`;
 *   - a read-only instance: state 'readonly', every write 403 `readonly`.
 * Write-only secrets: runtime.token and owner.password are never echoed, logged or audited. A token given to `check`
 * is kept in memory (for `discover` and `PUT`) until expiration, publication or process exit.
 */
const crypto = require('crypto');
const { ApiError, invalid } = require('./errors');
const { okBody } = require('./envelope');
const { hashPassword } = require('../../security/password');
const { createLoginThrottle } = require('../../security/login-throttle');
const IC = require('../../instance-config');
const path = require('path'), fs = require('fs');
const { ADAPTER_IDS, adapterById } = require('../../adapters');
const { createSetupIntegrations } = require('../../ops/setup-integrations');
const { networkConfig, createNetworkGuide, listener } = require('../../ops/onboarding-network');

const SETUP_CODE_TTL = 30 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L
function newSetupCode() {
  const pick = () => ALPHABET[crypto.randomInt(ALPHABET.length)];
  const part = () => Array.from({ length: 4 }, pick).join('');
  return `AO-${part()}-${part()}`;                       // 8 symbols of 31: ~40 bits, and throttled
}
const sameCode = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const LOCALES = ['fr', 'en'];
// G6: 'demo' needs no connection (no fields, no gateway): a synthesised team, read-only
const ADAPTERS = ADAPTER_IDS.map(id => ({ id, ...Object.fromEntries(['name', 'fields', 'defaultGatewayUrl', 'connect'].map(k => [k, adapterById(id).setup[k]])) }));
const PASSWORD_MIN = 12;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);

/**
 * @param {object} o
 * @param {object} o.env          the process env (the setup state reads the login variables from it)
 * @param {object} o.files        readInstanceConfig() result at boot
 * @param {(o) => Promise} o.probe  probeGateway (the runtime adapter's one-shot connection test)
 * @param {object} o.paths        adapter identity paths for the probe (identityPath, stateDbPath)
 * @param {(m) => void} o.log
 * @param {() => void} o.onConfigured  called once the PUT response has been sent (the server switches app)
 */
function createSetup({ env, files, probe, paths = {}, dataDir = null, log = () => {}, onConfigured = () => {}, throttle = createLoginThrottle(),
  now = () => Number(process.hrtime.bigint() / 1000000n), derivePassword = hashPassword,
  instance = env?.AO_ENV || 'dev', storeFactory = null, detect = null, networkGuide = null, recovery = false,
  suggestedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', engine = null } = {}) {
  let state = recovery && env.PORTAL_READONLY !== '1' ? 'open' : IC.setupState(env, files);
  let code = state === 'open' ? newSetupCode() : null;
  const expiresAt = now() + SETUP_CODE_TTL;
  let expired = false;
  let setupStore = null, detections = null;
  const store = (ownerName) => {
    if (!setupStore) setupStore = storeFactory ? storeFactory(ownerName) : require('../../store').openStore({ dir: dataDir, instance, ownerName, seedOwner: false });
    return setupStore;
  };
  // Resume only an existing store; an untouched first-run GET still creates no database.
  if (state === 'open' && dataDir && fs.existsSync(path.join(dataDir, 'agent-office.sqlite'))) store();
  const ownerAccount = () => setupStore?.users.owner() || null;
  const integration = createSetupIntegrations({ env, paths, dataDir, now, beforeMutation: () => assertActive() });
  const network = networkGuide || createNetworkGuide({ env });
  let remembered = null;                       // { gatewayUrl, token } from the last check with a token
  if (files.config && !files.secrets && !IC.isConfigured(IC.effectiveEnv(env, files))) log('Agent Office: setup is locked because secrets.json is missing. Restore the matching private secrets file and restart locally.');
  if (code) log('Agent Office: first-run setup is open. One-time setup code: ' + code + ' (valid for 30 minutes; restart locally for a fresh code).');

  const expiryTimer = code ? setTimeout(expireIfDue, SETUP_CODE_TTL) : null;
  expiryTimer?.unref();
  const vm = () => { expireIfDue(); const value = ({
    state, configured: state === 'locked',
    lockReason: state !== 'open' && files.config && !files.secrets && !IC.isConfigured(IC.effectiveEnv(env, files)) ? 'missing-secrets' : null,
    adapters: ADAPTERS.map((a) => Object.assign({}, a, { fields: a.fields.slice() })),
    draft: state !== 'open' ? null : {
      instance: { name: '', locale: 'fr', timeZone: null },
      owner: { displayName: '', email: '', passwordSet: !!ownerAccount() },
      runtime: { adapter: ADAPTERS[0].id, gatewayUrl: (remembered && remembered.gatewayUrl) || ADAPTERS[0].defaultGatewayUrl, tokenSet: !!(remembered && remembered.token) },
    },
    network: listener(env),
    suggestedTimeZone, locales: LOCALES.slice(),
    // architect-56: what setup can install into the runtime's agents (opt-out: integrations.projet false in the PUT)
    integrations: [{ id: 'projet', adapters: ADAPTER_IDS.filter(id => !!adapterById(id).projectTag), default: true }],
  });
    const checked = require('../../schema').validate(require('./vm/schemas').SetupVM, value);
    if (!checked.ok) throw new Error('invalid setup VM: ' + checked.issues.map(i => i.path).join(', '));
    return value;
  };
  // architect-56 · the project tag, installed for the primary agent right after the configuration is published
  // The adapter owns installation. Best effort: setup never fails because of it; the result says what happened.
  const PT = (id) => adapterById(id).projectTag?.();
  const integrationAgents = (id) => adapterById(id).setup.integrationAgents?.({ paths, agents: detections?.find(d => d.runtime === id)?.agents || [] }) || Promise.resolve([]);
  async function installProjectTag(runtimeId, agentId, locale) {
    if (!PT(runtimeId)) return { status: 'skipped', reason: 'adapter' };
    try {
      const I = PT(runtimeId);
      const agents = await integrationAgents(runtimeId);
      if (expired || now() >= expiresAt) return { status: 'skipped', reason: 'setup-expired' };
      const agent = agents && agents.find((a) => a.id === agentId);
      if (!agent) return { status: 'skipped', reason: 'agent-not-found' };
      const r = I.install(agent, { locale, backupDir: dataDir ? require('path').join(dataDir, 'integrations', 'backups') : null });
      log('Agent Office: project tag for agent ' + agentId + ': ' + r.status + (r.done && r.done.length ? ' (' + r.done.join(', ') + ')' : ''));
      return r.status === 'conflict' ? { status: 'conflict', reason: r.refused } : { status: r.status };
    } catch (e) { log('Agent Office: project tag install failed (' + (e.code || 'error') + ')'); return { status: 'failed', reason: 'error' }; }
  }
  async function projectTagStatus(runtimeId, agentIds, locale) {
    try {
      const I = PT(runtimeId);
      const agents = I ? await integrationAgents(runtimeId) : null;
      return Object.fromEntries(agentIds.map((id) => { const a = agents && agents.find((x) => x.id === id); return [id, a ? I.inspect(a, { locale }).status : 'unknown']; }));
    } catch (_) { return Object.fromEntries(agentIds.map((id) => [id, 'unknown'])); }
  }

  // R21-04: requests still being answered; the handoff to the configured app waits until none is (a losing PUT
  // must get its 403 before connections close)
  let inflight = 0; const idleWaiters = [];
  const track = (res) => {
    inflight++;
    let done = false;
    const end = () => { if (done) return; done = true; inflight--; if (inflight === 0) for (const f of idleWaiters.splice(0)) setImmediate(f); };
    res.on('finish', end); res.on('close', end);
  };
  const whenIdle = (f) => { if (inflight === 0) setImmediate(f); else idleWaiters.push(f); };

  function expireIfDue() {
    if (state === 'open' && (expired || now() >= expiresAt)) {
      expired = true; code = null; remembered = null; detections = null; integration.invalidate();
    }
    return expired;
  }
  function assertActive() {
    if (state === 'readonly') throw new ApiError('readonly');
    if (state !== 'open') throw new ApiError('forbidden', { message: 'L’installation est déjà faite.', details: [{ issue: 'locked' }] });
    if (expireIfDue()) {
      throw new ApiError('forbidden', { details: [{ field: 'setupCode', issue: 'expired' }] });
    }
  }

  // every write: the state, then the code (throttled like the login: a wrong code is a failed attempt; R21-05: the
  // throttle is the process's one, shared with the login)
  function admit(req, res) {
    assertActive();
    const ip = req.ip || 'unknown';
    const gate = throttle.check(ip);
    if (!gate.ok) { res.setHeader('Retry-After', String(gate.retryAfterSec)); throw new ApiError('rate_limited'); }
    const b = req.body;
    if (!isObj(b) || !sameCode(b.setupCode, code)) {
      throttle.failure(ip);
      throw new ApiError('forbidden', { message: 'Code d’installation invalide.', details: [{ field: 'setupCode', issue: 'invalid' }] });
    }
    return b;
  }
  function runtimeOf(b) {
    const r = b.runtime;
    if (!isObj(r)) throw invalid('runtime', 'required');
    if (!ADAPTERS.some((a) => a.id === r.adapter && a.connect)) throw invalid('runtime.adapter', 'invalid');
    if (!adapterById(r.adapter).setup.fields.length) {
      for (const k of Object.keys(r)) if (k !== 'adapter') throw invalid('runtime.' + k, 'unexpected-field');
      return { adapter: r.adapter, gatewayUrl: null, token: null, given: false };
    }
    const gatewayUrl = typeof r.gatewayUrl === 'string' ? r.gatewayUrl.trim() : '';
    if (!IC.GATEWAY_URL.test(gatewayUrl)) throw invalid('runtime.gatewayUrl', 'invalid');
    if (r.token != null && (typeof r.token !== 'string' || r.token.length > 4096)) throw invalid('runtime.token', 'invalid');
    const token = r.token || (remembered && remembered.adapter === r.adapter && remembered.gatewayUrl === gatewayUrl ? remembered.token : null) || detections?.find(d => d.runtime === r.adapter && d.connection?.gatewayUrl === gatewayUrl)?.secret || adapterById(r.adapter).setup.credential?.({ env, gatewayUrl }) || null;
    return { adapter: r.adapter, gatewayUrl, token, given: !!r.token };
  }
  const tryProbe = (rt) => (!adapterById(rt.adapter).setup.fields.length ? Promise.resolve({ status: 'connected', protocol: null, latencyMs: 0, gw: null })
    : adapterById(rt.adapter).setup.fields.includes('token') && !rt.token ? Promise.resolve({ status: 'unauthorized', protocol: null, latencyMs: 0, gw: null })
    : (probe || adapterById(rt.adapter).setup.probe)({ url: rt.gatewayUrl, token: rt.token, identityPath: paths.identityPath, stateDbPath: paths.stateDbPath }));
  const localAgents = (id) => adapterById(id).setup.agents();

  const ok = (res, result) => res.json(okBody({ ok: true, result, revision: null, vm: null }, { engine }));

  function mount(r) {
    r.get('/setup/catalog', (req, res, next) => { if (state !== 'open') return next(new ApiError(state === 'readonly' ? 'readonly' : 'forbidden', { details: [{ issue: 'locked' }] })); res.json(okBody(require('./vm/office').officeDefaults().manifest, { engine })); });
    r.get('/setup', (req, res) => res.json(okBody(vm(), { engine })));

    r.post('/setup/resume', (req, res, next) => {
      try {
        admit(req, res);
        ok(res, { owner: ownerAccount() ? { displayName: setupStore.persons.ensureOwner().name, email: ownerAccount().email, passwordSet: true } : null });
      } catch (e) { next(e); }
    });

    r.post('/setup/owner', async (req, res, next) => {
      track(res);
      try {
        const b = admit(req, res), o = b.owner || {};
        const displayName = text(o.displayName, 80), email = text(o.email, 254)?.toLowerCase();
        if (!displayName) throw invalid('owner.displayName', 'required');
        if (!IC.EMAIL.test(email || '')) throw invalid('owner.email', 'invalid');
        let passwordHash = null;
        if (!ownerAccount() || o.password) {
          if (typeof o.password !== 'string' || o.password.length < PASSWORD_MIN || o.password.length > 1024) throw invalid('owner.password', 'too-short');
          if (o.password !== o.passwordConfirmation) throw invalid('owner.passwordConfirmation', 'mismatch');
          passwordHash = await derivePassword(o.password);
        }
        assertActive();
        store().setup.amendOwner({ displayName, email, passwordHash, layout: require('../../ops/setup-layout').setupLayout({ primary: null, looks: {} }) });
        ok(res, { created: true, owner: { displayName, email, passwordSet: true } });
      } catch (e) { next(e); }
    });
    r.post('/setup/detect', async (req, res, next) => {
      track(res);
      try {
        admit(req, res);
        const found = await (detect || require('../../adapters').detectRuntimes)({ env });
        assertActive(); detections = found;
        const eligible = detections.filter(d => d.found && ADAPTERS.some(a => a.id === d.runtime && a.connect));
        const chosen = eligible.length === 1 ? eligible[0] : null;
        if (chosen?.secret) remembered = { adapter: chosen.runtime, gatewayUrl: chosen.connection.gatewayUrl, token: chosen.secret };
        // Secrets and workspace paths are adapter-private; only plans expose confirmed target files.
        ok(res, { runtimes: detections.map(d => ({ runtime: d.runtime, name: d.name, found: d.found, confidence: d.confidence,
          supported: ADAPTERS.some(a => a.id === d.runtime && a.connect), connection: d.connection ? { gatewayUrl: d.connection.gatewayUrl, tokenSet: !!d.connection.tokenSet } : null,
          agents: d.agents.map(a => ({ id: a.id, name: a.name, nameSource: a.nameSource, isPrimary: !!a.isPrimary, model: a.model || null })) })), selected: chosen?.runtime || null });
      } catch (e) { next(e); }
    });
    r.post('/setup/integrations/plan', async (req, res, next) => {
      track(res);
      try {
        const b = admit(req, res), rt = runtimeOf(b);
        const found = detections?.find(d => d.runtime === rt.adapter)?.agents || [];
        const agents = found.length ? found : !adapterById(rt.adapter).setup.fields.length ? localAgents(rt.adapter) : [];
        const result = await integration.plan({ runtime: rt.adapter, agents, locale: b.locale || 'fr' });
        assertActive(); ok(res, result);
      } catch (e) { next(e instanceof ApiError ? e : invalid('integrations', e.code || 'unavailable')); }
    });
    r.post('/setup/integrations/apply', (req, res, next) => {
      track(res);
      try { const b = admit(req, res); ok(res, integration.apply(b)); }
      catch (e) { next(['EPLAN', 'ECONFIRM', 'ESTALEPLAN', 'EUNSAFEPATH', 'EROLLBACK', 'ECONFLICT'].includes(e.code) ? invalid('integrations', e.code) : e); }
    });
    r.post('/setup/network', async (req, res, next) => {
      track(res);
      try {
        const b = admit(req, res);
        let result;
        try { result = b.action === 'probe' ? await network.probe(b.url) : await network.inspect(b); }
        catch { throw invalid('network', 'invalid'); }
        assertActive(); ok(res, result);
      } catch (e) { next(e); }
    });

    r.post('/setup/check', async (req, res, next) => {
      track(res);
      try {
        const rt = runtimeOf(admit(req, res));
        const p = await tryProbe(rt);
        if (p.gw) p.gw.close();
        assertActive();
        if (rt.given && p.status === 'connected') remembered = { adapter: rt.adapter, gatewayUrl: rt.gatewayUrl, token: rt.token };
        ok(res, { ok: p.status === 'connected', status: p.status, protocol: p.protocol, latencyMs: p.latencyMs });
      } catch (e) { next(e); }
    });

    r.post('/setup/discover', async (req, res, next) => {
      track(res);
      try {
        const rt = runtimeOf(admit(req, res));
        const p = await tryProbe(rt);
        try { assertActive(); } catch (e) { if (p.gw) p.gw.close(); throw e; }
        if (p.status !== 'connected') throw new ApiError('upstream_failed', { details: [{ issue: p.status }] });
        let agents;
        try { agents = await adapterById(rt.adapter).setup.discover({ gw: p.gw, detected: detections?.find(d => d.runtime === rt.adapter)?.agents || [] }); }
        catch (_) { throw new ApiError('upstream_failed', { details: [{ issue: 'agents-list' }] }); }
        finally { p.gw?.close(); }
        assertActive();
        // architect-56: is the project tag already in each agent's workspace (installed | outdated | absent | conflict | unknown)
        const tags = await projectTagStatus(rt.adapter, agents.map((a) => a.id), 'fr');
        assertActive();
        for (const a of agents) {
          a.projectTag = tags[a.id] || 'unknown';
        }
        ok(res, { agents });
      } catch (e) { next(e); }
    });

    r.put('/setup', async (req, res, next) => {
      track(res);
      try {
        const b = admit(req, res);
        const issues = [];
        const bad = (field, issue) => issues.push({ field, issue });
        const inst = isObj(b.instance) ? b.instance : {}, owner = isObj(b.owner) ? b.owner : {}, agents = isObj(b.agents) ? b.agents : {};
        const name = text(inst.name, 80); if (!name) bad('instance.name', inst.name == null ? 'required' : 'invalid');
        if (!LOCALES.includes(inst.locale)) bad('instance.locale', 'invalid');
        if (typeof inst.timeZone !== 'string' || !IC.validZone(inst.timeZone)) bad('instance.timeZone', 'invalid');
        const displayName = text(owner.displayName, 80); if (!displayName) bad('owner.displayName', owner.displayName == null ? 'required' : 'invalid');
        const email = typeof owner.email === 'string' ? owner.email.trim().toLowerCase() : '';
        if (!IC.EMAIL.test(email)) bad('owner.email', 'invalid');
        if (!ownerAccount() && (typeof owner.password !== 'string' || owner.password.length < PASSWORD_MIN || owner.password.length > 1024)) bad('owner.password', owner.password == null ? 'required' : 'too-short');
        let rt = null;
        try { rt = runtimeOf(b); } catch (e) { if (e.details) issues.push(...e.details); else throw e; }
        if (rt && adapterById(rt.adapter).setup.fields.includes('token') && !rt.token) bad('runtime.token', 'required');
        if (typeof agents.primary !== 'string' || !IC.AGENT_ID.test(agents.primary)) bad('agents.primary', agents.primary == null ? 'required' : 'invalid');
        const looks = agents.looks == null ? {} : agents.looks;
        const integ = b.integrations == null ? {} : b.integrations;
        if (!isObj(integ) || Object.keys(integ).some((k) => !['projet', 'reviewed'].includes(k)) || (integ.projet != null && typeof integ.projet !== 'boolean')) bad('integrations', 'invalid');
        if (integ.reviewed != null && integ.reviewed !== true) bad('integrations.reviewed', 'invalid');
        const projet = integ.projet !== false;   // opt-out
        if (!isObj(looks) || Object.keys(looks).some((k) => !IC.AGENT_ID.test(k))) bad('agents.looks', 'invalid');
        const names = agents.names;
        if (names != null && (!isObj(names) || !Object.keys(names).length || Object.entries(names).some(([id, n]) => !IC.AGENT_ID.test(id) || !text(n, 80)) || !names[agents.primary])) bad('agents.names', 'invalid');
        if (ownerAccount() && (ownerAccount().email !== email || setupStore.persons.ensureOwner().name !== displayName)) bad('owner', 'owner-exists');
        let netConfig;
        if (b.network != null) { try { netConfig = networkConfig(b.network); } catch { bad('network', 'invalid'); } }
        let initialLayout;
        if (ownerAccount()) { try { initialLayout = require('../../ops/setup-layout').setupLayout({ primary: agents.primary, looks, names: names || {} }); } catch { bad('agents.looks', 'invalid'); } }
        if (issues.length) throw new ApiError('validation_failed', { details: issues });
        const config = { version: ownerAccount() ? IC.VERSION : 1, instance: { name, locale: inst.locale, timeZone: inst.timeZone }, owner: { displayName, email, ...(ownerAccount() ? { authSource: 'database' } : {}) },
          runtime: adapterById(rt.adapter).setup.config(rt), agents: { primary: agents.primary, looks, ...(names ? { names: { [rt.adapter]: names } } : {}) },
          ...(netConfig ? { network: netConfig } : {}),
          integrations: { projet } };
        const secrets = { version: config.version, sessionSecret: crypto.randomBytes(48).toString('base64url'),
          ...(ownerAccount() ? {} : { passwordHash: await derivePassword(owner.password) }), runtimeToken: rt.token };
        assertActive();   // a concurrent PUT or elapsed expiry can never publish after the await
        // Durably seed the DB before publishing config.json, the filesystem commit marker.
        // A failed publication can be retried with changed looks while setup is still open.
        if (initialLayout) setupStore.setup.prepare(config, initialLayout);
        try {
          IC.writeInstanceConfig(files.paths, config, secrets, { replace: recovery });
          if (initialLayout) setupStore.setup.configured();
        } catch (e) {
          if (e instanceof IC.ConfigError) throw new ApiError('validation_failed', { details: [{ field: 'agents.looks', issue: 'invalid' }] });
          if (e.code === 'EEXIST') { state = 'locked'; code = null; throw new ApiError('forbidden', { details: [{ issue: 'locked' }] }); }
          if (e.code === 'EBUSY') throw new ApiError('conflict', { details: [{ issue: 'publishing' }] });   // R21-03: another process is publishing
          log('Agent Office: setup could not write the configuration (' + (e.code || 'error') + ')');
          throw new ApiError('upstream_unavailable', { details: [{ issue: 'write-failed' }] });
        }
        state = 'locked'; code = null; remembered = null;
        throttle.success(req.ip || 'unknown');
        log('Agent Office: setup complete; configuration written to ' + files.paths.file);
        const projetResult = !PT(rt.adapter) ? { status: 'skipped', reason: 'adapter' } : !projet ? { status: 'skipped', reason: 'opted-out' }
          : integ.reviewed ? { status: 'skipped', reason: 'reviewed' } : await installProjectTag(rt.adapter, agents.primary, inst.locale);
        res.on('finish', () => whenIdle(onConfigured));   // R21-04: after every in-flight setup request has answered
        ok(res, { configured: true, integrations: { projet: projetResult } });
      } catch (e) { next(e); }
    });
  }

  return { mount, close: () => { clearTimeout(expiryTimer); expired = true; code = null; remembered = null; detections = null; integration.invalidate(); if (setupStore) { setupStore.close(); setupStore = null; } }, state: () => state, vm, _code: () => { expireIfDue(); return code; } };
}

module.exports = { createSetup, newSetupCode, PASSWORD_MIN, SETUP_CODE_TTL };
