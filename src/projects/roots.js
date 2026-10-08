'use strict';

const path = require('node:path');
const { validation } = require('./errors');

const ROOT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

function normalizeWorkspaceRoots(roots) {
  if (!Array.isArray(roots)) throw validation('Racines de travail invalides.', 'root');
  const out = [];
  const ids = new Set();
  const paths = new Set();
  for (const root of roots) {
    const id = root && root.id;
    if (typeof id !== 'string' || !ROOT_ID.test(id)) throw validation('Identifiant de racine invalide.', 'root');
    if (!root || typeof root.path !== 'string' || !path.isAbsolute(root.path)) {
      throw validation('Racine de l’espace de travail invalide.', 'root');
    }
    const abs = path.resolve(root.path);
    if (ids.has(id) || paths.has(abs)) throw validation('Racine de travail en double.', 'root');
    ids.add(id);
    paths.add(abs);
    out.push({ id, path: abs });
  }
  return out;
}

function workspaceRef(folder, { workspaceRootIds = false } = {}) {
  const rel = folder && folder.path;
  if (!workspaceRootIds) return { path: rel };
  if (!folder || typeof folder.rootId !== 'string' || !ROOT_ID.test(folder.rootId)) {
    throw validation('La racine du dossier est requise.', 'source', 'root-required');
  }
  return { rootId: folder.rootId, path: rel };
}

module.exports = { ROOT_ID, normalizeWorkspaceRoots, workspaceRef };
