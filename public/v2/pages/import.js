// « Importer des projets »: review the discovery candidates, adjust them, import the chosen ones.
// api.md 2.1 §3.14/§5.4: GET /api/v2/views/project-candidates → CandidatesVM (one-shot GET, « Actualiser »);
// POST /api/v2/projects/import { keys, overrides? } → CommandResult<{ created: {key, id}[], skipped: {key, reason}[] }>.
// URL: ?source=github|workspace|sessionGroup, ?confiance=high|medium|low.
// The checkboxes and inline edits are unsent form input (api.md §1), so they stay in the page.
import { assetUrl } from '../config.js';
import { html, useState, useEffect, useRef } from '../lib.js';
import { useFetch } from '../hooks.js';
import { services } from '../services.js';
import { t, msg, label } from '../i18n.js';
import * as fmt from '../fmt.js';
import { get, post, toastError } from '../api.js';
import { toast } from '../toast.js';
import { Icon, EmptyState, ErrorState, Ago, Skeleton } from '../components/ui.js';
import { STATUSES, labelTone } from '../board.js';

export const CANDIDATES_URL = '/api/v2/views/project-candidates';
export const IMPORT_URL = '/api/v2/projects/import';

const SOURCE_FILTERS = [['', 'import.f.all'], ['github', 'import.f.github'], ['workspace', 'import.f.workspace'], ['sessionGroup', 'import.f.sessionGroup']];
const CONF_FILTERS = [['', 'import.f.all'], ['high', 'import.conf.high'], ['medium', 'import.conf.medium'], ['low', 'import.conf.low']];
const CONF = { high: ['success', 'success', 'import.confidence.high'], medium: ['warning', 'warning', 'import.confidence.medium'], low: [null, 'info', 'import.confidence.low'] };
const SOURCE_ICON = { github: 'branche', workspace: 'folder', sessionGroup: 'journaux', manual: 'pencil' };
const statusLabel = (s) => t('projectStatus.' + s);
const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const sourceText = (s) => label(s.label);
const SKIP_REASON = { unknown: 'import.skip.unknown', exists: 'import.skip.exists', validation_failed: 'import.skip.invalid' };

export function ImportPage({ match }) {
  const { router } = services;
  const back = services.lastBoardUrl || router.href('projets');
  const vm = useFetch(CANDIDATES_URL, async (url) => (await get(url, { quiet: true })).data);
  const source = SOURCE_FILTERS.some(([v]) => v && v === match.query.source) ? match.query.source : '';
  const conf = CONF_FILTERS.some(([v]) => v && v === match.query.confiance) ? match.query.confiance : '';
  const [selected, setSelected] = useState(null);   // Set of keys; null until the list arrives
  const [overrides, setOverrides] = useState({});  // key → { name?, status?, labels? }
  const [busy, setBusy] = useState(false);

  // Start with the confident suggestions checked.
  useEffect(() => {
    if (!vm.data) return;
    if (selected === null) setSelected(new Set(vm.data.candidates.filter((c) => c.confidence !== 'low').map((c) => c.key)));
    else { const keys = new Set(vm.data.candidates.map((c) => c.key)); setSelected((s) => new Set([...s].filter((k) => keys.has(k)))); }
  }, [vm.data]);

  if (vm.data === undefined && vm.error) return html`<div class="bu-page ao-frame ao-frame--detail"><a class="bu-backlink" href=${back}><${Icon} name="arrow-left" />${msg('nav.projets')}</a><${ErrorState} error=${vm.error} onRetry=${vm.reload} /></div>`;
  const list = vm.data ? vm.data.candidates : null;
  const sel = selected || new Set();
  const visible = list ? list.filter((c) => (!source || c.sources.some((s) => s.kind === source)) && (!conf || c.confidence === conf)) : [];
  const count = list ? list.filter((c) => sel.has(c.key)).length : 0;
  const toggle = (key, on) => setSelected((s) => { const n = new Set(s || []); if (on) n.add(key); else n.delete(key); return n; });
  const setAll = (on) => setSelected((s) => { const n = new Set(s || []); for (const c of visible) { if (on) n.add(c.key); else n.delete(c.key); } return n; });
  const patchOverride = (key, patch) => setOverrides((o) => {
    const next = { ...(o[key] || {}), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    return { ...o, [key]: next };
  });

  async function submit() {
    const keys = list.filter((c) => sel.has(c.key)).map((c) => c.key);
    if (!keys.length) return;
    const body = { keys, overrides: Object.fromEntries(Object.entries(overrides).filter(([k, o]) => keys.includes(k) && Object.keys(o).length)) };
    setBusy(true);
    try {
      const r = await post(IMPORT_URL, body, { quiet: true });
      const { created = [], skipped = [] } = (r.data && r.data.result) || {};
      const nameOf = (key) => (overrides[key] && overrides[key].name) || (list.find((c) => c.key === key) || {}).name || key;
      if (created.length) toast({ level: 'success', message: msg('import.done', { n: created.length }) });
      if (skipped.length) {
        toast({ level: 'warning', message: msg('import.skipped', { n: skipped.length, list: skipped.map((x) => ({ msg: SKIP_REASON[x.reason] || 'import.skip.other', params: { name: nameOf(x.key), reason: x.reason } })) }) });
      }
      if (!created.length) { setBusy(false); setSelected(null); vm.reload(); return; }
      // One project: open it; several: back to the board.
      router.navigate(created.length === 1 ? router.href('projet', { projectId: created[0].id }) : back);
    } catch (err) {
      setBusy(false);
      if (err.code === 'conflict') { toast({ level: 'warning', message: err.message, code: 'CONFLICT' }); setSelected(null); vm.reload(); }
      else if (err.code !== 'unauthorized') toastError(err);
    }
  }

  return html`<div class="bu-page ao-frame ao-frame--detail ao-import">
    <a class="bu-backlink" href=${back}><${Icon} name="arrow-left" />${msg('nav.projets')}</a>
    <header class="ao-import__head">
      <h2 class="bu-title ao-import__title">${msg('projects.import')}</h2>
      <p class="bu-text-secondary ao-import__lede">${msg('import.lede')}</p>
      ${vm.data ? html`<div class="ao-import__scan"><p class="bu-caption bu-text-tertiary">${msg('import.scanned')} <${Ago} at=${vm.data.scannedAt} /> · ${msg('import.suggestions', { n: list.length })}</p>
        <button type="button" class="bu-btn bu-btn--ghost bu-btn--sm" onClick=${vm.reload} disabled=${vm.loading} aria-busy=${vm.loading ? 'true' : undefined}><${Icon} name="refresh" />${msg('import.refresh')}</button></div>` : null}
    </header>
    ${!list ? html`<${ImportSkeleton} />` : !list.length ? html`<div class="bu-empty">
        <img class="ao-illus" src=${assetUrl('bureau/assets/Illustrations/all-good.webp')} alt="" width="400" height="300" />
        <p class="bu-empty__title">${msg('import.none')}</p>
        <p class="bu-empty__text">${msg('import.none.text')}</p>
        <a class="bu-btn" href=${back}>${msg('project.backToBoard')}</a></div>` : html`
      <div class="bu-toolbar ao-import__filters">
        <div class="ao-filter"><span class="bu-label bu-text-tertiary" id="f-source">${msg('import.source')}</span>
          <div class="ao-scroll-x"><div class="bu-segmented" role="group" aria-labelledby="f-source">
            ${SOURCE_FILTERS.map(([v, key]) => html`<button key=${v} type="button" class="bu-segmented__opt" aria-pressed=${source === v ? 'true' : 'false'} onClick=${() => router.setQuery({ source: v || null })}>${v ? html`<${Icon} name=${SOURCE_ICON[v]} />` : null}${msg(key)}</button>`)}
          </div></div></div>
        <div class="ao-filter"><span class="bu-label bu-text-tertiary" id="f-conf">${msg('import.confidenceLabel')}</span>
          <div class="ao-scroll-x"><div class="bu-segmented" role="group" aria-labelledby="f-conf">
            ${CONF_FILTERS.map(([v, key]) => html`<button key=${v} type="button" class="bu-segmented__opt" aria-pressed=${conf === v ? 'true' : 'false'} onClick=${() => router.setQuery({ confiance: v || null })}>${msg(key)}</button>`)}
          </div></div></div>
        <span class="bu-spacer"></span>
        <div class="bu-btn-group">
          <button type="button" class="bu-btn bu-btn--ghost bu-btn--sm" onClick=${() => setAll(true)} disabled=${!visible.length}>${msg('import.checkAll')}</button>
          <button type="button" class="bu-btn bu-btn--ghost bu-btn--sm" onClick=${() => setAll(false)} disabled=${!visible.length}>${msg('import.uncheckAll')}</button>
        </div>
      </div>
      ${visible.length ? html`<ul class="bu-list ao-import__list">
        ${visible.map((c) => html`<${Candidate} key=${c.key} c=${c} checked=${sel.has(c.key)} o=${overrides[c.key] || {}}
          onToggle=${(on) => toggle(c.key, on)} onOverride=${(patch) => patchOverride(c.key, patch)} />`)}
      </ul>` : html`<div class="bu-card bu-card--sunken"><${EmptyState} compact icon="filter" title=${msg('import.noMatch')} text=${msg('import.noMatch.text')} /></div>`}
      ${visible.length < list.length ? html`<p class="bu-caption bu-text-tertiary">${msg(list.some((c) => sel.has(c.key) && !visible.includes(c)) ? 'import.hiddenChecked' : 'import.hidden', { n: list.length - visible.length })}</p>` : null}
      <div class="ao-import__bar" role="region" aria-label=${msg('import.region')}>
        <span class="bu-text-secondary" aria-live="polite">${msg('import.selected', { n: count })}</span>
        <span class="bu-spacer"></span>
        <a class="bu-btn" href=${back}>${msg('common.cancel')}</a>
        <button type="button" class="bu-btn bu-btn--primary" disabled=${!count || busy} aria-busy=${busy ? 'true' : undefined} onClick=${submit}>
          <${Icon} name="import" />${msg('import.submit', { n: count })}</button>
      </div>`}
  </div>`;
}

function Candidate({ c, checked, o, onToggle, onOverride }) {
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const nameRef = useRef(null);
  const name = o.name ?? c.name;
  const status = o.status ?? c.suggestedStatus;
  const labels = o.labels ?? c.labels;
  const [tone, icon, confKey] = CONF[c.confidence] || CONF.low;
  const id = 'cand-' + slug(c.key);
  useEffect(() => { if (editing) nameRef.current?.select(); }, [editing]);
  const commitName = (v) => { const next = v.trim(); onOverride({ name: next && next !== c.name ? next : undefined }); setEditing(false); };
  const addLabel = (e) => {
    e.preventDefault();
    const v = labelDraft.trim();
    if (!v || labels.some((l) => slug(label(l)) === slug(v))) { setLabelDraft(''); return; }
    onOverride({ labels: [...labels, v] }); setLabelDraft('');
  };
  return html`<li class=${'bu-card ao-cand' + (checked ? ' is-selected' : '')}>
    <div class="ao-cand__head">
      <label class="bu-check ao-cand__check"><input type="checkbox" checked=${checked} onChange=${(e) => onToggle(e.currentTarget.checked)} aria-labelledby=${id + '-name'} /></label>
      <div class="ao-cand__name">
        ${editing ? html`<input ref=${nameRef} class="bu-input bu-input--sm" aria-label=${msg('import.name')} maxlength="80" value=${name}
            onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); commitName(e.currentTarget.value); } else if (e.key === 'Escape') setEditing(false); }}
            onBlur=${(e) => commitName(e.currentTarget.value)} />`
          : html`<span class="bu-heading-sm" id=${id + '-name'}>${name}</span>
            ${o.name ? html`<span class="bu-caption bu-text-tertiary">${msg('import.suggestedName', { name: c.name })}</span>` : null}
            ${c.summary ? html`<span class="ao-cand__summary bu-caption bu-text-secondary">${c.summary}</span>` : null}
            <button type="button" class="bu-btn bu-btn--ghost bu-btn--icon bu-btn--sm" aria-label=${msg('import.rename', { name })} title=${msg('import.renameShort')} onClick=${() => setEditing(true)}><${Icon} name="pencil" /></button>`}
      </div>
      ${c.lastActivityAt ? html`<span class="bu-caption bu-text-tertiary ao-cand__when">${msg('import.activity')} <${Ago} at=${c.lastActivityAt} /></span>` : null}
    </div>
    <div class="ao-cand__body">
      <div class="ao-cand__field">
        <label class="bu-field__label" for=${id + '-status'}>${msg('projects.new.stage')}</label>
        <div class="ao-cand__status">
          <select class="bu-select bu-input--sm" id=${id + '-status'} onChange=${(e) => onOverride({ status: e.currentTarget.value === c.suggestedStatus ? undefined : e.currentTarget.value })}>
            ${STATUSES.map((s) => html`<option value=${s} selected=${s === status}>${s === c.suggestedStatus ? msg('import.suggestedStage', { stage: statusLabel(s) }) : statusLabel(s)}</option>`)}
          </select>
          <span class=${'bu-chip bu-chip--sm' + (tone ? ' bu-chip--' + tone : '')}><${Icon} name=${icon} />${msg(confKey)}</span>
        </div>
        <p class="bu-caption bu-text-secondary ao-cand__reason">${label(c.reason)}</p>
      </div>
      <div class="ao-cand__field">
        <span class="bu-field__label">${msg('project.flags.labels')}</span>
        <ul class="bu-labels">
          ${labels.map((l) => html`<li key=${typeof l === 'string' ? l : l.key} class="ao-label-edit"><span class=${'bu-label-chip bu-label-chip--' + labelTone(slug(label(l)))}>${label(l)}</span>
            <button type="button" class="ao-label-edit__x" aria-label=${msg('project.label.remove', { label: label(l) })} title=${msg('project.label.removeShort')} onClick=${() => onOverride({ labels: labels.filter((x) => x !== l) })}><${Icon} name="close" /></button></li>`)}
          ${!labels.length ? html`<li class="bu-caption bu-text-tertiary">${msg('import.noLabels')}</li>` : null}
        </ul>
        <form class="ao-label-add" onSubmit=${addLabel}>
          <input class="bu-input bu-input--sm" placeholder=${msg('import.addPlaceholder')} maxlength="32" aria-label=${msg('import.addLabelTo', { name })} value=${labelDraft} onInput=${(e) => setLabelDraft(e.currentTarget.value)} />
          <button type="submit" class="bu-btn bu-btn--icon bu-btn--sm" aria-label=${msg('import.addLabel')} title=${msg('project.label.add')} disabled=${!labelDraft.trim()}><${Icon} name="add" /></button>
        </form>
      </div>
      <div class="ao-cand__field">
        <span class="bu-field__label">${msg('import.sources')}</span>
        <ul class="ao-sources__list">${c.sources.map((s, i) => html`<li key=${i} class="bu-source"><${Icon} name=${SOURCE_ICON[s.kind] || 'link'} />${sourceText(s)}</li>`)}</ul>
      </div>
    </div>
  </li>`;
}

function ImportSkeleton() {
  return html`<ul class="bu-list" aria-busy="true" aria-label=${msg('import.loading')}>${[0, 1, 2].map((k) => html`<li key=${k} class="bu-card"><${Skeleton} kind="title" /><${Skeleton} w="70" /><${Skeleton} w="40" /></li>`)}</ul>`;
}
