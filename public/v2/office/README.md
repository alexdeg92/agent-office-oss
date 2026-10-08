# Office scene renderer (S14a) and editor (S14c)

No-build ES modules:
- the scene is plain DOM; it draws the illustrated office from the manifest and layout in `design/office/` and animates `OfficeVM.occupants`;
- the customization editor is Preact + htm (the vendored `/v2/vendor/` runtime).

The spec is `design/office/README.md` and `editor.md`; the contract proposals are in `design/office/api-proposal.md`. This file covers the code.

| Module | What |
| --- | --- |
| `scene.js` | `OfficeScene`: layered DOM (shell, wall, decal, scene, light, fx, labels, controls), camera, occupants, walking, cues, themes, a11y |
| `geometry.js` | 2:1 projection, image anchoring, wall points, depth and sort (pure) |
| `pathfind.js` | walkable grid from the layout, 4-neighbour A* (pure) |
| `states.js` | state → pose / marker / monitor / micro-motion, cue durations, French labels (pure) |
| `theme.js` | Jour / Nuit / Automatique (19:00–07:00, America/Toronto) (pure) |
| `assets.js` | manifest index; pose (frames, seat anchors), two-layer accessory, landmark and seat-mode resolution, with fallbacks (pure) |
| `layout-rules.js` | **the** semantic validator, placement checks and occupant resolution (names, looks, stations), shared with the server (pure) |
| `landmarks.js` | normalises the artist's head landmarks (pure; used by build-manifest) |
| `editor-model.js` | immutable layout edits and undo history (pure) |
| `editor.js`, `editor.css` | the customization editor: Disposition, Personnages, Thème, save, conflicts, versions |
| `page.js`, `page.css` | the **Bureau page** (`/v2/bureau`): KPIs, scene, roster, agent drawer, Journal / File, office-theme toggle, editor entry |
| `mock-office.js` | OfficeVM / LayoutVM builders for the mock API, built from `docs/architecture/examples/` 2.1 and scripted (cues included) |
| `bureau-dev.html`, `bureau-dev.js` | standalone harness: the real page on a fake stream fed by `mock-office.js` |
| `contact.html`, `contact.js` | accessory contact sheet: every look × pose × accessory at 2×, marked v2 / v1 / absent (Batch 5b QA) |
| `mock-store.js` | the layout API in memory (contract 2.0 shapes + the 2.1 proposal), with 409s; demo and tests |
| `markers.js` | fx markers (Lucide icons inline) |
| `office.css` | scene styles; only `--bu-*` tokens; reduced-motion rules |
| `demo.html`, `demo.js` | standalone demo on mock occupants |
| `package.json` | `{"type":"module"}` so `test/office/` can `require()` the pure modules |

## Using it from the Bureau page

```js
import { OfficeScene } from '/v2/office/scene.js';
// stage: a sized element (e.g. <div class="bu-stage">); link /v2/office/office.css after bundle.css
const scene = new OfficeScene(stage, {
  manifest, layout,                // LayoutVM (GET /api/v2/office/layout)
  assetBase: '/v2/bureau/',        // manifest paths are "assets/Office/…"
  labels,                          // optional: { idle: 'Inactif', … } from MetaVM.labels['agentState.*']
  theme: 'auto',                   // UiPrefs.officeTheme: 'auto' | 'day' | 'night'
  onSelect: (occupantId) => openDrawer(occupantId),
});
scene.setOccupants(officeVM.occupants);   // on every snapshot/delta; roster order = Tab order
scene.cue(frame.occupantId, frame.cue);   // SSE 'cue' frames: celebrating | talking | delegating
scene.select(id);                         // ring + aria-current when the roster selects someone
scene.setTheme('night');
scene.setLayout(newLayout);               // when layoutRevision changes (replans every walk)
scene.addControl({ label: 'Personnaliser', icon, text: true, onClick });   // page-level stage buttons
scene.setLegacyAccessories(false);        // hide the deprecated v1 overlays (default: shown until Batch 5b)
scene.destroy();
```

The scene never decides who sits where: `stationUid`, `look` and `name` come resolved from the server, using `layout-rules.js` `resolveOccupants`. The client-side movements are decorative (api-proposal.md §6):
- idle for 10 minutes → a free lounge seat;
- idle swivels and the selection wave;
- `stationUid: null` (overflow) → the standing area near the entrance.

## Opening the editor
```js
import { openEditor } from '/v2/office/editor.js';
const editor = await openEditor({
  scene, store,                             // store = { get, getRevision, put } over /api/v2/office/layout (or mock-store.js)
  barHost, asideHost,                       // where the top bar and the side panel render
  getOccupants: () => sources,              // live roster: [{ id, role, sourceName, state, stateSince }]
  assetBase: '/v2/bureau/', toast,          // toast(message, level)
  onExit: ({ saved, layout, revision, vm }) => { /* re-render the page from vm */ },
});
```
- **While it's open,** the scene previews the draft: walking is off, and in Disposition states pause on *Inactif*.
- **Keyboard:** Ctrl+Z / Ctrl+Maj+Z; in Disposition, arrows (Maj: 3 tiles), R, Ctrl+D, Suppr and Échap; palette tiles with Entrée.
- **Announcements** go through a polite live region.

## Behaviour summary
- **Depth:** floor items and walking characters are sorted every frame something moves (README §3 formula, ties by sub-order, x, id). A seated occupant is drawn at its station's `character` stack slot.
- **Poses:** 120 ms crossfade between pose groups (body + accessory overlays); new images are decoded before the swap. Missing art falls back `walking-se → walking → idle`; a missing accessory pose shows nothing.
- **Walking:** A* over tiles, 1.5 tiles/s, SE walk image when moving screen-right (never mirrored). New occupants walk in from `room.entrance`; leaving ones walk out and fade.
- **Monitors:** on for active states, off for idle/offline, `danger` tint + glow for error; at night every occupied monitor is on except offline. Offline dims the station.
- **Reduced motion** (`prefers-reduced-motion` or `setReducedMotion(true)`): teleport with a 120 ms fade; no micro-motion, celebrations, idle swivels, frame loops or animated markers. Turning it on mid-walk snaps walkers to their destination (R4-14).
- **Seated:** desk occupants sit hip-on-cushion, typing in a 3-frame loop. A clipped near-armrest layer draws over the body; the chair backrest, seat and base draw behind it. Viewer-facing poses resolve through `deskPoseImage` to the proven sofa sitting frame, with matching gear and the turned chair contact. Seated waves pivot about the hips, and celebrations never hop off the seat. Desk visitors talk to the seated host; long idle goes to the sofa (`sofa-sit-sw`), returning to the chair for a visitor.
- **Lifecycle (R4-12/13/15):**
  - every timer, interval and frame belongs to its character and is cancelled on exit and in `destroy()`;
  - a pose whose images finish decoding after a newer request is dropped;
  - only the current instance of an id clears the selection;
  - `setLayout` invalidates every planned path.
- **Accessibility:** the world is `aria-hidden`; each occupant has a real `<button class="bu-nameplate">` with `aria-label="Timmy, Exécute"`, in roster order, plus a polite live region announcing state changes. The viewport is focusable: arrows pan (Maj = faster), `+`/`−` zoom, `0` refits. Furniture tooltips (`title`) are decorative.
- **Camera:** fit-to-stage by default (and on resize until the user zooms), zoom 0.5–1.5 (lower only if needed to fit), wheel / pinch zoom, drag pan.

## Demo
Serve the worktree root with any static server and open `/public/v2/office/demo.html`; it reads `design/` directly (`../../../design/`). Under the app (`/v2/office/demo.html`) it uses `/v2/bureau/` for CSS and assets and expects the manifest/layout JSON at `/v2/bureau/office/` (not synced yet). Query params: `theme=auto|day|night`, `scenario=mix|all`, `reduced=1`, `select=<occupantId>`, `assets=<base>`.

Tests: `node --test "test/office/*.test.js"`.
- Pure suites: projection, depth sort, pathfinding, manifest ↔ art, theme clock, poses and layers, the validator and resolver, editor model, mock API.
- `scene.dom.test.js` drives the real scene and editor in headless Chrome over CDP (`test/office/helpers/browser.js`, no dependencies). It covers R4-12…15, Tab/Enter on nameplates, and editor keyboard placement, undo, save, 409 (Écraser / Recharger) and reset.
  - It's skipped without Chrome (`CHROME_BIN`; `OFFICE_DOM_TESTS=0` disables it).
  - A fresh headless profile spends about 20–25 s on its first navigation, so the file shares one browser.

Demo: `?edit=1` (or `?edit=characters|theme`) opens the editor; `?debug=landmarks` shows the head landmarks; `?legacy=0` hides the v1 accessory overlays.

## Bureau page (S14a/b)
`BureauPage({ match })` reads `useTopic('office', '/api/v2/views/office')` and `useTopic('layout', '/api/v2/office/layout')`.
- **One list:** the scene, the roster and the drawer all read `OfficeVM.occupants`.
- **Selection** lives in `?agent=<occupantId>`. Escape closes the drawer and focus goes back to where it was.
- **Cues** arrive through `services.cueListeners`, which `app.js` must feed from the stream's `onCue`.
- **Theme toggle:** `PUT /api/v2/office/layout/theme` (api-proposal §4), with one retry on a 409 using `current.revision`.
- **Editor:** opens from the stage control or the drawer; it writes through `/api/v2/office/layout`.
- **Labels missing from MetaVM** (`kpi.*`, `occupantRole.*`, `liveEvent.*`, `schedule.*`) fall back to French in `page.js` (`FALLBACK`).
- **Test seams:** `services.officeApi` (layout writes) and `services.officeAssetBase`.

Harness: `/public/v2/office/bureau-dev.html?steps=6&tick=3000&scenario=1|vide|panne&agent=<id>`. Contact sheet: `/public/v2/office/contact.html?look=timmy|subagent/teal&acc=all`.

**Batch 5b:** `build-manifest.mjs` computes `manifest.accessoriesV2 {complete, covered, total}`. The scene draws the v1 overlays as a fallback until `complete`, then turns them off by default; no code change is needed to switch.
