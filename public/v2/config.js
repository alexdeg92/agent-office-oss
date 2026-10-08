// Runtime deployment config (F7): where the UI is mounted and where the API lives. Nothing else in the UI
// knows either. The server that serves index.html writes it into <meta name="ao-config" content='{json}'>
// together with a matching <base href> (scripts/serve-frontend.js renderIndex); the file's own values are the
// production defaults (UI at /, API behind /backend, api.md §1 paths below it).
//   basePath: the UI's mount point, with leading and trailing slash ('/', '/v2/').
//   apiBase:  prefix put before every API path ('/backend', or '' when the API shares the UI's origin root).
//   apiVersion: 2 | 3, the API contract the whole client speaks (G5, migration-v3.md: one version for views, commands
//             and the stream). Callers write api.md paths ('/api/v2/…'); apiUrl() alone puts the configured version in.
//   assetBase (derived): basePath + 'bureau/', where scripts/sync-design.js puts the design system and art.

// THE API-version switch (migration-v3.md step 4, frontend-21): change apiVersion here to move every client whose
// deployment doesn't pin one (serve-frontend --api-version / AO_API_VERSION) to that contract. Nothing else defaults it.
export const DEFAULTS = Object.freeze({ basePath: '/', apiBase: '/backend', apiVersion: 2 });
export const API_VERSIONS = [2, 3];

/** Normalises a raw config: basePath always '/…/', apiBase never ends with '/'. Bad values fall back to defaults. */
export function normalise(raw = {}) {
  const str = (v) => (typeof v === 'string' && !/[\s"'<>\\?#\0]/.test(v) ? v : null);   // same grammar as the server (R13-10)
  let basePath = str(raw.basePath) ?? DEFAULTS.basePath;
  if (!basePath.startsWith('/') || basePath.startsWith('//')) basePath = DEFAULTS.basePath;
  if (!basePath.endsWith('/')) basePath += '/';
  let apiBase = str(raw.apiBase) ?? DEFAULTS.apiBase;
  // Same origin only (cookie auth, no CORS): a path prefix, never another host.
  if (apiBase !== '' && (!apiBase.startsWith('/') || apiBase.startsWith('//'))) apiBase = DEFAULTS.apiBase;
  apiBase = apiBase.replace(/\/+$/, '');
  const apiVersion = API_VERSIONS.includes(raw.apiVersion) ? raw.apiVersion : DEFAULTS.apiVersion;
  return { basePath, apiBase, apiVersion };
}

/** Reads the injected meta tag (none in Node, or unreadable → defaults). */
export function readConfig(doc = globalThis.document) {
  const el = doc && doc.querySelector ? doc.querySelector('meta[name="ao-config"]') : null;
  if (!el) return normalise();
  try { return normalise(JSON.parse(el.getAttribute('content') || '{}')); } catch { return normalise(); }
}

const withDerived = (c) => ({ ...c, assetBase: c.basePath + 'bureau/' });
/** The active config: { basePath, apiBase, assetBase } (assetBase = the synced Bureau design system and art). */
export const config = withDerived(readConfig());
/** The release this document loaded; immutable for the lifetime of the tab. */
export const buildId = globalThis.document?.querySelector('meta[name="ao-build"]')?.getAttribute('content') || '';
export const buildQuery = buildId ? '?v=' + encodeURIComponent(buildId) : '';

/** Tests (and the Node side) only: replace the active config. */
export function configure(raw) { Object.assign(config, withDerived(normalise(raw))); }

/** The UI's mount point without its trailing slash: '' at the root, '/v2' under /v2. Route paths follow it. */
export const routeBase = () => config.basePath.slice(0, -1);
/** '/api/v2/…' or '/api/v3/…' → the same path on the configured version; any other path unchanged (v1 auth routes). */
export const versioned = (path) => String(path).replace(/^\/api\/v[23](?=\/|$|\?)/, '/api/v' + config.apiVersion);
/** An API URL: `path` is an api.md path ('/api/v2/views/health'); the version and the deployment prefix come from config. */
export const apiUrl = (path) => config.apiBase + versioned(path);
/** A UI asset URL, from a path relative to the UI root ('bureau/assets/Logos/favicon.svg'). */
export const assetUrl = (path) => {
  const url = config.basePath + path.replace(/^\/+/, '');
  return /\.(?:js|mjs|css)$/.test(url) ? url + buildQuery : url;
};
