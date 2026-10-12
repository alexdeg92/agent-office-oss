'use strict';
const path = require('path'), H = require('./helpers');
const runtime = 'openclaw', name = 'OpenClaw';
function detect({ env, home }) {
  const paths = require('../openclaw/paths').paths({ ...env, HOME: home });
  const state = env.OPENCLAW_STATE_DIR ? path.resolve(env.OPENCLAW_STATE_DIR) : path.join(paths.openclawHome, '.openclaw');
  const text = H.read(paths.openclawConfigPath, env);
  let config = {}; try { config = JSON.parse(text || '{}'); } catch {}
  const roster = config.agents?.entries || config.agents?.list;
  if (roster && Object.keys(roster).length > 1024) throw require('../../ops/local-files').limit();
  const found = !!text || H.exists(state, env) || !!H.binary('openclaw', env);
  const agents = require('../openclaw/agent-targets').targets({ paths, env, config }).map(a => {
    const workspace = a.workspace;
    const identity = H.read(path.join(workspace, 'IDENTITY.md'), env);
    const fromIdentity = identity?.match(/^\s*(?:[-*]\s*)?(?:\*\*)?Name(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*$/im)?.[1]?.replace(/\*\*/g, '').trim();
    const configured = a.identity?.name || a.name || (a.id === 'main' ? config.identity?.name : null);
    const displayName = typeof configured === 'string' && configured.trim() ? configured.trim() : fromIdentity && !/^\(|^\[|^your name/i.test(fromIdentity) ? fromIdentity : null;
    return { id: a.id, name: displayName?.slice(0, 80) || null, nameSource: configured ? 'openclaw.json' : displayName ? 'IDENTITY.md' : null,
      isPrimary: a.default === true || a.isDefault === true, workspace: path.resolve(workspace), model: typeof a.model === 'string' ? a.model : null };
  });
  const { gatewayUrl: url, token } = require('../openclaw/connection').connection(env, config);
  return { runtime, name, found, checkedPaths: [paths.openclawConfigPath, state], reason: text ? 'config' : found ? 'presence' : 'none', confidence: text ? 'config' : found ? 'presence' : 'none', agents,
    connection: { gatewayUrl: url, tokenSet: typeof token === 'string' && !!token }, secret: typeof token === 'string' ? token : null };
}
module.exports = { runtime, name, detect };
