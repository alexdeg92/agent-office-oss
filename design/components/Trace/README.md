# Trace

Traces show how Timmy handled an exchange: a **tree** of turns and tool calls, a **waterfall** timeline, and a **run history** for scheduled tasks.

## Tree: `bu-trace`
- **Node:** each node has an avatar, a head (who, time, meta) and a body.
  - Human messages use `--human` (raised background).
  - Agent turns use a plain surface.
  - There's no coloured left border; identity comes from the avatar and the name.
- **Tool calls:** listed under the turn in `bu-trace__tools`, linked by a hairline connector. Each call is a `<details class="bu-tool">` with:
  - a tool icon (Bureau line icons, mapped by tool family: search, fetch, exec, file, memory, message);
  - the name in mono;
  - an ok/erreur chip and the duration.
  - Expanding it shows *Entrée* / *Résultat* as `bu-code`.
  - Failed calls add `bu-tool--error`.

## Waterfall: `bu-waterfall`
- **Layout:** three columns (label, track, duration). Bars are positioned with `--start` and `--len` in %.
- **Kinds:** human (neutral), agent (accent), tool (`state-working`), error (striped danger). The stripe means errors don't rely on hue alone.

## Run history: `bu-run`
A `<details>` with a status chip, date, duration and tokens. The body holds a facts line and a summary block. Only the most recent run is open by default.

## Tokens
`surface`, `surface-raised`, `border-strong`, `bg-sunken`, `accent`, `state-working`, `danger`, `danger-border`, type `mono-sm`, `heading-sm`.
