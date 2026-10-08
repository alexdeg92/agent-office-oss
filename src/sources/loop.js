'use strict';
/*
 * The sources that feed the engine, runtime-neutral, started once by the composition root:
 *   - the runtime adapter's own read loops (runtime.start: gateway, refreshes, config, skills);
 *   - host metrics every 5 s;
 *   - interlocutor enrichment after each full refresh: every interlocutor id the engine has, to the selected enrichers
 *     (G7, ADR-001 §14.2; each takes its own families).
 * (Until S16 the v1 legacy runtime also observed these loops through hooks.)
 */
const { readHost } = require('./host');
const { every } = require('../ops/timescale');

const HOST_MS = 5000;
const HINT_SCAN_PER_REFRESH = 3, HINT_SCAN_DAYS = 7;

function startSources({ runtime, engine, enrichment = null }) {
  async function refreshOs() {
    try { engine.ingest({ source: 'host', channel: 'host.metrics', receivedAt: Date.now(), body: { kind: 'json', value: await readHost() } }); } catch (e) { console.log('[host]', e.message); }
  }
  async function resolveInterlocutors() {
    if (!enrichment) return;
    const ids = new Set();
    for (const s of engine.sessions()) if (s.class.interlocutorId && !s.class.heartbeatOf) ids.add(s.class.interlocutorId);
    const mine = [...ids].filter((id) => enrichment.handles(id));
    await enrichment.resolveAll(mine);
  }
  // architect-54: the project tag lives in transcripts (a no-op tool call); read the tail of sessions with new activity:
  // at most HINT_SCAN_PER_REFRESH per refresh, newest first, heartbeats never; at first, the last HINT_SCAN_DAYS only
  const scanned = new Map();   // sessionKey → updatedAt last read
  let scanning = false;
  async function scanHints() {
    if (scanning || !runtime.definition || typeof runtime.definition.projectHints !== 'function') return;
    const caps = (engine.runtime && engine.runtime().capabilities) || {};
    if (!caps.transcripts) return;
    const since = Date.now() - HINT_SCAN_DAYS * 86400e3;
    const due = engine.sessions().filter((s) => s.updatedAt && !s.class.heartbeatOf && (scanned.has(s.key) ? s.updatedAt > scanned.get(s.key) : s.updatedAt >= since))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, HINT_SCAN_PER_REFRESH);
    if (!due.length) return;
    scanning = true;
    try {
      for (const s of due) { try { await engine.request('transcript', s.key, { background: true }); } catch (_) { /* quiet: a background read */ } scanned.set(s.key, s.updatedAt); }
    } finally { scanning = false; }
  }
  runtime.start(engine, { refreshed: () => { resolveInterlocutors().catch(() => {}); scanHints().catch(() => {}); } });
  refreshOs();
  const hostTimer = setInterval(refreshOs, every(HOST_MS));
  return { close: () => clearInterval(hostTimer) };
}

module.exports = { startSources };
