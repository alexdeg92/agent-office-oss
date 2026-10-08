'use strict';

const { ProjectError, validation } = require('../errors');
const { authorHint } = require('../email');
const { resolveInside, assertGitContained, scrubGitEnv, stripRemoteCredentials } = require('./refs');
const { normalizeWorkspaceRoots } = require('../roots');

function parseGitLog(stdout) {
  const commits = [];
  const authors = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const [sha, iso, name, email, message] = line.split('\x1f');
    if (!/^[a-f0-9]{7,64}$/.test(sha || '')) continue;
    const at = Date.parse(iso || '');
    if (!Number.isInteger(at)) continue;
    const hint = authorHint(name, email);
    commits.push({
      sha,
      at,
      message: String(message || '').trim().slice(0, 200),
      author: { name: hint.name, personId: null },
    });
    authors.push(hint);
    if (commits.length === 10) break;
  }
  return { commits, authors };
}

async function run(exec, args, { allowFailure = false } = {}) {
  let result;
  try {
    result = await exec(args, scrubGitEnv(process.env));
  } catch {
    throw new ProjectError('upstream_failed', 'La lecture du dossier a échoué.');
  }
  if (!result || result.code !== 0) {
    if (allowFailure) return '';
    throw new ProjectError('upstream_failed', 'La lecture du dossier a échoué.');
  }
  return String(result.stdout ?? '');
}

function createWorkspaceSource({ root, roots, exec, workspaceRootIds = false } = {}) {
  if (typeof exec !== 'function') throw new ProjectError('internal', 'La source dossier n’a pas d’exécuteur.');
  const table = workspaceRootIds ? normalizeWorkspaceRoots(roots || []) : null;
  function locate(ref) {
    const body = ref && ref.ref ? ref.ref : ref;
    if (!table) {
      const found = resolveInside(root, body && body.path ? body.path : body);
      return { rel: found.path, abs: found.abs, rootPath: root, rootId: null };
    }
    const rootId = body && body.rootId ? body.rootId : (table.length === 1 ? table[0].id : '');
    const chosen = table.find((item) => item.id === rootId);
    if (!chosen) throw validation('La racine du dossier est requise.', 'source', 'root-required');
    const found = resolveInside(chosen.path, body && body.path);
    return { rel: found.path, abs: found.abs, rootPath: chosen.path, rootId: chosen.id };
  }
  return {
    kind: 'workspace',
    parseRef(input) {
      const located = locate(input);
      const ref = located.rootId ? { rootId: located.rootId, path: located.rel } : { path: located.rel };
      return { kind: 'workspace', ref };
    },
    async fetch(ref) {
      const located = locate(ref);
      const { rel, abs, rootPath } = located;
      assertGitContained(rootPath, abs);
      const branch = (await run(exec, ['git', '-C', abs, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      if (!branch || branch === 'HEAD') throw new ProjectError('upstream_failed', 'Branche git introuvable.');
      const log = await run(exec, ['git', '-C', abs, 'log', '-n', '10', `--format=%H%x1f%aI%x1f%an%x1f%ae%x1f%s`]);
      const remoteStdout = await run(exec, ['git', '-C', abs, 'remote', 'get-url', 'origin'], { allowFailure: true });
      const remote = stripRemoteCredentials(remoteStdout.trim()) || null;
      const parsed = parseGitLog(log);
      const snap = { path: rel, branch, remote, commits: parsed.commits, authors: parsed.authors };
      if (located.rootId) snap.rootId = located.rootId;
      return snap;
    },
  };
}

module.exports = { createWorkspaceSource, parseGitLog };
