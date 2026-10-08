'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { LIMITS } = require('./code');
const FILE = /^[a-f0-9]{64}\.(svg|webp)$/;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
function createCoverStore({ dataDir, writable = true, urlFor = (p) => p }) {
  const dir = path.resolve(dataDir, 'project-covers'), media = path.join(dir, 'media'), records = path.join(dir, 'records');
  if (writable) { fs.mkdirSync(media, { recursive: true, mode: 0o700 }); fs.mkdirSync(records, { recursive: true, mode: 0o700 }); }
  const recordPath = (id) => { if (!ID.test(id)) throw new Error('invalid-project-id'); return path.join(records, id + '.json'); };
  const hashFile = (bytes, ext, budget) => {
    if (!Buffer.isBuffer(bytes) || bytes.length > budget || !['svg', 'webp'].includes(ext)) throw new Error('cover-budget');
    const name = crypto.createHash('sha256').update(bytes).digest('hex') + '.' + ext;
    try { fs.writeFileSync(path.join(media, name), bytes, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    return name;
  };
  return {
    dir,
    get(id) {
      try {
        const filename = recordPath(id);
        if (fs.statSync(filename).size > 2048) return null;
        const r = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (!FILE.test(r.file) || !FILE.test(r.thumbFile) || !['agent', 'code', 'upload'].includes(r.source) || !Number.isSafeInteger(r.generatedAt) || !/^[a-f0-9]{64}$/.test(r.fingerprint)) return null;
        if (!fs.existsSync(path.join(media, r.file)) || !fs.existsSync(path.join(media, r.thumbFile))) return null;
        return r;
      } catch (_) { return null; }
    },
    save(id, result, metadata) {
      if (!writable) throw new Error('readonly');
      const r = { file: hashFile(result.cover, result.ext, LIMITS.cover), thumbFile: hashFile(result.thumb, result.ext, LIMITS.thumb), ...metadata };
      const target = recordPath(id), tmp = target + '.' + crypto.randomBytes(6).toString('hex');
      try { fs.writeFileSync(tmp, JSON.stringify(r), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, target); }
      finally { fs.rmSync(tmp, { force: true }); }
      return r;
    },
    vm(id) {
      const r = this.get(id);
      if (!r) return null;
      const url = urlFor('/api/v2/project-covers/' + r.file), thumbUrl = urlFor('/api/v2/project-covers/' + r.thumbFile);
      return url && thumbUrl ? { url, thumbUrl, source: r.source, generatedAt: r.generatedAt } : null;
    },
    read(name) {
      if (!FILE.test(name)) return null;
      let fd;
      try {
        fd = fs.openSync(path.join(media, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > LIMITS.cover) return null;
        const bytes = fs.readFileSync(fd);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== name.split('.')[0]) return null;
        return { bytes, type: name.endsWith('.svg') ? 'image/svg+xml' : 'image/webp', etag: '"' + name.split('.')[0] + '"' };
      } catch (_) { return null; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    },
  };
}
function serveCover(store) {
  return (req, res, next) => {
    const file = store.read(req.params.file);
    if (!file) return next(new (require('../../api/v2/errors').ApiError)('not_found'));
    res.set({ 'Cache-Control': 'private, max-age=31536000, immutable', ETag: file.etag, 'Content-Type': file.type,
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", Vary: 'Cookie' });
    const matches = String(req.headers['if-none-match'] || '').split(',').map((s) => s.trim().replace(/^W\//, ''));
    if (matches.includes(file.etag) || matches.includes('*')) return res.status(304).end();
    res.send(file.bytes);
  };
}
module.exports = { createCoverStore, serveCover };
