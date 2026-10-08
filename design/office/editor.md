# Office customization editor: UX spec

The editor lets Owner personalise the office: what each agent looks like, where the furniture sits, the room theme, and the names and roles shown on the nameplates.

It writes a layout document (`layout.schema.json`) to the Agent Office backend. It **never** writes to `~/.openclaw`; names and roles are display-only.

All UI text is French. Components come from Bureau (`bu-*`).

## 1. Entry and modes

- **Entry:** on the Bureau page, the stage controls (`bu-stage__controls`) gain a **Personnaliser** button (`bu-btn--sm`, icon `pen`). Only the logged-in admin sees it, and today that's everyone who can log in.
- **Editing view:** the office stays in place and gets an editing frame.
  - **Top bar:** title *Personnaliser le bureau*, a segmented control (*Disposition · Personnages · Thème*), then *Annuler*, *Réinitialiser…* and **Enregistrer** (primary).
  - **Side panel** (`size-aside`, right): the controls for the current mode.
  - **Scene:** live preview. Agents keep their real states, which are paused on `idle` while in *Disposition* mode so they don't walk through the furniture being placed.
- **Unsaved changes:** a `bu-chip--warning` *Modifications non enregistrées* in the top bar. Leaving with changes opens a confirm modal: *Quitter sans enregistrer ?* with *Rester* / *Quitter*.
- **Undo and redo:** `Ctrl+Z` / `Ctrl+Maj+Z`, plus icon buttons. History is kept for the whole session.
- **Mobile (under 820px):** *Personnages* and *Thème* work as plain forms in a bottom sheet. *Disposition* is desktop only, with the message: *La disposition se modifie sur un écran plus large.*

## 2. Mode: Disposition (layout)

**Palette** (side panel):
- furniture grouped by `category`, as a `bu-filter` list (*Postes*, *Assises*, *Rangement*, *Plantes*, *Équipement*, *Mur*, *Sol*, *Déco*);
- each item is a tile with a thumbnail, its French label and its footprint (*2 × 1*);
- a search field at the top.

**Placing:**
- Drag a tile onto the scene. A **ghost footprint** follows the cursor and snaps to the grid:
  - valid tiles: `accent-subtle` fill + `accent-border`;
  - invalid tiles: a `danger` hatch, with the reason in a tooltip (*Occupé par Canapé*, *Hors de la pièce*, *Bloque l'accès au poste de Timmy*).
- Releasing on a valid spot places the item. Releasing on an invalid spot cancels.
- Wall items snap to the nearest wall slot instead.

**Selecting an item** (click, or Tab through the placed items):
- the item gets a floor ring;
- a floating mini-toolbar appears: **Tourner** (`R`), **Dupliquer** (`Ctrl+D`), **Supprimer** (`Suppr`), *Renommer* (stations only, e.g. *Poste de Scout*);
- move it with the **arrow keys** (one tile; `Maj` + arrow for 3) or by dragging.

**Constraints** (validated live; *Enregistrer* is disabled while any are broken, with the reason in the save tooltip):
- footprints can't overlap (rugs excepted) and must stay inside the room;
- every agent with a fixed `station` needs that station to exist;
- each desk's seat tile must be reachable from the room entrance (path check);
- a maximum of 40 furniture items keeps the scene readable and fast.

**Rotation:** swaps between the two painted facings (`sw`/`se`) and swaps the footprint. If an item has only one facing, *Tourner* is disabled with the tooltip *Une seule orientation disponible*.

## 3. Mode: Personnages (character looks, names and roles)

**List** (side panel): every known agent as a `bu-roster` row.
- Timmy comes first, then the agents on stage, then those seen in the last 30 days (`LayoutVM.agentsSeen`, api-proposal.md §2), then agents that still have a rule.
- A final row **Nouveaux sous-agents** defines the default rule (`agentId: "*subagent"`).

**Editing an agent** opens its card:
- **Aperçu:** a large preview of the character on a neutral stage, with a pose picker (*Inactif, Réfléchit, Exécute, Recherche, Rédige, Appel d'outil, En attente, Erreur, Hors ligne*). Every combination can be checked against every state.
- **Personnage:** a choice of base character (*Timmy*, *Sous-agent*), as large selectable cards.
- **Couleur:** variant swatches as radio buttons, each with its French name from the manifest (*Sauge*, *Ocre*, *Sarcelle* today), so colour isn't the only cue. Changing the colour resets the accessories to that colour's default gear (`defaultAccessories`). The swatch ring uses `focus-ring` when selected.
- **Accessoires:** toggle tiles grouped by slot (*Tête*: Casque d'écoute, Casquette · *Visage*: Lunettes · *Cou*: Foulard · *Badge*: Badge). Choosing a second item in an occupied slot replaces the first, and an inline hint explains it.
- **Nom affiché:** a text field, max 24 characters. Placeholder: the OpenClaw name. Hint: *Affiché sur la plaque. Ne change pas le nom dans OpenClaw.*
- **Rôle:** a text field, max 32 characters (*Agent principal*, *Recherche*, *Rédaction*).
- **Poste:** a select listing *Automatique* plus the home stations: desks, then sofas. A station fixed by another rule is listed as *(attribué)* and disabled. Focusing the field, or choosing a station, highlights it in the scene (native options can't report hover). Default rules always use *Automatique*.

**Defaults for new sub-agents:**
- character *Sous-agent*;
- variants rotate in manifest order, starting at the rule's colour (*Sarcelle* in the shipped default);
- accessories: the colour's default gear (accessories omitted in the rule);
- the name OpenClaw reports;
- role *Sous-agent*;
- station *Automatique*.

## 4. Mode: Thème (room themes)

- **Mode:** a segmented control, *Automatique* · *Jour* · *Nuit*.
  - *Automatique* reveals two time fields, *Nuit de* `19:00` *à* `07:00` (America/Toronto).
- **Saison:** a select: *Aucune* (default), *Hiver*, *Automne*, … Season themes only add decorations; the layout doesn't change.
- **Preview:** thumbnails of each theme, as selectable cards with a label.
- The office theme is independent of the interface theme (*Sombre/Clair*), and a hint says so.

## 5. Saving, reset, conflicts

- **Enregistrer:**
  - validates;
  - saves the layout document (`PUT /api/v2/office/layout {expectedRevision, data}`, api.md §5.5);
  - shows the toast *Bureau enregistré*;
  - leaves edit mode.
  - Saving creates a revision, and the last 20 are kept server-side. **Versions** lists them; *Charger* puts one in the editor (undoable), and saving restores it.
- **Réinitialiser…:** a confirm modal *Revenir au bureau par défaut ?* that loads `LayoutVM.default.data` (the shipped `layout.example.json`) into the editor. It's undoable, and nothing is saved before *Enregistrer*.
- **Conflicts:** a 409 shows *Le bureau a été modifié ailleurs.*, with who saved it.
  - *Recharger* adopts the server version carried by the 409 and discards the draft.
  - *Écraser* resubmits the draft with the revision from that 409 (api-proposal.md §5).
- **Undo:** Ctrl+Z / Ctrl+Maj+Z for the whole editing session. Durable history is the revision list.
- **Live data during editing:** states keep updating in the roster; only the scene's walking is paused.

## 6. Accessibility

- **Keyboard:** every editor action is reachable by keyboard. Placing an item from the palette:
  1. focus the palette item and press `Entrée`; a ghost appears at the room centre;
  2. move it with the arrows;
  3. press `Entrée` to place it or `Échap` to cancel.
- **Announcements** (`aria-live="polite"`): *Canapé placé en 8, 8.*, *Emplacement occupé par Tapis.*
- **Ghost validity** is shown by fill plus hatch plus tooltip, never by colour alone.
- **Reduced motion:** placement and rotation are instant.

## 7. Components used
`bu-segmented`, `bu-filter`, `bu-card--interactive` (palette, character and theme cards), `bu-roster`, `bu-field` / `bu-input` / `bu-select`, `bu-check` / `bu-switch`, `bu-btn` (primary, ghost, icon), `bu-chip--warning`, `bu-modal`, `bu-toast`, `bu-nameplate`, `bu-stage__controls`.

The new editor-only pieces are the ghost footprint, the floor ring and the item mini-toolbar. They're drawn in the scene's `fx` and `ui` layers with these tokens: `accent-subtle`, `accent-border`, `danger`, `surface-overlay`, `shadow-2`, `radius-control`.

## 8. Implementation notes (v1, `public/v2/office/editor.js`)
- Every rule comes from `layout-rules.js`, the validator the server uses: placement reasons, the save blockers listed in the panel, and the preview of names, looks and stations.
- The item toolbar's *Tourner* stays disabled while all furniture art is SW-only (*Une seule orientation disponible*).
- Clicking a palette tile starts keyboard-style placement, with the ghost at the nearest free spot to the room centre. Dragging a tile places it under the pointer.
- Wall items snap along their painted wall only.
- Accessories without art for the selected character carry a "·" mark: they're saved, but not drawn until the art exists.
