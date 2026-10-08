#!/usr/bin/env node
'use strict';
// Standalone static server for the stateless UI (F7, go-live topology): the UI at its own service, the API
// elsewhere (production: https://<host>/ = this, https://<host>/backend = the API behind Traefik StripPrefix).
// Plain node:http, no dependency. What it does:
//   - serves public/v2/ under BASE_PATH; any extension-less GET under it is a client route → index.html (api.md §6);
//     a missing file (x.js, x.png) is a 404, never the HTML shell;
//   - writes the runtime config into index.html (<base href> + <meta name="ao-config">, see public/v2/config.js)
//     and serves it as JSON at <BASE_PATH>config.json;
//   - optional, for dev/staging without Traefik: --api-proxy <url> forwards <API_BASE>/… to <url>/… with the
//     prefix stripped, exactly like the production StripPrefix (SSE included).
//
// Config (env, or flags of the same meaning):
//   AO_BASE_PATH  --base        UI mount point                   default '/'
//   AO_API_BASE   --api         API prefix seen by the browser   default '/backend'   ('' = same root as the UI)
//   AO_PUBLIC_URL --public-url  public origin, only to make og:image absolute (link previews); optional
//   AO_API_PROXY  --api-proxy   upstream API URL to forward API_BASE to (dev/staging only; its path is kept); optional
//   PORT / HOST   --port/--host listen address                   default 8080 / 127.0.0.1
//   AO_UI_ROOT    --root        directory served                 default public/v2 next to this script
// Nothing here reads secrets; the UI never needs any.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const proxyaddr = require('proxy-addr');   // the same parser as the API's Express 'trust proxy' (R32-04)
const crypto = require('node:crypto');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
const NO_CACHE = /\.(html|js|mjs|css|webmanifest|json)$/;
// F10 performance budget: text files go out gzipped when the client accepts it (the UI is ~920 KB raw, ~280 KB
// gzipped), and every file carries an ETag so a revalidation (no-cache) is a 304, not a full download.
const COMPRESSIBLE = /\.(html|js|mjs|css|webmanifest|json|svg|txt|map)$/;
const GZIP_CACHE_MAX = 400;

// F12 security headers. The UI loads nothing from another origin (frontend-17) and runs no inline script or style
// except the import map, allowed by its SHA-256. `connect-src 'self'`: the API base is a same-origin path (config.js
// normalise), proxied or routed at the edge. docs/guide/deploy.md has the same set as a Traefik middleware.
const PERMISSIONS = 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';
/** The inline scripts of the page (the import map), as CSP hash sources. */
function inlineScriptHashes(html) {
  return [...html.matchAll(/<script(?: type="importmap")?>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
}
/** connect-src: same origin, plus the API's origin if apiBase is ever an absolute URL on another origin (PM, frontend-18). */
function connectSources(apiBase) {
  try { if (/^https?:\/\//i.test(apiBase || '')) return `'self' ${new URL(apiBase).origin}`; } catch { /* not a URL: same origin */ }
  return "'self'";
}
function contentSecurityPolicy(html, { apiBase = '' } = {}) {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(html).join(' ')}`.trim(),
    "style-src 'self'",
    // Images only: project thumbnails (GitHub OpenGraph cards, site screenshots) and avatars are public https URLs by
    // contract (api.md §3.12, 2.3); their hosts can't be listed. data:/blob: for the office's placeholders.
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    `connect-src ${connectSources(apiBase)}`,   // today apiBase is always a same-origin path (normaliseConfig)
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",   // not 'none': the UI's <base href> (its mount point, F7) must apply; 'self' still stops a base-tag hijack to another origin
    "form-action 'self'",
  ].join('; ');
}
/**
 * R27-06 (RFC 9110 §12.5.3): gzip only when the client's Accept-Encoding gives it a q-value above 0, explicitly or
 * through `*` when gzip isn't listed. `gzip;q=0` and identity-only lists get the plain body.
 */
function gzipAccepted(header) {
  const q = new Map();
  for (const part of String(header || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';').map((x) => x.trim());
    if (!name) continue;
    const qp = params.find((p) => p.startsWith('q='));
    const value = qp ? Number(qp.slice(2)) : 1;
    q.set(name, Number.isFinite(value) ? value : 0);
  }
  return (q.has('gzip') ? q.get('gzip') : q.get('*') ?? 0) > 0;
}
/**
 * Which peers may speak for the client through X-Forwarded-* (review-30): the API's AO_TRUST_PROXY semantics (Express
 * 'trust proxy' list): `loopback`, `linklocal`, `uniquelocal`, IP addresses and CIDR ranges, comma-separated; default
 * `loopback`. Only the immediate peer is checked, as Express does for req.protocol. An invalid entry fails at startup.
 */
function trustProxyList(spec = 'loopback') {
  // R32-04: the API's own parser. Express compiles 'trust proxy' strings exactly so: split on commas, trim, then
  // proxy-addr's compile(), which throws on an entry it can't read (127.0.0.0/8/x, /33, a hostname…).
  let trust;
  try { trust = proxyaddr.compile(String(spec).split(',').map((v) => v.trim())); } catch (e) { throw new Error(`invalid AO_TRUST_PROXY: ${e.message}`); }
  return (addr) => (addr ? trust(String(addr), 0) : false);   // hop 0: the immediate peer, as Express does for req.protocol
}
/** HTTPS as the client sees it: TLS on this socket, or a *trusted* proxy saying so. HSTS is only honoured over HTTPS. */
function httpsOf(trusted) {
  return (req) => {
    if (!req || !req.socket) return false;
    if (req.socket.encrypted) return true;
    if (!trusted(req.socket.remoteAddress)) return false;   // anyone else's X-Forwarded-Proto is ignored
    return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
  };
}   // compressed bodies kept in memory, keyed by file, size and mtime

/**
 * Same rules as public/v2/config.js normalise(): basePath '/…/', apiBase '' or '/…' without a trailing slash, apiVersion
 * 2 | 3 or absent. frontend-21: the default API version lives in ONE place, DEFAULTS.apiVersion in public/v2/config.js;
 * this server only writes an apiVersion into the page when one is configured (--api-version, AO_API_VERSION).
 */
function normaliseConfig({ basePath = '/', apiBase = '/backend', apiVersion = undefined } = {}) {
  // No quotes, markup, backslashes, query or fragment: a mount point is a plain path (review-13 R13-10).
  const bad = (v) => typeof v !== 'string' || /[\s"'<>\\?#\0]/.test(v);
  if (bad(basePath) || !basePath.startsWith('/') || basePath.startsWith('//')) throw new Error(`invalid base path: ${JSON.stringify(basePath)}`);
  if (!basePath.endsWith('/')) basePath += '/';
  if (bad(apiBase) || (apiBase !== '' && (!apiBase.startsWith('/') || apiBase.startsWith('//')))) throw new Error(`invalid API base: ${JSON.stringify(apiBase)}`);
  if (apiVersion == null || apiVersion === '') return { basePath, apiBase: apiBase.replace(/\/+$/, '') };
  apiVersion = Number(apiVersion);
  if (apiVersion !== 2 && apiVersion !== 3) throw new Error(`invalid API version: ${JSON.stringify(apiVersion)}`);
  return { basePath, apiBase: apiBase.replace(/\/+$/, ''), apiVersion };
}

const attr = (s) => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * index.html with the runtime config written in: <base href>, the ao-config meta, and (with publicUrl) absolute
 * og:image/twitter:image. Throws if the template lost its markers, so a broken deploy fails loudly at startup.
 */
function renderIndex(template, cfg, { publicUrl = null } = {}) {
  const norm = normaliseConfig(cfg);
  const { basePath } = norm;
  const base = /<base href="[^"]*">/;
  const meta = /<meta name="ao-config" content='[^']*'>/;
  if (!base.test(template) || !meta.test(template)) throw new Error('index.html has no <base href> / ao-config meta to configure');
  let out = template
    // Function replacers: config text is never read as a replacement pattern ($&, $$, $`) (R13-10).
    .replace(base, () => `<base href="${attr(basePath)}">`)
    .replace(meta, () => `<meta name="ao-config" content='${attr(JSON.stringify(norm))}'>`);
  if (publicUrl) {
    const origin = new URL(publicUrl).origin;
    out = out.replace(/(<meta (?:property="og:image"|name="twitter:image") content=")([^"]+)(")/g,
      (_, a, url, b) => a + attr(new URL(url, origin + basePath).href) + b);   // a function: literal output
  }
  return out;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** The dev proxy's upstream: plain http on this machine only (R13-01). Anything else is a configuration error. */
function parseUpstream(apiProxy) {
  let u;
  try { u = new URL(apiProxy); } catch { throw new Error(`invalid --api-proxy: not a URL`); }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname) || u.username || u.password || u.search || u.hash) {
    throw new Error('invalid --api-proxy: only http://127.0.0.1, http://localhost or http://[::1] (optionally with a port and a path)');
  }
  return u;
}

// Hop-by-hop fields (RFC 9110 §7.6.1) and forwarding context: never copied across the proxy (R13-11).
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const FORWARDING = /^(forwarded|x-forwarded-.*|x-real-ip|via)$/;
function endToEnd(headers) {
  const nominated = new Set(String(headers.connection || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP.has(k) && !nominated.has(k) && !FORWARDING.test(k)) out[k] = v;
  // Framing: keep Content-Length only when the hop didn't nominate it (R15-13); otherwise Node re-frames the body (chunked).
  if (headers['content-length'] != null && headers['transfer-encoding'] == null && !nominated.has('content-length')) out['content-length'] = headers['content-length'];
  return out;
}

function createFrontendServer({ root = path.join(__dirname, '..', 'public', 'v2'), basePath = '/', apiBase = '/backend', apiVersion = undefined, publicUrl = null, apiProxy = null, trustProxy = process.env.AO_TRUST_PROXY || 'loopback' } = {}) {
  const isHttps = httpsOf(trustProxyList(trustProxy));
  const cfg = normaliseConfig({ basePath, apiBase, apiVersion });
  const upstream = apiProxy ? parseUpstream(apiProxy) : null;
  root = fs.realpathSync(path.resolve(root));   // containment is checked on real paths (R13-13)
  const readBuild = require('../src/api/ui-build').createBuildReader(root);
  let source, indexBuf, indexTag, csp;
  const refreshShell = () => {
    const deployed = readBuild();
    if (!deployed.source) throw new Error('UI shell unavailable');
    if (source !== deployed.source) {
      source = deployed.source;
      const index = renderIndex(source, cfg, { publicUrl });
      indexBuf = Buffer.from(index);
      indexTag = '"i-' + crypto.createHash('sha256').update(indexBuf).digest('base64url').slice(0, 16) + '"';
      csp = contentSecurityPolicy(index, { apiBase: cfg.apiBase });
    }
    return deployed.buildId;
  };
  refreshShell();
  const configJson = JSON.stringify(cfg);
  const routeBase = cfg.basePath.slice(0, -1);   // '' or '/v2'

  const headers = (type, file, req) => ({
    'content-type': type,
    'cache-control': NO_CACHE.test(file) ? 'no-cache, must-revalidate' : 'public, max-age=3600',
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': PERMISSIONS,
    'cross-origin-opener-policy': 'same-origin',
    'x-frame-options': 'DENY',
    ...(isHttps(req) ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  });
  const gz = new Map();   // key → Buffer (gzip)
  const gzipOf = (key, buf) => {
    let out = gz.get(key);
    if (!out) {
      out = zlib.gzipSync(buf, { level: 9 });
      if (gz.size >= GZIP_CACHE_MAX) gz.delete(gz.keys().next().value);
      gz.set(key, out);
    }
    return out;
  };
  const acceptsGzip = (req) => gzipAccepted(req.headers['accept-encoding']);
  /** A body with its validator: 304 when the client already has it, gzip when it helps. */
  const sendBody = (req, res, type, file, buf, tag, head) => {
    const h = { ...headers(type, file, req), etag: tag };
    if (COMPRESSIBLE.test(file)) h.vary = 'accept-encoding';
    if (String(req.headers['if-none-match'] || '').split(/\s*,\s*/).includes(tag)) { res.writeHead(304, h); return res.end(); }
    let body = buf;
    if (COMPRESSIBLE.test(file) && buf.length > 512 && acceptsGzip(req)) { body = gzipOf(file + '|' + tag, buf); h['content-encoding'] = 'gzip'; }
    h['content-length'] = body.length;
    res.writeHead(200, h);
    res.end(head ? undefined : body);
  };
  const send = (res, status, type, body, file = '.txt', head = false) => {
    if (res.headersSent) return res.destroy();
    const h = headers(type, file, res.req);
    if (status === 410 || file === 'build.json') h['cache-control'] = 'no-store';
    res.writeHead(status, h);
    res.end(head ? undefined : body);
  };
  const json404 = JSON.stringify({ error: { code: 'not_found', message: 'Élément introuvable.', requestId: 'req_static' } });

  /** Forwards one request to the fixed upstream. `rest` is a vetted path below apiBase; the authority never changes. */
  function proxy(req, res, rest, query) {
    const target = new URL(upstream.href);
    target.pathname = upstream.pathname.replace(/\/+$/, '') + rest;
    target.search = query;
    const h = endToEnd(req.headers);
    h.host = upstream.host;
    h['x-forwarded-for'] = req.socket.remoteAddress || '';
    h['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
    h['x-forwarded-prefix'] = cfg.apiBase;
    const up = http.request(target, { method: req.method, headers: h }, (r) => {
      res.writeHead(r.statusCode, endToEnd(r.headers));
      r.pipe(res);
      // A severed upstream (API restart mid-SSE) must end the browser's stream too, so EventSource reconnects (R13-12).
      r.on('aborted', () => res.destroy());
      r.on('error', () => res.destroy());
      r.on('close', () => { if (!r.complete) res.destroy(); });
    });
    up.on('error', () => { if (!res.headersSent) send(res, 502, 'application/json; charset=utf-8', JSON.stringify({ error: { code: 'upstream_unavailable', message: 'API injoignable.', requestId: 'req_proxy' } })); else res.destroy(); });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });   // the browser left: stop the upstream
    req.pipe(up);
  }

  return http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(res, 400, 'text/plain; charset=utf-8', 'Bad request'); }
    if (p.includes('\0')) return send(res, 400, 'text/plain; charset=utf-8', 'Bad request');
    p = path.posix.normalize(p.replace(/\\/g, '/'));

    // The API prefix (dev proxy only; in production Traefik routes it before this server sees it).
    const rawPath = req.url.split('?')[0];
    if (cfg.apiBase && (p === cfg.apiBase || p.startsWith(cfg.apiBase + '/') || rawPath === cfg.apiBase || rawPath.startsWith(cfg.apiBase + '/'))) {
      if (!upstream) return send(res, 404, 'application/json; charset=utf-8', json404);
      const rest = rawPath.startsWith(cfg.apiBase) ? rawPath.slice(cfg.apiBase.length) || '/' : null;
      let decoded = null;
      try { decoded = rest && decodeURIComponent(rest); } catch { /* malformed */ }
      // Only a plain absolute path: no '//', no backslash (raw or encoded), no dot segments (R13-01).
      if (!decoded || !rest.startsWith('/') || decoded.startsWith('//') || /\\/.test(decoded) || decoded.includes('\0') || decoded.split('/').some((seg) => seg === '.' || seg === '..')) {
        return send(res, 400, 'text/plain; charset=utf-8', 'Bad request');
      }
      return proxy(req, res, rest, req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    const head = req.method === 'HEAD';
    if (!(p === routeBase || p === cfg.basePath || p.startsWith(cfg.basePath))) return send(res, 404, 'text/plain; charset=utf-8', 'Not found', '.txt', head);

    const rel = p.slice(cfg.basePath.length);   // '' for the mount point itself
    let buildId;
    try { buildId = refreshShell(); } catch { return send(res, 503, 'text/plain; charset=utf-8', 'UI shell unavailable', '.txt', head); }
    if (rel === 'build.json') {
      res.setHeader('Cache-Control', 'no-store');
      return send(res, 200, TYPES['.json'], JSON.stringify({ buildId }), 'build.json', head);
    }
    if (rel === 'config.json') return send(res, 200, TYPES['.json'], configJson, 'config.json', head);
    if (!path.posix.extname(rel) || rel === 'index.html') return sendBody(req, res, TYPES['.html'], 'index.html', indexBuf, indexTag, head);   // client route
    const requestedBuild = new URL(req.url, 'http://x').searchParams.get('v');
    if (/\.(js|mjs|css|json)$/.test(rel) && requestedBuild && buildId && requestedBuild !== buildId) {
      res.setHeader('Cache-Control', 'no-store');
      return send(res, 410, 'text/plain; charset=utf-8', 'UI build replaced; reload the document', '.txt', head);
    }

    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep)) return send(res, 404, 'text/plain; charset=utf-8', 'Not found', '.txt', head);
    // Lexical containment is not enough: a link inside the root may point outside it (R13-13).
    fs.realpath(file, (err, real) => {
      if (err || !real.startsWith(root + path.sep)) return send(res, 404, 'text/plain; charset=utf-8', 'Not found', '.txt', head);
      fs.stat(real, (err2, st) => {
        if (err2 || !st.isFile()) return send(res, 404, 'text/plain; charset=utf-8', 'Not found', '.txt', head);
        const type = TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream';
        const tag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
        if (COMPRESSIBLE.test(real) || String(req.headers['if-none-match'] || '').includes(tag)) {
          // Text (small, compressible) is read whole; a matching validator needs no read at all.
          if (String(req.headers['if-none-match'] || '').split(/\s*,\s*/).includes(tag)) return sendBody(req, res, type, real, null, tag, head);
          return fs.readFile(real, (err3, buf) => (err3 ? send(res, 404, 'text/plain; charset=utf-8', 'Not found', '.txt', head) : sendBody(req, res, type, real, buf, tag, head)));
        }
        res.writeHead(200, { ...headers(type, real, req), etag: tag, 'content-length': st.size });
        if (head) return res.end();
        fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
      });
    });
  });
}

module.exports = { renderIndex, normaliseConfig, createFrontendServer, endToEnd, contentSecurityPolicy, inlineScriptHashes, securityHeaders, gzipAccepted, trustProxyList, PERMISSIONS };

/** The security headers this server sends for a given UI root (docs/guide/deploy.md: the same set at the edge). */
function securityHeaders({ root = path.join(__dirname, '..', 'public', 'v2'), basePath = '/', apiBase = '/backend', apiVersion = undefined } = {}) {
  const index = renderIndex(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), { basePath, apiBase, apiVersion });
  return { 'Content-Security-Policy': contentSecurityPolicy(index, { apiBase }), 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': PERMISSIONS, 'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Frame-Options': 'DENY', 'Strict-Transport-Security': 'max-age=31536000 (HTTPS only)' };
}

if (require.main === module && process.argv.includes('--print-headers')) {
  // node scripts/serve-frontend.js --print-headers [--root …]: the exact values for this build (the CSP carries the import map's hash).
  const i = process.argv.indexOf('--root');
  for (const [k, v] of Object.entries(securityHeaders(i > 0 ? { root: process.argv[i + 1] } : {}))) console.log(`${k}: ${v}`);
} else if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
  const env = process.env;
  const opts = {
    root: flag('root') ?? env.AO_UI_ROOT ?? undefined,
    basePath: flag('base') ?? env.AO_BASE_PATH ?? '/',
    apiBase: flag('api') ?? env.AO_API_BASE ?? '/backend',
    apiVersion: flag('api-version') ?? env.AO_API_VERSION ?? undefined,   // unset: the page uses config.js DEFAULTS.apiVersion
    publicUrl: flag('public-url') ?? env.AO_PUBLIC_URL ?? null,
    apiProxy: flag('api-proxy') ?? env.AO_API_PROXY ?? null,
  };
  const port = Number(flag('port') ?? env.PORT ?? 8080);
  const host = flag('host') ?? env.HOST ?? '127.0.0.1';
  const server = createFrontendServer(opts);
  server.listen(port, host, () => {
    const { basePath, apiBase } = normaliseConfig(opts);
    console.log(`agent-office UI on http://${host}:${port}${basePath} (API base ${apiBase || '(same root)'}${opts.apiProxy ? ' → proxied' : ''})`);
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => server.close(() => process.exit(0)));
}
