'use strict';

// Runtime adapters opt into workspace projects by attaching an opaque projectRef
// and a safe projectLabel to canonical sessions. This join is deliberately
// adapter-neutral: source identity and connector branding come from the engine.
const crypto = require('node:crypto');
const { redactChatIdentity } = require('../security/redact-text');

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const projectId = (sourceId, projectRef, idKey) => {
  if (typeof idKey !== 'string' || idKey.length < 32) throw new TypeError('runtime project ID key required');
  const digest = crypto.createHmac('sha256', idKey).update(`runtime-project\0${sourceId}\0${projectRef}`).digest('hex').slice(0, 24);
  return `runtimeprj_${digest}`;
};
const personId = (sourceId, agentId) => `per_runtime_${hash(`${sourceId}\0${agentId}`)}`;

function connectorBrand(mark) {
  if (!mark || typeof mark !== 'object') return null;
  return {
    mark: String(mark.mark || mark.monogram || '?').slice(0, 3),
    providerName: typeof mark.providerName === 'string' ? mark.providerName : null,
    logo: typeof mark.logo === 'string' ? mark.logo : null,
    logoDark: typeof mark.logoDark === 'string' ? mark.logoDark : null,
    color: typeof mark.color === 'string' ? mark.color : null,
    foreground: typeof mark.foreground === 'string' ? mark.foreground : null,
  };
}

function collectRuntimeProjects({ sessions = [], agents = [], connectorOf = () => null, idKey } = {}) {
  const agentRows = agents instanceof Map ? agents : new Map((agents || []).map(row => [row.id, row]));
  const groups = new Map();
  for (const session of sessions || []) {
    if (typeof session?.projectRef !== 'string' || !session.projectRef || typeof session.projectLabel !== 'string' || !session.projectLabel.trim()) continue;
    const connector = connectorOf(session.key);
    if (!connector || typeof connector.id !== 'string' || !connector.id) continue;
    const declaration = connector.projectSource;
    if (!declaration || declaration.kind !== 'runtime' || declaration.projectRefField !== 'projectRef'
      || declaration.projectLabelField !== 'projectLabel' || declaration.capabilities?.read !== true) continue;
    const key = `${connector.id}\0${session.projectRef}`;
    const group = groups.get(key) || { sourceId: connector.id, connector, declaration, projectRef: session.projectRef, label: null, sessions: [], agents: new Map() };
    const label = redactChatIdentity(session.projectLabel, { role: 'conversation', maxLength: 120 });
    if (label && !group.label) group.label = label;
    group.sessions.push(session);
    const agentId = session.class?.agentId;
    if (typeof agentId === 'string' && agentId) group.agents.set(agentId, agentRows.get(agentId) || { id: agentId, name: null });
    groups.set(key, group);
  }

  const projects = [], persons = [];
  for (const group of groups.values()) {
    if (!group.label) continue;
    const source = { id: `runtime:${group.sourceId}`, kind: 'runtime', runtime: group.connector.adapter || null,
      label: { key: 'project.source.label', params: { label: group.connector.name || group.connector.adapter || 'Runtime' } },
      brand: connectorBrand(group.connector.mark) };
    const people = [];
    for (const [agentId, agent] of group.agents) {
      const id = personId(group.sourceId, agentId);
      const name = redactChatIdentity(agent.name, { role: 'conversation', maxLength: 120 }) || null;
      persons.push({ id, kind: 'agent', name: name || 'Agent', avatarUrl: null, links: null });
      people.push({ personId: id, role: null, origin: 'derived', liveState: null, commitCount: null });
    }
    const sessionTimes = group.sessions.map(row => row.updatedAt).filter(Number.isSafeInteger);
    const lastActivityAt = sessionTimes.length ? Math.max(...sessionTimes) : null;
    const titleSession = [...group.sessions].filter(row => typeof row.displayName === 'string' && row.displayName.trim())
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    const context = titleSession ? redactChatIdentity(titleSession.displayName, { role: 'conversation', maxLength: 240 }) : null;
    const activityCount = group.sessions.some(row => Number.isSafeInteger(row.messageCount))
      ? group.sessions.reduce((count, row) => count + (Number.isSafeInteger(row.messageCount) ? row.messageCount : 0), 0) : null;
    const activelyRunning = group.sessions.some(row => row.run?.status === 'running');
    const id = projectId(group.sourceId, group.projectRef, idKey);
    projects.push({
      id, name: group.label, status: activelyRunning ? 'in-progress' : 'todo', priority: 'P9', revision: 0,
      archivedAt: null, summary: context || null, summaryMeta: null, flags: [], people, sources: [], sourceDescriptors: [source],
      repo: null, cover: null, repoStatus: null,
      readOnly: group.declaration.capabilities.write !== true,
      commentCapability: group.declaration.capabilities.comments || 'unsupported',
      historyCapability: group.declaration.capabilities.history || 'unsupported', activityCount,
      sessionCount: group.sessions.length, agentCount: group.agents.size,
      createdAt: sessionTimes.length ? Math.min(...sessionTimes) : 0, lastActivityAt: lastActivityAt ?? 0,
      runtimeProject: { sourceId: group.sourceId, projectRef: group.projectRef, sessionKeys: group.sessions.map(row => row.key) },
    });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { projects, persons };
}

module.exports = { collectRuntimeProjects, projectId, personId, connectorBrand };
