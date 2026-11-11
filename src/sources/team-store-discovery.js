'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_ALLOW_ROOTS = 16;
const MAX_PROJECT_DIRECTORIES = 128;
const MAX_TEAM_STORES = 16;
const MAX_EXPLICIT_STORES = 4;
const MAX_REPO_DEPTH = 48;
const MAX_PATH_BYTES = 4096;
const MAX_GIT_METADATA_BYTES = 4096;
const MAX_LABEL_LENGTH = 96;

function readBoundedMetadata(filename, fsx, expectedStat = null) {
  let fd;
  try {
    const before = expectedStat || fsx.lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_GIT_METADATA_BYTES) return null;
    fd = fsx.openSync(filename, fsx.constants.O_RDONLY | (fsx.constants.O_NOFOLLOW || 0));
    const opened = fsx.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_GIT_METADATA_BYTES) return null;
    const chunks = [];
    let total = 0;
    while (total <= MAX_GIT_METADATA_BYTES) {
      const buffer = Buffer.alloc(Math.min(1024, MAX_GIT_METADATA_BYTES + 1 - total));
      const count = fsx.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
      if (total > MAX_GIT_METADATA_BYTES) return null;
    }
    const after = fsx.lstatSync(filename);
    const final = fsx.fstatSync(fd);
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
        final.dev !== opened.dev || final.ino !== opened.ino || final.size > MAX_GIT_METADATA_BYTES) return null;
    return Buffer.concat(chunks, total).toString('utf8');
  } catch { return null; }
  finally { if (fd != null) try { fsx.closeSync(fd); } catch {} }
}

function safeStoreLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!label || label.length > MAX_LABEL_LENGTH || /[\\/]/.test(label) || label === '.' || label === '..') return null;
  return label;
}

function declaredStoreLabel(root, fsx) {
  const filename = path.join(root, 'team.json');
  try {
    const stat = fsx.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_GIT_METADATA_BYTES) return null;
    const body = readBoundedMetadata(filename, fsx, stat);
    if (body == null) return null;
    const value = JSON.parse(body);
    return safeStoreLabel(value?.label) || safeStoreLabel(value?.name);
  } catch { return null; }
}

function safeAbsolute(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES &&
    path.isAbsolute(value) && !value.includes('\0') && !/[\u0000-\u001f\u007f]/.test(value);
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function existingDirectory(candidate, fsx) {
  try {
    const stat = fsx.lstatSync(candidate);
    return stat.isDirectory() && !stat.isSymbolicLink() ? fsx.realpathSync(candidate) : null;
  } catch { return null; }
}

// Conventional project folders under HOME. Team stores are read only below these roots, so the
// default stays a short fixed list rather than all of HOME; AO_TEAM_STORE_ALLOW_ROOTS replaces it.
const DEFAULT_PROJECT_FOLDERS = Object.freeze(['dev', 'Dev', 'Developer', 'code', 'Code', 'src', 'projects', 'Projects', 'repos', 'git', 'workspace']);

function configuredAllowRoots(env = process.env, fsx = fs) {
  const home = typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : require('node:os').homedir();
  const raw = Object.hasOwn(env, 'AO_TEAM_STORE_ALLOW_ROOTS')
    ? String(env.AO_TEAM_STORE_ALLOW_ROOTS || '').split(path.delimiter)
    : DEFAULT_PROJECT_FOLDERS.map(folder => path.join(home, folder));
  const roots = [];
  for (const item of raw.slice(0, MAX_ALLOW_ROOTS * 2)) {
    if (!safeAbsolute(item)) continue;
    const canonical = existingDirectory(item, fsx);
    if (canonical && !roots.includes(canonical)) roots.push(canonical);
    if (roots.length >= MAX_ALLOW_ROOTS) break;
  }
  return roots;
}

function gitCommonDirectory(repo, allowRoots, fsx) {
  const marker = path.join(repo, '.git');
  let markerStat;
  try { markerStat = fsx.lstatSync(marker); } catch { return null; }
  if (markerStat.isSymbolicLink()) return null;
  let gitDir;
  if (markerStat.isDirectory()) gitDir = marker;
  else if (markerStat.isFile() && markerStat.size <= MAX_GIT_METADATA_BYTES) {
    const body = readBoundedMetadata(marker, fsx, markerStat);
    if (body == null) return null;
    const match = /^gitdir:\s*([^\r\n]+)\s*$/i.exec(body);
    if (!match || match[1].length > MAX_PATH_BYTES || match[1].includes('\0')) return null;
    gitDir = path.resolve(repo, match[1]);
  } else return null;
  try {
    const gitStat = fsx.lstatSync(gitDir);
    if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) return null;
    gitDir = fsx.realpathSync(gitDir);
  } catch { return null; }
  if (!allowRoots.some(root => inside(root, gitDir))) return null;

  const commonFile = path.join(gitDir, 'commondir');
  try {
    const commonStat = fsx.lstatSync(commonFile);
    if (commonStat.isSymbolicLink() || !commonStat.isFile() || commonStat.size > MAX_GIT_METADATA_BYTES) return null;
    const body = readBoundedMetadata(commonFile, fsx, commonStat);
    if (body == null) return null;
    const relative = body.trim();
    if (!relative || relative.length > MAX_PATH_BYTES || relative.includes('\0') || /[\r\n]/.test(relative)) return null;
    gitDir = path.resolve(gitDir, relative);
    const commonStatResolved = fsx.lstatSync(gitDir);
    if (!commonStatResolved.isDirectory() || commonStatResolved.isSymbolicLink()) return null;
    gitDir = fsx.realpathSync(gitDir);
  } catch (error) { if (error?.code !== 'ENOENT') return null; }
  return allowRoots.some(root => inside(root, gitDir)) ? gitDir : null;
}

// The store belongs to the repository, not to whichever worktree was scanned first: name it after the
// common git directory (`<repo>/.git` → `<repo>`, bare `<repo>.git` → `<repo>`).
function repositoryLabel(commonDir) {
  const base = path.basename(commonDir);
  return base === '.git' ? path.basename(path.dirname(commonDir)) : base.replace(/\.git$/, '');
}

function discoverTeamStoreRoots({ projectDirectories = null, paneCwds = [], env = process.env, explicitRoot = null, explicitRoots = null, fsx = fs } = {}) {
  const directories = Array.isArray(projectDirectories) ? projectDirectories : paneCwds;
  const allowed = configuredAllowRoots(env, fsx);
  const roots = new Map();
  let truncatedStoreCount = 0;
  const requestedExplicit = Array.isArray(explicitRoots) ? explicitRoots : explicitRoot == null ? [] : [explicitRoot];
  const storeLimit = MAX_TEAM_STORES + Math.min(MAX_EXPLICIT_STORES, requestedExplicit.length);
  const add = (root, label, source) => {
    if (roots.has(root)) return;
    if (roots.size >= storeLimit) { truncatedStoreCount++; return; }
    const displayLabel = declaredStoreLabel(root, fsx) || safeStoreLabel(label) || 'Team';
    roots.set(root, Object.freeze({ root, label: displayLabel, source }));
  };

  for (const root of requestedExplicit.slice(0, MAX_EXPLICIT_STORES)) {
    const extra = safeAbsolute(root) ? existingDirectory(root, fsx) : null;
    if (extra) add(extra, 'Team', 'explicit');
  }

  const seenCwds = new Set();
  for (const hint of Array.isArray(directories) ? directories.slice(0, MAX_PROJECT_DIRECTORIES) : []) {
    const rawCwd = typeof hint === 'string' ? hint : hint?.cwd;
    if (!safeAbsolute(rawCwd) || seenCwds.has(rawCwd)) continue;
    seenCwds.add(rawCwd);
    let cwd;
    try { cwd = fsx.realpathSync(rawCwd); } catch { continue; }
    const allowedRoot = allowed.find(root => inside(root, cwd));
    if (!allowedRoot) continue;
    let repo = cwd;
    for (let depth = 0; depth < MAX_REPO_DEPTH; depth++) {
      const commonDir = gitCommonDirectory(repo, allowed, fsx);
      if (commonDir) {
        const candidate = path.join(commonDir, 'team');
        try {
          const stat = fsx.lstatSync(candidate);
          if (stat.isDirectory() && !stat.isSymbolicLink()) {
            const realStore = fsx.realpathSync(candidate);
            if (allowed.some(root => inside(root, realStore))) add(realStore, repositoryLabel(commonDir), 'pane');
          }
        } catch { /* no team store at this repository */ }
        break;
      }
      const parent = path.dirname(repo);
      if (parent === repo || !inside(allowedRoot, parent)) break;
      repo = parent;
    }
  }
  return Object.freeze({ stores: Object.freeze([...roots.values()]),
    scannedDirectoryCount: seenCwds.size, truncatedDirectoryCount: Math.max(0, (Array.isArray(directories) ? directories.length : 0) - MAX_PROJECT_DIRECTORIES),
    truncatedStoreCount });
}

module.exports = { discoverTeamStoreRoots, configuredAllowRoots, safeStoreLabel, MAX_ALLOW_ROOTS, MAX_PROJECT_DIRECTORIES, MAX_TEAM_STORES, MAX_EXPLICIT_STORES, MAX_REPO_DEPTH };
