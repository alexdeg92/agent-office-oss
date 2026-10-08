// Flux de travail (F6, office-dev): the sentences of the flows pages, chosen by rules from FlowListVM / FlowDetailVM.
// Pure: VM → message descriptors { key, params, tone } that the pages localize with i18n.msg/rich (messages/flows.js).
// Nothing is claimed without its evidence (editorial-guide.md §2):
//   - `health: 'failing'` is « un résultat en échec est signalé », never « the last run failed » (a newer run may
//     have been skipped or be running);
//   - enabled is not healthy, completed is not delivered, a planned diagram is not live progress.
// Lead order (guide §2): no snapshot → cached → enabled failing → never run → normal / empty.

const byName = (a, b) => a.name.localeCompare(b.name);
export const isFailing = (f) => f.enabled && f.health === 'failing';

/** The list page's lead: kicker, headline, standfirst, read-on target, margin (next run). */
export function listLead(vm, { cachedAt = null, cached = false } = {}) {
  const flows = vm.flows;
  const head = [];
  if (cached) head.push(cachedAt != null ? { key: 'editorial.cached', params: { date: { at: cachedAt } }, tone: 'warning' } : { key: 'editorial.unknownTime', tone: 'warning' });
  if (!flows.length) return { kicker: 'flows.kicker', kickerTone: null, head: [...head, { key: 'flows.empty.head' }], stand: [{ key: 'flows.empty.text' }], readOn: null, next: null };

  const failing = flows.filter(isFailing);
  const disabledFailing = flows.filter((f) => !f.enabled && f.health === 'failing');
  const neverRun = flows.filter((f) => f.enabled && f.health === 'never-run');
  let readOn = null;
  if (failing.length) {
    head.push({ key: 'flows.head.failing', params: { n: failing.length }, tone: 'danger' });
    readOn = failing[0].id;
  } else if (!vm.counts.enabled) head.push({ key: 'flows.head.noneEnabled' });
  else head.push({ key: 'flows.head.ok', params: { n: vm.counts.enabled } });

  const stand = [{ key: 'flows.stand.enabled', params: { enabled: vm.counts.enabled, n: vm.counts.total } }];
  if (failing.length) stand.push({ key: 'flows.stand.failingNames', params: { names: failing.map((f) => f.name) } });
  if (disabledFailing.length) stand.push({ key: 'flows.stand.disabledFailing', params: { n: disabledFailing.length } });
  if (neverRun.length) stand.push({ key: 'flows.stand.neverRun', params: { n: neverRun.length } });

  // The next known run: the earliest nextRunAt of an enabled task (no prediction beyond what the VM says).
  const next = flows.filter((f) => f.enabled && typeof f.nextRunAt === 'number').sort((a, b) => a.nextRunAt - b.nextRunAt || byName(a, b))[0] ?? null;
  return { kicker: failing.length ? 'flows.kicker.check' : 'flows.kicker', kickerTone: failing.length ? 'danger' : null, head, stand, readOn, next };
}

/** One task's state, as one line (the register row and the detail lead share it). */
export function stateSentence(f) {
  if (!f.enabled && f.health === 'failing') return { key: 'flows.state.disabledFailing', tone: 'danger' };
  if (!f.enabled) return { key: 'flows.state.disabled' };
  if (f.health === 'failing') return { key: 'flows.state.failing', tone: 'danger' };
  if (f.health === 'never-run') return { key: 'flows.state.neverRun' };
  return { key: 'flows.state.ok' };
}

/** The register row's margin: schedule, zone, next or last known run. */
export function rowMeta(f) {
  const out = [{ key: 'flows.meta.schedule', params: { schedule: f.schedule.sentence } }];
  if (f.enabled && typeof f.nextRunAt === 'number') out.push({ key: 'flows.meta.next', params: { date: { at: f.nextRunAt } } });
  else if (typeof f.lastRunAt === 'number') out.push({ key: 'flows.meta.last', params: { date: { at: f.lastRunAt } } });
  else out.push({ key: 'flows.meta.noRun' });
  return out;
}

/** The filters (display only): state keys in the URL (?etat=). */
export const FILTERS = ['', 'actives', 'echec', 'desactivees'];
export const keep = { '': () => true, actives: (f) => f.enabled, echec: (f) => f.health === 'failing', desactivees: (f) => !f.enabled };

/** The detail page's lead. `now` is only used for a running run's duration. */
export function detailLead(d, { now = Date.now() } = {}) {
  const j = d.job;
  const run = d.runs[0] ?? null;
  const head = [];
  const stand = [];
  if (run && run.status === 'running') {
    const ms = Math.max(0, now - run.at);
    // Under a minute: « vient de commencer » (no « depuis 0 ms »); then whole minutes, the page refreshes every 15 s.
    head.push(ms < 60_000 ? { key: 'flow.head.runningJust', tone: 'info' } : { key: 'flow.head.running', params: { duration: { n: Math.floor(ms / 60_000) * 60_000, unit: 'ms' } }, tone: 'info' });
  } else head.push(stateSentence(j));
  // What the newest recorded run says, as a fact about that run (never as the task's health).
  if (run && run.status === 'failed') stand.push({ key: 'flow.stand.lastFailed', params: { date: { at: run.at } }, tone: 'danger' });
  else if (run && run.status === 'succeeded') stand.push({ key: 'flow.stand.lastSucceeded', params: { date: { at: run.at } } });
  else if (run && run.status === 'skipped') stand.push({ key: 'flow.stand.lastSkipped', params: { date: { at: run.at } } });
  if (!j.enabled) stand.push({ key: 'flow.stand.noNext' });
  else if (typeof j.nextRunAt === 'number') stand.push({ key: 'flow.stand.next', params: { date: { at: j.nextRunAt } } });
  else stand.push({ key: 'flow.stand.nextUnknown' });
  return { head, stand };
}

/** One recorded run, as a sentence: status with its duration when known. */
export function runSentence(r) {
  const d = typeof r.durationMs === 'number' ? { n: r.durationMs, unit: 'ms' } : null;
  switch (r.status) {
    case 'succeeded': return d ? { key: 'flow.run.succeededIn', params: { duration: d } } : { key: 'flow.run.succeeded' };
    case 'failed': return d ? { key: 'flow.run.failedAfter', params: { duration: d }, tone: 'danger' } : { key: 'flow.run.failed', tone: 'danger' };
    case 'running': return { key: 'flow.run.running', tone: 'info' };
    case 'skipped': return { key: 'flow.run.skipped' };
    default: return { key: 'flow.run.unrecognized', tone: 'warning' };
  }
}

/** Delivery is its own fact: delivered / not delivered / none / unknown (an unknown raw status keeps its value). */
export function deliverySentence(r) {
  const s = r.delivery?.status;
  if (s == null) return { key: 'flow.delivery.unknown' };
  const known = ['delivered', 'not-delivered', 'skipped', 'none'].includes(s);
  // An unknown raw status passes through as its own text (open vocabulary); a known one is a server label.
  const status = known ? { key: 'delivery.' + s } : String(s);
  return r.delivery.channel ? { key: 'flow.delivery.via', params: { status, channel: { key: 'channel.' + r.delivery.channel } } } : { key: 'flow.delivery.status', params: { status } };
}

/** The instruction as ordered steps when it is written one per line (display only; the text is user content). */
export const instructionLines = (message) => String(message || '').split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean);
