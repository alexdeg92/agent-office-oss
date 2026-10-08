# Modal

Overlays focus the user on one task: `bu-modal` for creating or editing (*Nouvelle tâche planifiée*), `bu-drawer` for inspecting without leaving the page (an agent's detail from the office).

## Structure
`bu-scrim` → `bu-modal` (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`) → `__header` (title, optional description, close button) → `__body` → `__footer` (actions on the right; primary last).

## Behaviour (phase 2 must implement; the current modal has none of it)
- Move focus to the first field on open and trap Tab inside the dialog.
- **Escape** and a click on the scrim close it, unless the form has unsaved changes.
- Lock page scroll and return focus to the trigger on close.
- **Mobile:** below 820px, modals and drawers become bottom sheets with full width and `radius-panel` on the top corners, and they respect the safe area.

## Motion
The modal rises in with `duration-slow` + `ease-enter`; the drawer slides in with `duration-base`. Both become instant under reduced motion.

## Tokens
`surface-overlay`, `scrim` (64% dark / 40% light), `shadow-3`, `radius-panel`, `z-modal`, `z-drawer`, `size-aside`.
