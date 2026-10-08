'use strict';
// withTx(db, fn) → BEGIN IMMEDIATE … COMMIT / ROLLBACK (storage.md §5). Implemented in db.js.
module.exports = { withTx: require('./db').withTx };
