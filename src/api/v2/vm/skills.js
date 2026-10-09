'use strict';
// SkillListVM, SkillDetailVM (api.md §3.7). Pure builders over canonical Skill / SkillInfo plus the SKILL.md body
// (read by the adapter under R1-11). S7: the v1 `skillSteps` / `outputTags` heuristics live here as flowOf().

const { safeExternalUrl } = require('../../../../public/v2/url-policy.js');
const ORDER = { active: 0, unavailable: 1, disabled: 2 };

function rowVM(s) {
  return { id: s.name, emoji: s.emoji, description: s.description, source: s.source, status: s.status,
    visibility: { model: s.visibility.model, command: s.visibility.command, user: s.visibility.user } };
}

function buildSkillListVM(skills) {
  const list = skills.slice().sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name, 'fr')).map(rowVM);
  return { skills: list, counts: { total: list.length, active: list.filter((s) => s.status === 'active').length } };
}

// Steps: the first numbered list in the document (under any heading), else its level-2 headings. At most 8, 72 chars.
// Outputs: what the document says it produces (files written, a message sent, tool actions), else the agent's reply.
const clip = (s) => (s.length > 72 ? s.slice(0, 71) + '…' : s);
function flowOf(markdown, description) {
  const md = String(markdown || '').replace(/```[\s\S]*?```/g, '');
  let steps = [];
  const numbered = [...md.matchAll(/^\s{0,3}\d+[.)]\s+(.+)$/gm)].map((m) => m[1].replace(/[*_`]/g, '').trim()).filter(Boolean);
  if (numbered.length) steps = numbered;
  else steps = [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].replace(/[*_`#]/g, '').trim()).filter(Boolean);
  steps = steps.slice(0, 8).map(clip);
  const text = (md + ' ' + (description || '')).toLowerCase();
  const outputs = [];
  if (/\b(write|writes|save|saves|create[sd]? (a |the )?file|fichier|enregistr|écri[rt])/.test(text)) outputs.push('files');
  if (/\b(send|sends|post|posts|message|discord|whatsapp|notify|envoi|envoy|publi)/.test(text)) outputs.push('message');
  if (/\b(run|runs|exec|execute|command|shell|install|commande|exécut)/.test(text)) outputs.push('tool-actions');
  if (!outputs.length) outputs.push('agent-reply');
  return { steps, outputs };
}

/**
 * @param {object} skill     canonical Skill (null → not found)
 * @param {object|null} info canonical SkillInfo (null when `skills info` failed)
 * @param {{markdown: string}} doc
 * @param {boolean} needsRestart
 */
function buildSkillDetailVM(skill, info, doc, needsRestart) {
  if (!skill) return null;
  const markdown = (doc && doc.markdown) || '';
  return {
    skill: Object.assign(rowVM(skill), { homepage: safeExternalUrl(skill.homepage) || safeExternalUrl(info && info.homepage) }),
    detail: info ? { always: info.always, blockedBy: Object.assign({}, info.blockedBy), requirements: info.requirements, missing: info.missing,
      install: info.install.map((x) => ({ id: x.id, kind: x.kind, label: x.label, bins: x.bins.slice() })) } : null,
    markdown,
    flow: flowOf(markdown, skill.description),
    needsRestart: !!needsRestart,
  };
}

module.exports = { buildSkillListVM, buildSkillDetailVM, flowOf };
