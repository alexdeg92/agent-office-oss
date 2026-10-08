# ProjectSummary

The summary block, titled *Résumé*, states what the project is and where it stands in a few sentences, and always shows who wrote it and when.

## Rules
- **Text:** `body-lg` in `text-secondary`, at most `size-prose` wide, about 3–5 sentences.
- **Provenance line** (`bu-summary__source`): the author's avatar, then *Rédigé par Timmy · date*.
  - An agent-written summary always offers *Régénérer*.
  - A human-written one offers *Modifier*.
- **Empty:** *Aucun résumé pour l'instant.* plus *Demander un résumé à Timmy*.

## Data
`summary`. The provenance (author and date) isn't in the draft `Project` type; it's flagged to the coordinator.

## Tokens
type `body-lg`, `caption`, `text-secondary`, `size-prose`.
