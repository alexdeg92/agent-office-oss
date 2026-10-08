// api.js boot and auth paths with a stubbed fetch (R4-01, R4-11, R4-18). Each test imports a fresh module instance.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { configure } from '../../public/v2/config.js';

// F7: callers pass api.md paths; api.js alone adds config.apiBase. The stub only answers under that prefix,
// so a call that skips the prefix shows up as a 404 and an `unprefixed` entry.
let PREFIX = '/backend';
configure({ basePath: '/', apiBase: PREFIX });
const unprefixed = [];
let n = 0;
const fresh = () => import(`../../public/v2/api.js?case=${++n}`);
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => 'req_test' }, json: async () => body });
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (rawUrl, init = {}) => {
    if (!rawUrl.startsWith(PREFIX + '/api/')) unprefixed.push(rawUrl);
    const url = rawUrl.slice(PREFIX.length);
    calls.push({ url, raw: rawUrl, method: init.method || 'GET' });
    const r = routes[url.split('?')[0]];   // routes are paths; the query (e.g. meta's ?locale=) is checked by the tests that care
    if (r === 'network') throw new TypeError('fetch failed');
    if (typeof r === 'function') return r(init);
    return r || json(404, { error: 'not found' });
  };
  return calls;
}
const meta = (env) => json(200, { data: { modelVersion: 1, apiVersion: 2, contractVersion: '2.0', env, capabilities: { openclawWrites: true, storeWrites: true }, readonly: false, labels: {}, enums: {} },
  meta: { modelVersion: 1, generatedAt: 1, stale: [] } });

test('R4-01: ?mock is ignored when meta says production — no mock, real auth', async () => {
  const api = await fresh();
  const calls = stubFetch({ '/api/v2/meta': meta('production'), '/api/v2/me': json(401, { error: { code: 'unauthorized', message: 'x', requestId: 'r' } }) });
  const m = await api.init({ search: '?mock=1', hostname: 'staging.local' });
  assert.equal(m.env, 'production');
  assert.equal(api.isMock(), false);
  assert.equal(calls[0].url, '/api/v2/meta?locale=fr', 'meta is read before honouring ?mock, in the UI language (frontend-23)');
  assert.equal(await api.me(), null, 'no synthetic identity: the real /me says 401');
});

test('R4-01: a meta 404 never mocks outside a loopback host (no instance hostname in code)', async () => {
  const api = await fresh();
  stubFetch({ '/api/v2/meta': json(404, {}) });
  for (const host of ['dashboard.exemple.ca', '100.64.0.7', 'staging.local']) {
    await assert.rejects(api.init({ search: '?mock=1', hostname: host }), (e) => e.code === 'not_found', host);
    assert.equal(api.isMock(), false, host);
  }
  assert.equal(api.isLoopbackHost('127.0.0.1'), true);
  assert.equal(api.isLoopbackHost('dev.localhost'), true);
});

test('R4-01: a network error never falls back to mock', async () => {
  const api = await fresh();
  stubFetch({ '/api/v2/meta': 'network' });
  await assert.rejects(api.init({ search: '?mock=1', hostname: 'localhost' }), (e) => e.code === 'network');
  assert.equal(api.isMock(), false);
});

test('meta 404 on a dev host: mock view models; standalone (mock) auth only with ?mock', async () => {
  const a = await fresh();
  stubFetch({ '/api/v2/meta': json(404, {}), '/api/me': json(401, { error: 'unauthorized' }) });
  await a.init({ search: '', hostname: 'localhost' });
  assert.equal(a.isMock(), true);
  assert.equal(await a.me(), null, 'without ?mock the real v1 /api/me decides');

  const b = await fresh();
  stubFetch({ '/api/v2/meta': json(404, {}) });
  await b.init({ search: '?mock=1', hostname: 'localhost' });
  const me = await b.me();
  assert.equal(me.email, 'Owner@example.invalid', 'standalone: a static server has no /api/login');
});

test('a non-production server with ?mock: mock view models but real auth', async () => {
  const api = await fresh();
  const calls = stubFetch({ '/api/v2/meta': meta('staging'), '/api/v2/me': json(200, { data: { email: 'a@b.c', gateway: 'up' }, meta: { stale: [] } }) });
  await api.init({ search: '?mock=1', hostname: 'staging.local' });
  assert.equal(api.isMock(), true);
  assert.deepEqual(await api.me(), { email: 'a@b.c', gateway: 'up' });
  assert.ok(calls.some((c) => c.url === '/api/v2/me'));
});

test('live mode: other meta errors are surfaced, not mocked', async () => {
  const api = await fresh();
  stubFetch({ '/api/v2/meta': json(500, { error: { code: 'internal', message: 'Erreur interne du serveur.', requestId: 'r1' } }) });
  await assert.rejects(api.init({ search: '?mock=1', hostname: 'localhost' }), (e) => e.code === 'internal' && e.requestId === 'r1');
  assert.equal(api.isMock(), false);
});

test('R4-11: a failed logout rejects (the UI must not show it as done)', async () => {
  const api = await fresh();
  stubFetch({ '/api/v2/meta': meta('staging'), '/api/logout': 'network' });
  await api.init({ search: '', hostname: 'staging.local' });
  await assert.rejects(api.logout(), (e) => e.code === 'network');
  stubFetch({ '/api/v2/meta': meta('staging'), '/api/logout': json(500, { error: 'boom' }) });
  await assert.rejects(api.logout(), (e) => e.code === 'internal');
});

test('errors: v2 format with current (409), v1 strings, unauthorized listeners', async () => {
  const api = await fresh();
  const e = api.toApiError(409, { error: { code: 'conflict', message: 'Le projet a changé.', requestId: 'r', current: { revision: 8, vm: { id: 'prj_a' } } } });
  assert.equal(e.code, 'conflict');
  assert.deepEqual(e.current, { revision: 8, vm: { id: 'prj_a' } });
  assert.equal(api.toApiError(401, { error: 'Identifiants invalides.' }).message, 'Identifiants invalides.');
  assert.equal(api.toApiError(429, null).code, 'rate_limited');
  let hits = 0;
  api.onUnauthorized(() => hits++);
  stubFetch({ '/api/v2/meta': meta('staging'), '/api/v2/views/health': json(401, { error: { code: 'unauthorized', message: 'x', requestId: 'r' } }) });
  await api.init({ search: '', hostname: 'staging.local' });
  await assert.rejects(api.get('/api/v2/views/health'));
  api.notifyUnauthorized();
  assert.equal(hits, 2, 'an HTTP 401 and an SSE-detected expiry both reach the listeners');
});

test('F7: every API call goes through apiBase (production /backend, and the same-root dev setup)', async () => {
  assert.deepEqual(unprefixed, [], 'no call above skipped /backend');
  for (const prefix of ['/backend', '']) {
    PREFIX = prefix;
    configure({ basePath: '/', apiBase: prefix });
    const api = await fresh();
    const calls = stubFetch({ '/api/v2/meta': meta('staging'), '/api/v2/me': json(200, { data: { email: 'a@b.c' }, meta: { stale: [] } }), '/api/login': json(200, { ok: true }), '/api/v2/views/health': json(200, { data: {}, meta: {} }) });
    await api.init({ search: '', hostname: 'h.example' });
    await api.me();
    await api.login('a@b.c', 'x');
    await api.get('/api/v2/views/health');
    assert.deepEqual(calls.map((c) => c.raw), ['/api/v2/meta?locale=fr', '/api/v2/me', '/api/login', '/api/v2/views/health'].map((p) => prefix + p));
  }
  assert.deepEqual(unprefixed, []);
  PREFIX = '/backend';
  configure({ basePath: '/', apiBase: '/backend' });
});

test('login throttling (architect-20): a 429 carries retryAfterSec (body, else the Retry-After header); a 415 has its own code', async () => {
  const api = await fresh();
  const withHeader = (status, body, headers) => ({ status, ok: false, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, json: async () => body });
  stubFetch({ '/api/v2/meta': meta('staging'), '/api/login': withHeader(429, { error: 'Trop de tentatives. Réessayez dans quelques minutes.', retryAfterSec: 12 }, { 'retry-after': '12' }) });
  await api.init({ search: '', hostname: 'h.example' });
  await assert.rejects(api.login('a@b.c', 'x'), (e) => e.code === 'rate_limited' && e.retryAfterSec === 12);
  stubFetch({ '/api/v2/meta': meta('staging'), '/api/login': withHeader(429, { error: 'x' }, { 'retry-after': '30' }) });
  await assert.rejects(api.login('a@b.c', 'x'), (e) => e.retryAfterSec === 30, 'header fallback');
  stubFetch({ '/api/v2/meta': meta('staging'), '/api/login': withHeader(415, { error: 'Type de contenu non pris en charge.' }, {}) });
  await assert.rejects(api.login('a@b.c', 'x'), (e) => e.code === 'unsupported_media_type');
  const { msg, setLang } = await import('../../public/v2/i18n.js');
  assert.equal(msg('login.tooMany', { n: 12 }), 'Trop de tentatives, réessayez dans 12 s.');
  setLang('en');
  assert.equal(msg('login.tooMany', { n: 12 }), 'Too many attempts, retry in 12 s.');
  setLang('fr');
});

test('R15-01 (architect-21): every non-GET request carries X-AO-Request: 1; GETs do not need it', async () => {
  const api = await fresh();
  const seenHeaders = [];
  const ok = (body = {}) => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ data: body, meta: {} }) });
  globalThis.fetch = async (url, init = {}) => { seenHeaders.push({ url, method: init.method || 'GET', h: init.headers || {} }); return url.endsWith('/api/v2/meta') ? meta('staging') : ok(); };
  await api.init({ search: '', hostname: 'h.example' });
  await api.get('/api/v2/views/health');
  await api.post('/api/v2/projects', { name: 'x' });
  await api.put('/api/v2/projects/p/status', {});
  await api.patch('/api/v2/projects/p', {});
  await api.del('/api/v2/flows/f');
  await api.login('a@b.c', 'x');
  await api.logout();
  for (const r of seenHeaders) {
    if (r.method === 'GET') assert.equal(r.h['x-ao-request'], undefined, r.url);
    else assert.equal(r.h['x-ao-request'], '1', `${r.method} ${r.url}`);
  }
  assert.equal(seenHeaders.filter((r) => r.method !== 'GET').length, 6);
});

test('F9: server error messages stay French until G5, so in English the UI says the code’s own sentence', async () => {
  const api = await fresh();
  const { setLang } = await import('../../public/v2/i18n.js');
  const body = { error: { code: 'upstream_unavailable', message: 'La passerelle est injoignable.', requestId: 'r' } };
  assert.equal(api.toApiError(503, body).message, 'La passerelle est injoignable.', 'fr: the server’s own text');
  assert.equal(api.toApiError(429, null).message, 'Action trop fréquente. Réessayez dans quelques minutes.', 'fr: a fallback without a body');
  setLang('en');
  try {
    const e = api.toApiError(503, body);
    assert.equal(e.message, 'The runtime is unreachable. Try again in a moment.');
    assert.equal(e.serverMessage, 'La passerelle est injoignable.', 'kept for diagnosis');
    assert.equal(new api.ApiError({ code: 'network' }).message, 'The server is not responding. Check the connection, then try again.');
    assert.equal(new api.ApiError({ code: 'quelque-chose', message: 'Texte serveur.' }).message, 'Texte serveur.', 'an unknown code keeps the server text');
  } finally { setLang('fr'); }
});
