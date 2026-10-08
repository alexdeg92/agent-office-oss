# Kanban

The Projets board shows every project as a card in one of five ordered status columns: **Idée → À faire → En cours → En revue → Livré**. Owner moves projects between them by drag and drop.

## Columns
| key (`data-project-status`) | label | colour source |
| --- | --- | --- |
| `idea` | Idée | `state-idle` |
| `todo` | À faire | `info` |
| `in-progress` | En cours | `accent-text` |
| `in-review` | En revue | `state-thinking` |
| `shipped` | Livré | `success` |

- **Bloqué is not a column.** It's a `risk` flag (see LabelChip) that can appear on a card in any column.
- **Card order within a column:** priority (P0 → P3), then `lastActivityAt` (most recent first). Because order is computed, a drop only changes the **status**, not the position within the column. The drop slot appears where the card will land by that order.

## Anatomy
- `bu-board`: horizontal scroll, snap.
- `bu-column`: `size-kanban-column` wide, on `bg-sunken`. The head shows a status dot, label, count and an add button.
- `bu-column__list` is a `<ul>` of `bu-pcard`.
- Toolbar: title, search, a segmented filter (*Tous / À risque / Avec Timmy*), *Nouveau projet*.

## Drag and drop
| state | class | look |
| --- | --- | --- |
| card at rest | `[draggable="true"]` | grab cursor |
| card being dragged | `.is-dragging` | `shadow-3` + `accent-border`; no rotation or scale |
| card's original spot | `.is-ghost` | 40% opacity |
| column under the pointer | `.is-drop-target` | `accent-border` + `surface-selected` |
| landing position | `.bu-drop-slot` | dashed accent slot |
| keyboard-picked card | `.is-picked` | focus ring |

- **Keyboard (required):**
  - Focus a card, then press **Espace** to pick it up.
  - **←/→** changes the column; **Espace** drops; **Échap** cancels.
  - Every step is announced in an `aria-live="assertive"` region (*« … saisi. Colonne À faire. »*).
- **Touch:** long-press (400 ms) picks up the card; the board auto-scrolls at the edges.
- **Fallback:** every card also has a status menu (*Déplacer vers…*) on the detail page.
- **Recording:** a successful drop writes a `history` event (`kind: status`, `actor: Owner`) and shows the toast *Projet déplacé vers En revue* with an *Annuler* action.
- **Timmy's moves** (via the API later) animate the card into its new column (`duration-base`). The history records Timmy as the actor.
- **Reduced motion:** no position animation; the card appears in place.

## Mobile
Columns are `100vw − 48px` wide and snap one at a time. Drag works by long-press. The detail page's status menu remains the primary way to move a project.

## Tokens
`bg-sunken`, `border-subtle`, `accent-border`, `accent-subtle`, `surface-selected`, `shadow-3`, `focus-ring`, `size-kanban-column`, `radius-panel`, `state-*`, `info`, `success`.
