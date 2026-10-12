# runtime-autoadd-codex-1: auto-add new sessions + a real Codex connector — P0

Owner (2026-10-10, prod Settings captures):
- "For Claude Code you should auto-add when a new session arrives. Now, to see them in the office, I need to approve each new session."
- "I can see that we still don't support Codex. Why is that?"

## A. Auto-add (runtime-agnostic policy)
- Per runtime instance: « Ajouter automatiquement les nouveaux agents/sessions » toggle in Settings → Runtimes et agents. **Default ON** for transcript-based runtimes (Claude Code, Codex); stored in the DB, survives restarts.
- New discovered agents appear in the office immediately, with an unobtrusive « Nouveau » marker for 24h. Exclusions still apply (excluded projects, owner removals are remembered: a removed agent never auto-returns).
- The list today says « No agents configured » above 7 discovered rows. Make it one coherent list: Dans le bureau / Découverts (with « Tout ajouter ») / Exclus.
- RBAC: changing the policy requires write on runtimes; auto-added agents follow the normal visibility projections.

## B. Codex connector (replace « connector coming soon »)
- New adapter `src/adapters/codex/`, modelled on the Claude Code adapter (bounded tail reads, files/profile split, capacity caps, redaction, probe with reason codes, synthetic-home tests only).
- Source: Codex CLI session rollouts under `$CODEX_HOME` (default `~/.codex`) `sessions/YYYY/MM/DD/rollout-*.jsonl`. Read the real format from a synthetic copy of the key structure only (never commit real content; record keys/line types in the report like claude-real-format-1).
- Agents grouped per project (cwd), with title/summary for T-0049 (`displayName`/`summary`), working/idle from activity, model, tokens when present.
- Settings: Codex card becomes a real connection (detect, test connection, home path field, grouping, auto-add from A).
- Cursor CLI: keep presence-only, but put it on the same adapter shape (follow-up).
- herdr reconciliation (T-0045): a Codex pane seen by herdr and the Codex adapter must be one agent (exact session correlation; ADR-004).

Tests: adapter unit + probe + settings round-trip + browser (Codex card connected, auto-add puts a new session in the office without approval).
Reviewers: critic, security (privacy of transcript-derived fields), designer (Settings list).
