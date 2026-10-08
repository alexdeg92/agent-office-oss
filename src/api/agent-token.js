'use strict';
/*
 * S7d (projects-13 plan): the primary agent's scoped machine token. `Authorization: Bearer <token>`.
 * Mounted FIRST (before the audit router and every route), so the decision is made before any handler:
 *   - a bearer request never uses a cookie: its Cookie header is dropped (privileges never mix);
 *   - unknown, malformed or revoked token → 401 unauthorized (nothing says which);
 *   - 30 requests/min per token, counted BEFORE everything else (refused requests count too) → 429 rate_limited;
 *   - one allowlist of (method, route, body fields), matched with the routes' own Express Router semantics;
 *     everything else (every GET, the stream, v1, other commands) → 403 forbidden (issue 'token-scope');
 *   - a body `actor` → 400 unexpected-field; any field outside the allowlist → 400 unexpected-field;
 *   - an allowed request carries req.principal = { kind: 'agent', tokenId, agentId, personId } and is audited by the
 *     audit router as that agent; every refusal is audited here. Never the token or the body.
 */
const express = require('express');
const { ApiError, sendError, invalid } = require('./v2/errors');

const RATE = { max: 30, windowMs: 60 * 1000 };
const HISTORY_KINDS = new Set(['commit', 'flow-run', 'cron-run', 'session', 'agent-action']);

// The allowlist (api.md §5.4 for the commands; projects-13 for the scope).
const ALLOWED = [
  { method: 'put', path: '/api/v2/projects/:id/status', command: 'projects.setStatus', fields: ['expectedRevision', 'status'] },
  { method: 'patch', path: '/api/v2/projects/:id', command: 'projects.edit', fields: ['expectedRevision', 'summary'], required: ['summary'] },
  { method: 'post', path: '/api/v2/projects/:id/flags', command: 'projects.addFlag', fields: ['expectedRevision', 'kind', 'label'], check: (b) => b.kind === 'label' || 'kind' },
  // history: the kind's own payload fields pass through to the module's validation; only `actor` is refused
  { method: 'post', path: '/api/v2/projects/:id/history', command: 'projects.appendHistory', fields: null, check: (b) => HISTORY_KINDS.has(b.kind) || 'kind' },
];

function createAgentTokenGate({ tokens, personOf, audit, allowedAgent = null, now = () => Date.now(), log = () => {} }) {
  const hits = new Map();   // tokenId → [ms…] within the window
  const allow = express.Router();
  for (const spec of ALLOWED) allow[spec.method]((spec.path.startsWith('/api/v2/') ? [spec.path, spec.path.replace('/api/v2/', '/api/v3/')] : spec.path), (req, res, next) => { req.tokenRoute = spec; next('router'); });

  const record = (req, principal, command, outcome, detail) => {
    req.auditedByGate = true;   // the audit router (mounted first) skips what the gate recorded itself
    try {
      audit({ at: now(), requestId: req.requestId, actor: principal ? { kind: 'agent', personId: principal.personId } : { kind: 'anonymous' },
        command, target: null, outcome, detail: [detail, principal ? 'token:' + principal.tokenId : null].filter(Boolean).join(' ') });
    } catch (_) { log('audit: append failed'); }
  };

  // 1. before body parsing: the credential, the rate limit, and the principal (R15-05)
  function auth(req, res, next) {
    const h = req.headers.authorization;
    if (h === undefined) return next();
    delete req.headers.cookie;                                     // a bearer request never carries cookie privileges
    const m = /^Bearer ([^\s]+)$/.exec(String(h));
    const found = m ? tokens.resolve(m[1]) : null;
    if (!found) { record(req, null, 'token.request', 'rejected', 'unauthorized'); return sendError(req, res, new ApiError('unauthorized')); }
    const personId = personOf(found.agentId);
    const principal = { kind: 'agent', tokenId: found.id, agentId: found.agentId, personId };
    const t = now();
    const list = (hits.get(found.id) || []).filter((x) => t - x < RATE.windowMs);
    list.push(t); hits.set(found.id, list);
    if (list.length > RATE.max) { record(req, principal, 'token.request', 'rejected', 'rate-limited'); return sendError(req, res, new ApiError('rate_limited')); }
    // R15-06: only the supported agent identity may write (until G3a passes any agent's Person through projects)
    if (!personId || (allowedAgent && found.agentId !== allowedAgent())) {
      record(req, principal, 'token.request', 'rejected', 'token-scope');
      return sendError(req, res, new ApiError('forbidden', { details: [{ issue: 'token-scope' }] }));
    }
    req.principal = principal;   // the audit router attributes even a parser refusal to this agent
    req.tokenRoute = null;
    allow(req, res, () => {
      if (!req.tokenRoute) {
        record(req, principal, 'token.request', 'rejected', 'token-scope');
        return sendError(req, res, new ApiError('forbidden', { details: [{ issue: 'token-scope' }] }));
      }
      next();
    });
  }

  // 2. after body parsing: the allowlisted fields
  function scope(req, res, next) {
    if (!req.principal || req.principal.kind !== 'agent') return next();
    const spec = req.tokenRoute;
    const principal = req.principal;
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const bad = Object.prototype.hasOwnProperty.call(b, 'actor') ? 'actor'
      : spec.fields ? Object.keys(b).find((k) => !spec.fields.includes(k)) : null;
    const missing = (spec.required || []).find((k) => b[k] === undefined);
    const failed = spec.check ? spec.check(b) : true;
    const err = bad ? invalid(bad, 'unexpected-field') : missing ? invalid(missing, 'required') : failed !== true ? invalid(failed, 'invalid') : null;
    if (err) { record(req, principal, spec.command, 'rejected', 'http-400'); return sendError(req, res, err); }
    next();
  }

  return { auth, scope };
}

module.exports = { createAgentTokenGate, ALLOWED, RATE };
