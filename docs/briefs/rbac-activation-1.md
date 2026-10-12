# rbac-activation-1: bring multi-user live (T-0031 + T-0047) — P0, owner asked repeatedly

Approved but never integrated: backend T-0031 (access-t0031, last all-GO 234698a8 + later checkpoints) and UI T-0047 (chars-t0047, last all-GO 2fe54b83). Both branched long before today's releases.

## Do (access-codex lead, chars-b for the UI)
1. Start the moment T-0053 deploys. New worktree from redesign HEAD; merge access-t0031 then chars-t0047.
2. Migrations: redesign has 001–023 (022 looks, 023 auto-add). Renumber RBAC migrations to 024+ in order; upgrade test 021→023→RBAC on a copy of the prod DB schema.
3. Conflicts: keep every deployed behaviour (themes, names/summaries + canonical displayName, Journaux privacy gates, self-healing health, lineage parentId, auto-add/Codex). RBAC projections must cover the new resources (connectors/agents/journaux/health/releases); new child actions are denied by default.
4. Activation: config-gated switch ON for this instance; the owner (current login) becomes Admin with no lockout; owner-only rollback path verified.
5. E2E (real server, synthetic data): admin invites a Lecteur → accept → read-only everywhere (no writes, settings hidden); Éditeur writes allowed per matrix; per-user override works; last-admin guard.
6. Gates: critic, security, designer. Full suite (backend change), boot check on a prod DB copy, then deploy with DB backup.
