'use strict';
/*
 * The ONE primary-agent resolver (ADR-001 §12.2, G3a). Pure.
 *   1. the configured primary (instance config; AO_PRIMARY_AGENT until G4's config file) if it names a listed agent;
 *      otherwise a warn issue `config.primary-invalid` and the next rule;
 *   2. the adapter's `isPrimary` flag (OpenClaw: the runtime's defaultId; no 'main' fallback);
 *   3. the first agent in listing order, with an info issue `config.primary-guessed`;
 *   4. before any agent list: null.
 * Every consumer (commands, Persons, the office, LabelRef {agent}, the token principal) reads this, never a literal.
 *
 * @param {Array} agents     canonical Agent[] (listing order) or null before the first listing
 * @param {{ primary?: string|null }} config
 * @returns {{ agentId: string, source: 'config' | 'runtime' | 'guessed', issues: Array } | { agentId: null, source: null, issues: [] }}
 */
function resolvePrimaryAgent(agents, config = {}) {
  const issues = [];
  if (!Array.isArray(agents) || agents.length === 0) return { agentId: null, source: null, issues };
  const wanted = typeof config.primary === 'string' && config.primary ? config.primary : null;
  if (wanted) {
    if (agents.some((a) => a.id === wanted)) return { agentId: wanted, source: 'config', issues };
    issues.push({ code: 'config.primary-invalid', severity: 'warn', path: '$.agents.primary' });
  }
  const flagged = agents.find((a) => a.isPrimary);
  if (flagged) return { agentId: flagged.id, source: 'runtime', issues };
  issues.push({ code: 'config.primary-guessed', severity: 'info', path: null });
  return { agentId: agents[0].id, source: 'guessed', issues };
}

module.exports = { resolvePrimaryAgent };
