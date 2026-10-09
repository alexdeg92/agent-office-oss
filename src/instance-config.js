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

const VERSION = 2;
// A complete login replaces file auth. A secret-only override preserves the file auth mode.
const LOGIN_ENV = ['PORTAL_EMAIL', 'PORTAL_SECRET', 'PORTAL_PASSWORD_HASH', 'PORTAL_PASSWORD'];
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GATEWAY_URL = /^wss?:\/\/[^\s/?#]+(:\d{1,5})?(\/[^\s]*)?$/;
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}$/;
const validZone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch (_) { return false; } };

const str = (min, max) => s.string().min(min).max(max);
const Look = s.object({ character: str(1, 64), variant: str(1, 64).nullable(), accessories: s.array(str(1, 64)).max(8) }, { extra: 'reject' });
const ConfigShape = {
  version: s.literal(1),
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
  agents: s.object({ primary: s.string().refine(v => AGENT_ID.test(v), 'agent id').nullable(), looks: s.record(Look), names: s.record(s.record(str(1, 80))).optional() }, { extra: 'reject' }),
  network: s.object({ mode: s.enumOf(['local', 'lan', 'tailnet', 'public', 'tunnel']), host: str(1, 255), port: s.int().min(1).max(65535), publicUrl: s.string().nullable(), cookieSecure: s.boolean() }, { extra: 'reject' }).optional(),
}, { extra: 'reject' });
const ConfigSchema = s.union([LegacyConfigSchema, ConfigV2Schema]);
const secretShape = { sessionSecret: str(32, 256), runtimeToken: str(1, 4096).nullable() };
const LegacySecretsSchema = s.object({ version: s.literal(1), ...secretShape, passwordHash: s.string().refine(isHash, 'scrypt hash') }, { extra: 'reject' });
const SecretsV2Schema = s.object({ version: s.literal(2), ...secretShape }, { extra: 'reject' });
const SecretsSchema = s.union([LegacySecretsSchema, SecretsV2Schema]);
function versionedSchema(schema, value) {
  if (schema !== ConfigSchema && schema !== SecretsSchema) return schema;
  if (value?.version !== 1 && value?.version !== 2) throw new ConfigError('configuration', [{ path: '$.version', detail: 'unsupported config version; supported: 1, 2' }]);
  return schema === ConfigSchema ? (value.version === 1 ? LegacyConfigSchema : ConfigV2Schema) : (value.version === 1 ? LegacySecretsSchema : SecretsV2Schema);
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
  const out = {};
  const set = (k, v) => { if (v != null && v !== '') out[k] = String(v); };
  if (config) {
    set('PORTAL_EMAIL', config.owner.email); set('PORTAL_DISPLAY_NAME', config.owner.displayName);
    if (config.owner.authSource === 'database') set('AO_AUTH_DATABASE', '1');
    if (config.agents.names) set('AO_AGENT_NAMES', JSON.stringify(config.agents.names[config.runtime.adapter] || {}));
    if (config.network) { set('HOST', config.network.host); set('PORT', config.network.port); set('AO_PUBLIC_URL', config.network.publicUrl); set('PORTAL_COOKIE_SECURE', config.network.cookieSecure ? '1' : '0'); }
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

  if (config?.agents.names && env.AO_AGENT_NAMES === undefined) {
    const selected = out.AO_RUNTIME || require('./adapters').defaultAdapter().definition.id;
    out.AO_AGENT_NAMES = JSON.stringify(config.agents.names[selected] || {});
  }
  if (config) require('./adapters').adapterById(config.runtime.adapter).setup.overrideEnv?.({ env, runtime: config.runtime, effective: out });
  return out;
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

// One file: a private temporary (0600, fsynced), then link() to the final name. link() refuses an existing name, so a
// publication never overwrites a file (R21-03: exclusive); the temporary is always removed.
function publishFile(file, value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try { fs.writeSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ } }
}
// R22-01: the publication lock is an OS lock, not a file convention. A SQLite write transaction (BEGIN IMMEDIATE) on
// `.publish-lock.sqlite` in the config dir: acquiring it is atomic, a live owner can never be robbed (there is nothing
// to "take over"), and the OS releases it when its owner exits or dies, so no staleness rule is needed.
const LOCK_DB = '.publish-lock.sqlite';
function acquirePublishLock(dir) {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(dir, LOCK_DB);
  try { fs.closeSync(fs.openSync(file, 'a', 0o600)); fs.chmodSync(file, 0o600); } catch (_) { /* opened below; reported there */ }
  const db = new DatabaseSync(file, { timeout: 0 });
  try { db.exec('BEGIN IMMEDIATE'); } catch (e) {
    db.close();
    if (/locked|busy/i.test(String(e.message))) throw Object.assign(new Error('another publication is in progress'), { code: 'EBUSY' });
    throw e;
  }
  let released = false;
  return () => { if (released) return; released = true; try { db.exec('ROLLBACK'); } finally { db.close(); } };
}
/**
 * Publishes both files (R21-03, R22-01), recoverably and exclusively:
 *   1. the lock (one publisher at a time, an OS lock: acquirePublishLock); 2. a committed config.json → EEXIST (never overwritten);
 *   3. an orphan secrets.json (an interrupted publication: no commit) is removed; 4. secrets.json; 5. config.json, the
 *   commit marker, last. A crash before 5 leaves an uncommitted state that boot ignores and the next setup replaces.
 */
function writeInstanceConfig(paths, config, secrets, { replace = false } = {}) {
  if (config.version !== secrets.version) throw new ConfigError(paths.secrets, [{ path: '$.version', message: 'must match config version' }]);
  for (const [file, schema, v] of [[paths.file, ConfigSchema, config], [paths.secrets, SecretsSchema, secrets]]) {
    const r = s.validate(versionedSchema(schema, v), v);
    if (!r.ok) throw new ConfigError(file, safeIssues(r.issues || []));
  }
  const dir = path.dirname(paths.file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);   // mkdir's mode is masked by umask and leaves an existing directory as it was
  const release = acquirePublishLock(dir);
  try {
    if (!replace && fs.existsSync(paths.file)) throw Object.assign(new Error('already configured'), { code: 'EEXIST' });
    if (!replace && fs.existsSync(paths.secrets)) fs.unlinkSync(paths.secrets);
    if (replace) {
      const safe = require('./ops/safe-fs');
      safe.mutate(paths.secrets, { type: 'write', text: JSON.stringify(secrets, null, 2) + '\n', mode: 0o600 });
      safe.mutate(paths.file, { type: 'write', text: JSON.stringify(config, null, 2) + '\n', mode: 0o600 });
    } else { publishFile(paths.secrets, secrets); publishFile(paths.file, config); }
    try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch (_) { /* best effort */ }
  } finally { release(); }
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
  LegacyConfigSchema, LegacySecretsSchema, ConfigV2Schema, SecretsV2Schema, ConfigSchema, SecretsSchema, completeEnvLogin, ConfigError, AGENT_ID, GATEWAY_URL, EMAIL, validZone, LOGIN_ENV };
