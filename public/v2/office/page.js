// Bureau page (<basePath>bureau, migration-plan S14a/b), editorial (design/explorations/editorial-guide.md §6):
// one true sentence about the office now (headline.js) above the illustrated office; beside it a margin with the
// agents present as a quiet list, the snapshot's freshness and the office theme; below, the Carnet (the journal
// as dated notes) with the upcoming tasks in its margin. No statistics strip above the scene (guide §6).
// OfficeVM from the `office` topic, LayoutVM from the `layout` topic. Selection in the URL (?agent=<occupantId>).
// DOM order is the mobile reading order: headline, scene, agents, notes, Carnet, upcoming tasks. FR and EN.
import { html, useEffect, useRef, useState } from '../lib.js';
import { useTopic, useNow, useStore } from '../hooks.js';
import { services } from '../services.js';
import * as i18n from '../i18n.js';
import { t, label, has, agentName } from '../i18n.js';
import * as fmt from '../fmt.js';
import * as api from '../api.js';
import { toast } from '../toast.js';
import { config, buildQuery } from '../config.js';
import { streamUnconfirmed } from '../stream.js';
import * as fmtTz from '../fmt.js';
import { Icon, Ago, Skeleton } from '../components/ui.js';
import { OfficeScene } from './scene.js';
import { SurpriseSetting } from './surprise-setting.js';
import { STATES } from './states.js';
import { indexManifest, resolveUrl } from './assets.js';
import { itemName, resolveOccupants, canonicalRuleId, presenceMinutes } from './layout-rules.js';
import { displayName } from './names.js';
import { s as tr, locale, duration, labelOf } from './strings.js';
import { headline } from './headline.js';
import { seenOccupants } from './seen.js';
import { planAnnexes } from './annex.js';
import { trackTurns, planVisits, isVisitor, phaseOf, lingering } from './visits.js';
import { resolveTheme } from './theme.js';
import { useLayout, officeApi, shippedLayoutVM } from './layout-source.js';
export { shippedLayoutVM };
// Names (platform rule + 2.4 OccupantVM.title): the title is rendered in the UI language and in the server's own
// language (MetaVM.labels), so a generated name is shown localized and a given name stays as written.
const titleSource = (ref) => (ref && services.meta?.labels?.[ref.key] != null ? fmt.interpolate(services.meta.labels[ref.key], ref.params ?? {}) : null);
const nameOf = (o) => displayName(o, { primaryName: primaryName(), title: o.title ? L(o.title) : null, titleSource: titleSource(o.title) });
/** The roster in roster order, with the desks the annexes gave (an annex agent is not « sans poste »). */
function rosterOf(present, plan) {
  if (!plan.annexes.length) return present;
  const placed = new Map(plan.annexes.flatMap((a) => a.occupants.map((o) => [o.id, o])));
  return present.map((o) => placed.get(o.id) ?? o);
}

/** A cheap identity for a list of occupants (re-render the scene only when something it draws changed). */
const occupantsKey = (list) => list.map((o) => [o.id, o.state, o.stateSince, o.stationUid, o.presenceLabel ?? '', o.name, JSON.stringify(o.look), o.destination?.stationUid ?? ''].join('\u0001')).join('\u0002');

/**
 * O9: an annex room, a read-only scene of its own (zoom and fit, nameplates, selection; no editor, no theme toggle).
 * The same cues reach it (a cue for an agent elsewhere is ignored by its scene).
 */
function Annex({ annex, lay, selected, onSelect, unconfirmed, signals }) {
  const host = useRef(null);
  const sceneRef = useRef(null);
  useEffect(() => {
    const labels = Object.fromEntries(STATES.map((s) => [s, stateLabel(s)]));
    const scene = new OfficeScene(host.current, { manifest: lay.manifest, layout: annex.layout, assetBase: assetBase(), labels, theme: lay.theme.resolved,
      onSelect: (id) => onSelect(id), primaryName: () => primaryName(), timeZone: () => fmtTz.timeZone() });
    sceneRef.current = scene;
    const listeners = (services.cueListeners ??= new Set());
    const onCue = (f) => { if (annex.occupants.some((o) => o.id === f.occupantId)) (f.signal ? sceneRef.current?.signal(f.occupantId, f.signal) : sceneRef.current?.cue(f.occupantId, f.cue, { partnerId: f.partnerId ?? null, interactionId: f.interactionId ?? null })); };
    listeners.add(onCue);
    return () => { listeners.delete(onCue); scene.destroy(); sceneRef.current = null; };
  }, []);
  useEffect(() => { sceneRef.current?.setLayout(annex.layout); sceneRef.current?.setTheme(lay.theme.resolved); }, [lay.theme.resolved, annex.layout.items.length]);
  useEffect(() => { sceneRef.current?.setOccupants(named(annex.occupants)); }, [occupantsKey(annex.occupants)]);
  useEffect(() => { sceneRef.current?.setSignals(signals); }, [signals]);
  useEffect(() => { sceneRef.current?.select(annex.occupants.some((o) => o.id === selected) ? selected : null); }, [selected, occupantsKey(annex.occupants)]);
  useEffect(() => { sceneRef.current?.setFrozen(unconfirmed); }, [unconfirmed]);
  return html`<section class=${'ao-bureau__annex' + (unconfirmed ? ' ao-bureau__annex--last' : '')} aria-labelledby=${'ao-annex-' + annex.n}>
    <h3 class="ao-below-title" id=${'ao-annex-' + annex.n}>${tr('office.annex', { num: annex.n, n: annex.occupants.length })}</h3>
    <div class="bu-stage ao-bureau__annexstage" ref=${host} role="region" aria-label=${tr('office.annexStage', { n: annex.n })}></div>
  </section>`;
}

/** Occupants restyled by a layout (looks and home stations), as the server's OfficeVM would after a save. */
function withLayout(occupants, lay) {
  const r = resolveOccupants(lay.layout.data, indexOf(lay.manifest), occupants.map((o) => ({ id: o.id, role: o.role, sourceName: o.sourceName ?? o.name })));
  return occupants.map((o, i) => ({ ...o, look: r[i].look, stationUid: r[i].stationUid, ruleId: r[i].ruleId }));
}
/** Occupants with their display name resolved (the scene and the headline read `name`). */
const named = (list) => list.map((o) => ({ ...o, name: nameOf(o) }));
// The primary agent's configured name, or null (never i18n's « l’agent » fallback: each sentence picks its own form).
const primaryName = () => {
  const n = agentName();
  const fallback = typeof i18n.msg === 'function' ? i18n.msg('agent.fallback') : 'votre agent';
  return n && n !== fallback && n !== 'votre agent' ? n : null;
};

// Seams for the standalone harness (bureau-dev.html): services.officeAssetBase, services.officeApi.
// Asset base from the runtime config (F7): basePath + 'bureau/' ('/bureau/' at the root, '/v2/bureau/' under /v2).
export const officeAssetBase = () => services.officeAssetBase ?? config.assetBase;
const assetBase = officeAssetBase;
const STYLES = ['./office.css', './editor.css', './page.css', './setup-characters.css'].map((p) => new URL(p + buildQuery, import.meta.url).href);

/** LabelRef → text; office keys MetaVM doesn't carry yet fall back to strings.js (`label.<key>`, FR and EN). */
export function L(ref) {
  if (ref == null) return '';
  if (typeof ref !== 'object') return String(ref);
  if (ref.key === 'custom') return String(ref.params?.text ?? '');
  if (has(ref.key) || tr(`label.${ref.key}`) === `label.${ref.key}`) return label(ref);
  return tr(`label.${ref.key}`, Object.fromEntries(Object.entries(ref.params ?? {}).map(([k, v]) => [k, v && typeof v === 'object' ? L(v) : v])));
}
/** « Travaille depuis 12 minutes. » for an active state with a known start; else the state's label. */
const forState = (o, now = Date.now()) => (o.presenceLabel ? `${o.presenceLabel}.` : o.stateSince && !['idle', 'offline'].includes(o.state) && STATES.includes(o.state)
  ? tr(`office.for.${o.state}`, { duration: duration(Math.max(0, now - o.stateSince)) }) : stateLabel(o.state));
const stateLabel = (st) => (has(`agentState.${st}`) ? t(`agentState.${st}`) : tr(`state.${st}`));

function useStyles() {
  useEffect(() => {
    for (const href of STYLES) {
      if (document.querySelector(`link[data-office="${href}"]`)) continue;
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.dataset.office = href;
      document.head.append(l);
    }
  }, []);
}

/** Re-render on a UI language switch (frontend's i18n.onLang, F6); a no-op before it exists. */
function useLang() {
  const [lang, set] = useState(locale());
  useEffect(() => (typeof i18n.onLang === 'function' ? i18n.onLang(() => set(locale())) : undefined), []);
  return lang;
}
const NO_STATUS = { get: () => null, subscribe: () => () => {} };

/** office-dev-22: the exchange log behind visits, updated once per OfficeVM and kept for the tab (sessionStorage). */
let visitTrack = (() => { try { return JSON.parse(sessionStorage.getItem('ao.visits') || '{}') || {}; } catch { return {}; } })();
let trackedVm = null;
function trackFor(vm, list, now) {
  if (vm !== trackedVm) {
    trackedVm = vm;
    visitTrack = trackTurns(visitTrack, list, now);
    try { sessionStorage.setItem('ao.visits', JSON.stringify(visitTrack)); } catch { /* storage blocked: memory only */ }
  }
  return visitTrack;
}
/**
 * office-dev-24: re-render when the visit plan changes by time alone (the person's turn ends, a visitor walks out).
 * Returns schedule(at): idempotent for the same time, so it can be called while rendering.
 */
function useReplan() {
  const [, setTick] = useState(0);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current?.id), []);
  return (at) => {
    if ((timer.current?.at ?? null) === (at ?? null)) return;
    clearTimeout(timer.current?.id);
    timer.current = at == null ? null : { at, id: setTimeout(() => { timer.current = null; setTick((n) => n + 1); }, Math.max(0, at - Date.now()) + 50) };
  };
}
/** office-dev-21: phones customize in the Boutique (the inline editor stacks badly there). */
const phone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches;
const openShop = (query = {}) => {
  const r = services.router;
  const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString();
  r.navigate(r.href('boutique') + (q ? '?' + q : ''));
};
// The LayoutVM source (GET + `layout` topic, the shipped fallback) and the layout API live in layout-source.js, shared
// with the Boutique (office-dev-21).
export function BureauPage({ match }) {
  useStyles();
  const lang = useLang();
  const office = useTopic('office', '/api/v2/views/office');
  const layout = useLayout();
  const status = useStore(services.stream?.status ?? NO_STATUS);
  const now = useNow(60_000);
  const selected = match.query.agent || null;
  const [editing, setEditing] = useState(false);
  const [feed, setFeed] = useState('journal');   // the Journal / File tabs below the office
  const replan = useReplan();
  // A language switch remounts the scene (its labels are set at mount), but never under an open editor's draft.
  const [stageLang, setStageLang] = useState(lang);
  useEffect(() => { if (!editing) setStageLang(lang); }, [lang, editing]);

  const failed = (office.data === undefined && office.error) || (layout.data === undefined && layout.error);
  if (failed || office.data === undefined || layout.data === undefined) {
    return html`<${BureauWaiting} failed=${!!failed} onRetry=${() => { office.retry(); layout.retry(); }} />`;
  }
  const vm = office.data;
  const lay = layout.data;
  const occupants = vm.occupants;
  const seen = seenOccupants(vm, lay, now, config.apiVersion);
  // office-dev-22: the people the agent talks with are visitors: no desk of their own (they stand, or come to the agent).
  // office-dev-24: what a visitor shows follows the exchange (visits.js phaseOf): their own state while their message is
  // the latest; « attend une réponse » while the agent's reply run is active (the conversation's run spans the whole job,
  // sub-agents included, so the server keeps the person 'working' until it ends); idle and present for LINGER_MS once
  // it is over; then off the stage (they walk out), still listed as seen.
  const t0 = Date.now();
  const track = trackFor(vm, [...occupants, ...seen], t0);
  const asVisitor = (o) => {
    if (!isVisitor(o)) return o;
    const phase = phaseOf(o, track[o.id], t0);
    if (phase === 'agent') return { ...o, stationUid: null, state: 'waiting' };
    if (phase === 'linger') return { ...o, stationUid: null, presence: undefined, presenceLabel: undefined, state: 'idle' };
    return { ...o, stationUid: null, gone: phase == null };
  };
  const base = (seen.length ? [...occupants, ...seen] : occupants).map(asVisitor);
  const present = [...base, ...lingering(track, base, t0)];
  const visits = planVisits(present, track, t0);
  replan(visits.until);
  // O9: agents without a desk in the office (overflow) go to annex rooms below it (auto layout, same rules and looks);
  // visitors stay in the office (they have no desk by design).
  const plan0 = planAnnexes(indexOf(lay.manifest), lay.layout.data, present.filter((o) => !isVisitor(o)));
  const plan = { ...plan0, office: [...plan0.office, ...present.filter((o) => isVisitor(o) && !o.gone)] };
  const sel = present.find((o) => o.id === selected) || null;
  const select = (id) => services.router.setQuery({ agent: id });
  // The SSE stream is retrying or offline (R27-02, frontend's streamUnconfirmed): what is on screen is the last snapshot
  // received (guide §2, stale); the scene freezes (dimmed, paused) with « Hors ligne depuis X ».
  // Freshness (explorer-qa-02 Q02-01): the stream is reconnecting, or the server marks a source stale (the topic's
  // envelope meta, when the stream exposes it). A disconnected gateway is handled by the headline itself.
  const down = streamUnconfirmed(status);
  const stale = down ? { stale: ['stream'], generatedAt: status.lastFrameAt ?? office.meta?.generatedAt ?? null }
    : office.meta?.stale?.length ? { stale: office.meta.stale, generatedAt: office.meta.generatedAt ?? null } : null;
  const head = headline({ ...vm, occupants: named(vm.occupants) }, { primaryName: primaryName(), now, locale: lang, meta: stale, time: fmt.time, date: (ms) => fmt.dateTime(ms, now) });
  const unconfirmed = !!head.stale;
  const downSince = down ? stale.generatedAt : null;   // the chip's « depuis » (the last frame received)
  // Layout writes are Store-class commands (api.md §5.0): on a read-only instance the editor and the theme toggle
  // are not offered (explorer-qa-03 Q03-O02); zoom, selection and reading stay. Same when only the shipped layout exists.
  const caps = (status && status.capabilities) || (services.meta && services.meta.capabilities) || null;
  const canWrite = !lay.readOnly && !(caps && caps.storeWrites === false);

  // office-dev-18 (Owner, after go-live): the original Bureau (O3–O5) on today's data. KPI strip and the office theme
  // on top; the framed stage (and its annexes) with the agent cards beside it; Journal / File below. The headline stays
  // as the page's status sentence for assistive technology (and the stale/error kind), not as a visible title.
  return html`<div class=${'bu-page ao-bureau' + (editing ? ' ao-bureau--editing' : '') + (unconfirmed ? ' ao-bureau--last' : '')} lang=${lang}>
    <h2 class="bu-sr-only ao-bureau__lead" id="ao-bureau-lead" data-kind=${head.kind}>${[head.lead, ...head.deck].join(' ')}</h2>
    ${vm.connection.gateway === 'down' ? html`<div class="bu-banner bu-banner--warning" role="status"><${Icon} name="wifi-off" />
      <span class="bu-banner__text">${tr('office.gatewayDown')}${vm.connection.since ? html` <${Ago} at=${vm.connection.since} />` : null}</span></div>` : null}
    <div class="ao-bureau__top">
      <${Kpis} kpis=${vm.kpis ?? []} />
      ${editing ? null : canWrite ? html`<${ThemeToggle} lay=${lay} />`
        : html`<p class="ao-bureau__ro" id="ao-bureau-ro">${tr(lay.readOnly ? 'office.readonlyLayout' : 'office.readonly')}</p>`}
    </div>
    <div class="ao-bureau__editbar" id="ao-bureau-editbar"></div>
    <div class="ao-bureau__main">
      <div class="ao-bureau__stagecol">
        <div class="ao-bureau__stagewrap">
          <${Stage} key=${stageLang + (canWrite ? '' : ':ro')} vm=${vm} occupants=${editing ? present : plan.office} lay=${lay} selected=${selected} onSelect=${select} visits=${visits} editing=${editing} setEditing=${setEditing} unconfirmed=${unconfirmed} down=${down} downSince=${downSince} now=${now} canWrite=${canWrite} />
        </div>
        ${editing || !plan.annexes.length ? null : html`<div class="ao-bureau__annexes">
          ${plan.annexes.map((a) => html`<${Annex} signals=${vm.journal} key=${a.id + ':' + stageLang} annex=${a} lay=${lay} selected=${selected} onSelect=${select} unconfirmed=${unconfirmed} />`)}
        </div>`}
      </div>
      <aside class="ao-bureau__side" aria-label=${editing ? tr('office.customize') : tr('office.rosterLabel')}>
        <div id="ao-bureau-editaside" hidden=${!editing}></div>
        ${editing ? null : html`<${Roster} occupants=${rosterOf(present, plan)} selected=${selected} onSelect=${select} now=${now} unconfirmed=${unconfirmed} manifest=${lay.manifest} />`}
      </aside>
    </div>
    ${editing ? null : html`<${Feed} vm=${vm} stale=${stale} tab=${feed} setTab=${setFeed} />`}
    ${sel && !editing ? html`<${Drawer} o=${sel} lay=${lay} onClose=${() => select(null)} onCustomize=${canWrite ? () => (phone() ? openShop({ onglet: 'personnages', agent: sel.id }) : setEditing({ agent: sel.id })) : null} />` : null}
  </div>`;
}

/** No usable snapshot yet: the loading sentence, or the unavailable one with a retry (never zero counts). */
function BureauWaiting({ failed, onRetry }) {
  const head = headline(undefined, { error: failed, locale: locale() });
  if (failed) return html`<div class="bu-page ao-bureau">
    <div class="bu-banner bu-banner--warning ao-bureau__lead" role="alert" data-kind=${head.kind}><${Icon} name="warning" />
      <span class="bu-banner__text">${head.lead}</span>
      <button type="button" class="bu-btn bu-btn--sm" onClick=${onRetry}>${tr('office.retry')}</button></div>
  </div>`;
  return html`<div class="bu-page ao-bureau" aria-busy="true">
    <h2 class="bu-sr-only ao-bureau__lead" data-kind=${head.kind}>${head.lead}</h2>
    <div class="bu-kpis ao-bureau__kpis">${Array.from({ length: 6 }, (_, k) => html`<div key=${k} class="bu-kpi"><${Skeleton} style="width:6rem" /><${Skeleton} kind="title" style="width:3rem" /></div>`)}</div>
    <div class="ao-bureau__main"><div class="ao-bureau__stagecol"><div class="ao-bureau__stagewrap"><div class="bu-stage ao-bureau__stage"><${Skeleton} style="width:100%;height:100%" /></div></div></div>
      <div class="ao-bureau__side">${Array.from({ length: 3 }, (_, k) => html`<div key=${k} class="bu-roster"><${Skeleton} style="width:60%" /></div>`)}</div></div>
  </div>`;
}

/** The KPI strip (OfficeVM.kpis): label, value, optional sub-line; values formatted for the UI's locale. */
function kpiValue(k) {
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

/** Journal / File below the office: the recent activity, or the next scheduled tasks; the snapshot's freshness. */
function Feed({ vm, stale, tab, setTab }) {
  const up = vm.connection.gateway !== 'down';
  const fresh = stale ? tr('office.updatedAt', { time: fmt.time(stale.generatedAt) })
    : up && vm.connection.since ? tr('office.connectedSince', { time: fmt.dateTime(vm.connection.since) }) : null;
  return html`<section class="bu-section ao-bureau__feed" aria-labelledby="ao-bureau-feed">
    <div class="ao-bureau__feedhead">
      <h2 class="bu-eyebrow" id="ao-bureau-feed">${tr(tab === 'journal' ? 'office.feed.journal' : 'office.feed.queue')}</h2>
      ${fresh ? html`<span class="bu-text-tertiary ao-bureau__fresh">${fresh}</span>` : null}
      <div class="bu-segmented ao-bureau__tabs" role="group" aria-label=${tr('office.feed.show')}>
        <button type="button" class="bu-segmented__opt" aria-pressed=${String(tab === 'journal')} onClick=${() => setTab('journal')}>${tr('office.feed.journal')}</button>
        <button type="button" class="bu-segmented__opt" aria-pressed=${String(tab === 'file')} onClick=${() => setTab('file')}>${tr('office.feed.queue')} <span class="bu-count">${vm.queue.length}</span></button>
      </div>
    </div>
    ${tab === 'journal' ? html`<${Journal} items=${vm.journal} />` : html`<${Queue} items=${vm.queue} />`}
  </section>`;
}

function Queue({ items }) {
  if (!items.length) return html`<p class="bu-text-secondary">${tr('office.queueEmpty')}</p>`;
  return html`<ol class="bu-journal" aria-label=${tr('office.queueLabel')}>${items.map((q) => html`<li key=${q.id} class="bu-event ao-bureau__queue">
    <span class="bu-event__who"><${Icon} name="flux" />${q.name}</span><span class="bu-event__text">${L(q.schedule)}</span></li>`)}</ol>`;
}

/** Office theme quick toggle: the layout owns the theme (api-proposal §4). One automatic retry on 409. */
function ThemeToggle({ lay }) {
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
    const send = (rev, base) => officeApi().putTheme({ expectedRevision: rev, theme: apply(base) });
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
    <${SurpriseSetting} />
    <span class="ao-bureau__themelabel" id="ao-theme-label">${tr('office.margin.theme')}</span>
    <div class="bu-segmented" role="group" aria-labelledby="ao-theme-label" aria-busy=${busy ? 'true' : undefined}>
      ${opts.map(([id, text]) => html`<button type="button" class="bu-segmented__opt" aria-pressed=${String(mode === id)} disabled=${busy} onClick=${() => set(id)}>${text}</button>`)}
    </div>
    ${mode === 'auto' ? html`<p class="ao-bureau__themenow">${tr(lay.theme.resolved === 'night' ? 'office.themeNow.night' : 'office.themeNow.day')}</p>` : null}
  </div>`;
}

/** The scene: one OfficeScene per mount, fed from the VMs; cues from SSE `cue` frames. */
function Stage({ vm, occupants, lay, selected, onSelect, visits, editing, setEditing, unconfirmed, down, downSince, now, canWrite }) {
  const latestOcc = useRef(occupants);
  latestOcc.current = occupants;
  const host = useRef(null);
  const sceneRef = useRef(null);
  const editorRef = useRef(null);
  const latest = useRef(vm);
  latest.current = vm;
  const latestLay = useRef(lay);
  latestLay.current = lay;

  // Mount once the layout is known.
  useEffect(() => {
    const labels = Object.fromEntries(STATES.map((s) => [s, stateLabel(s)]));
    const scene = new OfficeScene(host.current, {
      manifest: lay.manifest, layout: lay.layout.data, assetBase: assetBase(), labels,
      theme: lay.theme.resolved, onSelect: (id) => onSelect(id), primaryName: () => primaryName(), timeZone: () => fmtTz.timeZone(),
    });
    sceneRef.current = scene;
    host.current.aoScene = scene;   // test/QA handle (DevTools, DOM tests): the stage element carries its scene
    // office-dev-21: on a phone Personnaliser opens the Boutique (catalog + full-screen placement); on desktop the editor.
    if (canWrite) scene.addControl({ label: tr('office.customize'), text: true, icon: '<path d="M12 20h9"/><path d="M16.38 3.62a1 1 0 0 1 3 3L7.37 18.64a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z"/>', onClick: () => (phone() ? openShop() : setEditing(true)) });
    // SSE cue frames (app.js forwards them to services.cueListeners).
    const listeners = (services.cueListeners ??= new Set());
    const onCue = (f) => (f.signal ? sceneRef.current?.signal(f.occupantId, f.signal) : sceneRef.current?.cue(f.occupantId, f.cue, { partnerId: f.partnerId ?? null, interactionId: f.interactionId ?? null }));
    listeners.add(onCue);
    return () => { listeners.delete(onCue); editorRef.current?.close?.({ saved: false }); scene.destroy(); sceneRef.current = null; };
  }, []);

  // Layout changes (another device saved, theme switch at nextChangeAt).
  useEffect(() => {
    const s = sceneRef.current;
    if (!s || editorRef.current) return;
    s.setLayout(lay.layout.data);
    s.setTheme(lay.theme.resolved);
  }, [lay.layout.revision, lay.theme.resolved]);

  // Occupants: the same list as the roster and the drawer.
  useEffect(() => {
    if (!sceneRef.current || editorRef.current) return;
    sceneRef.current.setOccupants(named(occupants));
  }, [occupantsKey(occupants)]);

  useEffect(() => { sceneRef.current?.setSignals(vm.journal); }, [vm.journal]);
  useEffect(() => { sceneRef.current?.select(selected); }, [selected, vm.occupants]);
  // office-dev-22: visitors come to the agent (desk, or the meeting table for a real conversation).
  const visitsKey = JSON.stringify(visits ?? null);
  useEffect(() => { sceneRef.current?.setVisits(editing ? null : visits); }, [visitsKey, editing]);

  // Editor (S14c): opened from the stage control or the drawer.
  useEffect(() => {
    if (!editing || editorRef.current || !sceneRef.current) return;
    let alive = true;
    // The editor (and its panels) loads on first use: it isn't part of the Bureau's first load (F11 budget).
    import('./editor.js' + buildQuery).then(({ openEditor }) => openEditor({
      scene: sceneRef.current, store: officeApi(), assetBase: assetBase(), primaryName: primaryName(), timeZone: fmtTz.timeZone(),
      barHost: document.getElementById('ao-bureau-editbar'), asideHost: document.getElementById('ao-bureau-editaside'),
      getOccupants: () => latest.current.occupants.map((o) => ({ id: o.id, role: o.role, sourceName: o.sourceName ?? o.name, state: o.state, stateSince: o.stateSince })),
      toast: (message, level) => toast({ level, message }),
      onOpenShop: () => openShop(),
      onExit: (result) => {
        editorRef.current = null;
        const s = sceneRef.current;
        if (s) {
          // R8-10: the scene shows the authoritative layout again: the saved VM, else the latest subscribed one
          // (an unsaved exit must drop the preview).
          const L = (result?.saved && result.vm) || latestLay.current;
          s.setLayout(L.layout.data);
          s.setTheme(L.theme.resolved);
          // O6: a saved look shows at once: the occupants are re-resolved against the saved layout with the shared
          // resolver (the server's OfficeVM uses the same one and confirms it on its next push).
          s.setOccupants(named(result?.saved ? withLayout(latestOcc.current, L) : latestOcc.current));
        }
        setEditing(false);
      },
    })).then((ed) => {
      if (!alive) { ed.close({ saved: false }); return; }
      editorRef.current = ed;
      if (editing.agent) { ed.agentSel = editing.agent; ed.setMode('characters'); }
    }, (err) => {
      // R8-11: loading failed (network, 401/403, 503…): back to browsing, say why; the control stays available.
      editorRef.current = null;
      sceneRef.current?.setEditing(false);
      if (alive) {
        setEditing(false);
        if (err && err.code === 'unauthorized') return;   // the app's auth flow takes over
        api.toastError(err instanceof api.ApiError ? err : new api.ApiError({ message: tr('office.openFailed') }));
      }
    });
    return () => { alive = false; };
  }, [editing]);

  // R27-02: not live, the scene freezes (no walks, frame loops or CSS animation) until the stream confirms again.
  useEffect(() => { sceneRef.current?.setFrozen(unconfirmed); }, [unconfirmed]);

  // An unconfirmed state keeps the scene, dimmed and labelled as the last observation (explorer-qa-02 Q02-01). With the
  // stream down, the chip says for how long: « Hors ligne depuis 3 minutes ».
  const cap = down && downSince ? tr('office.offlineSince', { duration: duration(Math.max(0, now - downSince)) }) : down ? tr('office.offline') : tr('office.stageCaption');
  return html`<div class=${'bu-stage ao-bureau__stage' + (unconfirmed ? ' ao-bureau__stage--last' : '')} ref=${host} role="region"
      aria-label=${tr(unconfirmed ? 'office.stageLast' : 'office.stage', { agent: agentName() })}></div>
    ${unconfirmed ? html`<p class=${'ao-bureau__stagecap' + (down ? ' ao-bureau__stagecap--offline' : '')}>${cap}</p>` : null}`;
}

/** Portrait from the manifest (variant, then character); until sub-agent portraits exist, a head crop of the look's idle pose. */
function Avatar({ o, manifest }) {
  const ch = manifest?.characters.find((c) => c.id === o.look.character);
  const v = ch?.variants?.find((x) => x.id === o.look.variant);
  const portrait = v?.portrait ?? (v ? null : ch?.portrait);
  const pose = !portrait && (v?.poses?.idle ?? ch?.poses?.idle);
  const path = portrait ?? (typeof pose === 'string' ? pose : pose?.image);
  // Head crop from the idle pose's landmarks: the head box fills ~85 % of the avatar.
  let crop = null;
  const hb = !portrait && (v?.landmarks?.idle ?? ch?.landmarks?.idle)?.headBox;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  if (hb && ch && [hb.x, hb.y, hb.w, hb.h, ch.canvas.w].every((v) => Number.isFinite(n(v)))) {
    // Numbers only reach CSS (style object, never a string built from server data).
    const k = 85 / Math.max(n(hb.w), n(hb.h));
    crop = { width: `${(n(ch.canvas.w) * k).toFixed(1)}%`, left: `${(50 - (n(hb.x) + n(hb.w) / 2) * k).toFixed(1)}%`, top: `${(50 - (n(hb.y) + n(hb.h) / 2) * k).toFixed(1)}%` };
  }
  return html`<span class="bu-avatar bu-avatar--agent" data-agent-state=${o.state}>
    ${path ? html`<img src=${resolveUrl(path, assetBase())} alt="" class=${portrait ? '' : 'ao-avatar-pose'} style=${crop} />` : html`<${Icon} name="agent" />`}</span>`;
}

/** « Les présences » (the button's accessible name is its visible text: name, role, state; the number is hidden, so
 * label and content never diverge, WCAG 2.5.3; frontend-16's axe finding). The agents present as a numbered margin list (the number is the stable roster position, never a
 * rank; decorative, hidden from screen readers). Name, then the state as a line of text; colour never carries it alone. */
/** O10: past this many agents the roster is grouped by state (errors open, the rest collapsed). */
export const ROSTER_GROUP_OVER = 12;
const ROSTER_GROUPS = [
  { id: 'error', open: true, has: (o) => !o.presence && o.state === 'error' },
  { id: 'waiting', has: (o) => !o.presence && o.state === 'waiting' },
  { id: 'active', has: (o) => !o.presence && !['error', 'waiting', 'idle', 'offline'].includes(o.state) },
  { id: 'inactive', has: () => true },
];

function Roster({ occupants, selected, onSelect, now, unconfirmed, manifest }) {
  const [eggs,setEggs]=useState({});
  useEffect(()=>{const update=e=>setEggs(prev=>({...prev,[e.detail.id]:e.detail.kind}));document.addEventListener('office-surprise',update);return ()=>document.removeEventListener('office-surprise',update);},[]);
  // The reader's own open/closed choices per group win over the defaults (errors open; a group holding the selection).
  const [toggled, setToggled] = useState({});
  // An agent card (O3): portrait in its state ring, name, role, and the state pill. Its accessible name is its visible
  // text (WCAG 2.5.3). A seen agent is muted, with « Vu il y a … »; unconfirmed, the pill is the last state, not live.
  const card = (o) => html`<li key=${o.id}>
    <button type="button" class=${'bu-roster ao-roster ao-agentcard' + (o.presence ? ' is-seen' : '')} data-presence=${o.presence || undefined}
      aria-current=${selected === o.id ? 'true' : undefined} onClick=${() => onSelect(o.id)}>
      <${Avatar} o=${o} manifest=${manifest} />
      <span class="bu-cell-main"><span class="ao-roster__name ao-agentcard__name">${nameOf(o)}</span>
        <span class="bu-cell-sub">${L(o.roleLabel)}${o.stationUid || isVisitor(o) ? '' : ` · ${tr('office.noStation')}`}</span>
        ${o.presence ? html`<span class="ao-agentcard__seen">${o.presenceLabel}</span>` : null}</span>
      ${eggs[o.id] && !unconfirmed ? html`<span class="bu-state" data-surprise-status=${eggs[o.id]}>${tr('egg.'+eggs[o.id])}</span>` : html`<${StateChip} state=${o.state} live=${!unconfirmed && !o.presence} title=${unconfirmed ? tr('office.lastState', { state: stateLabel(o.state) }) : forState(o, now)} />`}
    </button></li>`;
  if (!occupants.length) return html`<p class="bu-text-secondary">${tr('office.empty')}</p>`;
  if (occupants.length <= ROSTER_GROUP_OVER) return html`<ul class="ao-bureau__roster">${occupants.map(card)}</ul>`;
  // O10, past 12 agents: grouped by state; each agent in the first group it fits, roster order kept inside a group.
  const left = new Set(occupants);
  const groups = ROSTER_GROUPS.map((g) => { const list = [...left].filter(g.has); list.forEach((o) => left.delete(o)); return { ...g, list }; }).filter((g) => g.list.length);
  return html`<div class="ao-roster-groups">${groups.map((g) => {
    const open = toggled[g.id] ?? (!!g.open || g.list.some((o) => o.id === selected));
    return html`<details key=${g.id} class=${'ao-roster-group ao-roster-group--' + g.id} data-group=${g.id} open=${open}
        onToggle=${(e) => { const v = e.currentTarget.open; if (v !== open) setToggled((s) => ({ ...s, [g.id]: v })); }}>
      <summary class="ao-roster-group__head">
        <span class="ao-roster-group__label">${tr('office.group.' + g.id)}</span>
        <span class="ao-roster-group__count" aria-hidden="true">${g.list.length}</span>
        <span class="bu-sr-only">${tr('office.group.agents', { n: g.list.length })}</span>
      </summary>
      <ul class="ao-bureau__roster">${g.list.map(card)}</ul>
    </details>`;
  })}</div>`;
}

/** The state pill (O3): icon and label, the state's colour; « live » pulses only while confirmed and active. */
function StateChip({ state, live = true, title }) {
  const on = live && !['idle', 'offline'].includes(state);
  return html`<span class=${'bu-state ao-roster__state' + (on ? ' bu-state--live ao-roster__state--live' : '')} data-agent-state=${state} title=${title || undefined}>
    <${Icon} name=${'state-' + (STATES.includes(state) ? state : 'idle')} />${stateLabel(state)}</span>`;
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

function Drawer({ o, lay, onClose, onCustomize }) {
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
        <div style="flex:1"><h2 class="bu-modal__title" id="ao-drawer-title">${nameOf(o)}</h2><p class="bu-modal__desc" id="ao-drawer-desc">${tr('office.drawer.desc', { role: L(o.roleLabel), state: stateLabel(o.state).toLocaleLowerCase(locale() === 'en' ? 'en-CA' : 'fr-CA') })}</p></div>
        <button type="button" class="bu-btn bu-btn--icon bu-btn--ghost" aria-label=${tr('office.close')} ref=${closeRef} onClick=${onClose}><${Icon} name="close" /></button>
      </div>
      <div class="bu-modal__body">
        <p class="ao-drawer__state" data-agent-state=${o.state}>${o.stateSince && STATES.includes(o.state) ? tr(`office.for.${o.state}`, { duration: duration(Math.max(0, Date.now() - o.stateSince)) }) : stateLabel(o.state)}</p>
        <dl class="bu-kv">
          <div class="bu-kv__row"><dt>${tr('office.drawer.lastSeen')}</dt><dd>${o.lastSeenAt ? html`<${Ago} at=${o.lastSeenAt} />` : '—'}</dd></div>
          <div class="bu-kv__row"><dt>${tr('office.drawer.tokens')}</dt><dd>${fmt.number(o.tokens)}</dd></div>
          <div class="bu-kv__row"><dt>${tr('office.drawer.station')}</dt><dd>${stationText(o, lay)}</dd></div>
          <div class="bu-kv__row"><dt>${tr('office.drawer.session')}</dt><dd class="bu-mono">${o.sessionKey ?? '—'}</dd></div>
        </dl>
      </div>
      <div class="bu-modal__footer">
        ${onCustomize ? html`<button type="button" class="bu-btn bu-btn--ghost" onClick=${onCustomize}><${Icon} name="pencil" />${tr('office.customize')}</button>` : null}
        ${sessionHref ? html`<a class="bu-btn bu-btn--primary" href=${sessionHref}>${tr('office.openSession')}</a>` : null}
      </div>
    </aside>
  </div>`;
}
