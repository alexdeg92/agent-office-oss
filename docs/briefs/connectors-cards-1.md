# connectors-cards-1: Connexion as provider cards — P0 (owner, 2026-10-11)

Owner: "Instead of showing them like that, I want a card with the provider's icon for each one; when the user presses one, we get that provider's connector page. If the connector is already connected, the provider list shows a « Connecté » badge. Each connector needs the provider's logo, not just the initials. On mobile, make it a list."
Current page: long stacked forms per runtime (design/reports/connexion-current.png, local). No pixel-art illustration: owner rejected that direction. Plain, premium Bureau components.

## Target
- Settings → Connexion = a **grid of provider cards** (desktop 3–4 per row, tablet 2): the provider's **real logo** (T-0063 adapter-declared marks, shared connector-brand helper), name, one-line description, and a **« Connecté »** badge (green) when connected; otherwise « Détecté », « Non détecté » or « Erreur » as a neutral/warn badge. Includes OpenClaw, Claude Code, Codex, Cursor, herdr, Hermes… from the adapter registry (no hard-coded list), plus « Ajouter un connecteur » when relevant.
- **Tap/click a card → that connector's page** (own route, e.g. /parametres?onglet=connexion&connecteur=codex, with back): today's fields for that runtime (instance name, paths/URL, secret Replace, include/exclude as chips, auto-add, Active in the office toggle), Test connection, Add another instance, Disconnect. Save bar unchanged (Details/Cancel/Save on one row).
- **Mobile:** the same providers as a **list** (logo, name, badge, chevron) → full-screen connector page with back.
- Runtime-agnostic, adapter-driven; RBAC respected (read-only users see no editing).
- Tests: card grid renders logos + badges from the registry; navigation card → page → back keeps state; mobile list; the save flow still works; budget.
Reviewers: designer, critic, security. Frontend-only if possible (existing SettingsVM).
