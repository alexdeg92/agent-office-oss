'use strict';
// Runtime adapter registry (ADR-001 §3). The core asks for an adapter by id; it never imports adapter
// internals. One adapter per instance in 3.0 (PM decision on ADR-001 Q2); G4 picks it from the instance config.
// G6: `demo` synthesises a small team with no runtime at all (src/adapters/demo; ADR-001 §13)
const ADAPTERS = { openclaw: () => require('./openclaw'), demo: () => require('./demo') };

function adapterById(id) {
  const load = Object.prototype.hasOwnProperty.call(ADAPTERS, id) ? ADAPTERS[id] : null;
  if (!load) throw new Error('unknown runtime adapter: ' + id);
  return load();
}
const defaultAdapter = () => adapterById('openclaw');

module.exports = { adapterById, defaultAdapter, ADAPTER_IDS: Object.keys(ADAPTERS) };
