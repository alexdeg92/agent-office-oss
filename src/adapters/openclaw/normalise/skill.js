'use strict';
// skills list / info → Skill[] / SkillDetail (data-model.md §6).
const SOURCE = { 'openclaw-bundled': 'bundled', 'openclaw-extra': 'extra', 'openclaw-workspace': 'workspace', 'openclaw-workshop': 'workshop', 'openclaw-custodian': 'custodian' };
const reqs = (m) => (m ? { bins: m.bins || [], anyBins: m.anyBins || [], env: m.env || [], config: m.config || [], os: m.os || [] } : null);

function source(raw, issue, path) {
  if (raw == null) return 'unrecognized';
  if (Object.prototype.hasOwnProperty.call(SOURCE, raw)) return SOURCE[raw];   // R2-03
  issue('enum.unmapped', 'warn', path, 'value not in the table', { length: String(raw).length });
  return 'unrecognized';
}

function normaliseSkills(v, issue) {
  return v.skills.map((s) => ({
    name: s.name, emoji: s.emoji || null, description: s.description || '',
    source: source(s.source, issue, '$.skills[].source'), rawSource: s.source || null, bundled: !!s.bundled,
    status: s.disabled ? 'disabled' : s.eligible !== false ? 'active' : 'unavailable',
    visibility: { model: !!s.modelVisible, command: !!s.commandVisible, user: !!s.userInvocable },
    homepage: s.homepage || null, missing: reqs(s.missing),
  }));
}

function normaliseSkillInfo(i, issue) {
  return {
    name: i.name, filePath: i.filePath || null, always: !!i.always,
    source: source(i.source, issue, '$.source'),
    blockedBy: { allowlist: !!i.blockedByAllowlist, agentFilter: !!i.blockedByAgentFilter, platform: !!i.platformIncompatible },
    requirements: reqs(i.requirements), missing: reqs(i.missing),
    install: (i.install || []).map((x) => ({ id: x.id, kind: x.kind, label: x.label || x.kind, bins: x.bins || [] })),
    homepage: i.homepage || null,
  };
}

module.exports = { normaliseSkills, normaliseSkillInfo, SOURCE };
