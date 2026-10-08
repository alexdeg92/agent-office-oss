'use strict';
/*
 * R15-01 (P1, go-live gate): CSRF protection for EVERY non-GET request (v1, v2, login, logout, commands), before
 * any body is parsed or any handler (or adapter) runs.
 *   1. Media type: a request with a body must be application/json → else 415 (forms are urlencoded, multipart or
 *      text/plain; a browser can't send JSON cross-origin without a CORS preflight, which is never granted).
 *      A body-less request needs X-AO-Request: 1 (or a bearer token).
 *   2. Origin: a request that carries the session cookie (and no bearer) must come from an allowed origin: its
 *      Origin, else its Referer's origin, is the configured public origin (AO_PUBLIC_URL), the server's own
 *      origin, or — from the loopback hop only — a loopback X-Forwarded-Host (one-port local install); or it carries
 *      X-AO-Request: 1 (a custom header: not settable by a form, and cross-origin only after a preflight). A FOREIGN
 *      Origin is always refused, header or not.
 * Bearer-token requests carry no ambient credential: rule 1 applies, rule 2 doesn't.
 */
const { ApiError, sendError } = require('./v2/errors');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOGIN_MAX_BYTES = 4096;   // an e-mail and a password
const COOKIE = 'taco_sess';

// R17-04: every origin is compared in its normalised form (WHATWG URL): lower-cased scheme and host, IPv6 bracketed
// and compressed ([0:0::1] → [::1]), the scheme's default port dropped. Both sides go through here.
function originOf(value) {
  try { const u = new URL(value); return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null; } catch (_) { return null; }
}
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
 */
function createCsrfGuard({ publicUrl = null, onLoginRefused = null } = {}) {
  const configured = publicUrl ? originOf(publicUrl) : null;
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
      if (type !== 'application/json') return refuse(req, res, 415, 'content-type');
    } else if (!marked && !bearer) {
      return refuse(req, res, 415, 'content-type');
    }
    if (bearer) return next();
    const cookie = String(req.headers.cookie || '');
    if (!new RegExp('(^|;\\s*)' + COOKIE + '=').test(cookie)) return next();   // no ambient credential to abuse
    const own = originOf(req.protocol + '://' + req.get('host'));
    const local = localInstallOrigin(req);
    const allowed = (o) => (own && o === own) || (local && o === local) || (configured && o === configured);
    const origin = req.headers.origin ? originOf(req.headers.origin) : null;
    const referer = !req.headers.origin && req.headers.referer ? originOf(req.headers.referer) : null;
    const claimed = origin || referer;
    if (claimed && !allowed(claimed)) return refuse(req, res, 403, 'csrf');
    if (!claimed && !marked) return refuse(req, res, 403, 'csrf');
    next();
  };
}

module.exports = { createCsrfGuard, LOGIN_MAX_BYTES };
