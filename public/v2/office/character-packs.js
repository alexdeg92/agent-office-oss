// Pure registry adapter, shared by the renderer, Store and offline build tooling.
const point = p => ({ x: p[0], y: p[1] });
export function packDescriptor(pack, base) {
  const variants = pack.variants.map(v => ({ id: v.id, names: v.names, swatch: v.swatch,
    thumbnail: base + v.thumbnail, gearFree: true, defaultAccessories: [], poses: { idle: base + v.thumbnail } }));
  return { id: pack.id, names: pack.names, family: pack.id, role: 'subagent',
    canvas: { w: 192, h: 288 }, anchor: { x: 96, y: 276 }, scale: 1, scaleBaked: true,
    head: { y: 60 }, locomotion: pack.locomotion, seats: pack.seats, accessorySupport: pack.accessories,
    packManifest: base + 'manifest.json', thumbnail: variants[0].thumbnail, poses: variants[0].poses, variants };
}
export function adaptCharacterPack(pack, base) {
  const descriptor = packDescriptor(pack, base);
  const layers = {};
  const variants = pack.variants.map(v => {
    const poses = {}, landmarks = {};
    const frames = new Map(v.frames.map(f => [f.id, f]));
    const entry = f => ({ image: base + f.image, anchor: point(f.anchors.ground), canvas: { w: 192, h: 288 },
      ...(f.seated && { seatAnchor: point(f.anchors.hip) }), handAnchor: point(f.anchors[f.facing === 'se' || f.facing === 'ne' ? 'handRight' : 'handLeft']),
      ...(f.anchors.fx && { fxAnchor: point(f.anchors.fx) }) });
    const landmark = f => { const a = f.anchors; return { headCentre: point(a.head),
      ...(a.headBox && { headBox: { x: a.headBox[0], y: a.headBox[1], w: a.headBox[2] - a.headBox[0], h: a.headBox[3] - a.headBox[1] } }),
      tilt: a.tilt, earLeft: point(a.earLeft), earRight: point(a.earRight), neck: point(a.neck), chest: point(a.chest),
      ...(a.eyes.line && { eyeLine: { a: point(a.eyes.line[0]), b: point(a.eyes.line[1]) } }) }; };
    const key = pack.id + '/' + v.id;
    for (const f of v.frames) {
      if (f.id === 'portrait' || /^working-ne-\d+$/.test(f.id)) continue;
      poses[f.id] = entry(f); landmarks[f.id] = landmark(f);
    }
    const typing = [1, 2, 3].map(i => frames.get('working-ne-' + i));
    poses['working-ne'] = { ...entry(typing[0]), frames: typing.map(f => base + f.image),
      frameSeatAnchors: typing.map(f => point(f.anchors.hip)), frameMs: 350 };
    delete poses['working-ne'].image; landmarks['working-ne'] = landmark(typing[0]);
    const pair = reg => reg?.occluded ? {} : { ...(reg?.back && { back: base + reg.back }), ...(reg?.front && { front: base + reg.front }) };
    for (const [aid, support] of Object.entries(pack.accessories)) {
      if (!support.supported) continue;
      const out = {};
      for (const f of v.frames) {
        if (f.id === 'portrait' || /^working-ne-\d+$/.test(f.id)) continue;
        out[f.id] = pair(f.accessories[aid]);
      }
      const sequence = typing.map(f => pair(f.accessories[aid]));
      out['working-ne'] = { ...sequence[0], frames: sequence };
      (layers[aid] ??= {})[key] = out;
    }
    return { ...descriptor.variants.find(x => x.id === v.id), poses, landmarks, portrait: base + frames.get('portrait').image };
  });
  return { character: { ...descriptor, packLoaded: true, substitutes: pack.substitutes ?? {}, variants,
    poses: variants[0].poses, landmarks: variants[0].landmarks }, layers };
}
export function installCharacterPack(index, pack, base) {
  const adapted = adaptCharacterPack(pack, base);
  index.characters.set(pack.id, adapted.character);
  for (const [id, layers] of Object.entries(adapted.layers)) {
    const accessory = index.accessories.get(id);
    if (accessory) accessory.layers = { ...accessory.layers, ...layers };
  }
  return adapted.character;
}
