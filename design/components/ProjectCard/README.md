# ProjectCard

A project card summarises one project on the board: repo image, priority, name, flags, the people involved, and the last activity.

## Anatomy (top to bottom)
1. **`bu-thumb`:** a 16:9 repo image, capped at `size-repo-thumb`, with the `owner/repo` overlay in mono (hidden when there is no repo). The image source falls back in this order:
   1. the GitHub OpenGraph image (`--img`);
   2. a screenshot of the deployed site (`--img`);
   3. a **generated cover**: `bu-thumb--generated` shows the project initials in Sora on a `label-*` tint, the colour hashed from the project id, with an inset frame. No gradients or random photos.
2. **Top line:** the `bu-priority` badge (P0–P3) and the name (`heading-sm`, 2 lines max).
3. **`bu-labels`:** flags in kind order: **risk → priority-related → feature → label**. Show at most 3 and collapse the rest into `+N`. Risk flags always show, even past the limit.
4. **Footer:** `bu-avatar-stack` (max 4 + `+N`) and the relative `lastActivityAt` (*il y a 3 min*, *hier*).

- **Status:** not repeated on the card, because the column carries it. In search results outside the board, add `bu-pstatus`.
- **Interaction:** the whole card is one link (`<a class="bu-pcard">`) and is draggable (see Kanban for the states). Hover uses `border-strong` + `shadow-2`.

## Fields
`id, name, status, priority, flags[{kind, key, label, severity?}], repo{url, image}, people[], lastActivityAt`.

## Tokens
`surface`, `border-subtle`, `border-strong`, `shadow-1`, `shadow-2`, `radius-card`, `radius-control`, `size-repo-thumb`, `label-*` (generated cover).
