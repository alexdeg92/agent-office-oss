# ADR-002: multi-user identities and resource permissions

Status: **Accepted — critic-60 and security-40 GO on joint design `4466b165` (2026-10-10). Implementation checkpoints require separate review.**
Date: 2026-10-10. Owner: access-codex. Tasks: T-0031 and T-0032.
Inputs: [multi-user brief](../briefs/multi-user-rbac-1.md), [ADR-003](adr-003-split-origin-auth.md).
Inspection baseline: `310f64ef`; this ADR specifies future behavior, not delivered features.

## 1. Decision and current boundaries

Use one persisted human identity and one deny-by-default policy for cookie sessions, opaque human access tokens, and SSE tickets. Authentication establishes identity; current database state establishes authorization. Agent tokens retain their separate existing scopes. ADR-003 defines transport and external-access onboarding using these same identities and revisions.

The current `users` table is owner-only after migration 015, despite the wider migration 014 enum. `src/auth.js` accepts only that owner, uses the global `settings_state.auth_generation`, and signs `taco_sess`. API v2 and v3 share a router and separate stream hubs. Several actor builders and `src/api/audit.js` use `store.owner.id`; Settings reauthentication also assumes the owner. All those assumptions must be removed for human requests. Preserving the cookie name alone is insufficient to preserve sessions.

## 2. Data model and forward migration

Use `node:sqlite` repositories, short synchronous `BEGIN IMMEDIATE` transactions, existing private store permissions, and pre-migration backups. Do not edit migrations 014–020. Migration numbers are assigned from redesign HEAD at merge time. PM allocated 021 to discovery (T-0027) and 022 to RBAC (T-0031) on 2026-10-10; token tables receive the next available number at their merge.

| Object | Columns and constraints |
| --- | --- |
| `roles` | `id`, unique `slug`, localized built-in label keys or custom `name` (1–80 characters), `builtin` boolean, `revision >= 1`, timestamps. Stable built-ins: `admin`, `editor`, `reader`. |
| `users` (rebuilt) | Preserve `id`, `person_id` FK, case-insensitive unique normalized `email`, timestamps; add `role_id` FK, `status` (`invited`, `active`, `disabled`, `deleted`), nullable `password_hash`, `credential_source` (`database`, `env`, later `oidc`), `auth_generation >= 0`, `permission_revision >= 1`, nullable `last_seen_at`, `deleted_at`. Unique `person_id`; active database users require a valid hash. |
| `permission_resources` | Registry keys, parent key, schema/default version, adapter namespace, active flag; persisted identifiers allow FKs and preserve unavailable adapter grants. Labels are code/data translation keys. |
| `role_permissions` | `(role_id, resource)` PK/FKs, checked `mode` (`explicit`, `inherit-parent`) and `level` (`none`, `read`, `write`; null only in inherit-parent mode). Inherit-parent is legal only for a declared child and is an explicit stored grant for that child. Absence always denies. |
| `user_overrides` | `(user_id, resource)` PK/FKs, checked level. Absence means inherit; `none` is an explicit override. |
| `invitations` | `id`, `user_id`, purpose (`invite`, `password-reset`), unique token digest, `created_by` user FK, `created_at`, `expires_at`, nullable `consumed_at`, `revoked_at`, and target generation/revision captured on creation. No plaintext token. |
| `authorization_state` | Singleton random stable `installation_id`, `registry_revision >= 1`, migrated owner user ID, legacy-cookie acceptance deadline, legacy-cookie generation baseline, private HMAC env-credential fingerprint. |
| `permission_audit_changes` | FK to existing `audit_log.id`, bounded validated before/after changes containing only role/user IDs, resource keys, levels and status categories. |

Migration 022 seeds built-ins and core registry, rebuilds users (removes the owner-only index), and migrates the existing owner's stable user/person IDs to active `admin`. Seed its per-user generation from migration 017's global generation so existing signed cookies with that value remain valid. If there is no DB owner in a complete env-auth installation, boot transactionally creates a stable env-backed admin attached to the existing owner Person; it never persists the env password/hash into ordinary user credentials. Fresh setup still creates the first admin transactionally with its Person and setup draft.

The initial migration explicitly seeds child grants for the closed list in §3 into the editor/reader role revisions. Later registry migrations only add resource descriptors and increment registry_revision; an absent child grant means none for every existing or newly seeded non-admin role, regardless of parent level or user parent override. They must not backfill inherit-parent/write rows or broaden a role's reset defaults. Enabling a new child requires an audited, confirmed role edit or explicit per-user child override, with the corresponding revision increment. Preserve existing child levels/modes and overrides byte-for-byte on upgrade. Built-in reset defaults are a versioned explicit map: later-added children stay none until a separately reviewed administrative grant; reset is not an upgrade grant mechanism.

The unique owner Person remains the installation's historical operator identity, not an authentication or authorization shortcut. Deleted users are tombstones: retain user/person IDs and a resolvable display name for audit/history, remove their credential, revoke invitations and sessions, and never reuse their IDs. The email remains reserved in this version; restoring/reinviting a deleted identity requires an explicit administrative operation rather than silently transferring its history to someone else.

Roles in use cannot be deleted (`409 role-in-use`); reassign users first. Built-in roles cannot be deleted. Admin permissions and overrides are immutable. Editor/reader edits and reset-to-default increment their revision. Custom roles copy only explicitly chosen defaults, never future registry additions.

ADR-003's token/family/ticket migration is numbered at its merge. Migrations run before listeners open. A failed migration rolls back and leaves the old store usable with the old binary. Reverting an upgraded store requires the pre-migration backup; the old binary's existing newer-schema guard remains authoritative.

## 3. Canonical registry and defaults

Core owns `src/security/resources.js`; adapters contribute validated declarations through the public adapter interface, never through policy internals. Each descriptor includes key, parent (optional), FR/EN label keys, ordering, available levels, optional sub-actions, and whether it is privileged. Registration is deterministic at boot. Duplicate keys, cycles, invalid parents or unknown declarations fail boot/tests. Persisted keys from unavailable adapters are inert, shown as unavailable, and cannot authorize a route.

| Resource | Editor default | Reader default | Interpretation |
| --- | --- | --- | --- |
| `office` | read | read | Bureau summary and permitted live cues |
| `chat` | write | read | Shared conversation; write sends to agents |
| `flows` | write | read | Lists, details, create/edit/run/enable/delete |
| `projects` | write | read | Views, history, candidates, covers, moves, comments, regeneration |
| `access` | read | none | Agent/runtime habilitations, distinct from human user administration |
| `logs` | read | none | Sessions, transcripts and interlocutor detail |
| `skills` | write | read | Skill metadata and toggle |
| `health` | read | read | Health view; write mutes an issue |
| `store` | write | read | Shared office layout, theme, looks and shared preferences |
| `settings.runtimes` | none | none | Runtime and agent configuration/detection/checks |
| `settings.integrations` | none | none | Integration planning/application |
| `settings.instance` | none | none | Instance presentation/configuration |
| `settings.network` | none | none | External access planning, probes, origins and publication (ADR-003) |
| `settings.restart` | none | none | Restart the dashboard's API process |
| `users` | none | none | Users, invitations, roles and overrides |
| `gateway.restart` | none | none | Restart the selected runtime gateway |

An active built-in admin has write on all registered resources, including future resources; disabled/deleted admins have no access. Unknown resources always deny. `settings` is a UI group, not a grant that silently unlocks all settings. A custom role initially denies every resource. New adapter resource keys use `adapter.<adapterId>.<name>`. Every later-added resource or child action defaults to none for **all non-admin roles**, including editor/reader; this rule does not depend on a dangerous-action classification. Registry extensions increment `registry_revision` and invalidate policy caches/tokens/streams, but grant nothing to non-admins.

The initial reviewed sub-action list is `flows.create`, `flows.edit`, `flows.run`, `flows.enable`, `flows.delete`, `projects.comment`, and `projects.regenerate`. The initial editor/reader revisions explicitly store inherit-parent rows for these children; no runtime string-prefix inference creates a grant. A child added later, such as `flows.purge`, has no grant row and therefore none even when editor has flows:write. An administrator may explicitly add a concrete child level or an inherit-parent row through the existing role edit; either choice names the child in the confirmed permission diff. Unknown action names deny rather than being inferred by splitting arbitrary strings.

## 4. Policy semantics and privilege management

`can(user, resource, requiredLevel)` reads a validated current user snapshot, current role and override rows. Rank: none=0, read=1, write=2. Required level must be read or write; requesting none or an unknown level is a programmer error that fails closed.

For a root resource, effective level is user override if present, otherwise the explicit role permission, otherwise none. For a declared child, first require at least read on its effective parent. Then an explicit user child override wins; otherwise a concrete role child row supplies its level; otherwise a stored inherit-parent child row uses the parent's effective level; otherwise none. A parent override alone never creates a child grant. An explicit child none beats parent write. Thus flows:read plus an explicitly granted flows.run:write permits running while other writes remain denied; flows:none prevents every child, and flows:write plus flows.run:none denies running. Admin ignores overrides because its matrix is immutable; attempts to create admin overrides fail validation.

Registering flows.purge changes only the registry revision: editor flows:write still yields can(editor, flows.purge, read/write)=false until an administrator explicitly grants that child. A user override flows:write also cannot bypass this absence/none. Granting flows.purge:write increments the role or user permission revision and authorizes it only when the parent is readable. Resetting/removing that grant restores deny. Existing stored inherit-parent rows continue to follow parent edits; they never cover another child introduced afterward.

`users:write` is deliberately authority to administer identities and grants, including promoting an admin. The matrix must mark it as an administrative capability; assigning it requires recent password confirmation and an explicit privilege-change confirmation. It is not advertised as restricted helpdesk access. The initial product supports no partial/delegated user-management boundary. A non-admin may receive this capability only through an authorized administrator's explicit choice. Every subsequent grant mutation still requires users:write and recent confirmation, including custom roles acquiring users:write or gateway.restart. Admin promotions require confirmation naming the target; resets/overrides cannot be smuggled through ordinary profile edits.

Role changes, overrides, role permission edits and registry edits increment the relevant revision. They immediately affect HTTP; after commit they invalidate affected stream/replay state. Generations represent credential/session revocation, not ordinary role revisions. Policy caches are keyed by user ID, user permission revision, role ID/revision and registry revision, and updated synchronously after commit. Client-supplied role, actor, effective permissions or token revisions never authorize anything.

## 5. One route/command declaration mechanism

Introduce a policy-aware registration helper; each concrete route carries an explicit declaration: resource/level requirements, principal kind, command identity, write class, audit strategy and optional sensitive-action flag. Existing read-only flags, adapter capability checks, CSRF and domain invariants remain additional gates. No side effect, adapter read, file read, screenshot serving or entity lookup happens before authorization. Missing session is 401; valid human lacking permission is 403 `permission-denied` with no sensitive entity detail. Unavailable capabilities retain the existing 404 behavior after authorization.

A shared authentication gate distinguishes human cookie, human bearer and agent bearer (ADR-003). Route metadata explicitly identifies the current machine-scope routes; agent requests use their existing allowlist/body checks and never obtain human RBAC or cookie privileges.

| Route family | Declaration |
| --- | --- |
| `/api/login`, `/api/logout`, `/api/me`; v2/v3 `meta`, `me` | Public login/logout or authenticated self, individually declared exceptions. Public meta stays redacted; private meta is projected by permissions. |
| `/healthz`, `/readyz` | Explicit public minimal operational probes; no internal configuration or registry inventory. |
| `/views/office` | office:read plus field projection for related resources |
| `/views/chat`, `/chat/messages` | chat:read / chat:write |
| `/views/flows*`, `/flows*` | flows:read / declared corresponding sub-action:write |
| `/views/logs`, `/views/sessions/*`, `/views/interlocutors/*` | logs:read |
| `/views/access` | access:read |
| `/views/skills*`, skill enabled write | skills:read / skills:write |
| Health view and issue mute | health:read / health:write |
| Project/candidate/history/comment views, covers and `/shots/*` | projects:read; other resource detail within them is independently projected |
| Project commands/comments/regeneration | projects:write or declared child:write; retain comment ownership checks using the actual actor |
| Layout/revision and prefs reads/writes | store:read / store:write |
| v3 Settings aggregate | authenticated self; only authorized settings groups appear; no shared owner-only VM |
| Settings runtime(s)/agents/check/detect, integrations, instance, network, restart | respective settings resource, read for inspection and write for mutation/probing/planning |
| Settings owner/password legacy commands | self credential/profile operation, or users:write for another identity; never an implicit installation-wide owner action |
| Settings reauth | authenticated self, throttled, confirms the actual user's credential |
| User/role/invitation endpoints | users:read / users:write, plus sensitive confirmation for writes |
| Gateway restart | gateway.restart:write plus existing selected-runtime, confirmation and cooldown guards |
| Stream/open/topic change/resync | authenticated transport exception plus per-topic declarations, session ownership and current policy |
| Setup and new access/auth endpoints | Explicit setup-code/public/self exceptions or ADR-003 requirements; configured setup never reopens from a normal session |
| Static shell/assets, SPA fallback, API 404 | Individually described public presentation/fallback exceptions; never serve private data |

The command service rechecks the same policy before dispatch, and after awaited password hashing, probes or other work immediately before mutation. Background work carries the verified actor and accepted command identity; new privileged dispatch rechecks live authority. This does not undo an already authorized external effect when a role subsequently changes.

Coverage tests recursively inspect **actual Express 5 mounted stacks**, expand both API mount aliases, and enumerate every concrete method/path in configured, setup, recovery and API-only modes. Each route must have exactly one valid declaration or a narrowly typed public/setup/self/transport/static exception with a reason. No wildcard exemption for `/api/*` or `/settings/*`. Implicit HEAD inherits GET metadata; CORS OPTIONS has its own declaration. A deliberate undecorated mounted route must fail the test, proving the test is not comparing a hand-maintained list to itself. Command and topic registries have equivalent exhaustive checks. Audit/write-class metadata comes from these same declarations.

## 6. View and SSE isolation

Every topic definition declares requirements: office→office:read; chat→chat:read; flows/flow→flows:read; logs/session/interlocutor→logs:read; access→access:read; skills/skill→skills:read; health→health:read; layout/prefs→store:read; projects/project/comments→projects:read. Any future user/role topics require users:read. Ticket admission also checks these requirements (ADR-003).

Projection is shared between HTTP and SSE. Office may show a deliberately limited occupancy summary with office:read; without logs:read it excludes session keys, transcript fragments, session-derived navigation/detail and session event cues. Cross-resource links, project source details, runtime/integration secrets, capability flags and aggregate counts are omitted unless their resource can be read. Settings group values are independently filtered. Comment `mine`/edit affordances and other actor-sensitive fields are projected for the current user, never a shared owner VM. Cache identity includes the permission fingerprint and user ID where needed; fallback VM caches cannot cross permission cohorts. Deltas use the same projected base and revision as snapshots.

Streams bind user ID, session ID/family, auth generation, role revision, user permission revision, registry revision, and origin where applicable. Open, add, resync, reconnect, replay, each enqueue and each socket flush recheck current validity. Forbidden topic requests are reported as `permission-denied` with no snapshot/revision/entity existence information; permitted topics may proceed. Foreign stream IDs are 404 even for another session of the same user.

After any permission revision, close affected streams in both hubs, erase replay buffers/deferred snapshots/queued frames, and require a fresh stream with freshly authorized topics. Do not replay a frame serialized under old permissions. Credential disable/delete/revoke does the same for all that user's session types. Bytes already accepted by the network before revocation cannot be withdrawn. Settings broadcasts, system frames, toasts, office cues and closing notifications must use the same filtered serialization; a minimal permission-change closing reason carries no restricted inventory. The current unfiltered `broadcastSettings` and global `allExcept` revocation cannot be retained.

## 7. Sessions, invitations and user lifecycle

Keep the HMAC format and name `taco_sess`, HttpOnly, existing SameSite=Lax and production Secure. Resolve `userId` to the current user on every request; compare its generation, status and expiry, plus existing sid revocation. Newly issued cookies include stable user ID and generation, never a trusted permission matrix. Password confirmation validates the requesting user's database or env credential, with confirmation state bound to user/session/generation, using the existing monotonic five-minute window and shared throttle.

Existing DB owner cookies keep their IDs and generation. Signed legacy env cookies without userId map only to the migrated env/owner identity, never by looking up arbitrary cookie email. Accept them only until a persisted migration-time deadline equal to the old configured maximum session lifetime, with exp no later than that deadline. Missing generation means zero and is allowed only when the captured baseline and current generation are zero. Any later generation increment invalidates these legacy cookies; upgrade a valid one on the next authenticated response without extending its exp. Legacy no-sid logout revokes its digest until expiry and invalidates related streams. Preserve `PORTAL_SECRET` so deployment itself does not force logout.

Complete env login still works and maps to the same stable env-backed admin; invited database users remain able to log in beside it. The env credential is not used as a fallback password for a DB account. Its email is reserved; an env-backed account cannot be reset, deleted or demoted through the UI while that env auth source is active. Boot fingerprint tracking of env credential changes increments its generation without storing the credential. Moving from env to database is an explicit safe-publisher operation with confirmation. Unknown email verification pays the same scrypt cost using a valid dummy hash; snapshot the target generation/hash/status before asynchronous verification and recheck them before issuing a session.

Invitation/reset tokens are 32 random bytes, purpose-prefixed, stored as SHA-256 digests; invite TTL 48 hours, reset TTL one hour. The admin copies a link returned only once. Use a URL fragment so the token is stripped into memory by the frontend and sent only in a JSON body; no logging/referrers/history/query strings. Set no-store and Referrer-Policy:no-referrer. No SMTP dependency. Reissue invalidates outstanding tokens of the same purpose, and disable/delete invalidates all.

Public `POST /api/auth/invitations/accept` and `/api/auth/password-reset/accept` share login's IP/global admission before parsing/expensive hashing, JSON-only 4 KiB limits, generic invalid/expired/used rejection, and 12–1024 character password validation. Derive the hash outside the transaction; inside one transaction recheck token digest, expiry, purpose, user state/generation and issuing revision, atomically consume the token, set the password and activate an invited user or reset an active user's credential, increment generation, and audit. Only one racing acceptance can commit; failure rolls back consumption. Do not automatically issue a long-lived session; the user signs in with the chosen password. Role/permission changes revoke outstanding privilege-bearing invitation plans rather than letting them restore old grants.

Reset issuance immediately revokes sessions and pending reset links by incrementing generation; acceptance increments again. Disabling, deleting and logout-everywhere increment only the target user's generation, revoke families/tickets/invitations, clear confirmations, and close its streams. Re-enabling never revives old credentials' sessions. Single-session logout revokes sid/family plus descendants, without invalidating other users or sessions. Last-seen updates are bounded (at most once/minute per user).

## 8. Last-active-admin invariant and audit

Count only active users assigned the immutable built-in admin role. Invitations, disabled accounts and users:write custom roles do not count. Demotion, disable, deletion and bulk reassignment must leave at least one active admin. Validate the resulting state inside the same `BEGIN IMMEDIATE` transaction as the mutation; a defensive DB trigger protects direct repository writes as well. Handle cascades/role deletion explicitly. Race tests prove two simultaneous demotions cannot both succeed. Self-demotion is permitted only when another active admin remains. No API resets or overrides can make admin permissions empty.

Every accepted write uses the authenticated user's Person ID across audit, project activity/history, comment author and layout revision. Never accept an actor in a human request body. Agent actor handling remains unchanged. Successful permission/user/role mutations insert audit and typed before/after changes in their transaction; an audit failure rolls back them. Refused attempts remain category-only. Extend existing audit storage with ADR-003's validated origin field, not raw headers. Never put passwords, hashes, invitation/refresh/access/ticket tokens or DNS tokens into audit, VMs or SSE. Existing retention policy still applies; deleting a user must not delete its audit history.

## 9. UI contract and implementation gate

v3 `me` adds userId, personId, displayName/avatar, role id/label, effective permissions, explicit overrides and revision fingerprint. Private meta contains the permission-filtered navigation/action capabilities. The user's menu shows their role. Settings « Utilisateurs et rôles » uses the Bureau library: list/status/last seen, invite and user actions, role matrix Aucun/Lecture/Écriture with declared children, user overrides and highlighted differences. FR/EN keys and existing layout rules apply. Sensitive controls explain users:write authority and show « Lecture seule » where appropriate.

Proposed v3 endpoints: `GET /users`, `GET /users/:id`, `POST /users/invitations`, `PATCH /users/:id`, `PUT /users/:id/overrides`, `POST /users/:id/password-reset`, `POST /users/:id/revoke-sessions`, `DELETE /users/:id`; `GET/POST /roles`, `PUT/DELETE /roles/:id`, `POST /roles/:id/reset`, `GET /permissions/resources`. All mutations use explicit expected user/role revision and request validation. Self `/me` never exposes another user's credential or invitation digest. Lists paginate (default 50, max 100).

Implement backend only after critic **and** security GO on this ADR and ADR-003 at an exact candidate. Then add UI behind the designer gate after T-0030's component contract. Review of this ADR is separate from final implementation reviews.

## 10. Required evidence

Synthetic temporary stores only, never real `~/.openclaw` or production configuration. Exhaustive core/adapter resource × none/read/write tests cover both API versions, HTTP, snapshot/delta/live/settings frames, resync, buffered replay, backpressure and permission changes. Test mixed view field filtering and user-sensitive cache isolation. Test custom roles, overrides/sub-actions, unknown resources, disabled/deleted users, last-admin races, immutable admin, actor attribution and audit rollback. Test invite/reset expiry, reissue, replay, concurrent accept, shared throttle and password-hash races. Test targeted revocation across cookies/access/refresh/tickets and isolation from a second user's streams. Upgrade synthetic single-owner DB copies for both env and DB modes with pre-upgrade cookies (with and without sid), preserve generation/actor IDs, and prove generation changes defeat legacy cookies. Coverage tests mount an undeclared canary route/command/topic and fail. ADR-003 adds the two-origin browser and access-probe evidence.

Required future registry-extension regression (critic-57): seed editor flows:write and the initial reviewed child rows, then register flows.purge without editing any role. Assert both read and write are denied for editor, reader and custom roles, including a user with flows:write override; admin remains allowed. Assert old child grants and role revisions are unchanged while registry_revision increases, HTTP cannot dispatch the new command, SSE cannot admit a newly declared child-gated topic, and old token fingerprints are stale. Explicitly grant that child through the role edit, assert write/read allowed and the role revision/audit diff changes; remove/reset it and assert deny again. Repeat with an explicit user-child grant, an explicit child:none plus parent override, an adapter child and a simulated upgrade/reset/fresh installation to prove none is the default everywhere. Stored inherit-parent works only for the exact child row and never authorizes flows.purge merely because flows:write exists. These are implementation acceptance tests, not tests claimed to have run for this ADR-only checkpoint.
