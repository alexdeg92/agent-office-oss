'use strict';

// Only these stable, public surface classes may leave the engine. Unknown
// internal surface names are folded into one bucket and are never serialized.
const SURFACES = Object.freeze({
  office: 'health.parity.surface.office',
  'office.limited': 'health.parity.surface.officeLimited',
});
const FIELDS = Object.freeze(['comparisons', 'mismatches', 'changedRows', 'overflowKeys', 'overflowSurfaces']);
const MAX = 1_000_000;

function value(n) { return Number.isSafeInteger(n) && n >= 0 ? Math.min(MAX, n) : 0; }

function collect(engine) {
  let raw = {};
  try { raw = engine?.orchestrationParityCounters?.() || {}; } catch { /* diagnostics must not affect the request */ }
  const zeroes = () => Object.fromEntries(FIELDS.map(key => [key, 0]));
  const known = new Map(Object.keys(SURFACES).map(surface => [surface, zeroes()]));
  let other = zeroes();
  for (const [surface, counts] of Object.entries(raw)) {
    const target = Object.hasOwn(SURFACES, surface) ? surface : 'other';
    const into = target === 'other' ? other : known.get(target);
    for (const key of FIELDS) into[key] = Math.min(MAX, into[key] + value(counts?.[key]));
    if (target !== 'other') known.set(target, into);
  }
  return { known, other };
}

function healthRows(engine) {
  const { known, other } = collect(engine);
  const labels = Object.fromEntries(FIELDS.map(key => [key, { key: 'health.parity.' + key }]));
  const rows = [...known].sort(([a], [b]) => a.localeCompare(b)).map(([surface, counts]) => ({ surface: { key: SURFACES[surface] }, labels, ...counts }));
  if (Object.values(other).some(Boolean)) rows.push({ surface: { key: 'health.parity.surface.other' }, labels, ...other });
  return rows;
}

function logSnapshot(engine) {
  const { known, other } = collect(engine);
  const surfaces = [...known].sort(([a], [b]) => a.localeCompare(b)).map(([surface, counts]) => ({ surface, ...counts }));
  if (Object.values(other).some(Boolean)) surfaces.push({ surface: 'other', ...other });
  return { event: 'engine.parity', surfaces };
}

function startReporter({ engine, log = () => {}, onSample = () => {}, intervalMs = 600_000, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  const timer = setIntervalFn(() => {
    try { log(logSnapshot(engine)); } catch { /* metrics logging cannot affect the server */ }
    try { onSample(); } catch { /* topic invalidation is best effort */ }
  }, intervalMs);
  timer?.unref?.();
  return () => clearIntervalFn(timer);
}

module.exports = { collect, healthRows, logSnapshot, startReporter, SURFACES, FIELDS };
