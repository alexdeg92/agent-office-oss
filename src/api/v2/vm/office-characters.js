'use strict';

const { project2x: P2 } = require('../project2x');

const countLabel = n => ({ key: n === 1 ? 'office.characters.count.one' : 'office.characters.count.other', params: { n } });

/** Character-editor rows are a server projection of the same office roster and saved appearance rules. */
function buildOfficeCharactersVM({ office, layout, rules, index, seen = [], runtimeInfo = () => null, projection = P2, scope = 'office', search = '' }) {
  if (!office || !Array.isArray(office.occupants)) throw new TypeError('office occupants required');
  const activeIds = new Set(office.occupants.map(row => rules.canonicalRuleId(row.id) || row.id));
  const rows = office.occupants.map((row, order) => {
    const info = runtimeInfo(row) || {};
    return {
      id: row.id, role: row.role, name: row.name, runtime: row.runtime || info.name || null, runtimeBrand: info.brand || null,
      state: row.state, stateLabel: row.stateLabel, roleLabel: row.roleLabel, primary: row.role === 'primary' || row.role === 'main',
      look: row.look, ...(row.automaticLook ? { automaticLook: row.automaticLook } : {}), groupId: row.groupId || null, order, inOffice: true, lastSeenAt: row.lastSeenAt ?? null,
    };
  });

  if (scope === 'all') {
    const detected = seen.filter(row => !activeIds.has(rules.canonicalRuleId(row.id) || row.id));
    const wireLayout = rules.toVocabulary(layout, '2.x');
    const projected = rules.resolveOccupants(wireLayout, index, detected.map(row => ({
      id: P2.occupantId(row.id), role: P2.occupantRole(row.role), sourceName: row.name,
      automaticLook: row.automaticLook,
    })));
    detected.forEach((row, i) => {
      const info = runtimeInfo(row) || {};
      rows.push({
        id: projection.occupantId(row.id), role: projection.occupantRole(row.role), name: row.name, runtime: info.name || null, runtimeBrand: info.brand || null,
        state: null, stateLabel: { key: 'office.characters.detected' }, roleLabel: { key: `occupantRole.${projection.occupantRole(row.role)}` },
        primary: projection.occupantRole(row.role) === 'primary' || projection.occupantRole(row.role) === 'main',
        look: projected[i].look, ...(projected[i].automaticLook ? { automaticLook: projected[i].automaticLook } : {}), groupId: null, order: rows.length, inOffice: false, lastSeenAt: row.lastSeenAt ?? null,
      });
    });
  }

  const query = String(search || '').trim().toLocaleLowerCase('en');
  const matches = row => !query || `${row.name} ${row.runtime || ''}`.toLocaleLowerCase('en').includes(query);
  const byId = new Map(rows.map(row => [row.id, row]));
  const used = new Set();
  const groups = [];
  for (const group of office.rosterGroups || []) {
    if ((group.occupantIds || []).length < 2) continue;
    const members = (group.occupantIds || []).map(id => byId.get(id)).filter(Boolean).filter(matches);
    if (!members.length) continue;
    for (const row of members) used.add(row.id);
    groups.push({ id: group.id, label: group.label, count: members.length, countLabel: countLabel(members.length), rows: members });
  }
  const independent = rows.filter(row => !used.has(row.id) && row.inOffice && matches(row));
  if (independent.length) groups.push({ id: null, label: { key: 'office.characters.independent' }, count: independent.length,
    countLabel: countLabel(independent.length), rows: independent });
  const detected = rows.filter(row => !row.inOffice && matches(row));
  if (detected.length) groups.push({ id: 'detected', label: { key: 'office.characters.detectedGroup' }, count: detected.length,
    countLabel: countLabel(detected.length), rows: detected });
  const count = groups.reduce((total, group) => total + group.count, 0);
  return { scope, search: String(search || ''), count, countLabel: countLabel(count), groups,
    emptyLabel: { key: scope === 'all' ? 'office.characters.emptyAll' : 'office.characters.emptyOffice' } };
}

module.exports = { buildOfficeCharactersVM };
