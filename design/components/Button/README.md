# Button

Buttons trigger one action each: `bu-btn` plus one variant and an optional size.

## Variants
| class | use |
| --- | --- |
| `bu-btn--primary` | The single main action of a view or dialog: *Créer la tâche*, *Se connecter*, *Envoyer*. At most one per area. |
| `bu-btn` (default) | Secondary actions: *Exécuter*, *Modifier*, *Appliquer*. |
| `bu-btn--ghost` | Low-emphasis actions and dismissals: *Annuler*, toolbar icons. |
| `bu-btn--danger-ghost` | A destructive action at rest: *Supprimer*. |
| `bu-btn--danger` / `bu-btn--armed` | A destructive action in its confirm step. |
| `bu-backlink` | "← Section" link at the top of detail pages. |

- **Sizes:** `--sm` (32px, toolbars), the default (40px) and `--lg` (48px, login and mobile primary).
- **Icon-only:** `--icon` is square and always gets `aria-label` and `title`.
- **Mobile:** under 820px every button grows to `--bu-size-touch` (44px).

## States
- **Loading:** set `aria-busy="true"`, which adds a spinner. Change the label to an ellipsis form, e.g. *Création…*, and keep the button disabled until the request settles.
- **Two-step confirm** (replaces the current text swap). The first click arms the button:
  - add `bu-btn--armed`;
  - change the label to *Confirmer la suppression ?*;
  - announce the change with `aria-live="polite"`.
  The button disarms after 4 s or on blur. The same pattern applies to *Appliquer (redémarrer Timmy)*.
- **Disabled:** uses `text-disabled`. Never lower the opacity of the whole button.

## Copy
Labels are infinitive verbs in sentence case: *Exécuter*, *Activer*, *Désactiver*, *Demander l'accès*.

## Tokens
`accent`, `accent-hover`, `accent-pressed`, `text-on-accent`, `danger-fill`, `surface-raised`, `surface-hover`, `border-default`, `radius-control`, `size-control*`, `duration-instant`.
