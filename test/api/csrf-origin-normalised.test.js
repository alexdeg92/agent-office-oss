'use strict';
// Review-17 R17-04: the CSRF origin check compares NORMALISED origins on both sides (scheme, lower-cased host,
// IPv6 brackets and compression, effective port), so a bracketed IPv6 one-port install isn't refused.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createCsrfGuard } = require('../../src/api/csrf');
const { proxyHeaders } = require('../../packaging/bin/combined');

function invoke(guard, headers, remoteAddress = '127.0.0.1') {
  const req = { method: 'PATCH', path: '/api/v2/prefs', headers, protocol: 'http', socket: { remoteAddress },
    get(name) { return headers[String(name).toLowerCase()]; } };
  let status = null, nexted = false;
  const res = { headersSent: false, status(c) { status = c; return this; }, json() { return this; }, setHeader() {} };
  guard(req, res, () => { nexted = true; });
  return { status, nexted };
}
const base = { cookie: 'taco_sess=abc', 'content-type': 'application/json', 'content-length': '2' };
const pass = (g, h, ip) => assert.equal(invoke(g, Object.assign({}, base, h), ip).nexted, true, JSON.stringify(h));
const refused = (g, h, ip) => assert.equal(invoke(g, Object.assign({}, base, h), ip).status, 403, JSON.stringify(h));

describe('R17-04 · normalised origin comparison (IPv6, IPv4, hostnames)', () => {
  const g = createCsrfGuard();
  it('IPv6 one-port install: the bracketed loopback the browser used is allowed (from the loopback hop only)', () => {
    pass(g, { host: '127.0.0.1:40000', 'x-forwarded-host': '[::1]:18789', origin: 'http://[::1]:18789' }, '::1');
    pass(g, { host: '127.0.0.1:40000', 'x-forwarded-host': '[::1]:18789', origin: 'http://[0:0:0:0:0:0:0:1]:18789' }, '::1');
    const fwd = proxyHeaders(Object.assign({}, base, { host: '[::1]:18789', origin: 'http://[::1]:18789' }), { remoteAddress: '::1', listenPort: 18789, apiPort: 40000 });
    assert.equal(invoke(g, fwd, '127.0.0.1').nexted, true, 'the headers the one-port proxy really forwards');
    refused(g, { host: '127.0.0.1:40000', 'x-forwarded-host': '[::1]:18789', origin: 'http://[::1]:18789' }, '203.0.113.9');
    refused(g, { host: '127.0.0.1:40000', 'x-forwarded-host': '[::1]:18789', origin: 'http://[::1]:9999', 'x-ao-request': '1' }, '::1');
    refused(g, { host: '127.0.0.1:40000', 'x-forwarded-host': '[2001:db8::1]:18789', origin: 'http://[2001:db8::1]:18789' }, '::1');
  });
  it('the server\'s own origin is compared normalised (IPv6, case, default port)', () => {
    pass(g, { host: '[::1]:18789', origin: 'http://[::1]:18789' }, '203.0.113.9');
    pass(g, { host: '[2001:DB8::1]:8080', origin: 'http://[2001:db8:0::1]:8080' }, '203.0.113.9');
    pass(g, { host: 'Office.Example', origin: 'http://office.example' }, '203.0.113.9');
    pass(g, { host: 'office.example:80', origin: 'http://office.example' }, '203.0.113.9');
    pass(g, { host: '192.168.1.20:18789', origin: 'http://192.168.1.20:18789' }, '203.0.113.9');
    refused(g, { host: '192.168.1.20:18789', origin: 'http://192.168.1.21:18789', 'x-ao-request': '1' }, '203.0.113.9');
    refused(g, { host: 'office.example', origin: 'https://office.example' }, '203.0.113.9');   // scheme differs
    refused(g, { host: '[::1]:18789', origin: 'http://[::2]:18789' }, '203.0.113.9');
  });
  it('the configured public origin is normalised the same way', () => {
    const p = createCsrfGuard({ publicUrl: 'https://[2001:DB8::1]:443/office/' });
    pass(p, { host: '127.0.0.1:40000', origin: 'https://[2001:db8::1]' }, '172.30.0.2');
    const n = createCsrfGuard({ publicUrl: 'HTTPS://Office.Example:443' });
    pass(n, { host: '127.0.0.1:40000', origin: 'https://office.example' }, '172.30.0.2');
    refused(n, { host: '127.0.0.1:40000', origin: 'https://office.example:8443' }, '172.30.0.2');
  });
});
