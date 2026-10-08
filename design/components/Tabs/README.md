# Tabs

Tabs switch views of one object: `bu-tabs` for panels, `bu-segmented` for a 2–4 option view toggle or filter, `bu-filter` for a vertical filter list with counts.

## When to use each
- **`bu-tabs`:** switches between different content panels of the same object, e.g. the Bureau aside (*Activité · Agent · File · Santé*). Use `role="tablist"`/`tab` and `aria-selected`. The active tab is shown by `text-primary` and a 2px `accent` underline.
- **`bu-segmented`:** shows the same data differently (*Arbre / Chronologie*, *Grille / Tableau*) or filters it (*Tous / Utilisateurs / Canaux*). Use `aria-pressed`. This replaces the three different toggle styles in the current app.
- **`bu-filter`:** the Compétences aside (*Catégorie*, *Statut*, *Portée*), with counts. Use `aria-current="true"`. On mobile it collapses above the list.

## Tokens
`accent`, `surface-raised`, `surface-selected`, `bg-sunken`, `border-default`, `radius-control`, type `heading-sm`, `label`.
