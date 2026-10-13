import { loadModule, configureChunkRecovery, reloadChunks, recoverChunk } from './build-update.js';
// UI entry point: boot (meta → auth → stream), routing, shell. Business state lives on the server.
import { html, render, useState, useEffect, useRef, useErrorBoundary } from './lib.js';
import { SPRITE } from './icons.js';
import { createRouter, safeReturn, inApp, parse } from './router.js';
import { createStream } from './stream.js';
import * as api from './api.js';
import { apiUrl, config, splitOrigin, versioned, buildQuery } from './config.js';
import { label, onLang, msg, getLang } from './i18n.js';
import { initLang, initMetadata, metadataAuth, refreshMetadata } from './lang.js';
import * as vmcheck from './vmcheck.js';
import { setTimeZone } from './fmt.js';
import { services } from './services.js';
import { useStore } from './hooks.js';
import { toast } from './toast.js';
import { createBuildUpdate } from './build-update.js';
import { applyTheme, theme } from './theme.js';
import { Shell, MockBadge } from './components/shell.js';
import { Frame, Toasts, ErrorState } from './components/ui.js';
import { ShortcutsDialog, shortcutsSheet, installShortcutKey } from './components/shortcuts.js';
import { PlaceholderPage, NotFoundPage, MorePage } from './pages/placeholder.js';

initLang();
document.body.insertAdjacentHTML('afterbegin', SPRITE);

applyTheme(theme.get().pref);

let navigationUrl = null;
const release = createBuildUpdate({ reload: url => { void reloadChunks({ url }); }, notify: () => toast({
  message: msg('release.available'), action: { label: msg('release.reload'), run: () => reloadChunks({ manual: true }) }, duration: 0,
}) });
configureChunkRecovery(() => release.check(), () => navigationUrl, () => toast({
  message: msg('release.recovery'), action: { label: msg('release.reload'), run: () => reloadChunks({ manual: true }) }, duration: 0,
}));
release.start();
globalThis.AO_ROUTES?.attach(api.prewarm);
const router = createRouter(window, { beforeNavigate: async url => {
  navigationUrl = url;
  if (!await release.beforeNavigate(url)) return false;
  for (const guard of services.navigationGuards || []) if (!await guard(url)) { navigationUrl = null; return false; }
  return true;
} });
router.subscribe(() => { navigationUrl = null; });
services.router = router;
services.officeAssetBase = config.assetBase;   // office/page.js until it imports config.js itself

const TOAST_LEVEL = { info: 'info', success: 'success', error: 'danger' };

async function makeStream(meta) {
  const mock = api.isMock() ? await api.mock() : null;
  const openSource = mock ? (url) => new mock.MockEventSource(versioned(url))
    : splitOrigin ? (await loadModule(() => import('./split-stream.js' + buildQuery))).openSource
    : (url) => new EventSource(apiUrl(url), {withCredentials:true});
  return createStream({
    openSource,
    fetchVM: async (url) => { const r = await api.get(url, { quiet: true }); return { data: r.data, topic: (r.meta && r.meta.topic) || null, meta: r.meta || null }; },
    postTopics: (id, body) => api.post(`/api/v2/stream/${encodeURIComponent(id)}/topics`, body, { quiet: true }).then((r) => (r && r.data && Array.isArray(r.data.topics) ? r.data.topics : null)),
    checkAuth: async () => { try { return (await api.me()) ? 'ok' : 'unauthorized'; } catch { return 'unknown'; } },
    onUnauthorized: () => api.notifyUnauthorized(),
    postResync: (id, topic) => api.post(`/api/v2/stream/${encodeURIComponent(id)}/resync`, { topic }, { quiet: true }),
    onToast: (f) => toast({ level: TOAST_LEVEL[f.level] || 'info', message: label(f.message) }),
    // Office one-shot cues (api.md §4.4): the Bureau page registers in services.cueListeners (office-dev-03 §5).
    onBuild: () => { void release.check(); },
    onCue: (f) => { for (const fn of services.cueListeners ?? []) fn(f); },
    onSettings: (f) => { void refreshMetadata().catch(() => {}); for (const fn of services.settingsListeners ?? []) fn(f); },
    check: (topic, data, where) => vmcheck.check(vmcheck.schemaForTopic(topic), data, where),
    modelVersion: meta.modelVersion,
    contractVersion: meta.contractVersion || null,
  });
}

// Lazy route chunks; scripts/first-load.js reads this map.
const PAGES = {
  connexion: () => loadModule(() => import('./pages/login.js' + buildQuery)).then((m) => m.LoginPage),
  'bureau-animations': () => loadModule(() => import('./office/animations.js' + buildQuery)).then((m) => m.AnimationsPage),
  bureau: () => loadModule(() => import('./office/page.js' + buildQuery)).then((m) => m.BureauPage),
  boutique: () => loadModule(() => import('./office/boutique.js' + buildQuery)).then(async (m) => { await m.loadStyles(); return m.BoutiquePage; }),
  discuter: () => loadModule(() => import('./pages/chat.js' + buildQuery)).then(async (m) => { await m.loadStyles(); return m.ChatPage; }),
  flux: () => loadModule(() => import('./pages/flows.js' + buildQuery)).then(async (m) => { await m.loadStyles(); return m.FlowsPage; }),
  'flux-detail': () => loadModule(() => import('./pages/flow.js' + buildQuery)).then((m) => m.FlowPage),
  projets: () => loadModule(() => import('./pages/projects.js' + buildQuery)).then(async (m) => { await m.loadStyles(); return m.ProjectsPage; }),
  projet: () => loadModule(() => import('./pages/project.js' + buildQuery)).then((m) => m.ProjectPage),
  importer: () => loadModule(() => import('./pages/import.js' + buildQuery)).then((m) => m.ImportPage),
  habilitations: () => loadModule(() => import('./pages/access.js' + buildQuery)).then(async (m) => { await m.loadStyles(); return m.AccessPage; }),
  interlocuteur: () => loadModule(() => import('./pages/interlocutor.js' + buildQuery)).then(async (m) => { await m.loadStyles(); return m.InterlocutorPage; }),
  journaux: () => loadModule(() => import('./pages/journaux.js' + buildQuery)).then(async (m) => { await m.loadStyles(); return m.JournauxPage; }),
  session: () => loadModule(() => import('./pages/session.js' + buildQuery)).then((m) => m.SessionPage),
  competences: () => loadModule(() => import('./pages/skills.js' + buildQuery)).then((m) => m.SkillsPage),
  competence: () => loadModule(() => import('./pages/skill.js' + buildQuery)).then((m) => m.SkillPage),
  sante: () => loadModule(() => import('./pages/health.js' + buildQuery)).then((m) => m.HealthPage),
  parametres: () => loadModule(() => import('./pages/settings.js' + buildQuery)).then(async (m) => { await m.loadStyles(); return m.SettingsPage; }),
  ds: () => loadModule(() => import('./pages/ds.js' + buildQuery)).then(m=>m.DesignSystemPage),
  invitation: () => loadModule(() => import('./pages/invitation.js' + buildQuery)).then((m) => m.InvitationPage),
  setup: () => loadModule(() => import('./pages/setup.js' + buildQuery)).then(async (m) => { await m.loadStyles(); return m.SetupPage; }),
  'a-propos': () => loadModule(() => import('./pages/about.js' + buildQuery)).then((m) => m.AboutPage),
};
const pageLoads = new Map();   // name → Promise<Component>
const pageReady = new Map();   // name → Component (no loading flash once a page has been shown)
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
// Preload on navigation intent.
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
    // Reuse a completed successful navigation check, never an elapsed deadline.
    pageLoads.set(name, release.beforePageLoad().then((stale) => {
      if (stale) throw new Error(msg('release.available'));
      globalThis.AO_ROUTES?.preload(name);
      return PAGES[name]();
    }).catch(async (err) => {
      await recoverChunk(err);
      throw err;
    }).then((C) => { pageReady.set(name, C); return C; }, (err) => { pageLoads.delete(name); throw err; }));
  }
  return pageLoads.get(name);
}
function PageBoundary({ children }) {
  const [error, reset] = useErrorBoundary();
  return error ? html`<div class="bu-page"><${ErrorState} error=${{ code: 'internal', message: msg('common.unexpected') }} onRetry=${reset} /></div>` : children;
}
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
  if (C) return html`<${PageBoundary}><${C} ...${props} /></${PageBoundary}>`;
  if (error) return html`<div class="bu-page"><${ErrorState} error=${{ code: 'network', message: msg('apiError.network') }} onRetry=${() => reloadChunks({ manual: true })} /></div>`;
  return html`<div class="bu-page" aria-busy="true"><p class="bu-sr-only" role="status">${msg('common.loading')}</p></div>`;
}

function Page({ match, onLogout }) {
  if (match.name === 'introuvable') return html`<${PageBoundary}><${NotFoundPage} /></${PageBoundary}>`;
  if (match.name === 'plus') return html`<${PageBoundary}><${MorePage} onLogout=${onLogout} /></${PageBoundary}>`;
  return PAGES[match.name] ? html`<${LazyPage} key=${match.name + ':' + JSON.stringify(match.params)} name=${match.name} match=${match} />` : html`<${PlaceholderPage} match=${match} />`;
}

function App() {
  const [match, setMatch] = useState(router.current);
  const [boot, setBoot] = useState({ phase: 'loading', me: null, error: null });
  const authGeneration = useRef(0);
  const status = useStore(services.stream.status);
  const [, setLangTick] = useState(0);
  useEffect(() => onLang(() => setLangTick(n => n + 1)), []);   // a language switch re-renders everything in place

  useEffect(() => router.subscribe(setMatch), []);

  async function checkAuth() {
    const current = ++authGeneration.current;
    try {
      const me = await api.me();
      if (current !== authGeneration.current) return;
      await metadataAuth(!!me);
      if (current !== authGeneration.current) return;
      services.me = me;
      window.AO_SYNC_IDENTITY(me);
      setBoot({ phase: me ? 'in' : 'out', me, error: null });
      if (me) services.stream.start(); else services.stream.stop();
    } catch (error) {
      if (current !== authGeneration.current) return;
      setBoot({ phase: 'error', me: null, error });
    }
  }
  const leave = () => {
    authGeneration.current++;
    services.stream.stop();
    services.me = null;
    void metadataAuth(false).catch(() => {});
    setBoot({ phase: 'out', me: null, error: null });
  };
  useEffect(() => { checkAuth(); return api.onUnauthorized(leave); }, []);

  // Preserve the return URL across authentication.
  useEffect(() => {
    if (boot.phase === 'out' && match.name !== 'connexion' && !match.route?.public) {
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
      if (err && err.code === 'unauthorized') { leave(); return; }
      toast({ level: 'danger', message: msg('shell.logoutFailed'), code: err && err.code ? err.code.toUpperCase() : null,
        action: { label: msg('common.retry'), run: onLogout } });
      return;
    }
    leave();
  }

  let body;
  if (boot.phase === 'loading') body = html`<${Frame} bodyClass="ao-boot" aria-busy="true"><span class="bu-spinner" aria-label=${msg('common.loading')}></span></${Frame}>`;
  else if (boot.phase === 'error') body = html`<${Frame} bodyClass="ao-boot"><${ErrorState} error=${boot.error} onRetry=${boot.error?.chunkFailure ? () => reloadChunks({ manual: true }) : checkAuth} /></${Frame}>`;
  else if (match.route?.public && match.name !== 'connexion') body = html`<${LazyPage} name=${match.name} match=${match} />`;
  else if (boot.phase === 'out' || match.name === 'connexion') body = html`<${LazyPage} name="connexion" onLoggedIn=${checkAuth} />`;
  else body = html`<${Shell} match=${match} me=${boot.me} status=${status} onLogout=${onLogout}><${Page} match=${match} onLogout=${onLogout} /></${Shell}>`;

  const inShell = boot.phase === 'in' && match.name !== 'connexion' && !match.route?.public;
  return html`${body}${api.isMock() && !inShell ? html`<${MockBadge} floating />` : null}<${Toasts} /><${ShortcutsHost} />`;
}

function SetupRoot() {
  const [, setLangTick] = useState(0);
  useEffect(() => onLang(() => setLangTick(n => n + 1)), []);
  useEffect(() => { document.title = msg('setup.title') + ' · Agent Office'; });
  return html`<${LazyPage} name="setup" />${api.isMock() ? html`<${MockBadge} floating />` : null}<${Toasts} />`;
}

async function main() {
  const root = document.getElementById('app');
  try {
    const meta = await api.init();
    // Validate incoming VMs in dev/test.
    if (meta.env !== 'production') { await vmcheck.enable(); vmcheck.check('meta', meta, 'GET /api/v2/meta'); }
    initMetadata(meta);
    services.timeZone = setTimeZone(meta.instance && meta.instance.timeZone);   // R12-08 (office reads services.timeZone)
    // First-run setup precedes auth and streams.
    if (meta.instance && meta.instance.configured === false) { render(html`<${SetupRoot} />`, root); return; }
    services.stream = await makeStream(meta);
    render(html`<${App} />`, root);
  } catch (error) {
    render(html`<${Frame} bodyClass="ao-boot"><${ErrorState} error=${error} onRetry=${() => error?.chunkFailure ? reloadChunks({ manual: true }) : location.reload()} /></${Frame}><${Toasts} />`, root);
  }
}

main();
