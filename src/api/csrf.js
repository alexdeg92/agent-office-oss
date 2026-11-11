'use strict';
/*
 * R15-01 (P1, go-live gate): CSRF protection for EVERY non-GET request (v1, v2, login, logout, commands), before
 * any body is parsed or any handler (or adapter) runs.
 *   1. Media type: a request with a body must be application/json → else 415, except the streaming Chat attachment
 *      route, which accepts multipart only (forms are urlencoded or text/plain; a browser can't send JSON cross-origin
 *      without a CORS preflight, which is never granted).
 *      A body-less request needs X-AO-Request: 1 (or a bearer token).
 *   2. Origin: a request that carries the session cookie (and no bearer) must come from an allowed origin: its
 *      Origin, else its Referer's origin, is a configured public origin (AO_PUBLIC_URL, or the one the setup wizard
 *      saved), the server's own origin (its Host, over http or https), or — from the loopback hop only — a loopback
 *      X-Forwarded-Host (one-port local install); or it carries
 *      X-AO-Request: 1 (a custom header: not settable by a form, and cross-origin only after a preflight). A FOREIGN
 *      Origin is always refused, header or not.
 * Bearer-token requests carry no ambient credential: rule 1 applies, rule 2 doesn't.
 */
const { ApiError, sendError } = require('./v2/errors');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOGIN_MAX_BYTES = 4096;   // an e-mail and a password
const COOKIE = 'taco_sess';
// The streaming Chat attachment endpoint is the sole form-data write. Keep the
// exception path- and method-scoped: all other v2/v3 writes remain JSON-only.
const CHAT_ATTACHMENT_UPLOAD = /^\/api\/v3\/chat\/sessions\/cs_[A-Za-z0-9_-]{32,}\/attachments\/?$/;
const AVATAR_UPLOAD = /^\/api\/v3\/me\/avatar\/photo\/?$/i;

// R17-04: every origin is compared in its normalised form (WHATWG URL): lower-cased scheme and host, IPv6 bracketed
// and compressed ([0:0::1] → [::1]), the scheme's default port dropped. Both sides go through here.
function originOf(value) {
  try { const u = new URL(value); return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null; } catch (_) { return null; }
}
const PLAIN_ORIGIN = /^https?:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;   // normalised: lower case
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);   // URL.hostname keeps IPv6 brackets

function socketLoopback(req) {
  const addr = String((req.socket && req.socket.remoteAddress) || '');
  const ip = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  return ip === '127.0.0.1' || ip === '::1';
}

// The one-port proxy sets X-Forwarded-Host only for a loopback Host on its listen port. Honor that
// header only from the loopback hop, and only when the name itself is loopback (R16-04).
function localInstallOrigin(req) {
  if (!socketLoopback(req)) return null;
  const host = String(req.get('x-forwarded-host') || '').trim();
  if (!host || host.length > 255 || /[\s,]/.test(host)) return null;
  let url;
  try { url = new URL(`http://${host}`); } catch (_) { return null; }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
  return url.origin;
}

/**
 * @param {object} o
 * @param {string|null} o.publicUrl  the configured public origin (AO_PUBLIC_URL), if any
 * @param {string[]} o.origins       public origins the instance config saved (setup wizard access/network step)
 * @param {(m: string) => void} o.warn  told once per refused origin what to configure
 */
function createCsrfGuard({ publicUrl = null, origins = [], onLoginRefused = null, warn = null } = {}) {
  const configured = new Set([publicUrl, ...origins].map(u => u && originOf(u)).filter(Boolean));
  const warned = new Set();
  // A proxy that rewrites the Host can't be recognised: say once per origin what to configure (the 403 alone is silent).
  // The Origin is request data: an exact AO_PUBLIC_URL=… line is printed only for a plain host (LDH labels or IPv4,
  // optional port), which is safe to paste into a shell; anything else is shown quoted, with generic guidance.
  const explain = (claimed, own) => {
    if (!warn || configured.size || warned.size >= 8 || warned.has(claimed)) return;
    warned.add(claimed);
    const plain = PLAIN_ORIGIN.test(claimed);
    warn(`Agent Office: refused writes from ${plain ? claimed : JSON.stringify(claimed)}: this server sees itself as ${own && PLAIN_ORIGIN.test(own) ? own : 'another origin'}. `
      + (plain ? `If ${claimed} is this server behind a reverse proxy, set AO_PUBLIC_URL=${claimed} and restart.`
        : 'If that is this server behind a reverse proxy, set AO_PUBLIC_URL to its public origin (scheme://host[:port]) and restart.'));
  };
  const LOGIN = /^\/api\/login\/?$/i;
  const refuse = (req, res, status, issue) => {
    // R16-05: a refused login is still an attempt: counted toward the throttle and audited
    if (onLoginRefused && LOGIN.test(req.path)) onLoginRefused(req, issue === 'content-type' ? 'not-json' : issue);
    if (/^\/api\/v[23]\//i.test(req.path)) return sendError(req, res, new ApiError(status === 403 ? 'forbidden' : 'validation_failed', { status, details: [{ issue }] }));
    return res.status(status).json({ error: status === 403 ? 'Requête refusée (origine).' : status === 413 ? 'Requête trop volumineuse.' : 'Requête JSON attendue.' });
  };
  return function csrf(req, res, next) {
    if (SAFE.has(req.method)) return next();
    const bearer = typeof req.headers.authorization === 'string' && /^Bearer\s/i.test(req.headers.authorization);
    const marked = req.headers['x-ao-request'] === '1';
    const hasBody = (req.headers['content-length'] && req.headers['content-length'] !== '0') || req.headers['transfer-encoding'] !== undefined;
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    // R16-05 (R17a): refused BEFORE any parsing: a compressed body (never inflated), a non-UTF-8 charset, an oversized login
    const encoding = String(req.headers['content-encoding'] || '').trim().toLowerCase();
    if (encoding && encoding !== 'identity') return refuse(req, res, 415, 'content-encoding');
    const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(String(req.headers['content-type'] || ''));
    if (charset && charset[1].toLowerCase() !== 'utf-8') return refuse(req, res, 415, 'charset');
    if (LOGIN.test(req.path) && Number(req.headers['content-length'] || 0) > LOGIN_MAX_BYTES) return refuse(req, res, 413, 'too-large');
    if (hasBody || type) {
      const multipartUpload = req.method === 'POST' && (CHAT_ATTACHMENT_UPLOAD.test(req.path) || AVATAR_UPLOAD.test(req.path)) && type === 'multipart/form-data';
      if (type !== 'application/json' && !multipartUpload) return refuse(req, res, 415, 'content-type');
    } else if (!marked && !bearer) {
      return refuse(req, res, 415, 'content-type');
    }
    if (bearer) return next();
    const cookie = String(req.headers.cookie || '');
    if (!new RegExp('(^|;\\s*)' + COOKIE + '=').test(cookie)) return next();   // no ambient credential to abuse
    const own = originOf(req.protocol + '://' + req.get('host'));
    // The same Host over https: a TLS-terminating proxy that keeps the Host but isn't a trusted proxy (req.protocol
    // stays http). Safe because the session cookie is host-only (no Domain): the browser sends it only to the hostname it
    // addressed, and only a page that hostname served over TLS has this Origin. Assumes the proxy forwards the Host the
    // browser used (the same assumption as the http rule above). Only http → https is added; never https → http.
    const ownTls = originOf('https://' + req.get('host'));
    const local = localInstallOrigin(req);
    const allowed = (o) => (own && (o === own || o === ownTls)) || (local && o === local) || configured.has(o);
    const origin = req.headers.origin ? originOf(req.headers.origin) : null;
    const referer = !req.headers.origin && req.headers.referer ? originOf(req.headers.referer) : null;
    const claimed = origin || referer;
    if (claimed && !allowed(claimed)) { explain(claimed, own); return refuse(req, res, 403, 'csrf'); }
    if (!claimed && !marked) return refuse(req, res, 403, 'csrf');
    next();
  };
}

module.exports = { createCsrfGuard, LOGIN_MAX_BYTES };
