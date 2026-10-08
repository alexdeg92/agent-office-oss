# HistoryTimeline

The history timeline, titled *Historique*, records every event on a project, newest first. Every entry names its actor, including the status moves made by Owner (drag and drop) and by Timmy (API).

## Event kinds (`history[].kind`)
| kind | class | icon | sentence pattern |
| --- | --- | --- | --- |
| status | `--status` | arrow-right | ***Owner** a déplacé le projet : **À faire** → **En cours**.* |
| commit | `--commit` | commit | ***Owner** a poussé 2 commits sur **main**.* |
| flow run | `--flow` | flux | *Flux **…** exécuté par **Timmy** : réussi en 2 min 08 s.* |
| session | `--session` | discuter | *Session **#projets** avec **Guest** : 14 messages, 22 104 jetons.* |
| cron run | `--cron` | clock | *Tâche planifiée **…** : échec après 45 s.* |
| risk raised/cleared | `--risk` | alert | *Risque levé : **CI rouge**.* / *Risque résolu : …* |
| flag (manual) | `--flag` | flag | ***Owner** a ajouté l'étiquette **client**.* |
| agent action | `--agent` | bot | ***Timmy** a délégué … à **Scout**.* |

- **Sentences:** the actor comes first and names are bold. Verbs are in the past tense; run outcomes say *réussi* or *échec* plus the duration.
- **Times:** relative within 48 h, then a short date. `<time datetime>` carries the ISO value.
- **Grouping:** consecutive commits by the same author collapse into one entry, and so do repeated cron runs with the same outcome (*3 exécutions réussies*).
- **Paging:** 20 entries, then *Afficher plus*. Phase 2 can add a segmented filter by kind.
- **Unknown kinds:** neutral style with the raw `text`. Phase 3's classifier should make this impossible.

## Data
`history[{at, kind, text, actor}]`.

## Tokens
`surface-raised`, `border-default` (rail), `accent-text`, `state-working`, `state-thinking`, `info`, `danger`/`-bg`/`-border`, `warning`, type `body`, `mono-sm`.
