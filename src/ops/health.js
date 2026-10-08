'use strict';
/*
 * G8 (docs/architecture/operations.md §1): liveness and readiness probes. Unauthenticated, never audited, no-store, and
 * no instance data: every value is from a closed set (examples/ops/).
 *   /healthz  the process serves HTTP; touches neither the store nor the runtime
 *   /readyz   200 when this process can serve its API (setup mode included; a runtime that is down still serves stale
 *             data), 503 only when the store is unusable
 *   /healthz/proxy  G11 (`agent-office doctor --url`): how THIS request reached the server, behind the operator's proxy:
 *             { secure, forwarded: 'none'|'trusted'|'untrusted' }. Booleans and a closed set only: no address, no header text
 */
const RUNTIME = new Set(['connected', 'disconnected', 'not-configured']);

function storeState(mode, store) {
  if (mode === 'setup' || !store) return 'none';
  try { return store.ping() ? 'ok' : 'unavailable'; } catch (_) { return 'unavailable'; }
}
function runtimeState(engine) {
  try { const s = engine ? engine.runtime().state : 'not-configured'; return RUNTIME.has(s) ? s : 'disconnected'; } catch (_) { return 'disconnected'; }
}

/** → { status, body } */
function readiness({ mode = 'app', store = null, engine = null } = {}) {
  const checks = { mode, store: storeState(mode, store), runtime: runtimeState(engine) };
  const ready = checks.store !== 'unavailable';
  return { status: ready ? 200 : 503, body: { status: ready ? 'ready' : 'not-ready', checks } };
}

// Forwarded headers present, and whether this server believes them (AO_TRUST_PROXY → Express 'trust proxy' for the peer)
function proxyView(req) {
  const forwarded = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded'].some((h) => req.headers[h] !== undefined);
  const trust = req.app && req.app.get('trust proxy fn');
  const trusted = !!(trust && req.socket && trust(req.socket.remoteAddress, 0));
  return { secure: !!req.secure, forwarded: !forwarded ? 'none' : trusted ? 'trusted' : 'untrusted' };
}

/** Mounts the probes on an Express app, first, before any authenticated route. `deps()` → { mode, store, engine }. */
function mountHealth(app, deps) {
  const send = (res, status, body) => { res.setHeader('Cache-Control', 'no-store'); res.status(status).json(body); };
  app.get('/healthz', (req, res) => send(res, 200, { status: 'ok' }));
  app.get('/healthz/proxy', (req, res) => send(res, 200, { status: 'ok', request: proxyView(req) }));
  app.get('/readyz', (req, res) => { const r = readiness(deps()); send(res, r.status, r.body); });
}

module.exports = { mountHealth, readiness, proxyView };
