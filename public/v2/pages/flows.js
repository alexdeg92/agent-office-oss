// Flux de travail (S12; frontend-22: the original Bureau cards, as in 75895f4): FlowListVM from GET /api/v2/views/flows,
// kept fresh by the `flows` topic. URL: ?etat=actives|echec|desactivees (display filter), ?q=… (search).
// « Nouvelle tâche » → POST /api/v2/flows, shown only when the runtime can write flows (api-v3 D1).
import { html, useState, useRef, useLayoutEffect } from '../lib.js';
import { useTopic, useStore, runtimeCan } from '../hooks.js';
import { services } from '../services.js';
import { t, label, msg, agentName } from '../i18n.js';
import * as fmt from '../fmt.js';
import { Frame, Icon, Skeleton, StateArt, ErrorState, Ago } from '../components/ui.js';
import { Modal } from '../components/modal.js';
import { openclawWrite, fieldErrors } from '../openclaw-api.js';
import { matchesQuery } from '../board.js';
import * as rules from './flows-rules.js';
import { Button, TextInput, ListRow } from '../components/bureau/index.js';
import { useSmallWorkspace } from './workspace-mobile.js';
export { loadStyles } from './workspace-mobile.js';

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/** OpenClaw writes allowed? (capabilities from the stream's hello, else MetaVM; staging says no). */
export function useOpenclawWrites() {
  const status = useStore(services.stream.status);
  const caps = status.capabilities || (services.meta && services.meta.capabilities) || { openclawWrites: true };
  return caps.openclawWrites !== false;
}
/** Shown next to write actions on a read-only instance; the server's 403 message also appears on any attempt. */
export const ReadonlyNote = ({ id, cls = 'ao-ro' }) => html`<p class=${'bu-caption bu-text-tertiary ' + cls} id=${id}><${Icon} name="info" />${msg('flows.readonly')}</p>`;

/** api-v3 D1: the runtime can't write flows (`runtime.capabilities.flows.write === false`): the reason, no write action. */
export const CapabilityNote = ({ id, k = 'flows.capability.write' }) => html`<p class="bu-caption bu-text-tertiary ao-ro" id=${id}><${Icon} name="info" />${msg(k)}</p>`;

export const CachedBanner = ({ error, onRetry }) => html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="warning" />
  <span class="bu-banner__text">${msg('common.updateFailed', { error: error.message })}</span>
  <button type="button" class="bu-btn bu-btn--sm" onClick=${onRetry}>${msg('common.retry')}</button></div>`;

const HEALTH_TONE = { ok: 'success', failing: 'danger', 'never-run': null };
const HEALTH_ICON = { ok: 'success', failing: 'alert', 'never-run': 'clock' };
const HealthChip = ({ health }) => html`<span class=${'bu-chip bu-chip--sm' + (HEALTH_TONE[health] ? ' bu-chip--' + HEALTH_TONE[health] : '')}><${Icon} name=${HEALTH_ICON[health] || 'info'} />${t('flowHealth.' + health)}</span>`;
const EnabledChip = ({ enabled }) => html`<span class=${'bu-chip bu-chip--sm' + (enabled ? ' bu-chip--accent' : '')}><span class=${'bu-dot' + (enabled ? ' bu-dot--accent' : '')} aria-hidden="true"></span>${msg(enabled ? 'flows.chip.enabled' : 'flows.chip.disabled')}</span>`;

export function FlowsPage({ match }) {
  const { router } = services;
  const small = useSmallWorkspace();
  const rail = useRef(null);
  const vm = useTopic('flows', '/api/v2/views/flows');
  const filter = rules.keep[match.query.etat] ? match.query.etat : '';
  const q = match.query.q || '';
  const [creating, setCreating] = useState(false);
  const writes = useOpenclawWrites();
  const canWrite = runtimeCan('flows.write');

  // Reveal a selected filter in the strip without moving the page or content scroll position.
  useLayoutEffect(() => {
    const selected = rail.current?.querySelector('[aria-pressed=true]');
    if (!selected) return;
    const r = rail.current.getBoundingClientRect(), b = selected.getBoundingClientRect();
    rail.current.scrollLeft += b.left < r.left ? b.left - r.left : b.right > r.right ? b.right - r.right : 0;
  }, [filter, small, vm.data]);
  const all = vm.data ? vm.data.flows : null;
  const shown = all ? all.filter((f) => rules.keep[filter](f) && matchesQuery(f.name + ' ' + (f.description || ''), q)) : [];
  const count = (v) => (all ? all.filter(rules.keep[v]).length : 0);
  // The write action sits in a [data-write-actions] container (api-v3 D1 gating test: test/pages/register-gating.dom.test.js).
  const createBtn = (compact = false) => (canWrite ? html`<span class="ao-flows__actions" data-write-actions><${Button}
    variant="primary" label=${msg('flows.create')} icon=${html`<${Icon} name="add" />`} iconOnly=${compact}
    onPress=${() => setCreating(true)} describedBy=${writes ? undefined : 'flows-ro'} /></span>` : null);

  return html`<${Frame} class="bu-page ao-page ao-page--wide ao-flows ao-workspace" aria-busy=${vm.resyncing || (!all && !vm.error) ? 'true' : undefined}
    bodyLabel=${msg('nav.flux')} head=${html`<div class="ao-workspace__toolbar">
      <${TextInput} class="ao-flows__search ao-workspace__search" type="search" placeholder=${msg('flows.search.cards')}
        label=${msg('flows.search.aria')} value=${q} onValueChange=${value => router.setQuery({ q: value.trim() || null })} />
      ${createBtn(small)}
    </div>`} bar=${html`<div class="ao-flows__rail" ref=${rail} role="group" aria-label=${msg('flows.filter.aria')}>
      ${rules.FILTERS.map(v => html`<${Button} key=${v || 'all'} label=${msg('flows.filter.' + (v || 'all')) + (all ? ' ' + fmt.number(count(v)) : '')}
        pressed=${filter === v} variant="ghost" onPress=${() => router.setQuery({ etat: v || null })} />`)}
    </div>`}>
    ${vm.data === undefined && vm.error ? html`<${ErrorState} error=${vm.error} onRetry=${vm.retry} />` : null}
    ${!canWrite ? html`<${CapabilityNote} id="flows-ro" />` : writes ? null : html`<${ReadonlyNote} id="flows-ro" />`}
    ${vm.error && all ? html`<${CachedBanner} error=${vm.error} onRetry=${vm.retry} />` : null}
    ${!all ? vm.error ? null : html`<ul class="ao-flows__grid ao-flows__loading" aria-label=${msg('flows.loading')}>${[0, 1, 2, 3, 4, 5].map((k) => html`<li key=${k} class="bu-card"><${Skeleton} kind="title" /><${Skeleton} /><${Skeleton} w="50" /></li>`)}</ul>`
      : !all.length ? html`<div class="bu-empty">
          <${StateArt} slug="no-flows" />
          <p class="bu-empty__title">${msg('flows.empty.head')}</p>
          <p class="bu-empty__text">${msg('flows.empty.text')}</p>
          ${createBtn()}</div>`
      : !shown.length ? html`<div class="bu-card bu-card--sunken"><div class="bu-empty bu-empty--compact"><p class="bu-empty__title">${msg('flows.noMatch')}</p>
          <button type="button" class="bu-btn bu-btn--sm" onClick=${() => router.setQuery({ etat: null, q: null })}>${msg('flows.showAll')}</button></div></div>`
      : html`<ul class="ao-flows__mobile ao-workspace__list">${shown.map(f => html`<${ListRow} key=${f.id} muted=${!f.enabled}
          icon=${html`<${Icon} name="clock" />`} title=${html`<a class="ao-workspace__link" href=${router.href('flux-detail', { jobId: f.id })}>${f.name}</a>`}
          badges=${!f.enabled ? html`<${EnabledChip} enabled=${false} />` : null}
          meta=${html`<div>${label(f.schedule.sentence)}</div><div class="ao-workspace__meta"><${HealthChip} health=${f.health} />
            ${f.nextRunAt ? html`<span>${msg('flows.card.next')} <${Ago} at=${f.nextRunAt} /></span>` : f.lastRunAt ? html`<span>${msg('flows.card.last')} <${Ago} at=${f.lastRunAt} /></span>` : null}</div>`} />`)}</ul>
        <ul class="ao-flows__grid">${shown.map((f) => html`<li key=${f.id}><a class=${'bu-card bu-card--interactive ao-flow-card' + (f.enabled ? '' : ' bu-card--muted')} href=${router.href('flux-detail', { jobId: f.id })}>
          <div class="bu-card__header"><span class="bu-icon-tile" aria-hidden="true"><${Icon} name="flux" /></span><h3 class="bu-card__title bu-truncate" title=${f.name}>${f.name}</h3><span class="bu-spacer"></span><${EnabledChip} enabled=${f.enabled} /></div>
          ${f.description ? html`<p class="bu-card__desc">${f.description}</p>` : null}
          <p class="ao-flow-card__when"><${Icon} name="clock" />${label(f.schedule.sentence)}</p>
          <div class="bu-card__footer"><${HealthChip} health=${f.health} />
            <span>${f.nextRunAt ? html`${msg('flows.card.next')} <${Ago} at=${f.nextRunAt} />` : f.lastRunAt ? html`${msg('flows.card.last')} <${Ago} at=${f.lastRunAt} />` : '—'}</span></div>
        </a></li>`)}</ul>`}
    ${creating ? html`<${FlowFormModal} onClose=${() => setCreating(false)} />` : null}
  </${Frame}>`;
}

const tzList = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return [fmt.timeZone(), 'UTC']; } })();
export const FIELDS = ['name', 'cron', 'tz', 'message'];

/** The flow form (create and edit). Validation is the server's (api.md §5.1); its messages appear under each field. */
export function FlowFields({ values, errors, onInput, idPrefix }) {
  const f = (k) => idPrefix + '-' + k;
  const err = (k) => (errors[k] ? html`<p class="bu-field__error" id=${f(k) + '-err'}><${Icon} name="alert" />${errors[k]}</p>` : null);
  const aria = (k) => (errors[k] ? { 'aria-invalid': 'true', 'aria-describedby': f(k) + '-err' } : {});
  const req = html`<span class="bu-field__req" aria-hidden="true">*</span>`;
  return html`
    ${errors._form ? html`<div class="bu-banner bu-banner--danger" role="alert"><${Icon} name="alert" /><span class="bu-banner__text">${errors._form}</span></div>` : null}
    <div class="bu-field"><label class="bu-field__label" for=${f('name')}>${msg('flows.form.name')} ${req}</label>
      <input class="bu-input" id=${f('name')} name="name" maxlength="80" required autocomplete="off" value=${values.name} onInput=${(e) => onInput('name', e.currentTarget.value)} ...${aria('name')} />${err('name')}</div>
    <div class="bu-form-row">
      <div class="bu-field"><label class="bu-field__label" for=${f('cron')}>${msg('flows.form.cron')} ${req}</label>
        <input class="bu-input bu-mono" id=${f('cron')} name="cron" required autocomplete="off" spellcheck="false" placeholder="0 9 * * 1" value=${values.cron} onInput=${(e) => onInput('cron', e.currentTarget.value)} ...${aria('cron')} />
        ${err('cron') || html`<p class="bu-field__hint">${msg('flows.form.cronHint')}</p>`}</div>
      <div class="bu-field"><label class="bu-field__label" for=${f('tz')}>${msg('flows.form.tz')} ${req}</label>
        <input class="bu-input" id=${f('tz')} name="tz" required list=${f('tzlist')} autocomplete="off" spellcheck="false" value=${values.tz} onInput=${(e) => onInput('tz', e.currentTarget.value)} ...${aria('tz')} />
        <datalist id=${f('tzlist')}>${tzList.map((z) => html`<option key=${z} value=${z} />`)}</datalist>${err('tz')}</div>
    </div>
    <div class="bu-field"><label class="bu-field__label" for=${f('message')}>${msg('flows.form.message')} ${req}</label>
      <textarea class="bu-textarea ao-flow-msg" id=${f('message')} name="message" required maxlength="4000" placeholder=${msg('flows.form.messagePlaceholder')}
        onInput=${(e) => onInput('message', e.currentTarget.value)} ...${aria('message')}>${values.message}</textarea>
      ${err('message') || html`<p class="bu-field__hint">${msg('flows.form.messageHint', { count: values.message.length })}</p>`}</div>`;
}

function FlowFormModal({ onClose }) {
  const { router } = services;
  const [values, setValues] = useState({ name: '', cron: '0 9 * * 1', tz: fmt.timeZone(), message: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErrors({});
    const res = await openclawWrite('POST', '/api/v2/flows', { name: values.name, cron: values.cron, tz: values.tz, message: values.message }, { formErrors: true, success: msg('flows.toast.created') });
    setBusy(false);
    if (!res.ok) { setErrors(fieldErrors(res.error, FIELDS)); return; }
    onClose();
    const id = res.data.result && res.data.result.jobId;
    if (id) router.navigate(router.href('flux-detail', { jobId: id }));
  }
  return html`<${Modal} size="md" title=${msg('flows.form.title')} desc=${msg('flows.form.desc', { agent: cap(agentName()) })} onClose=${onClose}
    footer=${html`<${Button} label=${msg('flows.form.cancel')} onPress=${onClose} /><${Button} type="submit" form="flow-new" variant="primary" busy=${busy} label=${msg('flows.form.submit')} />`}>
    <form id="flow-new" class="ao-form" onSubmit=${submit} novalidate>
      <${FlowFields} values=${values} errors=${errors} idPrefix="nf" onInput=${(k, v) => setValues((x) => ({ ...x, [k]: v }))} />
    </form>
  </${Modal}>`;
}

