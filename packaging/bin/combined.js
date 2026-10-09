'use strict';
// One-port local install: the UI at / and the API at /backend on the same port.
// The API process itself still listens at /api (AO_API_ONLY=1) on loopback. This process strips
// /backend and forwards only to that child. It is not the optional --api-proxy on serve-frontend.js.

const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createFrontendServer } = require('../../scripts/serve-frontend');

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const FORWARDING = /^(forwarded|x-forwarded-.*|x-real-ip|via)$/;

function endToEnd(headers) {
  const nominated = new Set(String(headers.connection || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP.has(key) && !nominated.has(key) && !FORWARDING.test(key)) out[key] = value;
  }
  // Framing: keep Content-Length only when the hop didn't nominate it (R15-13 / R16-11).
  if (headers['content-length'] != null && headers['transfer-encoding'] == null && !nominated.has('content-length')) out['content-length'] = headers['content-length'];
  return out;
}

function clientAddress(remoteAddress) {
  const addr = String(remoteAddress || '');
  return addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
}

// A one-port install with no AO_PUBLIC_URL may only advertise the Host the browser used when that
// Host is loopback on this process's listen port. Any other Host is dropped (R16-04).
function browsedLocalHost(hostHeader, listenPort) {
  if (typeof hostHeader !== 'string') return null;
  const host = hostHeader.trim();
  if (!host || host.length > 255) return null;
  let name;
  let port;
  if (host.startsWith('[')) {
    const match = /^\[([0-9a-fA-F:]{2,45})\]:(\d{1,5})$/.exec(host);
    if (!match) return null;
    name = match[1].toLowerCase();
    port = match[2];
  } else {
    const match = /^(localhost|127\.0\.0\.1):(\d{1,5})$/i.exec(host);
    if (!match) return null;
    name = match[1].toLowerCase();
    port = match[2];
  }
  if (name !== 'localhost' && name !== '127.0.0.1' && name !== '::1') return null;
  if (String(Number(port)) !== port || Number(port) < 1 || Number(port) > 65535) return null;
  if (port !== String(listenPort)) return null;
  return name === '::1' ? `[::1]:${port}` : `${name}:${port}`;
}

function proxyHeaders(headers, { remoteAddress, listenPort, apiPort }) {
  const out = endToEnd(headers);
  out.host = `127.0.0.1:${apiPort}`;
  const ip = clientAddress(remoteAddress);
  if (ip) out['x-forwarded-for'] = ip;
  out['x-forwarded-proto'] = 'http';
  const browsed = browsedLocalHost(headers.host, listenPort);
  if (browsed) out['x-forwarded-host'] = browsed;
  return out;
}

function apiChildEnv(env, apiPort) {
  return { ...env, AO_UI_HOST: env.HOST || '127.0.0.1', AO_UI_PORT: env.PORT || '18789', HOST: '127.0.0.1', PORT: String(apiPort), AO_API_ONLY: '1', AO_TRUST_PROXY: 'loopback' };
}

function backendTarget(url) {
  const q = url.indexOf('?');
  const pathPart = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? '' : url.slice(q);
  if (pathPart !== '/backend' && !pathPart.startsWith('/backend/')) return null;
  const rest = pathPart.slice('/backend'.length) || '/';
  let decoded;
  try { decoded = decodeURIComponent(rest); } catch { return { bad: true }; }
  if (!rest.startsWith('/') || decoded.startsWith('//') || /\\/.test(decoded) || decoded.includes('\0') || decoded.split('/').some((seg) => seg === '.' || seg === '..')) {
    return { bad: true };
  }
  return { path: rest + query };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function forward(req, res, apiPort, target, listenPort) {
  const headers = proxyHeaders(req.headers, {
    remoteAddress: req.socket && req.socket.remoteAddress,
    listenPort,
    apiPort,
  });
  const up = http.request({
    host: '127.0.0.1',
    port: apiPort,
    method: req.method,
    path: target,
    headers,
  }, (upstream) => {
    res.writeHead(upstream.statusCode, endToEnd(upstream.headers));
    upstream.pipe(res);
    upstream.on('aborted', () => res.destroy());
    upstream.on('error', () => res.destroy());
    upstream.on('close', () => { if (!upstream.complete) res.destroy(); });
  });
  up.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'upstream_unavailable', message: 'API injoignable.', requestId: 'req_combined' } }));
    } else res.destroy();
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
}

function startCombined({ root, env = process.env } = {}) {
  const IC = require('../../src/instance-config');
  const configured = IC.effectiveEnv(env, IC.readInstanceConfig(env));
  // Resolve listener settings here; each process reads its own instance config.
  env = { ...env, HOST: configured.HOST || '127.0.0.1', PORT: configured.PORT || '18789' };
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 18789);
  const ui = createFrontendServer({
    root: path.join(root, 'public', 'v2'),
    basePath: '/',
    publicUrl: configured.AO_PUBLIC_URL || null,
    apiBase: '/backend',
  });
  let api = null;
  let server = null;

  return freePort().then((apiPort) => new Promise((resolve) => {
    let closed = false;
    const finish = (code) => {
      if (closed) return;
      closed = true;
      if (server) server.close();
      resolve(typeof code === 'number' ? code : 1);
    };
    const stop = (sig) => {
      if (!api || api.exitCode != null || api.signalCode != null) return finish(1);
      try { api.kill(sig); } catch { finish(1); }
    };
    api = spawn(process.execPath, [path.join(root, 'server.js')], {
      env: apiChildEnv(env, apiPort),
      stdio: 'inherit',
    });
    api.on('error', () => finish(1));
    api.on('exit', (code) => finish(code));
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));

    server = http.createServer((req, res) => {
      const target = backendTarget(req.url || '/');
      if (target && target.bad) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad request');
        return;
      }
      if (target) return forward(req, res, apiPort, target.path, port);
      ui.emit('request', req, res);
    });
    server.on('error', () => {
      if (api && api.exitCode == null) { try { api.kill('SIGTERM'); } catch { /* already gone */ } }
      finish(1);
    });
    server.listen(port, host, () => {
      process.stdout.write(`agent-office on http://${host}:${port}/ (API at /backend)\n`);
    });
  }));
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..', '..');
  startCombined({ root, env: process.env }).then((code) => process.exit(code));
}

module.exports = { backendTarget, startCombined, endToEnd, proxyHeaders, apiChildEnv, forward };
