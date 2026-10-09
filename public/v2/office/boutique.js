import { buildQuery } from '../config.js';
// La Boutique (Store, office-dev-21): customize the office from a catalog, mobile-first. Category tabs (Mobilier,
// Décoration, Personnages, Couleurs, Accessoires, Thèmes) with card grids built from the manifest (catalog.js); furniture
// and decor are placed in a full-screen placement mode (placement.js); looks are tried on a large live preview of the
// chosen agent, then applied. One draft (draft.js) with undo/redo and one « Enregistrer » through the existing layout
// write (expectedRevision, 409, versions). Query state, so a reload restores it: ?onglet=…&agent=…&placer=<asset|uid>.
import { html, useEffect, useMemo, useRef, useState } from '../lib.js';
import { useTopic, useStore } from '../hooks.js';
import { services } from '../services.js';
import { config } from '../config.js';
import * as fmtTz from '../fmt.js';
import { agentName } from '../i18n.js';
import { Icon, Skeleton } from '../components/ui.js';
import { toast } from '../toast.js';
import { indexManifest, resolveUrl, furnitureImage, roomImage, themeFor } from './assets.js';
import { updateTheme } from './editor-model.js';
import { presenceMinutes, canonicalRuleId } from './layout-rules.js';
import { resolveTheme } from './theme.js';
import { displayName } from './names.js';
import { s as tr, labelOf, duration, locale } from './strings.js';
import { useLayout, officeApi } from './layout-source.js';
import { createDraft } from './draft.js';
import { agentRows, looksOf, patchAgent, lookPatch } from './agent-looks.js';
import { TABS, furnitureItems, characterItems, colourItems, accessoryItems, themeChoices, isLookTab, placedOf } from './catalog.js';
import { Figure } from './setup-characters.js';
import { Placement } from './placement.js';

const STYLES = ['./office.css', './setup-characters.css', './boutique.css'].map((p) => new URL(p + buildQuery, import.meta.url).href);
const assetBase = () => services.officeAssetBase ?? config.assetBase;
// A manifest colour, only when it is a plain CSS colour (set through the CSSOM, never as markup).
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\)|hsla?\([\d.,\s%deg]+\))$/i;
const safeColor = (c) => (typeof c === 'string' && COLOR_RE.test(c.trim()) ? c.trim() : 'transparent');
const PRESENCE_CHOICES = [0, 15, 30, 60, 120, 240];
const ruleLabel = (id) => tr(`ed.rule.${canonicalRuleId(id) ?? id}`);
const NO_STATUS = { get: () => null, subscribe: () => () => {} };
const TAB_ICON = { mobilier: 'layers', decoration: 'sun', personnages: 'agent', couleurs: 'eye', accessoires: 'check', themes: 'moon' };

function useStyles() {
  useEffect(() => {
    for (const href of STYLES) {
      if (document.querySelector(`link[data-office="${href}"]`)) continue;
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href; l.dataset.office = href;
      document.head.append(l);
    }
  }, []);
}
const indexCache = new WeakMap();
const indexOf = (m) => indexCache.get(m) ?? (indexCache.set(m, indexManifest(m)), indexCache.get(m));

export function BoutiquePage({ match }) {
  useStyles();
  const layout = useLayout();
  const office = useTopic('office', '/api/v2/views/office');
  const status = useStore(services.stream?.status ?? NO_STATUS);
  const q = match.query ?? {};
  const tab = TABS.includes(q.onglet) ? q.onglet : 'mobilier';
  const setQuery = (patch) => services.router.setQuery(patch);

  // One draft per visit, created from the first LayoutVM; it follows the server while nothing is unsaved.
  const draftRef = useRef(null);
  const [, setSeq] = useState(0);
  const lay = layout.data;
  if (lay && !draftRef.current) draftRef.current = createDraft(lay, indexOf(lay.manifest), officeApi());
  const draft = draftRef.current;
  useEffect(() => (draft ? draft.subscribe(() => setSeq((n) => n + 1)) : undefined), [draft]);
  useEffect(() => { if (draft && lay) draft.follow(lay); }, [lay?.layout?.revision]);
  // Leaving with unsaved changes asks first (a reload, a closed tab).
  useEffect(() => {
    const onUnload = (e) => { if (draftRef.current?.dirty) { e.preventDefault(); e.returnValue = ''; } };
    addEventListener('beforeunload', onUnload);
    return () => removeEventListener('beforeunload', onUnload);
  }, []);

  if (!lay || !draft) {
    return html`<div class="bu-page ao-shop" aria-busy=${layout.error ? undefined : 'true'}>
      ${layout.error ? html`<div class="bu-banner bu-banner--warning" role="alert"><${Icon} name="warning" /><span class="bu-banner__text">${tr('shop.loadFailed')}</span>
        <button type="button" class="bu-btn bu-btn--sm" onClick=${layout.retry}>${tr('office.retry')}</button></div>`
        : html`<${Skeleton} kind="title" /><div class="ao-shop__grid">${Array.from({ length: 6 }, (_, k) => html`<div key=${k} class="bu-card ao-shop__card"><${Skeleton} kind="block" /></div>`)}</div>`}
    </div>`;
  }

  const index = indexOf(lay.manifest);
  const data = draft.data;
  const caps = (status && status.capabilities) || (services.meta && services.meta.capabilities) || null;
  const canWrite = !lay.readOnly && !(caps && caps.storeWrites === false);
  const occupants = office.data?.occupants ?? [];
  const primary = () => { const p = services.meta?.primaryAgent ?? services.meta?.agent; return (p && (p.name || p.displayName)) || agentName(); };

  const placing = q.placer ?? null;
  const place = (target) => setQuery({ placer: target });
  const closePlacement = () => setQuery({ placer: null });

  return html`<div class=${'bu-page ao-shop' + (draft.dirty ? ' ao-shop--dirty' : '')}>
    <header class="ao-shop__head">
      <div class="ao-shop__headtext">
        <h2 class="ao-shop__title">${tr('shop.title')}</h2>
        <p class="ao-shop__lede bu-text-secondary">${tr('shop.lede')}</p>
      </div>
      <a class="bu-btn bu-btn--ghost ao-shop__back" href=${services.router.href('bureau')} title=${tr('shop.back')}><${Icon} name="arrow-left" /><span class="ao-shop__backtext">${tr('shop.back')}</span></a>
    </header>
    ${canWrite ? null : html`<p class="bu-caption bu-text-tertiary ao-ro" id="ao-shop-ro"><${Icon} name="info" />${tr(lay.readOnly ? 'office.readonlyLayout' : 'office.readonly')}</p>`}
    <${Tabs} tab=${tab} onTab=${(t) => setQuery({ onglet: t === 'mobilier' ? null : t })} />
    <div class="ao-shop__panel" role="tabpanel" id=${'ao-shop-panel-' + tab} aria-labelledby=${'ao-shop-tab-' + tab} tabindex="0">
      ${tab === 'mobilier' || tab === 'decoration' ? html`<${FurnitureGrid} key=${tab} tab=${tab} index=${index} data=${data} canWrite=${canWrite} onPlace=${place} />`
        : isLookTab(tab) ? html`<${LooksPanel} key=${tab} tab=${tab} index=${index} draft=${draft} occupants=${occupants} seen=${lay.agentsSeen} canWrite=${canWrite}
            agentId=${q.agent ?? null} onAgent=${(id) => setQuery({ agent: id })} primaryName=${primary()} />`
        : html`<${ThemesPanel} index=${index} draft=${draft} canWrite=${canWrite} />`}
    </div>
    <${SaveBar} draft=${draft} canWrite=${canWrite} />
    ${placing && canWrite ? html`<${Placement} key=${placing} draft=${draft} index=${index} lay=${lay} occupants=${occupants.map((o) => ({ ...o, name: o.name }))}
      asset=${index.furniture.has(placing) ? placing : null} uid=${index.furniture.has(placing) ? null : placing} assetBase=${assetBase()}
      primaryName=${() => primary()} timeZone=${() => fmtTz.timeZone()} onClose=${closePlacement} />` : null}
  </div>`;
}

/** Category tabs (tablist; arrows move, Home/End; horizontally scrollable on phones). */
function Tabs({ tab, onTab }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [tab]);
  const onKey = (e) => {
    const i = TABS.indexOf(tab);
    const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (j == null) return;
    e.preventDefault();
    const next = TABS[(j + TABS.length) % TABS.length];
    onTab(next);
    requestAnimationFrame(() => ref.current?.querySelector(`#ao-shop-tab-${next}`)?.focus());
  };
  return html`<div class="ao-shop__tabs" role="tablist" aria-label=${tr('shop.tabs')} ref=${ref} onKeyDown=${onKey}>
    ${TABS.map((t) => html`<button type="button" role="tab" key=${t} id=${'ao-shop-tab-' + t} class="ao-shop__tab" aria-selected=${String(t === tab)}
      aria-controls=${'ao-shop-panel-' + t} tabindex=${t === tab ? '0' : '-1'} onClick=${() => onTab(t)}><${Icon} name=${TAB_ICON[t]} />${tr('shop.tab.' + t)}</button>`)}
  </div>`;
}

// ---------- Mobilier / Décoration ----------
function FurnitureGrid({ tab, index, data, canWrite, onPlace }) {
  const [open, setOpen] = useState(null);
  const items = furnitureItems(index, data, tab);
  const it = open && items.find((x) => x.id === open);
  if (!items.length) return html`<p class="bu-text-secondary">${tr('shop.emptyTab')}</p>`;
  return html`<ul class="ao-shop__grid" role="list">
    ${items.map((x) => html`<li key=${x.id}>
      <button type="button" class=${'bu-card bu-card--interactive ao-shop__card' + (open === x.id ? ' bu-card--selected' : '')} aria-expanded=${String(open === x.id)}
        aria-controls="ao-shop-sheet" onClick=${() => setOpen(open === x.id ? null : x.id)}>
        <span class="ao-shop__thumb"><img src=${resolveUrl(furnitureImage(x.f), assetBase())} alt="" loading="lazy" decoding="async" /></span>
        <span class="ao-shop__name">${labelOf(x.f, 'furniture')}</span>
        <span class=${'ao-shop__badge' + (x.count ? ' is-on' : '')}>${x.count ? tr('shop.inOffice', { n: x.count }) : tr('shop.notInOffice')}</span>
      </button></li>`)}
  </ul>
  ${it ? html`<${ItemSheet} it=${it} index=${index} data=${data} canWrite=${canWrite} onPlace=${onPlace} onClose=${() => setOpen(null)} />` : null}`;
}

/** The chosen item: a large image, what it is, « Placer dans le bureau », and its copies already in the office. */
function ItemSheet({ it, index, data, canWrite, onPlace, onClose }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); ref.current?.scrollIntoView?.({ block: 'nearest' }); }, [it.id]);
  const placed = placedOf(data, it.id);
  const fp = it.f.footprint;
  return html`<section class="bu-card ao-shop__sheet" id="ao-shop-sheet" aria-labelledby="ao-shop-sheet-title" tabindex="-1" ref=${ref}>
    <div class="ao-shop__sheethead">
      <h3 class="bu-card__title" id="ao-shop-sheet-title">${labelOf(it.f, 'furniture')}</h3>
      <button type="button" class="bu-btn bu-btn--icon bu-btn--ghost" aria-label=${tr('shop.sheet.close')} onClick=${onClose}><${Icon} name="close" /></button>
    </div>
    <div class="ao-shop__sheetbody">
      <span class="ao-shop__big"><img src=${resolveUrl(furnitureImage(it.f), assetBase())} alt="" /></span>
      <div class="ao-shop__facts">
        <p>${it.placement === 'wall' ? tr('shop.sheet.wall') : fp ? tr('shop.sheet.floor', { w: fp.w, d: fp.d }) : null}</p>
        ${it.f.station ? html`<p>${tr('shop.sheet.station')}</p>` : null}
        <p class="bu-text-secondary">${placed.length ? tr('shop.inOffice', { n: placed.length }) : tr('shop.notInOffice')}</p>
        <div class="ao-shop__sheetactions">
          <button type="button" class="bu-btn bu-btn--primary" disabled=${!canWrite} aria-describedby=${canWrite ? undefined : 'ao-shop-ro'} onClick=${() => onPlace(it.id)}>
            <${Icon} name="add" />${tr('shop.place')}</button>
          ${placed.length ? html`<button type="button" class="bu-btn" disabled=${!canWrite} onClick=${() => onPlace(placed[0].uid)}><${Icon} name="pencil" />${tr('shop.moveExisting')}</button>` : null}
        </div>
      </div>
    </div>
  </section>`;
}

// ---------- Personnages / Couleurs / Accessoires ----------
function LooksPanel({ tab, index, draft, occupants, seen, canWrite, agentId, onAgent, primaryName }) {
  const data = draft.data;
  const rows = useMemo(() => agentRows(data, occupants, seen ?? [], ruleLabel), [data, occupants, seen]);
  const looks = looksOf(data, index, rows);
  const row = rows.find((r) => r.id === agentId) ?? rows[0];
  const [focus, setFocus] = useState(null);
  useEffect(() => setFocus(null), [tab, row?.id]);
  if (!row) return html`<p class="bu-text-secondary">${tr('shop.noAgents')}</p>`;
  const nameOf = (r) => (r.isDefault ? ruleLabel(r.id) : displayName({ id: r.id, role: r.role, name: data.agents.find((a) => a.agentId === r.id)?.name, sourceName: r.sourceName }, { primaryName }));
  const look = looks[row.id];
  const list = tab === 'personnages' ? characterItems(index, look, rows, looks) : tab === 'couleurs' ? colourItems(index, look, rows, looks) : accessoryItems(index, look, rows, looks);
  const focused = list.find((x) => x.id === focus) ?? null;
  const preview = focused ? (tab === 'accessoires' ? focused.toggled : focused.look) : look;
  const changed = JSON.stringify(preview) !== JSON.stringify(look);
  const who = nameOf(row);
  const wornText = (ids) => (ids.length ? tr('shop.wornBy', { names: new Intl.ListFormat(locale() === 'en' ? 'en' : 'fr', { style: 'short', type: 'conjunction' }).format(ids.slice(0, 3).map((id) => nameOf(rows.find((r) => r.id === id)))), n: ids.length }) : null);
  const itemName = (x) => (tab === 'personnages' ? labelOf(x.c, 'character') : tab === 'couleurs' ? labelOf(x.v, 'variant') : labelOf(x.a, 'accessory'));
  function apply() {
    if (!changed) return;
    draft.commit(patchAgent(data, index, row, lookPatch(index, preview)), tr('shop.applied', { agent: who, item: focused ? itemName(focused) : '' }));
    setFocus(null);
  }
  return html`
    <div class="ao-shop__agents" role="radiogroup" aria-label=${tr('shop.agentFor')}>
      ${rows.map((r) => html`<button type="button" role="radio" key=${r.id} class="ao-shop__chip" aria-checked=${String(r.id === row.id)} onClick=${() => onAgent(r.id)}>
        <${Figure} index=${index} look=${looks[r.id]} pose="idle" assetBase=${assetBase()} cls="ao-shop__chipfig" />
        <span>${nameOf(r)}</span>${r.isDefault ? html`<span class="bu-sr-only">${tr('ed.defaultRule')}</span>` : null}</button>`)}
    </div>
    <div class="ao-shop__try">
      <div class="bu-card ao-shop__preview">
        <${Figure} index=${index} look=${preview} pose="idle" assetBase=${assetBase()} cls="ao-shop__previewfig" label=${tr('shop.previewOf', { agent: who })} />
        <div class="ao-shop__previewtext">
          <p class="ao-shop__previewname">${who}</p>
          <p class="bu-text-secondary" aria-live="polite">${focused ? tr(tab === 'accessoires' && focused.on ? 'shop.tryRemove' : 'shop.tryOn', { item: itemName(focused) }) : tr('shop.current')}</p>
          ${focused && tab === 'accessoires' && !focused.drawn ? html`<p class="bu-caption bu-text-tertiary">${tr('shop.notDrawn')}</p>` : null}
          <button type="button" class="bu-btn bu-btn--primary" disabled=${!changed || !canWrite} onClick=${apply}><${Icon} name="check" />${tr(tab === 'accessoires' && focused?.on ? 'shop.remove' : 'shop.apply')}</button>
        </div>
      </div>
      ${list.length ? html`<ul class="ao-shop__grid ao-shop__grid--looks" role="list">
        ${list.map((x) => html`<li key=${x.id}>
          <button type="button" class=${'bu-card bu-card--interactive ao-shop__card' + (focus === x.id ? ' bu-card--selected' : '')} aria-pressed=${String(focus === x.id)} onClick=${() => setFocus(focus === x.id ? null : x.id)}>
            <span class="ao-shop__thumb ao-shop__thumb--fig">
              ${tab === 'couleurs' && x.swatch ? html`<span class="ao-shop__swatch" style=${{ background: safeColor(x.swatch) }}></span>` : null}
              <${Figure} index=${index} look=${tab === 'accessoires' ? (x.on ? look : x.toggled) : x.look} pose="idle" assetBase=${assetBase()} thumbnail=${tab !== 'accessoires'} /></span>
            <span class="ao-shop__name">${itemName(x)}</span>
            <span class=${'ao-shop__badge' + (x.on ? ' is-on' : '')}>${x.on ? tr(tab === 'accessoires' ? 'shop.wearing' : 'shop.currentShort') : wornText(x.wornBy) ?? tr('shop.free')}</span>
          </button></li>`)}
      </ul>` : html`<p class="bu-text-secondary">${tr(tab === 'couleurs' ? 'shop.noColours' : 'shop.emptyTab')}</p>`}
    </div>`;
}

// ---------- Thèmes ----------
function ThemesPanel({ index, draft, canWrite }) {
  const data = draft.data;
  const t = data.theme;
  const room = index.rooms.get(data.room);
  const mode = t.mode === 'fixed' ? t.fixed : 'auto';
  const { modes, seasons } = themeChoices(index);
  const tz = fmtTz.timeZone() || undefined;
  const now = resolveTheme({ ...t, mode: 'auto' }, new Date(), tz);
  const set = (m) => draft.commit(updateTheme(data, m === 'auto' ? { mode: 'auto', nightFrom: t.nightFrom ?? '19:00', nightTo: t.nightTo ?? '07:00' } : { mode: 'fixed', fixed: m }),
    tr('ed.themeSet', { theme: m === 'auto' ? tr('office.theme.auto') : labelOf(themeFor(index, m), 'theme') }));
  const thumb = (id) => resolveUrl(roomImage(room, themeFor(index, id === 'auto' ? now : id)), assetBase());
  return html`<ul class="ao-shop__grid ao-shop__grid--themes" role="list">
      ${modes.map((id) => html`<li key=${id}><button type="button" class=${'bu-card bu-card--interactive ao-shop__card' + (mode === id ? ' bu-card--selected' : '')} aria-pressed=${String(mode === id)} disabled=${!canWrite} onClick=${() => set(id)}>
        <span class="ao-shop__thumb ao-shop__thumb--room"><img src=${thumb(id)} alt="" loading="lazy" /></span>
        <span class="ao-shop__name">${tr('office.theme.' + id)}</span>
        <span class=${'ao-shop__badge' + (mode === id ? ' is-on' : '')}>${mode === id ? tr('shop.currentShort') : id === 'auto' ? tr(now === 'night' ? 'office.themeNow.night' : 'office.themeNow.day') : tr('shop.free')}</span></button></li>`)}
    </ul>
    <div class="bu-card ao-shop__settings">
      ${t.mode === 'auto' ? html`<div class="ao-shop__row">
        <label class="bu-field"><span class="bu-field__label">${tr('ed.nightFrom')}</span><input class="bu-input" type="time" disabled=${!canWrite} value=${t.nightFrom ?? '19:00'} onChange=${(e) => draft.commit(updateTheme(data, { nightFrom: e.target.value }), tr('ed.nightFromSet', { time: e.target.value }))} /></label>
        <label class="bu-field"><span class="bu-field__label">${tr('ed.nightTo')}</span><input class="bu-input" type="time" disabled=${!canWrite} value=${t.nightTo ?? '07:00'} onChange=${(e) => draft.commit(updateTheme(data, { nightTo: e.target.value }), tr('ed.nightToSet', { time: e.target.value }))} /></label>
      </div>` : null}
      <label class="bu-field"><span class="bu-field__label">${tr('ed.season')}</span>
        <select class="bu-select" value=${t.season ?? ''} disabled=${!seasons.length || !canWrite} onChange=${(e) => draft.commit(updateTheme(data, { season: e.target.value || null }), tr('ed.seasonSet'))}>
          <option value="">${tr('ed.seasonNone')}</option>
          ${seasons.map((x) => html`<option value=${x.id}>${labelOf(x.t, 'theme')}</option>`)}
        </select>
        <span class="bu-field__hint">${seasons.length ? tr('ed.seasonHelp') : tr('ed.seasonNoneAvailable')}</span></label>
      ${config.apiVersion === 3 ? html`<label class="bu-field"><span class="bu-field__label">${tr('ed.presence')}</span>
        <select class="bu-select" value=${String(presenceMinutes(data))} disabled=${!canWrite} onChange=${(e) => { const m = Number(e.target.value); draft.commit({ ...data, presence: { seenMinutes: m } }, m ? tr('ed.presenceSet', { duration: duration(m * 60_000) }) : tr('ed.presenceOff')); }}>
          ${PRESENCE_CHOICES.map((m) => html`<option value=${String(m)}>${m ? duration(m * 60_000) : tr('ed.presenceNone')}</option>`)}
        </select>
        <span class="bu-field__hint">${tr('ed.presenceHelp')}</span></label>` : null}
    </div>`;
}

// ---------- the save bar (sticky, above the tab bar on phones) ----------
function SaveBar({ draft, canWrite }) {
  const [busy, setBusy] = useState(false);
  // Ctrl/⌘+Z undoes, Ctrl/⌘+Maj+Z (or Ctrl+Y) redoes, outside text fields (placement mode has its own keys).
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.target.closest?.('input, select, textarea, .ao-place')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); draft.undo(tr('ed.undone')); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); draft.redo(tr('ed.redone')); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [draft]);
  const errors = draft.dirty ? draft.errors : [];
  async function save(overwrite = false) {
    setBusy(true);
    const r = await draft.save({ overwrite });
    setBusy(false);
    if (r.ok) toast({ level: 'success', message: tr('shop.saved') });
    else if (r.error) toast({ level: 'danger', message: r.error.message ?? tr('ed.saveFailed') });
  }
  const c = draft.conflict;
  return html`<div class=${'ao-shop__savebar' + (draft.dirty ? ' is-dirty' : '')} role="region" aria-label=${tr('shop.saveBar')}>
    ${c ? html`<div class="bu-banner bu-banner--warning ao-shop__conflict" role="alert"><${Icon} name="warning" /><span class="bu-banner__text">${tr('shop.conflict')}</span>
      <button type="button" class="bu-btn bu-btn--sm" onClick=${() => draft.reloadFromConflict()}>${tr('shop.conflictReload')}</button>
      <button type="button" class="bu-btn bu-btn--sm" onClick=${() => save(true)}>${tr('shop.conflictOverwrite')}</button></div>` : null}
    <div class="ao-shop__saverow">
      <button type="button" class="bu-btn bu-btn--icon" aria-label=${tr('ed.undo')} title=${tr('ed.undo')} disabled=${!draft.canUndo} onClick=${() => draft.undo(tr('ed.undone'))}><${Icon} name="undo" /></button>
      <button type="button" class="bu-btn bu-btn--icon ao-shop__redo" aria-label=${tr('ed.redo')} title=${tr('ed.redo')} disabled=${!draft.canRedo} onClick=${() => draft.redo(tr('ed.redone'))}><${Icon} name="undo" /></button>
      <p class="ao-shop__status" aria-live="polite">${errors.length ? html`<span class="bu-ed-tone--danger">${errors[0].message}</span>` : draft.dirty ? tr('shop.unsaved', { n: draft.count }) : tr('shop.allSaved')}</p>
      <button type="button" class="bu-btn bu-btn--primary" disabled=${!canWrite || !draft.dirty || busy || draft.saving || errors.length > 0} aria-busy=${busy ? 'true' : undefined} onClick=${() => save()}>
        ${tr(busy ? 'ed.saving' : 'shop.save')}${draft.dirty ? html` <span class="bu-count">${draft.count}</span>` : null}</button>
    </div>
    <p class="bu-sr-only" aria-live="polite">${draft.announcement}</p>
  </div>`;
}
