'use strict';
const { mintId } = require('../ids');
const { isHash } = require('../../security/password');
function createUsersRepo(db, { now = Date.now } = {}) {
  const owner = db.prepare("SELECT * FROM users WHERE role = 'owner'");
  const byEmail = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE');
  return {
    owner: () => owner.get() || null,
    credential: (email) => byEmail.get(String(email).trim().toLowerCase()) || null,
    amendOwner({ email, passwordHash, personId }) {
      if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('invalid owner credential');
      const current = owner.get();
      if (!current) return this.createOwner({ email, passwordHash, personId });
      if (passwordHash != null && !isHash(passwordHash)) throw new Error('invalid owner credential');
      db.prepare('UPDATE users SET email = ?, password_hash = ?, updated_at = ? WHERE id = ?').run(email.trim().toLowerCase(), passwordHash || current.password_hash, now(), current.id);
      return owner.get();
    },
    createOwner({ email, passwordHash, personId }) {
      if (!isHash(passwordHash) || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('invalid owner credential');
      if (owner.get()) throw Object.assign(new Error('owner already exists'), { code: 'EOWNER' });
      const t = now();
      db.prepare('INSERT INTO users (id, person_id, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(mintId('usr'), personId, email.trim().toLowerCase(), passwordHash, 'owner', t, t);
      return owner.get();
    },
  };
}
module.exports = { createUsersRepo };
