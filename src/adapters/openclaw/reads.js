'use strict';
/*
 * Typed on-demand reads (ADR-001 §12.4). Each read asks the runtime and resolves once the answer has been
 * ingested: the taps feed the RPC/CLI output through the engine (validation, quarantine, last-good), so the
 * caller then reads the canonical value from the engine. → { ok: true } | { ok: false, category }.
 * Each read exists iff its capability is true (definition.capabilities()).
 */
const { errorCategory } = require('../../engine/redact');

const fail = (e) => ({ ok: false, category: errorCategory(e && e.message) });

function bind({ gw, cli }) {
  // `background` (architect-54, the project-tag scan): a failed read is not recorded as a source error (a session may be
  // gone since the list); a successful one is ingested like any other. The flag never reaches the gateway.
  const rpc = (method, params, opts = {}) => gw.call(method, params, opts.background ? { background: true } : undefined).then(() => ({ ok: true }), fail);
  return {
    // sessions.get takes the key only on 2026.9.8; the window is applied by the caller (transcript normaliser).
    transcript: (sessionKey, opts = {}) => rpc('sessions.get', { key: sessionKey }, opts),
    describeSession: (sessionKey) => rpc('sessions.describe', { key: sessionKey }),
    // S7b: the session-group catalog (read scope, path-free); membership arrives on the session rows (`category`)
    sessionGroups: () => rpc('sessions.groups.list', {}),
    flowRuns: (flowId, opts = {}) => rpc('cron.runs', Object.assign({ jobId: flowId }, Number.isInteger(opts.limit) ? { limit: Math.min(200, Math.max(1, opts.limit)) } : {})),
    // Per-agent CLI command: --agent is mandatory (CLAUDE.md gotcha). The primary agent comes from the resolver in G3a.
    skillInfo: async (name, opts = {}) => {
      if (!opts.agentId) return { ok: false, category: 'missing-agent' };   // G3a: the caller passes the resolver's primary
      const r = await cli.run(['skills', 'info', name, '--agent', opts.agentId, '--json'], 30000);
      if (r.ok) return { ok: true };
      return { ok: false, category: r.refused || errorCategory(r.err) };
    },
  };
}

module.exports = { bind };
