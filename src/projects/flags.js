'use strict';

const path = require('node:path');
const { parseGithubRef, resolveInside } = require('./sources/refs');

const MAX_FLAG_BYTES = 256 * 1024;
const MAX_FLAGS = 100;
const KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/;
const ENV_KEY = /^(?:export\s+)?(FEATURE_[A-Za-z0-9_]+|FF_[A-Za-z0-9_]+|ENABLE_[A-Za-z0-9_]+)\s*=\s*(.*)$/;
const CONFIG_NAME = /^[A-Za-z0-9._-]+\.json$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

const CANDIDATES = Object.freeze([
  '.env.example',
  'flags.json',
  'feature-flags.json',
  'features.json',
  'package.json',
  'unleash.json',
  '.unleashrc.json',
  'growthbook.json',
  'launchdarkly.json',
  '.launchdarkly/flags.json',
  'flagsmith.json',
  'openfeature.json',
  '.openfeature.json',
]);

const ROOT_MAP_FILES = new Set(['flags.json', 'feature-flags.json', 'features.json']);
const SDK_FILES = new Set([
  'unleash.json',
  '.unleashrc.json',
  'growthbook.json',
  'launchdarkly.json',
  'flagsmith.json',
  'openfeature.json',
  '.openfeature.json',
]);

function inside(root, abs) {
  return abs === root || abs.startsWith(root + path.sep);
}

function isSecretName(base) {
  const name = String(base || '').toLowerCase();
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return true;
  if (name.endsWith('.pem') || name === 'id_rsa' || name === 'id_ed25519') return true;
  return /(secret|credential|password|token)/.test(name);
}

function safeKey(key) {
  return typeof key === 'string' && KEY.test(key);
}

function flagParseError() {
  const err = new Error('flag-parse');
  err.code = 'flag-parse';
  return err;
}

function entry(key, state, source, line, detectedAt) {
  return { key, state, source, line, detectedAt };
}

function mergeFlags(list) {
  const map = new Map();
  for (const flag of list) {
    const prev = map.get(flag.key);
    if (!prev || (prev.state === 'unknown' && flag.state !== 'unknown')) map.set(flag.key, flag);
  }
  return [...map.values()];
}

function finish(list) {
  return mergeFlags(list)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, MAX_FLAGS);
}

function envState(raw) {
  let value = String(raw ?? '').trim();
  const quoted = value.match(/^(['"])([\s\S]*)\1(?:\s+#.*)?$/);
  if (quoted) value = quoted[2];
  else value = value.split(/\s+#/)[0].trim();
  if (/^true$/i.test(value)) return 'on';
  if (/^false$/i.test(value)) return 'off';
  return 'unknown';
}

function parseEnv(text, source, detectedAt) {
  const out = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = ENV_KEY.exec(trimmed);
    if (!match || !safeKey(match[1])) continue;
    out.push(entry(match[1], envState(match[2]), source, i + 1, detectedAt));
  }
  return mergeFlags(out);
}

function booleanOf(value) {
  if (value === true || value === false) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.enabled === 'boolean') return value.enabled;
  if (typeof value.on === 'boolean') return value.on;
  if (typeof value.defaultValue === 'boolean') return value.defaultValue;
  if (value.variants && typeof value.defaultVariant === 'string') {
    const variant = value.variants[value.defaultVariant];
    if (typeof variant === 'boolean') return variant;
  }
  return null;
}

function jsonState(value) {
  const bool = booleanOf(value);
  if (bool === true) return 'on';
  if (bool === false) return 'off';
  return 'unknown';
}

function isPlain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fromMap(map, source, detectedAt) {
  if (!isPlain(map)) return [];
  const out = [];
  for (const [key, value] of Object.entries(map)) {
    if (!safeKey(key)) continue;
    out.push(entry(key, jsonState(value), source, null, detectedAt));
  }
  return out;
}

function fromFeatureList(list, source, detectedAt) {
  const out = [];
  for (const item of list) {
    if (!isPlain(item)) continue;
    const key = typeof item.name === 'string' ? item.name : (typeof item.key === 'string' ? item.key : '');
    if (!safeKey(key)) continue;
    const state = typeof item.enabled === 'boolean' ? (item.enabled ? 'on' : 'off') : 'unknown';
    out.push(entry(key, state, source, null, detectedAt));
  }
  return out;
}

function fromFlagList(list, source, detectedAt) {
  const out = [];
  for (const item of list) {
    if (!isPlain(item)) continue;
    const named = item.feature && typeof item.feature.name === 'string' ? item.feature.name : '';
    const key = named || (typeof item.key === 'string' ? item.key : (typeof item.name === 'string' ? item.name : ''));
    if (!safeKey(key)) continue;
    let state = 'unknown';
    if (typeof item.enabled === 'boolean') state = item.enabled ? 'on' : 'off';
    else if (typeof item.on === 'boolean') state = item.on ? 'on' : 'off';
    else if (typeof item.feature_state_value === 'boolean') state = item.feature_state_value ? 'on' : 'off';
    out.push(entry(key, state, source, null, detectedAt));
  }
  return out;
}

function hasContainer(doc) {
  return doc.featureFlags != null || doc.features != null || doc.flags != null || doc.flagValues != null;
}

function parseMode(fileRel) {
  const base = path.posix.basename(fileRel);
  if (isSecretName(base) || fileRel.split('/').some((part) => isSecretName(part) && part !== base)) return 'skip';
  if (base === '.env.example') return 'env';
  if (base === 'package.json') return 'featureFlags';
  const config = fileRel.startsWith('config/') && fileRel.split('/').length === 2;
  if (config && !ROOT_MAP_FILES.has(base) && !SDK_FILES.has(base)) return 'featureFlags';
  if (ROOT_MAP_FILES.has(base) || SDK_FILES.has(base)) return 'document';
  return 'skip';
}

function parseFlagText(fileRel, text, detectedAt, source = fileRel) {
  const mode = parseMode(fileRel);
  if (mode === 'skip') return [];
  const stored = typeof source === 'string' && source.length >= 1 && source.length <= 300 && !source.split('/').includes('..')
    ? source
    : null;
  if (!stored) return [];
  if (mode === 'env') return parseEnv(text, stored, detectedAt);
  const body = String(text).charCodeAt(0) === 0xfeff ? String(text).slice(1) : String(text);
  if (!body.trim()) return [];
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    throw flagParseError();
  }
  if (mode === 'featureFlags') return fromMap(doc && doc.featureFlags, stored, detectedAt);
  return fromDocument(doc, stored, detectedAt, ROOT_MAP_FILES.has(path.posix.basename(fileRel)));
}

function fromDocument(doc, source, detectedAt, rootMap) {
  if (!isPlain(doc)) return [];
  const out = [];
  if (isPlain(doc.featureFlags)) out.push(...fromMap(doc.featureFlags, source, detectedAt));
  if (Array.isArray(doc.features)) out.push(...fromFeatureList(doc.features, source, detectedAt));
  else if (isPlain(doc.features)) out.push(...fromMap(doc.features, source, detectedAt));
  if (Array.isArray(doc.flags)) out.push(...fromFlagList(doc.flags, source, detectedAt));
  else if (isPlain(doc.flags)) out.push(...fromMap(doc.flags, source, detectedAt));
  if (isPlain(doc.flagValues)) out.push(...fromMap(doc.flagValues, source, detectedAt));
  if (!out.length && rootMap && !hasContainer(doc)) out.push(...fromMap(doc, source, detectedAt));
  return mergeFlags(out);
}

async function attempt(fn, arg) {
  try {
    return { value: await fn(arg) };
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'ENOTSUP')) return { missing: true };
    if (err && err.code === 'flag-parse') return { parse: true };
    return { error: true };
  }
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return null;
}

async function readContained(rootReal, abs, fs) {
  const st = await attempt(fs.lstat, abs);
  if (st.missing) return { missing: true };
  if (st.error || !st.value || (typeof st.value.isFile !== 'function')) return { error: true };
  if (!st.value.isFile() && !st.value.isSymbolicLink()) return { missing: true };
  const real = await attempt(fs.realpath, abs);
  if (real.missing) return { missing: true };
  if (real.error || typeof real.value !== 'string') return { error: true };
  if (!inside(rootReal, real.value)) return { missing: true };
  const body = await attempt(fs.readFile, real.value);
  if (body.missing) return { missing: true };
  if (body.parse) return { parse: true };
  if (body.error) return { error: true };
  const text = asText(body.value);
  if (text == null) return { missing: true };
  if (Buffer.byteLength(text) > MAX_FLAG_BYTES) return { missing: true };
  return { text };
}

async function listConfig(rootReal, folderAbs, fs) {
  const abs = path.join(folderAbs, 'config');
  const st = await attempt(fs.lstat, abs);
  if (st.missing) return { names: [] };
  if (st.error || !st.value) return { error: true };
  if (!st.value.isDirectory() && !st.value.isSymbolicLink()) return { names: [] };
  const real = await attempt(fs.realpath, abs);
  if (real.missing) return { names: [] };
  if (real.error || typeof real.value !== 'string') return { error: true };
  if (!inside(rootReal, real.value)) return { names: [] };
  const listed = await attempt(fs.readdir, real.value);
  if (listed.missing) return { names: [] };
  if (listed.error || !Array.isArray(listed.value)) return { error: true };
  const names = [];
  for (const name of listed.value) {
    if (typeof name !== 'string' || !CONFIG_NAME.test(name) || isSecretName(name)) continue;
    names.push(name);
  }
  names.sort();
  return { names };
}

async function scanWorkspace({ root, rel, fs, at }) {
  if (!root || !fs || typeof fs.lstat !== 'function' || typeof fs.realpath !== 'function' || typeof fs.readFile !== 'function') {
    return { error: true, flags: [] };
  }
  let located;
  try {
    located = resolveInside(root, rel);
  } catch {
    return { error: true, flags: [] };
  }
  const rootReal = await attempt(fs.realpath, path.resolve(root));
  if (rootReal.error || rootReal.missing || typeof rootReal.value !== 'string') return { error: true, flags: [] };
  const folderReal = await attempt(fs.realpath, located.abs);
  if (folderReal.missing || folderReal.error || typeof folderReal.value !== 'string') return { error: true, flags: [] };
  if (!inside(rootReal.value, folderReal.value)) return { error: true, flags: [] };
  const flags = [];
  const files = CANDIDATES.slice();
  const config = await listConfig(rootReal.value, located.abs, fs);
  if (config.error) return { error: true, flags: [] };
  for (const name of config.names || []) files.push(`config/${name}`);
  for (const fileRel of files) {
    if (fileRel.split('/').includes('..')) continue;
    const abs = path.join(located.abs, ...fileRel.split('/'));
    const read = await readContained(rootReal.value, abs, fs);
    if (read.missing) continue;
    if (read.error || read.parse) return { error: true, flags: [] };
    const stored = `${rel}/${fileRel}`;
    let parsed;
    try {
      parsed = parseFlagText(fileRel, read.text, at, stored);
    } catch (err) {
      if (err && err.code === 'flag-parse') return { error: true, flags: [] };
      throw err;
    }
    flags.push(...parsed);
  }
  return { flags };
}

function encodeRel(fileRel) {
  return fileRel.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function branchQuery(ref) {
  if (typeof ref !== 'string' || !ref || ref.includes('..') || !BRANCH.test(ref)) return '';
  return `?ref=${encodeURIComponent(ref)}`;
}

async function ghGet(exec, apiPath) {
  let result;
  try {
    result = await exec(['gh', 'api', apiPath]);
  } catch {
    return { error: true };
  }
  if (!result || result.code !== 0) {
    const text = `${result && result.stdout || ''}\n${result && result.stderr || ''}`;
    if (/\b404\b|not found/i.test(text)) return { missing: true };
    return { error: true };
  }
  const raw = String(result.stdout ?? '');
  const start = raw.search(/[[{]/);
  if (start < 0) return { error: true };
  try {
    return { json: JSON.parse(raw.slice(start)) };
  } catch {
    return { error: true };
  }
}

function decodeFile(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (json.type === 'dir' || json.type === 'symlink') return null;
  if (typeof json.content !== 'string') return null;
  if (json.content.length > MAX_FLAG_BYTES * 2) return null;
  if (json.encoding === 'base64') {
    const buf = Buffer.from(json.content.replace(/\s/g, ''), 'base64');
    if (buf.length > MAX_FLAG_BYTES) return null;
    return buf.toString('utf8');
  }
  if (Buffer.byteLength(json.content) > MAX_FLAG_BYTES) return null;
  return json.content;
}

async function pullGithubFile(exec, base, query, fileRel, source, at) {
  const got = await ghGet(exec, `${base}/contents/${encodeRel(fileRel)}${query}`);
  if (got.error) return { error: true, flags: [] };
  if (got.missing || Array.isArray(got.json)) return { flags: [] };
  const text = decodeFile(got.json);
  if (text == null) return { flags: [] };
  try {
    return { flags: parseFlagText(fileRel, text, at, source) };
  } catch (err) {
    if (err && err.code === 'flag-parse') return { error: true, flags: [] };
    throw err;
  }
}

async function scanGithub({ owner, repo, ref, exec, at }) {
  if (typeof exec !== 'function') return { error: true, flags: [] };
  let parsed;
  try {
    parsed = parseGithubRef({ owner, repo });
  } catch {
    return { error: true, flags: [] };
  }
  const base = `repos/${parsed.owner}/${parsed.repo}`;
  const query = branchQuery(ref);
  const prefix = `${parsed.owner}/${parsed.repo}`;
  const flags = [];
  for (const fileRel of CANDIDATES) {
    const pulled = await pullGithubFile(exec, base, query, fileRel, `${prefix}/${fileRel}`, at);
    if (pulled.error) return { error: true, flags: [] };
    flags.push(...pulled.flags);
  }
  const listed = await ghGet(exec, `${base}/contents/config${query}`);
  if (listed.error) return { error: true, flags: [] };
  if (!listed.missing && Array.isArray(listed.json)) {
    const names = [];
    for (const item of listed.json) {
      if (!item || item.type !== 'file' || typeof item.name !== 'string') continue;
      if (!CONFIG_NAME.test(item.name) || isSecretName(item.name)) continue;
      names.push(item.name);
    }
    names.sort();
    for (const name of names) {
      const fileRel = `config/${name}`;
      const pulled = await pullGithubFile(exec, base, query, fileRel, `${prefix}/${fileRel}`, at);
      if (pulled.error) return { error: true, flags: [] };
      flags.push(...pulled.flags);
    }
  }
  return { flags };
}

async function scanFeatureFlags(repository, input) {
  const project = repository.getProject(input.id);
  const detectedAt = input.at ?? Date.now();
  const collected = [];
  let attempted = false;
  let failed = false;
  for (const source of project.sources) {
    if (source.kind === 'workspace' && input.fs && input.root) {
      attempted = true;
      const result = await scanWorkspace({
        root: input.root, rel: source.ref.path, fs: input.fs, at: detectedAt,
      });
      if (result.error) failed = true;
      else collected.push(...result.flags);
    } else if (source.kind === 'github' && typeof input.exec === 'function') {
      attempted = true;
      const branch = project.repo && project.repo.defaultBranch;
      const result = await scanGithub({
        owner: source.ref.owner,
        repo: source.ref.repo,
        ref: branch,
        exec: input.exec,
        at: detectedAt,
      });
      if (result.error) failed = true;
      else collected.push(...result.flags);
    }
  }
  if (!attempted || failed) return { flags: [], wrote: false };
  const flags = finish(collected);
  repository.replaceFeatureFlags({
    id: input.id,
    actor: 'system',
    component: 'engine',
    at: detectedAt,
    features: flags.map((flag) => ({
      key: flag.key,
      state: flag.state,
      foundIn: { path: flag.source, line: flag.line },
    })),
  });
  return { flags, wrote: true };
}

module.exports = {
  scanFeatureFlags,
  parseFlagText,
  CANDIDATES,
  MAX_FLAG_BYTES,
  MAX_FLAGS,
};
