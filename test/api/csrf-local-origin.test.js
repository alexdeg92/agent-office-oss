'use strict';
// R16-04: a one-port install allows the origin the browser used, or AO_PUBLIC_URL.
// A foreign Origin stays refused.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createCsrfGuard } = require('../../src/api/csrf');
const { proxyHeaders } = require('../../packaging/bin/combined');

function invoke(guard, headers, remoteAddress = '127.0.0.1') {
  const req = {
    method: 'PATCH',
    path: '/api/v2/prefs',
    headers,
    protocol: 'http',
    socket: { remoteAddress },
    get(name) { return headers[String(name).toLowerCase()]; },
  };
  let status = null;
  let nexted = false;
  const res = {
    headersSent: false,
    status(code) { status = code; return this; },
    json() { return this; },
    type() { return this; },
    send() { return this; },
    setHeader() {},
  };
  guard(req, res, () => { nexted = true; });
  return { status, nexted };
}

const cookie = { cookie: 'taco_sess=abc', 'content-type': 'application/json', 'content-length': '2' };

describe('csrf one-port origin', () => {
  it('allows the loopback Host the browser used, and refuses a foreign Origin', () => {
    const guard = createCsrfGuard();
    const local = invoke(guard, {
      ...cookie,
      host: '127.0.0.1:40000',
      'x-forwarded-host': '127.0.0.1:18789',
      origin: 'http://127.0.0.1:18789',
    });
    assert.equal(local.nexted, true);
    const named = invoke(guard, {
      ...cookie,
      host: '127.0.0.1:40000',
      'x-forwarded-host': 'localhost:18789',
      origin: 'http://localhost:18789',
    });
    assert.equal(named.nexted, true);
    const foreign = invoke(guard, {
      ...cookie,
      host: '127.0.0.1:40000',
      'x-forwarded-host': 'evil.example',
      origin: 'http://evil.example',
      'x-ao-request': '1',
    });
    assert.equal(foreign.nexted, false);
    assert.equal(foreign.status, 403);
    const offLoopback = invoke(guard, {
      ...cookie,
      host: '127.0.0.1:40000',
      'x-forwarded-host': '127.0.0.1:18789',
      origin: 'http://127.0.0.1:18789',
    }, '203.0.113.9');
    assert.equal(offLoopback.nexted, false);
    assert.equal(offLoopback.status, 403);
  });

  it('accepts the headers the one-port proxy actually forwards', () => {
    const forwarded = proxyHeaders({
      host: '127.0.0.1:18789',
      origin: 'http://127.0.0.1:18789',
      cookie: 'taco_sess=abc',
      'content-type': 'application/json',
      'content-length': '2',
      'x-forwarded-for': '203.0.113.9',
    }, { remoteAddress: '192.0.2.10', listenPort: 18789, apiPort: 40000 });
    const result = invoke(createCsrfGuard(), forwarded, '127.0.0.1');
    assert.equal(forwarded['x-forwarded-for'], '192.0.2.10');
    assert.equal(result.nexted, true);
  });

  it('allows the configured public origin when the Host is the private API port', () => {
    const guard = createCsrfGuard({ publicUrl: 'https://office.example' });
    const ok = invoke(guard, {
      ...cookie,
      host: '127.0.0.1:40000',
      origin: 'https://office.example',
    }, '172.30.0.2');
    assert.equal(ok.nexted, true);
    const foreign = invoke(guard, {
      ...cookie,
      host: '127.0.0.1:40000',
      origin: 'https://evil.example',
      'x-ao-request': '1',
    }, '172.30.0.2');
    assert.equal(foreign.status, 403);
  });

  it('fresh install behind an untrusted TLS proxy that keeps the Host: the https Origin of that Host is its own', () => {
    const warnings = [];
    const guard = createCsrfGuard({ warn: (m) => warnings.push(m) });
    const tls = invoke(guard, { ...cookie, host: 'office.example', origin: 'https://office.example' }, '198.51.100.7');
    assert.equal(tls.nexted, true);
    const otherHost = invoke(guard, { ...cookie, host: 'office.example', origin: 'https://evil.example', 'x-ao-request': '1' }, '198.51.100.7');
    assert.equal(otherHost.status, 403);
    assert.deepEqual(warnings.length, 1);
  });

  it('a proxy that rewrites the Host is refused once with the AO_PUBLIC_URL to set, then quietly', () => {
    const warnings = [];
    const guard = createCsrfGuard({ warn: (m) => warnings.push(m) });
    const req = { ...cookie, host: '127.0.0.1:3300', origin: 'https://office.example' };
    assert.equal(invoke(guard, req, '198.51.100.7').status, 403);
    assert.equal(invoke(guard, req, '198.51.100.7').status, 403);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /AO_PUBLIC_URL=https:\/\/office\.example/);
    assert.match(warnings[0], /http:\/\/127\.0\.0\.1:3300/);
    const configured = [];
    invoke(createCsrfGuard({ publicUrl: 'https://office.example', warn: (m) => configured.push(m) }), { ...req, origin: 'https://evil.example', 'x-ao-request': '1' }, '198.51.100.7');
    assert.equal(configured.length, 0, 'an operator who set AO_PUBLIC_URL is not told to set it');
  });
});

describe('csrf · origins saved by the setup wizard', () => {
  it('accepts the saved public origins (network step, same-origin or tunnel access) and nothing else', () => {
    const IC = require('../../src/instance-config');
    assert.deepEqual(IC.savedOrigins({ network: { publicUrl: 'https://legacy.example' } }), ['https://legacy.example']);
    assert.deepEqual(IC.savedOrigins({ access: { mode: 'public-same-origin', apiPublicUrl: 'https://office.example/backend' } }), ['https://office.example/backend']);
    assert.deepEqual(IC.savedOrigins({ access: { mode: 'tunnel', apiPublicUrl: 'https://tunnel.example' } }), ['https://tunnel.example']);
    assert.deepEqual(IC.savedOrigins({ access: { mode: 'public-split-origin', apiPublicUrl: 'https://api.example' } }), [], 'split origin authenticates with bearer tokens');
    assert.deepEqual(IC.savedOrigins(null), []);
    const guard = createCsrfGuard({ origins: IC.savedOrigins({ access: { mode: 'public-same-origin', apiPublicUrl: 'https://office.example/backend' } }) });
    const req = { ...cookie, host: '127.0.0.1:40000' };
    assert.equal(invoke(guard, { ...req, origin: 'https://office.example' }, '198.51.100.7').nexted, true);
    assert.equal(invoke(guard, { ...req, origin: 'https://evil.example', 'x-ao-request': '1' }, '198.51.100.7').status, 403);
  });
});

describe('csrf · the refusal hint never turns a request Origin into a copyable shell assignment (review LOW)', () => {
  it('prints AO_PUBLIC_URL=<origin> only for a plain host; shell metacharacters get generic guidance and a quoted origin', () => {
    const hostile = ['https://$(id).example.invalid', 'https://`id`.example.invalid', 'https://a;b.example.invalid', 'https://a"b.example.invalid', "https://a'b.example.invalid"];
    const warnings = [];
    const guard = createCsrfGuard({ warn: (m) => warnings.push(m) });
    for (const origin of hostile) invoke(guard, { ...cookie, host: '127.0.0.1:3300', origin }, '198.51.100.7');
    assert.equal(warnings.length, hostile.length);
    for (const line of warnings) {
      assert.doesNotMatch(line, /AO_PUBLIC_URL=\S/, line);
      assert.match(line, /set AO_PUBLIC_URL to its public origin/);
      assert.match(line, /refused writes from "/, 'the untrusted origin is shown quoted, as data');
    }
    const plain = [];
    const ok = createCsrfGuard({ warn: (m) => plain.push(m) });
    for (const origin of ['https://office.example.invalid:8443', 'http://192.0.2.10:3300']) invoke(ok, { ...cookie, host: '127.0.0.1:3300', origin }, '198.51.100.7');
    assert.match(plain[0], /set AO_PUBLIC_URL=https:\/\/office\.example\.invalid:8443 and restart/);
    assert.match(plain[1], /set AO_PUBLIC_URL=http:\/\/192\.0\.2\.10:3300 and restart/);
  });
});
