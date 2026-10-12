# connectors-gallery-1: Settings → Connexion as a connector gallery — P0 (owner, 2026-10-10)

Owner: "Redesign this part: it should be options as cards side by side with the logo of each type of connector on them. We see more detail about the connector when the user clicks on it, and there is an active badge on those that are connected." Before: design/reports/connexion-before.png (local): long stacked forms per runtime.

## Target
- **Gallery grid** of connector cards (responsive, 3–4 per row desktop, 2 tablet, 1–2 mobile): OpenClaw, Claude Code, Codex, Cursor CLI, herdr, Hermes, plus "Ajouter un connecteur" for future adapters. Data-driven from the adapter registry (no hard-coded list in the page).
- **Card:** connector logo/mark (designer decides: official mark where use is permitted, otherwise a clean monogram tile in the connector's colour), name, one-line description, status badge: **Actif** (connected, green), Détecté (found, not connected), Non détecté, Erreur. Secondary line: instance count / agents count / last check.
- **Click → detail** (side sheet on desktop, full screen on mobile): status + last test, « Actif dans le bureau » switch, fields (instance name, paths/URL, secrets with Replace), include/exclude (as chip inputs, not raw textareas), auto-add toggle (T-0053), Test connection, Add another instance, danger zone (disconnect). Multi-instance: the card shows "2 instances", and the detail lists them.
- Save bar behaviour unchanged (draft → Enregistrer), works with revisions/conflicts.
- Built only on the Bureau components and identity themes (T-0048 tokens).

Owner of build: access-codex (merge with the T-0053 Settings UI checkpoint, as both touch Connexion). Designer storyboard first (desktop + mobile, all states), then build, then designer + critic + security.
