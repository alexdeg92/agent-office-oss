# EmptyState

Every data view has a defined empty, loading, error and stale state. These classes provide them.

## States
| state | component | copy pattern |
| --- | --- | --- |
| loading, known shape | `bu-skeleton` (text line, `--title`, `--block`, `--circle`) and `aria-busy="true"` on the container | — |
| loading, unknown shape | `bu-spinner` | — |
| empty | `bu-empty` + illustration slot + one action | *Aucun …* + what to do |
| error | `bu-empty--error` + *Réessayer* | *… indisponible* + cause |
| stale | `bu-banner--warning` + `bu-live--stale` | *Les données affichées datent de 14:22.* |
| offline | `bu-banner--danger` | cause, then the code in mono |

- **Illustrations:** `bu-empty__art` takes an icon now. When the character art lands, it takes a cropped Timmy pose (for example *sleeping* for "Aucune exécution"), set as `background-image`.
- **Motion:** the skeleton shimmer and the spinner are the only idle-time loops, and they stop under reduced motion.

## Tokens
`surface-raised`, `surface-hover` (shimmer), `danger-bg`, `warning-bg`/`-border`, `danger-border`, `accent` (spinner), `radius-card`.
