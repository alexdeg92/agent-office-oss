import { loadModule, chunkError } from '../build-update.js';
import './store-labels.js';
import { buildQuery } from '../config.js';
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../lib.js';
import { useTopic, useStore, useFetch } from '../hooks.js';
import { services, reloadGuards } from '../services.js';
import { config } from '../config.js';
import * as fmtTz from '../fmt.js';
import { agentName, label } from '../i18n.js';
import { get } from '../api.js';
import { Frame, Icon, Skeleton } from '../components/ui.js';
import { Modal } from '../components/modal.js';
import { Button, Select } from '../components/bureau/forms.js';
export { loadStyles } from '../components/bureau/styles.js';
import { toast } from '../toast.js';
import { indexManifest, resolveUrl, furnitureImage } from './assets.js';
import { canonicalRuleId } from './layout-rules.js';
import { displayName } from './names.js';
import { s as tr, labelOf, locale } from './strings.js';
import { useLayout, officeApi } from './layout-source.js';
import { createDraft } from './draft.js';
import { floorId } from './floors.js';
import { agentRows, looksOf, patchAgent, lookPatch } from './agent-looks.js';
import { furnitureItems, characterItems, colourItems, accessoryItems, isLookTab, placedOf } from './catalog.js';
import { Figure } from './setup-characters.js';

const STYLES = ['./office.css', './setup-characters.css', './boutique.css'].map((p) => new URL(p + buildQuery, import.meta.url).href);
const assetBase = () => services.officeAssetBase ?? config.assetBase;
// A manifest colour, only when it is a plain CSS colour (set through the CSSOM, never as markup).
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\)|hsla?\([\d.,\s%deg]+\))$/i;
const safeColor = (c) => (typeof c === 'string' && COLOR_RE.test(c.trim()) ? c.trim() : 'transparent');
const ruleLabel = (id) => tr(`ed.rule.${canonicalRuleId(id) ?? id}`);
const NO_STATUS = { get: () => null, subscribe: () => () => {} };

function useStyles() {
  useEffect(() => {
    for (const href of STYLES) {
      if (document.querySelector(`link[data-office="${href}"]`)) continue;
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href; l.dataset.office = href;
      l.onerror = () => chunkError(Error('Store stylesheet unavailable'));
      document.head.append(l);
    }
  }, []);
}
const indexCache = new WeakMap();
const indexOf = (m) => indexCache.get(m) ?? (indexCache.set(m, indexManifest(m)), indexCache.get(m));

export function BoutiquePage({ match }) {
  useStyles();
  const id=match.query?.etage ?? '1';
  return html`<${FloorBoutique} key=${id} match=${match} currentFloorId=${id} />`;
}

function FloorBoutique({match,currentFloorId}) {
  const q = match.query ?? {};
  const layout = useLayout(currentFloorId);
  const office = useTopic('office', '/api/v2/views/office');
  const status = useStore(services.stream?.status ?? NO_STATUS);
  const navQuery = new URLSearchParams({floorId:currentFloorId});
  if(q.onglet!=null)navQuery.set('section',q.onglet);
  if(q.categorie!=null)navQuery.set('category',q.categorie);
  navQuery.set('officeRevision',office.rev ?? 0);
  const navigation=useFetch('/api/v2/views/office/store?'+navQuery,url=>get(url,{quiet:true}).then(response=>response.data));
  const nav=navigation.data,tab=nav?.sectionId;
  const setQuery = (patch) => services.router.setQuery(patch);

  // One draft per floor context; its history and save transport share that scope.
  const draftRef = useRef(null);
  const leaveRef=useRef(null);
  const [leaving,setLeaving]=useState(false);
  const decideLeave=ok=>{const pending=leaveRef.current;leaveRef.current=null;setLeaving(false);pending?.resolve(ok);};
  const [, setSeq] = useState(0);
  const rootLay = layout.data;

  const floorStore = officeApi(currentFloorId);
  const lay = rootLay;
  if (lay && !draftRef.current) draftRef.current = createDraft(lay, indexOf(lay.manifest), floorStore);
  const draft = draftRef.current;
  useEffect(() => (draft ? draft.subscribe(() => setSeq((n) => n + 1)) : undefined), [draft]);
  useEffect(() => { if (draft && lay) draft.follow(lay); }, [lay?.layout?.revision]);
  // Register before interaction, including immediately after a floor remount. Leaving with unsaved changes asks
  // first: navigation (floor-scoped guard), a reload or closed tab, and chunk recovery (T-0106 reload guard).
  useLayoutEffect(() => {
    const reloadGuard = { dirty: () => !!(draftRef.current?.dirty || draftRef.current?.saving), confirm: () => !draftRef.current?.saving && window.confirm(tr('ed.leave.desc')) };
    reloadGuards.add(reloadGuard);
    const onUnload = (e) => { if (draftRef.current?.dirty && !reloadGuard.approved) { e.preventDefault(); e.returnValue = ''; } };
    const guard=url=>{
      const target=new URL(url,location.href);
      if(target.pathname===new URL(services.router.href('boutique'),location.href).pathname && (floorId(target.searchParams.get('etage'))??'1')===currentFloorId)return true;
      if(draftRef.current?.saving)return false;
      if(!draftRef.current?.dirty)return true;
      if(!leaveRef.current){const pending={};pending.promise=new Promise(resolve=>{pending.resolve=resolve;});leaveRef.current=pending;setLeaving(true);}
      return leaveRef.current.promise;
    };
    (services.navigationGuards ||= new Set()).add(guard);
    addEventListener('beforeunload', onUnload);
    return () => {reloadGuards.delete(reloadGuard);removeEventListener('beforeunload',onUnload);services.navigationGuards.delete(guard);leaveRef.current?.resolve(false);};
  }, []);

  if (!lay || !draft || !nav) {
    return html`<${Frame} class="bu-page ao-shop" aria-busy=${layout.error || navigation.error ? undefined : 'true'}>
      ${layout.error || navigation.error ? html`<div class="bu-banner bu-banner--warning" role="alert"><${Icon} name="warning" /><span class="bu-banner__text">${tr('shop.loadFailed')}</span>
        <button type="button" class="bu-btn bu-btn--sm" onClick=${()=>{layout.retry();navigation.reload();}}>${tr('office.retry')}</button></div>`
        : html`<div class="ao-shop__grid">${Array.from({ length: 6 }, (_, k) => html`<div key=${k} class="bu-card ao-shop__card"><${Skeleton} kind="block" /></div>`)}</div>`}
    </${Frame}>`;
  }

  const index = indexOf(lay.manifest);
  const data = draft.data;
  const category = nav.categoryId ?? '';
  const caps = (status && status.capabilities) || (services.meta && services.meta.capabilities) || null;
  const canWrite = !lay.readOnly && !(caps && caps.storeWrites === false);
  const occupants = office.data?.occupants ?? [];
  const primary = () => { const p = services.meta?.primaryAgent ?? services.meta?.agent; return (p && (p.name || p.displayName)) || agentName(); };

  const placing = q.placer ?? null;
  const place = (target) => setQuery({ placer: target });
  const closePlacement = () => setQuery({ placer: null });

  return html`<${Frame} class=${'bu-page ao-shop' + (draft.dirty ? ' ao-shop--dirty' : '')} data-floor-context=${nav.floorId} data-store-section=${nav.sectionId} data-store-category=${nav.categoryId ?? ''} bodyClass="ao-shop__panel ao-frame__body--framed"
    bodyProps=${{ role:'region',id:'ao-shop-panel-'+tab,'aria-labelledby':'ao-shop-section','aria-busy':navigation.loading ? 'true' : undefined }}
    head=${html`<div class="ao-shop__controls">${nav.floors ? html`<div class="ao-shop__header"><${StoreSelect} id="ao-shop-floor" class="ao-shop__floor" control=${nav.floors} value=${nav.floorId}
      onValueChange=${value=>setQuery({etage:value,placer:null})} />
      <a class="bu-btn bu-btn--ghost ao-shop__back" href=${services.router.href('bureau',{}, {etage:nav.floorId})}><${Icon} name="arrow-left" /><span class="ao-shop__backtext">${tr('shop.back')}</span></a></div>` : null}
    <div class="ao-shop__navigation">
      <${StoreSelect} id="ao-shop-section" class="ao-shop__section" control=${nav.sections} value=${tab}
        onValueChange=${value=>setQuery({onglet:value,categorie:null,placer:null})} />
      ${nav.categories ? html`<${StoreSelect} id="ao-shop-category" class="ao-shop__category" control=${nav.categories} value=${category}
        onValueChange=${value=>setQuery({categorie:value || null})} />` : null}
    </div></div>`}
    foot=${html`<${SaveBar} draft=${draft} canWrite=${canWrite} />`} bar=${navigation.error || !canWrite ? html`
    ${navigation.error ? html`<div class="bu-banner bu-banner--warning" role="alert"><span>${tr('shop.loadFailed')}</span><${Button} label=${tr('office.retry')} onClick=${navigation.reload} /></div>` : null}
    ${canWrite ? null : html`<p class="bu-caption bu-text-tertiary ao-ro" id="ao-shop-ro"><${Icon} name="info" />${tr(lay.readOnly ? 'office.readonlyLayout' : 'office.readonly')}</p>`}
` : null}>
      ${tab === 'mobilier' || tab === 'decoration' ? html`<${Frame} class="ao-shop__catalog" bodyClass="ao-shop__catalogue" bodyLabel=${tr('shop.tab.' + tab)}><${FurnitureGrid} key=${tab} tab=${tab} itemIds=${nav.itemIds} index=${index} data=${data} canWrite=${canWrite} onPlace=${place} /></${Frame}>`
        : isLookTab(tab) ? html`<${LooksPanel} key=${tab} tab=${tab} category=${category} itemIds=${nav.itemIds} index=${index} draft=${draft} occupants=${occupants} seen=${lay.agentsSeen} canWrite=${canWrite}
            agentId=${q.agent ?? null} onAgent=${(id) => setQuery({ agent: id })} primaryName=${primary()} />`
        : html`<${ThemesPanel} index=${index} draft=${draft} canWrite=${canWrite} />`}
  </${Frame}>
    ${placing && canWrite ? html`<${DecorPlacement} key=${placing} draft=${draft} index=${index} lay=${lay} occupants=${occupants.map((o) => ({ ...o, name: o.name }))}
      asset=${index.furniture.has(placing) ? placing : null} uid=${index.furniture.has(placing) ? null : placing} assetBase=${assetBase()}
      primaryName=${() => primary()} timeZone=${() => fmtTz.timeZone()} onClose=${closePlacement} />` : null}
    ${leaving ? html`<${Modal} size="sm" title=${tr('ed.leave.title')} onClose=${()=>decideLeave(false)} footer=${html`
      <${Button} label=${tr('ed.stay')} onClick=${()=>decideLeave(false)} />
      <${Button} variant="primary" label=${tr('ed.quit')} onClick=${()=>decideLeave(true)} />`}>
      <p>${tr('ed.leave.desc')}</p></${Modal}>` : null}
  `;
}

// Theme previews need the scene renderer only when their tab is opened.
function ThemesPanel(props) {
  const [Component, setComponent] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(false);
    loadModule(() => import('./themes-panel.js' + buildQuery))
      .then(m => { if (live) setComponent(() => m.ThemesPanel); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [attempt]);
  if (Component) return html`<${Component} ...${props} />`;
  return failed ? html`<div class="bu-banner bu-banner--warning" role="alert"><span>${tr('shop.loadFailed')}</span>
    <button type="button" class="bu-btn" onClick=${() => retry(n => n + 1)}>${tr('office.retry')}</button></div>`
    : html`<div aria-busy="true"><${Skeleton} kind="block" /></div>`;
}

// Choices, order, counts, labels and visibility come from OfficeStoreVM.
function StoreSelect({id,class:cls,control,value,onValueChange}) {
  return html`<div class=${'ao-shop__control '+cls}><label for=${id}>${label(control.label)}</label>
    <${Select} id=${id} width="full" label=${label(control.label)} value=${value} onValueChange=${onValueChange}
      options=${control.options.map(option=>({value:option.id,label:label(option.label)}))} /></div>`;
}

// ---------- Mobilier / Décoration ----------
function useDecorItem(index, id) {
  const [, update] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(null);
  const f = index.furniture.get(id);
  useEffect(() => {
    setError(null);
    if (!f?.packManifest || f.packLoaded) return;
    const controller = new AbortController();
    loadModule(() => import('./decor-pack-loader.js' + buildQuery)).then(m => m.ensureDecorPack(index, id, assetBase(), { signal: controller.signal }))
      .then(() => { if (!controller.signal.aborted) update(n => n + 1); })
      .catch(e => { if (!controller.signal.aborted && e.name !== 'AbortError') setError(e); });
    return () => controller.abort();
  }, [index, id, attempt]);
  return { f, pending: !!f?.packManifest && !f.packLoaded, error, retry: () => setAttempt(n => n + 1) };
}
function DecorPlacement(props) {
  const [Component, setComponent] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true; setLoadError(null);
    loadModule(() => import('./placement.js' + buildQuery)).then(m => { if (active) setComponent(() => m.Placement); })
      .catch(e => { if (active) setLoadError(e); });
    return () => { active = false; };
  }, [attempt]);
  const id = props.asset ?? props.draft.data.items.find(it => it.uid === props.uid)?.asset;
  const item = useDecorItem(props.index, id);
  const pending = item.pending || !Component, error = item.error ?? loadError;
  const retry = () => { item.retry(); setAttempt(n => n + 1); };
  if (!pending && !error) return html`<${Component} ...${props} />`;
  return html`<div class="ao-place" role="dialog" aria-modal="true" aria-label=${tr('shop.place')} aria-busy=${error ? undefined : 'true'}>
    ${error ? html`<div class="bu-banner bu-banner--warning" role="alert"><span>${tr('shop.loadFailed')}</span><button type="button" class="bu-btn" onClick=${retry}>${tr('office.retry')}</button></div>` : html`<${Skeleton} kind="block" />`}
    <button type="button" class="bu-btn" onClick=${props.onClose}>${tr('shop.sheet.close')}</button>
  </div>`;
}
function FurnitureGrid({ tab, itemIds, index, data, canWrite, onPlace }) {
  const [open, setOpen] = useState(null);
  const items = furnitureItems(index, data, tab);
  const byId=new Map(items.map(item=>[item.id,item]));
  const filtered=itemIds.map(id=>byId.get(id)).filter(Boolean);
  const it = open && filtered.find((x) => x.id === open);
  if (!items.length) return html`<p class="bu-text-secondary">${tr('shop.emptyTab')}</p>`;
  return html`<ul class="ao-shop__grid" role="list">
    ${filtered.map((x) => html`<li key=${x.id}>
      <button type="button" class=${'bu-card bu-card--interactive ao-shop__card' + (open === x.id ? ' bu-card--selected' : '')} aria-expanded=${String(open === x.id)}
        data-store-item=${x.id} aria-controls="ao-shop-sheet" onClick=${() => setOpen(open === x.id ? null : x.id)}>
        <span class="ao-shop__thumb"><img src=${resolveUrl(x.f.thumbnail ?? furnitureImage(x.f), assetBase())} alt="" loading="lazy" decoding="async" /></span>
        <span class="ao-shop__name">${labelOf(x.f, 'furniture')}</span>
        <span class=${'ao-shop__badge' + (x.count ? ' is-on' : '')}>${x.count ? tr('shop.inOffice', { n: x.count }) : tr('shop.notInOffice')}</span>
      </button></li>`)}
  </ul>
  ${it ? html`<${ItemSheet} it=${it} index=${index} data=${data} canWrite=${canWrite} onPlace=${onPlace} onClose=${() => setOpen(null)} />` : null}`;
}

/** The chosen item: a large image, what it is, « Placer dans le bureau », and its copies already in the office. */
function ItemSheet({ it, index, data, canWrite, onPlace, onClose }) {
  const { f, pending, error, retry } = useDecorItem(index, it.id);
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
      <span class="ao-shop__big" aria-busy=${pending ? 'true' : undefined}>${error ? html`<button type="button" class="bu-btn" onClick=${retry}>${tr('office.retry')}</button>` : pending ? html`<${Skeleton} kind="block" />` : html`<img src=${resolveUrl(furnitureImage(f), assetBase())} alt="" />`}</span>
      <div class="ao-shop__facts">
        <p>${it.placement === 'wall' ? tr('shop.sheet.wall') : fp ? tr('shop.sheet.floor', { w: fp.w, d: fp.d }) : null}</p>
        ${it.f.station ? html`<p>${tr('shop.sheet.station')}</p>` : null}
        <p class="bu-text-secondary">${placed.length ? tr('shop.inOffice', { n: placed.length }) : tr('shop.notInOffice')}</p>
        <div class="ao-shop__sheetactions">
          <button type="button" class="bu-btn bu-btn--primary" disabled=${!canWrite || pending || !!error} aria-describedby=${canWrite ? undefined : 'ao-shop-ro'} onClick=${() => onPlace(it.id)}>
            <${Icon} name="add" />${tr('shop.place')}</button>
          ${placed.length ? html`<button type="button" class="bu-btn" disabled=${!canWrite} onClick=${() => onPlace(placed[0].uid)}><${Icon} name="pencil" />${tr('shop.moveExisting')}</button>` : null}
        </div>
      </div>
    </div>
  </section>`;
}

// ---------- Personnages / Couleurs / Accessoires ----------
function LooksPanel({ tab, category, itemIds, index, draft, occupants, seen, canWrite, agentId, onAgent, primaryName }) {
  const data = draft.data;
  const rows = useMemo(() => agentRows(data, occupants, seen ?? [], ruleLabel), [data, occupants, seen]);
  const looks = looksOf(data, index, rows);
  const row = rows.find((r) => r.id === agentId) ?? rows[0];
  const [focus, setFocus] = useState(null);
  useEffect(() => setFocus(null), [tab, category, row?.id]);
  if (!row) return html`<${Frame}><p class="bu-text-secondary">${tr('shop.noAgents')}</p></${Frame}>`;
  const nameOf = (r) => (r.isDefault ? ruleLabel(r.id) : displayName({ id: r.id, role: r.role, name: data.agents.find((a) => a.agentId === r.id)?.name, sourceName: r.sourceName }, { primaryName }));
  const look = looks[row.id];
  const accessoryById=tab==='accessoires' ? new Map(accessoryItems(index,look,rows,looks).map(item=>[item.id,item])) : null;
  const list = tab === 'personnages' ? characterItems(index, look, rows, looks) : tab === 'couleurs' ? colourItems(index, look, rows, looks) : itemIds.map(id=>accessoryById.get(id)).filter(Boolean);
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
  return html`<${Frame} class="ao-shop__looks" bodyClass="ao-frame__body--framed" bar=${html`
    <div class="ao-shop__agents" role="radiogroup" aria-label=${tr('shop.agentFor')}>
      ${rows.map((r) => html`<button type="button" role="radio" key=${r.id} class="ao-shop__chip" aria-checked=${String(r.id === row.id)} onClick=${() => onAgent(r.id)}>
        <${Figure} index=${index} look=${looks[r.id]} pose="idle" assetBase=${assetBase()} cls="ao-shop__chipfig" />
        <span>${nameOf(r)}</span>${r.isDefault ? html`<span class="bu-sr-only">${tr('ed.defaultRule')}</span>` : null}</button>`)}
    </div>
    `}>
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
      <${Frame} class="ao-shop__catalog" bodyClass="ao-shop__catalogue" bodyLabel=${tr('shop.tab.' + tab)}>
      ${list.length ? html`<ul class="ao-shop__grid ao-shop__grid--looks" role="list">
        ${list.map((x) => html`<li key=${x.id}>
          <button type="button" class=${'bu-card bu-card--interactive ao-shop__card' + (focus === x.id ? ' bu-card--selected' : '')} data-store-item=${x.id} aria-pressed=${String(focus === x.id)} onClick=${() => setFocus(focus === x.id ? null : x.id)}>
            <span class="ao-shop__thumb ao-shop__thumb--fig">
              ${tab === 'couleurs' && x.swatch ? html`<span class="ao-shop__swatch" style=${{ background: safeColor(x.swatch) }}></span>` : null}
              <${Figure} index=${index} look=${tab === 'accessoires' ? (x.on ? look : x.toggled) : x.look} pose="idle" assetBase=${assetBase()} thumbnail=${tab !== 'accessoires'} /></span>
            <span class="ao-shop__name">${itemName(x)}</span>
            <span class=${'ao-shop__badge' + (x.on ? ' is-on' : '')}>${x.on ? tr(tab === 'accessoires' ? 'shop.wearing' : 'shop.currentShort') : wornText(x.wornBy) ?? tr('shop.free')}</span>
          </button></li>`)}
      </ul>` : html`<p class="bu-text-secondary">${tr(tab === 'couleurs' ? 'shop.noColours' : 'shop.emptyTab')}</p>`}
      </${Frame}>
    </div>
  </${Frame}>`;
}

// ---------- the save bar (a shared frame footer) ----------
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
