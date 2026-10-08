'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ProjectError, validation } = require('../errors');
const { ROOT_ID, normalizeWorkspaceRoots } = require('../roots');

const GH_NAME = /^[A-Za-z0-9._-]+$/;

function parseGithubRef(ref, owners) {
  if (!ref || typeof ref !== 'object') throw validation('Dépôt GitHub invalide.', 'source');
  const owner = String(ref.owner || '');
  const repo = String(ref.repo || '');
  if (!GH_NAME.test(owner) || !GH_NAME.test(repo)) throw validation('Dépôt GitHub invalide.', 'source');
  if (Array.isArray(owners) && !owners.some((item) => String(item).toLowerCase() === owner.toLowerCase())) {
    throw validation('Seuls les dépôts autorisés peuvent être liés.', 'source', 'owner-not-allowed');
  }
  return { owner, repo };
}

function parseWorkspacePath(rel) {
  if (typeof rel !== 'string' || rel.length < 1 || rel.length > 300) {
    throw validation('Chemin de dossier invalide.', 'source');
  }
  if (rel.includes('\\') || path.isAbsolute(rel) || rel.split('/').includes('..') || rel.startsWith('/')) {
    throw validation('Le dossier doit rester dans l’espace de travail.', 'source');
  }
  const norm = path.posix.normalize(rel);
  if (norm === '..' || norm.startsWith('../') || norm === '.' || path.posix.isAbsolute(norm)) {
    throw validation('Le dossier doit rester dans l’espace de travail.', 'source');
  }
  return norm;
}

function inside(root, abs) {
  return abs === root || abs.startsWith(root + path.sep);
}

function contained(message) {
  throw validation(message || 'Le dossier doit rester dans l’espace de travail.', 'source');
}

/**
 * Walk existing ancestors. A missing leaf is allowed only when every existing
 * ancestor realpath stays under the root. A symlink that leaves the root, or
 * a missing leaf under such a symlink, is rejected. A root that does not
 * exist yet falls back to the lexical path (nothing on disk can escape).
 */
function resolveInside(root, rel) {
  const safe = parseWorkspacePath(rel);
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw validation('Racine de l’espace de travail invalide.', 'root');
  const rootAbs = path.resolve(root);
  const lexical = path.resolve(rootAbs, safe);
  if (!inside(rootAbs, lexical)) contained();
  let rootReal;
  try {
    rootReal = fs.realpathSync(rootAbs);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { path: safe, abs: lexical };
    throw err;
  }
  const parts = safe.split('/');
  let current = rootReal;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(current, parts[i]);
    let st;
    try {
      st = fs.lstatSync(next);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        const rest = path.resolve(current, ...parts.slice(i));
        if (!inside(rootReal, rest)) contained();
        return { path: safe, abs: rest };
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      let real;
      try {
        real = fs.realpathSync(next);
      } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) contained();
        throw err;
      }
      if (!inside(rootReal, real)) contained();
      current = real;
      continue;
    }
    current = next;
  }
  if (!inside(rootReal, current)) contained();
  return { path: safe, abs: current };
}

const GIT_ENV_BLOCK = new Set([
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ALTERNATE',
]);
const MAX_GIT_TEXT = 64 * 1024;
const MAX_ALTERNATES = 100;

/** Copy of `env` without the variables Git uses to relocate its object database. */
function scrubGitEnv(env) {
  const source = env && typeof env === 'object' ? env : process.env;
  const next = {};
  for (const key of Object.keys(source)) {
    if (GIT_ENV_BLOCK.has(key) || key.startsWith('GIT_ALTERNATE')) continue;
    next[key] = source[key];
  }
  return next;
}

function realInside(rootReal, abs) {
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    contained();
  }
  if (!inside(rootReal, real)) contained();
  return real;
}

function readContainedText(rootReal, file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  let target = file;
  if (st.isSymbolicLink()) {
    target = realInside(rootReal, file);
    try {
      st = fs.statSync(target);
    } catch {
      contained();
    }
  }
  if (!st.isFile()) contained();
  if (st.size > MAX_GIT_TEXT) contained();
  return fs.readFileSync(target, 'utf8');
}

/**
 * `objects` (including a symlink) and every `objects/info/alternates` entry
 * must realpath inside the root. Alternates are walked, cycles included once.
 * A missing objects directory is fine. An unreadable or outside entry is not.
 */
function containObjectStore(rootReal, objectsPath, seen, required) {
  let listed;
  try {
    listed = fs.lstatSync(objectsPath);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      if (required) contained();
      return;
    }
    throw err;
  }
  if (!listed.isDirectory() && !listed.isSymbolicLink()) contained();
  const objectsReal = realInside(rootReal, objectsPath);
  if (seen.has(objectsReal)) return;
  seen.add(objectsReal);
  const infoPath = path.join(objectsReal, 'info');
  let infoStat;
  try {
    infoStat = fs.lstatSync(infoPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  if (infoStat.isSymbolicLink()) realInside(rootReal, infoPath);
  else if (!infoStat.isDirectory()) contained();
  const text = readContainedText(rootReal, path.join(infoPath, 'alternates'));
  if (text == null) return;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (lines.length > MAX_ALTERNATES) contained();
  for (const line of lines) {
    if (line.includes('"') || line.includes('\0')) contained();
    containObjectStore(rootReal, path.resolve(objectsReal, line), seen, true);
  }
}

function containCommondir(rootReal, gitDir, seen) {
  const text = readContainedText(rootReal, path.join(gitDir, 'commondir'));
  if (text == null) return;
  const relCommon = text.trim();
  if (!relCommon) return;
  const commonReal = realInside(rootReal, path.resolve(gitDir, relCommon));
  containObjectStore(rootReal, path.join(commonReal, 'objects'), seen);
}

/**
 * The working tree must have its own `.git` (directory, symlink, or `gitdir:`
 * file). That git dir, a worktree `commondir`, and the object database
 * (including `objects/info/alternates`) must realpath inside the root. A
 * folder with no `.git` is refused so `git -C` cannot walk up to a repository
 * outside the root. A missing directory is left to the caller.
 */
function assertGitContained(root, abs) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(path.resolve(root));
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return;
    throw err;
  }
  let workStat;
  try {
    workStat = fs.lstatSync(abs);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return;
    throw err;
  }
  if (!workStat.isDirectory() && !workStat.isSymbolicLink()) contained();
  const work = fs.realpathSync(abs);
  if (!inside(rootReal, work)) contained();
  const gitPath = path.join(work, '.git');
  let gitStat;
  try {
    gitStat = fs.lstatSync(gitPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') contained();
    throw err;
  }
  let gitDir;
  if (gitStat.isSymbolicLink() || gitStat.isDirectory()) {
    try {
      gitDir = fs.realpathSync(gitPath);
    } catch {
      contained();
    }
    if (!inside(rootReal, gitDir)) contained();
  } else if (gitStat.isFile()) {
    const text = fs.readFileSync(gitPath, 'utf8');
    const match = /^gitdir:\s*(.+)$/mi.exec(text);
    if (!match) contained();
    const pointer = match[1].trim();
    const resolved = path.resolve(path.dirname(gitPath), pointer);
    try {
      gitDir = fs.realpathSync(resolved);
    } catch {
      contained();
    }
    if (!inside(rootReal, gitDir)) contained();
  } else {
    contained();
  }
  const seen = new Set();
  containObjectStore(rootReal, path.join(gitDir, 'objects'), seen);
  containCommondir(rootReal, gitDir, seen);
}

/** Drop URL userinfo and token query parameters. Safe to run on a whole blob. */
function stripRemoteCredentials(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+(?::[^@/\s]*)?@/gi, '$1')
    .replace(/[?#][^\s]*?(?:access_token|token|password|secret)=[^\s]*/gi, '');
}

function parseSessionGroupRef(ref) {
  if (!ref || typeof ref !== 'object') throw validation('Groupe de sessions invalide.', 'source');
  if (ref.by === 'group') {
    const groupId = typeof ref.groupId === 'string' ? ref.groupId.trim() : '';
    const name = typeof ref.name === 'string' ? ref.name.trim() : '';
    if (!groupId || groupId.length > 200 || !name || name.length > 200) {
      throw validation('Groupe de sessions invalide.', 'source');
    }
    return { by: 'group', groupId, name };
  }
  if (ref.by === 'interlocutor') {
    if (typeof ref.interlocutorId !== 'string' || !/^discord-(user|channel):\d{17,20}$/.test(ref.interlocutorId)) {
      throw validation('Groupe de sessions invalide.', 'source');
    }
    return { by: 'interlocutor', interlocutorId: ref.interlocutorId };
  }
  if (ref.by === 'keys') {
    if (!Array.isArray(ref.sessionKeys) || ref.sessionKeys.length < 1 || ref.sessionKeys.length > 100) {
      throw validation('Groupe de sessions invalide.', 'source');
    }
    if (ref.sessionKeys.some((k) => typeof k !== 'string' || k.length < 1 || k.length > 200)) {
      throw validation('Groupe de sessions invalide.', 'source');
    }
    return { by: 'keys', sessionKeys: ref.sessionKeys.slice() };
  }
  throw validation('Groupe de sessions invalide.', 'source');
}

const SERVER_OWNED_SOURCE_FIELDS = ['id', 'addedAt', 'addedBy'];

function parseSourceInput(input, { githubOwners = [], workspaceRootIds = false, workspaceRoots = [] } = {}) {
  if (input && typeof input === 'object') {
    for (const key of SERVER_OWNED_SOURCE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        throw validation('L’attribution de la source est fixée par le serveur.', 'source', 'server-owned');
      }
    }
  }
  const kind = input && input.kind;
  if (kind === 'github') {
    const ref = parseGithubRef(input.ref, githubOwners);
    return { kind, ref };
  }
  if (kind === 'workspace') {
    const rel = parseWorkspacePath(input.ref && input.ref.path);
    if (!workspaceRootIds) return { kind, ref: { path: rel } };
    const roots = normalizeWorkspaceRoots(workspaceRoots);
    const given = input.ref && input.ref.rootId;
    let rootId = typeof given === 'string' ? given : '';
    if (!rootId && roots.length === 1) rootId = roots[0].id;
    if (!ROOT_ID.test(rootId) || !roots.some((root) => root.id === rootId)) {
      throw validation('La racine du dossier est requise.', 'source', 'root-required');
    }
    return { kind, ref: { rootId, path: rel } };
  }
  if (kind === 'sessionGroup') return { kind, ref: parseSessionGroupRef(input.ref) };
  if (kind === 'manual') return { kind, ref: null };
  throw validation('Source invalide.', 'source');
}

module.exports = {
  parseGithubRef, parseWorkspacePath, resolveInside, assertGitContained, scrubGitEnv, stripRemoteCredentials,
  parseSessionGroupRef, parseSourceInput,
};
