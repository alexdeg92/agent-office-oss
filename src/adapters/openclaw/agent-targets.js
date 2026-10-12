'use strict';
// Local adapter configuration is the authority for filesystem targets. Gateway
// agent metadata is never accepted as a path, and this reader runs no probes.
const path = require('node:path');
function targets({ paths, env, config }) {
  if (!config) { const text = require('../../ops/local-files').read(paths.openclawConfigPath, env); try { config = JSON.parse(text || '{}'); } catch { config = {}; } }
  const home = paths.openclawHome;
  const state = env.OPENCLAW_STATE_DIR ? path.resolve(env.OPENCLAW_STATE_DIR) : path.join(home, '.openclaw');
  const expand = value => typeof value === 'string' && value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
  const ids = new Set();
  // OpenClaw's keyed roster is current; list remains a supported legacy shape.
  // In a fleet, defaults.workspace is a parent for implicit per-agent workspaces,
  // not a shared target. The sole/legacy default owner inherits it directly.
  const entries = config.agents?.entries;
  const list = entries && typeof entries === 'object' && !Array.isArray(entries)
    ? Object.entries(entries).filter(([, a]) => a && typeof a === 'object' && !Array.isArray(a)).map(([id, a]) => ({ ...a, id }))
    : Array.isArray(config.agents?.list) ? config.agents.list : config.agents?.defaults ? [{ id: 'main', default: true }] : [];
  const marked = config.agents?.ownership !== 'explicit' ? list.filter(a => a?.default === true) : [];
  const owner = marked.length === 1 ? marked[0].id : list.length === 1 ? list[0]?.id : null;
  const base = expand(config.agents?.defaults?.workspace);
  return list.filter(a => a && /^[A-Za-z0-9_-]{1,64}$/.test(a.id || '') && !ids.has(a.id) && ids.add(a.id)).map(a => ({ ...a,
    workspace: path.resolve(home, expand(a.workspace) || (base ? a.id === owner ? base : path.join(base, a.id)
      : path.join(state, a.id === owner ? 'workspace' : 'workspace-' + a.id))) }));
}
module.exports = { targets };
