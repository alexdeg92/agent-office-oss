'use strict';
// Plans hold adapter-owned targets server-side. The browser can select ids, never file paths.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { AGENT_ID } = require('../instance-config');
const { adapterById } = require('../adapters');
const { safePath } = require('./local-files');
function checked(file, env) {
  file = require('./safe-fs').canonicalPath(safePath(file, env));
  for (let p = path.resolve(file); p !== path.dirname(p); p = path.dirname(p)) {
    let st; try { st = fs.lstatSync(p); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    if (st?.isSymbolicLink()) throw Object.assign(new Error('symlink target'), { code: 'EUNSAFEPATH' });
  }
  return file;
}
function fingerprint(files, env) {
  const hash = crypto.createHash('sha256');
  for (const original of files) {
    const f = checked(original, env); hash.update(f);
    for (let dir = path.dirname(path.resolve(f));; dir = path.dirname(dir)) {
      if (fs.existsSync(dir)) { const s = fs.lstatSync(dir, { bigint: true }); hash.update(JSON.stringify([dir, String(s.dev), String(s.ino), Number(s.mode)])); }
      if (dir === path.dirname(dir)) break;
    }
    if (fs.existsSync(f)) { const s = fs.lstatSync(f, { bigint: true }); hash.update(JSON.stringify([String(s.dev), String(s.ino), Number(s.mode)])); hash.update(require('./safe-fs').read(f, { roots: [path.dirname(f)], maxBytes: 16 * 1024 * 1024, encoding: 'base64' }).text); }
    else hash.update('<absent>');
  }
  return hash.digest('hex');
}
function createSetupIntegrations({ env, paths, dataDir, now = Date.now, beforeMutation = () => {}, afterMutation = () => {} }) {
  const plans = new Map(), resolved = new Map();
  function descriptor({ runtime, agentId, locale = 'fr', target = null }) {
    const adapter = adapterById(runtime), I = adapter.projectTag?.();
    const adapterPaths = adapter.paths?.(env) || paths;
    const local = adapter.setup?.integrationTargets?.({ paths: adapterPaths, env }) || [];
    target = local.find(a => a.id === agentId) || target || resolved.get(runtime + ':' + agentId);
    if (!I || !target?.workspace) return { status: I ? 'absent' : 'unsupported', target: null, I, files: [] };
    target = { ...target, workspace: checked(target.workspace, env) };
    const want = I.expected(target.workspace, locale);
    const files = [...Object.keys(want.files).map(f => path.join(want.dir, f)), path.join(target.workspace, 'AGENTS.md')];
    return { status: I.inspect(target, { locale }).status, target, I, files };
  }
  async function plan({ runtime, agents = [], locale = 'fr' }) {
    if (!['fr', 'en'].includes(locale)) throw Object.assign(new Error('invalid locale'), { code: 'EINVAL' });
    const adapter = adapterById(runtime);
    const I = adapter.projectTag?.();
    const discovered = I ? await adapter.setup.integrationAgents({ paths: adapter.paths?.(env) || paths, agents, env }) : [];
    const targets = (discovered || []).filter(a => a && typeof a.id === 'string' && AGENT_ID.test(a.id) && typeof a.workspace === 'string');
    for (const target of targets) resolved.set(runtime + ':' + target.id, target);
    const rows = (agents.length ? agents : targets).map(a => {
      const found = targets.find(x => x.id === a.id);
      const d = descriptor({ runtime, agentId: a.id, locale, target: found });
      const { target, files, status } = d;
      if (!I || !target) return { id: a.id, status: 'unsupported', files: [] };
      const before = fingerprint(files, env);
      const dry = I.install(target, { locale, dryRun: true });
      const changed = files.filter(f => f.endsWith('AGENTS.md') ? dry.done.includes('block') : dry.done.includes('skill'));
      return { id: a.id, status, files: changed, allFiles: files, target, before };
    });
    const planId = crypto.randomBytes(18).toString('base64url');
    if (plans.size >= 16) plans.delete(plans.keys().next().value);
    plans.set(planId, { rows, locale, I, expires: now() + 10 * 60000 });
    return { planId, agents: rows.map(({ id, status, files, allFiles }) => ({ id, status, files, uninstallFiles: allFiles || [] })),
      backupDir: dataDir ? path.join(dataDir, 'integrations', 'backups') : null };
  }
  function apply({ planId, agentIds, confirmed, action = 'install' }) {
    const p = plans.get(planId);
    if (!p || p.expires <= now()) throw Object.assign(new Error('expired plan'), { code: 'EPLAN' });
    if (confirmed !== true || !Array.isArray(agentIds) || !agentIds.length || new Set(agentIds).size !== agentIds.length || !['install', 'uninstall'].includes(action)) throw Object.assign(new Error('confirmation required'), { code: 'ECONFIRM' });
    const rows = agentIds.map(id => p.rows.find(a => a.id === id));
    if (rows.some(a => !a || a.status === 'unsupported')) throw Object.assign(new Error('unsupported target'), { code: 'EPLAN' });
    // Check every target before the first write, including changes to symlinked parents.
    for (const a of rows) if (fingerprint(a.allFiles, env) !== a.before) throw Object.assign(new Error('files changed; review a new plan'), { code: 'ESTALEPLAN' });
    const results = require('./safe-fs').transaction(rows.flatMap(a => a.allFiles), path.join(dataDir, 'integrations', 'backups'), () => { const results = rows.map(a => {
      beforeMutation();
      const r = p.I[action](a.target, { locale: p.locale, backupDir: dataDir ? path.join(dataDir, 'integrations', 'backups') : null });
      if (r.status === 'conflict' || r.status === 'failed') throw Object.assign(new Error('selected installation refused'), { code: 'ECONFLICT' });
      a.before = fingerprint(a.allFiles, env); a.status = p.I.inspect(a.target, { locale: p.locale }).status;
      return { id: a.id, status: a.status, changed: r.done, backup: r.backup || null, reason: r.refused || null };
    }); afterMutation(); return results; });
    return { agents: results };
  }
  return { plan, apply, descriptor, invalidate: () => plans.clear() };
}
module.exports = { createSetupIntegrations };
