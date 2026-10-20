import { loadModule, chunkError, reloadChunks } from '../build-update.js';
// Bureau: OfficeVM + LayoutVM; headline, scene, roster and Carnet in reading order.
import { html, useEffect, useRef, useState } from '../lib.js';
import { useTopic, useNow, useStore } from '../hooks.js';
import { services } from '../services.js';
import * as i18n from '../i18n.js';
import { registerMessages } from '../messages.js';
import * as mobileDictionary from '../messages/bureau-mobile.js';
registerMessages(mobileDictionary);
import { t, label, has, agentName } from '../i18n.js';
import * as fmt from '../fmt.js';
import * as api from '../api.js';
import { toast } from '../toast.js';
import { config, buildQuery } from '../config.js';
import { streamUnconfirmed } from '../stream.js';
import * as fmtTz from '../fmt.js';
import { Frame, Icon, Ago, Skeleton, ErrorState } from '../components/ui.js';
import { OfficeScene } from './scene.js';
import * as sceneIntents from './scene-intents.js';
import { Modal } from '../components/modal.js';
let Button, MobileRoster;
let mobileControls;
const loadMobileControls=()=>mobileControls ||= Promise.all([
  loadModule(() => import('./mobile-roster.js' + buildQuery)),
  loadModule(() => import('../components/bureau/styles.js' + buildQuery)).then(module=>module.loadStyles()),
]).then(([module])=>{Button=module.Button;MobileRoster=module.MobileRoster;}).catch(error=>{mobileControls=null;throw error;});
import { STATES, stateIconFor } from './states.js';
import { indexManifest } from './assets.js';
import { avatarSource, CharacterAvatar } from './avatar.js';
import { itemName, canonicalRuleId } from './layout-rules.js';
import { displayName } from './names.js';
import { s as tr, locale, duration, labelOf } from './strings.js';
import { headline } from './headline.js';
import { floorId } from './floors.js';
import { resolveTheme } from './theme.js';
import { useLayout, officeApi, shippedLayoutVM } from './layout-source.js';
export { shippedLayoutVM };
// Localize generated titles; preserve given names.
const titleSource = (ref) => (ref && services.meta?.labels?.[ref.key] != null ? fmt.interpolate(services.meta.labels[ref.key], ref.params ?? {}) : null);
const nameOf = (o) => displayName(o, { primaryName: primaryName(), title: o.title ? L(o.title) : null, titleSource: titleSource(o.title) });
const occupantsKey = (list) => list.map((o) => [o.id, o.state, o.stateSince, o.stationUid, o.presenceLabel ?? '', o.name, JSON.stringify(o.look), o.destination?.stationUid ?? '', JSON.stringify([o.sceneTarget, o.sceneTravel, o.activity, o.standingPoint, o.communication, o.screenIntent])].join('\u0001')).join('\u0002');

function useSceneRecovery() {
  const dispose = useRef(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = () => { setError(false); setAttempt(n => n + 1); };
  const protect = apply => {
    try { apply(); } catch { dispose.current?.(); setError(true); }
  };
  return { dispose, error, attempt, retry, protect };
}

/** Occupants with their display name resolved (the scene and the headline read `name`). */
const named = (list) => list.map((o) => ({ ...o, name: nameOf(o), stateLabelText: L(o.stateLabel), stateLastLabelText: L(o.stateLastLabel) }));
// Keep the generic i18n fallback out; each sentence chooses its own form.
const primaryName = () => {
  const n = agentName();
  const fallback = typeof i18n.msg === 'function' ? i18n.msg('agent.fallback') : 'votre agent';
  return n && n !== fallback && n !== 'votre agent' ? n : null;
};

// Asset base can be overridden by bureau-dev.html; otherwise use deployment config.
export const officeAssetBase = () => services.officeAssetBase ?? config.assetBase;
const assetBase = officeAssetBase;
const STYLES = ['./office.css', './editor.css', './page.css', './setup-characters.css'].map((p) => new URL(p + buildQuery, import.meta.url).href);
/** LabelRef → text; office keys MetaVM doesn't carry yet fall back to strings.js (`label.<key>`, FR and EN). */
export function L(ref) {
  if (ref == null) return '';
  if (typeof ref !== 'object') return String(ref);
  if (ref.key === 'custom') return String(ref.params?.text ?? '');
  const params = Object.fromEntries(Object.entries(ref.params ?? {}).map(([k, v]) => [k, v && typeof v === 'object' ? L(v) : v]));
  if (has(ref.key)) return label({ ...ref, params });
  if (i18n.messageKeys('fr').includes(ref.key) || i18n.messageKeys('en').includes(ref.key)) return i18n.msg(ref.key, params);
  if (ref.key.startsWith('agentState.')) {
    const officeText = tr(`state.${ref.key.slice('agentState.'.length)}`, params, locale());
    if (officeText !== `state.${ref.key.slice('agentState.'.length)}`) return officeText;
  }
  const officeText = tr(ref.key, params, locale());
  if (officeText !== ref.key) return officeText;
  return tr(`label.${ref.key}`, params);
}
const forState = (o) => L(o.stateDetailLabel || o.stateLabel);
const stateLabel = (o) => L(o?.stateLabel);

const styleLoads = new Map();
const stylesReady = () => STYLES.every(href => document.querySelector(`link[data-office="${href}"]`)?.dataset.loaded === 'true');
function loadStyles() {
  return Promise.all(STYLES.map(href => {
    if (styleLoads.has(href)) return styleLoads.get(href);
    const request = new Promise((resolve, reject) => {
      // A failed link can still have a sheet. Only its load event proves success.
      document.querySelector(`link[data-office="${href}"]`)?.remove();
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = href; link.dataset.office = href;
      const finish = ok => {
        clearTimeout(timer); link.onload = link.onerror = null;
        if (ok) { link.dataset.loaded = 'true'; resolve(); }
        else { link.remove(); styleLoads.delete(href); reject(chunkError(new Error(tr('office.mapUnavailable')))); }
      };
      const timer = setTimeout(() => finish(false), 10000);
      link.onload = () => finish(true); link.onerror = () => finish(false);
      document.head.append(link);
    });
    styleLoads.set(href, request);
    return request;
  }));
}

function useStyles() {
  const [ready, setReady] = useState(stylesReady);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const retry = () => reloadChunks({ manual: true });
  useEffect(() => {
    let alive = true;
    loadStyles().then(() => { if (alive) setReady(true); }, e => { if (alive) setError(e); });
    const online = () => { if (!stylesReady()) { setError(null); setAttempt(n => n + 1); } };
    window.addEventListener('online', online);
    return () => { alive = false; window.removeEventListener('online', online); };
  }, [attempt]);
  return { ready, error, retry };
}

/** Re-render on a UI language switch (frontend's i18n.onLang, F6); a no-op before it exists. */
function useLang() {
  const [lang, set] = useState(locale());
  useEffect(() => (typeof i18n.onLang === 'function' ? i18n.onLang(() => set(locale())) : undefined), []);
  return lang;
}
const NO_STATUS = { get: () => null, subscribe: () => () => {} };

const floorLabel = floor => L(floor?.label);
/** office-dev-21: phones customize in the Boutique (the inline editor stacks badly there). */
const phone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches;
function usePhone() {
  const [mobile,setMobile]=useState(phone);
  useEffect(()=>{const media=matchMedia('(max-width: 600px)');const changed=()=>setMobile(media.matches);media.addEventListener('change',changed);return()=>media.removeEventListener('change',changed);},[]);
  return mobile;
}
const openShop = (query = {}) => {
  const r = services.router;
  const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString();
  r.navigate(r.href('boutique') + (q ? '?' + q : ''));
};
// The LayoutVM source (GET + `layout` topic, the shipped fallback) and the layout API live in layout-source.js, shared
// with the Boutique (office-dev-21).
export function BureauPage({ match }) {
  const styles = useStyles();
  useLang();
  if (!styles.ready) return styles.error
    ? html`<${Frame} class="bu-page ao-bureau"><${ErrorState} compact error=${{message:tr('office.mapUnavailable')}} onRetry=${styles.retry} /></${Frame}>`
    : html`<${Frame} class="bu-page ao-bureau" aria-busy="true"><p role="status">${tr('office.mapLoading')}</p></${Frame}>`;
  return html`<${BureauContent} match=${match} />`;
}

function BureauContent({ match }) {
  const [teamUI, setTeamUI] = useState(null);
  useEffect(() => { loadModule(() => import(new URL('./team-office.js' + buildQuery, import.meta.url).href)).then(setTeamUI, api.toastError); }, []);
  const lang = useLang();
  const mobile = usePhone();
  const [controlsReady,setControlsReady]=useState(!!Button);
  useEffect(()=>{
    let alive=true;
    if(mobile)loadMobileControls().then(()=>{if(alive)setControlsReady(true);},api.toastError);
    return ()=>{alive=false;};
  },[mobile]);
  const office = useTopic('office', '/api/v2/views/office');
  const layout = useLayout();
  const layoutRef = useRef(layout.data);
  layoutRef.current = layout.data;
  const status = useStore(services.stream?.status ?? NO_STATUS);
  const now = useNow(1_000);
  const selected = match.query.agent || null;
  useEffect(() => {
    if (layout.data && match.query.etage && !floorId(match.query.etage)) services.router.setQuery({ etage: '1' });
  }, [layout.data, match.query.etage]);
  const [editing, setEditing] = useState(false);
  const [mobileSheet,setMobileSheet]=useState(null);
  const [detailTeam,setDetailTeam]=useState(null);
  const mobileIsolation=useRef(null);
  useEffect(() => {
    if (!mobileSheet) return;
    const scrim = document.querySelector('.ao-bureau .bu-scrim');
    if (!scrim) return;
    const undo = isolate(scrim);
    let released = false;
    const release = () => { if (!released) { released = true; undo(); } };
    mobileIsolation.current = release;
    return () => {
      release();
      if (mobileIsolation.current === release) mobileIsolation.current = null;
    };
  }, [mobileSheet]);
  const closeMobileSheet=()=>{mobileIsolation.current?.();setMobileSheet(null);};
  const mainScene=useRef(null);
  const travelMemory=useRef(new Map());
  const [feed, setFeed] = useState('journal');   // the Journal / File tabs below the office
  // A language switch remounts the scene (its labels are set at mount), but never under an open editor's draft.
  const [stageLang, setStageLang] = useState(lang);
  useEffect(() => { if (!editing) setStageLang(lang); }, [lang, editing]);

  const failed = (office.data === undefined && office.error) || (layout.data === undefined && layout.error);
  if (failed || office.data === undefined || layout.data === undefined) {
    return html`<${BureauWaiting} failed=${!!failed} onRetry=${() => { office.retry(); layout.retry(); }} />`;
  }
  const staleSources = office.meta?.stale ?? [];
  const vm = { ...office.data, occupants: office.data.occupants.map(o => ({ ...o, sourceStale: staleSources.some(s => o.sessionKey?.startsWith(`rt:${s.split(':')[0]}:`)) || (!staleSources.some(s => s.includes(':')) && staleSources.length > 0) })) };
  const lay = layout.data;
  const occupants = vm.occupants;
  const t0 = now;
  const present = occupants;
  const visits = vm.visitIntent || null;
  // The floor registry is canonical and data-driven; only its selected room is mounted below.
  const presentById = new Map(present.map(o => [o.id, o]));
  const floors = (vm.rosterFloors || []).map(floor => ({ ...floor,
    occupants: (floor.occupantIds || []).map(id => presentById.get(id)).filter(Boolean) }));
  const floorPlan = { floors, occupants: floors.flatMap(floor => floor.occupants), byId: new Map(floors.map(floor => [floor.id, floor])) };
  const roster = floorPlan.floors.flatMap(f => f.occupants);
  const queryFloor = floorId(match.query.etage);
  const currentFloor = floorPlan.byId.get(queryFloor) ?? floorPlan.byId.get('1');
  const visiblePeople = currentFloor.occupants;
  const currentStore = officeApi(currentFloor.id);
  const floorData = { ...lay.layout.data, ...currentFloor.layout };
  const floorLay = { ...lay, layout: { ...lay.layout, data: floorData }, default: lay.default && { ...lay.default, data: floorData }, theme: { ...lay.theme, resolved: resolveTheme(currentFloor.layout.theme, new Date(now), fmtTz.timeZone()) } };
  const sel = roster.find((o) => o.id === selected) || null;
  const detailLayout = floorLay;
  const select = (id,team=null) => {
    setDetailTeam(id ? team || mobileSheet?.team || (mobileSheet?.conversationIds ? {conversationIds:mobileSheet.conversationIds,label:i18n.msg('office.mobile.backConversations')} : null) : null);
    closeMobileSheet();
    const o = roster.find(x => x.id === id);
    const query = { agent: id };
    // Closing a selection should leave the viewed floor alone. Selecting a real
    // occupant still follows their home floor (and omits the default floor 1).
    if (id) query.etage = o?.floorId && o.floorId !== '1' ? o.floorId : null;
    services.router.setQuery(query);
  };
  const backToTeam = () => { services.router.setQuery({agent:null}); setMobileSheet(detailTeam.conversationIds ? {conversationIds:detailTeam.conversationIds} : {team:detailTeam}); };
  const selectFloor = id => {
    closeMobileSheet();
    if (id === currentFloor.id) return;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.documentElement.classList.add('ao-floor-transition');
    services.router.setQuery({ etage: id, agent: null });
    if (!reduced) setTimeout(() => document.documentElement.classList.remove('ao-floor-transition'), 380);
    else document.documentElement.classList.remove('ao-floor-transition');
  };
  // Only stream loss freezes the scene. Secondary source health stays scoped to its own data.
  const down = streamUnconfirmed(status);
  const stale = down ? { stale: ['stream'], generatedAt: status.lastFrameAt ?? office.meta?.generatedAt ?? null } : null;
  const head = headline({ ...vm, occupants: named(vm.occupants) }, { primaryName: primaryName(), now, locale: lang, meta: stale, time: fmt.time, date: (ms) => fmt.dateTime(ms, now) });
  const unconfirmed = !!head.stale;
  const downSince = down ? stale.generatedAt : null;   // the chip's « depuis » (the last frame received)
  // Read-only layouts disable editing and theme writes.
  const caps = (status && status.capabilities) || (services.meta && services.meta.capabilities) || null;
  const canWrite = !lay.readOnly && !(caps && caps.storeWrites === false);

  // Status and theme above; stage, team and roster together; journal below. The headline stays accessible and hidden.
  return html`<${Frame} class=${'bu-page ao-bureau ao-bureau--ready' + (editing ? ' ao-bureau--editing' : '') + (unconfirmed ? ' ao-bureau--last' : '')} lang=${lang} head=${html`
    <h2 class="bu-sr-only ao-bureau__lead" id="ao-bureau-lead" data-kind=${head.kind}>${[head.lead, ...head.deck].join(' ')}</h2>
    ${vm.connection.gateway === 'down' ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="wifi-off" />
      <span class="bu-banner__text">${tr('office.gatewayDown')}${vm.connection.since ? html` <${Ago} at=${vm.connection.since} />` : null}</span>
      <a class="bu-btn bu-btn--sm" href=${services.router.href('parametres',{}, {onglet:'connexion'})}>${i18n.msg('settings.openConnection')}</a></div>` : null}
    <div class="ao-bureau__top">
      ${mobile || editing ? null : html`<${Kpis} kpis=${vm.kpis ?? []} />`}
      ${editing ? null : canWrite ? html`<${ThemeToggle} lay=${floorLay} store=${currentStore} />`
        : html`<p class="ao-bureau__ro" id="ao-bureau-ro">${tr(lay.readOnly ? 'office.readonlyLayout' : 'office.readonly')}</p>`}
    </div>
    `}>
    <div class="ao-bureau__main">
      <div class="ao-bureau__stagecol">
        <div class="ao-bureau__stagewrap">
          ${mobile ? html`<button type="button" class="bu-btn bu-btn--sm ao-floor-mobile-trigger" onClick=${() => setMobileSheet('floors')} aria-haspopup="dialog">${tr('office.floor.picker')}: ${floorLabel(currentFloor)}</button>` : null}
          <${Stage} key=${currentFloor.id + ':' + stageLang + (canWrite ? '' : ':ro')} vm=${vm} occupants=${editing ? present : visiblePeople} lay=${floorLay} store=${currentStore} floor=${currentFloor} onSelectFloor=${selectFloor} selected=${selected} onSelect=${select} visits=${visits} editing=${editing} setEditing=${setEditing} unconfirmed=${unconfirmed} down=${down} downSince=${downSince} now=${now} canWrite=${canWrite} sceneHandle=${mainScene} travelMemory=${travelMemory.current} minimalLabels=${mobile && !editing} />
          ${editing ? null : html`<button type="button" class="bu-btn bu-btn--sm bu-btn--icon ao-mobile-options" disabled=${mobile&&!controlsReady} aria-label=${i18n.msg('office.mobile.options')} onClick=${() => setMobileSheet('options')}><${Icon} name="plus" /></button>`}
        </div>
        ${editing || !mobile ? null : html`<${MobileSummary} summary=${vm.rosterSummary} kpis=${vm.kpis || []} unconfirmed=${unconfirmed} />
          ${controlsReady?html`<${MobileRoster} occupants=${roster} rosterItems=${vm.rosterItems} rosterPreviewItems=${vm.rosterPreviewItems} rosterOverflowCount=${vm.rosterOverflowCount} rosterOverflowLabel=${vm.rosterOverflowLabel} allLabel=${vm.rosterAllLabel} conversationIds=${vm.conversationIds} conversationCount=${vm.conversationCount} conversationLabel=${vm.conversationLabel} selected=${selected} onSelect=${select} onAll=${() => setMobileSheet('roster')} onTeam=${team=>setMobileSheet({team})} onConversations=${ids=>setMobileSheet({conversationIds:ids})} manifest=${lay.manifest} unconfirmed=${unconfirmed} Avatar=${Avatar} StateChip=${StateChip} nameOf=${nameOf} roleLabel=${L} label=${L} emptyLabel=${tr('office.empty')} stateTitle=${o=>unconfirmed||o.sourceStale ? L(o.stateLastLabel) : forState(o)} />`:null}`}

        ${editing || mobile ? null : html`<${FloorPicker} floors=${floorPlan.floors} current=${currentFloor.id} onSelect=${selectFloor} />`}
      </div>
      <div class="ao-bureau__editbar" id="ao-bureau-editbar"></div>
      <aside class="ao-bureau__side" aria-label=${editing ? tr('office.customize') : tr('office.rosterLabel')}>
        <div id="ao-bureau-editaside" hidden=${!editing}></div>
        ${editing ? null : html`<${Roster} occupants=${roster} rosterFloors=${vm.rosterFloors || []} selected=${selected} onSelect=${select} now=${now} unconfirmed=${unconfirmed} manifest=${lay.manifest} groupedFloors onJumpFloor=${selectFloor} hostAnnotation=${teamUI?.hostAnnotation} />`}
        ${!editing && teamUI && html`<${teamUI.TeamOffice} hint=${office.data.orchestratorActivationAvailable} office=${office.data} />`}
      </aside>
    </div>
    ${editing ? null : html`<${Feed} vm=${vm} stale=${stale} tab=${feed} setTab=${setFeed} mobile=${mobile} />`}
    ${mobileSheet && !editing && !sel ? html`<${Modal} size="md" class=${'ao-office-sheet' + (mobileSheet === 'options' ? ' ao-office-options' : '')} title=${mobileSheet?.conversationIds ? i18n.msg('office.mobile.conversationsTitle') : mobileSheet?.team ? L(mobileSheet.team.label) : mobileSheet === 'floors' ? tr('office.floor.picker') : mobileSheet === 'roster' ? tr('office.rosterLabel') : i18n.msg('office.mobile.options')} onClose=${closeMobileSheet}
      footer=${mobileSheet === 'options' ? null : html`<button type="button" class="bu-btn" onClick=${closeMobileSheet}>${tr('office.close')}</button>`}>
      ${mobileSheet?.conversationIds ? html`<${Roster} all occupants=${roster.filter(o=>mobileSheet.conversationIds.includes(o.id))} selected=${selected} onSelect=${select} now=${now} unconfirmed=${unconfirmed} manifest=${lay.manifest} />`
        : mobileSheet === 'floors' ? html`<${FloorPicker} floors=${floorPlan.floors} current=${currentFloor.id} onSelect=${selectFloor} mobile />`
        : mobileSheet?.team ? html`<${Roster} all occupants=${roster.filter(o=>mobileSheet.team.ids.includes(o.id))} selected=${selected} onSelect=${select} now=${now} unconfirmed=${unconfirmed} manifest=${lay.manifest} />`
        : mobileSheet === 'roster' ? html`<${Roster} all occupants=${roster} rosterFloors=${vm.rosterFloors || []} selected=${selected} onSelect=${select} now=${now} unconfirmed=${unconfirmed} manifest=${lay.manifest} groupedFloors onJumpFloor=${selectFloor} />`
        : html`
        <div class="ao-office-options__actions">
          <${Button} label=${i18n.msg('office.mobile.center')} icon=${html`<${ViewIcon} center />`} onPress=${() => { if(mainScene.current){mainScene.current.cam.user=false;mainScene.current.fit();} }} />
          <${Button} label=${tr('scene.fullscreen')} icon=${html`<${ViewIcon} />`} onPress=${() => {closeMobileSheet();void mainScene.current?.toggleFullscreen();}} />
          ${canWrite ? html`<${Button} label=${tr('office.customize')} icon=${html`<${Icon} name="pencil" />`} onPress=${()=>{closeMobileSheet();setEditing(true);}} />` : null}
        </div>
        ${canWrite ? html`<${ThemeToggle} lay=${floorLay} store=${currentStore} labelId="ao-mobile-theme-label" visibleLabel=${i18n.msg('office.mobile.lighting')} icons />` : html`<p class="ao-bureau__ro">${tr(lay.readOnly ? 'office.readonlyLayout' : 'office.readonly')}</p>`}`}
    </${Modal}>` : null}
    ${sel && !editing ? html`<${Drawer} o=${sel} lay=${detailLayout} unconfirmed=${unconfirmed} sourceStale=${!!sel.sourceStale} onClose=${() => select(null)} onBack=${mobile&&detailTeam ? backToTeam : null} teamLabel=${L(detailTeam?.label)} onCustomize=${canWrite ? () => setEditing({ agent: sel.id }) : null} />` : null}
  </${Frame}>`;
}

/** No usable snapshot yet: the loading sentence, or the unavailable one with a retry (never zero counts). */
function BureauWaiting({ failed, onRetry }) {
  const head = headline(undefined, { error: failed, locale: locale() });
  if (failed) return html`<${Frame} class="bu-page ao-bureau">
    <div class="bu-banner bu-banner--warning ao-bureau__lead" role="alert" data-kind=${head.kind}><${Icon} name="warning" />
      <span class="bu-banner__text">${head.lead}</span>
      <button type="button" class="bu-btn bu-btn--sm" onClick=${onRetry}>${tr('office.retry')}</button></div>
  </${Frame}>`;
  return html`<${Frame} class="bu-page ao-bureau" aria-busy="true">
    <h2 class="bu-sr-only ao-bureau__lead" data-kind=${head.kind}>${head.lead}</h2>
    <div class="bu-kpis ao-bureau__kpis">${Array.from({ length: 6 }, (_, k) => html`<div key=${k} class="bu-kpi"><${Skeleton} style="width:6rem" /><${Skeleton} kind="title" style="width:3rem" /></div>`)}</div>
    <div class="ao-bureau__main"><div class="ao-bureau__stagecol"><div class="ao-bureau__stagewrap"><div class="bu-stage ao-bureau__stage"><${Skeleton} style="width:100%;height:100%" /></div></div></div>
      <div class="ao-bureau__side">${Array.from({ length: 3 }, (_, k) => html`<div key=${k} class="bu-roster"><${Skeleton} style="width:60%" /></div>`)}</div></div>
  </${Frame}>`;
}

/** The KPI strip (OfficeVM.kpis): label, value, optional sub-line; values formatted for the UI's locale. */
function kpiValue(k) {
  if (k.value == null) return '—';
  if (k.unit === 'percent') return fmt.percent(k.value);
  return fmt.number(k.value);
}
function Kpis({ kpis }) {
  if (!kpis.length) return html`<div class="ao-bureau__kpis"></div>`;
  return html`<div class="bu-kpis ao-bureau__kpis" role="list" aria-label=${tr('office.kpis')}>
    ${kpis.map((k) => html`<div key=${k.id} class="bu-kpi" role="listitem">
      <span class="bu-kpi__label">${L(k.label)}</span>
      <span class="bu-kpi__value">${kpiValue(k)}</span>
      ${k.sub ? html`<span class="bu-kpi__sub">${L(k.sub)}</span>` : null}
    </div>`)}
  </div>`;
}

/** Mobile shares identities and selection with the full roster, including annex occupants. */
function MobileSummary({summary,kpis,unconfirmed}) {
  const active=summary?.activeCount ?? null;
  const count=summary?.count ?? 0;
  const summaryKey=unconfirmed?'office.mobile.lastSummary':active==null?'office.mobile.summaryUnknown':'office.mobile.summary';
  return html`<details class="ao-mobile-summary"><summary><${Icon} name=${unconfirmed ? 'clock' : 'agent'} />${i18n.msg(summaryKey,{n:count,active})}<${Icon} name="arrow-down" /></summary><${Kpis} kpis=${kpis} /></details>`;
}

function ViewIcon({center=false}) {
  return html`<svg class="bu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />${center?html`<path d="M12 8v8m-4-4h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />`:null}</svg>`;
}

/** Journal / File below the office: the recent activity, or the next scheduled tasks; the snapshot's freshness. */
function connectionAge(vm, stale) {
  const up = vm.connection.gateway !== 'down';
  return stale ? tr('office.updatedAt', { time: fmt.time(stale.generatedAt) })
    : up && vm.connection.since ? tr('office.connectedSince', { time: fmt.dateTime(vm.connection.since) }) : null;
}
function Feed({ vm, stale, tab, setTab, mobile }) {
  const fresh = connectionAge(vm,stale);
  const content = html`<section class="bu-section ao-bureau__feed" aria-labelledby=${mobile ? undefined : 'ao-bureau-feed'} aria-label=${mobile ? i18n.msg('office.mobile.activity') : undefined}>
    <div class="ao-bureau__feedhead">
      ${mobile ? null : html`<h2 class="bu-eyebrow" id="ao-bureau-feed">${tr(tab === 'journal' ? 'office.feed.journal' : 'office.feed.queue')}</h2>`}
      ${!mobile && fresh ? html`<span class="bu-text-tertiary ao-bureau__fresh">${fresh}</span>` : null}
      <div class="bu-segmented ao-bureau__tabs" role="group" aria-label=${tr('office.feed.show')}>
        <button type="button" class="bu-segmented__opt" aria-pressed=${String(tab === 'journal')} onClick=${() => setTab('journal')}>${tr('office.feed.journal')}</button>
        <button type="button" class="bu-segmented__opt" aria-pressed=${String(tab === 'file')} onClick=${() => setTab('file')}>${tr('office.feed.queue')} <span class="bu-count">${vm.queue.length}</span></button>
      </div>
    </div>
    ${tab === 'journal' ? html`<${Journal} items=${vm.journal} />` : html`<${Queue} items=${vm.queue} />`}
  </section>`;
  return mobile ? html`<details class="ao-mobile-activity"><summary><${Icon} name="journaux" />${i18n.msg('office.mobile.activity')}<${Icon} name="arrow-down" /></summary>${content}</details>` : content;
}

function Queue({ items }) {
  if (!items.length) return html`<p class="bu-text-secondary">${tr('office.queueEmpty')}</p>`;
  return html`<ol class="bu-journal" aria-label=${tr('office.queueLabel')}>${items.map((q) => html`<li key=${q.id} class="bu-event ao-bureau__queue">
    <span class="bu-event__who"><${Icon} name="flux" />${q.name}</span><span class="bu-event__text">${L(q.schedule)}</span></li>`)}</ol>`;
}

/** Office theme quick toggle: the layout owns the theme (api-proposal §4). One automatic retry on 409. */
function ThemeToggle({ lay, store = officeApi(), labelId = 'ao-theme-label', visibleLabel, icons=false }) {
  const theme = lay.layout.data.theme;
  const mode = theme.mode === 'fixed' ? theme.fixed : 'auto';
  const [busy, setBusy] = useState(false);
  async function set(m) {
    if (busy || m === mode) return;
    // R8-12: the user's intent is only the mode; it is applied on top of whatever theme is current.
    const apply = (base) => {
      const next = m === 'auto' ? { ...base, mode: 'auto' } : { ...base, mode: 'fixed', fixed: m };
      if (m === 'auto') delete next.fixed;
      return next;
    };
    setBusy(true);
    const send = (rev, base) => store.putTheme({ expectedRevision: rev, theme: apply(base) });
    try {
      try { await send(lay.layout.revision, theme); } catch (err) {
        // One retry, rebased on the conflict's authoritative theme (keeps another device's schedule/season).
        if (err.code === 'conflict' && err.current?.vm) await send(err.current.revision, err.current.vm.layout.data.theme);
        else throw err;
      }
    } catch (err) { api.toastError(err); }
    setBusy(false);
  }
  const opts = ['auto', 'day', 'night'].map((id) => [id, tr(`office.theme.${id}`)]);
  return html`<div class="ao-bureau__theme">
    <span class="ao-bureau__themelabel" id=${labelId}>${visibleLabel || tr('office.margin.theme')}</span>
    <div class="bu-segmented" role="group" aria-labelledby=${labelId} aria-busy=${busy ? 'true' : undefined}>
      ${opts.map(([id, text]) => html`<button type="button" class="bu-segmented__opt" aria-pressed=${String(mode === id)} disabled=${busy} onClick=${() => set(id)}>${icons?html`<${Icon} name=${id==='auto'?'clock':id==='day'?'sun':'moon'} />`:null}${text}</button>`)}
    </div>
    ${mode === 'auto' ? html`<p class="ao-bureau__themenow">${tr(lay.theme.resolved === 'night' ? 'office.themeNow.night' : 'office.themeNow.day')}</p>` : null}
  </div>`;
}

/** The scene: one OfficeScene per mount, fed from the VMs; cues from SSE `cue` frames. */
function Stage({ vm, occupants, lay, store = officeApi(), floor, onSelectFloor, selected, onSelect, visits, editing, setEditing, unconfirmed, down, downSince, now, canWrite, sceneHandle, travelMemory, minimalLabels }) {
  const latestOcc = useRef(occupants);
  latestOcc.current = occupants;
  const host = useRef(null);
  const sceneRef = useRef(null);
  const { dispose, error: sceneError, attempt, retry: retryScene, protect } = useSceneRecovery();
  const editorRef = useRef(null);
  const latest = useRef(vm);
  latest.current = vm;
  const latestLay = useRef(lay);
  latestLay.current = lay;

  useEffect(() => {
    let scene, removeCue = () => {};
    const cleanup = () => {
      const owned = scene; scene = null;
      dispose.current = null;
      removeCue(); sceneRef.current = null;
      if (sceneHandle?.current === owned) sceneHandle.current = null;
      const editor = editorRef.current; editorRef.current = null;
      try { editor?.close?.({ saved: false }); } finally { owned?.destroy(); }
    };
    dispose.current = cleanup;
    protect(() => {
      scene = new OfficeScene(host.current, {
        intents: sceneIntents,
        manifest: lay.manifest, layout: lay.layout.data, assetBase: assetBase(),
        theme: lay.theme.resolved, onSelect: (id) => onSelect(id), primaryName: () => primaryName(), timeZone: () => fmtTz.timeZone(),
      });
      sceneRef.current = scene;
      scene.setPrimaryLabels(minimalLabels, floor?.mobileLabelIds ?? []);
      if(sceneHandle)sceneHandle.current=scene;
      host.current.aoScene = scene;   // test/QA handle (DevTools, DOM tests): the stage element carries its scene
      if (canWrite) scene.addControl({ label: tr('office.customize'), text: true, icon: '<path d="M12 20h9"/><path d="M16.38 3.62a1 1 0 0 1 3 3L7.37 18.64a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z"/>', onClick: () => setEditing(true) });
      // SSE cue frames (app.js forwards them to services.cueListeners).
      const listeners = (services.cueListeners ??= new Set());
      const onCue = (f) => protect(() => { f.signal ? sceneRef.current?.signal(f.occupantId, f.signal) : sceneRef.current?.cue(f.occupantId, f.cue, { partnerId: f.partnerId ?? null, interactionId: f.interactionId ?? null }); });
      listeners.add(onCue);
      removeCue = () => listeners.delete(onCue);
    });
    return cleanup;
  }, [attempt]);

  useEffect(() => protect(() => { sceneRef.current?.setPrimaryLabels(minimalLabels, floor?.mobileLabelIds ?? []); }), [minimalLabels, JSON.stringify(floor?.mobileLabelIds ?? []), attempt]);

  // Layout changes (another device saved, theme switch at nextChangeAt).
  useEffect(() => protect(() => {
    const s = sceneRef.current;
    if (!s || editorRef.current) return;
    s.setLayout(lay.layout.data);
    s.setTheme(lay.theme.resolved);
  }), [lay.layout.revision, lay.theme.resolved, attempt]);

  // Occupants: the same list as the roster and the drawer.
  useEffect(() => protect(() => {
    if (!sceneRef.current || editorRef.current) return;
    sceneRef.current.setTravelIntents(vm.occupants, floor.id, travelMemory);
    sceneRef.current.setOccupants(named(occupants));
  }), [occupantsKey(occupants), JSON.stringify(vm.occupants.map(o => [o.id, o.sceneTravel])), editing, attempt]);

  useEffect(() => protect(() => { sceneRef.current?.setSignals(vm.journal); }), [vm.journal, attempt]);
  useEffect(() => protect(() => { sceneRef.current?.select(selected); }), [selected, vm.occupants, attempt]);
  // office-dev-22: visitors come to the agent (desk, or the meeting table for a real conversation).
  const visitsKey = JSON.stringify(visits ?? null);
  useEffect(() => protect(() => { sceneRef.current?.setVisits(editing ? null : visits); }), [visitsKey, editing, attempt]);

  // Editor (S14c): opened from the stage control or the drawer.
  useEffect(() => {
    if (!editing || editorRef.current || !sceneRef.current) return;
    let alive = true;
    const ownerScene=sceneRef.current;
    // The editor loads on first use.
    loadModule(() => import('./editor.js' + buildQuery)).then(({ openEditor }) => alive ? openEditor({
      scene: ownerScene, isCurrent:()=>alive && sceneRef.current===ownerScene, store, assetBase: assetBase(), primaryName: primaryName(), timeZone: fmtTz.timeZone(),
      barHost: document.getElementById('ao-bureau-editbar'), asideHost: document.getElementById('ao-bureau-editaside'),
      floorId:floor.id, floors:vm.rosterFloors,
      getCharacterVM: services.officeCharacterVM,
      getOccupants: () => latest.current.occupants.map((o) => ({ id: o.id, role: o.role, sourceName: o.sourceName ?? o.name, automaticLook: o.automaticLook, state: o.state, stateSince: o.stateSince })),
      toast: (message, level) => toast({ level, message }),
      onOpenShop: () => openShop({ etage: floor?.id }),
      onExit: (result) => protect(() => {
        if(!alive || sceneRef.current!==ownerScene) return;
        editorRef.current = null;
        const s = sceneRef.current;
        if (s) {
          // Drop the draft and restore subscribed server data. A LayoutVM save
          // response cannot supply occupant placement; refresh OfficeVM below.
          const L = latestLay.current;
          s.setLayout(L.layout.data);
          s.setTheme(L.theme.resolved);
          // Restore the last server projection until the refreshed OfficeVM arrives.
          s.setTravelIntents(latest.current.occupants, floor.id, travelMemory);
          s.setOccupants(named(latestOcc.current));
        }
        if(result?.nextFloor) { setEditing({mode:result.mode});onSelectFloor(result.nextFloor); }
        else setEditing(false);
        if (result?.saved) services.stream.resync?.('office');
      }),
    }) : null).then((ed) => {
      if(!ed) return;
      if (!alive) { ed.close({ saved: false }); return; }
      editorRef.current = ed;
      if(editing.mode) ed.setMode(editing.mode);
      if (editing.agent) { ed.selectCharacter(editing.agent); ed.setMode('characters'); }
    }, (err) => {
    // Failed editor loads return to browsing, explain the error and keep the control available.
      editorRef.current = null;
      protect(() => { sceneRef.current?.setEditing(false); });
      if (alive) {
        setEditing(false);
        if (err && err.code === 'unauthorized') return;   // the app's auth flow takes over
        api.toastError(err instanceof api.ApiError ? err : new api.ApiError({ message: tr('office.openFailed') }));
      }
    });
    return () => { alive = false; };
  }, [editing, attempt]);

  // R27-02: not live, the scene freezes (no walks, frame loops or CSS animation) until the stream confirms again.
  useEffect(() => protect(() => { sceneRef.current?.setFrozen(unconfirmed); }), [unconfirmed, attempt]);

  // Keep the last observation visible, with its offline duration.
  const cap = down && downSince ? tr('office.offlineSince', { duration: duration(Math.max(0, now - downSince)) }) : down ? tr('office.offline') : tr('office.stageCaption');
  return html`<div class=${'bu-stage ao-bureau__stage ao-office' + (unconfirmed ? ' ao-bureau__stage--last' : '')} ref=${host} role="region" hidden=${sceneError}
      data-floor=${floor?.id}
      aria-label=${tr(unconfirmed ? 'office.stageLast' : 'office.stage', { agent: agentName() })}></div>
    ${sceneError ? html`<${ErrorState} compact error=${{message:tr('office.mapUnavailable')}} onRetry=${retryScene} />` : null}
    ${unconfirmed ? html`<p class=${'ao-bureau__stagecap' + (down ? ' ao-bureau__stagecap--offline' : '')}>${cap}</p>` : null}`;
}

/** Base portraits or lightweight Store pack thumbnails; idle head crops for older looks. */
function Avatar({ o, manifest }) {
  const source = manifest && avatarSource(indexOf(manifest), o.look, assetBase());
  return html`<${CharacterAvatar} source=${source} state=${o.state} />`;
}

/** Accessible cards render the server-projected order, hierarchy and floor groups. */
function Roster({ all = false, occupants, rosterFloors = [], selected, onSelect, now, unconfirmed, manifest, groupedFloors = false, onJumpFloor = () => {}, hostAnnotation }) {
  const [eggs,setEggs]=useState({});
  useEffect(()=>{const update=e=>setEggs(prev=>({...prev,[e.detail.id]:e.detail.kind}));document.addEventListener('office-surprise',update);return ()=>document.removeEventListener('office-surprise',update);},[]);
  // Accessible names match visible text; seen and unconfirmed cards show their last observation.
  const card = (o) => html`<li key=${o.id} class=${o.rosterDepth > 0 ? 'ao-roster__child' : undefined}>
    <button type="button" class=${'bu-roster ao-roster ao-agentcard' + (o.presence ? ' is-seen' : '')} data-occupant=${o.id} data-presence=${o.presence || undefined} data-source-stale=${o.sourceStale || undefined}
      aria-current=${selected === o.id ? 'true' : undefined} onClick=${() => onSelect(o.id)}>
      <${Avatar} o=${o} manifest=${manifest} />
      <span class="bu-cell-main" data-by=${o.parentName || undefined}><span class="ao-roster__name ao-agentcard__name" title=${nameOf(o)}>${nameOf(o)}</span>
        <span class="bu-cell-sub ao-roster__summary" data-visit=${o.visitPhase || undefined} title=${o.summary || undefined}>${o.visitLabel ? L(o.visitLabel) : o.summary && o.summary !== o.name ? o.summary : o.project ? tr('office.inProject', { project: o.project }) : L(o.roleLabel)}${o.stationUid || o.visitPhase || o.summary || o.project ? '' : ` · ${tr('office.noStation')}`}</span>
        ${hostAnnotation?.(o) ? html`<span class="bu-cell-sub ao-host-annotation" data-host-agent=${o.hostAgentId}>${hostAnnotation(o)}</span>` : null}
        ${o.presence ? html`<span class="ao-agentcard__seen">${o.presenceLabel}</span>` : null}</span>
      ${eggs[o.id] && !unconfirmed ? html`<span class="bu-state" data-surprise-status=${eggs[o.id]}>${tr('egg.'+eggs[o.id])}</span>` : html`<${StateChip} state=${o.state} stateKind=${o.stateKind} stateLabel=${o.stateLabel} stateActive=${o.stateActive} live=${!unconfirmed && !o.presence && !o.sourceStale} title=${unconfirmed || o.sourceStale ? L(o.stateLastLabel) : forState(o)} />`}
    </button></li>`;
  if (!occupants.length) return html`<p class="bu-text-secondary">${tr('office.empty')}</p>`;
  if (groupedFloors && rosterFloors.length) {
    const byId = new Map(occupants.map((o) => [o.id, o]));
    return html`<div class="ao-floor-roster">${rosterFloors.map(floor => {
      const floorItems = (floor.items || []).map(item => item.kind === 'team-header'
        ? html`<li key=${item.id} class="ao-floor-roster__team" data-roster-team-header=${item.id}>${L(item.label)}</li>`
        : byId.has(item.occupantId) ? card(byId.get(item.occupantId)) : null);
      return html`<section key=${floor.id} class="ao-floor-roster__group" data-roster-floor=${floor.id}>
      <button type="button" class="ao-floor-roster__jump" onClick=${() => onJumpFloor(floor.id)}><span>${L(floor.label)}</span><span>${floor.count}</span><${Icon} name="arrow-right" /></button>
      <ul class="ao-bureau__roster">${floorItems}</ul>
    </section>`;
    })}</div>`;
  }
  return html`<ul class="ao-bureau__roster">${occupants.map(card)}</ul>`;
}

function FloorPicker({ floors, current, onSelect, mobile = false }) {
  return html`<nav class=${'ao-floor-picker' + (mobile ? ' ao-floor-picker--mobile' : '')} aria-label=${tr('office.floor.picker')}>
    ${floors.map(f => {
      return html`<button type="button" class="ao-floor-picker__floor" data-floor=${f.id} aria-current=${current === f.id ? 'true' : undefined} onClick=${() => onSelect(f.id)}>
        <span class="ao-floor-picker__name">${L(f.label)}</span>
        <span class="ao-floor-picker__count">${L(f.countLabel)}</span>
        <span class="ao-floor-picker__status">${L(f.statusLabel)}</span>
      </button>`;
    })}
  </nav>`;
}

function StateChip({ state, stateKind, stateLabel: stateRef, stateActive = false, live = true, title }) {
  const on = live && stateActive;
  const visitor = stateKind === 'visitor';
  return html`<span class=${'bu-state ao-roster__state' + (on ? ' bu-state--live ao-roster__state--live' : '')} data-agent-state=${visitor ? 'visitor' : state} data-state-kind=${visitor ? 'visitor' : undefined} title=${title || undefined}>
    <${Icon} name=${visitor ? 'discuter' : STATES.includes(state) ? stateIconFor(state) : 'info'} />${L(stateRef)}</span>`;
}

/** Journal (O3): time, then the event's sentence (it already names its subject, set in bold when it leads); a repeated
 * event says how many times. */
function Journal({ items }) {
  if (!items.length) return html`<p class="bu-text-secondary">${tr('office.carnetEmpty')}</p>`;
  return html`<ol class="bu-journal ao-carnet" aria-label=${tr('office.carnetLabel')}>${items.map((e) => {
    const text = L(e.text);
    const who = e.actor?.name && text.startsWith(e.actor.name) ? e.actor.name : null;
    return html`<li key=${e.id} class="bu-event ao-carnet__entry">
      <time class="bu-event__time" datetime=${new Date(e.at).toISOString()}>${fmt.time(e.at)}</time>
      <span class="bu-event__text">${who ? html`<span class="bu-event__who">${who}</span>${text.slice(who.length)}` : text}${e.count > 1 ? html` <span class="bu-text-tertiary">${tr('office.grouped', { n: e.count })}</span>` : null}</span>
    </li>`;
  })}</ol>`;
}

/** Make every element outside `keep` inert (siblings along each ancestor up to <body>). Returns undo. */
function isolate(keep) {
  const changed = [];
  for (let n = keep; n && n !== document.body; n = n.parentElement) {
    for (const sib of n.parentElement?.children ?? []) {
      if (sib === n || sib.inert || sib.tagName === 'SCRIPT') continue;
      sib.inert = true;
      changed.push(sib);
    }
  }
  return () => { for (const s of changed) s.inert = false; };
}

/** Keep Tab / Maj+Tab inside a dialog. */
function trapTab(e, dialog) {
  if (!dialog) return;
  const items = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled && n.offsetParent !== null);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  const inside = dialog.contains(document.activeElement);
  if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
}

const indexCache = new WeakMap();
const indexOf = (manifest) => indexCache.get(manifest) ?? (indexCache.set(manifest, indexManifest(manifest)), indexCache.get(manifest));

/** The station, said once: its own name when it has one (a label, « Poste de Scout »), else « Attribué » (Q03-O03). */
function stationText(o, lay) {
  if (!o.stationUid) return tr('office.drawer.noStation');
  const idx = indexOf(lay.manifest);
  const name = itemName(lay.layout.data, idx, o.stationUid);
  const it = lay.layout.data.items.find((i) => i.uid === o.stationUid);
  const generic = it && !it.label && name === labelOf(idx.furniture.get(it.asset), 'furniture');
  return generic ? tr('office.drawer.stationAssigned') : name;
}

function Drawer({ o, lay, onClose, onCustomize, onBack, teamLabel, unconfirmed, sourceStale = false }) {
  const manifest = lay.manifest;
  const closeRef = useRef(null);
  const dialogRef = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    // R8-13: modal for real: everything outside the drawer is inert, Tab / Maj+Tab cycle inside it.
    const undo = isolate(dialogRef.current?.parentElement);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'Tab') trapTab(e, dialogRef.current);
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); undo(); if (opener && opener.isConnected) opener.focus(); };
  }, [o.id]);
  const sessionHref = o.sessionKey ? services.router.href('session', { sessionKey: o.sessionKey }) : null;
  return html`<div class="bu-scrim bu-scrim--drawer ao-bureau__scrim" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <aside class="bu-drawer" role="dialog" aria-modal="true" aria-labelledby="ao-drawer-title" aria-describedby="ao-drawer-desc" ref=${dialogRef}>
      <div class="bu-modal__header">
        <${Avatar} o=${o} manifest=${manifest} />
        <div style="flex:1"><h2 class="bu-modal__title" id="ao-drawer-title">${nameOf(o)}</h2><p class="bu-modal__desc" id="ao-drawer-desc">${tr('office.drawer.desc', { role: L(o.roleLabel), state: stateLabel(o).toLocaleLowerCase(locale() === 'en' ? 'en-CA' : 'fr-CA') })}</p></div>
        <button type="button" class="bu-btn bu-btn--icon bu-btn--ghost" aria-label=${tr('office.close')} ref=${closeRef} onClick=${onClose}><${Icon} name="close" /></button>
      </div>
      <div class="bu-modal__body">
        ${onBack?html`<${Button} variant="ghost" label=${teamLabel} icon=${html`<${Icon} name="arrow-left" />`} onPress=${onBack} />`:null}
        <p class="ao-drawer__state" data-agent-state=${o.state} data-source-stale=${sourceStale || undefined}>${unconfirmed || sourceStale ? L(o.stateLastLabel) : stateLabel(o)}</p>
        ${o.summary ? html`<section class="ao-drawer__activity"><h3>${tr('office.what')}</h3><p>${o.summary}</p></section>` : null}
        <dl class="bu-kv">
          ${o.lastSeenAt ? html`<div class="bu-kv__row"><dt>${tr('office.drawer.lastSeen')}</dt><dd><${Ago} at=${o.lastSeenAt} /></dd></div>` : null}
          ${o.tokensKnown ? html`<div class="bu-kv__row"><dt>${tr('office.drawer.tokens')}</dt><dd>${fmt.number(o.tokens)}</dd></div>` : null}
          ${o.startedAt ? html`<div class="bu-kv__row"><dt>${tr('office.since')}</dt><dd><${Ago} at=${o.startedAt} /></dd></div>` : null}
          ${['project', 'runtime', 'model'].map((k) => o[k] ? html`<div class="bu-kv__row"><dt>${tr('office.' + k)}</dt><dd>${o[k]}</dd></div>` : null)}
          <div class="bu-kv__row"><dt>${tr('office.drawer.station')}</dt><dd>${stationText(o, lay)}</dd></div>
          ${o.sessionKey ? html`<details class="ao-drawer__technical"><summary>${tr('office.tech')}</summary><dl><div class="bu-kv__row"><dt>${tr('office.drawer.session')}</dt><dd class="bu-mono">${o.sessionKey}</dd></div></dl></details>` : null}
        </dl>
        ${['observed', 'verified'].includes(o.execution?.evidence?.level) ? html`<p class="ao-drawer__evidence">${tr('state.' + o.execution.evidence.level)}</p>` : null}
      </div>
      <div class="bu-modal__footer">
        ${onCustomize ? html`<button type="button" class="bu-btn bu-btn--ghost" onClick=${onCustomize}><${Icon} name="pencil" />${tr('office.customize')}</button>` : null}
        ${sessionHref ? html`<a class="bu-btn bu-btn--primary" href=${sessionHref}>${tr('office.openSession')}</a>` : null}
      </div>
    </aside>
  </div>`;
}
