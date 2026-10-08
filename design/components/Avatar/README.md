# Avatar

Avatars identify who acts, whether a human, an agent or a git author, in a circle (an `--xl` avatar is a rounded square).

## Kinds
| class | who | fallback |
| --- | --- | --- |
| `bu-avatar--agent` | Timmy and sub-agents | `bot` icon on `accent-subtle` until the character portrait exists |
| `bu-avatar--human` | Discord users, Owner | initials (max 2), or the Discord avatar image |
| `bu-avatar--git` | git commit authors not matched to a person | mono initials, dashed border |
| `bu-avatar--human` with `hash` | Discord channel | — |

**Portraits:** agents use `assets/Characters/<character>/portrait.png` (see `design/office/manifest.schema.json`), set as `background-image` with the icon removed. Sub-agents inherit Timmy's base portrait plus their colour variant.

## Sizes
`--sm` 24 · default 32 · `--lg` 40 · `--xl` 56.

## State
- `[data-agent-state]` on an agent avatar draws a 2px ring in the state colour, offset by the surface colour.
- `bu-avatar__badge` is a corner dot for dense lists.
- Both are always paired with the state label somewhere in the same row.

## Tokens
`accent-subtle`, `accent-text`, `surface-raised`, `border-default`, `border-strong`, `state-*`, `radius-pill`, `radius-card`.
