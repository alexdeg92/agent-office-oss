import { loadModule } from './build-update.js';
// Shared HTTP client: deployment prefixes, ApiError and explicit or legacy mock mode.
import { toast } from './toast.js';
import { apiUrl, assetUrl, versioned, buildQuery, splitOrigin } from './config.js';
import * as vmcheck from './vmcheck.js';
import { getLang, msg, messageKeys } from './i18n.js';

// Route prewarm: HTTP cache only, never the module map.
export async function prewarm(url) {
  const r = await fetch(url, { priority: 'low', credentials: 'same-origin' });
  await r.arrayBuffer();
  if (!r.ok) throw new Error('preload');
}

/** The deployed static UI release, independently of the API version and mock mode. */
export async function getUIBuildId() {
  const r = await fetch(assetUrl('build.json'), { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  return (await r.json()).buildId;
}

export class ApiError extends Error {
  constructor({ status = 0, code = 'internal', message, details = null, requestId = null, current = null }) {
    super(localMessage(code, message) || msg('common.unexpected'));
    this.name = 'ApiError';
    this.serverMessage = message || null;
    // current: { revision, vm } — only on a 409 for project and layout writes (api.md 2.0 §2.2)
    Object.assign(this, { status, code, details, requestId, current });
  }
}

const CODE_BY_STATUS = { 400: 'validation_failed', 401: 'unauthorized', 403: 'readonly', 404: 'not_found', 409: 'conflict', 415: 'unsupported_media_type', 429: 'rate_limited', 502: 'upstream_failed', 503: 'upstream_unavailable' };
const known = (code) => messageKeys(getLang()).includes('apiError.' + code);
const localMessage = (code, message) => (known(code) && (getLang() !== 'fr' || !message) ? msg('apiError.' + code) : message);

/** Turns any error body into an ApiError: the v2 format, or v1's `{error: 'texte'}`. */
export function toApiError(status, body, headerRequestId = null) {
  const e = body && body.error;
  if (e && typeof e === 'object') {
    return new ApiError({ status, code: e.code || CODE_BY_STATUS[status] || 'internal', message: e.message, details: e.details || null, requestId: e.requestId || headerRequestId, current: e.current || null });
  }
  const code = CODE_BY_STATUS[status] || 'internal';
  const message = typeof e === 'string' && e !== 'unauthorized' ? e : null;
  return new ApiError({ status, code, message, requestId: headerRequestId });
}

let mode = null;          // 'live' | 'mock'
let mockScenario = null;  // mock/ scenario name
let mockModule = null;
let serverHasV2 = false; // GET /api/v2/meta answered (not 404): auth goes through /api/v2/me
const authListeners = new Set();
let splitAuthModule = null;
const loadSplitAuth = () => splitAuthModule || (splitAuthModule = loadModule(() => import('./split-auth.js' + buildQuery)).then(auth => (auth.configure(ApiError,toApiError),auth)));

export const onUnauthorized = (fn) => { authListeners.add(fn); return () => authListeners.delete(fn); };
/** Session expired outside an HTTP call (e.g. the SSE stream, R4-10): same handling as a 401. */
export function notifyUnauthorized() { for (const fn of authListeners) fn(new ApiError({ status: 401, code: 'unauthorized' })); }
export const isMock = () => mode === 'mock';
export const getMockScenario = () => mockScenario;
export async function mock() { return mockModule || (mockModule = await loadModule(() => import('./mock/server.js' + buildQuery))); }

// Loopback-only mock fallback.
export const isLoopbackHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || /\.localhost$/.test(h);

/** Selects live APIs or loopback-only mock mode at boot. */
export async function init({ search = location.search, hostname = location.hostname } = {}) {
  const q = new URLSearchParams(search);
  const wanted = q.has('mock') ? q.get('mock') || '1' : null;
  const mockableHost = isLoopbackHost(hostname);
  let res;
  try {
    res = await fetch(apiUrl('/api/v2/meta?locale=' + getLang()), { headers: { accept: 'application/json', 'accept-language': getLang() }, credentials: 'same-origin' });
  } catch {
    throw new ApiError({ code: 'network' });
  }
  if (res.status === 404) {
    res.body?.cancel().catch(() => {});   // unread no-store body
    if (!mockableHost) throw new ApiError({ status: 404, code: 'not_found', message: 'Cette version de l’interface n’est pas encore disponible sur ce serveur.' });
    return useMock(wanted || '1', { standalone: wanted != null });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.data) throw toApiError(res.status, body, res.headers.get('x-request-id'));
  const meta = body.data;
  serverHasV2 = true;
  if (wanted && meta.env !== 'production') return useMock(wanted, { standalone: false });
  mode = 'live';
  return meta;
}
async function useMock(scenario, { standalone }) {
  mode = 'mock';
  mockScenario = scenario || '1';
  const m = await mock();
  m.configure({ scenario: mockScenario, standalone });
  return (await m.handle('GET', versioned('/api/v2/meta'))).body.data;
}

/** Sends a JSON API request with optional cancellation and explicit API version. */
export async function request(method, path, body, { quiet = false, apiVersion, notifyUnauthorized: notifyAuth = true, signal, cache, live = false } = {}) {
  try {
    signal?.throwIfAborted();
    if (!live && mode === 'mock' && /^\/api\/v[23]\//.test(path)) return checked(method, path, unwrapMock(await (await mock()).handle(method, versioned(path, apiVersion), body)),apiVersion);
    const url = apiUrl(path, apiVersion);
    const options = { method, signal, cache, credentials:'same-origin',
      headers: { accept: 'application/json', 'accept-language': getLang(), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'GET' || method === 'HEAD' ? {} : { 'x-ao-request': '1' }) },
      body: body === undefined ? undefined : JSON.stringify(body) };
    let res;
    try { res = splitOrigin ? await (await loadSplitAuth()).request(url,options,apiUrl('/api/auth/refresh')) : await fetch(url,options); }
    catch (error) { if (signal?.aborted) throw signal.reason || error; if(error instanceof ApiError)throw error; throw new ApiError({ code:'network' }); }
    const rid = res.headers.get('x-request-id');
    let json = null;
    try { json = await res.json(); } catch { /* empty or non-JSON body */ }
    signal?.throwIfAborted();
    if (!res.ok) throw withRetryAfter(toApiError(res.status, json, rid), res, json);
    return checked(method, path, json,apiVersion);
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code === 'unauthorized' && (typeof notifyAuth === 'function' ? notifyAuth(err) : notifyAuth)) for (const fn of authListeners) fn(err);
      else if (!quiet) toastError(err);
    }
    throw err;
  }
}
/** Dev/test: a GET view model is checked against its schema (vmcheck.js); production never loads the validator. */
function checked(method, path, json,apiVersion) {
  if (method === 'GET' && json && json.data !== undefined) vmcheck.check(vmcheck.schemaForPath(path), json.data, 'GET ' + path,apiVersion);
  return json;
}
function unwrapMock({ status, body }) {
  if (status >= 400) throw withRetryAfter(toApiError(status, body), { status, headers: { get: () => null } }, body);
  return body;
}

/** Reads a 429 login delay from the body or Retry-After header. */
function withRetryAfter(err, res, body) {
  if (res.status !== 429) return err;
  const fromBody = body && Number.isFinite(body.retryAfterSec) ? body.retryAfterSec : null;
  const header = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  err.retryAfterSec = fromBody ?? (Number.isFinite(header) ? header : null);
  return err;
}

export function toastError(err) {
  toast({ level: 'danger', message: err.message, code: err.code && err.code !== 'internal' ? err.code.toUpperCase() : null, requestId: err.requestId });
}

export const get = (path, opts) => request('GET', path, undefined, opts);
export const post = (path, body, opts) => request('POST', path, body ?? {}, opts);
export const put = (path, body, opts) => request('PUT', path, body ?? {}, opts);
export const patch = (path, body, opts) => request('PATCH', path, body ?? {}, opts);
export const del = (path, opts) => request('DELETE', path, undefined, opts);

// ---- auth (unchanged v1 routes; /api/v2/me when it exists) ----

/** Returns the current user or null when signed out. */
export async function me() {
  if (mode === 'mock' && (await mock()).isStandalone()) return (await mock()).me();
  if (splitOrigin) {
    return (await loadSplitAuth()).me(apiUrl('/api/auth/refresh'),()=>get('/api/v3/me', {quiet:true,notifyUnauthorized:false,apiVersion:3}));
  }
  const tryGet = async (path) => {
    const res = await fetch(apiUrl(path), { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (res.status === 401) return null;
    if (res.status === 404) return undefined;
    const json = await res.json().catch(() => null);
    if (!res.ok) throw toApiError(res.status, json, res.headers.get('x-request-id'));
    return json;
  };
  try {
    const v2 = serverHasV2 ? await tryGet('/api/v2/me') : undefined;
    if (v2 !== undefined) return v2 && v2.data;
    return await tryGet('/api/me');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError({ code: 'network' });
  }
}

export async function login(email, password) {
  if (mode === 'mock' && (await mock()).isStandalone()) return (await mock()).login(email, password);
  if (splitOrigin) {
    return (await loadSplitAuth()).login(apiUrl('/api/auth/refresh'),email,password);
  }
  return request('POST', '/api/login', { email, password }, { quiet: true });
}

export async function logout() {
  if (mode === 'mock' && (await mock()).isStandalone()) return (await mock()).logout();
  if (splitOrigin) {
    return (await loadSplitAuth()).logout(apiUrl('/api/auth/refresh'));
  }
  return request('POST', '/api/logout', {}, { quiet: true });
}

/** Reload recovery and 401 refresh share one in-tab rotation. Bearer tokens stay volatile. */
export async function refreshHumanAccess() {
  if (!splitOrigin) return false;
  return (await loadSplitAuth()).refresh(apiUrl('/api/auth/refresh'));
}

/** A static JSON asset of the UI (e.g. the office manifest under bureau/), by path relative to the UI root.
 *  Same place as every other network call (the guard test), never through apiBase; errors are ApiErrors. */
/** A static text file shipped with the UI (a licence, F13): same rules as getAsset. */
export async function getAssetText(path) {
  let res;
  try { res = await fetch(assetUrl(path), { headers: { accept: 'text/plain' } }); } catch { throw new ApiError({ code: 'network' }); }
  if (!res.ok) throw toApiError(res.status, null);
  return res.text();
}
export async function getAsset(path) {
  let res;
  try { res = await fetch(assetUrl(path), { headers: { accept: 'application/json' } }); } catch { throw new ApiError({ code: 'network' }); }
  if (!res.ok) throw toApiError(res.status, null);
  return res.json();
}
