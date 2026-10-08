# Form

Form controls collect input: a `bu-field` wraps a visible label, one control, and an optional hint or error.

## Anatomy
`bu-field` → `bu-field__label` (sentence case, never only a placeholder) → `bu-input` / `bu-select` / `bu-textarea` → `bu-field__hint` or `bu-field__error`.

## Controls
- **Text input** `bu-input`: 40px high; `--sm` (32px) in toolbars. For search, wrap it in `bu-input-group` with a leading icon.
- **Textarea** `bu-textarea`: add `--mono` for cron instructions, prompts and JSON.
- **Select** `bu-select`: native, with a token-drawn chevron.
- **Checkbox** `bu-check` and **switch** `bu-switch` (`role="switch"`). Use a switch only when the change applies immediately; for example, the skill toggle runs `openclaw config set`.

## Rules
- **Borders:** controls use `border-control`, which is 3:1 against `bg-sunken` and `surface`.
- **Focus:** every control keeps the `focus-ring` outline. Never write `outline:none` (the current app does this on every input).
- **Errors:**
  - set `aria-invalid="true"`;
  - link the error with `aria-describedby`;
  - write it in French, cause first: *L'instruction est requise.*
- **Required fields:** mark them with a red `*` (`bu-field__req`) and the `required` attribute.
- **Placeholders:** give examples (*ex. Veille prix concurrent*), never the label.
- **Login:** don't pre-fill an email address.

## Tokens
`bg-sunken`, `border-control`, `focus-ring`, `danger`, `accent`, `radius-control`, `size-control`, type `label`, `body`, `mono`, `caption`.
