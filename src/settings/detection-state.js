'use strict';
const crypto = require('node:crypto');
const { validNativeId } = require('../runtime-ids');
const { normalizeGateway } = require('./runtime-detections');
const MAX_BYTES = 1024 * 1024, INTERVAL_MS = 5 * 60 * 1000;
const string = (v, max = 4096) => typeof v === 'string' && v.length <= max ? v : null;
// Only owner discovery metadata enters SQLite. Credentials, arbitrary detector
// properties and transcript contents are deliberately absent from this shape.
function snapshot(detections, checkedAt, scope) {
  if (!Array.isArray(detections) || detections.length > 32 || !Number.isSafeInteger(checkedAt) || checkedAt < 0) throw Error('invalid detection snapshot');
  const rows = detections.map(d => {
    if (!d || !/^[a-z][a-z0-9-]{0,79}$/.test(d.runtime) || typeof d.found !== 'boolean') throw Error('invalid detection row');
    const url = normalizeGateway(d.connection?.gatewayUrl), secret = typeof d.secret === 'string' ? d.secret : null;
    const gatewayUrl = url && (!secret || !url.includes(secret) && !url.includes(encodeURIComponent(secret))) ? url : null;
    return { runtime: d.runtime, name: string(d.name, 80) || d.runtime, found: d.found,
      confidence: ['config', 'presence', 'none', 'unreadable'].includes(d.confidence) ? d.confidence : 'none',
      checkedPaths: (Array.isArray(d.checkedPaths) ? d.checkedPaths : []).slice(0, 32).map(p => string(p)).filter(p => p !== null),
      home: string(d.home),
      connection: d.connection ? { gatewayUrl, tokenSet: !!d.connection.tokenSet } : null,
      agents: (Array.isArray(d.agents) ? d.agents : []).slice(0, 1024).filter(a => validNativeId(a?.id)).map(a => ({ id: a.id,
        name: string(a.name, 80), nameSource: string(a.nameSource, 80), isPrimary: a.isPrimary === true,
        workspace: string(a.workspace), model: string(a.model, 200) })),
    };
  });
  if (new Set(rows.map(d => d.runtime)).size !== rows.length) throw Error('duplicate detector kind');
  const value = { version: 1, scope, checkedAt, runtimes: rows };
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw Error('detection snapshot capacity');
  return value;
}
function createDetectionState({ store, env, detect, now = Date.now, changed = () => {}, writable = () => true, timeoutMs = 5000 }) {
  const scope = crypto.createHash('sha256').update(JSON.stringify(['HOME', 'OC_HOME', 'OC_CONFIG', 'OPENCLAW_STATE_DIR', 'AO_CLAUDE_HOME', 'OC_GATEWAY_URL', 'PATH'].map(k => env[k] || null))).digest('hex');
  const get = store.db.prepare("SELECT value FROM runtime_detection WHERE id=1");
  const put = store.db.prepare("INSERT INTO runtime_detection(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value");
  let current = null, flight = null, cancellation = null, closed = false, started = false, timer = null, cancelTimer = clearTimeout;
  try {
    const raw = get.get()?.value;
    if (raw && Buffer.byteLength(raw) <= MAX_BYTES) {
      const value = JSON.parse(raw);
      if (value.version === 1 && value.scope === scope) {
        const clean = snapshot(value.runtimes, value.checkedAt, scope);
        if (JSON.stringify(clean) === JSON.stringify(value)) current = clean;
      }
    }
  } catch { /* Corrupt/foreign cache is unchecked; never a fabricated negative. */ }
  async function refresh(validate = () => {}) {
    if (closed) throw Error('detection closed');
    validate();
    if (!flight) {
      cancellation = new AbortController();
      const source = Promise.resolve().then(() => { validate();return detect({ env, signal: cancellation.signal }); });
      flight = (async () => {
        let deadline;
        try {
          const rows = await Promise.race([source, new Promise((_, reject) => { deadline = setTimeout(() => { cancellation.abort(); reject(Error('detection timeout')); }, timeoutMs); })]);
          return snapshot(rows, now(), scope);
        } finally { clearTimeout(deadline); }
      })();
      const operation = flight;
      // A timed-out uncooperative detector still owns the flight until it settles:
      // repeated refreshes cannot launch unbounded background work.
      Promise.allSettled([source, operation]).then(() => { if (flight === operation) flight = null; });
    }
    const next = await flight;
    validate();
    if (closed) throw Error('detection closed');
    if (current !== next) {
      if (writable()) store.withTx(() => put.run(JSON.stringify(next)));
      current = next; changed();
    }
    return next;
  }
  async function start({ intervalMs = INTERVAL_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (started || closed) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < INTERVAL_MS) throw Error('detection interval must be at least five minutes');
    started = true; cancelTimer = clearTimer;
    const tick = async () => {
      if (closed) return;
      try { await refresh(); } catch { /* Keep the last real snapshot; next scheduled pass can recover. */ }
      if (!closed) { timer = setTimer(tick, intervalMs); timer?.unref?.(); }
    };
    await tick();
  }
  return { refresh, start, rows: () => current?.runtimes.map(d => ({ ...d, checkedAt: current.checkedAt })) || [],
    close() { closed = true; cancellation?.abort(); if (timer !== null) cancelTimer(timer); timer = null; } };
}
function detectionView(d, enabledOptional = false) {
  const checkedAt = d?.checkedAt ?? null;
  const status = enabledOptional ? 'enabled' : checkedAt === null ? 'not-checked' : d.confidence === 'unreadable' ? 'unreadable' : d.found ? 'detected' : 'not-detected';
  const reason = status === 'not-checked' ? 'notChecked' : status === 'not-detected' ? 'none' : status === 'enabled' ? 'enabled' : status === 'unreadable' ? 'unreadable' : d.confidence === 'config' ? 'config' : 'presence';
  return { detection: { status, checkedAt }, found: status === 'detected' || status === 'enabled', confidence: checkedAt === null ? 'none' : d.confidence, reason: { key: 'settings.detection.' + reason } };
}
module.exports = { createDetectionState, detectionView, INTERVAL_MS };
