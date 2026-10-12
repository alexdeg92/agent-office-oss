# identity-themes-1: ship all three identities as user-selectable themes

Owner decision (2026-10-10), on the identity comparison (Bureau / Observatoire / Atelier): "the 3 themes are valid, so why not simply offer which theme to be selected by the user in their settings."

## Scope
1. Each direction from T-0035 (design/reports identity-1 artifacts) becomes a **theme token set** for the Bureau components: Bureau (indigo), Observatoire (teal), Atelier (terracotta), each with light and dark. Tokens only: no per-theme component forks.
2. Settings → Apparence: « Identité visuelle » picker with three live thumbnails (desktop/mobile proportions), applied instantly, persisted **per user** (works with T-0031 multi-user; until it is active, per instance owner). Default: Bureau. Independent of the existing light/dark/system mode and the day/night office.
3. Data-driven theme registry so more identities can be added without code changes in pages.
4. **Save bar fix (all themes, all pages using it):** « Détails » sits on the same row as « Annuler » and « Enregistrer », left of them, with the status text (« 2 sections à enregistrer ») on the left. One row on mobile too; if it cannot fit, the status text truncates, never the buttons.
5. Tests: theme switch persists across reload; contrast (WCAG AA) for every theme × mode; save bar one-row layout at 360/390/1440; pinned captures for 3 themes × 2 modes.

Reviewers: designer, critic. Built on the Bureau components.
