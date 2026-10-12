'use strict';
// Environment → typed config. Required variables are checked here; the process exits if one is missing.
const os = require('os');
const path = require('path');

// A configuration that can't start the server: the message on stderr and exit 1. Under tryLoadConfig (G11: the doctor) it
// throws instead, with the VARIABLE's name and a closed reason (never its value) for a caller that must not print values.
let throwing = false;
function die(message, variable, reason) {
  if (throwing) throw Object.assign(new Error(message), { code: 'ECONFIG', variable, reason });
  console.error(message); process.exit(1);
}
// The store's data dir (storage.md §2). Each instance has its own default; staging and dev can never
// fall back to production's directory (boot check below + the store's instance guard).
const DATA_DIR_NAME = { production: 'agent-office', staging: 'agent-office-staging', dev: 'agent-office-dev', test: 'agent-office-test' };
function defaultDataDir(env, instance) {
  const base = env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), '.local', 'share');
  return path.join(base, DATA_DIR_NAME[instance]);
}
const resolveDataDir = (env, instance) => (env.AO_DATA_DIR ? path.resolve(env.AO_DATA_DIR) : defaultDataDir(env, instance));
// R8-01: a path's filesystem identity: the realpath of its nearest existing ancestor + the rest, so a symlink alias
// of production's directory (existing or not yet created) compares equal to it.
// A dangling symlink is followed too (its target may not exist yet), up to 40 hops.
function identityOf(p, hops = 0) {
  const fs = require('fs');
  let cur = path.resolve(p); const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.slice().reverse()); } catch (_) { /* missing, or a dangling link */ }
    let link = null; try { if (fs.lstatSync(cur).isSymbolicLink()) link = fs.readlinkSync(cur); } catch (_) { /* missing */ }
    if (link != null && hops < 40) return identityOf(path.join(path.resolve(path.dirname(cur), link), ...rest.slice().reverse()), hops + 1);
    const up = path.dirname(cur); if (up === cur) return path.resolve(p);
    rest.push(path.basename(cur)); cur = up;
  }
}
// Compatibility export; runtime path conventions are owned by the default adapter.
const openclawPaths = env => require('./adapters').defaultAdapter().paths(env);
function validTimeZone(tz) {
  if (!tz) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch (_) { die(`AO_TIME_ZONE is not an IANA time zone (got ${JSON.stringify(tz)})`, 'AO_TIME_ZONE', 'invalid'); }
}
function daysOf(env, name, def, min, max) {
  if (env[name] === undefined || env[name] === '') return def;
  const n = /^\d{1,5}$/.test(String(env[name])) ? Number(env[name]) : NaN;
  if (!(n >= min && n <= max)) die(`${name} must be a whole number of days between ${min} and ${max}`, name, 'invalid');
  return n;
}
function enrichersOf(env) {
  const { ENRICHER_IDS, DEFAULT_ENRICHERS } = require('./enrichers');
  if (env.AO_ENRICHERS === undefined) return DEFAULT_ENRICHERS.slice();
  const ids = String(env.AO_ENRICHERS).split(',').map((x) => x.trim()).filter(Boolean);
  for (const id of ids) if (!ENRICHER_IDS.includes(id)) die(`AO_ENRICHERS: unknown enricher ${JSON.stringify(id)} (known: ${ENRICHER_IDS.join(', ')})`, 'AO_ENRICHERS', 'invalid');
  return [...new Set(ids)];
}
function runtimeAdapterOf(env) {
  const id = env.AO_RUNTIME || 'openclaw';
  if (!require('./adapters').ADAPTER_IDS.includes(id)) die(`AO_RUNTIME must be one of ${require('./adapters').ADAPTER_IDS.join(', ')} (got ${JSON.stringify(id)})`, 'AO_RUNTIME', 'invalid');
  return id;
}
function loadConfig(env = process.env) {
  // The portal's own login and session secrets are required. The runtime token is NOT (R13-04, ADR-001 §12.1): without it
  // the server still boots and the adapter reports 'not-configured' (G4's setup screen fills it in).
  for (const k of ['PORTAL_EMAIL', 'PORTAL_SECRET']) {
    if (!env[k]) die(`Missing required env var ${k} (see .env.example)`, k, 'missing');
  }
  // PM audit (A): the password is stored as an scrypt hash (PORTAL_PASSWORD_HASH, from `agent-office hash-password`);
  // a plaintext PORTAL_PASSWORD still works this release, with a warning.
  const { isHash } = require('./security/password');
  if (env.PORTAL_PASSWORD_HASH) {
    if (!isHash(env.PORTAL_PASSWORD_HASH)) die('PORTAL_PASSWORD_HASH is not a valid scrypt hash (generate one with: agent-office hash-password)', 'PORTAL_PASSWORD_HASH', 'invalid');
  } else if (env.PORTAL_PASSWORD) {
    if (env.AO_ENV !== 'test' && !throwing) console.warn('Agent Office: PORTAL_PASSWORD (plaintext) is deprecated; store PORTAL_PASSWORD_HASH instead (agent-office hash-password) and remove PORTAL_PASSWORD.');
  } else if (env.AO_AUTH_DATABASE !== '1') die('Missing required env var PORTAL_PASSWORD_HASH (see .env.example)', 'PORTAL_PASSWORD_HASH', 'missing');
  const readonly = env.PORTAL_READONLY === '1';
  if(env.AO_RBAC_ENABLED!==undefined&&!['0','1'].includes(env.AO_RBAC_ENABLED))die('AO_RBAC_ENABLED must be 0 or 1','AO_RBAC_ENABLED','invalid');
  if(env.AO_SPLIT_AUTH_ENABLED!==undefined&&!['0','1'].includes(env.AO_SPLIT_AUTH_ENABLED))die('AO_SPLIT_AUTH_ENABLED must be 0 or 1','AO_SPLIT_AUTH_ENABLED','invalid');
  const splitAuthEnabled=env.AO_SPLIT_AUTH_ENABLED==='1';
  let apiPublicUrl=null,allowedOrigins=Object.freeze([]);
  if(splitAuthEnabled){
    if(env.AO_RBAC_ENABLED!=='1')die('AO_SPLIT_AUTH_ENABLED=1 requires AO_RBAC_ENABLED=1','AO_SPLIT_AUTH_ENABLED','requires-rbac');
    if(env.AO_API_ONLY!=='1')die('AO_SPLIT_AUTH_ENABLED=1 requires AO_API_ONLY=1','AO_API_ONLY','requires-api-only');
    if(typeof env.AO_TRUST_PROXY!=='string'||!env.AO_TRUST_PROXY.split(',').some(x=>x.trim()))die('AO_SPLIT_AUTH_ENABLED=1 requires explicit AO_TRUST_PROXY addresses','AO_TRUST_PROXY','required');
    try {
      const boundary=require('./security/access-boundary');
      apiPublicUrl=boundary.canonicalApiBase(env.AO_API_PUBLIC_URL);
      allowedOrigins=boundary.allowedOrigins(env.AO_ALLOWED_ORIGINS);
      if(!allowedOrigins.length)throw new TypeError('empty origin list');
    } catch {
      die('Split auth requires a canonical HTTPS AO_API_PUBLIC_URL and 1–16 exact HTTPS AO_ALLOWED_ORIGINS','AO_ALLOWED_ORIGINS','invalid');
    }
  }
  const instance = env.AO_ENV || (readonly ? 'staging' : env.NODE_ENV === 'production' ? 'production' : 'dev');
  if (!['production', 'staging', 'dev', 'test'].includes(instance)) die(`AO_ENV must be production, staging, dev or test (got ${JSON.stringify(instance)})`, 'AO_ENV', 'invalid');
  const dataDir = resolveDataDir(env, instance);
  if (instance !== 'production' && identityOf(dataDir) === identityOf(defaultDataDir(env, 'production'))) {
    die(`Refusing to start: the ${instance} instance would use production's data dir (${dataDir}). Set AO_DATA_DIR.`, 'AO_DATA_DIR', 'production-dir');
  }
  if (readonly && instance === 'production') die('Refusing to start: PORTAL_READONLY=1 with AO_ENV=production (a read-only instance is a staging one).', 'PORTAL_READONLY', 'readonly-production');
  const projectsOwners = (env.AO_PROJECTS_OWNERS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const projectsRoot = env.AO_PROJECTS_ROOT ? path.resolve(env.AO_PROJECTS_ROOT) : null;
  return Object.freeze({
    instance,
    dataDir,
    port: Number(env.PORT || 18789),
    host: env.HOST || '127.0.0.1',
    gatewayUrl: env.OC_GATEWAY_URL || 'ws://127.0.0.1:18793',
    gatewayToken: env.OC_GATEWAY_TOKEN || null,
    openclawService: env.OC_SERVICE || 'openclaw-gateway.service',   // the restart fallback's systemd user unit
    // ADR-001 §12.1: every OpenClaw path derives from ONE runtime home (default: this process's home), never a
    // literal. Each stays overridable (OC_* env today, the instance config in G4).
    ...openclawPaths(env),
    loginEmail: (env.PORTAL_EMAIL || '').toLowerCase(),
    authDatabase: env.AO_AUTH_DATABASE === '1',
    rbacEnabled: env.AO_RBAC_ENABLED === '1',
    splitAuthEnabled,
    apiPublicUrl,
    allowedOrigins,
    agentNames: env.AO_AGENT_NAMES ? JSON.parse(env.AO_AGENT_NAMES) : {},
    // S6.1: the owner's display name (MeVM.displayName, the owner Person). Not a secret. Default: the e-mail's local part.
    displayName: (env.PORTAL_DISPLAY_NAME || '').trim().slice(0, 80) || null,
    loginPassword: env.PORTAL_PASSWORD_HASH ? null : env.PORTAL_PASSWORD,
    passwordHash: env.PORTAL_PASSWORD_HASH || null,
    // R16-02: the proxies whose X-Forwarded-For is believed for the client IP (login throttling). Default: loopback only.
    // Production names its proxy network explicitly, e.g. AO_TRUST_PROXY=loopback,172.30.0.0/16 (Express syntax:
    // comma-separated IPs, CIDR ranges and the names loopback/linklocal/uniquelocal).
    trustProxy: env.AO_TRUST_PROXY ? env.AO_TRUST_PROXY.split(',').map((x) => x.trim()).filter(Boolean).join(', ') : 'loopback',
    sessionSecret: env.PORTAL_SECRET,
    sessionTtlMs: 12 * 3600 * 1000,
    // Staging instances share the real gateway and CLI, so they must not mutate anything.
    readonly,
    // storage.md §6: store writes (projects, layout, prefs, mute) are refused only when PORTAL_READONLY_STORE=1
    readonlyStore: env.PORTAL_READONLY_STORE === '1',
    senderCapture: env.AO_SENDER_CAPTURE !== '0',
    // Go-live topology (PM): the UI is served elsewhere and the API sits behind a reverse proxy at a stripped
    // prefix (/backend). API-only: no static files, no SPA fallbacks; non-API paths are a JSON 404.
    apiOnly: env.AO_API_ONLY === '1',
    // G6: the runtime adapter (instance config `runtime.adapter`, or AO_RUNTIME): 'openclaw' (default) or 'demo' (a
    // synthesised team; read-only; v1 never mounts with it). runtimeWritable: whether runtime commands can exist at all.
    // G8 (operations.md §3): retention, in days, within bounds (a value out of bounds refuses to start)
    retention: { auditDays: daysOf(env, 'AO_AUDIT_RETENTION_DAYS', 365, 30, 3650), issueDays: daysOf(env, 'AO_ISSUE_RETENTION_DAYS', 30, 7, 365), senderDays: daysOf(env, 'AO_SENDER_RETENTION_DAYS', 30, 1, 365) },
    runtimeAdapter: runtimeAdapterOf(env),
    // G7 (ADR-001 §14.2): the interlocutor enrichers (instance config `enrichers`, AO_ENRICHERS comma-separated; '' = none)
    enrichers: enrichersOf(env),
    runtimeWritable: runtimeAdapterOf(env) === 'openclaw',
    demoSeed: /^\d{1,9}$/.test(String(env.AO_DEMO_SEED || '')) ? Number(env.AO_DEMO_SEED) : 1,
    // frontend-07: URLs in VMs are absolute. The public origin (also og:url/og:image, instance.publicUrl in G4) and the
    // API prefix the browser sees (go-live: '/backend'; '' when the API is served at the root).
    publicUrl: env.AO_PUBLIC_URL || null,
    // S7d: project screenshots, OFF unless AO_CAPTURE=1. Found while testing with real Chrome: it connects to loopback
    // addresses DIRECTLY despite --proxy-bypass-list=<-loopback>, so the egress proxy can't yet stop a page from
    // reaching local services. Not to be enabled until Chrome runs in an isolated network namespace (architect-19).
    capture: env.AO_CAPTURE === '1',
    strictVm: env.AO_STRICT_VM === '1',
    // G3a (ADR §12.2, §12.7): the instance's configured primary agent (else the runtime's default, else the first listed),
    // its time zone (default: the server process's own, never a literal) and default locale. G4 moves them to the
    // instance config file.
    primaryAgent: env.AO_PRIMARY_AGENT || null,
    timeZone: validTimeZone(env.AO_TIME_ZONE) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    instanceLocale: ['fr-CA', 'en-CA', 'fr', 'en'].includes(env.AO_LOCALE) ? env.AO_LOCALE : 'fr-CA',   // PM audit (B): throw on an invalid VM even in production/staging (rehearsals)
    publicApiBase: env.AO_PUBLIC_API_BASE != null ? env.AO_PUBLIC_API_BASE : (env.AO_API_ONLY === '1' ? '/backend' : ''),
    // S7a, Projets discovery and repo refresh (read-only gh/git). AO_PROJECTS_DISCOVERY=0 turns them off (tests).
    // §12.1: discovery is off until configured: no default owner, no default workspace root.
    projectsOwners,
    projectsRoot,
    projectsDiscovery: env.AO_PROJECTS_DISCOVERY !== '0' && (projectsOwners.length > 0 || projectsRoot != null),
    // R1-10: Secure cookies on HTTPS deployments. PORTAL_COOKIE_SECURE=1/0 decides; default on in production
    // only (staging is served over plain HTTP on the tailnet: never enabled silently there).
    cookieSecure: env.PORTAL_COOKIE_SECURE === '1' ? true : env.PORTAL_COOKIE_SECURE === '0' ? false : instance === 'production',
  });
}

const READONLY_MESSAGE = 'Instance de test : actions désactivées.';

/** G11: loadConfig that throws ECONFIG ({ variable, reason }) instead of exiting, and prints nothing. */
function tryLoadConfig(env) {
  throwing = true;
  try { return loadConfig(env); } finally { throwing = false; }
}
module.exports = { tryLoadConfig, resolveDataDir, loadConfig, READONLY_MESSAGE, defaultDataDir, identityOf, openclawPaths };
