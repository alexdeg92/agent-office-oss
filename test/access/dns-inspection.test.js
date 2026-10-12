'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDnsInspector, canonicalDomain, detectProvider, RESOLVERS, TYPES, MAX_QUERIES_PER_INSPECTION, providers } = require('../../src/access/dns-inspection');

function reply(name, type, answers = [], status = 0) {
  return new Response(JSON.stringify({ Status: status, Question: [{ name: name + '.', type: TYPES[type] }], Answer: answers }), {
    headers: { 'content-type': 'application/dns-json' },
  });
}
function fixture({ fail = null } = {}) {
  const calls = [];
  const fetcher = async (raw, options) => {
    const url = new URL(raw), resolver = RESOLVERS.find(row => row.endpoint === url.origin + url.pathname)?.id;
    const name = url.searchParams.get('name'), rawType = url.searchParams.get('type'), type = TYPES[rawType] ? rawType : Object.keys(TYPES).find(key => TYPES[key] === Number(rawType));
    calls.push({ resolver, name, type, options });
    if (fail === resolver + ':' + type) return new Response('bad', { headers: { 'content-type': 'text/plain' } });
    if (type === 'NS' && name === 'example.org') return reply(name, type, [{ name: name + '.', type: TYPES.NS, TTL: 86400, data: 'ada.ns.cloudflare.com.' }]);
    if (type === 'A') return reply(name, type, [{ name: name + '.', type: TYPES.A, TTL: 300, data: '203.0.113.42' }]);
    return reply(name, type);
  };
  return { fetcher, calls };
}

test('canonical hostname input is strict and provider matching uses DNS-label boundaries', () => {
  assert.equal(canonicalDomain('API.Example.org.'), 'api.example.org');
  for (const value of ['localhost', '127.0.0.1', 'api.example.org/path', 'api.example.org:443', '*.example.org', 'api..example.org', 'api.example.org ', 'a'.repeat(64) + '.org']) assert.throws(() => canonicalDomain(value), { code: 'EDOMAIN' }, value);
  assert.equal(detectProvider(['x.ns.cloudflare.com']).id, 'cloudflare');
  assert.equal(detectProvider(['ns.notcloudflare.com']).id, 'unknown');
  assert.equal(detectProvider(['ns-123.awsdns-45.co.uk']).id, 'route53');
  assert.equal(providers.at(-1).id, 'unknown');
});

test('DNS inspection queries only the two fixed public resolvers and returns bounded normalized evidence without writes', async () => {
  const f = fixture();
  const result = await createDnsInspector({ env: { AO_ENV: 'test' }, fetcher: f.fetcher, now: () => 1791288000000 }).inspect('API.example.org');
  assert.equal(result.hostname, 'api.example.org');
  assert.equal(result.provider.id, 'cloudflare');
  assert.equal(result.provider.confidence, 'high');
  assert.deepEqual(result.provider.evidence.map(row => row.resolver).sort(), ['cloudflare', 'google']);
  assert.deepEqual(result.records.A.map(row => row.value), ['203.0.113.42']);
  assert.deepEqual(result.resolvers.map(row => row.state), ['answered', 'answered']);
  assert.equal(f.calls.length, 7, 'two host record queries per resolver plus bounded NS ancestor walk and second-resolver cross-check');
  assert.ok(f.calls.every(call => RESOLVERS.some(row => row.id === call.resolver)));
  assert.ok(f.calls.filter(call => ['A', 'AAAA'].includes(call.type)).every(call => call.name === 'api.example.org'));
  assert.ok(f.calls.filter(call => call.type === 'NS').every(call => ['api.example.org', 'example.org'].includes(call.name)));
  assert.ok(f.calls.every(call => call.options.redirect === 'error' && call.options.cache === 'no-store'));
});

test('NS delegation walk is capped within the total resolver query budget', async () => {
  const f = fixture();
  const result = await createDnsInspector({ env: { AO_ENV: 'test' }, fetcher: f.fetcher }).inspect('deep.api.example.org');
  assert.equal(result.zone, 'example.org');
  assert.equal(f.calls.length, 8);
  assert.ok(f.calls.length <= MAX_QUERIES_PER_INSPECTION);
});

test('unrelated DNS answer owners are rejected and inconsistent delegation is never provider evidence', async () => {
  const f = fixture();
  const original = f.fetcher;
  f.fetcher = async (raw, options) => {
    const url = new URL(raw), name = url.searchParams.get('name'), type = url.searchParams.get('type');
    if (url.origin === new URL(RESOLVERS[1].endpoint).origin && type === 'NS' && name === 'example.org') {
      return reply(name, 'NS', [{ name: name + '.', type: TYPES.NS, TTL: 86400, data: 'bob.ns.cloudflare.com.' }]);
    }
    return original(raw, options);
  };
  const result = await createDnsInspector({ env: { AO_ENV: 'test' }, fetcher: f.fetcher }).inspect('api.example.org');
  assert.equal(result.provider.id, 'unknown');
  assert.equal(result.provider.confidence, 'unknown');
  const hostile = async raw => {
    const url = new URL(raw), name = url.searchParams.get('name'), type = url.searchParams.get('type');
    if (type === 'A') return reply(name, type, [{ name: 'unrelated.example.net.', type: TYPES.A, TTL: 300, data: '203.0.113.42' }]);
    if (type === 'NS' && name === 'example.org') return reply(name, type, [{ name: name + '.', type: TYPES.NS, TTL: 86400, data: 'ada.ns.cloudflare.com.' }]);
    return reply(name, type);
  };
  const rejected = await createDnsInspector({ env: { AO_ENV: 'test' }, fetcher: hostile }).inspect('api.example.org');
  assert.equal(rejected.resolvers[0].state, 'invalid-response');
  assert.deepEqual(rejected.records.A, []);
});

test('valid CNAME-to-address chains are retained and delegated host zones beat parent NS data', async () => {
  const fetcher = async raw => {
    const url = new URL(raw), name = url.searchParams.get('name'), type = url.searchParams.get('type');
    if (type === 'NS' && name === 'tenant.example.org') return reply(name, type, [{ name: name + '.', type: TYPES.NS, TTL: 86400, data: 'alpha.ns.cloudflare.com.' }]);
    if (type === 'A') return reply(name, type, [
      { name: name + '.', type: TYPES.CNAME, TTL: 300, data: 'edge.example.org.' },
      { name: 'edge.example.org.', type: TYPES.A, TTL: 300, data: '203.0.113.9' },
    ]);
    if (type === 'CNAME') return reply(name, type, [{ name: name + '.', type: TYPES.CNAME, TTL: 300, data: 'edge.example.org.' }]);
    return reply(name, type);
  };
  const result = await createDnsInspector({ env: { AO_ENV: 'test' }, fetcher }).inspect('tenant.example.org');
  assert.equal(result.zone, 'tenant.example.org');
  assert.equal(result.provider.id, 'cloudflare');
  assert.deepEqual(result.records.CNAME.map(row => [row.name, row.value]), [['tenant.example.org', 'edge.example.org']]);
  assert.deepEqual(result.records.A.map(row => [row.name, row.value]), [['edge.example.org', '203.0.113.9']]);
});

test('mixed DNS failures produce deterministic resolver state independent of parallel resolver completion', async () => {
  const makeFetcher = reverse => async raw => {
    const url = new URL(raw), resolver = RESOLVERS.find(row => row.endpoint === url.origin + url.pathname)?.id;
    const type = url.searchParams.get('type'), name = url.searchParams.get('name');
    if (type === 'A') { await new Promise(resolve => setTimeout(resolve, resolver === (reverse ? 'google' : 'cloudflare') ? 2 : 12)); throw new Error('query timeout'); }
    if (type === 'AAAA') { await new Promise(resolve => setTimeout(resolve, resolver === (reverse ? 'cloudflare' : 'google') ? 2 : 12)); return new Response('bad', { headers: { 'content-type': 'text/plain' } }); }
    if (type === 'NS' && name === 'example.org') return reply(name, type, [{ name: name + '.', type: TYPES.NS, TTL: 86400, data: 'ada.ns.cloudflare.com.' }]);
    return reply(name, type);
  };
  const run = reverse => createDnsInspector({ env: { AO_ENV: 'test' }, fetcher: makeFetcher(reverse) }).inspect('api.example.org');
  const [a, b] = await Promise.all([run(false), run(true)]);
  assert.deepEqual(a.resolvers.map(row => row.state), ['timeout', 'timeout']);
  assert.deepEqual(b.resolvers.map(row => row.state), ['timeout', 'timeout']);
  assert.equal(a.provider.id, 'unknown'); assert.equal(b.provider.id, 'unknown');
});

test('resolver failures are typed and a single resolver never establishes provider identity', async () => {
  const f = fixture({ fail: 'cloudflare:NS' });
  const result = await createDnsInspector({ env: { AO_ENV: 'test' }, fetcher: f.fetcher }).inspect('api.example.org');
  assert.equal(result.resolvers.find(row => row.id === 'cloudflare').state, 'invalid-response');
  assert.equal(result.provider.id, 'unknown');
  assert.equal(result.provider.confidence, 'unknown');
  assert.deepEqual(result.provider.evidence, []);
});

test('test mode refuses to fall through to real public DNS when the resolver fixture is missing', async () => {
  const inspector = createDnsInspector({ env: { AO_ENV: 'test' } });
  await assert.rejects(inspector.inspect('api.example.org'), { code: 'ETESTPROBE' });
});
