'use strict';

// The gallery is an owner tool, not an RBAC capability. Fail closed when the
// session cannot be tied to the canonical owner account.
function isOwnerSession(session, { store = null, ownerEmail = null } = {}) {
  if (!session || typeof session.email !== 'string') return false;
  const email = session.email.trim().toLowerCase();
  if (!email) return false;
  const owner = store?.users?.owner?.() || null;
  if (owner) {
    if (owner.status !== 'active') return false;
    if (typeof session.userId === 'string') return session.userId === owner.id;
    return typeof owner.email === 'string' && email === owner.email.trim().toLowerCase();
  }
  return typeof ownerEmail === 'string' && email === ownerEmail.trim().toLowerCase();
}

function createOwnerAccess({ auth, store, ownerEmail }) {
  return req => {
    try { return isOwnerSession(auth?.sessionOf?.(req), { store, ownerEmail }); }
    catch { return false; }
  };
}

module.exports = { isOwnerSession, createOwnerAccess };
