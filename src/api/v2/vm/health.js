'use strict';
/*
 * HealthVM (api.md §3.8, contract 2.1). Pure builder over the engine + a CPU/memory sampler.
 * Authoritative example: docs/architecture/examples/health-vm.json (test/api/health-vm.test.js).
 * Cards use the frontend's label keys (healthValue.*, healthSub.*); values are raw numbers with a Unit
 * key; issues are value-free (S4.1).
 */
const { THRESHOLDS } = require('../../../engine/derive/health');
const { project2x: P2 } = require('../project2x');

const lvl = (v, t) => (v == null ? 'ok' : v >= t.alert ? 'alert' : v >= t.warn ? 'warn' : 'ok');
const GB = 1e9;
const SERIES_MAX = 1440;          // 24 h at one point per minute
const STEP_MS = 60000;

// One CPU/memory point per minute, from the engine's latest host metrics (canonical host).
function createHealthSeries({ engine, now = () => Date.now() }) {
  const cpu = [], mem = [];
  let at0 = null;
  function sample() {
    const h = engine.host();
    if (!h) return;
    const t = Math.floor(now() / STEP_MS) * STEP_MS;
    if (at0 == null) at0 = t;
    cpu.push(Math.round(h.cpuPct)); mem.push(h.memTotal ? Math.round((h.memUsed / h.memTotal) * 100) : 0);
    if (cpu.length > SERIES_MAX) { cpu.shift(); mem.shift(); at0 += STEP_MS; }
  }
  return { sample, get: () => ({ cpu: cpu.slice(), mem: mem.slice(), at0: at0 == null ? Math.floor(now() / STEP_MS) * STEP_MS : at0, stepMs: STEP_MS }) };
}

function buildHealthVM({ engine, series, P = P2 }) {
  const h = engine.health();
  const gw = h.gateway, host = h.host;
  const protocol = engine.runtime().protocol;   // G2: the runtime projection, never a raw channel
  const unknown = { key: 'healthValue.unknown' };
  const el = gw.eventLoop;
  const cards = [
    { id: 'gateway', level: gw.connected ? 'ok' : 'alert', value: { key: gw.connected ? 'healthValue.connected' : 'healthValue.disconnected' },
      sub: !gw.connected ? { key: 'healthSub.down' } : protocol != null ? { key: 'healthSub.protocol', params: { n: protocol } } : null },
    host ? { id: 'cpu', level: lvl(host.cpuPct, THRESHOLDS.cpu), value: { n: Math.round(host.cpuPct), unit: 'percent' }, sub: { key: 'healthSub.cores', params: { n: host.cores } } }
      : { id: 'cpu', level: 'ok', value: unknown, sub: null },
    host ? { id: 'memory', level: lvl(host.mem.pct, THRESHOLDS.mem), value: { n: host.mem.pct, unit: 'percent' }, sub: { key: 'healthSub.memTotalGb', params: { n: Math.round(host.mem.total / GB) } } }
      : { id: 'memory', level: 'ok', value: unknown, sub: null },
    host && host.disk ? { id: 'disk', level: lvl(host.disk.pct, THRESHOLDS.disk), value: { n: host.disk.pct, unit: 'percent' }, sub: { key: 'healthSub.diskTotalGb', params: { n: Math.round(host.disk.total / GB) } } }
      : { id: 'disk', level: 'ok', value: unknown, sub: null },
    el ? { id: 'event-loop', level: el.degraded ? 'alert' : 'ok', value: { key: el.degraded ? 'healthValue.degraded' : 'healthValue.healthy' },
      sub: el.delayP99Ms != null ? { key: 'healthSub.p99', params: { n: Math.round(el.delayP99Ms) } } : null }
      : { id: 'event-loop', level: 'ok', value: unknown, sub: null },
    host ? { id: 'uptime', level: 'ok', value: { n: Math.round(host.uptimeSec * 1000), unit: 'ms' }, sub: { key: 'healthSub.sinceBoot' } }
      : { id: 'uptime', level: 'ok', value: unknown, sub: null },
    { id: 'cron', level: h.cron.failing ? 'warn' : 'ok', value: { n: h.cron.total, unit: 'count' },
      sub: h.cron.failing ? { key: 'healthSub.cronFailing', params: { n: h.cron.failing } } : { key: 'healthSub.cronAllOk' } },
    gw.pluginsLoaded != null ? { id: 'plugins', level: 'ok', value: { n: gw.pluginsLoaded, unit: 'count' }, sub: { key: 'healthSub.pluginsAllOk' } }
      : { id: 'plugins', level: 'ok', value: unknown, sub: null },
  ];
  // 2.x: a channel outside the 2.x ChannelId union keeps its pre-G3b id 'raw:<rawId>' (project2x); 3.0: the ChannelRef
  const channels = engine.channels().map((c) => ({ id: P.healthChannelId(c), label: c.label, health: c.health,
    lastError: c.lastError, accounts: c.accounts.length }));
  const sources = engine.sources().map((s) => ({ id: s.id, state: s.state, lastOkAt: s.lastOkAt, lastErrorAt: s.lastErrorAt, lastError: s.lastError,
    channels: s.channels.map((c) => ({ channel: c.channel, state: c.state, lastOkAt: c.lastOkAt, lastErrorAt: c.lastErrorAt, lastError: c.lastError })) }));
  const q = engine.dataQuality();
  const issues = q.issues.map((i) => ({ id: i.fingerprint, code: i.code, severity: i.severity, channel: i.channel, path: i.path, count: i.count,
    firstSeenAt: i.firstSeenAt, lastSeenAt: i.lastSeenAt, state: i.state, mutable: i.severity !== 'error' }));
  return { level: h.level, cards, channels, sources, dataQuality: { open: q.open, issues }, series: series ? series.get() : { cpu: [], mem: [], at0: 0, stepMs: STEP_MS } };
}

module.exports = { buildHealthVM, createHealthSeries };
