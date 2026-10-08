'use strict';
/*
 * G11 · `agent-office doctor` (docs/guide/troubleshooting.md): read-only checks of an install, for self-hosters.
 *   environment (presence only), configuration files and permissions, the data directory and its instance, the store
 *   (integrity_check, schema version), the runtime (the adapter's own checks), the public URL and proxy headers (with
 *   --url), clock skew and disk space.
 * Read-only: it creates, fixes and migrates nothing (it reports what the server would do at start). It never prints a
 * value: messages carry names, paths, versions and closed values, and the rendered output is also filtered against
 * every secret value it can see (environment, secrets file), as a second guard.
 * Statuses: ok, info, warn, fail, skip. Exit: 0 (ok/info/skip only), 1 (a warning), 2 (a failure); usage errors: 64.
 */
const fs = require('fs');
const path = require('path');
const IC = require('../../instance-config');
const { tryLoadConfig, defaultDataDir } = require('../../config');
const { DB_FILE, listMigrations, MIGRATIONS_DIR } = require('../../store/db');
const { SERVER_LOCK } = require('../lock');
const { format } = require('./messages');

const GROUPS = ['env', 'files', 'data', 'store', 'runtime', 'url', 'host'];
const STATUSES = ['ok', 'info', 'warn', 'fail', 'skip'];
const LOGIN = ['PORTAL_EMAIL', 'PORTAL_SECRET'];
const SECRET_NAME = /SECRET|TOKEN|PASSWORD|HASH|KEY|COOKIE|CREDENTIAL/i;
const GiB = 1024 ** 3;

function exitCodeOf(checks) {
  if (checks.some((c) => c.status === 'fail')) return 2;
  if (checks.some((c) => c.status === 'warn')) return 1;
  return 0;
}

// a URL as printed: scheme, host and port only (no user info, path or query)
function originOf(u) {
  try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch (_) { return null; }
}
const isLoopbackHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(h);

// ---------------------------------------------------------------- environment and files
function checkEnv(ctx) {
  const { eff, env, files, add } = ctx;
  const sourceOf = (k) => (env[k] !== undefined && env[k] !== '' ? 'env' : 'file');
  const password = eff.PORTAL_PASSWORD_HASH ? 'PORTAL_PASSWORD_HASH' : eff.PORTAL_PASSWORD ? 'PORTAL_PASSWORD' : null;
  const present = LOGIN.filter((k) => eff[k]).concat(password ? [password] : []);
  if (!IC.isConfigured(eff) && !IC.envConfigured(env) && !files.config) add('env', 'env.login', 'info', 'env.login.setup');
  else if (present.length < 3) {
    const missing = LOGIN.filter((k) => !eff[k]).concat(password ? [] : ['PORTAL_PASSWORD_HASH']);
    add('env', 'env.login', 'fail', 'env.login.missing', { names: missing.join(', ') });
  } else {
    const sources = [...new Set(present.map(sourceOf))].map((s) => ctx.t('source.' + s)).join(', ');
    add('env', 'env.login', 'ok', 'env.login.ok', { names: present.join(', '), sources });
    if (password === 'PORTAL_PASSWORD') add('env', 'env.password', 'warn', 'env.login.plaintext');
  }
  // what loadConfig would refuse (the variable's name and a closed reason, never its value)
  if (IC.isConfigured(eff)) {
    try {
      ctx.cfg = tryLoadConfig(eff);
      add('env', 'env.config', 'ok', 'env.config.ok', { instance: ctx.cfg.instance, adapter: ctx.cfg.runtimeAdapter });
    } catch (e) {
      if (e.code !== 'ECONFIG') throw e;
      const key = ['invalid', 'missing', 'production-dir', 'readonly-production'].includes(e.reason) ? 'env.config.' + e.reason : 'env.config.invalid';
      add('env', 'env.config', 'fail', key, { variable: e.variable, instance: ctx.instance });
    }
  }
  if ((ctx.cfg ? ctx.cfg.runtimeAdapter : eff.AO_RUNTIME || 'openclaw') === 'openclaw') {
    if (eff.OC_GATEWAY_TOKEN) add('env', 'env.token', 'ok', 'env.token.ok', { source: ctx.t('source.' + sourceOf('OC_GATEWAY_TOKEN')) });
    else add('env', 'env.token', 'warn', 'env.token.missing');
  }
}

function checkFiles(ctx) {
  const { files, add } = ctx;
  if (files.error) add('files', 'files.config', 'fail', 'files.config.invalid', { detail: files.error });
  else if (files.config) add('files', 'files.config', 'ok', 'files.config.ok', { file: files.paths.file });
  else add('files', 'files.config', 'info', IC.isConfigured(ctx.eff) ? 'files.config.absent' : 'files.config.none', { file: files.paths.file });
  if (files.orphanSecrets) add('files', 'files.orphan', 'warn', 'files.config.orphan');
  // the server's own rule (instance-config.js securePermissions), reported instead of applied
  const uid = process.getuid ? process.getuid() : null;
  const targets = [[files.paths.secrets, 0o600], [path.dirname(files.paths.secrets), 0o700], [files.paths.file, 0o600],
    [ctx.dataDir, 0o700], [path.join(ctx.dataDir, DB_FILE), 0o600]];
  let checked = 0, bad = 0;
  for (const [p, want] of targets) {
    let st; try { st = fs.statSync(p); } catch (_) { continue; }
    checked++;
    const mode = st.mode & 0o777;
    if (st.isFile()) { try { fs.accessSync(p, fs.constants.R_OK); } catch (_) { bad++; add('files', 'files.perms', 'fail', 'files.perms.unreadable', { path: p }); continue; } }
    if ((mode & 0o077) === 0) continue;
    bad++;
    const ours = uid == null || st.uid === uid;
    add('files', 'files.perms', ours ? 'warn' : 'fail', ours ? 'files.perms.open-ours' : 'files.perms.open-theirs', { path: p, mode: mode.toString(8), want: want.toString(8) });
  }
  if (!bad) add('files', 'files.perms', 'ok', 'files.perms.ok', { count: checked });
}

// ---------------------------------------------------------------- data directory and store
function nearestExisting(p) { let cur = path.resolve(p); for (;;) { if (fs.existsSync(cur)) return cur; const up = path.dirname(cur); if (up === cur) return cur; cur = up; } }

function checkData(ctx) {
  const { dataDir, add } = ctx;
  let st = null; try { st = fs.statSync(dataDir); } catch (_) { /* absent */ }
  if (!st) {
    const parent = nearestExisting(dataDir);
    try { fs.accessSync(parent, fs.constants.W_OK); add('data', 'data.dir', 'info', 'data.dir.absent', { path: dataDir }); } catch (_) { add('data', 'data.dir', 'fail', 'data.dir.not-writable', { path: parent }); }
  } else if (!st.isDirectory()) add('data', 'data.dir', 'fail', 'data.dir.not-dir', { path: dataDir });
  else { try { fs.accessSync(dataDir, fs.constants.W_OK); add('data', 'data.dir', 'ok', 'data.dir.ok', { path: dataDir }); } catch (_) { add('data', 'data.dir', 'fail', 'data.dir.not-writable', { path: dataDir }); } }

  const file = path.join(dataDir, DB_FILE);
  ctx.store = null;
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) { add('data', 'data.instance', 'info', 'data.instance.new', { instance: ctx.instance }); return; }
  const { DatabaseSync } = require('node:sqlite');
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch (_) { add('store', 'store.integrity', 'fail', 'store.integrity.unreadable'); return; }
  try {
    let recorded = null, version = 0;
    try { const r = db.prepare("SELECT value FROM store_meta WHERE key = 'instance'").get(); recorded = r ? r.value : null; } catch (_) { /* a pre-store_meta schema */ }
    try { version = db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v || 0; } catch (_) { /* none */ }
    if (recorded && recorded !== ctx.instance) add('data', 'data.instance', 'fail', 'data.instance.mismatch', { recorded, instance: ctx.instance });
    else add('data', 'data.instance', 'ok', 'data.instance.ok', { instance: ctx.instance });
    // a server holds an OS lock on its data dir for its whole life (src/ops/lock.js); probed only if the lock file exists
    const lock = path.join(dataDir, SERVER_LOCK);
    if (fs.existsSync(lock)) {
      let running = false;
      try { const l = new DatabaseSync(lock, { timeout: 0 }); try { l.exec('BEGIN IMMEDIATE'); l.exec('ROLLBACK'); } catch (e) { running = /locked|busy/i.test(String(e.message)); } finally { l.close(); } } catch (_) { /* unreadable: say nothing */ }
      add('data', 'data.server', 'info', running ? 'data.server.running' : 'data.server.stopped');
    }
    let ok = false; try { const r = db.prepare('PRAGMA integrity_check').get(); ok = !!r && Object.values(r)[0] === 'ok'; } catch (_) { ok = false; }
    add('store', 'store.integrity', ok ? 'ok' : 'fail', ok ? 'store.integrity.ok' : 'store.integrity.fail');
    const migrations = listMigrations(MIGRATIONS_DIR);
    const known = migrations.length ? migrations[migrations.length - 1].version : 0;
    if (version === known) add('store', 'store.schema', 'ok', 'store.schema.ok', { version });
    else if (version < known) add('store', 'store.schema', 'info', 'store.schema.older', { version, known });
    else add('store', 'store.schema', 'fail', 'store.schema.newer', { version, known });
  } finally { db.close(); }
}

// ---------------------------------------------------------------- public URL
async function checkUrl(ctx, url, apiBase) {
  const { add, fetchImpl, timeoutMs } = ctx;
  const origin = originOf(url);
  if (!origin) { add('url', 'url.reach', 'fail', 'url.reach.fail', { url: '(invalid URL)' }); return; }
  const host = new URL(origin).hostname;
  const get = async (p) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
    try { return await fetchImpl(origin + p, { redirect: 'manual', signal: ac.signal, headers: { accept: 'application/json, text/html' } }); } finally { clearTimeout(t); }
  };
  let root;
  try { root = await get('/'); add('url', 'url.reach', 'ok', 'url.reach.ok', { url: origin, status: root.status }); } catch (_) { add('url', 'url.reach', 'fail', 'url.reach.fail', { url: origin }); return; }
  const tls = new URL(origin).protocol === 'https:';
  if (tls) add('url', 'url.tls', 'ok', 'url.tls.ok');
  else add('url', 'url.tls', isLoopbackHost(host) ? 'info' : 'warn', isLoopbackHost(host) ? 'url.tls.loopback' : 'url.tls.plain');
  if (tls) add('url', 'url.hsts', root.headers.get('strict-transport-security') ? 'ok' : 'info', root.headers.get('strict-transport-security') ? 'url.hsts.ok' : 'url.hsts.missing');
  const date = Date.parse(root.headers.get('date') || '');
  if (Number.isFinite(date)) {
    const s = Math.round(Math.abs(ctx.now() - date) / 1000);
    add('url', 'url.clock', s > 60 ? 'warn' : 'ok', s > 60 ? 'url.clock.warn' : 'url.clock.ok', { seconds: s });
  }
  // the API base: the one given, else the configured one, else the usual ones
  const bases = [...new Set([apiBase, ctx.eff.AO_PUBLIC_API_BASE, '/backend', ''].filter((b) => typeof b === 'string').map((b) => b.replace(/\/+$/, '')))];
  let base = null;
  for (const b of bases) {
    try { const r = await get(b + '/healthz'); const j = await r.json().catch(() => null); if (r.status === 200 && j && j.status === 'ok') { base = b; break; } } catch (_) { /* next */ }
  }
  if (base === null) { add('url', 'url.api', 'fail', 'url.api.missing', { url: origin, tried: bases.map((b) => (b || '/') ).join(', ') }); }
  else {
    add('url', 'url.api', 'ok', 'url.api.ok', { url: origin + (base || '/') });
    try {
      const r = await get(base + '/healthz/proxy');
      const j = r.status === 200 ? await r.json().catch(() => null) : null;
      const v = j && j.request;
      if (!v) add('url', 'url.proxy', 'skip', 'url.proxy.unsupported');
      else if (tls && !v.secure) add('url', 'url.proxy', 'warn', 'url.proxy.insecure');
      else if (v.forwarded === 'untrusted') add('url', 'url.proxy', 'warn', 'url.proxy.untrusted');
      else if (v.forwarded === 'none') add('url', 'url.proxy', 'info', 'url.proxy.none');
      else add('url', 'url.proxy', 'ok', 'url.proxy.ok');
    } catch (_) { add('url', 'url.proxy', 'skip', 'url.proxy.unsupported'); }
  }
  const configured = ctx.eff.AO_PUBLIC_URL ? originOf(ctx.eff.AO_PUBLIC_URL) : null;
  if (configured && configured === origin) add('url', 'url.public', 'ok', 'url.public.ok', { origin });
  else if (configured) add('url', 'url.public', 'warn', 'url.public.mismatch', { configured, origin });
  else if (!isLoopbackHost(host)) add('url', 'url.public', 'warn', 'url.public.unset', { origin });
}

// ---------------------------------------------------------------- host
function checkHost(ctx) {
  const { add } = ctx;
  try {
    const st = fs.statfsSync(nearestExisting(ctx.dataDir));
    const free = st.bavail * st.bsize, total = st.blocks * st.bsize;
    const percent = total ? Math.round((free / total) * 100) : 0;
    const p = { free: (free / GiB).toFixed(1), percent };
    if (free < 256 * 1024 * 1024) add('host', 'host.disk', 'fail', 'host.disk.critical', p);
    else if (free < GiB || percent < 5) add('host', 'host.disk', 'warn', 'host.disk.low', p);
    else add('host', 'host.disk', 'ok', 'host.disk.ok', p);
  } catch (_) { /* statfs unavailable: nothing to say */ }
  const major = Number(process.versions.node.split('.')[0]);
  add('host', 'host.node', major >= 24 ? 'ok' : 'fail', major >= 24 ? 'host.node.ok' : 'host.node.old', { version: process.versions.node });
}

// ---------------------------------------------------------------- the secret filter (second guard)
function secretValues(env, files) {
  const out = new Set();
  for (const [k, v] of Object.entries(env)) if (SECRET_NAME.test(k) && typeof v === 'string' && v.length >= 4) out.add(v);
  if (files && files.secrets) for (const v of Object.values(files.secrets)) if (typeof v === 'string' && v.length >= 4) out.add(v);
  return [...out].sort((a, b) => b.length - a.length);
}
// R33: every string in the secrets files the doctor can see (the given and the default location), read raw for the
// filter only: an orphan, an invalid or an overridden secrets file still never reaches the output
function secretFileValues(env) {
  const e0 = Object.assign({}, env); delete e0.AO_CONFIG;
  const out = [];
  for (const p of new Set([IC.configPaths(env).secrets, IC.configPaths(e0).secrets])) {
    let v; try { v = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { continue; }
    const walk = (x) => { if (typeof x === 'string') { if (x.length >= 4) out.push(x); } else if (x && typeof x === 'object') Object.values(x).forEach(walk); };
    walk(v);
  }
  return out;
}
const scrub = (text, secrets) => secrets.reduce((t, s) => t.split(s).join('[redacted]'), text);

/**
 * → { version, instance, locale, checks: [{ group, id, status, key, params, message }], summary, exitCode }
 * opts: { env, url, apiBase, locale, skipRuntime, timeoutMs, now, fetchImpl, dataDir, configFile }
 */
async function runDoctor(opts = {}) {
  const env = Object.assign({}, opts.env || process.env, opts.configFile ? { AO_CONFIG: opts.configFile } : {});
  let files;
  try { files = IC.readInstanceConfig(env); } catch (e) {
    files = { paths: IC.configPaths(env), config: null, secrets: null, orphanSecrets: false, error: e.message };
  }
  const eff = IC.effectiveEnv(env, files.error ? { config: null, secrets: null } : files);
  const named = eff.AO_ENV || (eff.PORTAL_READONLY === '1' ? 'staging' : eff.NODE_ENV === 'production' ? 'production' : 'dev');
  const instance = ['production', 'staging', 'dev', 'test'].includes(named) ? named : '?';   // an invalid AO_ENV is reported by name (env.config), not echoed
  const localeOf = (x) => { const l = String(x || '').toLowerCase().split(/[-_.]/)[0]; return l === 'fr' || l === 'en' ? l : null; };
  const locale = localeOf(opts.locale) || localeOf(eff.AO_LOCALE) || localeOf(env.LC_ALL) || localeOf(env.LANG) || 'fr';
  const checks = [];
  const ctx = {
    env, eff, files, instance, locale, cfg: null,
    dataDir: path.resolve(opts.dataDir || eff.AO_DATA_DIR || defaultDataDir(eff, instance === '?' ? 'dev' : instance)),
    timeoutMs: opts.timeoutMs || 8000, now: opts.now || Date.now, fetchImpl: opts.fetchImpl || fetch,
    t: (key, params) => format(locale, key, params),
    add: (group, id, status, key, params = {}) => checks.push({ group, id, status, key, params }),
  };
  checkEnv(ctx);
  for (const x of opts.envFileIssues || []) ctx.add('env', 'env.file', 'warn', x.key ? 'env.file.key' : 'env.file.line', { line: x.line, key: x.key });
  checkFiles(ctx);
  checkData(ctx);
  const adapterId = ctx.cfg ? ctx.cfg.runtimeAdapter : (eff.AO_RUNTIME || 'openclaw');
  if (opts.skipRuntime) ctx.add('runtime', 'runtime', 'skip', 'runtime.skipped');
  else {
    let adapter = null; try { adapter = require('../../adapters').adapterById(adapterId); } catch (_) { /* reported by env.config */ }
    if (adapter && adapter.doctor) await adapter.doctor(ctx);
  }
  if (opts.url) await checkUrl(ctx, opts.url, opts.apiBase);
  checkHost(ctx);

  const secrets = [...new Set(secretValues(Object.assign({}, env, eff), files).concat(secretFileValues(env)))].sort((a, b) => b.length - a.length);
  for (const c of checks) {
    c.message = scrub(ctx.t(c.key, c.params), secrets);
    for (const k of Object.keys(c.params)) if (typeof c.params[k] === 'string') c.params[k] = scrub(c.params[k], secrets);
  }
  checks.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
  const summary = Object.fromEntries(STATUSES.map((s) => [s, checks.filter((c) => c.status === s).length]));
  return { version: 1, instance, locale, checks, summary, exitCode: exitCodeOf(checks), secrets };
}

const MARK = { ok: '✓', info: 'i', warn: '!', fail: '✗', skip: '-' };
function renderText(report) {
  const t = (k, p) => format(report.locale, k, p);
  const lines = [t('title', { instance: report.instance })];
  let group = null;
  for (const c of report.checks) {
    if (c.group !== group) { group = c.group; lines.push('', t('group.' + group)); }
    lines.push(`  ${MARK[c.status]} ${c.message}`);
  }
  lines.push('', t('summary', Object.assign({ exit: report.exitCode }, report.summary)));
  return scrub(lines.join('\n'), report.secrets) + '\n';
}
function renderJson(report) {
  const { secrets, ...rest } = report;
  return scrub(JSON.stringify(rest, null, 2), secrets) + '\n';
}

module.exports = { runDoctor, renderText, renderJson, exitCodeOf, originOf, secretValues, secretFileValues, scrub, GROUPS, STATUSES };
