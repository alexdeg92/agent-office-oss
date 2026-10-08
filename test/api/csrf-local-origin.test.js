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
});
