'use strict';

function createAvatarsRepo(db, { now = () => Date.now() } = {}) {
  const get = db.prepare('SELECT user_id,kind,character_id,look_json,blob_id,updated_at FROM user_avatars WHERE user_id=?');
  const putCharacter = db.prepare(`INSERT INTO user_avatars(user_id,kind,character_id,look_json,blob_id,updated_at)
    VALUES(?,'character',?,?,NULL,?) ON CONFLICT(user_id) DO UPDATE SET kind='character',character_id=excluded.character_id,look_json=excluded.look_json,blob_id=NULL,updated_at=excluded.updated_at`);
  const putPhoto = db.prepare(`INSERT INTO user_avatars(user_id,kind,character_id,look_json,blob_id,updated_at)
    VALUES(?,'photo',NULL,NULL,?,?) ON CONFLICT(user_id) DO UPDATE SET kind='photo',character_id=NULL,look_json=NULL,blob_id=excluded.blob_id,updated_at=excluded.updated_at`);
  const del = db.prepare('DELETE FROM user_avatars WHERE user_id=?');
  const allBlobIds = db.prepare("SELECT blob_id FROM user_avatars WHERE kind='photo' AND blob_id IS NOT NULL");
  const fromRow = row => row ? { userId: row.user_id, kind: row.kind, characterId: row.character_id,
    look: row.look_json ? JSON.parse(row.look_json) : null, blobId: row.blob_id, updatedAt: row.updated_at } : null;
  return {
    get(userId) { return fromRow(get.get(userId)); },
    setCharacter(userId, characterId, look) {
      const previousBlobId = this.get(userId)?.blobId || null;
      putCharacter.run(userId, characterId, JSON.stringify(look), now());
      return { avatar: this.get(userId), previousBlobId };
    },
    setPhoto(userId, blobId) {
      const previous = this.get(userId)?.blobId || null;
      putPhoto.run(userId, blobId, now());
      return { avatar: this.get(userId), previousBlobId: previous };
    },
    remove(userId) { const previous = this.get(userId)?.blobId || null; del.run(userId); return previous; },
    blobIds() { return allBlobIds.all().map(row => row.blob_id); },
  };
}

module.exports = { createAvatarsRepo };
