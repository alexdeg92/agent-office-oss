'use strict';
// Mutations run in a short-lived child whose cwd pins the verified directory inode.
// The server never changes cwd; the child uses leaf names only after descending safely.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const unsafe = (file, reason = 'file or directory identity changed') => Object.assign(new Error((file ? file + ': ' : '') + reason), { code: 'EUNSAFEPATH' });
let identityFixture = null;
function setIdentityFixture(records) {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('identity fixtures are test-only');
  identityFixture = records;
}
const identity = s => ({ dev: String(s.dev), ino: String(s.ino) });
const same = (a, b) => String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
const stat = (file, fsx) => { try { return fsx.lstatSync(file, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
let journal = null; // Only synchronous mutations; never retained across an await.

// The only implicit aliases are OS configuration roots. Resolve once when this
// module is configured; operations check the original link identity, never follow
// a replacement link. Other links, including workspace descendants, remain refused.
function canonicalizer(roots, fsx = fs) {
  const aliases = roots.flatMap(root => {
    root = path.resolve(root);
    const s = stat(root, fsx);
    if (!s?.isSymbolicLink()) return [];
    const target = fsx.realpathSync(root), parents = [];
    for (let p = target;; p = path.dirname(p)) {
      const st = fsx.lstatSync(p, { bigint: true });
      if (!st.isDirectory() || st.isSymbolicLink()) throw unsafe();
      parents.push({ path: p, ...identity(st) });
      if (p === path.dirname(p)) break;
    }
    return [{ root, target, parents, link: fsx.readlinkSync(root), ...identity(s) }];
  }).sort((a, b) => b.root.length - a.root.length);
  return file => {
    file = path.resolve(file);
    const alias = aliases.find(a => file === a.root || file.startsWith(a.root + path.sep));
    if (!alias) return file;
    const current = stat(alias.root, fsx);
    if (!current?.isSymbolicLink() || !same(current, alias) || fsx.readlinkSync(alias.root) !== alias.link) throw unsafe();
    for (const parent of alias.parents) {
      const s = stat(parent.path, fsx);
      if (!s?.isDirectory() || s.isSymbolicLink() || !same(s, parent)) throw unsafe();
    }
    return path.join(alias.target, path.relative(alias.root, file));
  };
}
const canonicalPath = canonicalizer(['/tmp', '/var']);

function capture(parent, fsx = fs) {
  parent = canonicalPath(parent);
  const paths = []; for (let p = parent;; p = path.dirname(p)) { paths.unshift(p); if (p === path.dirname(p)) break; }
  const chain = [], missing = [];
  for (const p of paths) {
    const s = stat(p, fsx);
    if (!s) { missing.push(path.basename(p)); continue; }
    if (missing.length || !s.isDirectory() || s.isSymbolicLink()) throw unsafe(p, 'parent is not a real directory');
    chain.push({ path: p, ...identity(s), mode: Number(s.mode) & 0o777 });
  }
  return { chain, missing, anchor: chain.at(-1).path };
}

function mutate(file, operation, { fsx = fs } = {}) {
  file = canonicalPath(file);
  const job = { ...capture(path.dirname(file), fsx), file: path.basename(file), operation, identityFixture, testContext: !!process.env.NODE_TEST_CONTEXT };
  if (operation.expectedParents) for (const p of operation.expectedParents) {
    const current = job.chain.find(x => x.path === p.path);
    if (current ? !same(current, p) : !operation.allowMissingParents?.includes(p.path)) throw unsafe();
  }
  const result = spawnSync(process.execPath, [__filename], { cwd: job.anchor,
    input: JSON.stringify(job), encoding: 'utf8', timeout: operation.timeoutMs || 10000, maxBuffer: operation.type === 'read' ? operation.maxBytes * 6 + 4096 : 1024 * 1024,
    // No inherited preload/module injection in this filesystem-only helper.
    env: { PATH: '', NODE_OPTIONS: '', TZ: 'UTC' } });
  if (result.error) throw result.error;
  let reply; try { reply = JSON.parse(result.stdout); } catch { throw unsafe(); }
  if (result.status !== 0 || reply.error) throw Object.assign(new Error(reply.message || (file + ': safe file mutation refused')), { code: reply.error || 'EUNSAFEPATH' });
  if (journal && reply.changed && (journal.files.has(file) || operation.type === 'emptyDir' && [...journal.files].some(f => f.startsWith(file + path.sep)))) journal.receipts.push({ file, ...reply.receipt });
  return reply;
}

// Validate the leaf before handing off, then read only that same inode through a
// descriptor in the pinned worker. A replaced regular file is a conflict too.
function read(file, { roots, rootSnapshots = [], maxBytes, fsx = fs, encoding = 'utf8' }) {
  file = canonicalPath(file);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !roots.some(root => file.startsWith(canonicalPath(root) + path.sep))) throw unsafe();
  const parents = capture(path.dirname(file), fsx).chain;
  for (const root of rootSnapshots.filter(r => file.startsWith(r.root + path.sep))) {
    for (const expected of root.parents) { const actual = parents.find(p => p.path === expected.path); if (!actual || !same(actual, expected)) throw unsafe(); }
  }
  const before = fsx.statSync(file, { bigint: true });
  if (!before.isFile() || before.size > BigInt(maxBytes)) throw unsafe();
  return mutate(file, { type: 'read', expectedParents: parents, identity: identity(before), version: { size: String(before.size), mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) }, maxBytes, encoding }, { fsx });
}

// Preimages are staged privately before the first target changes. Undo only the
// exact inodes this operation published; a concurrent change refuses rollback.
function transaction(files, backupDir, fn) {
  const snapshots = new Map(), originalDirs = new Set();
  for (const file of new Set(files.map(canonicalPath))) {
    const parent = capture(path.dirname(file)); parent.chain.forEach(p => originalDirs.add(p.path));
    const s = stat(file, fs);
    const image = s ? read(file, { roots: [path.dirname(file)], maxBytes: 16 * 1024 * 1024, encoding: 'base64' }) : null;
    snapshots.set(file, { parent: parent.chain, image });
  }
  const backup = path.join(backupDir, 'plan-' + crypto.randomBytes(18).toString('hex') + '.json');
  const staged = mutate(backup, { type: 'write', text: JSON.stringify([...snapshots]), exclusive: true, mode: 0o600 });
  const previous = journal, active = { files: new Set(snapshots.keys()), receipts: [] }; journal = active;
  try {
    const result = fn(); journal = previous;
    mutate(backup, { type: 'remove', identity: staged.receipt.after });
    return result;
  } catch (cause) {
    journal = previous;
    const deleted = new Set(active.receipts.filter(r => r.type === 'emptyDir').map(r => r.file));
    const restored = new Map(), visited = new Set(), created = new Map();
    for (const r of active.receipts) for (const p of r.createdDirs || []) created.set(p.path, p);
    try {
      for (const r of active.receipts.toReversed()) {
        if (!snapshots.has(r.file) || visited.has(r.file)) continue;
        visited.add(r.file);
        const snapshot = snapshots.get(r.file);
        const expectedParents = r.chain.map(p => restored.get(p.path) || p);
        const options = { expectedParents, parentModes: Object.fromEntries(expectedParents.map(p => [p.path, p.mode])), allowMissingParents: [...deleted], expectedIdentity: r.after };
        const inverse = snapshot.image
          ? { type: 'write', text: snapshot.image.text, encoding: 'base64', mode: snapshot.image.mode, ...options }
          : { type: 'remove', identity: r.after, ...options };
        const undone = mutate(r.file, inverse);
        for (const p of undone.receipt?.createdDirs || []) restored.set(p.path, p);
      }
      for (const p of [...created.values()].sort((a, b) => b.path.length - a.path.length)) {
        if (!originalDirs.has(p.path)) mutate(p.path, { type: 'emptyDir', expectedIdentity: p });
      }
    } catch { throw Object.assign(new Error('rollback refused; private preimages retained'), { code: 'EROLLBACK', backup }); }
    throw cause;
  } finally { journal = previous; }
}

// Exported for controlled race tests; production invokes this only in the isolated child.
function execute(job, fsx = fs) {
  // The isolated worker receives the test fixture through its private IPC job;
  // production jobs always carry null and use local identity files.
  identityFixture = job.identityFixture || (job.testContext ? {} : null);
  // Platforms without no-follow opens refuse the operation instead of weakening confinement.
  if (!fs.constants.O_NOFOLLOW) throw unsafe();
  if (!job.file || job.file === '.' || job.file === '..' || path.basename(job.file) !== job.file) throw unsafe();
  const chain = job.chain.slice();
  const revalidate = () => { for (const p of chain) { const s = stat(p.path, fsx); if (!s?.isDirectory() || s.isSymbolicLink() || !same(s, p)) throw unsafe(); } };
  if (!same(fsx.statSync('.', { bigint: true }), chain.at(-1))) throw unsafe();
  revalidate();
  const createdDirs = [];
  for (const name of job.missing) {
    if (!name || name === '.' || name === '..' || path.basename(name) !== name) throw unsafe();
    if (!['write', 'mkdir'].includes(job.operation.type)) return { changed: false };
    fsx.mkdirSync(name, { mode: job.operation.parentModes?.[path.join(chain.at(-1).path, name)] ?? 0o700 });
    const s = fsx.lstatSync(name, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) throw unsafe();
    process.chdir(name);
    if (!same(fsx.statSync('.', { bigint: true }), s)) throw unsafe();
    const entry = { path: path.join(chain.at(-1).path, name), ...identity(s), mode: Number(s.mode) & 0o777 };
    chain.push(entry); createdDirs.push(entry);
    revalidate();
  }
  const before = stat(job.file, fsx), op = job.operation;
  if (op.type === 'remove' && !before) { revalidate(); return { changed: false }; }
  if (Object.hasOwn(op, 'expectedIdentity') && (op.expectedIdentity ? !before || !same(before, op.expectedIdentity) : before)) throw unsafe();
  const changed = after => ({ changed: true, receipt: { type: op.type, after, chain, createdDirs } });
  if (op.trusted) verifyTrusted(chain, fsx);
  if (op.type === 'mkdir') {
    if (before) { if (!before.isDirectory() || before.isSymbolicLink()) throw unsafe(); return { changed: false, identity: identity(before) }; }
    revalidate(); fsx.mkdirSync(job.file, { mode: 0o700 });
    const s = fsx.lstatSync(job.file, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) throw unsafe();
    revalidate(); return changed(identity(s));
  }
  if (op.type === 'emptyDir') {
    if (!before) return { changed: false };
    if (!before.isDirectory() || before.isSymbolicLink()) throw unsafe();
    revalidate();
    if (!same(fsx.lstatSync(job.file, { bigint: true }), before)) throw unsafe();
    try { fsx.rmdirSync(job.file); return changed(null); }
    catch (e) { if (['ENOTEMPTY', 'EEXIST'].includes(e.code)) return { changed: false }; throw e; }
  }
  if (before && (!before.isFile() || before.isSymbolicLink())) throw unsafe();
  if (op.type === 'guard') { revalidate(); return { identity: before ? identity(before) : null, mode: before ? Number(before.mode) & 0o777 : null }; }
  if (['copy', 'sqlite', 'sqlite-copy', 'publish', 'move'].includes(op.type)) {
    return require('./sqlite-artifacts').execute({ job, op, before, chain, revalidate, changed, fsx });
  }
  if (op.type === 'read') {
    if (!before || !same(before, op.identity) || before.size > BigInt(op.maxBytes)) throw unsafe();
    if (op.version && Object.entries(op.version).some(([key, value]) => String(before[key]) !== value)) throw unsafe();
    const fd = fsx.openSync(job.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      const opened = fsx.fstatSync(fd, { bigint: true });
      revalidate();
      if (!opened.isFile() || !same(opened, before) || opened.size > BigInt(op.maxBytes)) throw unsafe();
      if (op.version && Object.entries(op.version).some(([key, value]) => String(opened[key]) !== value)) throw unsafe();
      const bytes = Buffer.alloc(op.maxBytes + 1); let count = 0, n;
      while (count < bytes.length && (n = fsx.readSync(fd, bytes, count, bytes.length - count, count))) count += n;
      const after = fsx.fstatSync(fd, { bigint: true });
      revalidate();
      if (count > op.maxBytes || !same(after, opened) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw unsafe();
      return { text: bytes.subarray(0, count).toString(op.encoding || 'utf8'), identity: identity(opened), mode: Number(opened.mode) & 0o777 };
    } finally { fsx.closeSync(fd); }
  }
  if (op.type === 'remove') {
    if (!before) return { changed: false };
    if (op.identity && !same(before, op.identity)) throw unsafe();
    if (op.contents) {
      const approved = execute({ ...job, operation: { type: 'read', identity: identity(before), maxBytes: 16 * 1024 * 1024 } }, fsx);
      if (!op.contents.includes(approved.text)) return { changed: false };
    }
    revalidate();
    if (!same(fsx.lstatSync(job.file, { bigint: true }), before)) throw unsafe();
    fsx.unlinkSync(job.file);
    return changed(null);
  }
  if (op.type !== 'write') throw unsafe();
  const tmp = '.' + job.file + '.agent-office-tmp-' + crypto.randomBytes(18).toString('hex');
  let fd, created;
  const isCreated = () => { const s = stat(tmp, fsx); return s?.isFile() && !s.isSymbolicLink() && same(s, created); };
  try {
    revalidate();
    fd = fsx.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    created = fsx.fstatSync(fd, { bigint: true });
    revalidate();
    fsx.writeFileSync(fd, op.encoding === 'base64' ? Buffer.from(op.text, 'base64') : op.text);
    fsx.fchmodSync(fd, op.preserveMode && before ? Number(before.mode) & 0o777 : op.mode ?? 0o600);
    fsx.fsyncSync(fd);
    revalidate();
    if (!isCreated()) throw unsafe();
    const current = stat(job.file, fsx);
    if (before ? !current || !same(current, before) : current) throw unsafe();
    // Backups publish exclusively; replacement renames never follow destination links.
    if (op.exclusive) { fsx.linkSync(tmp, job.file); fsx.unlinkSync(tmp); }
    else fsx.renameSync(tmp, job.file);
    return changed(identity(created));
  } finally {
    // Never clean up an attacker's replacement entry or a pre-existing collision.
    try { if (created && isCreated()) fsx.unlinkSync(tmp); }
    finally { if (fd !== undefined) fsx.closeSync(fd); }
  }
}


function verifyTrusted(chain, fsx = fs) {
  const uid = process.getuid?.();
  const groups = require('./private-groups');
  let records;
  const fail = (entry, s, reason, fix = 'g-w') => {
    const mode = s ? '0' + (Number(s.mode) & 0o7777).toString(8).padStart(3, '0') : 'unknown';
    const quoted = "'" + entry.path.replaceAll("'", "'\\''") + "'";
    const command = fix === 'owner' ? `chown ${uid} ${quoted}` : `chmod ${fix} ${quoted}`;
    throw unsafe(entry.path, `${reason} (mode=${mode}, owner=${s?.uid ?? 'unknown'}, group=${s?.gid ?? 'unknown'}); fix: ${command}`);
  };
  for (const [index, entry] of chain.entries()) {
    const s = stat(entry.path, fsx);
    if (!s?.isDirectory() || s.isSymbolicLink() || !same(s, entry)) throw unsafe(entry.path, 'directory identity changed or is a symlink');
    const mode = Number(s.mode), last = index === chain.length - 1;
    if (uid !== undefined && s.uid !== BigInt(uid) && s.uid !== 0n) fail(entry, s, 'directory is owned by another non-root user', 'owner');
    if (last) {
      if (uid !== undefined && s.uid !== BigInt(uid)) fail(entry, s, 'artifact parent must be owned by the operator', 'owner');
      if (mode & 0o022) fail(entry, s, 'artifact parent must be private (no group or world write)', 'go-w');
      continue;
    }
    if (mode & 0o1000) continue; // Sticky OS ancestors protect owner-created children.
    if (mode & 0o002) fail(entry, s, 'world-writable ancestor lacks the sticky bit', 'o-w');
    if (mode & 0o020) {
      records ??= identityFixture || groups.localRecords(fsx);
      const proof = groups.privateGroup(records, s.uid, s.gid);
      if (!proof.allowed) fail(entry, s, proof.reason);
    }
  }
}
function receipt(file, { missing = false, trusted = true } = {}) {
  file = canonicalPath(file);
  const parents = capture(path.dirname(file));
  if (trusted) verifyTrusted(parents.chain);
  const leaf = stat(file, fs);
  if (leaf && (!leaf.isFile() || leaf.isSymbolicLink())) throw unsafe();
  if (!leaf && !missing) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
  return { file, parents: parents.chain, identity: leaf ? identity(leaf) : null };
}
function guarded(target, operation) {
  return mutate(target.file, { ...operation, trusted: true, expectedParents: target.parents, expectedIdentity: target.identity });
}
module.exports = { mutate, read, capture, execute, transaction, canonicalizer, canonicalPath, verifyTrusted, receipt, guarded, setIdentityFixture };

if (require.main === module) {
  (async () => {
    try { process.stdout.write(JSON.stringify(await execute(JSON.parse(fs.readFileSync(0, 'utf8'))))); }
    catch (e) { process.stdout.write(JSON.stringify({ error: e.code || 'EUNSAFEPATH', message: e.message })); process.exitCode = 1; }
  })();
}
