'use strict';
// FlowListVM, FlowDetailVM, CronRunVM (api.md §3.4). Pure builders over the engine's canonical CronJob / CronRun.
// S7: `humanCron` and `cronSteps` (v1 views) now live here as `scheduleSentence` and the diagram.
const { LABELS } = require('../../../i18n/fr');
const { project2x: P2 } = require('../project2x');   // G5: or project3x (the `P` param)

const RUNS_MAX = 25;
const pad2 = (n) => String(n).padStart(2, '0');

// ISO 8601 duration for `every` schedules (a LabelRef param is raw data; the client formats it).
function isoDuration(ms) {
  let s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const t = (h ? h + 'H' : '') + (m ? m + 'M' : '') + (s ? s + 'S' : '');
  return 'P' + (d ? d + 'D' : '') + (t ? 'T' + t : (d ? '' : 'T0S'));
}

// A 5-field cron expression → a sentence LabelRef (schedule.weekly / daily / weekdays, else the raw expression).
function cronSentence(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return { key: 'schedule.cron', params: { expr: String(expr || '') } };
  const [m, h, dom, mon, dow] = parts;
  const time = /^\d{1,2}$/.test(h) && /^\d{1,2}$/.test(m) && Number(h) < 24 && Number(m) < 60 ? pad2(h) + ':' + pad2(m) : null;
  if (time && dom === '*' && mon === '*') {
    if (dow === '*') return { key: 'schedule.daily', params: { time } };
    if (dow === '1-5') return { key: 'schedule.weekdays', params: { time } };
    // the day is a nested LabelRef (weekday.0 = Sunday … 6), so each locale names it (copy fix, office-dev)
    if (/^[0-7]$/.test(dow)) return { key: 'schedule.weekly', params: { day: { key: 'weekday.' + (Number(dow) % 7) }, time } };
  }
  return { key: 'schedule.cron', params: { expr: parts.join(' ') } };
}

function scheduleVM(s) {
  if (!s) return { kind: 'unrecognized', sentence: { key: 'schedule.unrecognized' } };
  if (s.kind === 'cron') return { kind: 'cron', expr: s.expr, tz: s.tz, sentence: cronSentence(s.expr) };
  if (s.kind === 'every') return { kind: 'every', everyMs: s.everyMs, anchorAt: s.anchorAt, sentence: { key: 'schedule.every', params: { duration: isoDuration(s.everyMs) } } };
  if (s.kind === 'at') return { kind: 'at', at: s.at, sentence: { key: 'schedule.at', params: { at: new Date(s.at).toISOString() } } };
  return { kind: 'unrecognized', sentence: { key: 'schedule.unrecognized' } };
}

// A LabelRef rendered with the French dictionary (diagram labels are display strings).
function render(ref) {
  const t = LABELS[ref.key] || ref.key;
  return t.replace(/\{(\w+)\}/g, (_, k) => {
    const v = ref.params ? ref.params[k] : null;
    return v == null ? '' : typeof v === 'object' && typeof v.key === 'string' ? render(v) : String(v);   // nested LabelRef
  });
}

function payloadVM(p) {
  if (!p) return { kind: 'unrecognized' };
  if (p.kind === 'agent-turn') return { kind: 'agent-turn', message: p.message, model: p.model, timeoutSeconds: p.timeoutSeconds };
  if (p.kind === 'command') return { kind: 'command', argv: p.argv.slice() };
  if (p.kind === 'heartbeat') return { kind: 'heartbeat' };
  return { kind: 'unrecognized' };
}

function summaryVM(j) {
  return { id: j.id, name: j.name, description: j.description, enabled: j.enabled, schedule: scheduleVM(j.schedule), health: j.health,
    nextRunAt: j.nextRunAt, lastRunAt: j.lastRunAt };
}

function buildFlowListVM(jobs) {
  const flows = jobs.slice().sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, 'fr') || a.id.localeCompare(b.id)).map(summaryVM);
  return { flows, counts: { total: flows.length, enabled: flows.filter((f) => f.enabled).length } };
}

const DECISION = /^(si|sinon|lorsque|quand)\b/i;
function diagramOf(j) {
  const schedule = scheduleVM(j.schedule);
  const nodes = [{ kind: 'trigger', label: render(schedule.sentence) }];
  const p = j.payload;
  if (p && p.kind === 'agent-turn') {
    const steps = j.steps.length ? j.steps : [p.message.split('\n')[0].trim().slice(0, 71) || LABELS['payloadKind.agent-turn']];
    for (const label of steps) nodes.push({ kind: DECISION.test(label) ? 'decision' : 'step', label });
  } else {
    nodes.push({ kind: 'step', label: LABELS['payloadKind.' + (p ? p.kind : 'unrecognized')] || LABELS['payloadKind.unrecognized'] });
  }
  const announces = j.delivery && j.delivery.mode === 'announce';
  nodes.push({ kind: 'output', label: announces ? 'Message' : 'Journal' });
  return { nodes };
}

function runVM(r, P = P2) {
  return { id: r.id, at: r.at, status: r.status, durationMs: r.durationMs, nextRunAt: r.nextRunAt,
    model: r.model && r.model.id ? r.model.id : null,
    tokens: r.usage ? { total: r.usage.total, input: r.usage.input, output: r.usage.output } : null,
    delivery: { status: r.delivery.status, delivered: r.delivery.delivered, channel: P.deliveryChannel(r.delivery.channel) },
    summary: r.summary, error: r.error };
}

// → FlowDetailVM | null (unknown job). `runs` = engine.cronRuns(jobId) ({fetchedAt, runs}) or null before the first read.
// `primaryId`: the resolver's primary, which runs a job that names no agent (G3b)
function buildFlowDetailVM(job, runs, primaryId = null, P = P2) {
  if (!job) return null;
  const s = summaryVM(job);
  const list = runs ? runs.runs.slice().sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, RUNS_MAX).map((r) => runVM(r, P)) : [];
  const ext = P.flowJobExt(job);   // 3.0: OpenClaw-only fields in job.ext.openclaw (D7); 2.x: none
  return {
    job: Object.assign(s, P.flowJobFields(job, primaryId), { payload: payloadVM(job.payload) }, ext === undefined ? {} : { ext },
      { createdAt: job.createdAt, updatedAt: job.updatedAt }),
    // R3-11: only cron + agent-turn is editable through the CLI (--name/--cron/--tz/--message)
    editable: !!(job.schedule && job.schedule.kind === 'cron' && job.payload && job.payload.kind === 'agent-turn'),
    diagram: diagramOf(job),
    runs: list,
  };
}

module.exports = { buildFlowListVM, buildFlowDetailVM, scheduleVM, cronSentence, isoDuration, RUNS_MAX };
