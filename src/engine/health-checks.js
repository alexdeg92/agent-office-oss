'use strict';

// Health checks are canonical records. Adapters own the predicate and remedy;
// the engine owns validation, retry bounds, state transitions and audit history.
const ID = /^[a-z][a-z0-9.-]{0,63}$/;
const SEVERITY = new Set(['error', 'warn', 'info']);
const REMEDY = new Set(['none', 'auto', 'one-click', 'guided']);

function canonicalCheck(adapterId, row, active, now, suppressed = new Map()) {
  if (!row || !ID.test(row.id || '') || !SEVERITY.has(row.severity) || !REMEDY.has(row.remedy)
    || typeof row.causeCode !== 'string' || !ID.test(row.causeCode)
    || typeof row.textKey !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,127}$/.test(row.textKey)
    || typeof row.impactKey !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,127}$/.test(row.impactKey)) return null;
  const guidedPath = typeof row.guidedPath === 'string' && row.guidedPath.startsWith('/') && !row.guidedPath.startsWith('//') && !/[\u0000-\u001f\\]/.test(row.guidedPath) ? row.guidedPath : null;
  const id = `${adapterId}:${row.id}`;
  const signature = `${row.causeCode}|${row.actionId || ''}`;
  const remedy = row.remedy === 'auto' && suppressed.get(id) === signature ? 'none' : row.remedy;
  const target = typeof row.target === 'string' && row.target.length <= 240 && !/[\u0000-\u001f]/.test(row.target) ? row.target : null;
  return Object.freeze({ id, adapter: adapterId, severity: row.severity,
    causeCode: row.causeCode, textKey: row.textKey, impactKey: row.impactKey,
    remedy, active: !!active, actionId: ID.test(row.actionId || '') ? row.actionId : null,
    guidedPath, target, changedAt: now });
}

function createHealthChecks({ adapterId, adapter, context, now, onChange = () => {}, onAudit = () => {}, remedyTimeoutMs = 10000 }) {
  const states = new Map(), audit = [], inFlight = new Map(), suppressedAuto = new Map();
  let running = false, timer = null;
  const definitions = () => {
    try { const rows = typeof adapter.health?.checks === 'function' ? adapter.health.checks(context()) : adapter.health?.checks || []; return Array.isArray(rows) ? rows : []; }
    catch { return []; }
  };
  function list() {
    const at = now(), seen = new Set(), out = [];
    for (const definition of definitions()) {
      // Dynamic adapter declarations usually return only failing checks; presence
      // therefore means active unless the adapter explicitly says otherwise.
      let active = true;
      try { if (definition.active != null) active = typeof definition.active === 'function' ? !!definition.active(context()) : !!definition.active; } catch { active = true; }
      const id = `${adapterId}:${definition.id}`;
      const signature = `${definition.causeCode}|${definition.actionId || ''}`;
      if (!active || (suppressedAuto.has(id) && suppressedAuto.get(id) !== signature)) suppressedAuto.delete(id);
      const check = canonicalCheck(adapterId, definition, active, at, suppressedAuto);
      if (!check) continue;
      seen.add(check.id);
      const old = states.get(check.id);
      if (old && old.active !== active) {
        const next = { ...check, changedAt: at, resolvedAt: active ? null : at };
        states.set(check.id, next); out.push(next);
      } else { const next = { ...(old || {}), ...check, changedAt: old?.changedAt || at,
        resolvedAt: active ? null : old ? old.resolvedAt || at : null }; states.set(check.id, next); out.push(next); }
    }
    for (const [id, old] of states) if (!seen.has(id)) {
      // Dynamic adapters omit a check when its cause clears. Forget its terminal
      // suppression too, so a later recurrence gets one fresh bounded attempt.
      suppressedAuto.delete(id);
      if (old.active) states.set(id, { ...old, active: false, resolvedAt: at, changedAt: at });
    }
    return [...states.values()].sort((a,b) => Number(b.active)-Number(a.active) || b.changedAt-a.changedAt);
  }
  async function execute(id, { automatic = false } = {}) {
    const row = list().find(c => c.id === id);
    if (!row || !row.active || !row.actionId || (automatic ? row.remedy !== 'auto' : row.remedy !== 'one-click')) return { ok: false, category: 'remedy-unavailable' };
    const fn = adapter.health?.remedies?.[row.actionId];
    if (typeof fn !== 'function') return { ok: false, category: 'remedy-unavailable' };
    let result = { ok: false, category: 'failed' }, attempts = automatic ? 3 : 1;
    for (let n = 0; n < attempts; n++) {
      const controller = new AbortController();
      let timeout;
      try {
        result = await Promise.race([
          Promise.resolve().then(() => fn(context(), { signal: controller.signal })),
          new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('remedy-timeout')); }, remedyTimeoutMs); }),
        ]);
      } catch (error) { result = { ok: false, category: error?.message === 'remedy-timeout' ? 'timeout' : 'failed' }; }
      finally { clearTimeout(timeout); }
      if (result?.ok !== false) break;
      if (n + 1 < attempts) await new Promise(resolve => setTimeout(resolve, Math.min(2000, 250 * (2 ** n))));
    }
    const category = typeof result?.category === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(result.category) ? result.category : 'failed';
    if (automatic && result?.ok === false) suppressedAuto.set(row.id, `${row.causeCode}|${row.actionId || ''}`);
    if (!row.active || result?.ok !== false) suppressedAuto.delete(row.id);
    const entry = Object.freeze({ checkId: row.id, actionId: row.actionId, at: now(), outcome: result?.ok === false ? category : 'completed', attempts });
    audit.unshift(entry); if (audit.length > 50) audit.length = 50;
    try { onAudit(entry); } catch { /* diagnostics must not interrupt remediation */ }
    list();
    onChange();
    return { ok: result?.ok !== false, category: result?.category || null, audit: entry };
  }
  function run(id, options = {}) {
    const pending = inFlight.get(id);
    if (pending) return pending;
    const promise = execute(id, options).finally(() => inFlight.delete(id));
    inFlight.set(id, promise);
    return promise;
  }
  async function runSafe() {
    if (running) return;
    running = true;
    try { for (const check of list()) if (check.active && check.remedy === 'auto') await run(check.id, { automatic: true }); }
    finally { running = false; onChange(); }
  }
  function start(intervalMs = 30000) {
    if (timer) return;
    runSafe(); timer = setInterval(runSafe, Math.max(10000, Math.min(300000, intervalMs))); timer.unref?.();
  }
  return { list, run, runSafe, audit: () => audit.slice(), start, close() { clearInterval(timer); timer = null; } };
}

module.exports = { createHealthChecks };
