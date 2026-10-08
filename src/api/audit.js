'use strict';
/*
 * Audit of every write command (storage.md §4 audit_log). Mounted BEFORE the read-only backstop, so refused
 * attempts are recorded too. Never a request body or an error message: `target` is the route's id segment,
 * `detail` a category.
 *   outcome ok        2xx (and no `ok:false` in the body)
 *           rejected  4xx: readonly (403), unauthorized (401), invalid (other 4xx)
 *           failed    5xx (http-5xx) or a 2xx carrying ok:false (the legacy routes' CLI failure: cli-not-ok)
 * S6.2:
 *   - R8-06: matching uses an Express Router declared with the SAME patterns as the real routes, so it has the
 *     router's own semantics (case-insensitive, optional trailing slash, decoding): every variant that can run
 *     a write is audited.
 *   - R8-07: the actor is the VERIFIED session's owner; no, invalid, expired or revoked session → recorded as
 *     `{ kind: 'anonymous' }` (an attempt, never attributed to the owner).
 */
const express = require('express');

// every audited write (api.md §4); the v1 entries went with v1 (S16)
const AUDITED_COMMANDS = [
  // API v2 store commands (transport control is never audited, api.md §4.2)
  { method: 'put', path: '/api/v2/health/issues/:id/muted', command: () => 'health.mute', target: (p) => p.id },
  // S7a, Projets (api.md §5.4): every write, the target is the project id
  { method: 'post', path: '/api/v2/projects', command: () => 'projects.create', target: () => null },
  { method: 'post', path: '/api/v2/projects/import', command: () => 'projects.import', target: () => null },
  { method: 'patch', path: '/api/v2/projects/:id', command: () => 'projects.edit', target: (p) => p.id },
  { method: 'put', path: '/api/v2/projects/:id/status', command: () => 'projects.setStatus', target: (p) => p.id },
  { method: 'put', path: '/api/v2/projects/:id/archived', command: () => 'projects.setArchived', target: (p) => p.id },
  { method: 'post', path: '/api/v2/projects/:id/flags', command: () => 'projects.addFlag', target: (p) => p.id },
  { method: 'delete', path: '/api/v2/projects/:id/flags/:kind/:key', command: () => 'projects.removeFlag', target: (p) => p.id },
  { method: 'put', path: '/api/v2/projects/:id/flags/risk/:key/ack', command: () => 'projects.ackRisk', target: (p) => p.id },
  { method: 'post', path: '/api/v2/projects/:id/sources', command: () => 'projects.linkSource', target: (p) => p.id },
  { method: 'delete', path: '/api/v2/projects/:id/sources/:sourceId', command: () => 'projects.unlinkSource', target: (p) => p.id },
  { method: 'put', path: '/api/v2/projects/:id/people/:personId', command: () => 'projects.setPersonOverride', target: (p) => p.id },
  { method: 'post', path: '/api/v2/projects/:id/history', command: () => 'projects.appendHistory', target: (p) => p.id },
  { method: 'post', path: '/api/v2/projects/:id/cover/regenerate', command: () => 'projects.regenerateCover', target: (p) => p.id },
  { method: 'put', path: '/api/v2/projects/:id/cover', command: () => 'projects.uploadCover', target: (p) => p.id },
  { method: 'post', path: '/api/v2/projects/:id/summary/regenerate', command: () => 'projects.regenerateSummary', target: (p) => p.id },
  // architect-57: the project thread
  { method: 'post', path: '/api/v2/projects/:id/comments', command: () => 'projects.comment', target: (p) => p.id },
  { method: 'post', path: '/api/v2/projects/:id/comments/:cid/retry', command: () => 'projects.retryComment', target: (p) => p.id },
  { method: 'patch', path: '/api/v2/projects/:id/comments/:cid', command: () => 'projects.editComment', target: (p) => p.id },
  { method: 'delete', path: '/api/v2/projects/:id/comments/:cid', command: () => 'projects.deleteComment', target: (p) => p.id },
  // S7c, OpenClaw commands (api.md §5.1, §5.2)
  { method: 'post', path: '/api/v2/flows', command: () => 'flows.create', target: () => null },
  { method: 'patch', path: '/api/v2/flows/:jobId', command: () => 'flows.edit', target: (p) => p.jobId },
  { method: 'put', path: '/api/v2/flows/:jobId/enabled', command: () => 'flows.setEnabled', target: (p) => p.jobId },
  { method: 'post', path: '/api/v2/flows/:jobId/runs', command: () => 'flows.run', target: (p) => p.jobId },
  { method: 'delete', path: '/api/v2/flows/:jobId', command: () => 'flows.delete', target: (p) => p.jobId },
  { method: 'put', path: '/api/v2/skills/:name/enabled', command: () => 'skills.setEnabled', target: (p) => p.name },
  { method: 'post', path: '/api/v2/gateway/restart', command: () => 'gateway.restart', target: () => null },
  { method: 'post', path: '/api/v2/chat/messages', command: () => 'chat.send', target: () => null },
  // S14b
  { method: 'put', path: '/api/v2/office/layout', command: () => 'office.saveLayout', target: () => null },
  { method: 'put', path: '/api/v2/office/layout/theme', command: () => 'office.setTheme', target: () => null },
  { method: 'patch', path: '/api/v2/prefs', command: () => 'prefs.update', target: () => null },
];
const safeTarget = (t) => (t == null ? null : String(t).replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 200) || null);

function outcomeOf(status, body) {
  if (status >= 500) return { outcome: 'failed', detail: 'http-' + status };
  // R16-05: a 403 says why (csrf, token-scope, readonly…), from the error body; the v1 read-only text is 'readonly'
  if (status === 403) {
    const e = body && body.error;
    const issue = e && Array.isArray(e.details) && e.details[0] && e.details[0].issue;
    if (typeof issue === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(issue)) return { outcome: 'rejected', detail: issue };
    if (e && typeof e.code === 'string') return { outcome: 'rejected', detail: e.code === 'readonly' ? 'readonly' : 'http-403' };
    if (typeof e === 'string' && e.startsWith('Requête refusée')) return { outcome: 'rejected', detail: 'csrf' };
    return { outcome: 'rejected', detail: 'readonly' };
  }
  if (status === 401) return { outcome: 'rejected', detail: 'unauthorized' };
  if (status >= 400) return { outcome: 'rejected', detail: 'http-' + status };
  if (body && typeof body === 'object' && body.ok === false) return { outcome: 'failed', detail: 'cli-not-ok' };
  return { outcome: 'ok', detail: null };
}

// → an Express Router (mount it before the read-only backstop). `sessionOf(req)` verifies the cookie.
function auditMiddleware({ store, sessionOf, now = () => Date.now(), commands = AUDITED_COMMANDS, log = () => {} }) {
  const router = express.Router();
  for (const spec of commands) {
    router[spec.method]((spec.path.startsWith('/api/v2/') ? [spec.path, spec.path.replace('/api/v2/', '/api/v3/')] : spec.path),   // G5: /api/v3 too
      (req, res, next) => {
      const params = Object.assign({}, req.params);
      const session = sessionOf ? sessionOf(req) : null;
      let body;
      const json = res.json.bind(res);
      res.json = (b) => { body = b; return json(b); };
      // Recorded when the status line is written, BEFORE any byte reaches the client: whoever has seen the response can
      // see its audit row (with 'finish' the row could land after the client read the response; flaky tests showed it)
      let recorded = false;
      const writeHead = res.writeHead;
      res.writeHead = function (statusCode, ...rest) {
        if (!recorded) { recorded = true; record(typeof statusCode === 'number' ? statusCode : res.statusCode); }
        return writeHead.call(this, statusCode, ...rest);
      };
      const record = (status) => {
        if (req.auditedByGate) return;   // S7d: the token gate recorded this attempt (one row per attempt)
        const { outcome, detail } = outcomeOf(status, body);
        // S7d: a token request (req.principal, set by the token gate) is the agent's; it never has a cookie session
        const p = req.principal;
        const actor = p && p.kind === 'agent' ? { kind: 'agent', personId: p.personId } : session ? { kind: 'human', personId: store.owner.id } : { kind: 'anonymous' };
        const det = p && p.kind === 'agent' ? [detail, 'token:' + p.tokenId].filter(Boolean).join(' ') : detail;
        try {
          store.audit.append({ at: now(), requestId: req.requestId, actor, command: spec.command(params), target: safeTarget(spec.target(params)), outcome, detail: det });
        } catch (_) { log('audit: append failed'); }
      };
      next('router');                      // matched: leave the audit router, continue to the real handlers
    });
  }
  return router;
}

module.exports = { auditMiddleware, outcomeOf, AUDITED_COMMANDS };
