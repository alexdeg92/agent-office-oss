// Mock HealthVM (api.md 2.1 §3.8), invented data, conformed to health-vm.json. Issues are value-free (no source,
// detail or sample: the PM's diagnostics privacy rule); paths are schema paths.
import { EXAMPLES, conform } from './examples.js';
// buildHealth(scenario, now, tick) is deterministic for a given tick, so screenshots are reproducible.

const MIN = 60_000;
const levelOf = (v, warn, alert) => (v >= alert ? 'alert' : v >= warn ? 'warn' : 'ok');
const worst = (levels) => (levels.includes('alert') ? 'alert' : levels.includes('warn') ? 'warn' : 'ok');

// Smooth, plausible 24 h curves (CPU around 20 %, a nightly backup spike; memory slowly climbing).
function cpuAt(i) { return Math.round(18 + 9 * Math.sin(i / 37) + 5 * Math.sin(i / 7.3) + (i % 1440 > 1200 && i % 1440 < 1225 ? 38 : 0)); }
function memAt(i) { return Math.round(54 + 9 * Math.sin(i / 160) + 3 * Math.sin(i / 23)); }

export function buildHealth(scenario = '1', now = Date.now(), tick = 0) {
  if (scenario === 'vide') return emptyHealth(now);
  const down = scenario === 'panne';
  const start = Math.floor(now / MIN) * MIN - 1439 * MIN;
  const base = Math.floor(start / MIN);
  const cpuSeries = Array.from({ length: 1440 }, (_, k) => Math.max(1, Math.min(99, cpuAt(base + k + tick))));
  const memSeries = Array.from({ length: 1440 }, (_, k) => Math.max(1, Math.min(99, memAt(base + k + tick))));
  const cpu = cpuSeries[cpuSeries.length - 1];
  const mem = memSeries[memSeries.length - 1];
  const disk = 78;

  const cards = [
    { id: 'gateway', level: down ? 'alert' : 'ok', value: { key: down ? 'healthValue.disconnected' : 'healthValue.connected' }, sub: down ? { key: 'healthSub.down' } : { key: 'healthSub.protocol', params: { n: 4 } } },
    { id: 'cpu', level: levelOf(cpu, 55, 85), value: { n: cpu, unit: 'percent' }, sub: { key: 'healthSub.cores', params: { n: 8 } } },
    { id: 'memory', level: levelOf(mem, 75, 90), value: { n: mem, unit: 'percent' }, sub: { key: 'healthSub.memTotalGb', params: { n: 32 } } },
    { id: 'disk', level: levelOf(disk, 75, 90), value: { n: disk, unit: 'percent' }, sub: { key: 'healthSub.diskTotalGb', params: { n: 512 } } },
    { id: 'event-loop', level: down ? 'warn' : 'ok', value: { key: down ? 'healthValue.unknown' : 'healthValue.healthy' }, sub: down ? null : { key: 'healthSub.p99', params: { n: 11 + (tick % 4) } } },
    { id: 'uptime', level: 'ok', value: { n: (1_123_200 + tick * 2) * 1000, unit: 'ms' }, sub: { key: 'healthSub.sinceBoot' } },
    { id: 'cron', level: 'warn', value: { n: 7, unit: 'count' }, sub: { key: 'healthSub.cronFailing', params: { n: 1 } } },
    { id: 'plugins', level: down ? 'warn' : 'ok', value: { n: down ? 0 : 12, unit: 'count' }, sub: down ? { key: 'healthSub.down' } : { key: 'healthSub.pluginsAllOk' } },
  ];

  const channels = [
    { id: 'discord', label: 'Discord', health: down ? 'error' : 'connected', lastError: down ? 'Passerelle injoignable' : null, accounts: 1 },
    { id: 'whatsapp', label: 'WhatsApp', health: 'stopped', lastError: null, accounts: 1 },
    { id: 'wechat', label: 'WeChat', health: 'not-configured', lastError: null, accounts: 0 },
  ];

  const ago = (m) => now - m * MIN;
  // SourceStatusVM (api.md 2.0 §3.8): value-free error categories, one entry per channel.
  const ch = (channel, state, okAgo, errAgo = null, lastError = null) => ({ channel, state, lastOkAt: okAgo == null ? null : ago(okAgo), lastErrorAt: errAgo == null ? null : ago(errAgo), lastError });
  const src = (id, state, channels, lastError = null) => {
    const ok = channels.map((c) => c.lastOkAt).filter((x) => x != null);
    const err = channels.map((c) => c.lastErrorAt).filter((x) => x != null);
    return { id, state, lastOkAt: ok.length ? Math.max(...ok) : null, lastErrorAt: err.length ? Math.max(...err) : null, lastError, channels };
  };
  const sources = [
    down ? src('gateway', 'down', [ch('gw.rpc.health', 'stale', 4, 0.03, 'connection-closed'), ch('gw.rpc.sessions.list', 'stale', 4, 0.03, 'connection-closed')], 'connection-closed')
      : src('gateway', 'fresh', [ch('gw.rpc.health', 'fresh', 0.05), ch('gw.rpc.sessions.list', 'fresh', 0.1), ch('gw.rpc.cron.list', 'fresh', 0.1)]),
    src('host', 'fresh', [ch('host.os', 'fresh', 0.02), ch('host.df', 'fresh', 0.5)]),
    src('config', 'fresh', [ch('config.file', 'fresh', 0.6)]),
    src('cli.skills', 'stale', [ch('cli.skills.list', 'stale', 14, 2, 'killed-or-timeout'), ch('cli.skills.info', 'fresh', 30)], 'killed-or-timeout'),
    src('discord', 'fresh', [ch('discord.rest', 'fresh', 3)]),
    src('store', 'fresh', [ch('store.sqlite', 'fresh', 0.08)]),
  ];

  const issues = [
    { id: 'iss_7f3a', code: 'cli.failed', severity: 'error', channel: 'cli.skills.list', path: null, count: 3, firstSeenAt: ago(41), lastSeenAt: ago(2), state: 'open' },
    { id: 'iss_21c9', code: 'enum.unmapped', severity: 'warn', channel: 'gw.rpc.sessions.list', path: '$.sessions[].completionStatus', count: 18, firstSeenAt: ago(60 * 26), lastSeenAt: ago(6), state: 'open' },
    { id: 'iss_9b02', code: 'activity.unmapped', severity: 'warn', channel: 'gw.event.session.tool', path: '$.payload.kind', count: 5, firstSeenAt: ago(95), lastSeenAt: ago(19), state: 'open' },
    { id: 'iss_c4d1', code: 'shape.extra-field', severity: 'info', channel: 'gw.rpc.cron.list', path: '$.jobs[].<undeclared>', count: 240, firstSeenAt: ago(60 * 50), lastSeenAt: ago(1), state: 'open' },
    { id: 'iss_e815', code: 'event.unknown', severity: 'info', channel: 'gw.event.<unadvertised>', path: null, count: 1312, firstSeenAt: ago(60 * 70), lastSeenAt: ago(0.2), state: 'muted' },
  ];
  if (down) issues.unshift({ id: 'iss_0a11', code: 'rpc.failed', severity: 'error', channel: 'gw.rpc.health', path: null, count: 2, firstSeenAt: ago(4), lastSeenAt: now - 2_000, state: 'open' });

  for (const i of issues) i.mutable = i.severity !== 'error';
  return finish({ cards, channels, sources, issues, cpuSeries, memSeries, start });
}

export function finish({ cards, channels, sources, issues, cpuSeries, memSeries, start }) {
  const open = { error: 0, warn: 0, info: 0 };
  for (const i of issues) if (i.state === 'open') open[i.severity]++;
  return conform(EXAMPLES.healthVm.data, {
    level: worst(cards.map((c) => c.level)),
    cards,
    channels,
    sources,
    dataQuality: { open, issues },
    series: { cpu: cpuSeries, mem: memSeries, at0: start, stepMs: 60000 },
  });
}

function emptyHealth(now) {
  return {
    level: 'ok',
    cards: [],
    channels: [],
    sources: [],
    dataQuality: { open: { error: 0, warn: 0, info: 0 }, issues: [] },
    series: { cpu: [], mem: [], at0: now, stepMs: 60000 },
  };
}

/** Recomputes level and open counts after an issue changed (used by the mock mute command). */
export function withIssue(vm, id, patch) {
  const issues = vm.dataQuality.issues.map((i) => (i.id === id ? { ...i, ...patch } : i));
  const open = { error: 0, warn: 0, info: 0 };
  for (const i of issues) if (i.state === 'open') open[i.severity]++;
  return { ...vm, dataQuality: { open, issues } };
}
