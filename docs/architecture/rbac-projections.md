# Permission projections for HTTP and SSE

Implementation contract for ADR-002/ADR-003. Operator activation with `auth.rbacEnabled` / `AO_RBAC_ENABLED` registers these projectors and enables additional-user login; deployment also requires the Settings consumer checkpoint. `src/security/view-projection.js` is shared by protected HTTP responses and per-user stream snapshots. Both contracts (2.x and 3.x) use the same policy, with version-specific VM validation.

Every protected view has an exact root requirement. Authorization precedes its builder or on-demand read; projection checks current identity and permission again before serialization. Unknown view names/contracts fail closed. The projected VM is validated without a shared fallback cache. A shared raw cache remains internal; streams send full projected snapshots instead of raw shared-cache deltas. The user ID and permission fingerprint bind replay and buffered output. Actor-sensitive fields are recomputed even for admins.

## Explicit permission state

Authenticated `/me` adds the following optional fields to the legacy schema. Protected production wiring will always supply them:

```ts
user: { id: string; personId: string; roleId: string };
permissions: Record<string, 'none' | 'read' | 'write'>;
resourceStatus: Record<string, 'available' | 'unavailable'>;
permissionRevision: { user: number; role: number; registry: number };
```

These are the current user's effective permissions, including exact children. Persisted resources absent from the active registry are `unavailable` and have `none`. A missing/unknown permission never grants an action. Capability booleans are the intersection of operational write availability and eligible declared commands; individual actions still use their exact resource. Self account operations use their explicit account affordance, separately from resource-command capability aggregates.

The UI uses these permission/status fields to distinguish unreadable, unavailable and genuinely empty data. It must not infer a permission from an empty array or turn a redacted null into zero. After an authorization change it clears stale private data and obtains fresh `/me` state. Empty-state and permission explanations require a later rendered UI review.

## Cross-resource fields and schema additions

| VM | Projection |
| --- | --- |
| Office | Without `logs:read`, only primary/agent summary occupants remain, `sessionKey`/`tokens`/`lastSeenAt` are null, exchanges and journal are absent/empty. Session KPIs are omitted. Active count is recomputed from permitted summary occupants without the hidden on-stage count. Queue/flow KPI require `flows:read`; CPU requires `health:read`. Project journal entries require `projects:read`. Session cues also require related flow/project access. |
| Flow | Runs require `logs:read`; edit affordance requires exact `flows.edit:write`. Unstructured extension data requires `settings.runtimes:read`. |
| Access/interlocutor | Session-derived interlocutor inventory requires `logs:read`; adapter identity requires `settings.runtimes:read`. Interlocutor access policy is null when `access` cannot be read. |
| Health | Cron/plugins cards require flows/skills respectively. Channels require access; their error messages require runtime settings access. Source inventory and quality issue/count data require both logs and runtime settings access. Redacted `dataQuality` is null. |
| Layout and layout revision | Without logs access, seen occupants contain only summary agents with null last-seen timestamps. Custom agent matching rules are withheld because their opaque fields may contain exact private session identities; active/default and historical revision `agents` arrays are empty. `layoutRevision` is a checked partial VM with revision, timestamp, actor and layout data. |
| Project/board/history | Session group sources require logs; workspace sources require runtime settings. Session/flow history obeys related access. Unprovenance summary text is null unless logs, flows and runtime settings can all be read. Derived session people/risk flags, hidden counts and activity timestamps are withheld without logs. Pagination cursors are withheld when related history is filtered. Discovery candidates are withheld when transcript/local-root access is missing. |
| Comments | Session navigation requires logs. `editable`/`deletable` require current author's Person ID, undeleted comment, exact `projects.comment:write` and operational store writes. `canComment`/`canMention` intersect these permissions with operational capabilities. A raw owner affordance cannot grant another human edit/delete access. |
| Metadata | Runtime inventory/capabilities require runtime settings access, instance name requires instance settings access, primary-agent metadata requires a related readable view. Dynamic labels are rebuilt from the public dictionary plus only authorized agent/channel/model/provider entries. |
| Settings | Each instance/network/restart group is independently null when unreadable. Runtime/agent inventory and diagnostics are filtered by the relevant settings group. Read-only grants disable field edits. The account section always describes the current user; env/external accounts are immutable. Write-only credential fields retain the existing write-only schema. |

The schema additions are nullable Office occupant tokens; Health data quality; board hidden counts/activity timestamps; project summary/activity timestamp; layout seen timestamps; and Settings instance/network/restart groups. Existing owner/admin domain examples retain their values. A protected response with null indicates withheld data according to its explicit permission context, rather than a measured zero or a claim that no events exist.

A layout writer without logs access cannot change the withheld agent matching rules. Full saves and restores preserve the current private rules when the submitted projected `agents` array is empty. A nonempty submitted array is denied. Historical restoration therefore restores the visible layout fields and retains the current private matching rules; the UI must explain this scope rather than promise a full restore. Validator errors for retained private rules identify only the `agents` field, never a private rule ID.

## Broadcasts and response metadata

Every protected broadcast passes the actor filter. System frames expose only gateway summary, eligible capabilities and a closing reason. Settings notifications include only readable changed groups and only include network restart state for network readers. Unscoped toast/unknown frames are suppressed because they lack a resource/provenance declaration. Raw deltas are rejected. Stream-control envelopes withhold stale source IDs by default; a caller may explicitly expose them only with the same shared source-inventory policy as HTTP.

The internal `mountV2({ enforceAuthorization: true })` integration installs exact guards into the real core router, routes success/command/conflict views through this shared projector and configures both protected SSE hubs. Server boot selects this option through the validated operator switch. Checked historical layout revisions and actor-specific comment results follow the same policy; unknown embedded command view/conflict shapes fail closed. Protected response validation keys include the current permission fingerprint. Flow readers without logs do not request run history; callers without logs/runtime access do not start project discovery.

Core router coverage checks registrations and guard ordering in both aliases, including implicit HEAD. Whole-app middleware, configured/setup/recovery/API-only entrypoints, commands that dispatch after awaits, actual-user recent reauthentication, users/roles/invitation HTTP management, bootstrap identity wiring, and split-origin tokens remain separate gates. This internal integration is not approval to enable additional-user login. No schema fallback grants access or resurrects an old private payload.
