// UI entry point: boot (meta → auth → stream), routing, shell. Business state lives on the server.
import { html, render, useState, useEffect } from './lib.js';
import { SPRITE } from './icons.js';
import { createRouter, safeReturn, inApp, parse } from './router.js';
import { createStream } from './stream.js';
import * as api from './api.js';
import { apiUrl, config, versioned, buildQuery } from './config.js';
import { setMeta, label, onLang, msg, getLang } from './i18n.js';
import { initLang } from './lang.js';
import * as vmcheck from './vmcheck.js';
import { setTimeZone } from './fmt.js';
import { services } from './services.js';
import { useStore } from './hooks.js';
import { toast } from './toast.js';
import { createBuildUpdate } from './build-update.js';
import { applyTheme, theme } from './theme.js';
import { Shell, MockBadge } from './components/shell.js';
import { Toasts, ErrorState } from './components/ui.js';
import { ShortcutsDialog, shortcutsSheet, installShortcutKey } from './components/shortcuts.js';
import { LoginPage } from './pages/login.js';
import { PlaceholderPage, NotFoundPage, MorePage } from './pages/placeholder.js';

initLang();
document.body.insertAdjacentHTML('afterbegin', SPRITE);
applyTheme(theme.get().pref);

const release = createBuildUpdate({ notify: (run) => toast({
  message: msg('release.available'), action: { label: msg('release.reload'), run }, duration: 0,
}) });
release.start();
const router = createRouter(window, { beforeNavigate: release.beforeNavigate });
services.router = router;
services.officeAssetBase = config.assetBase;   // office/page.js until it imports config.js itself

const TOAST_LEVEL = { info: 'info', success: 'success', error: 'danger' };

async function makeStream(meta) {
  const mock = api.isMock() ? await api.mock() : null;
  return createStream({
    openSource: (url) => (mock ? new mock.MockEventSource(versioned(url)) : new EventSource(apiUrl(url), { withCredentials: true })),
    fetchVM: async (url) => { const r = await api.get(url, { quiet: true }); return { data: r.data, topic: (r.meta && r.meta.topic) || null, meta: r.meta || null }; },
    postTopics: (id, body) => api.post(`/api/v2/stream/${encodeURIComponent(id)}/topics`, body, { quiet: true }).then((r) => (r && r.data && Array.isArray(r.data.topics) ? r.data.topics : null)),
    checkAuth: async () => { try { return (await api.me()) ? 'ok' : 'unauthorized'; } catch { return 'unknown'; } },
    onUnauthorized: () => api.notifyUnauthorized(),
    postResync: (id, topic) => api.post(`/api/v2/stream/${encodeURIComponent(id)}/resync`, { topic }, { quiet: true }),
    onToast: (f) => toast({ level: TOAST_LEVEL[f.level] || 'info', message: label(f.message) }),
    // Office one-shot cues (api.md §4.4): the Bureau page registers in services.cueListeners (office-dev-03 §5).
    onBuild: () => { void release.check(); },
    onCue: (f) => { for (const fn of services.cueListeners ?? []) fn(f); },
    check: (topic, data, where) => vmcheck.check(vmcheck.schemaForTopic(topic), data, where),
    modelVersion: meta.modelVersion,
    contractVersion: meta.contractVersion || null,
  });
}

// F11: every page is its own chunk, imported when its route is shown. route-preload.js (generated with the table of
// each route's modules) preloads the current URL's chunk while the core loads, and the shell preloads a route on
// navigation intent, so a page never arrives as an import waterfall. One entry per line: scripts/first-load.js reads them.
const PAGES = {
  'bureau-animations': () => import('./office/animations.js' + buildQuery).then((m) => m.AnimationsPage),
  bureau: () => import('./office/page.js' + buildQuery).then((m) => m.BureauPage),
  boutique: () => import('./office/boutique.js' + buildQuery).then((m) => m.BoutiquePage),
  discuter: () => import('./pages/chat.js' + buildQuery).then((m) => m.ChatPage),
  flux: () => import('./pages/flows.js' + buildQuery).then((m) => m.FlowsPage),
  'flux-detail': () => import('./pages/flow.js' + buildQuery).then((m) => m.FlowPage),
  projets: () => import('./pages/projects.js' + buildQuery).then((m) => m.ProjectsPage),
  projet: () => import('./pages/project.js' + buildQuery).then((m) => m.ProjectPage),
  importer: () => import('./pages/import.js' + buildQuery).then((m) => m.ImportPage),
  habilitations: () => import('./pages/access.js' + buildQuery).then((m) => m.AccessPage),
  interlocuteur: () => import('./pages/interlocutor.js' + buildQuery).then((m) => m.InterlocutorPage),
  journaux: () => import('./pages/journaux.js' + buildQuery).then((m) => m.JournauxPage),
  session: () => import('./pages/session.js' + buildQuery).then((m) => m.SessionPage),
  competences: () => import('./pages/skills.js' + buildQuery).then((m) => m.SkillsPage),
  competence: () => import('./pages/skill.js' + buildQuery).then((m) => m.SkillPage),
  sante: () => import('./pages/health.js' + buildQuery).then((m) => m.HealthPage),
  setup: () => import('./pages/setup.js' + buildQuery).then(async (m) => { await m.loadStyles(); return m.SetupPage; }),
  'a-propos': () => import('./pages/about.js' + buildQuery).then((m) => m.AboutPage),
};
const pageLoads = new Map();   // name → Promise<Component>
const pageReady = new Map();   // name → Component (no loading flash once a page has been shown)
/** Preloads a route's modules (route-preload.js table); safe to call often (hover, focus, touch). */
export const preloadRoute = async (name) => {
  if (await release.check()) return;
  try { globalThis.AO_ROUTES?.preload(name); } catch { /* best effort */ }
};
services.preloadRoute = preloadRoute;
installShortcutKey();   // F13: « ? » opens the keyboard shortcuts sheet
function ShortcutsHost() {
  const { open } = useStore(shortcutsSheet);
  return open ? html`<${ShortcutsDialog} onClose=${() => shortcutsSheet.set({ open: false })} />` : null;
}
// Navigation intent: hovering, focusing or touching an in-app link preloads its page's modules (all links: the
// sidebar, the bottom bar, « Plus », and links inside pages), so the click finds the chunk ready.
for (const type of ['pointerover', 'focusin', 'touchstart']) {
  document.addEventListener(type, (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || !inApp(url.pathname)) return;
    const name = parse(url.pathname, url.search).name;
    if (PAGES[name]) preloadRoute(name);
  }, { passive: true, capture: true });
}
function loadPage(name) {
  if (!pageLoads.has(name)) {
    pageLoads.set(name, release.check().then((stale) => {
      if (stale) { location.reload(); return new Promise(() => {}); }
      globalThis.AO_ROUTES?.preload(name);
      return PAGES[name]();
    }).catch(async (err) => {
      // A release can land between the check and the request (old assets return 410).
      if (await release.check()) { location.reload(); return new Promise(() => {}); }
      throw err;
    }).then((C) => { pageReady.set(name, C); return C; }, (err) => { pageLoads.delete(name); throw err; }));
  }
  return pageLoads.get(name);
}
/** A lazy page: a quiet skeleton while its chunk loads, a retry if it can't (offline, or a deploy replaced it). */
function LazyPage({ name, ...props }) {
  const [, setTick] = useState(0);
  const [error, setError] = useState(null);
  const C = pageReady.get(name);
  useEffect(() => {
    if (pageReady.has(name)) return;
    let live = true;
    setError(null);
    loadPage(name).then(() => live && setTick((n) => n + 1), (err) => live && setError(err));
    return () => { live = false; };
  }, [name]);
  if (C) return html`<${C} ...${props} />`;
  if (error) return html`<div class="bu-page"><${ErrorState} error=${{ code: 'network', message: msg('apiError.network') }} onRetry=${() => { setError(null); loadPage(name).then(() => setTick((n) => n + 1), setError); }} /></div>`;
  return html`<div class="bu-page" aria-busy="true"><p class="bu-sr-only" role="status">${msg('common.loading')}</p></div>`;
}

function Page({ match, onLogout }) {
  if (match.name === 'introuvable') return html`<${NotFoundPage} />`;
  if (match.name === 'plus') return html`<${MorePage} onLogout=${onLogout} />`;
  return PAGES[match.name] ? html`<${LazyPage} key=${match.name + ':' + JSON.stringify(match.params)} name=${match.name} match=${match} />` : html`<${PlaceholderPage} match=${match} />`;
}

function App() {
  const [match, setMatch] = useState(router.current);
  const [boot, setBoot] = useState({ phase: 'loading', me: null, error: null });
  const status = useStore(services.stream.status);
  const [, setLangTick] = useState(0);
  useEffect(() => onLang((l) => setLangTick(l)), []);   // a language switch re-renders everything in place

  useEffect(() => router.subscribe(setMatch), []);

  async function checkAuth() {
    try {
      const me = await api.me();
      services.me = me;
      setBoot({ phase: me ? 'in' : 'out', me, error: null });
      if (me) services.stream.start(); else services.stream.stop();
    } catch (error) {
      setBoot({ phase: 'error', me: null, error });
    }
  }
  useEffect(() => { checkAuth(); return api.onUnauthorized(() => { services.stream.stop(); setBoot({ phase: 'out', me: null, error: null }); }); }, []);

  // Route guard: logged out → <base>/connexion?suite=<where we were>; logged in on /connexion → back.
  useEffect(() => {
    if (boot.phase === 'out' && match.name !== 'connexion') {
      router.navigate(router.href('connexion', {}, { suite: location.pathname + location.search }), { replace: true });
    } else if (boot.phase === 'in' && match.name === 'connexion') {
      const next = safeReturn(match.query.suite) || router.href('bureau');
      router.navigate(next, { replace: true });
    }
  }, [boot.phase, match.name]);

  useEffect(() => {
    const r = match.route && (match.route.parent ? null : match.route);
    document.title = (match.name === 'connexion' ? msg('nav.connexion') : r ? r.label : 'Agent Office') + ' · Agent Office';
  }, [match.name, getLang()]);

  // R4-11: only a successful response logs out; otherwise the cookie may still be valid, so say so and stay.
  async function onLogout() {
    try {
      await api.logout();
    } catch (err) {
      if (err && err.code === 'unauthorized') { services.stream.stop(); setBoot({ phase: 'out', me: null, error: null }); return; }
      toast({ level: 'danger', message: msg('shell.logoutFailed'), code: err && err.code ? err.code.toUpperCase() : null,
        action: { label: msg('common.retry'), run: onLogout } });
      return;
    }
    services.stream.stop();
    setBoot({ phase: 'out', me: null, error: null });
  }

  let body;
  if (boot.phase === 'loading') body = html`<div class="ao-boot" aria-busy="true"><span class="bu-spinner" aria-label=${msg('common.loading')}></span></div>`;
  else if (boot.phase === 'error') body = html`<div class="ao-boot"><${ErrorState} error=${boot.error} onRetry=${checkAuth} /></div>`;
  else if (boot.phase === 'out' || match.name === 'connexion') body = html`<${LoginPage} onLoggedIn=${checkAuth} />`;
  else body = html`<${Shell} match=${match} me=${boot.me} status=${status} onLogout=${onLogout}><${Page} match=${match} onLogout=${onLogout} /></${Shell}>`;

  // Inside the shell the badge sits in the top bars; elsewhere (login, boot) it floats top-right, away from any action.
  const inShell = boot.phase === 'in' && match.name !== 'connexion';
  return html`${body}${api.isMock() && !inShell ? html`<${MockBadge} floating />` : null}<${Toasts} /><${ShortcutsHost} />`;
}

function SetupRoot() {
  const [, setLangTick] = useState(0);
  useEffect(() => onLang((l) => setLangTick(l)), []);
  useEffect(() => { document.title = msg('setup.title') + ' · Agent Office'; });
  return html`<${LazyPage} name="setup" />${api.isMock() ? html`<${MockBadge} floating />` : null}<${Toasts} />`;
}

async function main() {
  const root = document.getElementById('app');
  try {
    const meta = await api.init();
    services.meta = meta;
    // Dev/test only (architect-23): validate every incoming VM against the server's schemas; never in production.
    if (meta.env !== 'production') { await vmcheck.enable(); vmcheck.check('meta', meta, 'GET /api/v2/meta'); }
    setMeta(meta);
    services.timeZone = setTimeZone(meta.instance && meta.instance.timeZone);   // R12-08 (office reads services.timeZone)
    // F8 (G4): an instance that isn't configured yet shows the first-run setup instead of the app: no login, no stream.
    if (meta.instance && meta.instance.configured === false) { render(html`<${SetupRoot} />`, root); return; }
    services.stream = await makeStream(meta);
    render(html`<${App} />`, root);
  } catch (error) {
    render(html`<div class="ao-boot"><${ErrorState} error=${error} onRetry=${() => location.reload()} /></div><${Toasts} />`, root);
  }
}

main();
