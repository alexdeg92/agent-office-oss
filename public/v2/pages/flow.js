import { buildQuery } from '../config.js';
// Flux de travail, a scheduled task (S12; owner office-dev): FlowDetailVM from GET /api/v2/views/flows/:jobId, kept
// fresh by `flow:<jobId>` (a run started here appears and finishes live over SSE). The original S7a design, restored
// in office-dev-18: detail header with chips, actions row, execution-flow diagram, Planification / Configuration
// cards, run history, the instruction. Actions (api.md §5.1) are OpenClaw writes (403 « Instance de test » on
// staging) and need the runtime's `flows.write` (api-v3 D1): enable/disable, « Exécuter maintenant », edit (only when
// `editable`), delete (two steps). Messages: messages/flow.js ('task.*'), FR and EN.
import { html, useState, useEffect, useRef } from '../lib.js';
import { useTopic, runtimeCan } from '../hooks.js';
import { services } from '../services.js';
import { t, label, msg, agentName } from '../i18n.js';
import * as fmt from '../fmt.js';
import { Icon, EmptyState, ErrorState, Skeleton } from '../components/ui.js';
import { openclawWrite, fieldErrors } from '../openclaw-api.js';
import { FlowFields, FIELDS, useOpenclawWrites, ReadonlyNote, CapabilityNote } from './flows.js';

const enc = encodeURIComponent;
export const flowTopic = (id) => 'flow:' + enc(id);
const RUN_TONE = { succeeded: 'success', failed: 'danger', skipped: null, running: 'info', unrecognized: 'warning' };
const RUN_ICON = { succeeded: 'success', failed: 'error', skipped: 'state-idle', running: 'refresh', unrecognized: 'warning' };
const NODE_ICON = { trigger: 'clock', step: null, decision: 'warning', output: 'check' };
const HEALTH_TONE = { ok: 'success', failing: 'danger', 'never-run': null };
const HEALTH_ICON = { ok: 'success', failing: 'alert', 'never-run': 'clock' };

const CSS = new URL('./flow.css' + buildQuery, import.meta.url).href;
function useFlowCss() {
  useEffect(() => {
    if (document.querySelector('link[data-flow-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = CSS; l.dataset.flowCss = '';
    document.head.append(l);
  }, []);
}

const HealthChip = ({ health }) => html`<span class=${'bu-chip bu-chip--sm' + (HEALTH_TONE[health] ? ' bu-chip--' + HEALTH_TONE[health] : '')}><${Icon} name=${HEALTH_ICON[health] || 'info'} />${t('flowHealth.' + health)}</span>`;
const EnabledChip = ({ enabled }) => html`<span class=${'bu-chip bu-chip--sm' + (enabled ? ' bu-chip--accent' : '')}><span class=${'bu-dot' + (enabled ? ' bu-dot--accent' : '')} aria-hidden="true"></span>${msg(enabled ? 'task.enabled' : 'task.disabled')}</span>`;

/** api-v3 D7: OpenClaw's wake mode and session target live in `job.ext.openclaw` (3.0) or on the job (2.x). */
const openclawOf = (j) => (j.ext && j.ext.openclaw) || j;
/** A delivery channel: a 3.0 ChannelRef ({ id, label? }) or a 2.x id; an unknown one reads « Autre ({id}) ». */
function channelText(c) {
  if (c == null) return null;
  if (typeof c === 'object') return c.label ? label(c.label) : label({ key: 'channel.' + c.id });
  return label({ key: 'channel.' + c });
}
function deliveryText(d) {
  if (!d || d.status == null) return '—';
  const known = ['delivered', 'not-delivered', 'skipped', 'none'].includes(d.status);
  const status = known ? t('delivery.' + d.status) : String(d.status);   // open vocabulary: an unknown status as is
  const ch = channelText(d.channel);
  return ch ? `${status} · ${ch}` : status;
}

export function FlowPage({ match }) {
  useFlowCss();
  const { router } = services;
  const id = match.params.jobId;
  const vm = useTopic(flowTopic(id), '/api/v2/views/flows/' + enc(id));
  const writes = useOpenclawWrites();
  const [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState(false);
  const armTimer = useRef(null);
  useEffect(() => () => clearTimeout(armTimer.current), []);
  const back = router.href('flux');
  const Back = () => html`<a class="bu-backlink" href=${back}><${Icon} name="arrow-left" />${msg('task.back')}</a>`;
  const page = (body, busyAttr) => html`<div class="bu-page ao-frame ao-frame--detail ao-flow" aria-busy=${busyAttr ? 'true' : undefined}>${body}</div>`;

  if (vm.data === undefined && vm.error) {
    return page(html`<${Back} />${vm.error.code === 'not_found'
      ? html`<${EmptyState} icon="flux" art="not-found" title=${msg('task.notFound.title')} text=${msg('task.notFound.text')}><a class="bu-btn" href=${back}>${msg('task.notFound.back')}</a></${EmptyState}>`
      : html`<${ErrorState} error=${vm.error} onRetry=${vm.retry} />`}`);
  }
  if (vm.data === undefined) return page(html`<${Back} /><${Skeleton} kind="title" /><${Skeleton} style="width:50%" /><${Skeleton} kind="block" /><${Skeleton} kind="block" />`, true);

  const { job: j, editable, diagram, runs } = vm.data;
  const oc = openclawOf(j);
  const path = '/api/v2/flows/' + enc(j.id);
  const running = runs[0] && runs[0].status === 'running';
  const can = runtimeCan('flows.write');
  const ro = writes ? undefined : 'flow-ro';
  const act = async (key, method, sub, body, success) => { setBusy(key); const r = await openclawWrite(method, path + sub, body, { success }); setBusy(null); return r; };
  async function remove() {
    if (!armed) { setArmed(true); clearTimeout(armTimer.current); armTimer.current = setTimeout(() => setArmed(false), 4000); return; }
    setArmed(false);
    const r = await act('delete', 'DELETE', '', {}, msg('task.toast.deleted'));
    if (r.ok) router.navigate(back);
  }

  return page(html`
    <${Back} />
    ${vm.error ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" /><span class="bu-banner__text">${msg('task.cached', { message: vm.error.message })}</span><button class="bu-btn bu-btn--sm" onClick=${vm.retry}>${msg('task.retry')}</button></div>` : null}
    <header class="bu-detail-header">
      <span class="bu-icon-tile bu-icon-tile--lg" aria-hidden="true"><${Icon} name="flux" size="md" /></span>
      <div class="ao-flow__headtext">
        <h2 class="bu-detail-header__title">${j.name}<${EnabledChip} enabled=${j.enabled} /><${HealthChip} health=${j.health} /></h2>
        ${j.description ? html`<p class="bu-detail-header__desc">${j.description}</p>` : null}
        <p class="bu-detail-header__meta">${label(j.schedule.sentence)}${j.schedule.kind === 'cron' && j.schedule.tz ? ` · ${j.schedule.tz}` : ''} · ${msg('task.meta.agent', { agent: j.agentId })}</p>
      </div>
    </header>

    ${can ? html`<div class="ao-flow__actions" data-write-actions>
      <label class="bu-switch"><input type="checkbox" role="switch" checked=${j.enabled} disabled=${busy === 'enabled'} aria-describedby=${ro}
        onChange=${(e) => { e.currentTarget.checked = j.enabled; act('enabled', 'PUT', '/enabled', { enabled: !j.enabled }, msg(j.enabled ? 'task.toast.disabled' : 'task.toast.enabled')); }} />${msg(j.enabled ? 'task.enabled' : 'task.disabled')}</label>
      <button type="button" class="bu-btn bu-btn--primary" disabled=${busy === 'run' || running} aria-busy=${busy === 'run' || running ? 'true' : undefined} aria-describedby=${ro}
        onClick=${() => act('run', 'POST', '/runs', {}, msg('task.toast.run'))}><${Icon} name="state-working" />${msg(running ? 'task.action.running' : 'task.action.run')}</button>
      ${editable ? html`<button type="button" class="bu-btn" aria-expanded=${editing ? 'true' : 'false'} aria-controls="fl-edit-form" onClick=${() => setEditing(!editing)}><${Icon} name="pencil" />${msg('task.action.edit')}</button>` : null}
      <button type="button" class=${'bu-btn ' + (armed ? 'bu-btn--armed' : 'bu-btn--danger-ghost')} disabled=${busy === 'delete'} aria-describedby=${ro} onClick=${remove}>
        <${Icon} name="close" />${msg(armed ? 'task.action.confirmDelete' : 'task.action.delete')}</button>
      ${writes ? null : html`<${ReadonlyNote} id="flow-ro" />`}
    </div>
    ${editable ? null : html`<p class="bu-caption bu-text-tertiary">${msg('task.notEditable')}</p>`}
    ${editing && editable ? html`<${EditForm} job=${j} path=${path} onDone=${() => setEditing(false)} />` : null}`
    : html`<${CapabilityNote} id="flow-ro" />`}

    ${diagram.nodes.length ? html`<section class="bu-card ao-section" aria-labelledby="fl-diagram">
      <h3 class="bu-card__title" id="fl-diagram">${msg('task.diagram.title')}</h3>
      <ol class="bu-flow">${diagram.nodes.map((n, i) => {
        const kind = ['trigger', 'step', 'decision', 'output'].includes(n.kind) ? n.kind : 'step';
        return html`
        ${i ? html`<li key=${'a' + i} class="bu-flow__arrow" aria-hidden="true"><${Icon} name="arrow-right" /></li>` : null}
        <li key=${'n' + i} class=${'bu-flow__node bu-flow__node--' + kind}><span class="bu-flow__kind">${NODE_ICON[kind] ? html`<${Icon} name=${NODE_ICON[kind]} />` : null}${msg('task.node.' + kind)}</span><span class="bu-flow__label">${n.label}</span></li>`;
      })}</ol>
      <p class="bu-caption bu-text-tertiary">${msg('task.diagram.note')}</p>
    </section>` : null}

    <div class="bu-grid--2 ao-flow__pair">
      <section class="bu-card ao-section" aria-labelledby="fl-sched">
        <h3 class="bu-card__title" id="fl-sched">${msg('task.schedule.title')}</h3>
        <dl class="bu-kv">
          ${j.schedule.kind === 'cron' ? html`<div class="bu-kv__row"><dt>${msg('task.schedule.expr')}</dt><dd class="bu-mono">${j.schedule.expr}</dd></div>` : null}
          <div class="bu-kv__row"><dt>${msg('task.schedule.plain')}</dt><dd>${label(j.schedule.sentence)}</dd></div>
          ${j.schedule.kind === 'cron' ? html`<div class="bu-kv__row"><dt>${msg('task.schedule.zone')}</dt><dd>${j.schedule.tz || '—'}</dd></div>` : null}
          <div class="bu-kv__row"><dt>${msg('task.schedule.next')}</dt><dd>${j.nextRunAt ? fmt.dateTime(j.nextRunAt) : '—'}</dd></div>
          <div class="bu-kv__row"><dt>${msg('task.schedule.last')}</dt><dd>${j.lastRunAt ? fmt.dateTime(j.lastRunAt) : msg('task.schedule.never')}</dd></div>
          ${oc.wakeMode ? html`<div class="bu-kv__row"><dt>${msg('task.schedule.wake')}</dt><dd>${t('wakeMode.' + oc.wakeMode)}</dd></div>` : null}
        </dl>
      </section>
      <section class="bu-card ao-section" aria-labelledby="fl-conf">
        <h3 class="bu-card__title" id="fl-conf">${msg('task.config.title')}</h3>
        <dl class="bu-kv">
          <div class="bu-kv__row"><dt>${msg('task.config.agent')}</dt><dd>${j.agentId}</dd></div>
          ${oc.sessionTarget ? html`<div class="bu-kv__row"><dt>${msg('task.config.target')}</dt><dd>${t('sessionTarget.' + oc.sessionTarget)}</dd></div>` : null}
          <div class="bu-kv__row"><dt>${msg('task.config.kind')}</dt><dd>${t('payloadKind.' + j.payload.kind)}</dd></div>
          ${j.payload.kind === 'agent-turn' ? html`<div class="bu-kv__row"><dt>${msg('task.config.model')}</dt><dd>${j.payload.model || msg('task.config.default')}</dd></div>
            <div class="bu-kv__row"><dt>${msg('task.config.timeout')}</dt><dd>${j.payload.timeoutSeconds ? fmt.duration(j.payload.timeoutSeconds * 1000) : msg('task.config.default')}</dd></div>` : null}
          <div class="bu-kv__row"><dt>${msg('task.config.created')}</dt><dd>${j.createdAt ? fmt.dateTime(j.createdAt) : '—'}</dd></div>
          <div class="bu-kv__row"><dt>${msg('task.config.updated')}</dt><dd>${j.updatedAt ? fmt.dateTime(j.updatedAt) : '—'}</dd></div>
          <div class="bu-kv__row"><dt>${msg('task.config.id')}</dt><dd class="bu-mono">${j.id}</dd></div>
        </dl>
      </section>
    </div>

    <section class="bu-card ao-section" aria-labelledby="fl-runs">
      <div class="ao-section__head"><h3 class="bu-card__title" id="fl-runs">${msg('task.runs.title')}</h3><span class="bu-count">${runs.length}</span></div>
      ${runs.length ? html`<div class="ao-runs" aria-live="polite">${runs.map((r, i) => html`<${Run} key=${r.id} run=${r} open=${i === 0} />`)}</div>`
        : html`<p class="bu-text-secondary">${msg('task.runs.empty')}</p>`}
    </section>

    ${j.payload.kind === 'agent-turn' ? html`<section class="bu-card ao-section" aria-labelledby="fl-msg">
      <h3 class="bu-card__title" id="fl-msg">${msg('task.message.title')}</h3>
      <pre class="bu-code ao-flow__msg"><code>${j.payload.message}</code></pre>
    </section>` : j.payload.kind === 'command' ? html`<section class="bu-card ao-section" aria-labelledby="fl-cmd">
      <h3 class="bu-card__title" id="fl-cmd">${msg('task.command.title')}</h3><pre class="bu-code"><code>${j.payload.argv.join(' ')}</code></pre></section>` : null}
  `, vm.resyncing);
}

function Run({ run: r, open }) {
  const tone = RUN_TONE[r.status];
  return html`<details class="bu-run" open=${open} data-status=${r.status}>
    <summary>
      <span class=${'bu-chip bu-chip--sm' + (tone ? ' bu-chip--' + tone : '')}>${r.status === 'running' ? html`<span class="bu-spinner ao-spin-sm" aria-hidden="true"></span>` : html`<${Icon} name=${RUN_ICON[r.status] || 'info'} />`}${t('runStatus.' + r.status)}</span>
      <span class="bu-run__when"><time datetime=${new Date(r.at).toISOString()}>${fmt.dateTime(r.at)}</time></span>
      <span class="bu-run__stats">${[r.durationMs != null ? fmt.duration(r.durationMs) : null, r.tokens ? fmt.tokens(r.tokens.total) : null].filter(Boolean).join(' · ') || (r.status === 'running' ? msg('task.run.running') : '—')}</span>
    </summary>
    <div class="bu-run__body">
      <p class="bu-run__facts">
        <span>${msg('task.run.model')} <b>${r.model || '—'}</b></span>
        ${r.tokens ? html`<span>${msg('task.run.io')} <b>${fmt.number(r.tokens.input)} / ${fmt.number(r.tokens.output)}</b></span>` : null}
        <span>${msg('task.run.delivery')} <b>${deliveryText(r.delivery)}</b></span>
        ${r.nextRunAt ? html`<span>${msg('task.run.next')} <b>${fmt.dateTime(r.nextRunAt)}</b></span>` : null}
      </p>
      ${r.summary ? html`<div class="bu-code"><pre><code>${r.summary}</code></pre></div>` : null}
      ${r.error ? html`<div class="bu-banner bu-banner--danger"><${Icon} name="alert" /><span class="bu-banner__text">${r.error}</span></div>` : null}
      ${!r.summary && !r.error && r.status === 'running' ? html`<p class="bu-caption bu-text-tertiary">${msg('task.run.waiting', { agent: agentName() })}</p>` : null}
    </div>
  </details>`;
}

function EditForm({ job, path, onDone }) {
  const initial = { name: job.name, cron: job.schedule.expr || '', tz: job.schedule.tz || '', message: job.payload.message || '' };
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    const body = Object.fromEntries(FIELDS.filter((k) => values[k] !== initial[k]).map((k) => [k, values[k]]));
    if (!Object.keys(body).length) { setErrors({ _form: msg('task.form.noChange') }); return; }
    setBusy(true); setErrors({});
    const res = await openclawWrite('PATCH', path, body, { formErrors: true, success: msg('task.toast.saved') });
    setBusy(false);
    if (res.ok) onDone(); else setErrors(fieldErrors(res.error, FIELDS));
  }
  return html`<section class="bu-card ao-section" id="fl-edit-form" aria-labelledby="fl-edit">
    <h3 class="bu-card__title" id="fl-edit">${msg('task.form.title')}</h3>
    <form class="ao-form" onSubmit=${submit} novalidate>
      <${FlowFields} values=${values} errors=${errors} idPrefix="ef" onInput=${(k, v) => setValues((x) => ({ ...x, [k]: v }))} />
      <div class="bu-btn-group"><button type="submit" class="bu-btn bu-btn--primary" disabled=${busy} aria-busy=${busy ? 'true' : undefined}>${msg(busy ? 'task.form.saving' : 'task.form.save')}</button>
        <button type="button" class="bu-btn" onClick=${onDone}>${msg('task.form.cancel')}</button></div>
    </form>
  </section>`;
}
