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
- **Seated:** desk occupants sit hip-on-cushion, typing in a 3-frame loop. For the rear-facing chair, clipped backrest and near-armrest layers draw over the body; the cushion and base stay behind. The turned chair retains its backrest behind the torso. Viewer-facing poses resolve through `deskPoseImage` to the proven sofa sitting frame, with matching gear and the turned chair contact. Seated waves pivot about the hips, and celebrations never hop off the seat. Desk visitors talk to the seated host; long idle goes to the sofa (`sofa-sit-sw`), returning to the chair for a visitor.
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

## Office life (office-dev-26a)

`life.js` defines weighted idle activities and signal reactions; Held objects and gripping fingers are authored together in the body raster; separate CSS FX supply steam and water drops. Round 2 adds eight generated WebP poses per look (sleep, facepalm, fist pump, stretch, rear NE/NW, two high-five facings) with registered accessory pairs and seated hip anchors. Glyph bubbles use the unscaled label layer. `scene.interact(id, kind, { durationMs })` runs the actual A* walk, landmark pose and return. Coffee, watering, window, book, whiteboard, chat, high-five, visitor wave, desk nap and server checks require an idle, present occupant and a reachable landmark. Missing furniture or a busy partner excludes that choice. Visits, editing, hidden/frozen scenes, removal and work preempt the activity. A return goes to the desk before lounge eligibility resumes.

Options `life: { idleAfterMs, intervalMs, cooldownMs, longRunMs }`, `random` and `walkTilesPerS` support deterministic QA. Defaults: 45 seconds idle, a 5-second scheduler, 90 seconds between activities, stretch after 5 minutes of active work. No consecutive repeat. Success uses the actual celebrating cue; errors, waiting, wake-up notice and long-run stretches use state transitions/time. An idle snapshot alone does not imply a successful run. Reading and calling use registered seated book/phone rasters; writing retains its typing loop. New gesture poses have their own head, hand and hip registration; chair composition remains hip-anchored. The rear-facing backrest is clipped into a foreground layer over the seated back, then the near armrest; the turned chair keeps its backrest behind the torso. Social partners stand on separate free floor tiles, face each other, and align high-five palms across different heights. Coffee carries its cup until arrival home.

Open `bureau-dev.html?life=1&tick=600000` for state/action selectors, or use `window.officeLife`. `scene.react(id, 'success'|'error'|'message'|'stretch'|'waiting', {durationMs})` forces a reaction. Reduced motion holds pose changes and FX still and uses the established fade/teleport. `design/reports/office-dev-26a/round-2/capture.cjs` captures every interaction at 1440 and 360, with 2× camera close-ups and 2× device scale. Source prompts and the registration script live under `design/assets/tools/office26-round2-sources/` and `register_office26_life.py`. New sprites/layers load only when their pose is used; source sheets are not served.


## Held props and facing gear (office-dev-26c)

Every look has 24 generated held-object WebPs: mug walk, book, drink, watering can and marker in SW/SE/NE/NW, plus seated book and phone in NE/SW. Coffee alternates holding/drinking frames and returns with the mug in the actual walking body; work clears the carry and sip timer. The vector prop module was removed.

Cap/headphone renders come from dedicated source perspectives for each look, including both rear directions, and are registered to every body frame, including each typing frame. Headphone far cup/band draws behind the head and near cup over its ear. Every accessory layer records a `poseRegistration` with its body, anchors and facing in `anchors.json`; the gate in `test/office/life-registration.test.js` traverses the entire runtime manifest. `register_office26c.py` exports the rasters; `office26c_atlas.py` emits all-frame 3× head/hand sheets. The existing head-slot rule still selects cap OR headphones; the QA atlas composites both to inspect all five registrations together. Raw generation sources and normalized prompt sets live under `design/assets/tools/office26c-sources/` and are excluded from the runtime copy.

## Neutral signals and scale (Open + scale)

`scene.signal(occupantId, signal)` accepts opaque occupant ids and the neutral vocabulary below. A runtime adapter supplies canonical engine data; the scene reads no adapter fields. The v3 OfficeVM journal now exposes optional `occupantId` and `activity` from those canonical LiveEvents. Both v2 and v3 SSE office subscriptions receive canonical engine signals in cue frames; the page forwards them to `signal`. Event id/at/count deduplicates these against the v3 journal. Both the main scene and annexes call `setSignals(vm.journal)`: the initial history is seeded without replay, and subsequent id/at/count changes are consumed once. The v2 projection remains unchanged. Missing signals are not fabricated: current adapters that only supply run state still use neutral occupant states; richer adapters can supply tool categories, waiting, messages and spawn signals through the same entry point.

| Signal | Presentation |
| --- | --- |
| `run.started` | Cancel idle life, clear carried mug, resume the desk; block new idle actions until the next work snapshot/run end |
| `run.succeeded` | Registered seated fist pump and ✓ |
| `run.failed` | Registered facepalm and ! |
| `activity` + canonical `activity` | Desk pose for researching/writing/calling/thinking/working |
| `tool.kind` + `toolKind` | search/web/browser/file-read/memory → seated book; file-write → typing; message → seated phone; exec/image/other → working |
| `waiting-on-human` | Tap/… |
| `message.inbound` | Notice/✉ |
| `subagent.spawn` + optional partner id | Existing delegation cue/meeting |

`ACTIVITIES`, `REACTIONS` and `SIGNALS` are data registries in `life.js`. Held frames, rest frames, carry, sip cadence, duration, landmark, weight and conditions are entries. Adding another held interaction uses a registry entry and registered assets. Pose resolution uses frame anchors, never offsets by character name. Future looks must supply the body/accessory anchor data checked by the manifest registration gate.

One shared life clock serves all mounted scenes. Activity, sip and reaction deadlines are stored as data; they add no occupant timers. A shared reservation caps idle wanderers at three by default (social partners count too), including the return walk, and frees them on arrival/removal/destroy. `life.maxWanderers` can lower that cap for QA. Pathfinding and landmark choices run only on scheduler ticks with a free reservation; the frame loop advances existing paths. The 12-occupant browser test checks the cap, busy preemption, neutral signal mappings, history deduplication, zero life timers and cleanup across a replacement scene.

## Idle surprises (office-dev-26b)

`surprises.js` declares `EGGS`: plant hide, gym and outdoor smoke break. Each entry supplies weight, landmark/room, entry motion, pose sequence, loops, FX, duration and weather conditions. `SURPRISES` defaults to 15 minutes continuously idle, a 20-minute per-agent cooldown, and a 3.5% roll per eligible life check. The bounded history survives occupant removal/rejoin and excludes consecutive repeats. `OfficeScene` options `surprises` override timings for QA. Canonical idle eligibility and all neutral work preemption use the same `SIGNALS` registry as office life; no adapter-specific fields are read.

`scene.surprise(id, kind, {weather:'clear'|'rain'})` forces the timing roll but retains idle, work, room visibility, landmark and global reservation guards. One egg lease covers all main/annex scenes, including room loading and return walking. Eggs share the three-wanderer reservation with regular life. The lazy controller stores one next deadline; room loops use that same shared clock. It creates no actor timers. Cleanup restores office visibility, removes foliage/arrows/rooms and releases reservations on return, removal, layout change, hidden/frozen scenes, editing and destroy. Work during a room visit triggers the reverse transition before the desk return.

`rooms.js` is a lazy registry: artwork bundle, edge/arrow, canvas, contact points, window polygons, optional shelter/lamp/puddle and rain probability. Its `load` function imports `break-room.js + buildQuery`; CSS loads with the same release query. Hosts share artwork, camera, theme and bounded particles when multiple actors use one room; removing one actor preserves its peers. Theme comes from the office's resolved local-time day/night, including forced Jour/Nuit. Weather defaults to a 25% rain roll on entry and can be forced in QA. Reduced motion crossfades, holds the first lifting frame and leaves rain/FX static. Props and gripping hands are baked into registered WebPs; only sweat, smoke, ember, ground drop and rain are CSS effects.

The local « Animations surprises » setting appears in the Bureau theme controls and Personnaliser. It defaults on, persists across reloads, and cancels active eggs when disabled. Roster badges consume decorative `office-surprise` events without changing engine state. `bureau-dev.html?life=1&tick=600000&weather=rain` exposes all three entries; `window.officeLife.theme` and `.weather` force variants. The 1440/360 sequence recorder is `design/reports/office-dev-26b/capture.cjs`; the 3× head/hand atlas and registration gate cover all eight looks and five accessories. A future look supplies the same per-frame body, hand, hip, FX and accessory anchor data, with no scheduler offsets by look.
