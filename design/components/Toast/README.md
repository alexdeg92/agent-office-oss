# Toast

Toasts confirm the result of a mutation, briefly and without blocking.

## Rules
- **Container:** a single `bu-toasts` region (`role="status" aria-live="polite"`), bottom-centre. On mobile it sits above the bottom bar.
- **Errors:** use `bu-toast--danger` with `role="alert"` and stay until dismissed. Success and info auto-dismiss after 4 s; hovering or focusing pauses the timer.
- **Kind:** carried by the icon **and** the wording, not only the colour. The surface stays `surface-overlay`; only the icon is tinted, and danger also tints the border.
- **Copy:**
  - success: past participle, e.g. *Tâche créée*;
  - error: cause first, in French, with the technical code on a mono sub-line;
  - at most one action: *Réessayer*, *Voir l'historique*, *Appliquer*.
- **Stacking:** at most 3 toasts; the oldest is dropped first.

## Tokens
`surface-overlay`, `shadow-3`, `success`, `warning`, `danger`, `danger-border`, `info`, `z-toast` (above modals), `duration-base`, `ease-enter`.
