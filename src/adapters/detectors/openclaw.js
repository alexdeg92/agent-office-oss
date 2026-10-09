'use strict';
const path = require('path'), H = require('./helpers');
const runtime = 'openclaw', name = 'OpenClaw';
function detect({ env, home }) {
  const paths = require('../openclaw/paths').paths({ ...env, HOME: home });
  const state = env.OPENCLAW_STATE_DIR ? path.resolve(env.OPENCLAW_STATE_DIR) : path.join(paths.openclawHome, '.openclaw');
  const text = H.read(paths.openclawConfigPath, env);
  let config = {}; try { config = JSON.parse(text || '{}'); } catch {}
  const found = !!text || H.exists(state, env) || !!H.binary('openclaw', env);
  const expand = p => typeof p === 'string' && p.startsWith('~/') ? path.join(paths.openclawHome, p.slice(2)) : p;
  let list = Array.isArray(config.agents?.list) ? config.agents.list : [];
  const ids = new Set();
  const agents = list.filter(a => a && /^[A-Za-z0-9_-]{1,64}$/.test(a.id || '') && !ids.has(a.id) && ids.add(a.id)).map(a => {
    const workspace = path.resolve(paths.openclawHome, expand(a.workspace || config.agents?.defaults?.workspace || path.join(state, 'workspace' + (a.id === 'main' ? '' : '-' + a.id))));
    const identity = H.read(path.join(workspace, 'IDENTITY.md'), env);
    const fromIdentity = identity?.match(/^\s*(?:[-*]\s*)?(?:\*\*)?Name(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*$/im)?.[1]?.replace(/\*\*/g, '').trim();
    const configured = a.identity?.name || a.name || (a.id === 'main' ? config.identity?.name : null);
    const displayName = typeof configured === 'string' && configured.trim() ? configured.trim() : fromIdentity && !/^\(|^\[|^your name/i.test(fromIdentity) ? fromIdentity : null;
    return { id: a.id, name: displayName?.slice(0, 80) || null, nameSource: configured ? 'openclaw.json' : displayName ? 'IDENTITY.md' : null,
      isPrimary: a.default === true || a.isDefault === true, workspace: path.resolve(workspace), model: typeof a.model === 'string' ? a.model : null };
  });
  const { gatewayUrl: url, token } = require('../openclaw/connection').connection(env, config);
  return { runtime, name, found, confidence: text ? 'config' : found ? 'presence' : 'none', agents,
    connection: { gatewayUrl: url, tokenSet: typeof token === 'string' && !!token }, secret: typeof token === 'string' ? token : null };
}
module.exports = { runtime, name, detect };
