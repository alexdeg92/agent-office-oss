// Shared editor/Store appearance rows and owner edits.
import { updateAgent, effectiveAccessories, resolveOccupants, ruleKind } from './editor-model.js';
import { defaultAccessoriesFor, canonicalRuleId, canonicalRole, roleOfRule, automaticAppearance } from './layout-rules.js';

const DAY_MS = 86_400_000;

/** Live, recently seen, configured and default rows; preserve existing rule IDs and saved automatic looks. */
export function agentRows(draft, live, seen, defaultLabel, now = Date.now()) {
  const rows = new Map();
  const ruleId = (id) => draft.agents.find((a) => canonicalRuleId(a.agentId) === canonicalRuleId(id))?.agentId ?? id;
  const add = (id, row) => { const k = canonicalRuleId(id) ?? id; if (!rows.has(k)) rows.set(k, { ...row, id: ruleId(id), role: canonicalRole(row.role) ?? row.role }); };
  for (const o of live) add(o.id, { role: o.role, sourceName: o.sourceName ?? o.name, automaticLook: o.automaticLook, live: true });
  for (const s of seen ?? []) if (now - s.lastSeenAt < 30 * DAY_MS) add(s.id, { role: s.role, sourceName: s.name, automaticLook: s.automaticLook, live: false });
  for (const a of draft.agents) if (ruleKind(a.agentId) !== 'default') add(a.agentId, { role: roleOfRule(a), sourceName: a.name ?? a.agentId, live: false });
  const people = [...rows.values()].sort((a, b) => (a.role === 'primary' ? -1 : b.role === 'primary' ? 1 : 0));
  const defaults = draft.agents.filter((a) => ruleKind(a.agentId) === 'default').map((a) => ({ id: a.agentId, role: roleOfRule(a), sourceName: defaultLabel(a.agentId), isDefault: true }));
  return [...people, ...defaults];
}

/** The rule a look edit writes to: the agent's exact rule, or one created on first change from the resolved look. */
export function ruleView(draft, index, row) {
  const exact = draft.agents.find((a) => canonicalRuleId(a.agentId) === canonicalRuleId(row.id));
  if (exact && !automaticAppearance(exact)) return { rule: exact, own: true };
  const [r] = resolveOccupants(draft, index, [{ id: row.id, role: row.role, sourceName: row.sourceName, automaticLook: row.automaticLook }]);
  return { rule: { agentId: row.id, match: { kind: row.role }, name: null, role: null, station: 'auto', ...exact, ...r.look, ...(r.automaticLook && { appearance: 'auto' }) }, own: !!exact, resolved: r };
}

/** The draft with `patch` applied to the row's rule (created from the resolved look on first change). */
export function patchAgent(draft, index, row, patch) {
  const { rule, own } = ruleView(draft, index, row);
  let next = draft;
  if (!own) next = updateAgent(next, row.id, { ...rule });
  else if (rule.appearance === 'auto') next = updateAgent(next, row.id, { appearance: 'auto' });
  const editsLook = ['character', 'variant', 'accessories'].some(k => Object.hasOwn(patch, k));
  next = updateAgent(next, row.id, { ...patch, ...(editsLook && { appearance: 'manual' }) });
  const a = next.agents.find((x) => x.agentId === row.id);
  for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
  return next;
}

/** Effective looks: reuse saved automatic appearances; resolve manual wildcard colours together. */
export function looksOf(draft, index, rows) {
  const people = rows.filter((r) => !r.isDefault);
  const resolved = new Map(resolveOccupants(draft, index, people.map((r) => ({ id: r.id, role: r.role, sourceName: r.sourceName, automaticLook: r.automaticLook }))).map((o, i) => [people[i].id, o.look]));
  const out = {};
  for (const r of rows) {
    const { rule, own } = ruleView(draft, index, r);
    if (r.isDefault || (own && !automaticAppearance(rule))) {
      const c = index.characters.get(rule.character);
      out[r.id] = { character: rule.character, variant: rule.variant ?? c?.variants?.[0]?.id ?? null, accessories: effectiveAccessories(index, rule) };
    } else out[r.id] = resolved.get(r.id);
  }
  return out;
}

/** A look as a rule patch: gear equal to the colour's defaults is stored as « default » (accessories omitted). */
export function lookPatch(index, look) {
  const defaults = defaultAccessoriesFor(index, look.character, look.variant);
  const accessories = look.accessories.length === defaults.length && look.accessories.every((x) => defaults.includes(x)) ? undefined : [...look.accessories];
  return { character: look.character, variant: look.variant, accessories };
}
