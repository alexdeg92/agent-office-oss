// Router: History API, every selection that matters on reload lives in the URL (api.md §1).
// Pure parsing/building here; `createRouter` adds the browser binding. No DOM access at import time.
// Paths live under the runtime basePath (config.js): '' at the root, '/v2' when mounted there.
import { routeBase, config } from './config.js';
import { msg } from './i18n.js';

/** True when `pathname` is inside the UI's mount point (and not under the API prefix when both share a root). */
export function inApp(pathname) {
  const base = routeBase();
  if (!(pathname === base || pathname.startsWith(base + '/'))) return false;
  const api = config.apiBase;
  return !(api.startsWith('/') && (pathname === api || pathname.startsWith(api + '/')));
}

// Ordered as the sidebar (Nav README). `tab` = mobile bottom bar slot.
export const ROUTES = [
  { name: 'bureau-animations', path: '/bureau/test-animations', parent: 'bureau', tab: 'bureau' },
  { name: 'bureau', path: '/bureau', label: true, icon: 'bureau', question: true, tab: 'bureau' },
  { name: 'discuter', path: '/discuter', label: true, icon: 'discuter', question: true, tab: 'discuter', needs: 'chat' },
  { name: 'flux', path: '/flux', label: true, icon: 'flux', question: true, tab: 'plus', needs: 'flows.read' },
  { name: 'flux-detail', path: '/flux/:jobId', parent: 'flux', tab: 'plus' },
  { name: 'projets', path: '/projets', label: true, icon: 'projets', question: true, tab: 'projets' },
  { name: 'importer', path: '/projets/importer', parent: 'projets', tab: 'projets' },
  { name: 'projet', path: '/projets/:projectId', parent: 'projets', tab: 'projets' },
  { name: 'habilitations', path: '/habilitations', label: true, icon: 'habilitations', question: true, tab: 'plus' },
  { name: 'interlocuteur', path: '/habilitations/:interlocutorId', parent: 'habilitations', tab: 'plus' },
  { name: 'journaux', path: '/journaux', label: true, icon: 'journaux', question: true, tab: 'journaux', needs: 'sessions' },
  { name: 'session', path: '/journaux/:sessionKey', parent: 'journaux', tab: 'journaux' },
  { name: 'competences', path: '/competences', label: true, icon: 'competences', question: true, tab: 'plus', needs: 'skills.read' },
  { name: 'competence', path: '/competences/:skillName', parent: 'competences', tab: 'plus' },
  { name: 'sante', path: '/sante', label: true, icon: 'sante', question: true, tab: 'plus' },
  // Boutique (office-dev-21): customising the office, last in the sidebar and the Plus list (frontend: route and shell).
  // State in the query: ?onglet=…&agent=<occupantId>&placer=<asset|uid>.
  { name: 'boutique', path: '/boutique', label: true, icon: 'boutique', question: true, tab: 'plus' },
  { name: 'plus', path: '/plus', label: true, icon: 'plus', question: true, tab: 'plus', mobileOnly: true },
  { name: 'a-propos', path: '/a-propos', label: true, question: true, tab: 'plus', menu: true },   // F13: from the user menu, not the sidebar
  { name: 'connexion', path: '/connexion', label: true, public: true },
];
// Labels and page questions are UI messages (nav.<name>, nav.<name>.question), read in the current language.
for (const r of ROUTES) {
  if (r.label) Object.defineProperty(r, 'label', { get: () => msg('nav.' + r.name), enumerable: true });
  if (r.question) Object.defineProperty(r, 'question', { get: () => msg('nav.' + r.name + '.question'), enumerable: true });
}
export const NAV = ROUTES.filter((r) => r.label && !r.public && !r.mobileOnly && !r.menu);
export const BOTTOM_TABS = ['bureau', 'discuter', 'projets', 'journaux', 'plus'];
export const DEFAULT_ROUTE = 'bureau';
// Query params that follow every navigation (mock mode must survive clicks).
export const STICKY_PARAMS = ['mock'];

const byName = new Map(ROUTES.map((r) => [r.name, r]));
export const routeByName = (name) => byName.get(name) || null;

function compile(path) {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  return { re, keys };
}
const compiled = ROUTES.map((r) => ({ route: r, ...compile(r.path) }));

/** Parses a location into a match: { name, params, query, route }. Unknown paths → name 'introuvable'. */
export function parse(pathname, search = '') {
  const base = routeBase();
  let p = pathname === base || pathname.startsWith(base + '/') ? pathname.slice(base.length) : pathname;
  if (p === '' || p === '/') p = '/' + DEFAULT_ROUTE;
  const query = Object.fromEntries(new URLSearchParams(search));
  for (const { route, re, keys } of compiled) {
    const m = re.exec(p);
    if (!m) continue;
    const params = {};
    try { keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); } catch { continue; }
    return { name: route.name, params, query, route };
  }
  return { name: 'introuvable', params: {}, query, route: null };
}

/** Builds a URL for a named route. `query` values null/undefined/'' are dropped. */
export function href(name, params = {}, query = {}) {
  const r = byName.get(name);
  if (!r) throw new Error('unknown route: ' + name);
  const path = r.path.replace(/:([A-Za-z]+)/g, (_, k) => {
    if (params[k] == null || params[k] === '') throw new Error(`missing param ${k} for ${name}`);
    return encodeURIComponent(params[k]);
  });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v != null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return routeBase() + path + (s ? '?' + s : '');
}

/** Returns `url` with the sticky params of `currentSearch` added when `url` doesn't set them. */
export function withSticky(url, currentSearch) {
  const cur = new URLSearchParams(currentSearch);
  const [path, s = ''] = url.split('?');
  const qs = new URLSearchParams(s);
  for (const k of STICKY_PARAMS) if (cur.has(k) && !qs.has(k)) qs.set(k, cur.get(k));
  const out = qs.toString();
  return path + (out ? '?' + out : '');
}

/** Which bottom-bar slot is active for a match (detail pages light their parent's slot). */
export function activeTab(match) {
  return match.route ? match.route.tab || null : null;
}
/** Which sidebar item is active for a match. */
export function activeNav(match) {
  if (!match.route) return null;
  return match.route.parent || match.name;
}

/** Browser binding: intercepts same-origin in-app link clicks, keeps sticky params, notifies on change. */
export function createRouter(win = window, { beforeNavigate = null } = {}) {
  const listeners = new Set();
  let current = parse(win.location.pathname, win.location.search);
  const emit = () => { current = parse(win.location.pathname, win.location.search); for (const fn of listeners) fn(current); };

  let intent = 0;
  function navigate(url, { replace = false } = {}) {
    const next = withSticky(url, win.location.search);
    if (next === win.location.pathname + win.location.search) return;
    const token = ++intent;
    const apply = () => {
      if (token !== intent) return;
      win.history[replace ? 'replaceState' : 'pushState'](null, '', next);
      emit();
      if (!replace) win.scrollTo(0, 0);
    };
    if (beforeNavigate) return Promise.resolve(beforeNavigate(next)).then((ok) => { if (ok) apply(); });
    apply();
  }
  /** Merges query params into the current URL (selections, filters); null removes a param. */
  function setQuery(patch, { replace = true } = {}) {
    const qs = new URLSearchParams(win.location.search);
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') qs.delete(k); else qs.set(k, String(v)); }
    const s = qs.toString();
    navigate(win.location.pathname + (s ? '?' + s : ''), { replace });
  }

  win.addEventListener('popstate', () => {
    const token = ++intent;
    if (beforeNavigate) Promise.resolve(beforeNavigate(win.location.href)).then((ok) => { if (ok && token === intent) emit(); });
    else emit();
  });
  win.document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download')) return;
    const url = new URL(a.href, win.location.href);
    if (url.origin !== win.location.origin || !inApp(url.pathname)) return;
    if (/\.[a-z0-9]+$/i.test(url.pathname)) return; // a file, not a client route (api.md §6)
    e.preventDefault();
    navigate(url.pathname + url.search);
  });

  return {
    get current() { return current; },
    navigate, setQuery,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    href: (name, params, query) => withSticky(href(name, params, query), win.location.search),
  };
}

/** The login return target: same origin, normalised (no dot segments), inside the app, never the login page itself. */
export function safeReturn(suite, origin = globalThis.location ? location.origin : 'http://localhost') {
  if (!suite || !suite.startsWith('/')) return null;
  let u;
  try { u = new URL(suite, origin); } catch { return null; }
  if (u.origin !== origin || !inApp(u.pathname)) return null;
  const login = href('connexion');
  if (u.pathname === login || u.pathname.startsWith(login + '/')) return null;
  return u.pathname + u.search;
}
