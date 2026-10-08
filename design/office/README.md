# Office: illustrated isometric scene spec

The office is the one playful surface of Agent Office. It's a cozy, painted, 2:1 dimetric room where Timmy and his sub-agents visibly work, and every pose is driven by a real agent state.

This folder is the spec and the asset contract. The renderer and the editor live in `public/v2/office/` (see its README). `api-proposal.md` holds the office contract proposals for API 2.1.

| File | What |
| --- | --- |
| `README.md` | Grid, projection, layers and z-order, the state → pose mapping, motion, interaction |
| `manifest.schema.json` | JSON Schema for the **asset manifest**: rooms, furniture, characters, accessories, themes |
| `manifest.example.json` | The manifest for the **delivered** art (generated; don't hand-edit) |
| `build-manifest.mjs` | Regenerates the manifest from `design/assets/anchors.json`; seats, stacks, labels and `pending` notes live here |
| `layout.schema.json` | JSON Schema for a **saved office layout** (what the editor writes) |
| `layout.example.json` | The default layout: 6 stations, lounge, coffee corner, server rack |
| `editor.md` | Customization editor UX: character looks, layout, room themes, names and roles |
| `api-proposal.md` | OfficeVM / LayoutVM / editor command proposals (R3-08, R3-14 … R3-18) for architect |

Art direction (from the brief):
- **Style:** smooth painted volumes in the spirit of a polished indie management game. Never pixel art or flat vector.
- **Lighting:** soft, from the top-left.
- **Palette:** ink and slate structures, warm wood and plants, indigo (`accent`) accent lights.

---

## 1. Projection and grid

- **True game isometric (2:1 dimetric).** Floor axes run at ±26.565° to the horizontal, verticals stay upright, and there's no perspective. Every asset uses exactly the same camera.
- **Tile:** **96 × 48 CSS px** at zoom 1. Art is authored and exported at **2×** (192 × 96 px per tile), so it's crisp on high-density screens. `manifest.projection.artScale = 2`.
- **Grid coordinates:** integer tiles `(x, y)`.
  - `x` grows toward the **bottom-right** (along the right wall) and `y` toward the **bottom-left** (along the left wall).
  - `(0, 0)` is the back corner, where the two walls meet.
- **Screen projection** for a grid point, before the camera offset:
  ```
  sx = (x − y) × tileW / 2
  sy = (x + y) × tileH / 2
  ```
- **Default room:** 12 × 10 tiles. Walls sit on the `y = 0` edge (right/back wall) and the `x = 0` edge (left/back wall). They are **3 tiles tall** (`wallHeight = 144` CSS px).
- **Front cutaway:** there are no front walls. The two back walls carry wall-mounted items (whiteboard, shelves, windows, signage).
- **Footprint:** every floor object occupies `w × d` tiles. `w` runs along `x` and `d` along `y`. Footprints may not overlap, except for **rugs**, which are floor decals and allow objects on top.
- **Wall items:** placed by `wall: "left" | "right"`, `offset` (tiles along the wall) and `elevation` (CSS px above the floor). They take no floor tiles.
- **Walkable tiles:** every floor tile not covered by a non-walkable footprint. Rugs are walkable; chairs are walkable only as the "seat" tile of their station.
- **Zoom:** continuous from 0.5 to 1.5 (painted art scales cleanly, unlike the old pixel office). The default is fit-to-stage. On mobile the scene is contained (fit width) and pans with one finger.

## 2. Anchors

Every image declares an **anchor**: the pixel in the image (at `artScale`) that lands on a known grid point.

| asset kind | anchor means | placed at |
| --- | --- | --- |
| room shell | the back corner of the floor (where the walls meet the floor) | grid `(0, 0)` |
| floor object | the **back corner of its footprint** (the top vertex of the footprint diamond) | grid `(x, y)` of the item |
| wall item | the bottom-left point of the item on the wall plane | the wall position |
| character | the **centre of the feet** (ground contact) | the character's `(x + 0.5, y + 0.5)` tile centre, or a station's `seat` point |
| accessory overlay | identical canvas to its character pose; anchor equal | stacks 1:1 on the pose |

Export rules for the codex agent:
- transparent PNG (or WebP), sRGB;
- anchors written in the manifest;
- no baked shadows outside the image bounds, except a **soft contact shadow** included in the image;
- canvas trimmed to content plus 8 px.

## 3. Layers and z-order

The scene renders as layered DOM images (recommended: crisp, accessible, easy hit-testing; up to about 80 sprites is fine) or as a 2D canvas. Either way, the order is fixed:

| # | layer | contents | sort |
| --- | --- | --- | --- |
| 0 | `backdrop` | page/stage colour (`bg-sunken`) | — |
| 1 | `shell` | room shell for the active theme: floor + 2 back walls | — |
| 2 | `wall` | wall-mounted items (whiteboard, shelf, window, clock) | by wall, then by `offset` |
| 3 | `decal` | rugs and floor markings | by `(x + y)` |
| 4 | `scene` | furniture **and** characters, depth-sorted together | see below |
| 5 | `light` | theme lighting overlay (night tint, lamp glows); `mix-blend-mode` per theme | — |
| 6 | `fx` | state markers (thought bubble, "?", "!" and "zz"), selection ring, floor focus ring | follows its character |
| 7 | `labels` | nameplates (DOM, `bu-nameplate`), always on top, never scaled below 11px text | by screen y |
| 8 | `ui` | stage controls (`bu-stage__controls`), editor overlays | — |

**Depth sort inside `scene`:**
```
depth(item)      = (x + w − 1) + (y + d − 1) + item.layerBias      // front corner of the footprint
depth(character) = px + py + 0.5                                   // px, py = fractional tile position while walking
tie-breakers     = higher depth first by: sub-order, then x, then id
```
- **Stations are composites.** A desk station is one footprint whose parts declare a `stack` order; the occupant is drawn at the `character` token. The character's `seat` point and `facing` come from the station.
  - **Seated:** `desk → monitor → keyboard → chair-back → accessory back → character → accessory front → chair-front armrest`. The chair bitmap is reused with a clipped foreground armrest; its backrest, seat and base stay behind the body. The agent sits on the camera side of the desk facing the monitor. Geometry comes from anchors.json `stationRegistration['desk-ne']`:
    - chair@ne at station-local tile `(0.5625, 0.7708)`;
    - the pose's `seatAnchor` lands on the chair's `seatAnchor`;
    - the NE chair cushion contact is `(100,94)`; the turned chair uses `(65,98)` and `station.seated.turned` for its contact and stack;
    - viewer-facing desk poses reuse the sofa's sitting frame and matching accessory layers through `deskPoseImage`; Timmy's larger NE art has a `.85` hip-centred scale correction, while the front frame retains the sofa scale;
    - the keyboard is shifted per family (`timmy (0,0)`, `subagent (−8,+12)` image px).

    The seat tiles `(0,1)` and `(1,1)` are non-walkable (`station.blocks`).
  - **Sofa:** `sofa → character`; `sofa-sit-sw` is placed hip-on-seat on the sofa's first `seatAnchors` point.
  - **v1 interim (looks without seated poses):** `desk → monitor → chair → character`, standing in front of the desk, facing the camera. The manifest keeps both compositions (`station.*` and `station.seated`), and the renderer picks per occupant.
- **Tall objects** that span several tiles (shelf, server rack, sofa) use their front corner for depth. If a character walking behind one of them is fully hidden, its nameplate stays visible (labels layer).

## 4. Characters

- **Timmy:** the main character. **Sub-agents:** smaller siblings (`scale: 0.85`) with the same silhouette family, differing in **colour variant** and **accessory**.
- **One image per pose**, all at the same scale, angle and anchor. The base canvas is **192 × 288 px at 2×** for Timmy. Sub-agents use the same canvas, drawn smaller inside it, so the anchors are shared.
- **Facing:** characters are drawn facing **front-left** (`sw`). Walking toward the right uses a separate `walking-se` image, not a mirror, because mirroring would flip the top-left lighting. If only `sw` exists, mirroring is allowed as a fallback for `walking` only.
- **Colour variants:** for v1, codex pre-renders each variant as its own image set (`variants[].poses`). An optional `tintMask` (greyscale) enables runtime recolouring later.
- **Accessories (contract v2):** headphones, cap, glasses, scarf and badge are **two layers per pose** on the exact pose canvas.
  - `back` is drawn behind the body (far cup and band, the back of a scarf, glasses arms), and `front` over it.
  - Each set is in slot order (`body → neck → face → head → badge`), with at most one item per slot.
  - Layers may be per character or per `character/variant`.
  - The v1 single-layer overlays are deprecated and only drawn as a fallback (`legacy: true`) until Batch 5b.
- **Default gear is data:** the sub-agent bodies are gear-free. `variants[].defaultAccessories` (teal: glasses, ochre: cap, sage: none) apply when a layout rule omits `accessories`; an explicit `[]` means none. The server resolves this into `look.accessories`.
- **Head landmarks** per pose (head box, tilt, ears, eye line, neck, chest) place the state markers above the head and drive the demo's debug overlay (`?debug=landmarks`).

### 4.1 Poses (assets)
`idle`, `working` (at the desk, typing), `thinking`, `talking`, `walking`, `celebrating`, `sleeping`, `alert`.

### 4.2 Agent state → pose (the contract with the UI)

| agent state (UI) | pose | prop / marker (fx layer) | where | micro-motion (procedural) |
| --- | --- | --- | --- | --- |
| `idle` · Inactif | `idle` | — | own station, or the lounge after 10 min idle | breathing: scaleY 1 → 1.015, 2.4 s |
| `thinking` · Réfléchit | `thinking` | thought bubble "…", 3 dots pulse | own station | dots pulse, 1.2 s |
| `working` · Exécute | `working` | monitor glow on (`accent`) | own station | typing bob 1 px, 0.4 s |
| `researching` · Recherche | `working` | **reading** prop (open book/tablet overlay) | own station or shelf station | page-turn every 3 s |
| `writing` · Rédige | `working` | document on screen, pen marker | own station | typing bob, faster (0.3 s) |
| `calling` · Appel d'outil | `talking` | plug/tool marker | own station, or the server rack for `exec` tools | marker pulse |
| `waiting` · En attente | `idle` | "?" + hourglass marker in `state-waiting` | own station | marker bob, 1.6 s |
| `error` · Erreur | `alert` | "!" marker in `state-error`, monitor tinted `danger` | own station | one shake on entry (3 × 2 px), then static |
| `offline` · Hors ligne | `sleeping` | "zz" marker, monitor off, light layer dimmed for that station | own station (head on desk) or the sofa | slow breathing |

**Transitional poses:**
- `walking`: moving between stations at 1.5 tiles/s along a grid path (A\*, 4-neighbour). The image alternates with a 2-frame bob (±2 px, 0.35 s). The state's pose applies on arrival.
- `celebrating`: a one-shot of 1.6 s when a run or cron finishes successfully. Then the character returns to the state pose. It's suppressed if another state arrives first.
- `talking` is also used when Timmy delegates to a sub-agent: the two characters face each other at the meeting table for 1.5 s, then the sub-agent walks to its desk.

**Rules:**
- A pose change is a **crossfade of 120 ms**, never a slide.
- Markers use **Bureau state colours** (`--bu-state-*` read from CSS), so the office and the UI badges always match.
- The state shown in the scene and in the roster or nameplate must come from the same field (`agent.state`).

### 4.2b Seated behaviour (Batch 6)
Agents **work seated with their back to the camera, facing the monitor**, and turn toward the camera for:
- talking, celebrating and alert/error;
- selection (a short swivel and wave, 1.8 s);
- an occasional idle swivel (every 25–50 s, held 3.5 s).

| state | seated pose |
| --- | --- |
| working, writing, calling | `working-ne`: a 3-frame typing loop, 350 ms per frame |
| researching | `reading-ne` |
| thinking | `thinking-ne` |
| idle, waiting | `seated-ne` (not delivered: the first `working-ne` frame, held still) |
| offline | `sleeping-ne` (not delivered: same as idle) |
| error | `seated-alert-sw` → `seated-turn-sw` |
| cues | `seated-celebrating-sw` / `seated-talking-sw` → the sofa sitting frame at the turned chair contact |

- **Long idle:** after 10 minutes, the agent walks to the sofa and uses `sofa-sit-sw`.
- **Walking:** facing the camera uses the SW/SE walks; walking away uses `walking-ne`/`walking-nw` when delivered (fallback: the SE/SW walk).
- **Swivels:** a swivel crossfades through `seated-swivel` when one is delivered.

### 4.2c Destinations and the delegation scene (api.md 2.1)
- **`OccupantVM.destination`** is `{ kind: 'server' | 'meeting', stationUid }`, set by the server. The occupant walks to that station (for example the server rack while an exec-class tool runs), using the station's standing seat and its state pose, and walks home when it's `null`. It takes priority over the decorative lounge rule. An unknown `stationUid` is ignored.
- **Delegation:** the `delegating` cue with `partnerId` plays a short scene. It's decorative and client-side; the server only names the partner.
  1. The delegator walks to the meeting table's right spot (faces SW), and the new sub-agent to the left spot (faces SE). The spots come from `station.seats`, on one screen row, so they face each other.
  2. Once both have arrived, they talk for 1.5 s (`talking`; `talking-se` → `idle-se` → `walking-se` until that art exists).
  3. Each walks to its own `stationUid`.
- **Edge cases:**
  - a cue that arrives before its partner is on stage waits up to 4 s;
  - a repeated `interactionId` is ignored;
  - the scene ends if either one leaves, after 15 s at most, or as soon as reduced motion is on;
  - under reduced motion, the delegator only plays the talking cue.

### 4.3 Reduced motion
Under `prefers-reduced-motion: reduce`:
- no walking (characters teleport to their target with a 120 ms fade);
- no micro-motion or celebration;
- markers are static.
The scene stays fully informative because pose, marker and nameplate carry the state.

## 5. Interaction and accessibility

- **Nameplate:** each character has one (`bu-nameplate`) showing the name and a state dot (and, on hover or focus, the state label). The nameplate is the accessible target: a real `<button>` positioned over the character with `aria-label="Timmy, Exécute"`.
- **Click or Enter:** opens the agent drawer (`bu-drawer`). **Tab** order follows the roster order (Timmy first).
- **Selection:** a floor ellipse ring in `accent` (fx layer) plus `aria-current` in the roster list.
- **Hover:** the furniture tooltip shows the station name (*Poste de Timmy*, *Machine à café*). It's decorative and never required.
- **The scene is not the only source of truth.** The roster list next to it (`bu-roster`) carries the same information for screen readers and small screens.
- **Day/night:** the theme can follow the clock (*Automatique*: night from 19:00 to 07:00, America/Toronto) or be fixed. The office theme is independent of the UI's light or dark theme.

## 6. Themes

**One owner:** `layout.theme` (api-proposal.md §4). The server resolves it (`LayoutVM.theme.resolved`, America/Toronto) and pushes the change at `nextChangeAt`.


A theme is a set of overrides:
- a room shell image;
- a lighting overlay (image + blend mode + opacity; night = `multiply` at 0.35 per the artist);
- optional per-furniture variants, tried in order (`furnitureVariants: ["night", "on"]` → `window@night`, `lamp@on`);
- `monitors: "on"` lights every occupied monitor at night (except offline); by day monitors follow the state table;
- palette hints for markers.

v1 ships **`day`** and **`night`**. Seasonal themes (`hiver`, `automne`, …) add decals and props (garland, snow on the window, pumpkins) without changing furniture footprints.

## 7. Delivered asset paths

`design/assets/anchors.json` is the truth for every canvas, anchor, seat anchor, footprint and landmark. `build-manifest.mjs` copies them into the manifest, and `test/office/manifest.test.js` fails if they drift.

```
design/assets/Office/
  room/{day,night}.png                  shells, canvas 2134×1373, anchor (971,298); *-raw.png are provenance only
  light/night.png                       overlay, multiply 0.35, same canvas/anchor as the shells
  furniture/<id>.png                    desk, chair, sofa, rug, plant-large, plant-small, shelf, coffee-machine,
                                        server-rack, meeting-table, lamp, whiteboard (right wall), window (left wall)
  furniture/monitor.png, monitor@on.png, keyboard.png   desk station parts, same canvas/anchor as desk.png
  furniture/chair@ne.png                seated chair seen from behind (own canvas, seatAnchor)
  furniture/window@night.png, lamp@on.png   night variants
design/assets/Characters/
  timmy/<pose>.png                      9 standing poses + Batch 6 seated: working-ne-1..3, thinking-ne, reading-ne,
                                        seated-turn-sw, sofa-sit-sw; portrait.png
  subagent/{sage,ochre,teal}/<pose>.png same set, gear-free, 0.85 scale baked in
  accessories/<id>/{timmy,subagent}/<pose>.png   v1 single-layer overlays: deprecated fallback
```

- **Pending:** these are documentation only (`pending` in the manifest), never fetched:
  - Batch 5b two-layer accessories `<pose>.{back,front}.png` for every pose, character and variant;
  - `seated-ne` / `sleeping-ne` / `seated-swivel`;
  - `walking-ne` / `walking-nw`;
  - sub-agent portraits;
  - meeting-table seats.
- **When art lands,** rerun `node design/office/build-manifest.mjs`. No renderer change is needed.
- **Names differing from the original plan,** absorbed by the manifest:
  - `plant-tall` → `plant-large`;
  - the sub-agent character is `subagent`, with variants `sage` / `ochre` / `teal` (labels Sauge / Ocre / Sarcelle; `sage` doubles as the base set);
  - furniture is SW-only, so rotation is disabled in the editor.

## 8. Runtime asset URLs

Manifest paths are relative to `design/` (`assets/Office/...`). The renderer prefixes them with `assetBase`:
- app: `/v2/bureau/` (frontend's `scripts/sync-design.js` copies `design/assets/{Office,Characters}` to `public/v2/bureau/assets/`);
- dev: `../../../design/` from `public/v2/office/demo.html` when a static server serves the worktree root.
