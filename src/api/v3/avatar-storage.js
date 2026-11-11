'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_STORED_BYTES = 1024 * 1024;

function privateRoot(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('avatar storage unavailable');
  const base = fs.realpathSync(dataDir);
  for (const relative of ['user',path.join('user','avatar')]) {
    const dir = path.join(base, relative);
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0 || fs.realpathSync(dir) !== dir) throw new Error('avatar storage unavailable');
  }
  return path.join(base, 'user', 'avatar');
}

function createAvatarStorage({ dataDir }) {
  const root = privateRoot(dataDir);
  const fileFor = blobId => {
    if (typeof blobId !== 'string' || !UUID.test(blobId)) throw new Error('avatar blob unavailable');
    return path.join(root, blobId + '.webp');
  };
  return {
    write(bytes) {
      const id = crypto.randomUUID();
      const finalPath = fileFor(id), tempPath = path.join(root, '.' + crypto.randomBytes(16).toString('hex') + '.tmp');
      const fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } catch (error) {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(tempPath); } catch {}
        throw error;
      }
      fs.closeSync(fd);
      try {
        fs.renameSync(tempPath, finalPath);
        const dirFd = fs.openSync(root, fs.constants.O_RDONLY);
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch (error) { try { fs.unlinkSync(tempPath); } catch {} throw error; }
      return id;
    },
    read(blobId) {
      const fd = fs.openSync(fileFor(blobId), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0));
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size < 12 || stat.size > MAX_STORED_BYTES || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('avatar blob unavailable');
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== stat.size) throw new Error('avatar blob unavailable');
        return bytes;
      } finally { fs.closeSync(fd); }
    },
    remove(blobId) { try { fs.unlinkSync(fileFor(blobId)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
    reconcile(referencedIds) {
      const referenced = new Set(referencedIds.filter(id => typeof id === 'string' && UUID.test(id)));
      const names = fs.readdirSync(root).slice(0, 10000);
      let removed = 0;
      for (const name of names) {
        const match = name.match(/^([0-9a-f-]{36})\.webp$/i);
        if (match && UUID.test(match[1]) && !referenced.has(match[1])) { try { fs.unlinkSync(fileFor(match[1])); removed++; } catch {} }
        // Atomic writes may leave this private, opaque temporary name behind
        // after a crash. The directory is scanned before the API starts, so no
        // live upload can own one of these files during startup reconciliation.
        if (/^\.[0-9a-f]{32}\.tmp$/i.test(name)) { try { fs.unlinkSync(path.join(root, name)); removed++; } catch {} }
      }
      return removed;
    },
  };
}

module.exports = { createAvatarStorage, privateRoot, MAX_STORED_BYTES };
