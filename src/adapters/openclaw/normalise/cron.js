'use strict';
const { channelIdOf } = require('./channel');
/*
 * cron.list / cron.runs → CronJob[] / CronRun[] (data-model.md §5).
 * `issue(code, severity, path, detail, sample)` records quarantine issues for unmapped enum values.
 * Vocabulary still unconfirmed (job lastRunStatus, run completionStatus — scrambled in
 * capture-20261005) is kept as a raw string and reported at INFO level, so staging tells us the real
 * set without warning noise. Delivery status is confirmed (live CLI check on S4 staging + the active
 * capture): delivered, not-delivered, not-requested, skipped; anything else stays raw at INFO.
 */
const SESSION_TARGET = new Set(['isolated', 'main']);
const WAKE_MODE = new Set(['now', 'next-heartbeat']);
const DELIVERY_MODE = new Set(['none', 'announce']);
const RUN_STATUS = { ok: 'succeeded', error: 'failed', skipped: 'skipped', running: 'running' };
const DELIVERY_STATUS = { delivered: 'delivered', 'not-delivered': 'not-delivered', 'not-requested': 'none', skipped: 'skipped' };

// CronDelivery.channel: ChannelRef | 'last' | null (data-model §5; R6-09; G3b). Aliases map like channels.status
// (openclaw-weixin → wechat); only a raw value that isn't a slug is 'unrecognized', with a warn issue.
const deliveryChannel = (raw, issue) => {
  if (raw == null || raw === '') return null;
  if (raw === 'last') return 'last';
  const id = channelIdOf(raw);
  if (id === 'unrecognized') issue('enum.unmapped', 'warn', '$.jobs[].delivery.channel', 'value not in the table');
  return id;
};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);   // R2-03: never inherited members
const enumOr = (set, v, issue, path) => {
  if (v == null) return null;
  if (set.has(v)) return v;
  issue('enum.unmapped', 'warn', path, 'value not in the table', { length: String(v).length });
  return 'unrecognized';
};
const pending = (v, issue, path) => {
  if (v == null) return null;
  issue('enum.unmapped', 'info', path, 'vocabulary not confirmed yet (kept raw)', { length: String(v).length });
  return String(v);
};
const delivery = (v, issue, path) => (v != null && own(DELIVERY_STATUS, v) ? DELIVERY_STATUS[v] : pending(v, issue, path));

// Steps for the flow diagram, from the instruction text (was cronSteps() in public/app.js).
function stepsOf(msg) {
  let steps = [...String(msg || '').matchAll(/^\s*(\d+)[.)]\s+(.+)$/gm)].map((m) => m[2].trim()).filter((s) => s.length < 72).slice(0, 6);
  if (!steps.length) steps = [...String(msg || '').matchAll(/^([A-Z][A-Z0-9 /&'-]{4,}):/gm)].map((m) => m[1].trim().toLowerCase()).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).slice(0, 5);
  return steps;
}

function schedule(s, issue) {
  if (s.kind === 'cron') return { kind: 'cron', expr: s.expr || '', tz: s.tz || null };
  if (s.kind === 'every') return { kind: 'every', everyMs: s.everyMs || 0, anchorAt: Number.isInteger(s.anchorMs) && s.anchorMs > 1.5e12 ? s.anchorMs : null };
  if (s.kind === 'at') {
    const t = Date.parse(s.at || '');
    if (Number.isFinite(t)) return { kind: 'at', at: t };
    issue('shape.invalid', 'warn', '$.jobs[].schedule.at', 'unparseable date', null);
    return { kind: 'unrecognized', rawKind: 'at' };
  }
  issue('enum.unmapped', 'warn', '$.jobs[].schedule.kind', 'value not in the table', { length: String(s.kind).length });
  return { kind: 'unrecognized', rawKind: String(s.kind) };
}

function payload(p, issue) {
  if (!p) return null;
  if (p.kind === 'agentTurn') return { kind: 'agent-turn', message: p.message || '', timeoutSeconds: p.timeoutSeconds ?? null, model: p.model || null, toolsAllow: p.toolsAllow || null, lightContext: !!p.lightContext };
  if (p.kind === 'heartbeat') return { kind: 'heartbeat' };
  if (p.kind === 'command') return { kind: 'command', argv: p.argv || [] };
  // legacy/synthetic 'message' payloads carry an instruction like agentTurn
  if (p.kind === 'message') return { kind: 'agent-turn', message: p.message || '', timeoutSeconds: null, model: null, toolsAllow: null, lightContext: false };
  issue('enum.unmapped', 'warn', '$.jobs[].payload.kind', 'value not in the table', { length: String(p.kind).length });
  return { kind: 'unrecognized', rawKind: String(p.kind) };
}

function normaliseCronJobs(v, issue) {
  return v.jobs.map((j) => {
    const pl = payload(j.payload, issue);
    const last = j.lastRunStatus != null ? (own(RUN_STATUS, j.lastRunStatus) ? RUN_STATUS[j.lastRunStatus] : pending(j.lastRunStatus, issue, '$.jobs[].lastRunStatus')) : null;
    return {
      id: j.id, name: j.displayName || j.name, description: j.description || '', enabled: j.enabled,
      schedule: schedule(j.schedule, issue),
      agentId: j.agentId || null,   // G3b: none = the runtime's default agent (the resolver's primary), never a guessed 'main'
      sessionTarget: enumOr(SESSION_TARGET, j.sessionTarget, issue, '$.jobs[].sessionTarget'),
      wakeMode: enumOr(WAKE_MODE, j.wakeMode, issue, '$.jobs[].wakeMode'),
      payload: pl,
      delivery: j.delivery ? { mode: enumOr(DELIVERY_MODE, j.delivery.mode, issue, '$.jobs[].delivery.mode'), channel: deliveryChannel(j.delivery.channel, issue), to: j.delivery.to || null } : null,
      steps: pl && pl.kind === 'agent-turn' ? stepsOf(pl.message) : [],
      createdAt: j.createdAtMs || null, updatedAt: j.updatedAtMs || null,
      nextRunAt: j.nextRunAtMs || null, lastRunAt: j.lastRunAtMs || null,
      lastRunStatus: last, lastRunError: j.lastRunError || null,
      lastDeliveryStatus: delivery(j.lastDeliveryStatus, issue, '$.jobs[].lastDeliveryStatus'),
      deleteAfterRun: !!j.deleteAfterRun,
      sessionKey: j.sessionKey || null,
      health: last === 'failed' ? 'failing' : j.lastRunAtMs || last ? 'ok' : 'never-run',
    };
  });
}

function normaliseCronRuns(v, jobId, issue) {
  const raw = v.entries || v.runs || [];
  return raw.map((e) => {
    const at = e.runAtMs || e.ts || 0;
    const status = e.status != null ? (own(RUN_STATUS, e.status) ? RUN_STATUS[e.status] : enumOr(new Set(), e.status, issue, '$.entries[].status')) : 'unrecognized';
    const u = e.usage;
    return {
      id: e.runId || `${e.jobId || jobId}@${at}`, jobId: e.jobId || jobId, sessionKey: e.sessionKey || null,
      at, action: e.action || null, status,
      completionStatus: pending(e.completionStatus, issue, '$.entries[].completionStatus'),
      durationMs: Number.isInteger(e.durationMs) ? e.durationMs : null, nextRunAt: e.nextRunAtMs || null,
      model: e.model || e.provider ? { id: e.model || null, provider: e.provider || null } : null,
      usage: u ? { total: u.total_tokens || u.totalTokens || 0, input: u.input_tokens || 0, output: u.output_tokens || 0 } : null,
      delivery: { status: delivery(e.deliveryStatus, issue, '$.entries[].deliveryStatus'), delivered: typeof e.delivered === 'boolean' ? e.delivered : null,
        channel: (e.delivery && e.delivery.intended && e.delivery.intended.channel) || null },
      summary: e.summary || (e.diagnostics && e.diagnostics.summary) || '',
      error: e.error || null,
    };
  }).sort((a, b) => b.at - a.at);
}

module.exports = { normaliseCronJobs, normaliseCronRuns, stepsOf };
