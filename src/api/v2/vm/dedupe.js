'use strict';

// Use after projecting rows into the caller's ID vocabulary: several canonical
// identities can intentionally share one older wire ID (e.g. group/conversation
// both become channel in v2).
function dedupeRows(rows, { keyOf = row => row.id, tieBreak = () => 0 } = {}) {
  const selected = new Map();
  const looks = new Map();
  const time = row => Number.isFinite(Number(row.lastSeenAt)) ? Number(row.lastSeenAt) : -Infinity;
  for (const input of rows || []) {
    const row = { ...input };
    const key = keyOf(row);
    const previous = selected.get(key);
    const stamp = time(row);
    const look = row.automaticLook && typeof row.automaticLook === 'object' ? row.automaticLook : null;
    const priorLook = looks.get(key);
    const activeLook = row.inOffice === true;
    const preferLook = !priorLook
      || (activeLook !== priorLook.active ? activeLook : stamp > priorLook.at);
    if (look && preferLook) looks.set(key, { at: stamp, value: look, active: activeLook });
    const preferActive = previous && row.inOffice !== previous.inOffice
      ? row.inOffice === true
      : !previous || stamp > time(previous) || (stamp === time(previous) && tieBreak(row) > tieBreak(previous));
    if (preferActive) {
      selected.set(key, row);
    }
  }
  for (const [key, row] of selected) {
    const look = looks.get(key);
    if (look) row.automaticLook = look.value;
  }
  return [...selected.values()];
}

module.exports = { dedupeRows };
