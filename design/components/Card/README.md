# Card

Cards group one object or one section on a `surface`, with a hairline border and `radius-card`.

## Variants
- `bu-card`: a section container, with a `bu-eyebrow` title and content.
- `bu-card--interactive`: the whole card is a link or button (task, skill). On hover the border goes to `border-strong` and the shadow to `shadow-2`. There's no lift or scale.
- `bu-card--selected` / `[aria-current="true"]`: an indigo-tinted selection.
- `bu-card--flush`: no padding, for tables and media.
- `bu-detail-header`: the header of a detail page, with a large icon tile, title, status chip, description and meta line.

## Anatomy of an object card
1. Header: dot, title, status chip.
2. Description, clamped to 2 lines.
3. Footer: mono metadata, then *Ouvrir →*.

## Don'ts
- No coloured left-border accent cards.
- No gradients.
- No nesting cards more than one level deep. Inside a card, use `bu-stat--compact` or `bu-kv`.

## Tokens
`surface`, `border-subtle`, `border-strong`, `shadow-1`, `shadow-2`, `radius-card`, `space-4`, `surface-selected`, `accent-border`.
