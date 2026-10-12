'use strict';
/*
 * API v2 errors (api.md §2.2): one format everywhere, a request id on every response.
 *   { error: { code, message, details?, requestId, current? } }   + header X-Request-Id
 * Messages are fixed French phrases (src/i18n/fr.js error.*), never upstream or exception text.
 */
const crypto = require('crypto');
const { LABELS } = require('../../i18n/fr');

const STATUS = { unauthorized: 401, readonly: 403, forbidden: 403, not_found: 404, validation_failed: 400, conflict: 409, rate_limited: 429,
  upstream_unavailable: 503, upstream_failed: 502, internal: 500 };

class ApiError extends Error {
  constructor(code, { message, details, current, status } = {}) {
    super(code);
    if (!STATUS[code]) throw new Error('unknown ErrorCode ' + code);
    this.code = code; this.status = status || STATUS[code];
    this.publicMessage = message || LABELS['error.' + code];
    if (details) this.details = details;
    if (current) this.current = current;
  }
}
const invalid = (field, issue, message) => new ApiError('validation_failed', { message, details: [Object.assign(field ? { field } : {}, { issue })] });

// Every request gets an id (also used by the audit log); every response carries it.
function requestId(req, res, next) {
  req.requestId = req.requestId || 'req_' + crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

function internalFrames(err) {
  const stack = err && typeof err.stack === 'string' ? err.stack : '';
  return stack.split('\n').slice(1, 17).map((line) => {
    // Keep only a basename and source coordinates. Never log exception messages, absolute paths,
    // query strings, or arbitrary frame text (which can contain credentials).
    const match = line.match(/^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/);
    if (!match) return null;
    const raw = match[2].replace(/^file:\/\//, '').replace(/\\/g, '/');
    const file = raw.split('/').pop();
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(file)) return null;
    return file + ':' + match[3] + ':' + match[4];
  }).filter(Boolean).slice(0, 12);
}

function logInternal(req, err, log) {
  const entry = { event: 'api.internal', requestId: req.requestId || 'req_unknown', stack: internalFrames(err) };
  // VM validation errors contain only schema names/paths and fixed validator messages. Keep this
  // narrow diagnostic so a production fallback failure is actionable without logging VM data.
  if (err && err.name === 'VmError' && typeof err.vm === 'string' && Array.isArray(err.issues)) {
    entry.vm = /^[A-Za-z0-9_.-]{1,80}$/.test(err.vm) ? err.vm : 'unknown';
    entry.issues = err.issues.slice(0, 5).map((i) => ({
      // `parent` is supplied only by schema object validation and contains declared segments.
      // Parentless paths include undefinedPath(), which traverses arbitrary object keys.
      path: typeof i.parent === 'string' && /^[A-Za-z0-9_.$[\]-]{1,140}$/.test(i.parent) ? i.parent + '.<undeclared>' : '<redacted>',
      detail: typeof i.detail === 'string' && /^[A-Za-z0-9 _.,:|()<>-]{1,140}$/.test(i.detail) ? i.detail : 'validation failed',
    }));
  }
  try { log(entry); } catch (_) { /* Logging must never prevent the API error response. */ }
}

function sendError(req, res, err, log = (entry) => console.error(JSON.stringify(entry))) {
  const e = err instanceof ApiError ? err : new ApiError('internal');
  if (e.code === 'internal') logInternal(req, err, log);
  const body = { error: { code: e.code, message: e.publicMessage, requestId: req.requestId || 'req_unknown' } };
  if (e.details) body.error.details = e.details;
  if (e.current) body.error.current = e.current;
  res.status(e.status).json(body);
}

// Express error middleware for API routes. Internal failures are logged by request id with redacted frames.
function errorMiddleware(log = (entry) => console.error(JSON.stringify(entry))) {
  return (err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (res.headersSent) return next(err);
    if (err && err.type === 'entity.parse.failed') return sendError(req, res, invalid(null, 'invalid-json'), log);
    if (err && err.type === 'entity.too.large') return sendError(req, res, invalid(null, 'too-large'), log);
    sendError(req, res, err, log);
  };
}

module.exports = { ApiError, invalid, requestId, sendError, errorMiddleware, STATUS, internalFrames };
