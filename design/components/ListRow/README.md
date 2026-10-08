# ListRow

Rows display collections: `bu-table` for desktop data tables, `bu-row` for mobile and short lists, `bu-roster` for agents, `bu-event` for the live journal, and `bu-kv` for key/value details.

## Data table: `bu-table`
- **Columns:** set them once on the container: `style="--cols: 8.5rem minmax(0,1fr) 9rem 6rem 7.5rem"`. The head and rows use `subgrid`, so columns always align. This replaces the hard-coded `grid-template-columns` repeated on every row.
- **Rows:** a clickable row is a `<button>` or `<a class="bu-table__row">` with a hover plate. Rows are 48px minimum.
- **Cells:**
  - `bu-cell-main` holds the title plus a mono sub-line;
  - `bu-cell-num` is mono with tabular figures, right-aligned with `bu-cell-end`.
- **Sortable headers:** use `bu-table__sort` with `aria-sort`.
- **Mobile:** below 820px, render the same data as a `bu-list` of `bu-row`, with no horizontal scroll.

## Other rows
- **`bu-roster`:** agent avatar with a state ring, name and role, then the state badge. Selection uses `aria-current`.
- **`bu-event`:** time (mono), actor (with a state dot), past-tense text: *a terminé*, *a été délégué par*. The actor's name stays `text-primary`; only the dot is coloured.
- **`bu-kv`:** a `<dl>`. Add `dd.is-warning` for missing dependencies.

## Tokens
`surface`, `surface-raised` (head), `surface-hover`, `surface-selected`, `border-subtle`, `size-control-lg`, type `label`, `mono-sm`, `body`.
