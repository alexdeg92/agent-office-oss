// Compétences (F6, office-dev): the sentences of the skills pages, chosen by rules from SkillListVM / SkillDetailVM.
// Pure: VM → message descriptors { key, params, tone } (messages/skills.js). Evidence rules (editorial-guide.md §2):
//   - `status: 'unavailable'` alone never claims a missing requirement; only `detail.missing` does;
//   - active is not invoked or authorized; visible is not permitted;
//   - `detail: null` means the details were not received, not that there are none.
// Lead order: no snapshot → cached → pending restart (detail) → unavailable → disabled → normal / empty.

export const SCOPES = ['model', 'command', 'user'];

// A param that is one of this page's own UI messages (not a server LabelRef): { ui: key }. The page resolves it
// with localize(descriptor, msg) before rendering; i18n's nested LabelRefs only look up server labels.
const ui = (key) => ({ ui: key });
/** Replaces every { ui: key } inside a descriptor's params with msg(key). Pure (msg is injected). */
export function localize(d, msg) {
  const walk = (v) => (Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? ('ui' in v && Object.keys(v).length === 1 ? msg(v.ui) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))) : v);
  return d && { ...d, ...(d.params && { params: walk(d.params) }) };
}
export const outputsParam = (outputs) => outputs.map((o) => ui('skill.output.' + o));
export const STATUSES = ['active', 'disabled', 'unavailable'];
export const REQ_KINDS = ['bins', 'anyBins', 'env', 'config', 'os'];
const MARGIN_MAX = 5;

/** The list page's lead. */
export function listLead(vm, { cached = false, cachedAt = null } = {}) {
  const skills = vm.skills;
  const head = [];
  if (cached) head.push(cachedAt != null ? { key: 'editorial.cached', params: { date: { at: cachedAt } }, tone: 'warning' } : { key: 'editorial.unknownTime', tone: 'warning' });
  if (!skills.length) return { kicker: 'skills.kicker', kickerTone: null, head: [...head, { key: 'skills.empty.head' }], stand: [{ key: 'skills.empty.text' }], unavailable: [], more: 0 };
  const unavailable = skills.filter((s) => s.status === 'unavailable');
  if (unavailable.length) head.push({ key: 'skills.head.unavailable', params: { n: unavailable.length }, tone: 'warning' });
  else head.push({ key: 'skills.head.allAvailable' });
  const disabled = skills.filter((s) => s.status === 'disabled').length;
  const stand = [{ key: 'skills.stand.active', params: { active: vm.counts.active, n: vm.counts.total } }];
  if (disabled) stand.push({ key: 'skills.stand.disabled', params: { n: disabled } });
  if (unavailable.length) stand.push({ key: 'skills.stand.whyUnavailable' });
  return {
    kicker: unavailable.length ? 'skills.kicker.check' : 'skills.kicker', kickerTone: unavailable.length ? 'warning' : null,
    head, stand, unavailable: unavailable.slice(0, MARGIN_MAX), more: Math.max(0, unavailable.length - MARGIN_MAX),
  };
}

/** One skill's state, as one line. */
export const stateSentence = (s) => ({ active: { key: 'skills.state.active' }, disabled: { key: 'skills.state.disabled' },
  unavailable: { key: 'skills.state.unavailable', tone: 'warning' } }[s.status] ?? { key: 'vocab.other', params: { id: String(s.status) } });

/** Where the skill can be invoked from, as a sentence (an empty visibility is internal use). */
export function visibilitySentence(v) {
  const scopes = SCOPES.filter((k) => v && v[k]).map((k) => ui('skill.scope.' + k));
  return scopes.length ? { key: 'skills.meta.visible', params: { scopes } } : { key: 'skills.meta.internal' };
}

/** A source label: known sources by key; an unknown one keeps its safe id (open vocabulary). */
export const sourceRef = (src) => ({ key: 'skillSource.' + src });

/** The list filters (display only). */
export function matches(s, { status, source, scope }) {
  return (!status || s.status === status) && (!source || s.source === source) && (!scope || !!(s.visibility && s.visibility[scope]));
}

/** The detail page's lead. */
export function detailLead(d) {
  const s = d.skill;
  const head = [];
  const stand = [];
  if (d.needsRestart) head.push({ key: 'skill.head.restartPending', tone: 'warning' });
  if (s.status === 'unavailable') {
    const missing = missingList(d.detail);
    if (missing.length) head.push({ key: 'skill.head.missing', params: { n: missing.length, requirements: missing.map((m) => m.value) }, tone: 'warning' });
    else head.push({ key: 'skill.head.unavailable', tone: 'warning' });
    if (!d.detail) stand.push({ key: 'skill.stand.noDetails' });
    else if (!missing.length && blockers(d.detail).length) stand.push({ key: 'skill.stand.blocked', params: { by: blockers(d.detail).map((b) => ui('skill.blocker.' + b)) } });
    stand.push({ key: 'skill.stand.enableDoesNotInstall' });
  } else if (s.status === 'disabled') head.push({ key: 'skill.head.disabled' });
  else head.push({ key: 'skill.head.active' });
  if (d.needsRestart) stand.unshift({ key: 'skill.stand.restartPending' });
  return { head, stand };
}

/** What blocks the skill (allowlist, agent filter, platform), when the details say so. */
export const blockers = (detail) => (detail ? ['allowlist', 'agentFilter', 'platform'].filter((k) => detail.blockedBy && detail.blockedBy[k]) : []);

/** Missing requirements, flattened: [{ kind, value }] (empty when the details don't say). */
export function missingList(detail) {
  if (!detail || !detail.missing) return [];
  return REQ_KINDS.flatMap((k) => (detail.missing[k] || []).map((value) => ({ kind: k, value })));
}

/** Requirement rows: only kinds with entries, each value marked present or missing. Empty categories are omitted. */
export function requirementRows(detail) {
  if (!detail || !detail.requirements) return [];
  return REQ_KINDS.filter((k) => (detail.requirements[k] || []).length).map((k) => ({
    kind: k,
    values: detail.requirements[k].map((v) => ({ value: v, missing: !!(detail.missing && (detail.missing[k] || []).includes(v)) })),
  }));
}
