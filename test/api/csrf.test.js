'use strict';
// R15-01 (P1, go-live gate): CSRF. A same-site page on another origin can submit forms with the owner's Lax cookie.
// Every non-GET needs a JSON body (or no body + X-AO-Request) and, with a cookie, an allowed Origin/Referer or the
// X-AO-Request header; ordinary forms never reach a handler. Chat uploads have a separate mounted-app regression.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

const sc = loadScenario('synthetic-basic');
const JOB = 'ffffffff-0c01-4000-8000-000000000001';

// What a browser sends for a same-site form post is reproduced exactly: the form's content type, the attacker page's
// Origin and the owner's session cookie (a browser can't add custom headers or a JSON type to a form).
describe('R15-01 · CSRF: forged writes never reach a handler', () => {
  let h;
  before(async () => { h = await startServer(sc); });
  after(async () => { if (h) await h.stop(); });
  const raw = (p, headers, body, method = 'POST') => fetch(h.base + p, { method, headers: Object.assign({ cookie: h.cookie }, headers), body })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const restarts = () => h.gw.callsTo('gateway.restart.request').length;
  const runs = () => h.cliCalls().filter((a) => a[0] === 'cron' && a[1] === 'run').length;

  it('form-encoded, multipart and text/plain bodies → 415, with a valid cookie, on v2 and v3 writes; nothing runs', async () => {
    const r0 = restarts(), c0 = runs();
    for (const [type, body] of [['application/x-www-form-urlencoded', 'confirm=redemarrer'], ['multipart/form-data; boundary=x', '--x\r\nContent-Disposition: form-data; name="confirm"\r\n\r\nredemarrer\r\n--x--\r\n'],
      ['text/plain', '{"confirm":"redemarrer"}']]) {
      const v2 = await raw('/api/v2/gateway/restart', { 'content-type': type, origin: h.base }, body);
      assert.equal(v2.status, 415, type); assert.equal(v2.json.error.code, 'validation_failed'); assert.deepEqual(v2.json.error.details, [{ issue: 'content-type' }]);
      assert.equal((await raw(`/api/v3/flows/${JOB}/runs`, { 'content-type': type, origin: h.base }, body)).status, 415, 'v3 ' + type);
    }
    assert.equal(restarts(), r0); assert.equal(runs(), c0);
  });

  it('JSON with a foreign Origin → 403 csrf; JSON with no Origin, no Referer and no X-AO-Request → 403; nothing runs', async () => {
    const r0 = restarts();
    const foreign = await raw('/api/v2/gateway/restart', { 'content-type': 'application/json', origin: 'http://evil.example' }, '{"confirm":"redemarrer"}');
    assert.equal(foreign.status, 403); assert.deepEqual(foreign.json.error.details, [{ issue: 'csrf' }]);
    const bare = await raw('/api/v2/gateway/restart', { 'content-type': 'application/json' }, '{"confirm":"redemarrer"}');
    assert.equal(bare.status, 403);
    const badRef = await raw('/api/v2/gateway/restart', { 'content-type': 'application/json', referer: 'http://evil.example/x' }, '{"confirm":"redemarrer"}');
    assert.equal(badRef.status, 403);
    assert.equal(restarts(), r0);
  });

  it('allowed: same-origin Origin, a same-origin Referer, or X-AO-Request; a body-less write needs the header', async () => {
    assert.equal((await raw('/api/v2/prefs', { 'content-type': 'application/json', origin: h.base }, '{"uiTheme":"dark"}', 'PATCH')).status, 200);
    assert.equal((await raw('/api/v2/prefs', { 'content-type': 'application/json', referer: h.base + '/v2/' }, '{"uiTheme":"dark"}', 'PATCH')).status, 200);
    assert.equal((await raw('/api/v2/prefs', { 'content-type': 'application/json', 'x-ao-request': '1' }, '{"uiTheme":"dark"}', 'PATCH')).status, 200);
    assert.equal((await raw('/api/logout', { origin: h.base })).status, 415, 'no body, no header: refused');
    assert.equal((await raw('/api/logout', { 'x-ao-request': '1' })).status, 200);
  });

  it('login: JSON only; the urlencoded parser is gone', async () => {
    const r = await fetch(h.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
    assert.equal(r.status, 415);
  });
});
