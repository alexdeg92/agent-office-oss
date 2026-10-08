# FlowDiagram

The flow diagram shows how a scheduled task or a skill goes from its trigger to its output, in a few readable steps.

## Nodes
| kind | class | shape | label |
| --- | --- | --- | --- |
| trigger | `--trigger` | pill, `info` kind label | *Déclencheur* / *Demande / intention* |
| step | `--step` | card, auto-numbered 01, 02… | *Étape* |
| decision | `--decision` | dashed border, `warning` kind label | *Décision* |
| output | `--output` | success border | *Sortie* |

- **Kind:** carried by the uppercase label, an icon and the shape, never by a coloured left border (the current app's pattern).
- **Arrows:** `bu-flow__arrow` items are `aria-hidden`; the `<ol>` order carries the sequence for screen readers.
- **Mobile:** below 820px (or with `--vertical`) the diagram stacks and the arrows rotate.
- **Steps:** keep labels under about 48 characters and the step count at 6 or fewer, the same limits as `cronSteps`/`skillSteps` today. Add a caption saying where the steps come from.

## Tokens
`surface-raised`, `border-default`, `info`, `warning`, `success`, `success-border`, `radius-card`, `radius-pill`, type `label-sm`, `heading-sm`.
