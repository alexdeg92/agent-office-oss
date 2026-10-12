'use strict';

// ADR-004 §5.2. This small registry contribution is deliberately independent
// of the not-yet-installed multi-user policy store. Unknown keys always deny.
const RESOURCES = Object.freeze([
  Object.freeze({ key: 'orchestrators', parent: null, levels: Object.freeze(['read']), privileged: true }),
  Object.freeze({ key: 'teams', parent: null, levels: Object.freeze(['read']), privileged: true }),
  Object.freeze({ key: 'teams.report.resolve', parent: 'teams', levels: Object.freeze(['read']), privileged: true }),
]);

const byKey = new Map(RESOURCES.map((r) => [r.key, r]));

function descriptor(key) { return byKey.get(key) || null; }

function allows(role, key, level = 'read') {
  if (!descriptor(key) || !['read'].includes(level)) return false;
  // ADR-002's immutable admin rule applies to resources added after its core
  // matrix. Every non-admin role starts at none; parent grants do not imply a
  // child grant.
  return role === 'admin';
}

function allowsPrincipal(principal, key, level = 'read') {
  if (!principal || !descriptor(key) || level !== 'read') return false;
  if (principal.role === 'admin') return true;
  const entry = descriptor(key);
  const granted = principal.effectivePermissions?.[key] ?? principal.permissions?.[key] ?? 'none';
  if (granted !== 'read' && granted !== 'write') return false;
  return !entry.parent || allowsPrincipal(principal, entry.parent, 'read');
}

function assertCanRead(principal, key) {
  if (!allowsPrincipal(principal, key, 'read')) {
    const err = new Error('permission-denied');
    err.code = 'permission-denied';
    throw err;
  }
  return true;
}

module.exports = { RESOURCES, descriptor, allows, allowsPrincipal, assertCanRead };
