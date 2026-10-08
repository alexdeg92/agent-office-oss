// O8: seen-agent presence (contract 3.0). Pure: (OfficeVM, LayoutVM, now, version) → extra occupants for the scene and
// the roster. No DOM; tested in Node (test/office/seen-presence.test.js).
import { resolveOccupants, canonicalRuleId, presenceMinutes } from './layout-rules.js';
import { indexManifest } from './assets.js';
import { s as tr, duration } from './strings.js';

const cache = new WeakMap();
const indexOf = (m) => cache.get(m) ?? (cache.set(m, indexManifest(m)), cache.get(m));

/**
 * O8 (contract 3.0): agents seen recently (LayoutVM.agentsSeen, the canonical inventory of migration 008) but no longer
 * on stage stay at their desk, greyed, for the layout's presence minutes after their last activity; then they leave
 * the list and the scene walks them out. Live occupants keep the server's desks; a seen agent only takes a free one.
 */
export function seenOccupants(vm, lay, now = Date.now(), version = 2) {
  if (version !== 3) return [];
  const minutes = presenceMinutes(lay.layout.data);
  if (!minutes) return [];
  const key = (id) => canonicalRuleId(id) ?? id;
  const onStage = new Set(vm.occupants.map((o) => key(o.id)));
  const seen = (lay.agentsSeen ?? []).filter((s) => !onStage.has(key(s.id)) && Number.isFinite(s.lastSeenAt) && now - s.lastSeenAt < minutes * 60_000)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  if (!seen.length) return [];
  const all = resolveOccupants(lay.layout.data, indexOf(lay.manifest), [...vm.occupants, ...seen].map((o) => ({ id: o.id, role: o.role, sourceName: o.name })));
  const taken = new Set(vm.occupants.map((o) => o.stationUid).filter(Boolean));
  return seen.map((s, i) => {
    const r = all[vm.occupants.length + i];
    const stationUid = r.stationUid && !taken.has(r.stationUid) ? r.stationUid : null;
    if (stationUid) taken.add(stationUid);
    // R27-05: the layout's custom name for this agent (its exact rule) wins over the inventory's, as for a live occupant.
    return { id: s.id, role: s.role, name: r.name || s.name, roleLabel: r.roleLabel, state: 'offline', stateSince: s.lastSeenAt, stationUid, look: r.look, ruleId: r.ruleId,
      destination: null, sessionKey: null, tokens: 0, lastSeenAt: s.lastSeenAt, presence: 'seen',
      presenceLabel: tr('office.seenAgo', { duration: duration(Math.max(0, now - s.lastSeenAt)) }) };
  });
}

