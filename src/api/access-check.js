'use strict';

const { ApiError, invalid, sendError } = require('./v2/errors');
const { APP_ROUTES } = require('../security/route-declarations');
const { declareRoute } = require('../security/route-policy');

const PATH = '/api/auth/access-diagnostic';
const PREFLIGHT_HEADERS = new Set(['authorization', 'content-type', 'x-ao-csrf', 'x-ao-request']);

function mountAccessDiagnostic(app, { externalAccess, boundary, store = null, auth = null } = {}) {
  if (!externalAccess || typeof externalAccess.consumeDiagnosticChallenge !== 'function' || typeof boundary !== 'function') {
    throw new TypeError('access diagnostic dependencies required');
  }
  const publicRoute = APP_ROUTES.get('POST ' + PATH), optionsRoute = APP_ROUTES.get('OPTIONS ' + PATH);
  const route = (method, spec, handler) => {
    if (store?.registry && auth) declareRoute(app, method.toLowerCase(), PATH, spec, { store, auth }, handler);
    else app[method.toLowerCase()](PATH, handler);
  };
  const refuse = (req, res, issue) => sendError(req, res, new ApiError('forbidden', { details: [{ issue }] }));
  const headers = (req, res, policy) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.vary('Origin');
    if (!policy?.allows(req.headers.origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    return true;
  };

  route('OPTIONS', optionsRoute, (req, res) => {
    const policy = boundary();
    if (!headers(req, res, policy)) return refuse(req, res, 'origin');
    res.vary('Access-Control-Request-Method');
    res.vary('Access-Control-Request-Headers');
    const method = req.headers['access-control-request-method'];
    const raw = req.headers['access-control-request-headers'] || '';
    const requested = raw ? raw.toLowerCase().split(',').map(value => value.trim()) : [];
    if (method !== 'POST' || !requested.length || requested.length > PREFLIGHT_HEADERS.size
      || new Set(requested).size !== requested.length || requested.some(value => !PREFLIGHT_HEADERS.has(value))) {
      return refuse(req, res, 'cors-headers');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', requested.join(', '));
    res.setHeader('Access-Control-Max-Age', '300');
    return res.status(204).end();
  });

  route('POST', publicRoute, (req, res) => {
    try {
      const policy = boundary();
      if (!headers(req, res, policy)) return refuse(req, res, 'origin');
      if (req.url.includes('?')) throw invalid(null, 'unexpected-query');
      if (req.headers.authorization || req.headers.cookie) throw new ApiError('forbidden');
      if (req.headers['x-ao-request'] !== '1' || !req.is('application/json')) throw invalid(null, 'content-type');
      if (Number(req.headers['content-length'] || 0) > 512) throw invalid(null, 'too-large');
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2
        || Object.keys(body).some(key => !['nonce', 'planId'].includes(key))) throw invalid(null, 'invalid-body');
      if (typeof body.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(body.nonce)
        || typeof body.planId !== 'string' || !/^acp_[a-f0-9]{32}$/.test(body.planId)) throw invalid(null, 'invalid-challenge');
      return res.status(200).json(externalAccess.consumeDiagnosticChallenge({ nonce: body.nonce, planId: body.planId }));
    } catch (error) { return sendError(req, res, error); }
  });
  return app;
}

module.exports = { mountAccessDiagnostic, PATH };
