'use strict';
/*
 * Login throttling (PM audit (A)): per client IP and global, exponential.
 *   - per IP: after IP_FREE failures within WINDOW_MS, each further failure locks that IP for
 *     2^(failures − IP_FREE) s, capped at MAX_LOCK_MS. A success resets the IP.
 *   - global: when failures from ALL clients exceed GLOBAL_PER_MIN in the last minute, every login waits
 *     2^(excess) s (capped), so a distributed guess is slowed too.
 * check(ip) → { ok: true } | { ok: false, retryAfterSec, scope: 'ip' | 'global' }
 */
const WINDOW_MS = 15 * 60 * 1000, IP_FREE = 5, MAX_LOCK_MS = 15 * 60 * 1000, GLOBAL_PER_MIN = 20, MAX_ENTRIES = 10000;
const INFLIGHT_PER_IP = 2, INFLIGHT_ALL = 16;   // R16-01: concurrent scrypt verifications

function createLoginThrottle({ now = () => Date.now() } = {}) {
  const ips = new Map();      // ip → { failures: [ms], lockedUntil }
  let global = [];            // failure timestamps, all clients
  let globalUntil = 0;

  const entry = (ip) => {
    let e = ips.get(ip);
    if (!e) {
      if (ips.size >= MAX_ENTRIES) { const oldest = ips.keys().next().value; ips.delete(oldest); }
      e = { failures: [], lockedUntil: 0 }; ips.set(ip, e);
    }
    return e;
  };
  function check(ip) {
    const t = now();
    if (globalUntil > t) return { ok: false, retryAfterSec: Math.ceil((globalUntil - t) / 1000), scope: 'global' };
    const e = ips.get(ip);
    if (e && e.lockedUntil > t) return { ok: false, retryAfterSec: Math.ceil((e.lockedUntil - t) / 1000), scope: 'ip' };
    return { ok: true };
  }
  function failure(ip) {
    const t = now();
    const e = entry(ip);
    e.failures = e.failures.filter((x) => t - x < WINDOW_MS); e.failures.push(t);
    const over = e.failures.length - IP_FREE;
    if (over > 0) e.lockedUntil = t + Math.min(MAX_LOCK_MS, 1000 * 2 ** Math.min(over, 20));
    global = global.filter((x) => t - x < 60000); global.push(t);
    const excess = global.length - GLOBAL_PER_MIN;
    if (excess > 0) globalUntil = t + Math.min(MAX_LOCK_MS, 1000 * 2 ** Math.min(excess, 20));
  }
  function success(ip) { ips.delete(ip); }

  // R16-01: ATOMIC admission. reserve() runs synchronously, before any password derivation: the attempt is counted as
  // a failure at once (so N parallel requests can't all pass the check), and concurrent verifications are capped
  // (per client and overall). release(true) refunds the attempt on a successful login; release(false) keeps it.
  const inflight = new Map(); let inflightAll = 0;
  function reserve(ip) {
    const gate = check(ip);
    if (!gate.ok) return gate;
    if ((inflight.get(ip) || 0) >= INFLIGHT_PER_IP || inflightAll >= INFLIGHT_ALL) return { ok: false, retryAfterSec: 1, scope: 'busy' };
    failure(ip);
    const stamp = global[global.length - 1];
    inflight.set(ip, (inflight.get(ip) || 0) + 1); inflightAll++;
    let done = false;
    return { ok: true, release(succeeded) {
      if (done) return; done = true;
      const n = (inflight.get(ip) || 1) - 1; if (n) inflight.set(ip, n); else inflight.delete(ip);
      inflightAll--;
      if (succeeded) { success(ip); const i = global.lastIndexOf(stamp); if (i >= 0) global.splice(i, 1); }
    } };
  }
  return { check, failure, success, reserve, _state: () => ({ ips: ips.size, global: global.length, globalUntil, inflightAll }) };
}

module.exports = { createLoginThrottle, IP_FREE, WINDOW_MS, MAX_LOCK_MS, GLOBAL_PER_MIN };
