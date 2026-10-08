# RepoPanel

The repo panel, titled *Dépôt*, connects a project to its code: the repo link, default branch, CI state, recent commits, and the list of **linked sources**.

## Anatomy
- **`bu-repo__link`:** mono, external icon, `target="_blank" rel="noopener"`.
- **`bu-kv`:**
  - *Branche par défaut*, as a `bu-tag`;
  - *Intégration continue*, as a status chip: *Réussie* (success), *En cours* (info), *En échec* (danger; also raises the `CI rouge` risk flag), *Aucune* (neutral);
  - *Dernier commit*.
- **`bu-commits`:** the last 3–5 commits, each showing a mono SHA (accent link), a single-line message, and author · age. Then *Voir tous les commits →*.
- **Sources liées** (`bu-source`): one line per `sources[]` entry, each with an icon and a mono reference:
  - `github` (branch icon);
  - `workspace` (file icon), a Timmy workspace folder;
  - `sessionGroup` (journaux icon), with its session count;
  - `manual`.
  A project can link several sources.
- **No repo** (manual project): an empty state with *Lier un dépôt GitHub*.

## Data
- `repo{url, branch, image, ci}` and `sources[{kind, ref}]`.
- Commits need `repo.commits[{sha, message, author, at}]` or a server call; they're not in the draft type. This is flagged to the coordinator.

## Tokens
type `mono`, `mono-sm`, `body-sm`, `accent-text`, `border-subtle`, `success`, `danger`, `info`.
