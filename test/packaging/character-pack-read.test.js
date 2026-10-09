'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readPackFile, readPackManifest } = require('../../packaging/character-pack-read');
const { buildCharacterRegistry } = require('../../packaging/character-pack-registry');
const { validateCharacterPack, contract, main } = require('../../packaging/validate-character-pack');

function fixture(t, bytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-read-limit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'manifest.json');
  fs.writeFileSync(file, bytes);
  return { root, file };
}

test('registry and standalone CLI reject known oversized metadata without read or parse', t => {
  const { root, file } = fixture(t, ' '.repeat(contract.budgets.manifestBytes + 1));
  const parent = path.dirname(root), id = path.basename(root);
  let reads = 0, parses = 0;
  t.mock.method(fs, 'readSync', () => { reads++; assert.fail('oversized file must not be read'); });
  t.mock.method(JSON, 'parse', () => { parses++; assert.fail('oversized file must not be parsed'); });
  t.mock.method(console, 'error', () => {});
  assert.match(buildCharacterRegistry(parent, [id]).pending[0].errors.join('; '), /metadata budget/);
  assert.equal(main([file]), 1);
  assert.equal(reads, 0); assert.equal(parses, 0);
});

test('descriptor-bound reads stop at budget plus one probe when a file grows after inspection', t => {
  const { file } = fixture(t, '{}');
  const fstat = fs.fstatSync, read = fs.readSync;
  let inspectedFd, readBytes = 0, calls = 0;
  t.mock.method(fs, 'fstatSync', fd => {
    inspectedFd = fd;
    const stat = fstat(fd);
    fs.appendFileSync(file, ' '.repeat(contract.budgets.manifestBytes * 2));
    return stat;
  });
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    assert.equal(fd, inspectedFd);
    calls++;
    const count = read(fd, buffer, offset, Math.min(length, 8192), position);
    readBytes += count;
    return count;
  });
  assert.throws(() => readPackManifest(file), /metadata budget/);
  assert.equal(readBytes, contract.budgets.manifestBytes + 1);
  assert.ok(calls > 1);
  assert.throws(() => fstat(inspectedFd), { code: 'EBADF' });
});

test('bounded manifest reader accepts exact limits and distinguishes malformed JSON', t => {
  const { file } = fixture(t, '{"names":"é"}');
  const size = fs.statSync(file).size;
  fs.appendFileSync(file, ' '.repeat(contract.budgets.manifestBytes - size));
  assert.deepEqual(readPackManifest(file), { pack: { names: 'é' }, metadataBytes: contract.budgets.manifestBytes });
  fs.writeFileSync(file, '{');
  assert.throws(() => readPackManifest(file), /invalid manifest JSON/);
  fs.mkdirSync(file + '.dir');
  assert.throws(() => readPackFile(file + '.dir', 100, 'over budget'), /not a file/);
});

test('oversized thumbnail and raster records fail before reading their bytes', t => {
  const { root } = fixture(t, '{}');
  const image = path.join(root, 'big.webp');
  fs.writeFileSync(image, Buffer.alloc(contract.budgets.frameBytes + 1));
  let reads = 0;
  t.mock.method(fs, 'readSync', () => { reads++; assert.fail('oversized raster must not be read'); });
  const pack = { variants: [{ id: 'test', thumbnail: 'big.webp', frames: [{ id: 'idle', image: 'big.webp' }] }] };
  const result = validateCharacterPack(pack, root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /thumbnail: exceeds 8192 bytes/);
  assert.match(result.errors.join('; '), /idle: exceeds 16384 bytes/);
  assert.equal(reads, 0);
});

test('oversized parsed metadata fails before variant traversal or raster reads', t => {
  const { root } = fixture(t, '{}');
  let traversals = 0;
  const variants = new Array(1);
  Object.defineProperty(variants, 0, { get() { traversals++; return null; } });
  const pack = { padding: ' '.repeat(contract.budgets.manifestBytes), variants };
  // One visit during size measurement; no subsequent shape/asset traversal.
  const { checkPackShape } = require('../../public/v2/office/character-pack-shape');
  assert.deepEqual(checkPackShape(pack, {metadataBytes:contract.budgets.manifestBytes+1}).errors, ['manifest exceeds metadata budget']);
  assert.equal(traversals, 0);
  assert.deepEqual(validateCharacterPack(pack, root).errors, ['manifest exceeds metadata budget']);
  assert.equal(traversals, 1);
});
