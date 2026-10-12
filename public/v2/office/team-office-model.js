/** A display link exists only for the canonical exact hostAgentId reference; names are never compared. */
export function linkedPresence(member, hostRows = []) {
  if (!member?.hostAgentId) return null;
  return dedupeHostRows(hostRows).find(row => row.id === member.hostAgentId) || null;
}

/** Host observations have stable IDs; duplicate refresh rows must not create duplicate people. */
export function dedupeHostRows(rows = []) {
  const byId = new Map();
  for (const row of rows) if (row?.id && !byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()];
}

/** Exact-linked Herdr panes annotate a runtime occupant; only unlinked rows are separate presences. */
export function unlinkedHostRows(rows = []) {
  return dedupeHostRows(rows).filter(row => !row.linkedOccupantId);
}

const isUnresolvedName = (name) => !name || /^(?:agent|unknown|unnamed|observation sans nom|unnamed observation)(?:\s+\d+)?$/i.test(name.trim());

/** Unnamed observations are summarized by status instead of repeating a generic name. */
export function anonymousPresenceGroups(rows = []) {
  const counts = new Map();
  for (const row of dedupeHostRows(rows)) if (isUnresolvedName(row.name)) counts.set(row.status, (counts.get(row.status) || 0) + 1);
  return [...counts].map(([status, count]) => ({ status, count }));
}

export function isResolvedPresenceName(name) { return !isUnresolvedName(name); }

/** Present stable team-parent relationships as a hierarchy without guessing from names. */
export function groupedTeamMembers(members = []) {
  const byId = new Map();
  for (const row of members) if (row?.id && !byId.has(row.id)) byId.set(row.id, row);
  const unique = [...byId.values()];
  const parentOf = new Map();
  for (const member of unique) {
    const candidate = member.parentMemberId;
    if (!candidate || candidate === member.id || !byId.has(candidate)) continue;
    let cursor = candidate;
    const seen = new Set([member.id]);
    let cyclic = false;
    while (cursor && byId.has(cursor)) {
      if (seen.has(cursor)) { cyclic = true; break; }
      seen.add(cursor);
      cursor = byId.get(cursor).parentMemberId;
    }
    if (!cyclic) parentOf.set(member.id, candidate);
  }
  const children = new Map();
  for (const member of unique) {
    const parentId = parentOf.get(member.id);
    if (!parentId) continue;
    const rows = children.get(parentId) || [];
    rows.push(member); children.set(parentId, rows);
  }
  const ordered = [];
  const visit = (member, depth) => {
    ordered.push({ member, depth, parent: depth ? byId.get(parentOf.get(member.id)) : null });
    for (const child of children.get(member.id) || []) visit(child, depth + 1);
  };
  for (const member of unique) if (!parentOf.has(member.id)) visit(member, 0);
  // Defensive fallback for malformed cycles: retain every stable member once as an ungrouped row.
  const emitted = new Set(ordered.map(row => row.member.id));
  for (const member of unique) if (!emitted.has(member.id)) ordered.push({ member, depth: 0, parent: null });
  return ordered;
}
