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

function sendError(req, res, err) {
  const e = err instanceof ApiError ? err : new ApiError('internal');
  const body = { error: { code: e.code, message: e.publicMessage, requestId: req.requestId || 'req_unknown' } };
  if (e.details) body.error.details = e.details;
  if (e.current) body.error.current = e.current;
  res.status(e.status).json(body);
}

// Express error middleware for /api/v2: body-parser failures become validation_failed; anything unknown is
// a 500 'internal' whose text never reaches the client (logged as a category only).
function errorMiddleware(log = () => {}) {
  return (err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (res.headersSent) return next(err);
    if (err && err.type === 'entity.parse.failed') return sendError(req, res, invalid(null, 'invalid-json'));
    if (err && err.type === 'entity.too.large') return sendError(req, res, invalid(null, 'too-large'));
    if (!(err instanceof ApiError)) log('api v2: internal error (' + (err && err.name || 'Error') + ')');
    sendError(req, res, err);
  };
}

module.exports = { ApiError, invalid, requestId, sendError, errorMiddleware, STATUS };
