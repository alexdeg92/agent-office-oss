'use strict';
/*
 * G4 (ADR-001 §5, api.md §5.7): the instance config file and its secret file.
 *   config  $AO_CONFIG, else $XDG_CONFIG_HOME/agent-office/config.json (~/.config/…): non-secret, schema-validated
 *   secrets secrets.json next to it: session secret/runtime token; v1 also has its legacy scrypt hash.
 *   v2 authenticates against the owner's users row; it never copies that hash into secrets.
 * Both files are written 0600, atomically (temp file + rename), in a 0700 directory, by the first-run setup only.
 *
 * PRECEDENCE: env → file → built-in defaults. The file is mapped onto the env names src/config.js already reads, and
 * every variable the env sets wins (`effectiveEnv`). An install configured by env (production: PORTAL_EMAIL,
 * PORTAL_SECRET, PORTAL_PASSWORD_HASH) is configured, and setup stays locked on it forever (`setupState`).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const s = require('./schema');
const { isHash } = require('./security/password');

const VERSION = 3;
const { scopedId, parseId, INSTANCE_ID } = require('./runtime-ids');
// A complete login replaces file auth. A secret-only override preserves the file auth mode.
const LOGIN_ENV = ['PORTAL_EMAIL', 'PORTAL_SECRET', 'PORTAL_PASSWORD_HASH', 'PORTAL_PASSWORD'];
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GATEWAY_URL = /^wss?:\/\/[^\s/?#]+(:\d{1,5})?(\/[^\s]*)?$/;
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}$/;
const validZone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch (_) { return false; } };

const str = (min, max) => s.string().min(min).max(max);
const Look = s.object({ character: str(1, 64), variant: str(1, 64).nullable(), accessories: s.array(str(1, 64)).max(8) }, { extra: 'reject' });
const AccessConfig = s.object({
  mode: s.enumOf(['local', 'lan', 'private', 'public-same-origin', 'public-split-origin', 'tunnel']),
  apiPublicUrl: str(1, 2048).nullable(), uiOrigins: s.array(str(1, 2048)).max(16), domain: str(1, 253).nullable(),
  proxy: s.enumOf(['caddy', 'traefik', 'cloudflare', 'manual']),
  security: s.object({ accessTokenMinutes: s.int().min(5).max(15), refreshIdleHours: s.int().min(1).max(24),
    refreshAbsoluteDays: s.int().min(1).max(30), partitionedCookie: s.boolean() }, { extra: 'reject' }),
}, { extra: 'reject' }).refine(value => {
  try { require('./access/draft').validateAccessDraft(value); return true; } catch { return false; }
}, 'canonical external access draft');
const ConfigShape = {
  version: s.literal(1),
  auth:s.object({rbacEnabled:s.boolean()},{extra:'reject'}).optional(),
  access: AccessConfig.optional(), accessRevision: s.int().min(0).optional(),
  instance: s.object({ name: str(1, 80), locale: s.enumOf(['fr', 'en']), timeZone: s.string().refine(validZone, 'IANA time zone') }, { extra: 'reject' }),
  owner: s.object({ displayName: str(1, 80), email: s.string().refine((v) => EMAIL.test(v), 'e-mail') }, { extra: 'reject' }),
  // G6: 'openclaw' needs its gateway; 'demo' (a synthesised team) takes an optional seed
  runtime: s.object({ adapter: s.enumOf(['openclaw', 'demo']),
    openclaw: s.object({ gatewayUrl: s.string().refine((v) => GATEWAY_URL.test(v), 'ws(s) URL') }, { extra: 'reject' }).optional(),
    demo: s.object({ seed: s.int().min(0).max(999999999) }, { extra: 'reject' }).optional() }, { extra: 'reject' })
    .refine((r) => r.adapter !== 'openclaw' || !!r.openclaw, 'openclaw needs runtime.openclaw'),
  enrichers: s.array(s.enumOf(['discord'])).max(8).optional(),   // G7: the selected interlocutor enrichers (default ['discord'])
  // architect-56: what Agent Office installs into the runtime's agents (default: the project tag); false = opt out
  integrations: s.object({ projet: s.boolean() }, { extra: 'reject' }).optional(),
  agents: s.object({ primary: s.string().refine((v) => AGENT_ID.test(v), 'agent id').nullable(),
    looks: s.record(Look) }, { extra: 'reject' }),
};
const LegacyConfigSchema = s.object(ConfigShape, { extra: 'reject' });
const ConfigV2Schema = s.object({ ...ConfigShape, version: s.literal(2),
  runtime: s.unknown().refine(r => {
    if (!r || !require('./adapters').ADAPTER_IDS.includes(r.adapter)) return false;
    const adapter = require('./adapters').adapterById(r.adapter);
    return !!adapter.setup.connect && s.validate(adapter.setup.configSchema, r).ok;
  }, 'connectable adapter config'),
  owner: s.object({ displayName: str(1, 80), email: s.string().refine(v => EMAIL.test(v), 'e-mail'), authSource: s.literal('database') }, { extra: 'reject' }),
  agents: s.object({ primary: s.string().refine(v => AGENT_ID.test(v), 'agent id').nullable(), looks: s.record(Look), names: s.record(s.record(str(1, 80).nullable())).optional(), hidden: s.record(s.array(s.string().refine(v => AGENT_ID.test(v), 'agent id'))).optional(), configured: s.record(s.array(s.string().refine(v => AGENT_ID.test(v), 'agent id'))).optional() }, { extra: 'reject' }),
  network: s.object({ mode: s.enumOf(['local', 'lan', 'tailnet', 'public', 'tunnel']), host: str(1, 255), port: s.int().min(1).max(65535), publicUrl: s.string().nullable(), cookieSecure: s.boolean() }, { extra: 'reject' }).optional(),
}, { extra: 'reject' });
const runtimeEntryValid = r => {
  if (!r || !INSTANCE_ID.test(r.id) || typeof r.enabled !== 'boolean') return false;
  const { id, enabled, name, ...native } = r;
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length>80 || /[\x00-\x1f\x7f]/.test(name))) return false;
  if (!require('./adapters').ADAPTER_IDS.includes(native.adapter)) return false;
  const adapter = require('./adapters').adapterById(native.adapter);
  return !!adapter.setup.connect && s.validate(adapter.setup.configSchema, native).ok;
};
const { runtime: singleRuntime, ...V3Base } = ConfigShape;
const ConfigV3Schema = s.object({ ...V3Base, version: s.literal(3),
  owner: s.object({ displayName: str(1, 80), email: s.string().refine(v => EMAIL.test(v), 'e-mail'), authSource: s.literal('database') }, { extra: 'reject' }),
  runtimes: s.array(s.unknown().refine(runtimeEntryValid, 'declared runtime instance')).max(32)
    .refine(rows => new Set(rows.map(r => r.id)).size === rows.length, 'unique runtime instance ids'),
  sources: s.object({ herdr: s.boolean().optional() }, { extra: 'reject' }).optional(),
  agents: s.object({ primary: s.string().refine(v => !!parseId(v, 'agent'), 'scoped agent id').nullable(), looks: s.record(Look),
    names: s.record(s.record(str(1, 80).nullable())).optional(), hidden: s.record(s.array(str(1, 4096))).optional(), configured: s.record(s.array(str(1, 4096))).optional() }, { extra: 'reject' }),
  network: s.object({ mode: s.enumOf(['local', 'lan', 'tailnet', 'public', 'tunnel']), host: str(1, 255), port: s.int().min(1).max(65535), publicUrl: s.string().nullable(), cookieSecure: s.boolean() }, { extra: 'reject' }).optional(),
}, { extra: 'reject' });
const ConfigSchema = s.union([LegacyConfigSchema, ConfigV2Schema, ConfigV3Schema]);
const secretShape = { sessionSecret: str(32, 256), runtimeToken: str(1, 4096).nullable() };
const LegacySecretsSchema = s.object({ version: s.literal(1), ...secretShape, passwordHash: s.string().refine(isHash, 'scrypt hash') }, { extra: 'reject' });
const SecretsV2Schema = s.object({ version: s.literal(2), ...secretShape }, { extra: 'reject' });
const SecretsV3Schema = s.object({ version: s.literal(3), sessionSecret: str(32, 256),
  runtimes: s.record(s.object({ runtimeToken: str(1, 4096).nullable().optional() }, { extra: 'reject' })) }, { extra: 'reject' });
const SecretsSchema = s.union([LegacySecretsSchema, SecretsV2Schema, SecretsV3Schema]);
function versionedSchema(schema, value) {
  if (schema !== ConfigSchema && schema !== SecretsSchema) return schema;
  if (![1, 2, 3].includes(value?.version)) throw new ConfigError('configuration', [{ path: '$.version', detail: 'unsupported config version; supported: 1, 2, 3' }]);
  return schema === ConfigSchema ? [null, LegacyConfigSchema, ConfigV2Schema, ConfigV3Schema][value.version] : [null, LegacySecretsSchema, SecretsV2Schema, SecretsV3Schema][value.version];
}

function configPaths(env = process.env) {
  const file = env.AO_CONFIG ? path.resolve(env.AO_CONFIG)
    : path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'), 'agent-office', 'config.json');
  return { file, secrets: path.join(path.dirname(file), 'secrets.json') };
}

class ConfigError extends Error {
  constructor(file, issues) { super(`${file}: ${issues.filter((i) => i.severity !== 'info').map((i) => `${i.path} ${i.detail || i.message || 'invalid'}`).join('; ')}`); this.file = file; this.issues = issues; }
}

// R21-02 / R22-02: an undeclared field's NAME may itself be a secret (a password pasted as a key), dots included.
// Diagnostics say how many undeclared fields sit under which DECLARED parent (the schema's `parent`, never parsed out of a
// path that contains the key): no key text, no type.
function safeIssues(issues) {
  const out = [], undeclared = new Map();
  for (const i of issues) {
    if (i.severity === 'info') continue;
    if (i.detail !== 'unexpected field') { out.push(i); continue; }
    const parent = typeof i.parent === 'string' ? i.parent : '$';
    undeclared.set(parent, (undeclared.get(parent) || 0) + 1);
  }
  for (const [parent, n] of undeclared) out.push({ path: parent + ':', detail: `${n} undeclared field${n === 1 ? '' : 's'}` });
  return out;
}
function readJson(file, schema) {
  if (!fs.existsSync(file)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { throw new ConfigError(file, [{ path: '$', message: 'is not JSON' }]); }
  const r = s.validate(versionedSchema(schema, value), value);
  if (!r.ok) throw new ConfigError(file, r.issues ? safeIssues(r.issues) : [{ path: '$', message: 'invalid' }]);
  return value;
}

/**
 * → { paths, config, secrets, orphanSecrets } (null when absent). Throws ConfigError (field paths only) on a bad file.
 * R21-03: config.json is the COMMIT MARKER of a publication: secrets.json without it is the remainder of an interrupted
 * one, never read (orphanSecrets: true) and replaced by the next setup.
 */
function readInstanceConfig(env = process.env) {
  const paths = configPaths(env);
  const config = readJson(paths.file, ConfigSchema);
  if (!config) return { paths, config: null, secrets: null, orphanSecrets: fs.existsSync(paths.secrets) };
  const secrets = readJson(paths.secrets, SecretsSchema);
  if (secrets && secrets.version !== config.version) throw new ConfigError(paths.secrets, [{ path: '$.version', message: 'must match config version' }]);
  if (secrets && config.owner.authSource !== 'database' && !secrets.passwordHash) throw new ConfigError(paths.secrets, [{ path: '$.passwordHash', message: 'required for file authentication' }]);
  return { paths, config, secrets, orphanSecrets: false };
}

// The file, as the env variables src/config.js reads (only what the file holds)
function fileEnv(config, secrets) {
  // The legacy env projection remains usable by setup/doctor and older callers.
  // Multi-source consumers use runtimeInstances() rather than broadcasting it.
  if (config?.version === 3) {
    const legacy = config.runtimes.find(r => r.id === 'legacy');
    const primary = parseId(config.agents.primary, 'agent');
    const selected = legacy || config.runtimes.find(r => r.enabled), adapter = selected?.adapter || 'demo';
    const projected = { ...config, version: 2, runtime: selected ? nativeRuntime(selected) : { adapter },
      agents: { ...config.agents, primary: primary?.runtime === 'legacy' ? primary.local : null,
        names: { [adapter]: config.agents.names?.legacy || {} } } };
    return fileEnv(projected, secrets ? { version: 2, sessionSecret: secrets.sessionSecret, runtimeToken: selected ? secrets.runtimes[selected.id]?.runtimeToken ?? null : null } : null);
  }
  const out = {};
  const set = (k, v) => { if (v != null && v !== '') out[k] = String(v); };
  if (config) {
    if(config.auth)set('AO_RBAC_ENABLED',config.auth.rbacEnabled?'1':'0');
    set('PORTAL_EMAIL', config.owner.email); set('PORTAL_DISPLAY_NAME', config.owner.displayName);
    if (config.owner.authSource === 'database') set('AO_AUTH_DATABASE', '1');
    if (config.agents.names) set('AO_AGENT_NAMES', JSON.stringify(config.agents.names[config.runtime.adapter] || {}));
    if (config.network) { set('HOST', config.network.host); set('PORT', config.network.port); set('AO_PUBLIC_URL', config.network.publicUrl); set('PORTAL_COOKIE_SECURE', config.network.cookieSecure ? '1' : '0'); }
    if (config.access) set('AO_ALLOWED_ORIGINS', JSON.stringify(config.access.uiOrigins));
    set('AO_INSTANCE_NAME', config.instance.name); set('AO_LOCALE', config.instance.locale); set('AO_TIME_ZONE', config.instance.timeZone);
    set('AO_RUNTIME', config.runtime.adapter); set('AO_PRIMARY_AGENT', config.agents.primary);
    Object.assign(out, require('./adapters').adapterById(config.runtime.adapter).setup.env({ runtime: config.runtime, token: secrets?.runtimeToken }));
    if (Array.isArray(config.enrichers)) out.AO_ENRICHERS = config.enrichers.join(',');   // [] = none (an empty string is meaningful)
    if (config.integrations) out.AO_INTEGRATIONS = config.integrations.projet === false ? 'none' : 'projet';
  }
  if (secrets) { set('PORTAL_SECRET', secrets.sessionSecret); set('PORTAL_PASSWORD_HASH', secrets.passwordHash); }
  return out;
}

/** env → file → defaults: every variable the env sets (even to '') wins over the file. */
function effectiveEnv(env, { config, secrets }) {
  const out = fileEnv(config, secrets);
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  if (completeEnvLogin(env)) {
    for (const k of LOGIN_ENV) if (env[k] === undefined) delete out[k];
    delete out.AO_AUTH_DATABASE;
  } else if (LOGIN_ENV.some(k => env[k] !== undefined)) {
    throw new ConfigError('environment', [{ path: '$', detail: 'incomplete environment login: ' + LOGIN_ENV.filter(k => env[k] !== undefined).join(', ') }]);
  }

  if (config?.version === 3) {
    if (!config.runtimes.some(r => r.id === 'legacy') && Object.keys(env).some(k => k === 'AO_RUNTIME' || k === 'AO_PRIMARY_AGENT' || k.startsWith('AO_AGENT_') || ['OC_GATEWAY_TOKEN', 'OC_GATEWAY_URL'].includes(k))) {
      throw new ConfigError('environment', [{ path: '$.runtimes', detail: 'legacy runtime overrides require the legacy instance' }]);
    }
    const legacy = config.runtimes.find(r => r.id === 'legacy');
    if (legacy) require('./adapters').adapterById(legacy.adapter).setup.overrideEnv?.({ env, runtime: nativeRuntime(legacy), effective: out });
  } else if (config?.agents.names && env.AO_AGENT_NAMES === undefined) {
    const selected = out.AO_RUNTIME || require('./adapters').defaultAdapter().definition.id;
    out.AO_AGENT_NAMES = JSON.stringify(config.agents.names[selected] || {});
  }
  if (config && config.version !== 3) require('./adapters').adapterById(config.runtime.adapter).setup.overrideEnv?.({ env, runtime: config.runtime, effective: out });
  return out;
}

const nativeRuntime = ({ id, enabled, name, ...native }) => native;
// Pure upgrade: reading v2 never publishes or changes the caller's object.
function upgradeV2(config, secrets) {
  if (config.version === 3) return { config: structuredClone(config), secrets: secrets && structuredClone(secrets) };
  if (config.version !== 2) throw new ConfigError('configuration', [{ path: '$.version', detail: 'database owner migration required before v3' }]);
  const { runtime, ...other } = structuredClone(config), adapter = runtime.adapter;
  const agents = { ...other.agents,
    primary: other.agents.primary ? scopedId('legacy', 'agent', other.agents.primary) : null,
    looks: Object.fromEntries(Object.entries(other.agents.looks || {}).map(([key, value]) => [key === 'primary' ? key : scopedId('legacy', 'agent', key.replace(/^agent:/, '')), value])) };
  for (const key of ['names', 'hidden', 'configured']) if (other.agents[key]) agents[key] = { legacy: other.agents[key][adapter] || (key === 'names' ? {} : []) };
  return { config: { ...other, version: 3, runtimes: [{ id: 'legacy', enabled: true, ...runtime }], agents },
    secrets: secrets ? { version: 3, sessionSecret: secrets.sessionSecret, runtimes: { legacy: { runtimeToken: secrets.runtimeToken } } } : null };
}

// Resolve each source independently. Legacy env overrides cannot leak a token
// into another gateway. Child cfgs deliberately contain no runtime collection.
function runtimeInstances(base, files, env = {}) {
  const upgraded = files.config?.version === 2 ? upgradeV2(files.config, files.secrets) : files;
  if (!upgraded.config || upgraded.config.version !== 3) return null;
  const config = upgraded.config;
  return config.runtimes.map(entry => {
    const A = require('./adapters').adapterById(entry.adapter), token = upgraded.secrets?.runtimes[entry.id]?.runtimeToken ?? null;
    const adapterEnv = A.setup.env({ runtime: nativeRuntime(entry), token });
    const scopedEnv = { HOME: env.HOME || os.homedir(), ...adapterEnv, ...(entry.id === 'legacy' ? env : {}) };
    if (entry.id === 'legacy') A.setup.overrideEnv?.({ env, runtime: nativeRuntime(entry), effective: scopedEnv });
    const kind = scopedEnv.AO_RUNTIME || entry.adapter;
    if (kind !== entry.adapter && !scopedEnv.OC_GATEWAY_TOKEN) throw new ConfigError('environment', [{ path: '$.runtimes', detail: 'adapter override requires its explicit credential' }]);
    const child = require('./config').tryLoadConfig({ PORTAL_EMAIL: base.loginEmail, PORTAL_SECRET: base.sessionSecret,
      AO_AUTH_DATABASE: base.authDatabase ? '1' : undefined, PORTAL_PASSWORD_HASH: base.passwordHash || undefined,
      PORTAL_PASSWORD: base.loginPassword || undefined, AO_ENV: base.instance, AO_DATA_DIR: base.dataDir,
      AO_RUNTIME: kind, ...scopedEnv });
    const primary = parseId(config.agents.primary, 'agent');
    return { id: entry.id, name:entry.name, adapter: kind, enabled: entry.enabled, config: nativeRuntime(entry), cfg: { ...child, ...base,
      gatewayUrl: child.gatewayUrl, gatewayToken: child.gatewayToken, ...A.paths?.(scopedEnv),
      runtimeAdapter: kind, demoSeed: child.demoSeed,
      primaryAgent: primary?.runtime === entry.id ? primary.local : null,
      agentNames: entry.id === 'legacy' && env.AO_AGENT_NAMES !== undefined ? JSON.parse(env.AO_AGENT_NAMES) : config.agents.names?.[entry.id] || {},
      hiddenAgents: config.agents.hidden?.[entry.id] || [], configuredAgents: config.agents.configured?.[entry.id] || null,
      runtimeId: entry.id, runtimeConfig: nativeRuntime(entry) } };
  });
}

const completeEnvLogin = env => !!(env.PORTAL_EMAIL && env.PORTAL_SECRET && (env.PORTAL_PASSWORD_HASH || env.PORTAL_PASSWORD));
const envConfigured = (env) => LOGIN_ENV.some((k) => env[k] !== undefined && env[k] !== '');
const isConfigured = (eff) => !!(eff.PORTAL_EMAIL && eff.PORTAL_SECRET && (eff.AO_AUTH_DATABASE === '1' || eff.PORTAL_PASSWORD_HASH || eff.PORTAL_PASSWORD));

/**
 * The setup state (api.md §5.7): 'readonly' on a read-only instance; 'locked' once configured, by the file OR by the
 * env (any login variable in the env locks it, even incomplete: the operator configures by env); else 'open'.
 */
function setupState(env, files) {
  if (env.PORTAL_READONLY === '1') return 'readonly';
  if (envConfigured(env) || isConfigured(effectiveEnv(env, files)) || files.config || files.secrets) return 'locked';
  return 'open';
}

// Schema validation stays here; setup and settings share the single safe publisher.
const acquirePublishLock = dir => require('./ops/config-publisher').acquirePublishLock(dir);
function writeInstanceConfig(paths, config, secrets, options = {}) {
  if (config.version !== secrets.version) throw new ConfigError(paths.secrets, [{ path: '$.version', message: 'must match config version' }]);
  for (const [file, schema, v] of [[paths.file, ConfigSchema, config], [paths.secrets, SecretsSchema, secrets]]) {
    const r = s.validate(versionedSchema(schema, v), v);
    if (!r.ok) throw new ConfigError(file, safeIssues(r.issues || []));
  }
  return require('./ops/config-publisher').publish(paths, config, secrets, options);
}

/**
 * R21-01: the secret file, its directory and the data dir are private. Ours and too open → fixed (0600 / 0700) with a
 * warning naming what was fixed; someone else's and too open → refused (EPERMS) with the command to run. Never silent.
 */
function securePermissions({ paths, dataDir = null, uid = process.getuid ? process.getuid() : null, warn = () => {} }) {
  const targets = [[paths.secrets, 0o600, 'file'], [path.dirname(paths.secrets), 0o700, 'directory'], [paths.file, 0o600, 'file']];
  if (dataDir) targets.push([dataDir, 0o700, 'directory']);
  for (const [p, want, kind] of targets) {
    let st; try { st = fs.statSync(p); } catch (_) { continue; }
    const m = st.mode & 0o777;
    if ((m & 0o077) === 0) continue;
    const octal = want.toString(8);
    if (uid != null && st.uid !== uid) {
      throw Object.assign(new Error(`${p}: the ${kind} is open to other users (mode ${m.toString(8)}) and not ours to fix; run: chmod ${octal} ${p}`), { code: 'EPERMS' });
    }
    fs.chmodSync(p, want);
    warn(`Agent Office: fixed permissions of ${p} (${kind}, mode ${m.toString(8)} → ${octal}): it must not be open to other users`);
  }
}

module.exports = { VERSION, configPaths, readInstanceConfig, writeInstanceConfig, securePermissions, acquirePublishLock, effectiveEnv, fileEnv, setupState, isConfigured, envConfigured,
  LegacyConfigSchema, LegacySecretsSchema, ConfigV2Schema, SecretsV2Schema, ConfigV3Schema, SecretsV3Schema, ConfigSchema, SecretsSchema,
  upgradeV2, runtimeInstances, nativeRuntime, completeEnvLogin, ConfigError, AGENT_ID, GATEWAY_URL, EMAIL, validZone, LOGIN_ENV };
