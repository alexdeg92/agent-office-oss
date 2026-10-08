// Agents and their looks in a layout draft (shared by the Bureau editor and the Boutique, office-dev-21). Pure: no
// DOM, no strings except the caller's labels; tested through test/office/catalog.test.js and the editor suites.
import { updateAgent, effectiveAccessories, resolveOccupants, ruleKind } from './editor-model.js';
import { defaultAccessoriesFor, canonicalRuleId, canonicalRole, roleOfRule } from './layout-rules.js';

const DAY_MS = 86_400_000;

/**
 * The agents a look can be set for: live occupants, agents seen in the last 30 days, agents with their own rule, then
 * the default rules. Rows are keyed canonically (api-v3 D3/D4: an occupant 'primary' and a rule 'main' are one agent)
 * and take the id of the agent's existing rule, so edits update that rule in the vocabulary it is stored in.
 * @param {object} draft  layout data
 * @param {object[]} live occupants ({ id, role, name|sourceName })
 * @param {object[]} seen inventory ({ id, role, name, lastSeenAt })
 * @param {(id: string) => string} defaultLabel  label of a default rule (« Nouveaux sous-agents »…)
 */
export function agentRows(draft, live, seen, defaultLabel, now = Date.now()) {
  const rows = new Map();
  const ruleId = (id) => draft.agents.find((a) => canonicalRuleId(a.agentId) === canonicalRuleId(id))?.agentId ?? id;
  const add = (id, row) => { const k = canonicalRuleId(id) ?? id; if (!rows.has(k)) rows.set(k, { ...row, id: ruleId(id), role: canonicalRole(row.role) ?? row.role }); };
  for (const o of live) add(o.id, { role: o.role, sourceName: o.sourceName ?? o.name, live: true });
  for (const s of seen ?? []) if (now - s.lastSeenAt < 30 * DAY_MS) add(s.id, { role: s.role, sourceName: s.name, live: false });
  for (const a of draft.agents) if (ruleKind(a.agentId) !== 'default') add(a.agentId, { role: roleOfRule(a), sourceName: a.name ?? a.agentId, live: false });
  const people = [...rows.values()].sort((a, b) => (a.role === 'primary' ? -1 : b.role === 'primary' ? 1 : 0));
  const defaults = draft.agents.filter((a) => ruleKind(a.agentId) === 'default').map((a) => ({ id: a.agentId, role: roleOfRule(a), sourceName: defaultLabel(a.agentId), isDefault: true }));
  return [...people, ...defaults];
}

/** The rule a look edit writes to: the agent's exact rule, or one created on first change from the resolved look. */
export function ruleView(draft, index, row) {
  const exact = draft.agents.find((a) => canonicalRuleId(a.agentId) === canonicalRuleId(row.id));
  if (exact) return { rule: exact, own: true };
  const [r] = resolveOccupants(draft, index, [{ id: row.id, role: row.role, sourceName: row.sourceName }]);
  return { rule: { agentId: row.id, match: { kind: row.role }, character: r.look.character, variant: r.look.variant, name: null, role: null, station: 'auto' }, own: false, resolved: r };
}

/** The draft with `patch` applied to the row's rule (created from the resolved look on first change). */
export function patchAgent(draft, index, row, patch) {
  const { rule, own } = ruleView(draft, index, row);
  let next = draft;
  if (!own) next = updateAgent(next, row.id, { ...rule, accessories: undefined });
  next = updateAgent(next, row.id, { ...patch });
  const a = next.agents.find((x) => x.agentId === row.id);
  for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
  return next;
}

/**
 * Every row's effective look in the draft ({ character, variant, accessories }). Agents without an own rule are
 * resolved together, in roster order, so a default rule's colour rotation holds (O6).
 */
export function looksOf(draft, index, rows) {
  const people = rows.filter((r) => !r.isDefault);
  const resolved = new Map(resolveOccupants(draft, index, people.map((r) => ({ id: r.id, role: r.role, sourceName: r.sourceName }))).map((o, i) => [people[i].id, o.look]));
  const out = {};
  for (const r of rows) {
    const { rule, own } = ruleView(draft, index, r);
    if (r.isDefault || own) {
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
