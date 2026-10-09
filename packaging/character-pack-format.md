# Character packs — Phase 1 proposal

Status: design/validation only, pending PM model picks and confirmation that the final 26c frame/anchor contract has landed. The local `design/reports/office-dev-26c.md` was read. Existing runtime manifests, scene, scheduler and look folders are not changed by this proposal.

## Self-contained directory

```text
characters/<model-id>/
  manifest.json
  thumbnails/<variant>.webp
  <variant>/<frame>.webp
  accessories/<accessory>/<variant>/<frame>.back.webp
  accessories/<accessory>/<variant>/<frame>.front.webp
```

All asset paths are relative to the pack, with no URLs, absolute paths, traversal or escaping symlinks. Code is never accepted inside a community/custom pack. `license` is an SPDX identifier or `LicenseRef-…` backed by a bundled license; this phase checks its presence, not licensing validity. IDs are lowercase slugs; FR and EN names are required, additional locales allowed. At least one variant is required for community packs; the proposed twelve models each have three.

The machine contract is [character-pack-contract.json](character-pack-contract.json). It freezes the 48 current body frame entries, including the three NE typing frames and all 26c held-object facings, and adds `idle-ne` and `portrait`: **50 entries per variant**. A pack cannot reduce its own required list. Unknown extra frames/accessories are allowed and validated. A final 26c change requires a reviewed contract version, not an implicit update from the changing shared manifest.

## Manifest shape

This fragment illustrates one frame; a delivered manifest must enumerate all 50 entries for **every** variant. Coordinates here are illustrative, not approved registration for any candidate.

```json
{
  "schemaVersion": 1,
  "contract": "bureau-26c-proposal-v1",
  "id": "orbit",
  "names": { "fr": "Orbite", "en": "Orbit" },
  "license": "LicenseRef-Pack-Art",
  "canvas": [192, 288], "artScale": 2, "scale": 1,
  "locomotion": { "type": "floats", "hoverPx": 12 },
  "seats": {
    "desk": { "supported": true, "mode": "hover-dock" },
    "sofa": { "supported": true, "mode": "hover-dock" }
  },
  "accessories": {
    "cap": { "supported": false, "reason": "Not authored in this example" },
    "headphones": { "supported": false, "reason": "Not authored in this example" },
    "glasses": { "supported": false, "reason": "Not authored in this example" },
    "scarf": { "supported": false, "reason": "Not authored in this example" },
    "badge": { "supported": false, "reason": "Not authored in this example" }
  },
  "variants": [{
    "id": "pearl", "names": { "fr": "Perle", "en": "Pearl" },
    "swatch": "#E6E0D4", "thumbnail": "thumbnails/pearl.webp",
    "frames": [{
      "id": "idle", "image": "pearl/idle.webp", "facing": "sw", "seated": false,
      "anchors": {
        "ground": [96, 276], "hip": [96, 222],
        "handLeft": [46, 184], "handRight": [148, 188],
        "head": [96, 114], "earLeft": [44, 118], "earRight": [148, 120],
        "eyes": { "visibility": "visible", "line": [[70, 118], [100, 128]] },
        "neck": [96, 165], "chest": [96, 190], "tilt": 18
      },
      "accessories": {}
    }]
  }]
}
```

Required anchors exist on every frame, including both hands/flipper or tentacle tips and a virtual hip on models without legs. Coordinates use authored image pixels; extrapolated hand landmarks may be outside the canvas, as in current high-five art. `ground.y` is always 276. Rear eyes are explicitly `{ "visibility": "occluded", "line": null }`; invisible features are not inferred from a front sprite. A seated frame's `hip` maps to the scene's `seatAnchor`. `heldProp` is mandatory for book, cupwalk, drink, water, pen, readseat and phone frames; the object and gripping digits are painted into the body. Cupwalk requires an `anchors.fx` painted-surface point for steam. A visual atlas remains necessary: metadata validation cannot prove grip, direction or scale from pixels.

For a supported accessory, **every frame in every variant** has this record in `frame.accessories.<id>`:

```json
{
  "body": "idle", "facing": "sw", "anchor": [96, 276],
  "occluded": false,
  "back": "accessories/cap/pearl/idle.back.webp",
  "front": "accessories/cap/pearl/idle.front.webp",
  "sourceFacing": "sw", "mirrored": false,
  "matrix": [1, 0, 0, 0, 1, 0]
}
```

`matrix` is `[a,b,tx,c,d,ty]`, source to authored canvas. Cap/headphones require dedicated same-facing source metadata and positive determinant; rear sources cannot be mirrored front sources. Fully hidden accessories use `occluded:true, front:null, back:null` (body, facing and anchor still required). Rear glasses/badges must be hidden; a front held book can also hide a badge. Unsupported accessories require an explicit reason and have no layer registrations. Final support is decided after the PM picks models, not assumed from these gear-free concepts.

## Scale and non-walking behavior

All production bodies/layers are 192×288 with `artScale:2, scale:1`; bake size uniformly at export. Match current Timmy's about 108 authored-pixel head width; target main body heights 210–230 px, with ears/antennae fitting within the canvas. Filo can have a narrower head; mass/eye height must be judged next to Timmy rather than independently filling each sprite canvas. Do not rescale separately by pose or apply a second runtime family scale. Thumbnail is 96×144.

The `ground` point locates an occupant on the existing 2:1 floor and supplies depth ordering for all locomotion types. Floats use a virtual floor point below the hover body, with a stationary shadow; hover is baked into the sprite and `hoverPx` describes it, not an extra scene translation. Rolls retain the same floor point and route speed. Scheduler duration, reservation limits, work preemption and neutral signals are unchanged across modes. Existing `walking`, `walking-se`, `walking-ne`, `walking-nw` keys remain logical travel slots: they contain floating/rolling art where appropriate. No simulated feet are required.

At desks and sofas, attach **hip**, not feet/ground, to the current seat landmark and preserve chair foreground occlusion. Hoverers dock and suppress bobbing; Tread parks a lowered track base; Blob compresses; Octobot folds its lower tentacles; owl/penguin perch. All packs must support desk and sofa so ordinary scheduler destinations remain available. Seated typing NE and sofa SW must have independently authored contact geometry. At shelf, coffee, plants, whiteboard and server, use current approach/facing data and the pack's hand/prop anchors: no per-model branch or landmark offset in scheduler code. Chair, desk and shelf usability must still be proved with Phase 2 browser captures.

## Registry and lazy loading (Phase 2 integration design)

Registry envelope:

```json
{
  "schemaVersion": 1,
  "packs": [{
    "id": "orbit", "names": { "fr": "Orbite", "en": "Orbit" },
    "manifest": "characters/orbit/manifest.json",
    "variants": [{ "id": "pearl", "swatch": "#E6E0D4", "thumbnail": "characters/orbit/thumbnails/pearl.webp" }]
  }]
}
```

The build discovers `characters/*/manifest.json`, validates each pack, rejects duplicate IDs, and emits a thin registry from those manifests. Adding a pack is adding its directory; no JS edits and no manual parallel catalogs. Community/custom packs use exactly the same gate and format. Installation/distribution is outside Phase 1.

One repository adapter in Phase 2 converts pack records to the existing character/variant/pose index and 26c `landmarks`, `seatAnchor`, `handAnchor` and accessory layer records. Store, renderer and life scheduler share that index. Typing IDs become the existing ordered three-frame `working-ne` sequence with the current 350ms cadence. Any new scheduler animation is declared by contract data, not by switching on model IDs. Existing three models enter through the same adapter after approval; no migration in this phase.

Fetch registry only when Bureau/Store is opened. Store loads registry thumbnails only for visible grid items (`loading=lazy`, intersection observation); selection loads that pack manifest. Scene loads manifests for deduplicated occupant model IDs, then only active variants/poses and selected accessories. Cache in-flight requests by pack URL plus `buildQuery`; prefetch the next typing frame only, evict decoded images for unused variants when the last occupant releases them. Abort unused fetches on room destroy. Never import raster sheets or bulk preload all packs. Any new JS room/registry module uses dynamic `import(path + buildQuery)` under the existing lazy entry. A new model has no initial core JS cost.

## Transfer budgets

Budget terminology is binary KiB (1 KiB = 1024 bytes); the gate stores byte counts. These are targets for future WebP production, **not measurements of generated concept PNGs**.

| Delivery | Maximum |
| --- | ---: |
| Store thumbnail, 96×144 WebP | 8 KiB |
| One body/portrait WebP, 192×288 | 16 KiB |
| One accessory layer WebP, 192×288 | 4 KiB |
| Variant incl. bodies, supported accessories and thumbnail | 768 KiB |
| Entire manifest | 192 KiB |
| Entire model, three variants + manifest | 2,560 KiB (2.5 MiB) |

Aim for 6 KiB mean body and 0.6 KiB mean layer: 50 bodies + up to 500 layers + thumbnail ≈608 KiB per variant, ≈2,016 KiB for three variants plus metadata. Individual maxima do not guarantee aggregate fit; validator enforces both. Pack transfer counts unique referenced files, never gzip estimates or unreferenced generation sources. Normal initial 12-model Store thumbnails cost at most 96 KiB for one tile per model; unused model bodies cost zero. One active idle model/variant needs its manifest plus idle and selected gear, not all 2.5 MiB. Full 12-model distribution adds at most 30 MiB raw asset bytes; npm release's existing total budget must be reviewed with actual production assets in Phase 2. Alpha uses WebP, preserve crisp edges, tune quality after native/3× review; this proposal does not change the release budget.

## Offline gate

```bash
node packaging/validate-character-pack.js <pack-directory>
node packaging/validate-character-pack.js <pack-directory>/manifest.json
```

Exit 0 passes; exit 1 reports invalid JSON, missing frames/files/anchors, bad WebP headers or dimensions, unsupported contract, undeclared/partial gear, same-facing/affine violations, unsupported seating, or size overages; usage error exits 2. Only referenced assets are read. This validates WebP container headers and completeness, not a full decoder or image semantics. Phase 2 still requires decoder/browser rendering, visual anchor atlas and 1440/360 desk/typing/travel/sofa/life evidence. No concept PNG is declared a valid production pack.

## Phase 2 integration handoff (2026-10-08)

The PM approved eleven models and the final 26b/26c states. The Phase 1 contract and validator stay unchanged. The additional integration gate is `validateIntegratedPack` in `packaging/character-pack-registry.js`. It requires the ten `egg-*` frames from 26b in every variant and `anchors.headBox: [left, top, right, bottom]` on those frames. Include that box on all frames for head cropping and visual inspection. The original 50 entries remain required.

**Accessory delivery:** authoritative manifest references must stay inside `Characters/<model>/`, including accessory layers. Use pack-local `accessories/<accessory>/<variant>/…`, or shorter equivalent pack-relative paths. Copies in the parallel brief's shared accessory export tree are optional; the integrator derives shared anchor records from the pack-local registrations. Do not use `../` references or symlinks out of the pack. This resolves the handoff questions in characters-2b/2c/2d without changing the validator.

**Substitutes:** add an optional top-level `substitutes` object. Keys are `<egg-kind>.<step-id>`, matching `EGGS` in `public/v2/office/surprises.js`. The scheduler merges the record into that one step; timing, room leases and return behavior retain the existing defaults. Every substitute has a nonempty `poses` array naming frames present in every variant. Optional fields are `point`, `anchor` (`ground` or `seat`), `approach`, `loopMs`, `ms`, `fx`, `weather`, and `label: {fr,en}`. Use existing room contacts from `ROOMS`; do not supply model-specific scene coordinates. `anchor: ground` attaches the virtual floor point; `anchor: seat` attaches `hip`. An explicit `fx: null` suppresses an inherited effect. Held-object and FX anchors remain on each body frame; no separate runtime prop artwork.

```json
"substitutes": {
  "gym.bench": {
    "point": "benchFloor", "anchor": "ground",
    "poses": ["egg-bench-low-sw", "egg-bench-high-sw"],
    "label": {"fr": "Presse en suspension", "en": "Hover press"}
  },
  "smoke.crush": {
    "point": "covered", "anchor": "ground",
    "poses": ["egg-crush-sw"],
    "label": {"fr": "Écraser", "en": "Crush"}
  }
}
```

Floaters require both entries above, with upright hover-press art and nub/stomp-bounce crush art. Rollers require `smoke.crush` with tread-pivot art. Walkers need no substitutes. All ten surprise frames retain their canonical IDs; the bench entries can be authored upright and `seated:false` for a ground-attached hover substitute. `locomotion.hoverPx` describes the gap already painted into the body and never adds another translation.

The thin registry is generated from valid pack manifests selected by `design/office/character-packs.enabled.json`. The enable list is the sole integrator's batch gate, not a second model catalog. To integrate a later validated pack, append its ID and rebuild; no model-specific JavaScript edits are needed. Discovery returns `{packs,pending}` for every pack error; the shipping build fails if any enabled manifest is invalid or missing. The registry and loader share the pure `checkPackShape` metadata gate. The loader checks the response's actual UTF-8 bytes before installation, and each caller owns an independent share of a deduplicated metadata request.

For dense three-variant manifests, non-surprise `headBox` values may remain in the source registration ledger to meet the unchanged 192 KiB metadata limit. The runtime preserves authored head/ear/neck landmarks and exposes only explicit bounds; it does not synthesize a head box. The integrator preserves measured bounds in `anchors.json`. Surprise bounds remain explicit in the pack. Compact pack-relative WebP filenames are valid; logical frame IDs retain their canonical names. No external accessory references or budget increases are needed.
