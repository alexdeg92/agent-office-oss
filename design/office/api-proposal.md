# Office contract proposals for API 2.1 (office-dev → architect)

> **Status:** merged into api.md 2.1 (architect-05a): OccupantVM `ruleId` and `destination`; LayoutVM `layout.updatedBy`, `theme.season`, `default`, `revisions` and `agentsSeen`. The authoritative shapes are now `docs/architecture/examples/{office-vm,layout-vm}.json`. **Open:** `layout.data` / `default.data` should be listed as opaque in the examples README, like `manifest`: items are a floor | wall union that the checker's first-element rule can't express. `layout.schema.json` plus `layout-rules.js` govern them.

Answers review R3-08 and R3-14 … R3-18 on top of **contract 2.0** (api.md §3.2, §3.10, §3.13, §5.5; data-model §4, §12). Architect owns api.md and data-model.md; this file is the input for 2.1. Everything below is already implemented client-side against `public/v2/office/mock-store.js`, and covered by `test/office/`.

**Principle:** one implementation of every office rule. `public/v2/office/layout-rules.js` is a pure ES module with no DOM. The server loads it with `require(esm)` (Node 24) and uses it for PUT validation and for OccupantVM resolution. The editor uses the same file for live preview. Nothing is re-implemented on either side.

## 1. Manifest v2 encoding (R3-08)

`LayoutVM.manifest` is exactly the output of `design/office/build-manifest.mjs`: `manifest.schema.json`, with `version: 2`. The fields that encode the approved art contract:

| Need | Field | Rule |
| --- | --- | --- |
| Gear-free bodies | `characters[].variants[].gearFree: true` | Copied from anchors.json. |
| Default gear | `variants[].defaultAccessories: string[]` | **Precedence (resolved once, server-side):** `rule.accessories` if present, where an explicit `[]` means none → `variant.defaultAccessories` → `[]`. OccupantVM `look.accessories` is final; the renderer adds nothing. |
| Two-layer accessories | `accessories[].layers["<character>" \| "<character>/<variant>"][pose] = {back?, front?}` | Draw order: back layers (slot order) → body → front layers (slot order). The variant key wins over the character key. |
| v1 overlays | `accessories[].images[character][pose]` + `legacy: true` | Deprecated (`runtime:false` in anchors). A renderer may draw them as a front layer only where no v2 layer exists, and may hide them. |
| Head landmarks | `characters[].landmarks[pose]`, `variants[].landmarks[pose]` | `{headCentre, headBox{x,y,w,h}, tilt, earLeft, earRight, eyeLine{a,b}, neck, chest}` in image px, normalised from anchors.json `headLandmarks` (`public/v2/office/landmarks.js`). Used for marker placement and the debug overlay. |
| Frame loops | pose entry `{frames: [...], frameMs}` | `working-ne` = 3 frames × 350 ms. Under reduced motion, frame 1 only. |
| Seat anchors | pose entry `{image \| frames, seatAnchor}` | Seated poses are placed hip-on-seat: `poseTopLeft = seatPoint − pose.seatAnchor`. |
| Facing | pose names (`*-ne` / `*-sw`) | **NE is a pose family chosen inside a station, not a station orientation.** `station.facing` stays the standing (v1) facing. |
| Seated stations | `furniture[].station.seated {seat, facing, seatFrom:'chair' \| seatPoint, stack, parts}` | Desk: copied from anchors.json `stationRegistration['desk-ne']` (chair@ne at tile offset (0.5625, 0.7708), keyboard with `offsetByCharacter`). Stack: desk → monitor → keyboard → chair → character. Sofa: `seatPoint` = the first `seatAnchors` entry of sofa.png. |
| v1 interim | everything above is optional | A look without `working-ne` + `seated-turn-sw` uses the standing seat/stack. That makes the interim a manifest fact, not a renderer branch. |

**Variant-key construction (R3-17 part):** furniture image key = `"<orientation>@<suffix>"` for each suffix in `theme.furnitureVariants` in order, then `"<orientation>"`, then `furniture.image`. Example: night tries `sw@night`, then `sw@on`.

## 2. Identity, resolution and inventory (R3-14)

- **Rule identity = `OccupantId`, verbatim** (`main`, `subagent:<subjectId>`, `cron:<id>`, `dm:<id>`, `channel:<id>`). Default rules are `*subagent`, `*cron`, `*dm` and `*channel`. The layout schema now enforces the pattern. `match.kind` is optional and redundant; when present it must equal the role in `agentId`.
- **Matching:** exact `agentId === occupant.id` → `*<role>` → `*subagent`. `main` has no fallback rule; the validator requires one.
- **Variant rotation:** a default rule rotates through `character.variants` starting at `rule.variant`, by order of appearance among the occupants that rule styles, in roster order.
- **Names:** an exact rule's `name`, else the source name. Default rules must leave `name` null (validator).
- **Role text:** already in 2.0: `roleLabel = {key:'custom', params:{text}}` when the rule has `role`, else `{key:'occupantRole.<role>'}`.
- **New OccupantVM field:** `ruleId: string | null`, the `agentId` of the rule that styled the occupant. The editor opens that rule, and the roster can show "règle par défaut".
- **Inventory:** add `LayoutVM.agentsSeen: Collection<{ id: OccupantId; role: OccupantRole; name: string; lastSeenAt: Ms }>`, covering agents seen in the last 30 days, newest first, capped at 200.
  - **Persistence:** a store table `office_agents_seen(occupant_id TEXT PRIMARY KEY, role, name, last_seen_at)`. It's upserted whenever the occupant resolver sees an occupant (debounced with the OfficeVM rebuild) and pruned past 30 days at boot and daily.
  - It holds no session content, only the id, role, source name and timestamp.
  - The editor lists live occupants, then `agentsSeen`, then exact rules for ids no longer seen, then the default rules.

## 3. The shared semantic validator, eligibility and capacity (R3-16)

`validateLayout(data, manifestIndex) → {code, message, uid?, agentId?}[]` in `layout-rules.js`, with an empty array meaning valid. PUT returns 400 `validation_failed` with `details[] = {issue: code, field: 'items.<uid>' | 'agents.<agentId>'}`. The shipped default passes; that's tested.

| Issue | Rule |
| --- | --- |
| `unknown-room`, `manifest-version` | The room exists; `manifestVersion` ≤ the server's manifest version. |
| `too-many` | At most 40 items. |
| `uid`, `duplicate-uid` | Item uids match the pattern and are unique. |
| `unknown-asset`, `placement-kind` | The asset exists; wall assets use `wall/offset`, floor and decal assets use `x/y`. |
| `orientation` | The orientation is in the asset's `orientations` (SW-only art rejects `se`). |
| `wrong-wall`, `outside`, `occupied` | A wall item goes on its painted wall, inside the wall, with no overlap on that wall. Floor footprints and station `blocks` stay inside the room and don't overlap (rugs excepted). |
| `unreachable` | Every station's seat tile (the seated seat when present) is reachable from `room.entrance` (4-neighbour A*). |
| `no-desk` | At least one desk. |
| `agent-id`, `duplicate-agent`, `match` | Rule ids are valid and unique, and `match` is consistent. |
| `unknown-character`, `unknown-variant` | Known look ids. |
| `default-station`, `default-name` | Default rules use `station: 'auto'` (or omit it) and no name. |
| `missing-station`, `station-kind`, `station-taken` | An explicit station exists, is a home kind, and isn't fixed by another rule. |
| `unknown-accessory`, `slot-conflict`, `accessories` | Known ids, one per slot, at most 5. |
| `name-too-long`, `role-too-long` | 24 and 32 characters. |
| `no-main`, `no-default` | Rules for `main` and `*subagent` exist. |
| `theme`, `theme-time` | `fixed` requires a day/night theme id. Auto times are `HH:MM` and differ. `season` is null or a season theme. |

- **Home stations and capacity (T-0158):** only desks are work homes. Explicit desk assignments resolve before automatic placement, which takes desks in layout item order. Lounge seats remain activity destinations; legacy saved lounge homes migrate to desks. When desks run out, `stationUid: null` (overflow). Capacity equals the number of desks.
- **Overflow (`stationUid: null`):** the scene places the occupant in a decorative standing area, on the free walkable tiles nearest the entrance, one per occupant in roster order. Nothing else changes: the occupant stays in the roster and keeps its state.
- **Schema fixes, done:** the `agentId` pattern; `match.kind` required when `match` is present; `fixed` required when `mode: 'fixed'`; descriptions of the omitted-vs-`[]` accessories and of `auto` stations. Semantic checks that JSON Schema can't express stay in the validator: uid uniqueness, wall side, and orientation per asset.

## 4. Theme ownership (R3-17, final)

- **One owner:** `layout.data.theme` (`mode`, `fixed`, `day`, `night`, `nightFrom`, `nightTo`, `season`). There's no office theme in `UiPrefs`, as in 2.0.
- **The quick toggle** (stage menu Automatique / Jour / Nuit, outside the editor): `PUT /api/v2/office/layout/theme {expectedRevision, theme}`.
  - It's the same write path, but only the theme is replaced; it creates a revision.
  - On 409, the client re-applies its choice to `error.current.vm` and resubmits once. A toggle is idempotent, so this is safe.
- **Resolution:** the server resolves with the America/Toronto clock. The night window `[nightFrom, nightTo)` may wrap midnight. `LayoutVM.theme = {resolved, mode, nextChangeAt, season}`.
  - The server pushes the `layout` topic at `nextChangeAt`.
  - The renderer uses `theme.resolved` and never reads the clock; the standalone demo does, through `theme.js`.
- **Seasons:** a season theme has `base: 'day' | 'night'` semantics at render time. The resolved day/night theme supplies the shell, light and furniture variants; the season adds `extras` on top. The layout never changes.

## 5. Save, overwrite, reset and revisions (R3-18)

| Route | Body | Result |
| --- | --- | --- |
| `GET /api/v2/office/layout` | — | `LayoutVM` + **`default: {data}`** (the shipped `layout.example.json`), **`revisions: Collection<{revision, updatedAt, updatedBy}>`** (newest first, at most 20) and `agentsSeen` (§2) |
| `GET /api/v2/office/layout/revisions/:rev` | — | `{revision, updatedAt, updatedBy, data}`; 404 once the revision is past retention |
| `PUT /api/v2/office/layout` | `{expectedRevision, data}` | `CommandResult` (`revision`, `vm: LayoutVM`) |
| `PUT /api/v2/office/layout/theme` | `{expectedRevision, theme}` | `CommandResult` (§4) |

- **Retention:** 20 revisions (storage.md). editor.md now says 20 too.
- **Conflict:** 409 with `error.current = {revision, vm: LayoutVM}`, as in 2.0.
  - **Recharger** adopts `current.vm` without another request.
  - **Écraser** resubmits the draft with `expectedRevision = current.revision`. If a third writer gets in between, the 409 simply shows again.
- **Reset:** the client loads `LayoutVM.default.data` into the draft, which is undoable, then saves through the normal PUT. There's no dedicated reset route, so there's one write path and one validator.
- **Restore a version:** "Versions" lists `revisions`; *Charger* fetches `/revisions/:rev` into the draft, then saves through the normal PUT. Undo/redo is session-local in the editor; the durable history is the revision list.
- `updatedBy` is the `ActorRef` the store already records. The editor shows `updatedBy.name` in the conflict modal.

## 6. Destinations and delegation partners (R3-15)

> **Status (office-dev-04):** the renderer implements `destination` and the `partnerId` meeting scene. The meeting spots are hand-tuned in build-manifest (`station.seats`) until the artist registers them. `destination` stays null server-side until the engine has tool kinds (activity is run-state only on 2026.9.8).

- **Client-side and decorative:** everything here is animation only. It never changes a field, and it's cancelled as soon as the input changes.
  - **Lounge after 10 minutes idle:** computed from `stateSince`. A free lounge is reserved in roster order, and the occupant returns home on any state change.
  - **Idle swivel** toward the camera every 25–50 s, held 3.5 s.
  - **Selection swivel and wave:** 1.8 s.
  - **Standing area** on overflow.
- **Server-authoritative, proposed for when the data exists:**
  - **`OccupantVM.destination: { kind: 'server' | 'meeting'; stationUid: string } | null`.** For example, the server rack while an `exec`-class tool runs.
    - Today activity is derived from run state only (architect-03 §2), so this stays `null`; the renderer already walks to any `stationUid` it gets.
    - Reservation is the server's: at most one occupant per destination seat, and others stay home.
  - **Cue frame:** `{ type:'cue', occupantId, cue, at, partnerId?: OccupantId, interactionId?: string }`.
    - For `delegating`, `partnerId` is the new sub-agent. The renderer seats both at the meeting table for 1.5 s, then the partner walks to its `stationUid`.
    - Without `partnerId`, today's behaviour applies (the delegator plays its talking pose).
    - A second cue with the same `interactionId` is ignored.
  - **Meeting seats:** the manifest gains `station.seats: gridPoint[]` for the meeting table (two seats facing each other). It isn't in the art yet, so the meeting choreography stays pending until the artist registers the seats.

## 7. Open points for the PM

1. **Quick theme toggle conflicts:** auto-retry once (proposed), or surface the editor's conflict modal?
2. **`agentsSeen` cap:** I proposed 200. Fine?
3. **Overflow:** a decorative standing area (implemented). Alternatively, overflow occupants could be hidden from the scene and shown only in the roster.
4. **api.md 2.0 example:** the LayoutVM JSON example uses `"room": "room-main"`; the manifest's room id is `bureau`.
