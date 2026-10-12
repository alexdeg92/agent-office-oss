'use strict';
// The catalog and shared validator are also used by the Store/editor; no private character list.
function setupLayout({ primary, looks, names = {} }) {
  const { officeDefaults } = require('../api/v2/vm/office');
  const off = officeDefaults(), data = structuredClone(off.layout);
  const main = data.agents.find(a => a.agentId === 'main' || a.agentId === 'primary');
  if (looks[primary]) Object.assign(main, looks[primary], { name: names[primary] || null, appearance: 'manual' });
  for (const [id, look] of Object.entries(looks)) {
    if (id === primary) continue;
    data.agents.unshift({ agentId: 'agent:' + id, match: { kind: 'agent' }, ...look, appearance: 'manual', name: names[id] || null, role: 'Agent', station: 'auto' });
  }
  const valid = off.rules.validateLayout(data, off.index);
  if (valid.length) throw new Error('invalid setup layout');
  return off.rules.toVocabulary(data, '3.0');
}
module.exports = { setupLayout };
