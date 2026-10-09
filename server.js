'use strict';
/*
 * Agent Office — live window into the OpenClaw agent ("Timmy") on the home server.
 * Single email/password login, signed session cookie, served behind Traefik.
 *
 * Composition root only: config → store → engine (fed by the runtime adapter's sources) → HTTP (v2/v3 API, the /v2 UI).
 * See docs/architecture/migration-plan.md for where each piece is heading.
 */
const path = require('path');
const { loadConfig } = require('./src/config');
const { createAuth } = require('./src/auth');
const { adapterById } = require('./src/adapters');
const { createEnrichment } = require('./src/enrichers');
const { createEngine } = require('./src/engine');
const { createApp } = require('./src/api/http');
const { openStore } = require('./src/store');
const { auditMiddleware } = require('./src/api/audit');
const { createAgentTokenGate } = require('./src/api/agent-token');
const { createCsrfGuard } = require('./src/api/csrf');
const { mountV2, writeClassOf } = require('./src/api/v2/routes');
const { startSources } = require('./src/sources/loop');
const { mountHealth } = require('./src/ops/health');

const express = require('express');
const IC = require('./src/instance-config');
const { createSetup } = require('./src/api/v2/setup');
const { buildMetaVM, buildMetaVM3 } = require('./src/api/v2/vm/meta');
const { apiVersionOf } = require('./src/api/v2/routes');
const { okBody } = require('./src/api/v2/envelope');
const { ApiError, sendError, errorMiddleware } = require('./src/api/v2/errors');
const { openclawPaths } = require('./src/config');
const { resolveLocale } = require('./src/i18n');

// G4 (ADR-001 §5, api.md §5.7): env → instance config file → defaults. Configured (by the file or the env) → the
// full app; nothing configured → setup mode, which switches to the full app in-process once setup is saved.
function readFiles() {
  try { return IC.readInstanceConfig(process.env); } catch (e) {
    console.error('Agent Office: refusing to start: invalid instance configuration: ' + e.message); process.exit(1);
  }
}
// R21-01: private files are private; ours are fixed (with a warning), someone else's refuse the start
function securePermissions(files, dataDir = null) {
  try { IC.securePermissions({ paths: files.paths, dataDir, warn: (m) => console.warn(m) }); } catch (e) {
    if (e.code !== 'EPERMS') throw e;
    console.error('Agent Office: refusing to start: ' + e.message); process.exit(1);
  }
}
// R21-05: ONE login throttle for the process: setup codes and logins count together, across the setup → app handoff
const { createLoginThrottle } = require('./src/security/login-throttle');
const throttle = createLoginThrottle();
let serverLock = null;   // G8: held for the process's life (released by the OS on exit): { dir, release }
// G8 / R30-01: whichever mode serves (setup or app), this process owns its data dir: `agent-office restore` refuses, and
// a second server refuses to start. The setup → app handoff keeps the lock it holds when the directory is the same.
function holdDataDir(dir) {
  const { acquireDirLock, SERVER_LOCK } = require('./src/ops/lock');
  const { identityOf } = require('./src/config');
  const id = identityOf(dir);
  if (serverLock && serverLock.dir === id) return;
  if (serverLock) { serverLock.release(); serverLock = null; }
  try { serverLock = { dir: id, release: acquireDirLock(dir, SERVER_LOCK) }; } catch (e) {
    if (e.code !== 'EBUSY') throw e;
    console.error('Agent Office: refusing to start: another server is using this data directory'); process.exit(1);
  }
}
const files = readFiles();
securePermissions(files);
if (files.orphanSecrets) console.warn('Agent Office: an interrupted setup left secrets.json without config.json; it is ignored, and the next setup replaces it');
let effective;
try { effective = IC.effectiveEnv(process.env, files); }
catch (e) { console.error('Agent Office: refusing to start: ' + e.message); process.exit(1); }
if (IC.isConfigured(effective) || IC.envConfigured(process.env)) bootFull(effective, files);
else bootSetup(files);

function bootFull(env, files) {
  const cfg = Object.freeze(Object.assign({}, loadConfig(env), { configured: true, instanceName: env.AO_INSTANCE_NAME || null }));
  securePermissions(files, cfg.dataDir);
  // G8: this server owns its data dir for its whole life (an OS lock): `agent-office restore` refuses meanwhile, and a
  // second server on the same data dir refuses to start
  holdDataDir(cfg.dataDir);
  // S5: the store. Refuses to start on a schema newer than this build or a data dir of another instance.
  let store;
  try {
    store = openStore({ dir: cfg.dataDir, instance: cfg.instance, ownerName: cfg.displayName || cfg.loginEmail.split('@')[0], renameOwner: !!cfg.displayName, retention: cfg.retention });
  } catch (e) {
    console.error('Agent Office: store unavailable (' + (e.code || 'error') + '): ' + (e.code ? e.message : 'see the stack below'));
    if (!e.code) console.error(e.stack);
    process.exit(1);
  }
  if (cfg.authDatabase && !store.setup.reconcile(files.config)) {
    store.close();
    console.warn('Agent Office: database owner setup needs local recovery; use the fresh setup code.');
    return bootSetup(files, { recovery: true });
  }
  store.office.migrateConfiguredPeers(cfg.agentNames);
  // G2 (ADR-001): the runtime adapter (one per instance; OpenClaw today, chosen by the instance config in G4)
  const adapter = adapterById(cfg.runtimeAdapter);   // G6: 'openclaw' or 'demo' (instance config runtime.adapter / AO_RUNTIME)
  const runtime = adapter.createRuntime(cfg, { senderCaptures: store.senderCaptures });

  // The engine sees every raw input, validates it and quarantines what it can't accept; v2/v3 read only the engine.
  const engine = createEngine({ adapter: runtime.definition || adapter.definition, primary: cfg.primaryAgent, agentNames: cfg.agentNames, senderContext: () => ({ operator: store.owner, people: store.persons.senderPeople() }) });
  store.bindEngine(engine);       // quarantine restored from the store, written behind
  runtime.attach(engine);         // the adapter's taps: every runtime read is ingested

  // the Discord enricher's token: the runtime config's (engine)
  const discordToken = () => { const c = engine.config(); return c && c.discord && c.discord.token.present ? c.discord.token.reveal() : null; };
  // G7 (ADR-001 §14.2): the enrichers the instance selects (default ['discord']); secrets are asked by name
  const enrichment = createEnrichment({ ids: cfg.enrichers, deps: { secret: (name) => (name === 'discord.token' ? discordToken() : null),
    cache: store.caches.interlocutors, log: (m) => console.log(m) } });

  const auth = createAuth({ secret: cfg.sessionSecret, ttlMs: cfg.sessionTtlMs, email: cfg.loginEmail, password: cfg.loginPassword, passwordHash: cfg.passwordHash,
    credential: cfg.authDatabase ? (email) => email == null ? store.users.owner() : store.users.credential(email) : null,
    cookieSecure: cfg.cookieSecure, revocations: store.sessions, audit: (row) => store.audit.append(row), ownerPersonId: () => store.owner.id, throttle });
  let v2 = null;
  const app = createApp({
    readonly: cfg.readonly,
    readonlyStore: cfg.readonlyStore,
    apiOnly: cfg.apiOnly,
    trustProxy: cfg.trustProxy,
    writeClassOf,
    audit: auditMiddleware({ store, sessionOf: (req) => auth.sessionOf(req) }),
    // S7d: the agent's scoped token. G3a: only the resolver's primary agent, as { kind: 'agent', agentId }
    csrf: createCsrfGuard({ publicUrl: cfg.publicUrl, onLoginRefused: (req, d) => auth.loginRefused(req, d) }),
    onLoginRefused: (req, d) => auth.loginRefused(req, d),
    tokenGate: createAgentTokenGate({ tokens: store.tokens, audit: (row) => store.audit.append(row), allowedAgent: () => { const agent = engine.primaryAgent(); return agent ? agent.id : null; },
      personOf: (agentId) => { const p = store.persons.list().find((x) => x.links.agentId === agentId); return p ? p.id : null; }, log: (m) => console.log(m) }),
    publicDir: path.join(__dirname, 'public'),
    mountRoutes: (a) => {
      mountHealth(a, () => ({ mode: 'app', store, engine }));   // G8: /healthz, /readyz (operations.md §1)
      auth.mountRoutes(a, { isGwConnected: () => engine.gateway().connected });   // login, logout, /api/me: every mode
      const setup = createSetup({ env: process.env, files, engine, throttle });   // locked: configured
      v2 = mountV2(a, { auth, engine, cfg, store, runtime, enrichment, setup });   // S6: /api/v2 (meta, me, health view, mute, typed stream)
    },
  });

  // ================= boot =================
  // the sources that feed the engine: the runtime adapter's loops, host metrics, interlocutor enrichment
  startSources({ runtime, engine, enrichment });
  store.startMaintenance();
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { try { if (v2) v2.close(); store.close(); } finally { process.exit(0); } });
  app.listen(cfg.port, cfg.host, () => {
    console.log('Agent Office listening on http://' + cfg.host + ':' + cfg.port + (cfg.apiOnly ? ' (API only)' : ''));
    console.log('Gateway: ' + cfg.gatewayUrl + '  ·  login: ' + cfg.loginEmail);
    console.log('Store: ' + store.file + ' (instance ' + cfg.instance + ', schema v' + store.version + ')');
    console.log('AO_READY ' + JSON.stringify({ mode: 'app', port: cfg.port }));
  });
}

// ================= setup mode (G4) =================
// Only the static UI, GET /api/v2/meta (instance.configured: false) and the setup routes; every other API route is
// 503 `not-configured`. A pristine first run takes only the data-dir lock. The store opens for an owner draft/resume;
// the runtime starts after publication. Local recovery also uses the setup-code gate.
function bootSetup(files, { recovery = false } = {}) {
  const env = recovery ? IC.effectiveEnv(process.env, files) : process.env;
  const cfg = { instance: ['production', 'staging', 'dev', 'test'].includes(env.AO_ENV) ? env.AO_ENV : 'dev', readonly: env.PORTAL_READONLY === '1',
    readonlyStore: true, configured: false, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', instanceLocale: 'fr' };
  const port = Number(env.PORT || 18789), host = env.HOST || '127.0.0.1';
  // R30-01: the directory the configured app will use (created 0700, empty), named like loadConfig names it; never
  // production's from another instance (loadConfig refuses that at the handoff; setup must not hold its lock meanwhile)
  let setupDataDir;
  {
    const { resolveDataDir, defaultDataDir, identityOf } = require('./src/config');
    const named = env.AO_ENV || (env.PORTAL_READONLY === '1' ? 'staging' : env.NODE_ENV === 'production' ? 'production' : 'dev');
    const inst = ['production', 'staging', 'dev', 'test'].includes(named) ? named : 'dev';
    cfg.instance = inst;
    const dir = resolveDataDir(env, inst);
    if (inst !== 'production' && identityOf(dir) === identityOf(defaultDataDir(env, 'production'))) {
      console.error(`Refusing to start: the ${inst} instance would use production's data dir (${dir}). Set AO_DATA_DIR.`); process.exit(1);
    }
    holdDataDir(dir);
    setupDataDir = dir;
  }
  let server = null;
  const setup = createSetup({ env, files, recovery, paths: openclawPaths(env), dataDir: setupDataDir, instance: cfg.instance, log: (m) => console.log(m), throttle,
    onConfigured: () => {
      // the files now exist: hand the port over to the configured app, in this process
      for (const sig of ['SIGTERM', 'SIGINT']) process.removeListener(sig, closeSetup);
      setup.close();
      server.close();
      if (server.closeAllConnections) server.closeAllConnections();
      server.once('close', () => {
        const next = readFiles(), nextEnv = IC.effectiveEnv(process.env, next);
        // Keep the listener and browser origin for this session; saved network changes apply on restart.
        Object.assign(nextEnv, { HOST: host, PORT: String(port), AO_PUBLIC_URL: env.AO_PUBLIC_URL || '',
          PORTAL_COOKIE_SECURE: env.PORTAL_COOKIE_SECURE || (String(env.AO_PUBLIC_URL || '').startsWith('https://') ? '1' : '0') });
        bootFull(nextEnv, next);
      });
    } });
  const closeSetup = () => { setup.close(); process.exit(0); };
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, closeSetup);
  const notConfigured = (req, res) => sendError(req, res, new ApiError('upstream_unavailable', { details: [{ issue: 'not-configured' }] }));
  const app = createApp({
    readonly: cfg.readonly, publicDir: path.join(__dirname, 'public'), apiOnly: env.AO_API_ONLY === '1',
    trustProxy: env.AO_TRUST_PROXY ? env.AO_TRUST_PROXY.split(',').map((x) => x.trim()).filter(Boolean).join(', ') : 'loopback',
    csrf: createCsrfGuard({ publicUrl: env.AO_PUBLIC_URL || null }),
    mountRoutes: (a) => {
      mountHealth(a, () => ({ mode: 'setup' }));   // G8: live, and ready (setup must be reachable)
      const r = express.Router();
      r.use((req, res, next) => { req.apiVersion = apiVersionOf(req); res.setHeader('Cache-Control', 'no-store'); next(); });
      setup.mount(r);
      // R22-03: a fresh instance serves the v3 bootstrap too (a 3.0 client's first call is /api/v3/meta)
      r.get('/meta', (req, res) => { res.setHeader('Vary', 'Accept-Language'); res.json(okBody((req.apiVersion === 3 ? buildMetaVM3 : buildMetaVM)(cfg, { locale: resolveLocale({ acceptLanguage: req.headers['accept-language'] }) }))); });
      r.use(notConfigured);
      r.use(errorMiddleware((m) => console.log(m)));
      a.use(['/api/v2', '/api/v3'], r);
      a.use('/api', notConfigured);
    },
  });
  server = app.listen(port, host, () => {
    console.log('Agent Office setup URL: http://' + (env.AO_UI_HOST || host) + ':' + (env.AO_UI_PORT || port) + (env.AO_UI_PORT ? '/' : '/v2/'));
    console.log('AO_READY ' + JSON.stringify({ mode: 'setup', port }));   // a fixed, structured readiness line (supervisors, tests)
  });
}
