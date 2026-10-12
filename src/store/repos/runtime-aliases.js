'use strict';
// Monotonic safety history, excluded from retention/namespace rewrites. Values
// are SHA-256 fingerprints only; overflow is permanent and refuses v2 aliases.
const { withTx } = require('../db');
const LIMIT = 4096;
function createRuntimeAliasesRepo(db, { onInvalid = () => {} } = {}) {
  const get = db.prepare('SELECT hashes, overflow FROM runtime_alias_policy WHERE id = 1');
  const put = db.prepare('INSERT INTO runtime_alias_policy (id, hashes, overflow) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET hashes = excluded.hashes, overflow = excluded.overflow');
  function load() {
    const value = get.get();
    if (value == null) return { seen: new Set(), overflow: false };
    try {
      const hashes = JSON.parse(value.hashes);
      if (![0, 1].includes(value.overflow) || !Array.isArray(hashes) || hashes.length > LIMIT
        || !hashes.every(h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h)) || new Set(hashes).size !== hashes.length) throw Error();
      return { seen: new Set(hashes), overflow: value.overflow === 1 };
    } catch { onInvalid('runtime_aliases'); return { seen: new Set(), overflow: true }; }
  }
  function remember(hashes, overflow = false) {
    return withTx(db, () => {
      const row = load(); row.overflow ||= overflow;
      for (const hash of hashes) {
        if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw Object.assign(new Error('invalid alias fingerprint'), { code: 'EIDENTITY' });
        if (row.seen.has(hash)) continue;
        if (row.seen.size >= LIMIT) { row.overflow = true; break; }
        row.seen.add(hash);
      }
      put.run(JSON.stringify([...row.seen].sort()), row.overflow ? 1 : 0);
      return row;
    });
  }
  return { load, remember };
}
module.exports = { createRuntimeAliasesRepo, LIMIT };
