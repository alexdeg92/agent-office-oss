'use strict';
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { parseMeta, PROFILE } = require('./profile');
const MAX_SESSIONS = 2000, MAX_WORKSPACES = 4000, MAX_ENTRIES = 8192, MAX_META = 64 * 1024, MAX_FILTER_BYTES = 256 * 1024;
const WORKSPACE_RE = /^[a-f0-9]{16,64}$/i, CHAT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = () => Object.assign(new Error('cursor path refused'), { code: 'EUNSAFEPATH' });
const idOf = filename => 'cursor:' + createHash('sha256').update(filename).digest('hex');
const projectIdOf = cwd => 'project:' + createHash('sha256').update(path.resolve(cwd || '/')).digest('hex');

// Cursor stores are WAL-mode. A plain readOnly open still creates -shm/-wal under ~/.cursor.
// file:…?immutable=1 skips the WAL index and locking so Settings probes never write beside the db.
async function openSqliteReadonly(file) {
  const before = await fsp.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw invalid();
  const { DatabaseSync } = require('node:sqlite');
  const url = pathToFileURL(file);
  url.searchParams.set('immutable', '1');
  const db = new DatabaseSync(url, { readOnly: true });
  const after = await fsp.lstat(file);
  if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
    try { db.close(); } catch { /* ignore */ }
    throw invalid();
  }
  return db;
}

async function verifyStore(file, stats) {
  let db;
  try {
    db = await openSqliteReadonly(file);
    // Schema presence only — never COUNT(*) / scan blob payloads (unbounded I/O on large stores).
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    if (!tables.has('blobs') || !tables.has('meta')) { stats.unsupportedStores = (stats.unsupportedStores || 0) + 1; return false; }
    return true;
  } catch (error) {
    if (error?.code === 'EUNSAFEPATH') { stats.unreadableStores = (stats.unreadableStores || 0) + 1; return false; }
    stats.unreadableStores = (stats.unreadableStores || 0) + 1;
    return false;
  } finally {
    try { db?.close?.(); } catch { /* ignore */ }
  }
}

function createFiles({ home, include = [], exclude = [], now = Date.now, agentGrouping = 'project' } = {}) {
  const root = path.resolve(home, 'chats');
  const index = new Map();
  const stats = { entries: 0, files: 0, truncated: false, bytes: 0, malformedMeta: 0, unknownKeys: 0, unsupportedStores: 0, unreadableStores: 0, filterBytes: 0 };
  let closed = false, scanning = null, changeHandler = null;
  const watchers = new Map();

  function ensureWatcher(dir) {
    if (!changeHandler || closed || watchers.has(dir) || watchers.size >= 4096) return;
    try {
      const w = fs.watch(dir, { persistent: false }, (_event, name) => changeHandler?.({ path: name == null ? null : path.resolve(dir, String(name)) }));
      w.on('error', () => { w.close(); watchers.delete(dir); });
      watchers.set(dir, w);
    } catch { /* ignore */ }
  }

  async function scan() {
    if (scanning) return scanning;
    scanning = (async () => {
      stats.truncated = false; stats.entries = 0;
      const rows = [];
      let entries = 0, workspaces = 0, stop = false;
      const countEntry = () => { entries++; if (entries >= MAX_ENTRIES) { stats.truncated = true; stop = true; } return !stop; };
      try {
        ensureWatcher(root);
        const rootDir = await fsp.opendir(root);
        for await (const ws of rootDir) {
          if (closed || stop || !countEntry()) break;
          if (!ws.isDirectory() || ws.isSymbolicLink() || !WORKSPACE_RE.test(ws.name)) continue;
          if (++workspaces > MAX_WORKSPACES) { stats.truncated = true; stop = true; break; }
          const wp = path.join(root, ws.name);
          let wd; try { wd = await fsp.opendir(wp); } catch { continue; }
          ensureWatcher(wp);
          try {
            for await (const chat of wd) {
              if (closed || stop || !countEntry()) break;
              if (!chat.isDirectory() || chat.isSymbolicLink() || !CHAT_RE.test(chat.name)) continue;
              const dir = path.join(wp, chat.name), metaPath = path.join(dir, 'meta.json');
              let st;
              try { st = await fsp.lstat(metaPath); } catch { continue; }
              if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_META || st.size < 2) continue;
              const key = idOf(metaPath);
              rows.push({
                key, sessionId: chat.name, workspaceHash: ws.name, filename: metaPath, storePath: path.join(dir, 'store.db'),
                dev: st.dev, ino: st.ino, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs,
              });
            }
          } finally { await wd.close().catch(() => {}); }
        }
      } finally { scanning = null; }
      rows.sort((a, b) => b.mtime - a.mtime || a.key.localeCompare(b.key));
      if (rows.length > MAX_SESSIONS) { stats.truncated = true; rows.length = MAX_SESSIONS; }
      const next = new Map(rows.map(row => [row.key, { ...index.get(row.key), ...row }]));
      index.clear();
      for (const [k, v] of next) index.set(k, v);
      stats.entries = entries; stats.files = rows.length;
      return [...index.values()];
    })();
    return scanning;
  }

  async function readMeta(keyOrRow) {
    const row = typeof keyOrRow === 'string' ? index.get(keyOrRow) : keyOrRow;
    if (!row || closed) return null;
    const before = await fsp.lstat(row.filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_META) throw invalid();
    const buf = await fsp.readFile(row.filename);
    stats.bytes += buf.length;
    let raw;
    try { raw = JSON.parse(buf.toString('utf8')); } catch { stats.malformedMeta++; return null; }
    const parsed = parseMeta(raw, { sessionId: row.sessionId, workspaceHash: row.workspaceHash, counters: stats });
    if (!parsed) return null;
    const after = await fsp.lstat(row.filename);
    if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) throw invalid();
    const agentId = agentGrouping === 'runtime' ? 'runtime' : projectIdOf(parsed.cwd || row.workspaceHash || row.sessionId);
    const projectName = agentGrouping === 'runtime' ? 'Cursor' : parsed.projectName;
    Object.assign(row, {
      identitySessionRef: parsed.sessionId, projectPath: parsed.cwd, projectId: parsed.cwd ? projectIdOf(parsed.cwd) : null,
      agentId, projectName, displayName: parsed.title, model: null, usage: null,
      activityAt: parsed.updatedAt, execution: { status: 'idle', at: parsed.updatedAt || parsed.createdAt || row.mtime },
      recognized: true, loadedSize: before.size, loadedMtime: before.mtimeMs, loadedCtime: before.ctimeMs,
    });
    return {
      sessionKey: row.key, fetchedAt: typeof now === 'function' ? now() : now, messageCount: 0, window: { from: 0, to: 0 }, events: [],
      agentId, projectName, model: null, sessionId: parsed.sessionId, displayName: parsed.title, activityAt: parsed.updatedAt,
    };
  }

  async function filterRows(rows) {
    if (!include.length && !exclude.length) {
      Object.defineProperty(rows, 'capacityLimited', { value: false });
      return rows;
    }
    let budget = 0, limited = false;
    stats.filterBytes = 0;
    const allowed = new Set();
    const matches = name => name ? !(exclude.includes(name) || (include.length && !include.includes(name))) : !include.length && !exclude.length;
    for (const row of rows) {
      if (closed) break;
      if (row.projectName != null && row.loadedMtime === row.mtime) {
        if (matches(row.projectName)) allowed.add(row.key);
        continue;
      }
      if (budget + row.size > MAX_FILTER_BYTES) { limited = true; break; }
      try {
        const value = await readMeta(row);
        budget += row.size; stats.filterBytes = budget;
        if (value && matches(row.projectName)) allowed.add(row.key);
      } catch (error) {
        if (error.code === 'EUNSAFEPATH') throw error;
        limited = true;
      }
    }
    const out = rows.filter(row => allowed.has(row.key));
    Object.defineProperty(out, 'capacityLimited', { value: limited });
    return out;
  }

  async function refresh(key) {
    const row = index.get(key);
    if (!row || closed) return null;
    let st;
    try { st = await fsp.lstat(row.filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!st.isFile() || st.isSymbolicLink()) return null;
    Object.assign(row, { dev: st.dev, ino: st.ino, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs });
    return row;
  }

  return {
    scan, filterRows, read: readMeta, refresh, verifyStore: (row) => verifyStore(row.storePath, stats),
    keyForPath: file => [...index.values()].find(row => row.filename === path.resolve(file) || row.storePath === path.resolve(file))?.key || null,
    watch(onChange) {
      changeHandler = typeof onChange === 'function' ? onChange : null;
      ensureWatcher(root);
      for (const row of [...index.values()].sort((a, b) => b.mtime - a.mtime)) {
        ensureWatcher(path.dirname(row.filename));
        if (watchers.size >= 4096) break;
      }
    },
    rows: () => [...index.values()].filter(row => row.agentId),
    stats, bounds: { sessions: MAX_SESSIONS, readBytes: MAX_META },
    close() { closed = true; changeHandler = null; for (const w of watchers.values()) w.close(); watchers.clear(); },
    profile: PROFILE,
  };
}

module.exports = { createFiles, openSqliteReadonly, verifyStore, MAX_SESSIONS, MAX_META, MAX_FILTER_BYTES, MAX_WORKSPACES };
