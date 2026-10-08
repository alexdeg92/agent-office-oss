# ProjectHeader

The project header opens the detail page: repo image, status, priority, flags, title, people and last activity, with the main actions.

## Anatomy
- **Grid:** the `bu-thumb` (max 18rem; same fallback chain as the card: OpenGraph, then site screenshot, then generated cover) and the body. On mobile the image stacks on top, full width.
- **Body:**
  1. `bu-pstatus`, `bu-priority`, then flags in kind order (risk, feature, label);
  2. the title (`title-lg`; `title` on mobile);
  3. a meta line with the avatar stack, a people count and the last activity;
  4. actions:
     - *Déplacer vers…*: the status menu, which is the keyboard and mobile equivalent of drag and drop;
     - *Ouvrir le dépôt*;
     - *Gérer les drapeaux*.
- Above the header, `bu-backlink` *← Projets* returns to the board, keeping its scroll position and filters.

## Page layout below the header
- **Desktop:** two columns.
  - Left (wide): **Résumé**, then **Historique**.
  - Right (`size-aside`): **Dépôt** (with CI and sources), then **Personnes impliquées**, then **Drapeaux** (all flags grouped by kind, as in LabelChip).
- **Mobile:** one column: Résumé, Dépôt, Historique, Personnes, Drapeaux.

## Tokens
`radius-card`, type `title-lg`, `caption`, `space-5`.
