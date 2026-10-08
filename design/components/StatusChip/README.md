# StatusChip

Status chips label the state of something in a few words: `bu-state` for the 9 agent states, `bu-chip` for generic statuses, `bu-live` for the connection, `bu-tag` and `bu-count` for read-only metadata.

## Agent-state badge: `bu-state[data-agent-state]`
The nine states are a contract shared with the office animation.

| state | label | icon | office pose |
| --- | --- | --- | --- |
| idle | Inactif | pause | idle |
| thinking | Réfléchit | sparkle | thinking |
| working | Exécute | zap | working at desk |
| researching | Recherche | search | working at desk + reading prop |
| writing | Rédige | pen | working at desk (typing) |
| calling | Appel d'outil | plug | talking |
| waiting | En attente | hourglass | idle + waiting marker |
| error | Erreur | alert | error/alert |
| offline | Hors ligne | moon | sleeping |

- **Never colour alone:** every badge has an icon **and** a label. A bare `bu-dot[data-agent-state]` is only allowed next to a visible label, or with a `title` in dense rows.
- **Shared mapping:** `[data-agent-state]` sets `--_st` / `--_st-bg`, so a dot, an avatar ring and a badge all use the same mapping.
- **Live:** add `bu-state--live` to pulse the icon. Only do this while a run is actually active.

## Generic status: `bu-chip--success|warning|danger|info|accent`
Use these for task, skill and run states (*Active*, *Indisponible*, *Échec*, *Planifiée*). The default chip is neutral (*Désactivée*). Chip text is a short adjective or past participle and always carries an icon.

## Connection: `bu-live`
| class | label |
| --- | --- |
| `bu-live` | *En direct* |
| `bu-live--stale` | *Données de 14:22* (data older than 60 s) |
| `bu-live--off` | *Reconnexion…* |

## Metadata
- `bu-tag`: mono, radius-xs, read-only (model, channel).
- `bu-count`: numbers in nav and filters.
- Pill-shaped = status, square = metadata. Keep that distinction.

## Tokens
`state-*`, `state-*-bg`, `success|warning|danger|info` + `-bg`/`-border`, `accent-subtle`, `radius-pill`, `radius-xs`.
