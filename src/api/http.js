'use strict';
// Express app: body parsing, the read-only backstop, auth routes, API routes, static files, SPA fallback.
const path = require('path');
const express = require('express');
const { ApiError, sendError, requestId } = require('./v2/errors');
const { LOGIN_MAX_BYTES } = require('./csrf');

function createApp({ readonly, readonlyStore = false, publicDir, mountRoutes, audit = null, tokenGate = null, csrf = null, onLoginRefused = null, writeClassOf = () => null, apiOnly = false, trustProxy = false }) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy);   // req.ip from X-Forwarded-For set by a trusted (private) proxy
  app.use(requestId);   // S6: every response carries X-Request-Id (also the audit log's request id)
  // S5: every write command is audited, including the ones refused below (CSRF, token, parser, backstop).
  if (audit) app.use(audit);
  // S7d / R15-05 / R16-05: the agent token is resolved, rate-counted and audited FIRST (headers only), so every later
  // refusal (media type, CSRF, parser) is attributed and counted; its body-dependent scope is checked after parsing.
  if (tokenGate) app.use(tokenGate.auth);
  // R15-01: CSRF (media type + origin) before any body is parsed or any handler runs. No form parser exists.
  if (csrf) app.use(csrf);
  // R16-05: a compressed body is never inflated (the CSRF guard refused it already). R17-05: the login's 4 KiB ceiling
  // is the PARSER's limit too, so a chunked body (no Content-Length for the guard to check) can't bypass it.
  const LOGIN = /^\/api\/login\/?$/i;
  const jsonLogin = express.json({ inflate: false, limit: LOGIN_MAX_BYTES }), json = express.json({ inflate: false });
  app.use((req, res, next) => (LOGIN.test(req.path) ? jsonLogin : json)(req, res, next));
  // R16-05: a login the parser refuses still counts toward the throttle and is audited
  const PARSER = { 'entity.parse.failed': [400, 'invalid-json'], 'entity.too.large': [413, 'too-large'], 'charset.unsupported': [415, 'charset'],
    'encoding.unsupported': [415, 'content-encoding'], 'entity.verify.failed': [400, 'invalid-json'], 'request.size.invalid': [400, 'invalid-json'] };
  app.use((err, req, res, next) => {
    const hit = err && PARSER[err.type];
    if (!hit || !LOGIN.test(req.path)) return next(err);
    if (onLoginRefused) onLoginRefused(req, hit[1]);
    res.status(hit[0]).json({ error: hit[0] === 413 ? 'Requête trop volumineuse.' : 'Requête refusée.' });
  });
  if (tokenGate) app.use(tokenGate.scope);

  // Backstop for read-only (staging) instances. The real guard is in the CLI wrapper and the
  // gateway-restart route; this keeps every non-GET route refused even if a new route forgets.
  app.use((req, res, next) => {
    if (!readonly || req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.path === '/api/login' || req.path === '/api/logout') return next();
    // S6: API v2 write classes (api.md §5.0): transport control is never guarded; store writes follow
    // PORTAL_READONLY_STORE; anything else under /api/v2 is refused in the v2 error format.
    const cls = writeClassOf(req.method, req.path);
    if (cls === 'transport' || (cls === 'store' && !readonlyStore)) return next();
    sendError(req, res, new ApiError('readonly'));
  });

  mountRoutes(app);

  // API-only (go-live topology): nothing but the API is served, so no static redirect (`/x` → `/x/`) can ever
  // emit a Location that drops the proxy's stripped prefix. Every other path is the v2 JSON 404.
  if (apiOnly) {
    app.use((req, res) => sendError(req, res, new ApiError('not_found')));
    return app;
  }

  const noCache = (res, p) => { if (/\.(html|js|css|webmanifest)$/.test(p)) res.setHeader('Cache-Control', 'no-cache, must-revalidate'); };

  // F7: render the deployed /v2 shell with the frontend runtime config; refresh after a release.
  // The shell is rendered with the frontend's runtime config
  // (scripts/serve-frontend.js renderIndex: <base href>, the ao-config meta). Backend-served /v2 is mounted at
  // /v2/ with the API on the same root (apiBase ''). It's intercepted BEFORE the static handler, which would
  // otherwise serve the raw template for /v2/ and /v2/index.html. A template without its markers fails loudly
  // (logged at startup, 500 for the shell) instead of serving an unconfigured UI.
  const readBuild = require('./ui-build').createBuildReader(path.join(publicDir, 'v2'));
  let shellSource, shellValue;
  const shell = () => {
    const deployed = readBuild();
    if (deployed.source === shellSource) return shellValue;
    shellSource = deployed.source;
    shellValue = renderShell(deployed);
    return shellValue;
  };
  const renderShell = (deployed) => {
    const cfg = { basePath: '/v2/', apiBase: '' };
    if (!deployed.source) return { absent: true };   // no UI deployed: 404
    try {
      const { renderIndex } = require('../../scripts/serve-frontend');
      const html = renderIndex(deployed.source, cfg);
      return { html, config: JSON.stringify(cfg) };
    } catch (e) {
      console.error('Agent Office: the /v2 shell could not be rendered (' + (e && e.message ? e.message.split('\n')[0] : 'error') + ')');
      return null;
    }
  };
  shell();
  const sendShell = (res) => {
    const v2Shell = shell();
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    if (v2Shell && v2Shell.absent) return res.status(404).type('text/plain').send('Not found');
    if (!v2Shell) return res.status(500).type('text/plain').send('UI shell unavailable');
    res.type('html').send(v2Shell.html);
  };
  // R13-08: the index decision is made on the CANONICAL path (decoded once, dot segments resolved) before the static
  // handler, so no alias (/v%32/, /v2/%69ndex.html, the extensionless /v2/index) can reach the raw template.
  const canonicalOf = (req) => {
    let p; try { p = decodeURIComponent(req.path); } catch (_) { return null; }
    return p.includes('\0') ? null : path.posix.normalize(p.replace(/\\/g, '/'));
  };
  const SHELL_ALIASES = new Set(['/v2', '/v2/', '/v2/index.html', '/v2/index']);
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const p = canonicalOf(req);
    if (p === null) return res.status(400).type('text/plain').send('Bad request');
    if (SHELL_ALIASES.has(p)) return sendShell(res);
    if (p === '/v2/build.json') { res.setHeader('Cache-Control', 'no-store'); return res.json({ buildId: readBuild().buildId }); }
    const requestedBuild = req.query.v, deployedBuild = readBuild().buildId;
    if (p.startsWith('/v2/') && /\.(js|mjs|css|json)$/.test(p) && requestedBuild && deployedBuild && requestedBuild !== deployedBuild) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(410).type('text/plain').send('UI build replaced; reload the document');
    }
    const v2Shell = shell();
    if (p === '/v2/config.json') { res.setHeader('Cache-Control', 'no-cache, must-revalidate'); if (!v2Shell || v2Shell.absent) return res.status(v2Shell ? 404 : 500).end(); return res.type('json').send(v2Shell.config); }
    next();
  });
  // S16: the old UI is gone; its entry points go to the /v2 UI
  app.get(['/', '/index.html', '/index'], (req, res) => res.redirect(302, '/v2/'));
  // S16 follow-up: only /v2 is static (the v1 files and the /_ds bundle are deleted). /sw.js retires the worker v1
  // registered at the root; a redirect there would leave it installed (browsers refuse redirected worker scripts).
  app.get('/sw.js', (req, res) => { res.setHeader('Cache-Control', 'no-cache, must-revalidate'); res.type('application/javascript').sendFile(path.join(publicDir, 'v2', 'sw.js')); });
  // Static files on the CANONICAL path only, and only under /v2 (R2-10: /v%32/x.js routes like /v2/x.js).
  const staticFiles = express.static(publicDir, { extensions: ['html'], setHeaders: noCache });
  app.use((req, res, next) => { const p = canonicalOf(req); return p && (p === '/v2' || p.startsWith('/v2/')) ? staticFiles(req, res, next) : next(); });

  // New stateless UI (frontend owns public/v2/). Files under /v2/ are served by the static handler
  // above; any other GET under /v2 without a file extension is a client route → public/v2/index.html.
  // A missing asset (/v2/x.js) is a 404, never the HTML shell. Auth stays client-side (/api/me).
  // Decisions use ONE canonical path: percent-decoded once (malformed → 400) and dot-segment
  // normalised, so /v%32/x and /v2/x%2ejs route exactly like /v2/x and /v2/x.js (R2-10).
  const canonical = (req) => {
    let p;
    try { p = decodeURIComponent(req.path); } catch (_) { return null; }
    if (p.includes('\0')) return null;
    return path.posix.normalize(p.replace(/\\/g, '/'));
  };
  const isV2 = (p) => p === '/v2' || p.startsWith('/v2/');
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const p = canonical(req);
    if (p === null) return res.status(400).type('text/plain').send('Bad request');
    req.canonicalPath = p;
    next();
  });
  app.get(/.*/, (req, res, next) => {
    const p = req.canonicalPath;
    if (!p || !isV2(p) || path.posix.extname(p)) return next();
    sendShell(res);
  });
  app.use((req, res, next) => {
    const p = req.canonicalPath;
    if (req.method !== 'GET' || !p || p.startsWith('/api/') || isV2(p)) return next();
    res.redirect(302, '/v2/');
  });
  return app;
}

module.exports = { createApp };
