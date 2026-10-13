'use strict';
// design/office manifest + default layout against the delivered art, plus theme clock and pose
// resolution. Catches renamed or missing artist files before the scene shows a broken image.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OFFICE = path.join(ROOT, 'public', 'v2', 'office');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/manifest.example.json'), 'utf8'));
const layout = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/office/layout.example.json'), 'utf8'));
const anchors = JSON.parse(fs.readFileSync(path.join(ROOT, 'design/assets/anchors.json'), 'utf8')).assets;
const { indexManifest, poseImage, accessoryImages, furnitureImage, themeFor } = require(path.join(OFFICE, 'assets.js'));
const { buildGrid, findPath, nearestWalkable } = require(path.join(OFFICE, 'pathfind.js'));
const { footprintFor, footprintTiles } = require(path.join(OFFICE, 'geometry.js'));
const { resolveTheme, isNight } = require(path.join(OFFICE, 'theme.js'));
const { STATES, STATE_VIEW } = require(path.join(OFFICE, 'states.js'));

const idx = indexManifest(manifest);

/** Every asset path in the manifest, skipping the documentation-only `pending` lists. */
function paths(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => paths(n, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (k !== 'pending') paths(v, out); }
  else if (typeof node === 'string' && node.startsWith('assets/')) out.push(node);
  return out;
}

// The manifest built from the art on disk now (pure import, writes nothing) and the sections that move
// while an art batch is being delivered (Batch 5b): a lag there is reported, never a failure.
const { manifest: fresh, IN_FLUX } = require(path.join(ROOT, 'design/office/build-manifest.mjs'));
const stable = (m) => {
  const c = structuredClone(m);
  for (const k of IN_FLUX) delete c[k];
  for (const ch of c.characters) { delete ch.landmarks; for (const v of ch.variants ?? []) delete v.landmarks; }
  return c;
};

describe('manifest.example.json ↔ delivered art', () => {
  it('the committed manifest matches a fresh build outside the in-flux art sections', (t) => {
    assert.deepEqual(stable(manifest), stable(fresh), 'stale manifest: run `node design/office/build-manifest.mjs`');
    const lag = JSON.stringify(manifest.accessories) !== JSON.stringify(fresh.accessories);
    if (lag) t.diagnostic(`Batch 5b in progress: committed accessories lag the art (${manifest.accessoriesV2?.covered}/${fresh.accessoriesV2.total} vs ${fresh.accessoriesV2.covered} on disk); rerun build-manifest when convenient.`);
  });

  it('a character family delivered in batches ships only when complete (base poses and every v2 accessory layer)', (t) => {
    for (const [id, s] of Object.entries(fresh.families ?? {})) {
      const shipped = fresh.characters.some((c) => c.id === id);
      assert.equal(shipped, s.complete, `${id}: shipped only when complete`);
      const kb = fresh.furniture.find((f) => f.id === 'desk')?.station?.seated?.parts?.keyboard?.offsetByCharacter ?? {};
      for (const k of Object.keys(kb)) assert.ok(fresh.characters.some((c) => c.id === k), `keyboard offset for unshipped character ${k}`);
      if (!s.complete) {
        assert.ok(fresh.pending.some((p) => p.includes(id)), `${id} listed as pending`);
        t.diagnostic(`${id} in delivery: base ${s.base.covered}/${s.base.total}, accessory layers ${s.accessories.covered}/${s.accessories.total}`);
      }
    }
    // Shipping a partial family would make accessoriesV2 incomplete and bring back the v1 overlays for every look.
    assert.equal(fresh.accessoriesV2.complete, true, 'shipped looks keep complete v2 accessory coverage');
  });

  it('a fresh build references only files that exist (by construction, even mid-delivery)', () => {
    assert.deepEqual(paths(fresh).filter((p) => !fs.existsSync(path.join(ROOT, 'design', p))), []);
  });

  it('every file the committed manifest references exists (in-flux accessory files only warn)', (t) => {
    const missing = paths(stable(manifest)).filter((p) => !fs.existsSync(path.join(ROOT, 'design', p)));
    assert.deepEqual(missing, []);
    const gone = paths(manifest.accessories).filter((p) => !fs.existsSync(path.join(ROOT, 'design', p)));
    if (gone.length) t.diagnostic(`${gone.length} accessory file(s) referenced by the committed manifest were moved by the artist; rerun build-manifest`);
  });

  it('anchors and sizes match design/assets/anchors.json (the source of truth)', () => {
    const check = (p, anchor, size, what) => {
      const a = anchors[p.replace(/^assets\//, '')];
      assert.ok(a, `${what}: ${p} not in anchors.json`);
      if (anchor) assert.deepEqual([anchor.x, anchor.y], a.anchor, `${what} anchor`);
      if (size) assert.deepEqual([size.w, size.h], a.canvas, `${what} size`);
    };
    for (const r of manifest.rooms) for (const p of Object.values(r.images)) check(p, r.anchor, r.size, r.id);
    const sofa = manifest.furniture.find(f => f.id === 'sofa'), sofaAnchors = anchors['Office/furniture/sofa.png'].seatAnchors;
    assert.deepEqual(sofa.station.seated.seats, Object.entries(sofaAnchors).map(([id, [x, y]]) => ({ id, seatPoint: { x, y } })), 'every authored sofa seat has its own registered hip contact in draw order');
    assert.equal(new Set(sofa.station.seated.seats.map(seat => `${seat.seatPoint.x},${seat.seatPoint.y}`)).size, sofa.station.seated.seats.length, 'multi-seat furniture contacts are distinct');
    for (const f of manifest.furniture) {
      if (f.packManifest) {
        // Pack registrations replace the shared legacy ledger; the thin image is a thumbnail.
        const { pack, metadataBytes } = require('../../packaging/decor-pack-registry').readDecorManifest(path.join(ROOT, 'design', f.packManifest));
        assert.ok(require('../../packaging/decor-pack-registry').validateDecorPack(pack, path.dirname(path.join(ROOT, 'design', f.packManifest)), metadataBytes).ok);
        const descriptor = require('../../public/v2/office/decor-packs').decorDescriptors(pack, f.packManifest.replace(/manifest\.json$/, '')).find(x => x.id === f.id);
        assert.deepEqual(f, descriptor);
        continue;
      }
      check(f.image, f.anchor, f.size, f.id);
      for (const p of Object.values(f.images ?? {})) check(p, f.anchor, f.size, f.id);
      for (const [name, part] of Object.entries(f.station?.parts ?? {})) {
        const o = typeof part === 'string' ? { image: part } : part;
        for (const p of [o.image, ...Object.values(o.variants ?? {})]) check(p, o.anchor ?? f.anchor, o.size ?? f.size, `${f.id}.${name}`);
      }
      if (f.footprint) {
        const a = anchors[f.image.replace(/^assets\//, '')];
        assert.deepEqual(f.footprint, a.footprint, `${f.id} footprint`);
      }
    }
    for (const c of manifest.characters) {
      for (const set of [c.poses, ...(c.variants ?? []).map((v) => v.poses)]) {
        for (const e of Object.values(set)) {
          // A pose is a path or {image|frames, seatAnchor?, anchor?, canvas?}; check every file and seat anchor.
          const files = typeof e === 'string' ? [e] : e.frames ?? [e.image];
          for (const p of files) {
            // (typeof guard: a string has String.prototype.anchor, a legacy method)
            const o = typeof e === 'string' ? {} : e;
            check(p, o.anchor ?? c.anchor, o.canvas ?? c.canvas, c.id);
            if (e.seatAnchor) assert.deepEqual([e.seatAnchor.x, e.seatAnchor.y], anchors[p.replace(/^assets\//, '')].seatAnchor, `${p} seatAnchor`);
          }
        }
      }
    }
  });

  it('characters have every required pose; sub-agent scale is baked', () => {
    const required = ['idle', 'working', 'thinking', 'talking', 'walking', 'celebrating', 'sleeping', 'alert'];
    for (const c of manifest.characters) {
      for (const set of [c.poses, ...(c.variants ?? []).map((v) => v.poses)]) for (const p of required) assert.ok(set[p], `${c.id} ${p}`);
    }
    const sub = idx.characters.get('subagent');
    assert.equal(sub.scaleBaked, true);
  });

  it('every state maps to a pose every character has', () => {
    for (const s of STATES) for (const c of manifest.characters) assert.ok(c.poses[STATE_VIEW[s].pose], `${s} → ${c.id}`);
  });
});

it('blocked and executing states have explicit, available scene mappings', () => {
  const { viewFor, stateIconFor, SEATED_VIEW } = require(path.join(OFFICE, 'states.js'));
  const { readFileSync } = require('node:fs');
  assert.ok(STATES.includes('blocked'));
  assert.equal(viewFor('blocked').marker, 'alert');
  assert.equal(viewFor('blocked').pose, 'alert');
  assert.equal(SEATED_VIEW.blocked.pose, 'seated-alert-sw');
  assert.equal(SEATED_VIEW.blocked.turn, true);
  assert.equal(stateIconFor('blocked'), 'state-error');
  assert.equal(viewFor('executing').pose, 'working');
  assert.equal(viewFor('executing').marker, 'executing');
  assert.equal(stateIconFor('executing'), 'tool-exec');
  assert.match(readFileSync(path.join(__dirname, '../../public/v2/icons.js'), 'utf8'), /"tool-exec"/);
  for (const character of manifest.characters) {
    assert.ok(character.poses[viewFor('blocked').pose], `${character.id} has blocked pose`);
  }
});

describe('layout.example.json', () => {
  const room = idx.rooms.get(layout.room);
  const floor = layout.items.filter((i) => i.wall == null);

  it('references known assets and characters', () => {
    for (const it of layout.items) assert.ok(idx.furniture.has(it.asset), it.asset);
    for (const a of layout.agents) {
      const c = idx.characters.get(a.character);
      assert.ok(c, a.character);
      if (a.variant) assert.ok(c.variants.some((v) => v.id === a.variant), a.variant);
      for (const acc of a.accessories ?? []) assert.ok(idx.accessories.has(acc), acc);
    }
  });

  it('footprints (and station extra tiles) stay inside the room and never overlap, rugs excepted', () => {
    const seen = new Map();
    for (const it of floor) {
      const f = idx.furniture.get(it.asset);
      if (f.placement === 'decal') continue;
      const tiles = [...footprintTiles(it.x, it.y, footprintFor(f.footprint, it.orientation)), ...(f.station?.blocks ?? []).map((b) => ({ x: it.x + b.x, y: it.y + b.y }))];
      for (const t of tiles) {
        assert.ok(t.x >= 0 && t.y >= 0 && t.x < room.cols && t.y < room.rows, `${it.uid} outside at ${t.x},${t.y}`);
        const k = `${t.x},${t.y}`;
        assert.ok(!seen.has(k), `${it.uid} overlaps ${seen.get(k)} at ${k}`);
        seen.set(k, it.uid);
      }
    }
  });

  it('every station seat is reachable from the entrance', () => {
    const grid = buildGrid(room.cols, room.rows, floor, idx.furniture);
    const start = nearestWalkable(grid, room.entrance.x, room.entrance.y);
    for (const it of floor) {
      const f = idx.furniture.get(it.asset);
      if (!f.station) continue;
      const seat = { x: Math.floor(it.x + f.station.seat.x), y: Math.floor(it.y + f.station.seat.y) };
      assert.ok(findPath(grid, start, seat), `${it.uid} seat ${seat.x},${seat.y} unreachable`);
    }
  });

  it('the main agent has a desk station', () => {
    const main = layout.agents.find((a) => a.match?.kind === 'main');
    const st = layout.items.find((i) => i.uid === main.station);
    assert.equal(idx.furniture.get(st.asset).station.kind, 'desk');
  });
});

describe('theme', () => {
  it('night window wraps midnight', () => {
    assert.equal(isNight(19 * 60), true);
    assert.equal(isNight(23 * 60 + 59), true);
    assert.equal(isNight(0), true);
    assert.equal(isNight(6 * 60 + 59), true);
    assert.equal(isNight(7 * 60), false);
    assert.equal(isNight(18 * 60 + 59), false);
    assert.equal(isNight(13 * 60, '12:00', '14:00'), true);
  });

  it('automatique follows the instance zone it is given (no built-in zone), across DST', () => {
    // the zone is data (MetaVM.instance.timeZone); Toronto here is just a test instance
    const TZ = 'America/Toronto';
    assert.equal(resolveTheme('auto', new Date('2026-10-05T23:30:00Z'), TZ), 'night'); // 19:30 EDT
    assert.equal(resolveTheme('auto', new Date('2026-10-05T22:59:00Z'), TZ), 'day'); // 18:59 EDT
    assert.equal(resolveTheme('auto', new Date('2026-01-15T11:59:00Z'), TZ), 'night'); // 06:59 EST
    assert.equal(resolveTheme('auto', new Date('2026-01-15T12:00:00Z'), TZ), 'day'); // 07:00 EST
    // the same instant in a Paris instance: 23:30 UTC is 01:30 CEST → night; 16:00 UTC is 18:00 → day
    assert.equal(resolveTheme('auto', new Date('2026-10-05T23:30:00Z'), 'Europe/Paris'), 'night');
    assert.equal(resolveTheme('auto', new Date('2026-10-05T16:00:00Z'), 'Europe/Paris'), 'day');
    assert.equal(resolveTheme('auto', new Date('2026-10-05T16:30:00Z'), 'Asia/Tokyo'), 'night');   // 01:30 JST
  });

  it('fixed modes ignore the clock', () => {
    assert.equal(resolveTheme('night', new Date('2026-10-05T16:00:00Z')), 'night');
    assert.equal(resolveTheme({ mode: 'fixed', fixed: 'day' }, new Date('2026-10-05T03:00:00Z')), 'day');
  });

  it('night swaps in the delivered night/on variants', () => {
    const night = themeFor(idx, 'night');
    assert.match(furnitureImage(idx.furniture.get('window'), 'sw', night.furnitureVariants), /window@night\.png$/);
    assert.match(furnitureImage(idx.furniture.get('lamp'), 'sw', night.furnitureVariants), /lamp@on\.png$/);
    assert.match(furnitureImage(idx.furniture.get('desk'), 'sw', night.furnitureVariants), /desk\.png$/);
  });
});

describe('pose resolution', () => {
  it('variants override base poses', () => {
    const sub = idx.characters.get('subagent');
    assert.match(poseImage(sub, 'ochre', 'working').path, /subagent\/ochre\/working\.png$/);
    assert.match(poseImage(sub, null, 'working').path, /subagent\/sage\/working\.png$/);
  });

  it('missing art falls back instead of blanking', () => {
    const fake = { poses: { idle: 'assets/Characters/x/idle.png', walking: 'assets/Characters/x/walking.png' } };
    assert.equal(poseImage(fake, null, 'walking-se').pose, 'walking');
    assert.equal(poseImage(fake, null, 'alert').pose, 'idle');
  });

  it('accessories stack in slot order, one per slot; v2 layers win, v1 is the fallback', () => {
    const { accessoryLayers } = require(path.join(OFFICE, 'assets.js'));
    // headphones and cap share the head slot: the first in slot order wins, the other is dropped.
    const r = accessoryLayers(idx, 'timmy', ['headphones', 'cap', 'scarf', 'glasses'], 'idle');
    const ids = [...new Set([...r.back, ...r.front].map((a) => a.id))];
    assert.deepEqual(ids.sort(), ['glasses', 'headphones', 'scarf']);
    assert.deepEqual(r.front.map((a) => a.id), ['scarf', 'glasses', 'headphones']);
    // Per pose: delivered v2 layers → back+front; else the v1 overlay as one legacy front layer; else nothing.
    for (const pose of ['idle', 'working', 'thinking', 'talking']) {
      const a = manifest.accessories.find((x) => x.id === 'headphones');
      const one = accessoryLayers(idx, 'timmy', ['headphones'], pose);
      if (a.layers?.timmy?.[pose]) assert.ok(one.front.length === 1 && !one.front[0].legacy, pose);
      else if (a.images?.timmy?.[pose]) assert.ok(one.front[0].legacy, pose);
      else assert.equal(one.front.length + one.back.length, 0, pose);
    }
    // Sub-agents only have the deprecated single-layer overlays where no v2 layer exists; hidden with legacy:false.
    const subIdle = accessoryImages(idx, 'subagent', ['glasses'], 'idle', 'sage');
    const v2 = manifest.accessories.find((x) => x.id === 'glasses').layers?.['subagent/sage']?.idle;
    assert.equal(subIdle[0]?.legacy, v2 ? undefined : true);
    // With legacy:false, a combination that has no v2 layer yet draws nothing (picked from the data, as 5b lands).
    const sub = manifest.characters.find((c) => c.id === 'subagent');
    const gap = manifest.accessories.flatMap((x) => Object.keys(sub.variants[0].poses).map((pose) => [x.id, pose]))
      .find(([id, pose]) => { const x = manifest.accessories.find((a) => a.id === id); return !x.layers?.[`subagent/${sub.variants[0].id}`]?.[pose] && !x.layers?.subagent?.[pose]; });
    if (gap) assert.deepEqual(accessoryImages(idx, 'subagent', [gap[0]], gap[1], sub.variants[0].id, { legacy: false }), []);
  });
});
