'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateCharacterPack, contract } = require('../../packaging/validate-character-pack');
// Real lossless transparent WebPs, synthetic geometry only; never production character art.
const body = Buffer.from('UklGRiIAAABXRUJQVlA4TBYAAAAvv8BHEAcQEREQkCT+/09F9D/tf/8C', 'base64');
const thumb = Buffer.from('UklGRiAAAABXRUJQVlA4TBQAAAAvX8AjEAcQEREGICH8/69E9D/1BQ==', 'base64');

function fixture(t, type = 'walks') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'character-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'body.webp'), body);
  fs.writeFileSync(path.join(root, 'thumb.webp'), thumb);
  const pack = {
    schemaVersion: 1, contract: contract.id, id: 'test-bot', names: { fr: 'Robot test', en: 'Test Robot' }, license: 'CC0-1.0',
    canvas: [192, 288], artScale: 2, scale: 1,
    locomotion: { type, hoverPx: type === 'floats' ? 12 : 0 },
    seats: { desk: { supported: true, mode: 'sit' }, sofa: { supported: true, mode: 'sit' } },
    accessories: Object.fromEntries(contract.accessories.map(id => [id, { supported: false, reason: 'Synthetic fixture has no gear' }])),
    variants: ['pearl', 'sage', 'ochre'].map(id => ({
      id, names: { fr: id, en: id }, swatch: '#AABBCC', thumbnail: 'thumb.webp',
      frames: contract.frames.map(r => ({
        id: r.id, facing: r.facing, seated: r.seated, image: 'body.webp', ...(r.heldProp ? { heldProp: r.heldProp } : {}),
        anchors: {
          ground: [96, 276], hip: [96, 220], handLeft: [-2, 160], handRight: [150, 160],
          head: [96, 110], earLeft: [40, 110], earRight: [150, 110], neck: [96, 170], chest: [96, 190], tilt: 17,
          eyes: ['ne', 'nw'].includes(r.facing) ? { visibility: 'occluded', line: null } : { visibility: 'visible', line: [[70, 120], [100, 130]] },
          ...(r.fx ? { fx: [40, 145] } : {}),
        }, accessories: {},
      })),
    })),
  };
  return { root, pack, run: () => validateCharacterPack(pack, root) };
}
function padWebp(size) {
  const data = Buffer.alloc(size); body.copy(data);
  data.write('JUNK', body.length); data.writeUInt32LE(size - body.length - 8, body.length + 4);
  data.writeUInt32LE(size - 8, 4); return data;
}

test('three-variant 50-frame packs validate for walks, floats and rolls', t => {
  for (const type of ['walks', 'floats', 'rolls']) {
    const f = fixture(t, type); assert.equal(f.run().ok, true, JSON.stringify(f.run().errors));
    assert.deepEqual(f.run().variants.map(v => v.frames), [50, 50, 50]);
  }
});
test('all required frames are checked on the last variant, including typing and life facings', t => {
  const f = fixture(t);
  for (const id of ['working-ne-3', 'life-cupwalk-nw', 'life-readseat-ne', 'idle-ne', 'portrait']) {
    const original = f.pack.variants[2].frames;
    f.pack.variants[2].frames = original.filter(frame => frame.id !== id);
    assert.ok(f.run().errors.some(e => e.includes('ochre: missing frame ' + id)));
    f.pack.variants[2].frames = original;
  }
});
test('every anatomical anchor, seated hip, eyes and FX must be complete', t => {
  const f = fixture(t); const frame = f.pack.variants[2].frames.find(f => f.id === 'working-ne-2');
  for (const key of Object.keys(frame.anchors)) {
    const original = frame.anchors[key]; delete frame.anchors[key];
    assert.equal(f.run().ok, false, key); frame.anchors[key] = original;
  }
  delete f.pack.variants[1].frames.find(f => f.id === 'life-cupwalk-ne').anchors.fx;
  assert.ok(f.run().errors.some(e => e.includes('FX anchor')));
});
test('rear direction, held props, floor registration and seat compatibility cannot silently fall back', t => {
  const f = fixture(t, 'floats');
  const rear = f.pack.variants[0].frames.find(f => f.id === 'life-book-ne');
  rear.facing = 'sw'; delete rear.heldProp;
  f.pack.variants[0].frames[0].anchors.ground[1] = 264;
  f.pack.seats.sofa.supported = false;
  const errors = f.run().errors.join('\n');
  for (const pattern of [/facing must be ne/, /heldProp must be book/, /ground y must remain 276/, /seats.sofa/]) assert.match(errors, pattern);
});
test('accessory support declarations are mandatory, including unsupported reasons', t => {
  const f = fixture(t); delete f.pack.accessories.cap;
  f.pack.accessories.scarf.reason = '';
  assert.match(f.run().errors.join('\n'), /accessories.cap/);
  assert.match(f.run().errors.join('\n'), /unsupported reason/);
});
test('supported headwear covers every variant/frame with actual same-facing positive transforms', t => {
  const f = fixture(t); f.pack.accessories.cap = { supported: true };
  for (const v of f.pack.variants) for (const frame of v.frames) frame.accessories.cap = {
    body: frame.id, facing: frame.facing, anchor: [...frame.anchors.ground], occluded: false,
    back: 'body.webp', front: 'body.webp', sourceFacing: frame.facing, mirrored: false, matrix: [1, 0, 0, 0, 1, 0],
  };
  assert.equal(f.run().ok, true);
  const rear = f.pack.variants[2].frames.find(f => f.id === 'walking-ne');
  rear.accessories.cap.sourceFacing = 'sw'; rear.accessories.cap.matrix[0] = -1;
  delete f.pack.variants[1].frames[0].accessories.cap;
  const errors = f.run().errors.join('\n');
  assert.match(errors, /same-facing/); assert.match(errors, /positive affine/); assert.match(errors, /registration missing/);
});
test('occluded rear glasses retain registration and have no visible layers', t => {
  const f = fixture(t); f.pack.accessories.glasses = { supported: true };
  for (const v of f.pack.variants) for (const frame of v.frames) {
    const rear = ['ne', 'nw'].includes(frame.facing);
    frame.accessories.glasses = { body: frame.id, facing: frame.facing, anchor: [...frame.anchors.ground], occluded: rear, front: rear ? null : 'body.webp', back: rear ? null : 'body.webp' };
  }
  assert.equal(f.run().ok, true);
  f.pack.variants[2].frames.find(f => f.id === 'idle-ne').accessories.glasses.front = 'body.webp';
  assert.match(f.run().errors.join('\n'), /occluded layers must be null/);
});
test('custom accessory declarations follow the same completeness gate', t => {
  const f = fixture(t); f.pack.accessories.ribbon = { supported: true };
  assert.match(f.run().errors.join('\n'), /ribbon: registration missing/);
});
test('missing files, PNG disguised as WebP and wrong pixel dimensions fail', t => {
  const f = fixture(t);
  f.pack.variants[0].frames[0].image = 'absent.webp'; assert.match(f.run().errors.join('\n'), /ENOENT/);
  fs.writeFileSync(path.join(f.root, 'invalid.webp'), Buffer.from('PNG'));
  f.pack.variants[0].frames[0].image = 'invalid.webp'; assert.match(f.run().errors.join('\n'), /invalid WebP/);
  f.pack.variants[0].frames[0].image = 'thumb.webp'; assert.match(f.run().errors.join('\n'), /wrong dimensions/);
});
test('path traversal, URLs and symlinks outside the pack fail', t => {
  const f = fixture(t);
  for (const file of ['../body.webp', '/body.webp', 'https://example.test/body.webp']) {
    f.pack.variants[0].frames[0].image = file; assert.match(f.run().errors.join('\n'), /pack-relative/);
  }
  fs.symlinkSync(path.join(__dirname, '../../packaging/character-pack-contract.json'), path.join(f.root, 'escape.webp'));
  f.pack.variants[0].frames[0].image = 'escape.webp'; assert.match(f.run().errors.join('\n'), /path escapes pack/);
});
test('duplicate IDs, empty variants and malformed records are rejected without crashing', t => {
  const f = fixture(t); f.pack.variants[1].id = 'pearl'; f.pack.variants[0].frames.push(f.pack.variants[0].frames[0]);
  assert.match(f.run().errors.join('\n'), /unique/);
  f.pack.variants = [null, { frames: [null], id: 'empty' }]; assert.equal(f.run().ok, false);
  f.pack.variants = []; assert.match(f.run().errors.join('\n'), /at least one variant/);
  assert.equal(validateCharacterPack(null, f.root).ok, false);
});
test('actual unique bytes enforce per-file, per-variant and full-pack limits', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'large.webp'), padWebp(16386));
  f.pack.variants[0].frames[0].image = 'large.webp'; assert.match(f.run().errors.join('\n'), /exceeds 16384 bytes/);
  for (const frame of f.pack.variants[0].frames) {
    frame.image = frame.id + '.webp'; fs.writeFileSync(path.join(f.root, frame.image), padWebp(16384));
  }
  assert.match(f.run().errors.join('\n'), /exceeds variant budget/);
  f.pack.variants.push(structuredClone(f.pack.variants[2])); f.pack.variants[3].id = 'clay';
  for (const v of f.pack.variants) for (const frame of v.frames) {
    frame.image = v.id + '-' + frame.id + '.webp'; fs.writeFileSync(path.join(f.root, frame.image), padWebp(14336));
  }
  const errors = f.run().errors.join('\n'); assert.doesNotMatch(errors, /exceeds variant budget/); assert.match(errors, /pack exceeds/);
});
test('CLI validates a self-contained manifest, emits JSON, fails bad inputs and reports usage', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'manifest.json'), JSON.stringify(f.pack, null, 2));
  const script = path.resolve(__dirname, '../../packaging/validate-character-pack.js');
  const ok = spawnSync(process.execPath, [script, f.root], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.equal(JSON.parse(ok.stdout).ok, true);
  assert.equal(JSON.parse(ok.stdout).bytes, fs.statSync(path.join(f.root, 'manifest.json')).size + body.length + thumb.length);
  fs.writeFileSync(path.join(f.root, 'manifest.json'), '{');
  assert.equal(spawnSync(process.execPath, [script, f.root]).status, 1);
  assert.equal(spawnSync(process.execPath, [script]).status, 2);
});
