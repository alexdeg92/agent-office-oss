# rbac-ui-1: « Utilisateurs et rôles » in Settings (T-0031 UI) — P0

Owner (2026-10-10): "where is the multi user with permission level per user?????" The backend is done and reviewed on access-t0031 (worktree ../agent-office-redesign-access), but OFF. This brief is the UI that makes it usable.

## Scope
Settings → new section « Utilisateurs et rôles » (admin only; hidden for others), built ONLY on the Bureau components (public/v2 component library, TabButton/ListRow/Field/Button/Dialog). No ad-hoc pills or boxes.
1. **Utilisateurs:** list (name, email, role, status: actif / invité / désactivé, last seen). Invite (email + role) → one-time link shown once with copy; resend/revoke invitation; change role; disable/enable; remove. The owner/admin cannot demote or remove the last admin.
2. **Rôles:** Admin, Éditeur, Lecteur built-in (read-only), plus custom roles (create, rename, duplicate, delete when unused).
3. **Matrice de permissions:** rows = resources from the RBAC registry (served by the API, never hardcoded), columns/segmented control = Aucun / Lecture / Écriture per role. Group rows by area. Bulk "tout en lecture" per group.
4. **Exceptions par utilisateur:** per-user overrides on top of the role, same matrix, with clear "hérité du rôle" vs "remplacé" state and reset-to-role.
5. Sensitive actions (role change, removal, permission writes) use the backend's named-action confirmation / reauth flow (see docs/architecture/rbac-management.md).
6. Mobile: list → detail drill-down; matrix scrolls inside its container (page never scrolls; see frame layout rules).

## Data
Use the management HTTP contract in docs/architecture/rbac-management.md and rbac-projections.md on access-t0031. Settings consumer must handle separate account vs config revisions (current designer blocker): conflicts show a clear « modifié ailleurs, recharger » state, never silent overwrite.

## Order
1. Designer storyboard (desktop + mobile, all states: empty, invite sent, conflict, last-admin guard, error) → designer GO.
2. Build on top of access-t0031 (branch from its HEAD in your own worktree). Browser tests: invite → accept in a second context → role limits enforced in UI; override; last-admin guard; mobile.
3. Reviewers: designer, critic, security. Production activation is a separate access-codex checkpoint.
