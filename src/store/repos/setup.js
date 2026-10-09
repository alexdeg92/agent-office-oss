'use strict';
// The DB draft is one owner/person/layout transaction. The filesystem remains
// the publication marker; its digest reconciles a crash before status finalizes.
const crypto = require('crypto');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function createSetupRepo(db, { persons, users, office, tx }) {
  const get = db.prepare('SELECT value FROM store_meta WHERE key = ?');
  const put = db.prepare('INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const status = () => get.get('setup_status')?.value || null;
  return {
    status,
    amendOwner({ displayName, email, passwordHash, layout }) {
      return tx(() => {
        if (status() === 'configured') throw Object.assign(new Error('setup is configured'), { code: 'ESETUPLOCKED' });
        const person = persons.ensureOwner(displayName, { rename: true });
        const account = users.amendOwner({ email, passwordHash, personId: person.id });
        if (!office.active()) office.active(() => layout);
        put.run('setup_status', 'open'); put.run('setup_config_hash', '');
        return account;
      });
    },
    prepare(config, layout) {
      tx(() => {
        if (layout) {
          const current = office.active();
          if (!current) office.active(() => layout);
          else if (!office.save({ expectedRevision: current.revision, data: layout, actor: { kind: 'system', component: 'engine' } }).ok) throw Object.assign(new Error('layout changed'), { code: 'ECONFLICT' });
        }
        put.run('setup_status', 'open'); put.run('setup_config_hash', digest(config));
      });
    },
    configured: () => tx(() => put.run('setup_status', 'configured')),
    reconcile(config) {
      return tx(() => {
        if (!users.owner()) { put.run('setup_status', 'open'); put.run('setup_config_hash', ''); return false; }
        if (status() === 'open' && get.get('setup_config_hash')?.value !== digest(config)) return false;
        put.run('setup_status', 'configured'); return true;
      });
    },
  };
}
module.exports = { createSetupRepo };
