'use strict';

const { withTx } = require('../db');

function createProjectKickoffsRepository(db) {
  const parse = row => row && ({ projectId: row.project_id, principalScope: row.principal_scope, idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash, targetId: row.target_id, sessionId: row.session_id, turnId: row.turn_id,
    connectorId: row.connector_id, createdAt: row.created_at });
  return {
    byKey(scope, key) {
      return parse(db.prepare('SELECT * FROM project_kickoffs WHERE principal_scope=? AND idempotency_key=?').get(scope, key));
    },
    byProject(scope, projectId) {
      return parse(db.prepare('SELECT * FROM project_kickoffs WHERE principal_scope=? AND project_id=?').get(scope, projectId));
    },
    create(row) {
      withTx(db, () => db.prepare(`INSERT INTO project_kickoffs(project_id,principal_scope,idempotency_key,request_hash,target_id,session_id,turn_id,connector_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(row.projectId, row.principalScope, row.idempotencyKey, row.requestHash, row.targetId, row.sessionId, row.turnId, row.connectorId || null, row.createdAt));
      return this.byProject(row.principalScope, row.projectId);
    },
  };
}

module.exports = { createProjectKickoffsRepository };
