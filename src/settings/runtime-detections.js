'use strict';
// One instance association for Settings cards, agent discovery and diagnostics.
// Adapter descriptors supply identities; core matching never guesses from kind alone.
const path = require('node:path');
const { adapterById, ADAPTER_IDS } = require('../adapters');
const normalizePath = value => typeof value === 'string' && value ? path.resolve(value) : null;
function normalizeGateway(value) {
  try {
    const url = new URL(value);
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin + url.pathname.replace(/\/$/, '');
  } catch { return null; }
}
function matchScore(left, right) {
  const equal = (key, normalize) => (left?.[key] || []).some(a => {
    const value = normalize(a); return value && (right?.[key] || []).some(b => value === normalize(b));
  });
  return equal('gateways', normalizeGateway) ? 2 : equal('paths', normalizePath) ? 1 : 0;
}
function runtimeDetections({ config, cfg, detections = [] }) {
  const saved = config.runtimes.filter(r => !ADAPTER_IDS.includes(r.adapter) || !adapterById(r.adapter).setup.settings?.optional || r.enabled);
  const rows = saved.map(entry => ({ entry, detection: null })), unmatched = [];
  for (const detection of detections) {
    const A = ADAPTER_IDS.includes(detection.runtime) ? adapterById(detection.runtime) : null;
    const identity = A?.setup.settings?.detectionIdentity;
    const observed = identity?.({ detection });
    const matches = rows.filter(r => r.entry.adapter === detection.runtime).map(row => {
      const child = cfg.runtimeInstances?.find(r => r.id === row.entry.id)?.cfg;
      return { row, score: matchScore(identity?.({ cfg: child || cfg, entry: row.entry }), observed) };
    }).filter(r => r.score).sort((a, b) => b.score - a.score);
    if (matches.length) matches[0].row.detection = detection;
    else unmatched.push(detection);
  }
  const kinds = new Map(require('../adapters/detection').runtimeCatalog().map(d => [d.runtime, d]));
  for (const id of ADAPTER_IDS) if (!kinds.has(id)) kinds.set(id, { runtime: id, name: adapterById(id).setup.name });
  for (const detection of unmatched) kinds.set(detection.runtime, detection);
  for (const [kind, detection] of kinds) {
    const A = ADAPTER_IDS.includes(kind) ? adapterById(kind) : null;
    const observed = unmatched.find(d => d.runtime === kind);
    // Optional transcript connectors still need a Settings candidate when the
    // detector found their local session store; otherwise users cannot see or
    // enable the connector before it has a saved runtime instance.
    if (A?.setup.settings?.optional && !observed?.found) continue;
    if (rows.some(r => r.detection?.runtime === kind)) continue;
    if (saved.some(r => r.adapter === kind) && !unmatched.some(d => d.runtime === kind && d.found)) continue;
    // A configured instance ID must never be reused for a candidate of another kind.
    let id = kind, suffix = 1;
    while (config.runtimes.some(r => r.id === id) || rows.some(r => r.entry.id === id)) id = kind + '-detected-' + suffix++;
    rows.push({ entry: { id, adapter: kind, enabled: false, candidate: true }, detection: observed || null, name: detection.name });
  }
  return rows;
}
module.exports = { runtimeDetections, normalizePath, normalizeGateway };
