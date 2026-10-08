# LabelChip

Project flags come in **four kinds that must never be confused**. Each kind has its own shape, type and icon logic, so they stay distinct in greyscale too.

| kind | class | shape | type | colour | content |
| --- | --- | --- | --- | --- | --- |
| `priority` | `bu-priority--p0…p3` | small **solid square badge** | mono bold | P0 `danger-fill` (solid), P1 `warning`, P2 `info`, P3 neutral | `P0`–`P3` only; one per project |
| `risk` | `bu-risk` + `--high` / default / `--low` | **outlined pill** with an alert icon | sans | severity: high = `danger`, medium = `warning`, low = neutral | *Bloqué*, *Flow en échec*, *Cron en échec*, *CI rouge*, *Inactif depuis N j* |
| `feature` | `bu-feature` + `--on` | **dashed** square chip | **mono** | neutral; the on/off mark is a filled `success` dot or a hollow ring | the flag key as found in code/config (`projets.board`) |
| `label` | `bu-label-chip--slate…green` | tinted square chip with a dot | sans | 6 categorical `label-*` hues, hashed from the label name | free tags: *client*, *perso*, *site web* |

## Rules
- **Risk flags are automatic.** The system adds and removes them; users can't edit them, only acknowledge them in phase 2. They always come first and are never hidden by the `+N` overflow.
- **Labels never use status colours.** Risks never use `label-*` colours.
- **Severity:** `flags[].severity` maps `high` to `--high`, `medium` (or missing) to the default, and `low` to `--low`.
- **Display order everywhere:** priority, risk, feature, label.

## Project status: `bu-pstatus[data-project-status]`
A pill with an icon for *Idée*, *À faire*, *En cours*, *En revue* and *Livré*. It reuses existing tokens.

## Tokens
`danger-fill`, `danger`/`-bg`/`-border`, `warning`/`-bg`/`-border`, `info`/`-bg`/`-border`, `success`, `border-strong`, `label-*`, `label-*-bg`, `radius-xs`, `radius-pill`, type `label-sm`, `mono-sm`.
