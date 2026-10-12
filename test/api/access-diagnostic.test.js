'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createApp } = require('../../src/api/http');
const { createCsrfGuard } = require('../../src/api/csrf');
const { createResourceRegistry } = require('../../src/security/resources');
const { createAccessBoundary } = require('../../src/security/access-boundary');
const { mountAccessDiagnostic } = require('../../src/api/access-check');
const { createExternalAccessService, createBootAccessRuntime } = require('../../src/access/service');

const draft = require('../../docs/architecture/examples/v3/external-access-vm.json').data.draft;
const installationId = 'install-diagnostic-test';
const activeRevision = 9;
const allowedOrigin = draft.uiOrigins[0];

function dnsObservation(hostname) {
  const records = { A: [{ value: '8.8.8.8', ttl: 60 }], AAAA: [], CNAME: [], NS: [] };
  return { hostname, zone: 'example.org', observedAt: 1, elapsedMs: 1,
    provider: { id: 'unknown', confidence: 'unknown', evidence: [] },
    resolvers: ['google', 'cloudflare'].map(id => ({ id, state: 'answered', records })), records };
}

async function application(createDependencies) {
  let server;
  const runtimeRequester = async input => {
    const routedPath = input.path.startsWith('/backend/') ? input.path.slice('/backend'.length) : input.path;
    const url = new URL(routedPath, server.address.url);
    const response = await fetch(url, { method: input.method, headers: input.headers, body: input.body });
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
  };
  const deps = createDependencies(runtimeRequester);
  const store = { registry: createResourceRegistry() };
  const auth = { sessionOf: () => null };
  const boundary = () => createAccessBoundary({ installationId, apiPublicUrl: draft.apiPublicUrl, origins: draft.uiOrigins });
  const app = createApp({ readonly: false, apiOnly: true, publicDir: path.resolve('public'), routeSecurity: { store, auth },
    csrf: createCsrfGuard(), mountRoutes(router) { mountAccessDiagnostic(router, { externalAccess: deps.service, boundary, store, auth }); } });
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve({ listener, address: { url: `http://127.0.0.1:${listener.address().port}` } }));
  });
  return { ...deps, server, close: async () => { deps.service.close(); await new Promise(resolve => server.listener.close(resolve)); } };
}

test('mounted CORS diagnostic is single-use and the nonce is bound to the live plan/session job', async () => {
  const f = await application(requester => {
    const settings = { revision: () => 1, accessConfig: () => draft, accessRevision: () => activeRevision };
    const accessRuntime = createBootAccessRuntime({ access: draft, accessRevision: activeRevision, splitAuthEnabled: true,
      apiPublicUrl: draft.apiPublicUrl, allowedOrigins: draft.uiOrigins });
    const service = createExternalAccessService({ settings, cfg: { access: draft, accessRevision: activeRevision, accessRuntime }, installationId,
      env: { AO_ENV: 'test' }, inspector: { inspect: async hostname => dnsObservation(hostname) }, requester,
      randomBytes: size => Buffer.alloc(size, 0x2a) });
    return { service };
  });
  try {
    const req = { user: { id: 'usr_diag' }, session: { sid: 'sid-diag-a' } };
    const preflight = await fetch(new URL('/api/auth/access-diagnostic', f.server.address.url), { method: 'OPTIONS', headers: {
      Origin: allowedOrigin, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,x-ao-csrf,x-ao-request' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null, 'diagnostic CORS remains credentialless');
    assert.deepEqual(preflight.headers.get('access-control-allow-headers').split(',').map(value => value.trim()).sort(),
      ['authorization', 'content-type', 'x-ao-csrf', 'x-ao-request']);
    const plan = await f.service.createPlan({ req, draft, expectedRevision: 1 });
    const missingNonce = await fetch(new URL('/api/auth/access-diagnostic', f.server.address.url), { method: 'POST',
      headers: { Origin: allowedOrigin, 'Content-Type': 'application/json', 'X-AO-Request': '1' }, body: JSON.stringify({ planId: plan.planId }) });
    assert.equal(missingNonce.status, 400);
    const started = f.service.startChecks({ req, planId: plan.planId, checks: ['cors'] });
    let result;
    for (let i = 0; i < 100; i++) {
      result = f.service.status({ req, jobId: started.jobId });
      if (result.state !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(result.state, 'passed');
    assert.equal(result.checks[0].state, 'passed');
    assert.throws(() => f.service.status({ req: { user: req.user, session: { sid: 'sid-diag-b' } }, jobId: started.jobId }), { code: 'not_found' },
      'a different session for the same person cannot read or reuse the diagnostic job');

    const reused = await fetch(new URL('/api/auth/access-diagnostic', f.server.address.url), {
      method: 'POST', headers: { Origin: allowedOrigin, 'Content-Type': 'application/json', 'X-AO-Request': '1' },
      body: JSON.stringify({ nonce: '2a'.repeat(32), planId: plan.planId }),
    });
    assert.equal(reused.status, 404, 'a consumed nonce cannot be replayed');
  } finally { await f.close(); }
});

test('diagnostic challenge rejects a nonce presented for a different plan and an unlisted origin', async () => {
  let captured;
  const f = await application(requester => {
    const accessRuntime = createBootAccessRuntime({ access: draft, accessRevision: activeRevision, splitAuthEnabled: true,
      apiPublicUrl: draft.apiPublicUrl, allowedOrigins: draft.uiOrigins });
    const service = createExternalAccessService({ settings: { revision: () => 1, accessConfig: () => draft }, cfg: { access: draft, accessRevision: activeRevision, accessRuntime },
      installationId, env: { AO_ENV: 'test' }, inspector: { inspect: async hostname => dnsObservation(hostname) },
      requester: async input => { if (input.method === 'POST') captured = JSON.parse(input.body); return requester(input); },
      randomBytes: size => Buffer.alloc(size, 0x3b) });
    return { service };
  });
  try {
    const req = { user: { id: 'usr_diag_other' }, session: { sid: 'sid-diag-c' } };
    const plan = await f.service.createPlan({ req, draft, expectedRevision: 1 });
    const started = f.service.startChecks({ req, planId: plan.planId, checks: ['cors'] });
    for (let i = 0; i < 100; i++) { const state = f.service.status({ req, jobId: started.jobId }); if (state.state !== 'running') break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.ok(captured);
    const wrongPlan = await fetch(new URL('/api/auth/access-diagnostic', f.server.address.url), { method: 'POST',
      headers: { Origin: allowedOrigin, 'Content-Type': 'application/json', 'X-AO-Request': '1' },
      body: JSON.stringify({ ...captured, planId: 'acp_' + 'f'.repeat(32) }) });
    assert.equal(wrongPlan.status, 404);
    const wrongOrigin = await fetch(new URL('/api/auth/access-diagnostic', f.server.address.url), { method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json', 'X-AO-Request': '1' },
      body: JSON.stringify(captured) });
    assert.equal(wrongOrigin.status, 403);
  } finally { await f.close(); }
});
