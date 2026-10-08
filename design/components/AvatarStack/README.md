# AvatarStack

An avatar stack shows who is involved in a project in a small space: overlapping avatars with a `+N` overflow.

## Rules
- **Order:** humans, then agents (Timmy first, then sub-agents), then git authors. Show at most 4 and then `bu-avatar-stack__more` (*+2*, with a `title` listing the rest).
- **Discs, not chips:** every avatar is a full circle with a solid background (an initials tile on `surface-raised`, or the agent portrait clipped to the circle) and a 2px ring in the colour behind the stack (`--_ring`: `surface` on cards, `bg` on the project header), so the overlap reads as stacked discs.
- **Overlap:** later avatars sit on top; each overlaps the previous by 4px on 32px discs and 3px on 28px card discs (`bu-avatar-stack--sm`), about 11–13 % of the diameter, so the previous disc's initials stay fully visible (checked by `test/frontend/browser.test.js`, which measures the glyphs).
- **`+N`:** a disc of the same size and ring (`bu-avatar-stack__more`).
- **Active agents** keep their state ring (`data-agent-state`), drawn as an inner ring over the portrait so it never widens the disc.
- **Accessibility:** the `<ul>` gets `aria-label="Personnes impliquées"`. Each avatar has a `title` with the name and role (*Timmy · agent principal*).
- **Sizes:** `bu-avatar-stack--sm` (28px discs) on cards, default (32px) on the project header, in Personnes impliquées and on the Bureau roster.

## Data
`people[{kind: human|agent|git, name, avatar, role}]`. Use `kind` to pick the avatar class (`--human`, `--agent`, `--git`).

## Tokens
`surface` (ring), `surface-raised`, `border-default`, `text-secondary`, `radius-pill`.
