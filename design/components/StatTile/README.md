# StatTile

Stat tiles show one number or state with its label: an inline `bu-kpis` strip for page headers, `bu-stat` tiles for grids.

## Variants
- **`bu-kpis` / `bu-kpi`:** the inline strip in the Bureau header, with dividers. On mobile it scrolls horizontally. There's one sub-text per value.
- **`bu-stat`:** a tile for Santé système. It holds a label, a value (`title-lg`, tabular figures), an optional `bu-meter`, and a sub-line.
- **`bu-stat--compact`:** policy tiles on Habilitations, and tiles nested inside cards.
- **Status:**
  - `--success`, `--warning` and `--danger` colour the label icon and the meter;
  - warning and danger also tint the border.
  - **The value itself stays `text-primary`.** Status is carried by the icon and the label, never by a coloured number. The server currently sends `c.color`; phase 2 should send a status key instead.

## Content
- Use French number formatting with a space as the thousands separator and a comma as the decimal separator: `184 302`, `1,84`, `23 %`.
- Durations are spelled out, e.g. `4 min 12 s`.

## Tokens
type `label` and `title-lg`, `surface`, `surface-raised`, `border-subtle`, `warning-border`, `danger-border`, `accent` (meter), `radius-card`.
