# Nav

The app shell navigation: a desktop sidebar and top bar, and on mobile (under 820px) a compact top bar and a 5-item bottom bar.

## Desktop
- **`bu-shell`:** a grid of `size-sidebar` (248px) plus the main column.
- **`bu-sidebar`:**
  - the brand mark and the name *Agent Office*;
  - `bu-nav` items (icon + label);
  - the user card pinned to the bottom.
  - The active item uses `aria-current="page"`, which gives it the `surface-selected` plate and an `accent-text` icon. There's no left border bar.
- **`bu-topbar`:** the page title (Sora), the page question (caption), `bu-live`, and the clock (mono, tabular figures).

## Mobile
- **`bu-mtopbar`:** mark, title and live pill. It respects `safe-area-inset-top`.
- **`bu-bottombar`:** 5 slots, each with a 24px icon and an 11px label, 64px tall plus the safe area. The active slot gets `accent-text` **and** a 2px top indicator, so it isn't shown by colour alone.
  Proposed slots: *Bureau · Discuter · Projets · Journaux · Plus*. *Flux de travail* moves into *Plus*, together with *Habilitations*, *Compétences* and *Santé système* (see the open question in the README).
- **`bu-morelist`:** the *Plus* page, with full-width 48px rows.

## Page order (sidebar)
Bureau · Discuter · Flux de travail · Projets · Habilitations · Journaux · Compétences · Santé système.

## Rules
- Navigation icons come from the Bureau line set. No emoji.
- The viewport meta must not include `maximum-scale=1`.

## Tokens
`size-sidebar`, `size-topbar`, `size-bottombar`, `surface`, `surface-selected`, `accent-text`, `accent`, `border-subtle`, `z-nav`.
