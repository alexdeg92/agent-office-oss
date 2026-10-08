'use strict';
/*
 * G4 first-run setup (api.md §5.7, ADR-001 §5). Mounted in BOTH modes:
 *   - setup mode (nothing configured): state 'open'; a one-time code is printed to the server log at boot;
 *   - configured (by the files OR by env, PM on architect-33): state 'locked' forever, every write 403 `{issue:'locked'}`;
 *   - a read-only instance: state 'readonly', every write 403 `readonly`.
 * Write-only secrets: runtime.token and owner.password are never echoed, logged or audited. A token given to `check`
 * is kept in memory (for `discover` and `PUT`) until the process ends.
 */
const crypto = require('crypto');
const { ApiError, invalid } = require('./errors');
const { okBody } = require('./envelope');
const { hashPassword } = require('../../security/password');
const { createLoginThrottle } = require('../../security/login-throttle');
const IC = require('../../instance-config');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L
function newSetupCode() {
  const pick = () => ALPHABET[crypto.randomInt(ALPHABET.length)];
  const part = () => Array.from({ length: 4 }, pick).join('');
  return `AO-${part()}-${part()}`;                       // 8 symbols of 31: ~40 bits, and throttled
}
const sameCode = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const LOCALES = ['fr', 'en'];
// G6: 'demo' needs no connection (no fields, no gateway): a synthesised team, read-only
const ADAPTERS = [{ id: 'openclaw', name: 'OpenClaw', fields: ['gatewayUrl', 'token'], defaultGatewayUrl: 'ws://127.0.0.1:18789' },
  { id: 'demo', name: 'Démo', fields: [], defaultGatewayUrl: null }];
const PASSWORD_MIN = 12;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);

/**
 * @param {object} o
 * @param {object} o.env          the process env (the setup state reads the login variables from it)
 * @param {object} o.files        readInstanceConfig() result at boot
 * @param {(o) => Promise} o.probe  probeGateway (the runtime adapter's one-shot connection test)
 * @param {object} o.paths        openclaw identity paths for the probe (identityPath, stateDbPath)
 * @param {(m) => void} o.log
 * @param {() => void} o.onConfigured  called once the PUT response has been sent (the server switches app)
 */
function createSetup({ env, files, probe, paths = {}, dataDir = null, log = () => {}, onConfigured = () => {}, throttle = createLoginThrottle(),
  suggestedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', engine = null } = {}) {
  let state = IC.setupState(env, files);
  let code = state === 'open' ? newSetupCode() : null;
  let remembered = null;                       // { gatewayUrl, token } from the last check with a token
  if (code) log('Agent Office: first-run setup is open. One-time setup code: ' + code);

  const vm = () => ({
    state, configured: state === 'locked',
    adapters: ADAPTERS.map((a) => Object.assign({}, a, { fields: a.fields.slice() })),
    draft: state !== 'open' ? null : {
      instance: { name: '', locale: 'fr', timeZone: null },
      owner: { displayName: '', email: '', passwordSet: false },
      runtime: { adapter: 'openclaw', gatewayUrl: (remembered && remembered.gatewayUrl) || ADAPTERS[0].defaultGatewayUrl, tokenSet: !!(remembered && remembered.token) },
    },
    suggestedTimeZone, locales: LOCALES.slice(),
    // architect-56: what setup can install into the runtime's agents (opt-out: integrations.projet false in the PUT)
    integrations: [{ id: 'projet', adapters: ['openclaw'], default: true }],
  });
  // architect-56 · the project tag, installed for the primary agent right after the configuration is published
  // (src/adapters/openclaw/integration.js). Best effort: setup never fails because of it; the result says what happened.
  const PT = () => require('../../adapters').adapterById('openclaw').projectTag();
  const integrationCli = () => PT().cli({ openclawBin: paths.openclawBin, openclawHome: paths.openclawHome });
  async function installProjectTag(agentId, locale) {
    if (!paths.openclawBin || !paths.openclawHome) return { status: 'skipped', reason: 'no-runtime-paths' };
    try {
      const I = PT();
      const agents = await I.discoverAgents(integrationCli(), { home: paths.openclawHome });
      const agent = agents && agents.find((a) => a.id === agentId);
      if (!agent) return { status: 'skipped', reason: 'agent-not-found' };
      const r = I.install(agent, { locale, backupDir: dataDir ? require('path').join(dataDir, 'integrations', 'backups') : null });
      log('Agent Office: project tag for agent ' + agentId + ': ' + r.status + (r.done && r.done.length ? ' (' + r.done.join(', ') + ')' : ''));
      return r.status === 'conflict' ? { status: 'conflict', reason: r.refused } : { status: r.status };
    } catch (e) { log('Agent Office: project tag install failed (' + (e.code || 'error') + ')'); return { status: 'failed', reason: 'error' }; }
  }
  async function projectTagStatus(agentIds, locale) {
    try {
      const I = PT();
      const agents = paths.openclawBin ? await I.discoverAgents(integrationCli(), { home: paths.openclawHome }) : null;
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

  // every write: the state, then the code (throttled like the login: a wrong code is a failed attempt; R21-05: the
  // throttle is the process's one, shared with the login)
  function admit(req, res) {
    if (state === 'readonly') throw new ApiError('readonly');
    if (state !== 'open') throw new ApiError('forbidden', { message: 'L’installation est déjà faite.', details: [{ issue: 'locked' }] });
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
    if (!ADAPTERS.some((a) => a.id === r.adapter)) throw invalid('runtime.adapter', 'invalid');
    if (r.adapter === 'demo') {
      for (const k of Object.keys(r)) if (k !== 'adapter') throw invalid('runtime.' + k, 'unexpected-field');
      return { adapter: 'demo', gatewayUrl: null, token: null, given: false };
    }
    const gatewayUrl = typeof r.gatewayUrl === 'string' ? r.gatewayUrl.trim() : '';
    if (!IC.GATEWAY_URL.test(gatewayUrl)) throw invalid('runtime.gatewayUrl', 'invalid');
    if (r.token != null && (typeof r.token !== 'string' || r.token.length > 4096)) throw invalid('runtime.token', 'invalid');
    const token = r.token || (remembered && remembered.gatewayUrl === gatewayUrl ? remembered.token : null) || env.OC_GATEWAY_TOKEN || null;
    return { adapter: r.adapter, gatewayUrl, token, given: !!r.token };
  }
  const tryProbe = (rt) => (rt.adapter === 'demo' ? Promise.resolve({ status: 'connected', protocol: null, latencyMs: 0, gw: null })
    : probe({ url: rt.gatewayUrl, token: rt.token, identityPath: paths.identityPath, stateDbPath: paths.stateDbPath }));
  const demoAgents = () => require('../../adapters/demo').AGENTS.map((a) => ({ id: a.id, name: a.name, isPrimary: a.primary, model: a.model }));

  const ok = (res, result) => res.json(okBody({ ok: true, result, revision: null, vm: null }, { engine }));

  function mount(r) {
    r.get('/setup', (req, res) => res.json(okBody(vm(), { engine })));

    r.post('/setup/check', async (req, res, next) => {
      track(res);
      try {
        const rt = runtimeOf(admit(req, res));
        const p = await tryProbe(rt);
        if (p.gw) p.gw.close();
        if (rt.given && p.status === 'connected') remembered = { gatewayUrl: rt.gatewayUrl, token: rt.token };
        ok(res, { ok: p.status === 'connected', status: p.status, protocol: p.protocol, latencyMs: p.latencyMs });
      } catch (e) { next(e); }
    });

    r.post('/setup/discover', async (req, res, next) => {
      track(res);
      try {
        const rt = runtimeOf(admit(req, res));
        if (rt.adapter === 'demo') return ok(res, { agents: demoAgents() });
        const p = await tryProbe(rt);
        if (p.status !== 'connected') throw new ApiError('upstream_failed', { details: [{ issue: p.status }] });
        let listing;
        try { listing = await p.gw.call('agents.list', {}); } catch (_) { throw new ApiError('upstream_failed', { details: [{ issue: 'agents-list' }] }); } finally { p.gw.close(); }
        const list = isObj(listing) && Array.isArray(listing.agents) ? listing.agents : [];
        const agents = list.filter((a) => isObj(a) && typeof a.id === 'string' && IC.AGENT_ID.test(a.id)).map((a) => ({
          id: a.id, name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 80) : a.id,
          isPrimary: listing.defaultId === a.id,
          model: typeof a.model === 'string' ? a.model : isObj(a.model) && typeof a.model.primary === 'string' ? a.model.primary : null,
        }));
        // architect-56: is the project tag already in each agent's workspace (installed | outdated | absent | conflict | unknown)
        const tags = await projectTagStatus(agents.map((a) => a.id), 'fr');
        for (const a of agents) a.projectTag = tags[a.id] || 'unknown';
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
        if (typeof owner.password !== 'string' || owner.password.length < PASSWORD_MIN || owner.password.length > 1024) bad('owner.password', owner.password == null ? 'required' : 'too-short');
        let rt = null;
        try { rt = runtimeOf(b); } catch (e) { if (e.details) issues.push(...e.details); else throw e; }
        if (rt && rt.adapter === 'openclaw' && !rt.token) bad('runtime.token', 'required');
        if (typeof agents.primary !== 'string' || !IC.AGENT_ID.test(agents.primary)) bad('agents.primary', agents.primary == null ? 'required' : 'invalid');
        const looks = agents.looks == null ? {} : agents.looks;
        const integ = b.integrations == null ? {} : b.integrations;
        if (!isObj(integ) || Object.keys(integ).some((k) => k !== 'projet') || (integ.projet != null && typeof integ.projet !== 'boolean')) bad('integrations', 'invalid');
        const projet = integ.projet !== false;   // opt-out
        if (!isObj(looks) || Object.keys(looks).some((k) => !IC.AGENT_ID.test(k))) bad('agents.looks', 'invalid');
        if (issues.length) throw new ApiError('validation_failed', { details: issues });
        const config = { version: IC.VERSION, instance: { name, locale: inst.locale, timeZone: inst.timeZone }, owner: { displayName, email },
          runtime: rt.adapter === 'demo' ? { adapter: 'demo', demo: { seed: 1 } } : { adapter: 'openclaw', openclaw: { gatewayUrl: rt.gatewayUrl } }, agents: { primary: agents.primary, looks },
          integrations: { projet } };
        const secrets = { version: IC.VERSION, sessionSecret: crypto.randomBytes(48).toString('base64url'),
          passwordHash: await hashPassword(owner.password), runtimeToken: rt.token };
        if (state !== 'open') throw new ApiError('forbidden', { message: 'L’installation est déjà faite.', details: [{ issue: 'locked' }] });   // a concurrent PUT won
        try {
          IC.writeInstanceConfig(files.paths, config, secrets);
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
        const projetResult = rt.adapter !== 'openclaw' ? { status: 'skipped', reason: 'adapter' } : !projet ? { status: 'skipped', reason: 'opted-out' }
          : await installProjectTag(agents.primary, inst.locale);
        res.on('finish', () => whenIdle(onConfigured));   // R21-04: after every in-flight setup request has answered
        ok(res, { configured: true, integrations: { projet: projetResult } });
      } catch (e) { next(e); }
    });
  }

  return { mount, state: () => state, vm, _code: () => code };
}

module.exports = { createSetup, newSetupCode, PASSWORD_MIN };
