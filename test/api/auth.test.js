'use strict';
/*
 * R1-08, for the API that remains after S16 (moved from test/characterisation/auth.test.js, which covered v1): every
 * protected route of /api/v2 and /api/v3 (reads, writes, streams) refuses missing, tampered, expired, wrong-secret and
 * malformed cookies with 401 (never 500), and an unauthenticated write never reaches the CLI or the gateway. The table
 * is checked against the routes the code declares, so a route cannot be added without a negative test (or without
 * being listed as public on purpose).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

// the protected routes, each with a concrete path (under /api/v2 and /api/v3)
const PROTECTED = [
  ['GET', '/me'], ['GET', '/views/health'], ['PUT', '/health/issues/x/muted'], ['GET', '/shots/x.png'],
  ['GET', '/stream'], ['POST', '/stream/x/topics'], ['POST', '/stream/x/resync'],
  ['GET', '/views/office'], ['GET', '/views/flows'], ['GET', '/views/flows/x'], ['GET', '/views/logs'], ['GET', '/views/sessions/agent%3Amain%3Amain'],
  ['GET', '/views/access'], ['GET', '/views/interlocutors/x'], ['GET', '/views/skills'], ['GET', '/views/skills/weather'], ['GET', '/views/chat'],
  ['POST', '/flows'], ['PATCH', '/flows/x'], ['PUT', '/flows/x/enabled'], ['POST', '/flows/x/runs'], ['DELETE', '/flows/x'],
  ['PUT', '/skills/weather/enabled'], ['POST', '/gateway/restart'], ['POST', '/chat/messages'],
  ['GET', '/office/layout'], ['GET', '/office/layout/revisions/1'], ['PUT', '/office/layout'], ['PUT', '/office/layout/theme'], ['GET', '/prefs'], ['PATCH', '/prefs'],
  ['GET', '/views/projects'], ['GET', '/views/projects/x/history'], ['GET', '/views/projects/x'], ['GET', '/views/project-candidates'],
  ['POST', '/projects'], ['POST', '/projects/import'], ['PATCH', '/projects/x'], ['PUT', '/projects/x/status'], ['PUT', '/projects/x/archived'],
  ['POST', '/projects/x/flags'], ['DELETE', '/projects/x/flags/risk/k'], ['PUT', '/projects/x/flags/risk/k/ack'], ['POST', '/projects/x/sources'],
  ['DELETE', '/projects/x/sources/s'], ['PUT', '/projects/x/people/p'], ['POST', '/projects/x/history'], ['POST', '/projects/x/summary/regenerate'],
  ['GET', '/project-covers/x.svg'], ['POST', '/projects/x/cover/regenerate'], ['PUT', '/projects/x/cover'],
  ['POST', '/projects/x/comments/c/retry'], ['GET', '/views/projects/x/comments'], ['POST', '/projects/x/comments'], ['PATCH', '/projects/x/comments/c'], ['DELETE', '/projects/x/comments/c'],   // architect-57
];
// public on purpose: the bootstrap (meta) and first-run setup (its own one-time code; locked once configured)
const PUBLIC = new Set(['GET /meta', 'GET /setup', 'POST /setup/check', 'POST /setup/discover', 'PUT /setup', 'GET /setup/catalog', 'POST /setup/resume', 'POST /setup/owner', 'POST /setup/detect', 'POST /setup/integrations/plan', 'POST /setup/integrations/apply', 'POST /setup/network']);

// the routes the code declares: `r.<method>('<path>', …)` in src/api/v2/*.js, with whether `authed` guards them
function declared() {
  const dir = path.join(__dirname, '..', '..', 'src', 'api', 'v2');
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const m = /\br\.(get|post|put|patch|delete)\('([^']+)',\s*(authed\b)?/.exec(line);
      if (m) out.push({ route: `${m[1].toUpperCase()} ${m[2]}`, authed: !!m[3], file: f });
    }
  }
  return out;
}
const template = (p) => p.split('?')[0];
const matches = (route, [method, p]) => {
  const [m, tpl] = route.split(' ');
  if (m !== method) return false;
  const re = new RegExp('^' + tpl.replace(/:[A-Za-z]+/g, '[^/]+') + '$');
  return re.test(template(p));
};

function sign(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

describe('auth: every protected v2/v3 route refuses bad cookies', () => {
  let h, cookies;
  before(async () => {
    const sc = loadScenario('synthetic-basic');
    h = await startServer(sc);
    h.now = sc.now;   // the server under test runs on the scenario's frozen clock
    const good = sign(h.secret, { email: 'test@example.invalid', exp: sc.now + 3600e3 });
    const [b, m] = good.split('.');
    cookies = {
      missing: null,
      tampered: (b.slice(0, -2) + (b.endsWith('A') ? 'BB' : 'AA')) + '.' + m,
      expired: sign(h.secret, { email: 'test@example.invalid', exp: sc.now - 1000 }),
      'wrong-secret': sign('not-the-secret', { email: 'test@example.invalid', exp: sc.now + 3600e3 }),
      'no-exp': sign(h.secret, { email: 'test@example.invalid' }),
      malformed: '%E0%A4%A',
      garbage: 'a.b.c',
      empty: '',
      'json-null': (() => { const nb = Buffer.from('null').toString('base64url'); return nb + '.' + crypto.createHmac('sha256', h.secret).update(nb).digest('base64url'); })(),
    };
  });
  after(async () => { if (h) await h.stop(); });

  it('the table covers every declared route: each is authed and tested, or public on purpose', () => {
    const routes = declared();
    assert.ok(routes.length >= PROTECTED.length, 'routes found');
    const unguarded = routes.filter((r) => !r.authed && !PUBLIC.has(r.route)).map((r) => r.route + ' (' + r.file + ')');
    assert.deepEqual(unguarded, [], 'a route without `authed` must be listed as PUBLIC');
    const untested = routes.filter((r) => r.authed && !PROTECTED.some((p) => matches(r.route, p))).map((r) => r.route);
    assert.deepEqual(untested, [], 'every authed route has a negative test');
  });

  for (const version of ['v2', 'v3']) {
    for (const [method, p] of PROTECTED) {
      it(`${method} /api/${version}${p} → 401 for missing, tampered, expired, wrong-secret, malformed cookies`, async () => {
        for (const [name, value] of Object.entries(cookies)) {
          const headers = { 'content-type': 'application/json', 'x-ao-request': '1' };   // what the UI sends (R15-01): this tests authentication, not CSRF
          if (value !== null) headers.cookie = 'taco_sess=' + value;
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 3000);   // an accepted stream would otherwise never end
          const r = await fetch(`${h.base}/api/${version}${p}`, { method, headers, body: method === 'GET' ? undefined : '{"name":"x","enabled":true,"message":"x"}', signal: ac.signal });
          const text = r.status === 401 ? await r.text() : '(not 401)';
          clearTimeout(timer); ac.abort();
          assert.equal(r.status, 401, `${name}: got ${r.status} ${text.slice(0, 80)}`);
          const j = JSON.parse(text);
          assert.ok(j.error === 'unauthorized' || (j.error && j.error.code === 'unauthorized'), name + ' ' + text.slice(0, 120));
        }
      });
    }
  }

  it('/api/me (kept for the /v2 UI) refuses them too', async () => {
    for (const [name, value] of Object.entries(cookies)) {
      const r = await fetch(h.base + '/api/me', { headers: value === null ? {} : { cookie: 'taco_sess=' + value } });
      assert.equal(r.status, 401, name);
    }
  });

  it('unauthenticated writes reached neither the CLI nor the gateway', () => {
    assert.deepEqual(h.cliCalls().filter((a) => a[0] !== 'skills'), []);
    assert.equal(h.gw.callsTo('gateway.restart.request').length, 0);
  });

  it('a valid cookie still works (control)', async () => {
    const cookie = 'taco_sess=' + sign(h.secret, { email: 'test@example.invalid', exp: h.now + 60e3 });
    for (const p of ['/api/v2/me', '/api/v3/me', '/api/me']) assert.equal((await fetch(h.base + p, { headers: { cookie } })).status, 200, p);
  });

  it('login: wrong credentials 401, cookie attributes HttpOnly + SameSite=Lax + Path=/; logout clears it', async () => {
    const bad = await fetch(h.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"test@example.invalid","password":"nope"}' });
    assert.equal(bad.status, 401);
    const ok = await fetch(h.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"TEST@example.invalid","password":"test-password"}' });
    const sc = ok.headers.get('set-cookie');
    assert.match(sc, /^taco_sess=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=43200$/);
    const out = await fetch(h.base + '/api/logout', { method: 'POST', headers: { 'x-ao-request': '1' } });
    assert.match(out.headers.get('set-cookie'), /^taco_sess=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/);
  });
});
