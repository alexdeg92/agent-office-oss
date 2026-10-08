'use strict';
// HealthSnapshot (data-model.md §10). Thresholds were hard-coded in the v1 buildHealth(); named here.
const T = { cpu: { warn: 55, alert: 85 }, mem: { warn: 75, alert: 90 }, disk: { warn: 75, alert: 90 } };
const lvl = (v, t) => (v >= t.alert ? 'alert' : v >= t.warn ? 'warn' : 'ok');
const worst = (...l) => (l.includes('alert') ? 'alert' : l.includes('warn') ? 'warn' : 'ok');

// `runtime` is the adapter's canonical projection of the runtime's own health ({ version, pluginsLoaded,
// eventLoop }, G2): the core never reads a runtime's raw health payload.
function deriveHealth({ now, host, runtime, gateway, cronJobs, sources, quality }) {
  const rt = runtime || { version: null, pluginsLoaded: null, eventLoop: null };
  const memPct = host && host.memTotal ? Math.round((host.memUsed / host.memTotal) * 100) : null;
  const diskPct = host && host.disk ? Math.round((host.disk.used / host.disk.total) * 100) : null;
  const jobs = cronJobs || [];
  const snap = {
    at: now,
    gateway: { connected: !!gateway.connected, since: gateway.since, version: rt.version || gateway.version || null,
      pluginsLoaded: rt.pluginsLoaded, eventLoop: rt.eventLoop },
    host: host ? { hostname: host.host, cpuPct: host.cpuPct, load1: host.load1, cores: host.ncpu, mem: { used: host.memUsed, total: host.memTotal, pct: memPct },
      disk: host.disk ? { used: host.disk.used, total: host.disk.total, pct: diskPct } : null, uptimeSec: host.uptimeSec } : null,
    cron: { enabled: jobs.filter((j) => j.enabled).length, total: jobs.length, failing: jobs.filter((j) => j.health === 'failing').length },
    sources: sources.map((s) => Object.assign({}, s)),
    dataQuality: quality,
  };
  snap.level = worst(
    snap.gateway.connected ? 'ok' : 'alert',
    snap.gateway.eventLoop && snap.gateway.eventLoop.degraded ? 'alert' : 'ok',
    host ? lvl(host.cpuPct, T.cpu) : 'ok', memPct != null ? lvl(memPct, T.mem) : 'ok', diskPct != null ? lvl(diskPct, T.disk) : 'ok',
    quality.open.error ? 'warn' : 'ok',
  );
  return snap;
}

module.exports = { deriveHealth, THRESHOLDS: T };
