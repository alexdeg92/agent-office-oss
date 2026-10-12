'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAccessProbes, isPublicAddress, resolverAddresses, originAllowed } = require('../../src/access/probes');

function observation(addresses = ['8.8.8.8']) {
  const records = { A: addresses.filter(value => value.includes('.')).map(value => ({ value })),
    AAAA: addresses.filter(value => value.includes(':')).map(value => ({ value })) };
  return { resolvers: ['google', 'cloudflare'].map(id => ({ id, state: 'answered', records })) };
}
const draft = { apiPublicUrl: 'https://api.example.org/backend', domain: 'example.org', uiOrigins: ['https://office.example.org'] };

test('public address classifier blocks special, private, mapped and reserved IPv4/IPv6 ranges', () => {
  for (const value of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '192.0.2.1', '198.51.100.1',
    '203.0.113.5', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(value), false, value);
  for (const value of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(value), true, value);
});

test('HTTPS probe pins an agreed public answer, preserves host and refuses redirects', async () => {
  let request;
  const probes = createAccessProbes({ env: { AO_ENV: 'test' }, inspector: { inspect: async host => { assert.equal(host, 'api.example.org'); return observation(); } },
    requester: async input => { request = input; return { status: 200, headers: {}, body: '' }; } });
  const result = await probes.run({ draft, kind: 'tls', signal: new AbortController().signal });
  assert.equal(result.state, 'passed');
  assert.deepEqual({ host: request.host, address: request.address, path: request.path, method: request.method, rejectUnauthorized: request.rejectUnauthorized, redirect: request.redirect },
    { host: 'api.example.org', address: '8.8.8.8', path: '/backend/healthz', method: 'GET', rejectUnauthorized: true, redirect: 'error' });
  const redirected = createAccessProbes({ env: { AO_ENV: 'test' }, inspector: { inspect: async () => observation() },
    requester: async () => ({ status: 307, headers: { location: 'https://127.0.0.1/' }, body: '' }) });
  assert.deepEqual((await redirected.run({ draft, kind: 'tls', signal: new AbortController().signal })).state, 'blocked');
});

test('CORS probe matches the diagnostic POST policy and rejects the former GET/legacy-header false positive', async () => {
  const requests = [];
  const headers = { 'access-control-allow-origin': 'https://office.example.org',
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers', 'access-control-allow-methods': 'POST',
    'access-control-allow-headers': 'authorization, content-type, x-ao-csrf, x-ao-request' };
  const probes = createAccessProbes({ env: { AO_ENV: 'test' }, inspector: { inspect: async () => observation() },
    requester: async input => { requests.push(input); return input.method === 'OPTIONS' ? { status: 204, headers, body: '' }
      : { status: 200, headers: {}, body: JSON.stringify({ nonce: 'a'.repeat(64), installationId: 'install-1', accessRevision: 9 }) }; } });
  const result = await probes.run({ draft, kind: 'cors', diagnostic: { nonce: 'a'.repeat(64), planId: 'acp_' + 'b'.repeat(32), installationId: 'install-1', accessRevision: 9 }, signal: new AbortController().signal });
  assert.equal(result.state, 'passed');
  assert.equal(requests[0].method, 'OPTIONS');
  assert.equal(requests[0].headers['Access-Control-Request-Method'], 'POST');
  assert.equal(requests[0].headers['Access-Control-Request-Headers'], 'authorization,content-type,x-ao-csrf,x-ao-request');
  assert.equal(requests[0].headers.Origin, 'https://office.example.org');
  assert.equal(requests[1].method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].body), { nonce: 'a'.repeat(64), planId: 'acp_' + 'b'.repeat(32) });
  const oldFalsePositive = { 'access-control-allow-origin': draft.uiOrigins[0], 'access-control-allow-credentials': 'true',
    vary: 'Origin', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, x-csrf-token' };
  const misleading = createAccessProbes({ env: { AO_ENV: 'test' }, inspector: { inspect: async () => observation() },
    requester: async () => ({ status: 204, headers: oldFalsePositive, body: '' }) });
  assert.equal((await misleading.run({ draft, kind: 'cors', signal: new AbortController().signal })).state, 'failed');
  assert.equal(originAllowed({ ...headers, vary: 'Origin' }, draft.uiOrigins[0]), false);
  assert.equal(originAllowed({ ...headers, 'access-control-allow-credentials': 'true' }, draft.uiOrigins[0]), false);
});

test('CORS diagnostic fails closed on nonce, installation or active-revision mismatch', async () => {
  const headers = { 'access-control-allow-origin': draft.uiOrigins[0],
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers', 'access-control-allow-methods': 'POST',
    'access-control-allow-headers': 'authorization, content-type, x-ao-csrf, x-ao-request' };
  for (const body of [
    { nonce: 'c'.repeat(64), installationId: 'install-1', accessRevision: 9 },
    { nonce: 'a'.repeat(64), installationId: 'other-install', accessRevision: 9 },
    { nonce: 'a'.repeat(64), installationId: 'install-1', accessRevision: 8 },
    null,
  ]) {
    let call = 0;
    const probes = createAccessProbes({ env: { AO_ENV: 'test' }, inspector: { inspect: async () => observation() },
      requester: async () => call++ === 0 ? { status: 204, headers, body: '' } : { status: 200, headers: {}, body: body && JSON.stringify(body) } });
    assert.equal((await probes.run({ draft, kind: 'cors', diagnostic: { nonce: 'a'.repeat(64), planId: 'acp_' + 'b'.repeat(32), installationId: 'install-1', accessRevision: 9 }, signal: new AbortController().signal })).state, 'failed');
  }
});

test('probes fail closed on resolver disagreement, any unsafe address and out-of-domain target', async () => {
  const mismatch = observation(['8.8.8.8']); mismatch.resolvers[1].records = { A: [{ value: '1.1.1.1' }], AAAA: [] };
  assert.equal(resolverAddresses(mismatch).state, 'unknown');
  let calls = 0;
  const blocked = createAccessProbes({ env: { AO_ENV: 'test' }, inspector: { inspect: async () => { calls++; return observation(['8.8.8.8', '10.1.2.3']); } }, requester: async () => { throw new Error('must not connect'); } });
  assert.equal((await blocked.run({ draft, kind: 'tls', signal: new AbortController().signal })).state, 'blocked');
  const outside = { ...draft, apiPublicUrl: 'https://api.example.net' };
  assert.equal((await blocked.run({ draft: outside, kind: 'tls', signal: new AbortController().signal })).state, 'blocked');
  assert.equal(calls, 1);
});
