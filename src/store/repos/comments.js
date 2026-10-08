'use strict';
// architect-57 · project comments (migration 012). Plain SQL rows; the API layer (src/api/v2/comments.js) owns the rules.
// Order is insertion order (rowid → `seq`): a frozen or skewed clock never reorders a thread.
const crypto = require('crypto');

const rowOf = (r) => r && {
  id: r.id, seq: r.seq, projectId: r.project_id, kind: r.kind, author: { kind: r.author_kind, id: r.author_id, name: r.author_name }, body: r.deleted_at ? '' : r.body,
  mentions: JSON.parse(r.mentions_json || '[]'), replyTo: r.reply_to || null, delivery: r.delivery_json ? JSON.parse(r.delivery_json) : [],
  createdAt: r.created_at, editedAt: r.edited_at || null, deleted: r.deleted_at != null,
};

function createCommentsRepo(db, { now = () => Date.now() } = {}) {
  const q = {
    page: db.prepare('SELECT rowid AS seq, * FROM project_comments WHERE project_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?'),
    active: db.prepare("SELECT rowid AS seq, * FROM project_comments WHERE delivery_json IS NOT NULL ORDER BY rowid"),
    get: db.prepare('SELECT rowid AS seq, * FROM project_comments WHERE id = ?'),
    count: db.prepare('SELECT count(*) AS n FROM project_comments WHERE project_id = ? AND deleted_at IS NULL'),
    insert: db.prepare('INSERT INTO project_comments (id, project_id, kind, author_kind, author_id, author_name, body, mentions_json, reply_to, delivery_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    edit: db.prepare('UPDATE project_comments SET body = ?, mentions_json = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL'),
    del: db.prepare('UPDATE project_comments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'),
    delivery: db.prepare('UPDATE project_comments SET delivery_json = ? WHERE id = ?'),
  };
  return {
    /** newest first, before the sequence number `before` (exclusive) */
    page(projectId, { before = null, limit = 50 } = {}) {
      return q.page.all(projectId, before == null ? Number.MAX_SAFE_INTEGER : before, Math.min(200, Math.max(1, limit))).map(rowOf);
    },
    active() { return q.active.all().map(rowOf).filter((c) => c.delivery.some((d) => d.status === 'pending' || d.status === 'working' || d.follow?.phase === 'tracking')); },
    get: (id) => rowOf(q.get.get(id)),
    count: (projectId) => q.count.get(projectId).n,
    create({ projectId, kind = 'comment', author, body, mentions = [], replyTo = null, delivery = [], at = now() }) {
      const id = 'cmt_' + crypto.randomBytes(8).toString('hex');
      q.insert.run(id, projectId, kind, author.kind, author.id || null, String(author.name).slice(0, 120), body, JSON.stringify(mentions), replyTo, delivery.length ? JSON.stringify(delivery) : null, at);
      return rowOf(q.get.get(id));
    },
    edit(id, body, mentions, at = now()) { q.edit.run(body, JSON.stringify(mentions), at, id); return rowOf(q.get.get(id)); },
    remove(id, at = now()) { q.del.run(at, id); return rowOf(q.get.get(id)); },
    setDelivery(id, delivery) { q.delivery.run(JSON.stringify(delivery), id); return rowOf(q.get.get(id)); },
  };
}

module.exports = { createCommentsRepo };
