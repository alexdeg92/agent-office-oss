# Projets domain

The Projets module (`src/projects/`) is the board’s domain: projects, flags, people, history, source adapters, the risk monitor, and the `BoardVM` / `ProjectVM` builders. It does not open the store, speak HTTP, or call `gh` / `git` unless a caller injects an exec function. The architect wires it into `src/store` and `src/api` later. Behaviour below is what that wiring should preserve.

Tests: `node --test test/projects/*.test.js` — 17 suites, 130 tests, no live network and no live `gh` / `git`. The Timmy CLI tests bind a fake server on `127.0.0.1`. Fixtures live in `test/projects/fixtures/github/` and `test/projects/fixtures/flags/`. The repository contract is `test/projects/repository-contract.test.js`. `test/projects/vm-shape.test.js` checks `buildProjectVM`, `buildBoardVM`, `buildCandidatesVM`, `buildHistoryPage`, `projectConflictBody`, and `importCandidates` with `compareExample` (example plus sidecar) against `docs/architecture/examples/`. `test/projects/session-group.test.js` checks the `{by:'group', groupId, name}` ref, the keys fallback, an OpenClaw rename, and `compareShape` of the Automations candidate.

## Layout

| Path | Role |
| --- | --- |
| `constants.js` | Closed enums, including status `idea \| todo \| in-progress \| in-review \| shipped` |
| `validate.js` | Canonical checks on the schema DSL (`extra: 'reject'`) |
| `plan.js` | Pure transitions. A future SQL repository should call these inside one transaction |
| `memory.js` | In-memory repository. Same methods the store will implement |
| `risks.js` | Pure risk monitor |
| `activity.js` | Pure linkers from canonical sessions, cron runs and commits |
| `people.js` | Derived membership and the git/human merge |
| `sources/` | Adapters: GitHub, workspace, session group, manual |
| `repo-refresh.js` | Stale check, backoff, one in-flight fetch per repo, screenshot policy |
| `screenshot.js` | Public-https check and the injected 1200×630 capturer |
| `flags.js` | Read-only feature-flag scan of a linked workspace or GitHub repo |
| `service.js` | API facade: one repository write, then a change set for SSE |
| `discovery.js` | Candidate proposals (pure merge) and read-only collectors |
| `vm.js` | `BoardVM` and `ProjectVM` |
| `index.js` | Public entry |
| `scripts/projects-discover.js` | Dry-run printer. Writes nothing |

Ids are `prefix + '_' + base32(randomBytes(10))` (`prj_`, `src_`, `evt_`, `per_`), 16 lowercase characters. Tests may use readable ids that only require the prefix.

Actors on commands are `'owner'`, `'system'`, `{ kind: 'agent', agentId }`, or a canonical `ActorRef`. `owner` is the owner `Person`. `{ kind: 'agent', agentId }` is that agent's `Person` (the primary id comes from the engine resolver). `system` is `{ kind: 'system', component }` (`risk-monitor` by default, or `engine` / `scheduler`). The command shorthand `'timmy'` is refused. History stores the `ActorRef`. A stored actor string `'timmy'` is read as the primary agent's `Person` and is not rewritten.

Compatibility: earlier owner command aliases remain accepted and resolve to the configured owner Person. Upgrades preserve existing person IDs, canonical actor references, stored names and source references. `AO_PROJECTS_OWNERS` remains the instance's GitHub owner allow-list; changing public distribution metadata never replaces it.

## Repository

`createMemoryRepository(options)` and, later, the SQLite repos in `src/store/repos/` implement the same methods (`REPOSITORY_METHODS`). Reads return frozen canonical objects. A failed command writes nothing.

`test/projects/repository-contract.test.js` is that shared suite. It exports `defineRepositoryContract(createRepository, label)`. Loading the file runs it against the memory repository (`label` defaults to `memory`). The SQL repository runs the same function:

```js
const { defineRepositoryContract } = require('../../test/projects/repository-contract.test.js');
defineRepositoryContract((options) => createProjectsRepository(db, options), 'sql');
```

`createRepository(options)` may be async. `options` is `{ persons, ownerPersonId, timmyPersonId, now, githubOwners }`. `now` is the clock when a command omits `at`. `persons` is the actor directory (the owner human and the `main` agent). If the repository has `close()`, the suite calls it after each test.

Every user write except create takes `expectedRevision`. A mismatch throws `ProjectError` with `code: 'conflict'`, `status: 409`, and `revision` set to the current value. The message is French. The route layer should put that revision, plus a fresh `ProjectVM`, on `error.current`. Missing projects are `not_found` (404). Bad input is `validation_failed` (400) with `details: [{ field, issue }]`. A no-op (same status, same label, ack already in that state, same source) returns the project, does not bump `revision`, and writes no history.

System writes do not take or check `expectedRevision`: `applyRisks`, `applyProjectRisks`, `ingestActivity`, `replaceFeatureFlags`, and the three cache puts. The risk monitor and the feature scan still add 1 to `revision` when the card or the flag set actually changes, so an open drag sees 409 and refetches. Cache puts and activity ingestion do not, so a refresh cannot 409 a drag.

A command builds the next card, validates that card (history events and the canonical project, including feature `foundIn`), and only then writes. A validation failure leaves revision, flags, history, and caches as they were. `putRepoCache` validates the repo the same way and rolls the cache back if assembling a linked project would throw. `getProject` and `listProjects` keep working.

| Method | Who | Revision | `lastActivityAt` | History |
| --- | --- | --- | --- | --- |
| `createProject` | user | starts at 1 | command time, or `activityAt` when seeding | `project-created`, plus `source-linked` per source |
| `edit` / `rename` / `setPriority` / `editSummary` | user | +1 if something changed | command time | one event per changed field: `renamed`, `summary-edited`, `priority` |
| `setStatus` / `reorder` | user | +1 when the status changes | command time | one `status` event |
| `addLabel` / `addFlag` (label) | user | +1 | command time | `flag-added` |
| `setBlocked` / `addFlag` (`blocked`) | user | +1 | unchanged | `flag-added` and `risk-raised` |
| `removeFlag` (label) | user | +1 | command time | `flag-removed` |
| `removeFlag` (`blocked`) | user | +1 | unchanged | `flag-removed` |
| `ackRisk` | user | +1 when ack flips | unchanged | `risk-acked` or `risk-unacked` |
| `linkSource` / `unlinkSource` | user | +1 | command time | `source-linked` or `source-unlinked` |
| `setArchived` | user | +1 | unchanged | `archived` or `restored` (no payload) |
| `setPersonOverride` | user | +1 when role, hidden, or membership changes | unchanged | `people-override` `{ personId, role, hidden }` |
| `appendHistory` | user (Timmy) | checked, not incremented | the event’s own `at`, and only for an activity kind | one event, Timmy’s kinds only |
| `applyRisks` / `applyProjectRisks` | system | +1 when the card changes | unchanged | `risk-raised`, `risk-cleared`, `risk-unacked` |
| `ingestActivity` | system | unchanged | max of the new events’ own `at`, activity kinds only | commit / flow / cron / session, skipped when `dedupeKey` already exists |
| `replaceFeatureFlags` | system | +1 when the key/state set changes | unchanged | one `flags-updated` `{ flags: [{ key, state }] }`. A scan that only moves `foundIn` updates the rows and writes no event |
| `importCandidates` | user | 1 per new project | the candidate’s last activity, not the import clock | `project-created`, `source-linked`, `flag-added` |
| `putRepoCache`, `putWorkspaceSnapshot`, `putSessionSnapshot` | system | unchanged | unchanged | none |

`reorder({ id, expectedRevision, status, actor })` is the board drop. There is no `index`. Passing one is `validation_failed` and writes nothing. Order inside a column is computed: priority P0→P3, then `lastActivityAt` descending, then `id` ascending (`compareCards`). Dropping a card in its current column is a no-op and does not bump the revision.

`edit` is the `PATCH` body (`name?`, `summary?`, `priority?`) in one revision. The single-field methods call it.

`applyProjectRisks` reads the stored project, runs `evaluateRisks` on `project.lastActivityAt`, and writes that plan. A caller-supplied `lastActivityAt` is ignored, so a derivation cannot feed the monitor a clock it just advanced with a `risk-raised` event.

`getHistory(id, { cursor, limit })` is newest first (`at` desc, `id` desc). Default limit 20, max 100. `nextCursor` is an opaque base64url token. Invalid cursors are `validation_failed`.

GitHub `(owner, repo)` is unique among non-archived projects, case-insensitively. Archiving frees it. Restoring fails if another active project took it. `findActiveByGithub` is the lookup.

## Canonical assembly

`getProject` builds the data-model `Project`:

- stored label / risk / feature flags, plus the derived `priority` flag (never stored);
- `repo` from the first GitHub source’s cache (by `addedAt`, then `id`);
- `people` from derived membership plus `project_people` overrides.

Canonical `repo` stays `null` until the first successful cache write. `repoStatus` is derived, not stored on the row: `null` with no GitHub source, `pending` before the first success, `ok` after it, `error` when `recordRepoFailure` recorded a `SourceErrorCategory` (the last good `repo` is kept). `ProjectVM.repo` is a `RepoVM` as soon as a GitHub source is linked (`state: 'pending' | 'ok' | 'error'`, null branch and empty commits while pending). The client reads `repo.state`; a pending fetch has no separate notice field. A project with no GitHub source has `repo` and `repoStatus` null. `presentHistory` returns `HistoryItemVM`: `{ id, at, kind, actor, text: LabelRef, group }`. `text.key` is `historyKind.<kind>[.<variant>]` from api.md §3.9.1. Params are raw (status and risk values are nested LabelRefs; a one-run duration is ISO 8601). A null session `messages` count is omitted. `actor` is a PersonChip, or `{ kind: 'system', name: 'Système' }`. The text does not repeat the actor’s name.

People:

- git authors match `links.gitEmailHash` (SHA-256 of the lowercased email). A human with that hash absorbs the author; no second git `Person` is created. `commitCount` is the number of cached commits (GitHub and workspace) and is set on that human so the count survives the merge;
- session groups add the agent (`links.agentId`, and `subagentId` when the session has one) and the Discord user (`discord-user:<snowflake>` → `links.discordUserId`);
- overrides can set `role`, `hidden`, or add a person (`origin: 'manual'`). Hidden people are omitted. `liveState` is filled from `setLiveStates` at read time (the store will pass office occupants). It is not a table.
- order is humans, then the primary agent (`primaryAgentId` is a string or a callback, read when people are derived and again on a person override, or `main` when that is unset), then the name in `locale` (`fr` when unset).

Raw emails are not stored and are not returned by the adapters. `putRepoCache({ owner, name, repo, authors })` creates a git `Person` only when the hash is new.

## Risk monitor

`evaluateRisks` is pure. The caller classifies which cron jobs are flows and which are other jobs that touch the project. The monitor does not decide that.

| Key | Raised when | Severity | Evidence |
| --- | --- | --- | --- |
| `flow-failing` | a linked flow’s latest signal is `health: 'failing'` or `status: 'failed'` | high | `cron-run` (a flow is a cron job) |
| `cron-failing` | same, for the cron list | high | `cron-run` |
| `ci-red` | `ci.state === 'failing'` and `ci.at` is set | medium | `ci` |
| `stale` | `now - lastActivityAt >= 14 days` (`STALE_AFTER_DAYS`) | low | `inactivity`, `at` = `lastActivityAt` |
| `blocked` | never | high, manual only | — |

`running`, `passing`, `none`, and `unrecognized` CI do not raise `ci-red`. Flows and crons are judged per job: only the latest run counts, so a newer success clears that job and an older failure of a different job still raises. An auto flag clears when its condition is gone (`clearedAt` set, row kept). `blocked` and any `origin: 'manual'` flag are left alone on both the raise path and the refresh path: a manual flag is never refreshed or un-acked, and a cleared manual flag is not replaced by an automatic raise of the same key. A newer evidence `at` than `ack.at` un-acks an automatic flag and does not emit a second `risk-raised`. The same evidence leaves the ack in place.

## Activity clock (R3-06)

`lastActivityAt` is not the maximum timestamp over every history row. `activityAtFromHistory(events, createdAt)` keeps only:

- `project-created`, `status`, `priority`, `renamed`, `summary-edited`
- `source-linked`, `source-unlinked`
- `flag-added` and `flag-removed` when `flagKind` is `label`
- `commit`, `flow-run`, `cron-run`, `session`, `agent-action` (each at the event’s own `at`, not the time the row was written)

Excluded, on every path including `ingestActivity` and `appendHistory`: `risk-raised`, `risk-cleared`, `risk-acked`, `risk-unacked`, `flag-added` / `flag-removed` for a risk, `archived`, `restored`, `people-override`, `flags-updated`. Setting or clearing Bloqué, acknowledging a risk, and the monitor’s own history therefore cannot cure `stale` or jump the card to the top of its column. A later commit or session can. The monitor reads the stored clock and does not recompute it from raw history. Contract 2.0 lists every `flag-added` / `flag-removed` as meaningful; this module does not, and that delta is in the proposals below.

`applyProjectRisks` defaults the actor to `'system'` / `risk-monitor` and uses `project.repo.ci` when `ci` is omitted.

## Linking activity

`linkProjectActivity({ projects, sessions, cronRuns, cronJobs, transcripts, agents, commits, links, now })` is pure. It reads canonical objects only. It does not call the gateway, the CLI, or the store. Archived projects are ignored. The same snapshot produces the same `dedupeKey`s, so a refresh or a restart fed through `ingestActivity` does not write a second row.

There is no FlowRun type. A **flow** is a `CronRun` whose `jobId` is in `links` as `{ projectId, jobId }`. A **cron-run** is any other run whose session touches the project: `CronRun.sessionKey`, `CronJob.sessionKey`, or `class.cronJobId` on an already linked session. One run is not both. LiveEvents are not an input and are not history.

| Activity | Belongs to a project when |
| --- | --- |
| Session | a `sessionGroup` source with `{by:'group', groupId, name}` whose `groupId` equals `session.group`; or `{by:'keys'}` lists its key; or `{by:'interlocutor'}` matches `class.interlocutorId`; or `links` contains `{ projectId, sessionKey }` |
| Session | a `workspace` source path appears in `cwd` as its own path. `goal.objective` is used only when `cwd` is null or names none of the linked folders. A shorter prefix loses to the longer folder; two projects with the same path are left unmatched and reported on `ambiguous` |
| Commit | a `github` source matches `repo.owner` / `repo.name` (or a `{ owner, name, sha, at, branch? }` commit) case-insensitively, and exactly one active project has that repo. `branch` is the commit’s branch or `repo.defaultBranch`. `{ projectId, sha }` forces that sha onto one project |
| Flow run | `{ projectId, jobId }` |
| Cron run | the run’s session is already linked, and the job is not an explicit flow |

A heartbeat (`class.heartbeatOf`) follows only an explicit key or a `by: 'keys'` source that names it. Matching the group id, the parent interlocutor, or a folder in the parent’s goal does not pull the heartbeat in.

History drafts use the keys `ingestActivity` already dedupes: `commit:<sha>`, `flow-run:<run.id>`, `cron-run:<run.id>`, `session:<key>@<at>`. `at` for a session is `updatedAt`, then `run.endedAt`, then `run.startedAt`. A later `updatedAt` is a new event. A run still `running`, or `unrecognized`, is not history: the key is the run id, so the first terminal status (`succeeded`, `failed`, `skipped`) is the one that sticks. The risk input still includes `running`, so a retry does not keep an older failure. `unrecognized` is left out of the risk input too. Each project’s `riskPlan` is `evaluateRisks` over those flows and crons, plus `repo.ci`, `lastActivityAt`, and the project’s current flags. `now` is required for the plan.

`people` are suggestions, not stored persons. Linked sessions contribute `{ kind: 'agent', links: { agentId } }` (name from `Agent.name` when an `agents` entry matches), `{ kind: 'agent', links: { agentId, subagentId } }` when `class.subagentId` is set, and `{ kind: 'human', links: { discordUserId } }` for a `discord-user:` interlocutor. A Discord channel is not a person. `messages` is `session.messageCount` when that is an integer (including 0), otherwise `Transcript.messageCount`, otherwise `null`. An unknown count is never stored as 0. The history sentence says « nombre de messages inconnu » in that case.

## Sources

All four adapters share `{ kind, parseRef(input), fetch(ref, ctx) }`. Nothing in `src/projects/` imports `child_process`. Production passes an `execFile`-shaped function; tests pass fixtures.

`exec` is `async (argv: string[]) => { stdout, stderr, code }`. Non-zero exits become `upstream_failed` with a fixed French message. Stderr is not copied onto the error (a token on stderr must not surface).

Clients send `ProjectSourceInput`: `kind` and `ref` only. `id`, `addedAt`, and `addedBy` are rejected with `issue: 'server-owned'`. The server mints them. The same `(kind, ref)` on the same project is a no-op. A GitHub repo already on another active project is 409 `conflict` with `issue: 'source-in-use'` and `revision: null` (no `error.current`). An owner outside the allow-list is `issue: 'owner-not-allowed'`.

- **GitHub** (`createGithubSource({ exec, owners })`). Owners default to `alexdeg92`. Calls, in order: `gh api repos/{owner}/{repo}`, then `…/commits?sha={defaultBranch}&per_page=10` and `…/actions/runs?branch={defaultBranch}&per_page=1`. A workflow run whose `head_branch` is some other branch is ignored. JSON is parsed from the first `{` or `[`. The GitHub card is not downloaded. If the repo payload has an https `openGraphImageUrl`, `open_graph_image_url`, or `social_preview_url`, that URL is the OpenGraph image (userinfo stripped). Otherwise it is `https://opengraph.githubassets.com/{hash}/{owner}/{repo}`, where `{hash}` is 16 hex chars of sha256(`node_id` or `owner/repo`, plus `updated_at` or `pushed_at`). CI: `success` → `passing`; `failure` / `cancelled` / `timed_out` / `startup_failure` / `action_required` → `failing`; queued or in progress → `running`; skipped or no runs on the default branch → `none`; anything else → `unrecognized`. Commits keep the first line of the message (max 200) and an author hint `{ name, emailHash }`. The cached repo also keeps `archived`, `homepage` (https or null), and `topics` (slugs, max 20). Those three are not copied onto `RepoVM`. A non-zero `gh` is still `upstream_failed` with a fixed French message; the error’s `category` is a source-error token (`rate-limited` when the output says so) and stderr is not stored.
- **Workspace** (`createWorkspaceSource({ root, exec })`). `root` is absolute. The relative path cannot be absolute, empty, or contain `..`. If the root exists, each existing ancestor is realpathed and must stay inside it; a missing leaf is accepted only under those ancestors, and a symlink (or a missing leaf beneath one) that leaves the root is rejected. Before any commit is read, the folder must contain its own `.git`. A directory, a symlink, or a `gitdir:` file (a linked worktree) is realpathed. A worktree `commondir` is realpathed too, and so is the file itself when `commondir` is a symlink. The object database is contained as well: `.git/objects` (or the common dir’s `objects`) must realpath inside the root, and every `objects/info/alternates` entry is resolved relative to that object directory and walked the same way, including a chain that hops through an inside store. Anything outside is rejected before `git` runs, so a contained git dir cannot publish commits whose objects live elsewhere. `fetch` and the workspace collector then run git with an env copy that drops `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, and any `GIT_ALTERNATE*` variable. The dry-run script passes that env to `execFile`. The git commands are `git -C <abs> rev-parse --abbrev-ref HEAD`, `git log -n 10` with a unit-separator format, and `remote get-url origin` (a missing origin is fine). All three go through the same executor wrapper: a thrown error becomes `upstream_failed` with a fixed French message, and the executor’s message is dropped. Userinfo and `token` / `access_token` / `password` / `secret` query parameters are stripped from the remote before it is stored or returned. The dry-run script strips them again on stdout and stderr. An author name that is an email address is stored as `inconnu` with the hash; the raw address is not kept.
- **Session group** (`createSessionGroupSource()`). No I/O. The stored ref is `{by:'group', groupId, name}`: `groupId` is the runtime's stable group id (OpenClaw: the catalog name, which is also `Session.group`), and `name` is the display label. `fetch` keeps every canonical session whose `group` equals `groupId`, including sessions filed into the group after the source was linked. `{by:'keys', sessionKeys}` remains the fallback for a runtime with no groups: it matches those keys and ignores `session.group`. `{by:'interlocutor', interlocutorId}` is still accepted for a Discord user or channel. OpenClaw has no id separate from the name, so a rename is a new `groupId`. The stored source is left as it was: its `source-linked` history stays, and it stops matching sessions whose `group` is now the new name. Discovery proposes the renamed group as its own candidate (`sg:group:<new id>`). Linking that candidate adds a source; it does not rewrite the old one.
- **Manual** (`createManualSource()`). `ref` is `null`. One per project.

`createRepoRefresh({ source, capture, resolve, now })` is the cache behind the Dépôt panel and the card image. `refresh(repository, { owner, name, at })` uses the injected source only. A linked repo is fresh for 10 minutes after `fetchedAt` (data-model §9.3). A failed fetch stores a source-error category through `recordRepoFailure` and waits before the next try: 1 minute for a generic error, 2 minutes for `timeout`, 15 minutes for `rate-limited`, doubled on each further failure of the same category, capped at 1 hour. The streak resets on success. One fetch is in flight per `owner/repo` (case-insensitive); a second caller gets the same promise. Success calls `putRepoCache`, then `ingestActivity` with `{ sha, branch: defaultBranch, at }` so history gets `commit:<sha>` (a sha already stored is a no-op), then `applyProjectRisks`. That reads `repo.ci`: `failing` raises `ci-red`, and a later `passing` refresh clears it. A failed fetch keeps the last good repo and does not clear `ci-red`. These writes do not take `expectedRevision`. `archived`, `homepage`, and `topics` stay on the cached repo and off `RepoVM`.

Image priority, after the `gh` payload is in: (1) `screenshot` of `repo.homepage` at 1200×630, from an injected `capture({ url, width, height, timeoutMs, maxBytes })` (tests pass a fake; the server will pass headless Chrome); (2) the GitHub OpenGraph card; (3) a `monogram` when neither URL exists. A screenshot is kept for 24 hours while the homepage stays the same. The capturer is given a 10 s timeout and a 2 MiB cap. A timeout, an oversized body, or a capturer error falls through to the OpenGraph card. ProjectCovers are not referenced.

The capturer is not called for a non-https URL, a URL with userinfo, or a host that is `localhost`, `*.localhost`, `*.local`, `*.internal`, loopback, RFC1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16, IPv6 `fe80::/10`), or CGNAT 100.64/10 (tailnet). A name is looked up through the injected `resolve` before the call and again after it; any private address, including a second lookup that rebinds the name, drops the shot. A `redirect` in the capturer result is checked the same way and is never followed onto a private host. The stored image URL has to be public https too.

## Feature flags (S15d)

Owner has no flag convention. `scanFeatureFlags(repository, { id, root, fs, exec, at })` detects the common ones, read-only, and writes them with `replaceFeatureFlags` (`actor: 'system'`, `component: 'engine'`). That is the `flags-updated` event. The scan does not move `lastActivityAt`.

A returned flag is `{ key, state, source, line, detectedAt }`. `state` is `on`, `off`, or `unknown`. `source` is the file. `detectedAt` is the scan clock. The stored row is the existing feature flag: `foundIn.path` is `source`, `foundIn.line` is `line` (`null` for JSON), and `scannedAt` is `detectedAt`. No new canonical field.

JSON stores a boolean and nothing else. `true` / `false`, or a boolean `enabled`, `on`, `defaultValue`, or the OpenFeature variant named by `defaultVariant`, become `on` / `off`. A string (including `"true"`), a number, or any other value is `unknown`. The raw value is not kept. `.env.example` has no boolean type, so the words `true` and `false` (either case, optional quotes) are the one exception. `1`, `yes`, and `on` stay `unknown`.

Files, and nothing else:

- `.env.example` only. Keys `FEATURE_*`, `FF_*`, and `ENABLE_*`. `.env`, any other `.env.*`, and a name containing `secret`, `credential`, `password`, or `token` are never opened.
- `flags.json`, `feature-flags.json`, and `features.json`: a map, a `featureFlags` / `flags` / `flagValues` object, or a list of `{ name|key, enabled }`.
- `package.json` and one level of `config/*.json`: the `featureFlags` object only.
- SDK files, by presence: Unleash `unleash.json` and `.unleashrc.json`; GrowthBook `growthbook.json`; LaunchDarkly `launchdarkly.json` and `.launchdarkly/flags.json`; Flagsmith `flagsmith.json`; OpenFeature `openfeature.json` and `.openfeature.json`. A file that holds only a URL or a token produces no flags.

`fs` is `{ lstat, realpath, readFile, readdir }`, sync or async. The linked folder goes through `resolveInside`. Each candidate is realpathed and has to stay inside `root`. A symlink that leaves the root is not read. GitHub uses the injected `exec` on `gh api repos/{owner}/{repo}/contents/<path>` for that allowlist, plus `contents/config`. Listing entries that are not files are ignored. A missing file is absent. Any other failure (including invalid JSON and `gh` rate limit) skips the write, so the last good set stays. Files over 256 KiB are skipped. At most 100 flags are kept, the history payload cap, sorted by key. The same key keeps a boolean over `unknown`, and the earlier file when both are booleans. Workspace sources are scanned before GitHub. The GitHub path is `owner/repo/<file>`, using the cached `defaultBranch` when there is one.

An unchanged key, state, and place is the existing no-op: no event, and `scannedAt` stays at the last change.

This is the answer to data-model.md open question 4. That file is not edited here.

## `repo.image`

`RepoVM.image` is the thumb without `repoLabel`. A pending GitHub source (no cache yet) is a monogram. A cached screenshot or OpenGraph card keeps that kind and its https `url`. `initials` and `accent` always come from the project name and id.

```json
"image": { "kind": "screenshot", "url": "https://shots.example/alexdeg92/agent-office-oss.png", "initials": "AO", "accent": "indigo" }
```

```json
"image": { "kind": "opengraph", "url": "https://opengraph.githubassets.com/1/alexdeg92/agent-office-oss", "initials": "AO", "accent": "indigo" }
```

```json
"image": { "kind": "monogram", "url": null, "initials": "GI", "accent": "teal" }
```

`kind` is `screenshot | opengraph | monogram`. `url` is a public https string, or `null` for a monogram. `initials` is the fr-CA monogram of the project name (two letter-words → one letter each; one word → its first two letters; letters include accents; emoji are skipped when the name has letters, and used alone only when it has none). `accent` is `slate | indigo | teal | amber | rose | green`, hashed from the project id. The cached repo stores a screenshot or OpenGraph value as `{ kind, url }` and a monogram as `{ kind, initials, accent }`.

`ref` keys: `owner/repo` lowercased, the workspace path, `group:<groupId>`, `interlocutor:<id>`, `keys:` plus sorted keys, or `manual`. A group source's history string is its `name`.

## View models

`buildBoardVM(projects, { filter, persons, timmyPersonId, liveStates })` returns api.md `BoardVM`. Columns are the five statuses in order, even when empty. `all`, `at-risk` and `with-timmy` omit archived projects. `at-risk` is any uncleared risk, including an acked one. `with-timmy` is the primary agent's Person (the resolver's id), or `timmyPersonId` when no resolver is wired. The filter id on the wire stays `with-timmy`. `archived` is the archived projects only (api.md 2.1).

The backend can add canonical orchestrator teams through `src/projects/orchestrator-teams.js`; this projection consumes joined `Team`, `TeamMember`, `Task`, and `Review` rows, never a provider's files or role vocabulary. It contributes one opaque, read-only-by-default project per team. Its `ProjectVM.teamProject.columns` maps open to todo, claimed/working to in-progress, review to in-review, done to shipped, and blocked to in-progress while preserving the task state. Owner, reviewers, priority, and activity are resolved from the canonical snapshot. Task briefs, review notes, inbox bodies, paths and report references are excluded. The actor-specific projects view hides these project cards and denies their detail without `teams.read`.

`ProjectCardVM` matches api.md except the thumb. The thumb uses `repo.image` when `kind` is `screenshot` or `opengraph` and `url` is https; otherwise `monogram`, with `url: null`. `initials` and `accent` are always present (see the `repo.image` shape above). ProjectCovers are not used. Card flags follow the ProjectCard README and the “3 + risks” note: every unacked, uncleared risk, then up to 3 other flags (priority, feature, label). `hiddenCount` is the rest of the non-risk flags. An acked risk is omitted from the card, not counted in `+N`. People: 4 visible, then `hiddenCount`.

`FlagVM` keeps the feature `state` (`on` | `off` | `unknown`). A risk carries `removable: true` only for manual `blocked`. A label is always `removable: true`. Priority and feature flags are not removable. `addFlag` accepts only `{ kind: 'label', label }` and `{ kind: 'risk', key: 'blocked' }`; anything else is `validation_failed` with `issue: 'flag-not-writable'`. `removeFlag` on a feature, on priority, or on an automatic risk is `issue: 'flag-not-removable'` (400). An unknown key is 404. A duplicate label and a second Bloqué are no-ops.

`buildProjectVM(project, historyEvents, options)` is the detail page and matches `project-vm.json`. Flags there include acked risks and follow LabelChip order (priority, risk, feature, label). Cleared risks stay on the canonical project and off the VM. `archived` is a boolean; `archivedAt` is not on the VM. `repo.branch` duplicates `defaultBranch`. `repo.image` is copied onto `RepoVM` (the same four fields as the thumb, without `repoLabel`). `sources[].ref` is the stored ref, or `null` for a manual source. `sources[].sessionCount` comes from `options.sessionCounts` (`repository.sourceStats`). History is `recentHistory` plus `historyNextCursor` (`options.nextCursor`).

`presentHistory` groups adjacent commits by the same actor and branch, and adjacent flow/cron runs with the same job and outcome. `group` is the number of raw events in that row. The cursor is still over raw events, so a group can be split across pages. `buildHistoryPage(events, options)` is `{ items, nextCursor }` and matches `history-page.json`.

A stale `expectedRevision` throws `conflict` with the message « Le projet a changé entre-temps. » and the current revision. `projectConflictBody({ requestId, vm })` is the api.md §2.2 envelope: `error.current` is `{ revision, vm: ProjectVM }` and matches `error-409-project.json`. `requestId` comes from the route. A repo already linked (`source-in-use`) stays a 409 without `current`.

## History kinds for the CHECK

`STORAGE_HISTORY_KINDS` is the list in data-model.md §9.6 as it stood at P1. The module writes these as well. Please put these payloads in the union and the SQL `CHECK`, in place of the split kinds in the current §9.6 draft (`restored`, `people-override`, `flags-updated` as added/removed arrays):

| Kind | Payload |
| --- | --- |
| `renamed` | `{ from, to }` |
| `risk-unacked` | `{ key }` |
| `archived` | none — the project was archived |
| `restored` | none — the project was restored. Neither kind moves `lastActivityAt` |
| `people-override` | `{ personId, role, hidden }` — `role` may be null; both fields are always written |
| `flags-updated` | `{ flags: [{ key, state }] }` — one event per scan whose key/state set changed; actor is `{ kind: 'system', component: 'engine' }`. This is the one payload that still differs from data-model §9.6 (see proposals) |

`blocked` set by hand writes both `flag-added` and `risk-raised`. Removing it writes `flag-removed`. Auto risks cannot be deleted; they clear.

## Discovery and import

`proposeCandidates({ now, github, workspaces, sessionGroups, owners })` is pure.

- A workspace folder joins a GitHub repo when `git remote get-url origin` is `git@github.com:owner/repo` or `https://github.com/owner/repo` (a trailing `.git` is ignored). Clones that share any other remote join one workspace candidate. A folder whose owner is outside the allow-list is dropped. A `gitlab.com`, `gitea.com`, or `gitea.io` remote is not fetched and is not turned into a GitHub source: the folder stays a workspace candidate, and `notices` on the returned array records `{ host, remote, issue: 'not-supported', key: 'candidateNotice.host-not-supported' }`. `formatTable` prints that line. The candidates VM does not gain a field.
- A worktree with no remote joins the candidate whose slug is the longest prefix of its folder name (`pivot-billing` → `pivot`, `Clover-KDS-wip` → `Clover-KDS`), or the candidate with the same slug. The parent must already exist; two suffixes without a parent stay separate.
- Folder names in the ignore list are not candidates and are not walked. The default is `claude`, `codex`, `cursor` (`ignoreNames` replaces it; an empty list ignores nothing). A path is ignored when any segment matches, case-insensitively.
- A session group joins a bucket when its name or slug is similar to exactly one bucket slug. Similarity strips a trailing `-web`, `-app`, `-site`, or `-repo`, requires length at least 3, and rejects stop words (`main`, `src`, `app`, …). Any other group, including an ambiguous one, becomes its own candidate with key `sg:group:<groupId>`. A catalog row `{groupId, name, sessionKeys, lastActivityAt}` (or `{id, name}`, or a name alone) becomes `{by:'group', groupId, name}`. `groupId` is `groupId`, else `id`, else the name. The session-key list is not copied onto that ref, so later members join by `session.group`. `{by:'keys', sessionKeys}` is used when the caller already passed that ref, or when the row has keys and no group id or name. `interlocutorId` is still accepted.
- Owners default to `alexdeg92`. Other owners are dropped.
- Each candidate has `confidence` (`high` | `medium` | `low`) and a French `reason`. GitHub `archived` → `shipped`, high, « Le dépôt GitHub est archivé. » Activity within 14 days → `in-progress`, high. Between 14 and 180 days → `todo`, medium. Older than 180 days → `todo`, low, and the reason says there is no sign it was shipped. No timestamp → `idea`, low. Staleness never suggests Livré.
- Labels come from the description and topics only: `client` (client, customer, contrat), `perso` (perso, personal, hobby), `site web` (site web, website, homepage, blog).

`importCandidates(repo, { candidates, keys?, overrides?, actor, at })` creates one project per accepted candidate (`keys` omitted means all). It returns the command result `{ ok: true, result: { created, skipped }, revision: null, vm: null }`. `created` is `{ key, id }[]`. `skipped` is `{ key, reason }[]` with `reason` one of `unknown`, `exists`, `validation_failed`. `overrides[key]` may set `name`, `status`, and `labels` (those labels replace the suggested ones). Actor defaults to `'owner'`. Sources and labels are written in that create. `lastActivityAt` stays the candidate’s last activity so a seeded board does not look like everything happened at import time; `createdAt` and the history timestamps are the import time. A GitHub repo already on an active project is skipped (`reason: 'exists'`). An unknown key is `reason: 'unknown'`. A candidate that fails validation is `validation_failed`. One bad candidate does not roll back the ones already imported.

`buildCandidatesVM(candidates, { scannedAt })` is the review screen and matches `candidates-vm.json`. It does not read the store. `id` is the candidate key. `suggestedStatus` is the stored suggestion (`status` on the candidate object). `labels` are display strings. Each source is `{ kind, label, ref }`.

Collectors (`collectGithubRepos`, `collectWorkspaceFolders`) take an injected `exec`. `listGitDirs(root, ignoreNames)` is a read-only walk, depth 2, skipping `node_modules`, dot directories, and the ignore list, returning relative paths of folders that contain `.git`. It does not follow symlinks.

`node scripts/projects-discover.js --owner alexdeg92 --root <abs> [--sessions groups.json] [--ignore claude,codex,cursor]` is a dry run. It prints JSON on stdout and a French table (name, suggested status, confidence, reason, sources) on stderr. Both the table and the printed `confidence` field use `haute`, `moyenne`, or `faible`. The in-process candidate still uses `high` | `medium` | `low`. It does not import, open the store, write a file, or talk to the gateway. Session groups are whatever is in `--sessions`. `--owner` and `--root` are both required; if either is missing the script exits before `gh` or `git`. Do not point `--root` at `~/.openclaw`.

## Candidates on the wire

The board is seeded from a review screen, never by an automatic import. These two routes are not mounted. They use the same `Ok<T>` envelope as the other v2 routes. Neither carries `expectedRevision`: import creates projects. The shapes are `candidates-vm.json` and `import-result.json` (api.md §3.14 and §5.4).

```ts
interface CandidateVM {
  id: string;                              // same as key
  key: string;
  name: string;
  summary: string;
  suggestedStatus: ProjectStatus;
  confidence: 'high' | 'medium' | 'low';
  reason: string;                          // French, shown next to the suggested column
  labels: string[];
  sources: { kind: 'github' | 'workspace' | 'sessionGroup' | 'manual'; label: string; ref: ProjectSourceInput['ref'] }[];
  lastActivityAt: Ms | null;
}
interface CandidatesVM { scannedAt: Ms; candidates: CandidateVM[] }
```

| Command | Route | Body | Result |
| --- | --- | --- | --- |
| List candidates | `GET /api/v2/views/project-candidates` | — | `Ok<CandidatesVM>` from `buildCandidatesVM`. Read-only. The server runs discovery; the browser does not call `gh` or `git` |
| Import | `POST /api/v2/projects/import` | `{ keys: string[]; overrides?: Record<string, { name?: string; status?: ProjectStatus; labels?: string[] }> }` | `Ok<CommandResult<{ created: { key: string; id: ProjectId }[]; skipped: { key: string; reason: 'unknown' \| 'exists' \| 'validation_failed' }[] }>>`. `revision` is null (many projects). `vm` is null; the client refetches the board |

`labels` in an override are display strings. The server slugifies them. A key that is not in the latest candidate list is `unknown` and is not created. Owner’s cookie only. Timmy cannot import.

## Timmy’s command surface (draft — not installed)

Nothing in this draft is installed. `~/.openclaw` stays untouched until Owner approves the install. The domain module still does not check a bearer; that check belongs on the route layer. Owner’s cookie keeps every command. A Timmy token is a different principal.

**Machine authentication.** A scoped API token, stored outside the repo at `~/.config/agent-office-timmy.token` (mode 600). OpenClaw injects it as `AGENT_OFFICE_TOKEN`. The server stores only a hash, plus a token id, `createdAt`, and `revokedAt`. The raw token is never logged, never put in an audit row, and never committed. Revocation sets `revokedAt`; the next request is 401. Replacing the file and the hash rotates it.

The token may call only these project commands, and the route forces `{ kind: 'agent', agentId }` from the token. The token is accepted only when that id is the primary agent from the resolver. A body `actor` is ignored.

| Command | Route | Body |
| --- | --- | --- |
| `setStatus` | `PUT /api/v2/projects/:id/status` | `{ expectedRevision, status }` |
| `reorder` | same route | same body. An `index` is `validation_failed`. There is no stored column position |
| `appendHistory` | `POST /api/v2/projects/:id/history` | `{ expectedRevision, kind, dedupeKey?, eventAt?, …payload }`. Kinds `commit`, `flow-run`, `cron-run`, `session`, `agent-action` only. A repeated `dedupeKey` is a no-op. The revision is checked and not incremented |
| `addLabel` | `POST /api/v2/projects/:id/flags` | `{ expectedRevision, kind: 'label', label }` |
| `editSummary` | `PATCH /api/v2/projects/:id` | `{ expectedRevision, summary }` only. `name` and `priority` on this token are 403 |

Anything else is 403 `issue: 'token-scope'`: archive, restore, rename, priority, Bloqué, risks, people, import, candidates, feature flags, and every non-project area (logs, skills, health, gateway, office, chat, access, env). The token cannot read secrets. It also cannot `GET` the board or a project; the revision has to be one Timmy already has. A scoped read would be a separate approval.

Rate limit: 30 requests per minute per token, then 429 `rate_limited`. Every call is audited like the other project commands (`actor`, command, project id, outcome, `requestId`). The audit row does not store the body or the token.

The draft skill is `integrations/openclaw-skill/projets/` (`SKILL.md` plus `scripts/projets.js`). It only builds those five requests. Tests run it against a fake server. Copying it into OpenClaw is the install step, and this draft does not do that.

## Proposals for api.md and data-model (R3)

Read against contract 2.0 (architect-03). The module matches §5.4 on revision scope, `ProjectSourceInput`, flag issue codes, and no-ops. These are the remaining deltas to land. I am not editing those files.

**R3-05 — history payloads.** Adopted from §9.6, with one exception:

| Kind | What this module writes | Confirm |
| --- | --- | --- |
| `renamed` | `{ from, to }` | yes |
| `risk-unacked` | `{ key }` | yes |
| `archived` / `restored` | no extra fields. Neither moves `lastActivityAt` | yes |
| `people-override` | `{ personId, role, hidden }` — `role` is `string \| null`, `hidden` is always present | yes, as a complete payload of the optional fields |
| `flags-updated` | `{ flags: [{ key, state }] }`, sorted by key, only when the key/state set changes. Actor `{ kind: 'system', component: 'engine' }` | **not** `{ flagKind: 'feature', added, removed }` |

`added` / `removed` cannot record an on→off flip of a key that stays. Please change §9.6 and the SQL `CHECK` to the `flags` array. I did not invent a mapping onto `added`/`removed`.

**R3-06 — Bloqué is not activity.** §9.1 lists every `flag-added` / `flag-removed` as meaningful, and the §5.4 table marks Set Bloqué and every flag delete as moving `lastActivityAt`. The prose in the same section says risk bookkeeping never moves the clock. The module follows the prose: those two events move the clock only when `flagKind` is `label`. Setting or removing Bloqué writes history and does not move `lastActivityAt`. Please narrow §9.1 and set those two table cells to **no** (label delete stays **yes**). `ingestActivity` uses each event’s own `at`, and `movesActivityClock` ignores risk events if one is ever passed in.

**R3-04 — two system cases to name.** `appendHistory` checks `expectedRevision` and does not increment it (a note must not 409 a drag). `replaceFeatureFlags` does not check a revision and increments when the key/state set changes, same rule as the risk monitor. Please add the scanner next to the monitor in §9.1. `source-in-use` stays 409 with `revision: null` and no `error.current`.

**R3-12 and R3-13.** Accepted as written in api.md §5.4 and data-model §9.2 / §9.4. `issue` values in this module: `server-owned`, `source-in-use`, `owner-not-allowed`, `flag-not-writable`, `flag-not-removable`.

**R3-19 — accepted, with the clock rule above.** engine.md §7 and storage.md §5 are the ownership we implement: `project-activity.js` calls `ingestActivity`, the monitor calls `applyProjectRisks`, both only through the repository, and the store publishes one batch per commit (`{ source: 'store', type, op, id, projectId? }`). The derivation must not set `lastActivityAt` itself. The store update of `last_activity_at` has to use the whitelist in “Activity clock”, including the label-only flag rule, not the maximum over every history row. The scanner is the third system caller (`replaceFeatureFlags`). Registry `ChangeSet`s stay on `engine.on('change')`.

## Service facade (S7 / S15)

`createProjectService({ repository, clock, ids, sources, capturer, engineRegistry, publish })` is the surface the architect mounts. It does not open SQLite, speak HTTP, or construct a live `gh` / `git` exec. The store repository is the `repository` (one `withTx` per public method). `publish(changeSet)` runs after that commit. The SSE layer forwards `changeSet.topics` and does not decide them.

```js
const { createProjectService } = require('./src/projects');
const projects = createProjectService({
  repository, clock, ids, sources, capturer, engineRegistry, publish,
});
```

| Facade | Route | Repository method |
| --- | --- | --- |
| `views.board({ filter })` | `GET /api/v2/views/projects` | `listProjects` |
| `views.project({ id })` | `GET /api/v2/views/projects/:id` | `getProject` + `getHistory` |
| `views.candidates()` | `GET /api/v2/views/project-candidates` | none (discovery only) |
| `views.history({ id, cursor, limit })` | `GET /api/v2/views/projects/:id/history` | `getHistory` |
| `commands.create` | `POST /api/v2/projects` | `createProject` |
| `commands.edit` | `PATCH /api/v2/projects/:id` | `edit` |
| `commands.setStatus` | `PUT /api/v2/projects/:id/status` | `setStatus` |
| `commands.setArchived` | `PUT /api/v2/projects/:id/archived` | `setArchived` |
| `commands.addFlag` | `POST /api/v2/projects/:id/flags` | `addFlag` |
| `commands.removeFlag` | `DELETE /api/v2/projects/:id/flags/:kind/:key` | `removeFlag` |
| `commands.ackRisk` | `PUT /api/v2/projects/:id/flags/risk/:key/ack` | `ackRisk` |
| `commands.linkSource` | `POST /api/v2/projects/:id/sources` | `linkSource` |
| `commands.unlinkSource` | `DELETE /api/v2/projects/:id/sources/:sourceId` | `unlinkSource` |
| `commands.setPersonOverride` | `PUT /api/v2/projects/:id/people/:personId` | `setPersonOverride` |
| `commands.appendHistory` | `POST /api/v2/projects/:id/history` | `appendHistory` |
| `commands.importCandidates` | `POST /api/v2/projects/import` | `importCandidates` |
| `commands.regenerateSummary` | `POST /api/v2/projects/:id/summary/regenerate` | `claimSummary` (internal turn identity only) |
| `commands.abandonSummary` | none (the route calls it when the agent turn fails, is empty, or is dropped) | `abandonSummary` (internal turn identity only) |
| `commands.completeSummary` | none (the route calls it when the agent turn returns text) | `completeSummary`, only if the turn id and revision still match |
| `refresh(changeSet)` | engine change, or a timer | repo refresh, `ingestActivity`, `applyProjectRisks` |

A command calls exactly one repository method. That method is the transaction. Import is the exception the API already states: `importCandidates` commits each created project inside that one call, so one bad candidate does not roll back the others. A no-op still enters the method and publishes nothing. A thrown `ProjectError` publishes nothing. A 409 whose `revision` is set gets `err.body` from `projectConflictBody` (`error.current.vm` is the current `ProjectVM`). `source-in-use` stays a 409 with `revision: null` and no body.

The 200 body is `CommandResult`. `result` is `null` except import (`{ created, skipped }`) and summary regeneration (`{ turnId }`). `vm` is the fresh `ProjectVM` for a single project, and `null` for import. `revision` is the project revision, or `null` for import. Regeneration checks `expectedRevision` and stores one pending turn per project in `projects.summary_turn` (migration 016), without changing the public project revision/history. The identity survives store and service restarts. Comment-driven acceptance claims it with the delivery insert before 202; the comment worker uses the same guarded completion with the current revision to allow intervening tag changes. A child fallback keeps that identity until the parent settles or the delivery expires. A second call while that turn is pending is 409 `issue: 'turn-pending'`. The pending turn clears when `commands.edit` changes the summary, when `commands.completeSummary({ id, turnId, expectedRevision, summary })` applies that turn, or when `commands.abandonSummary({ id, turnId })` is called with that turn's id. Completion writes the summary only when `turnId` is still the pending turn and `expectedRevision` is still the project revision (the revision returned when the turn was accepted). Otherwise it drops the reply: no write, and a newer pending turn stays. Abandon clears only the internal identity: the revision, summary and history stay, and nothing is published. A different `turnId`, or a second call, leaves the pending turn as it is. The architect answers 202 and runs the agent turn; this module does not. A failed or empty turn, or a dropped completion, calls abandon for that turn id only.

`candidates()` remembers the list it just proposed. Import treats any other key as `skipped: unknown`. Empty `keys` is 400 `empty-selection`. An override for a key that was not selected is 400 `override-not-selected`. Both fail before the repository call.

A change set is `{ at, projectIds, topics }`. `topics` is only what that write can change:

- `projects` when the project is on the active board before or after
- `projects?filter=at-risk` when it is on that board before or after (uncleared risk, not archived)
- `projects?filter=with-timmy` when Timmy is on it before or after
- `projects?filter=archived` when it is archived before or after
- `project:<id>` for each changed project

`refresh(changeSet)` is what the architect calls from the engine bus. A change whose types are outside `Session`, `CronRun`, `CronJob`, `Transcript`, `Activity`, `Agent` and `Repo` returns immediately. Anything else, and a call with no `changes` (the timer), does three steps: refresh each linked GitHub repo through the injected source and `capturer` (the 10-minute gate still applies), link sessions and cron runs from `engineRegistry`, then `applyProjectRisks`. Each of those writes is its own repository transaction. One change set is published at the end if anything changed. Session snapshots stay on `putSessionSnapshot`; the refresh writes history, not the live membership cache.

`sources` is `{ github?, exec?, owners?, owner?, root?, resolve?, githubRepos?, workspaceFolders?, sessionGroups? }`. `github` is a `{ fetch }` adapter (otherwise `exec` builds `createGithubSource`). Discovery prefers `githubRepos` / `workspaceFolders` / `sessionGroups` and only then calls `gh` or walks `root`. `ids.mint(prefix)` mints the summary turn id; the repository mints everything else. `clock()` is the command time when the caller does not pass `at`.

Map `ProjectError.status` onto the api.md envelope. Do not import this package from a request path that builds a real `gh` exec without the owner allow-list.

## Portability (P13) — proposal, waiting on the ADR

`ActorRef` stored on history stays `{ kind: 'agent', personId }`. A command actor `{ kind: 'agent', agentId }` resolves to that agent's Person, and the shorthand `timmy` is refused. A stored actor string `timmy` is mapped to that Person on read. The v2 board filter stays `with-timmy`. `alexdeg92` is not a default owner: an empty allow-list refuses every repository (`owner-not-allowed`). Callers pass `githubOwners`. With `portability: true`, the board also accepts `with-agent`, and risk labels and candidate reasons are label keys. GitHub is a `CodeHostProvider` (`gitlab` and `gitea` report `not-supported`). `Project`, `Flag`, `Person`, `HistoryEvent` and `ProjectSource` are `defineEntity` classes; the repository admits each stored value through them and still returns the schema value.

### Instance config

| Setting | Today | Proposed |
| --- | --- | --- |
| Code-host owners | `DEFAULT_GITHUB_OWNERS = ['alexdeg92']` in `constants.js`, used whenever `createGithubSource`, `parseGithubRef`, `parseSourceInput`, `discoverProjects`, or the memory repository is called without owners. `src/config.js` repeats that fallback when `AO_PROJECTS_OWNERS` is unset | No personal default. `AO_PROJECTS_OWNERS` is a comma-separated allow-list. Empty means no repository can be linked or discovered (`owner-not-allowed`). Callers pass the list in. The constant goes away |
| Workspace roots | One root: `createWorkspaceSource({ root })`, and `AO_PROJECTS_ROOT` falling back to `$HOME/dev/project`. A workspace ref is `{ path }` and its identity is that relative path | `AO_PROJECTS_ROOTS` is a list of `{ id, path }`. `id` is a stable slug (`rootId`), configured, not derived from the path. The ref is `{ rootId, path }`. See R12-10 below. The `$HOME/dev/project` fallback goes away |

`src/config.js` is the architect’s. This module will read `owners` and `roots` from the injected `sources` bag (`sources.owners`, `sources.roots`) and will not invent either.

### Workspace root identity (R12-10)

Two configured roots can each contain `app`. A ref that is only `{ path: 'app' }` cannot say which root, and both candidates share the key `ws:app`. G1.1 has to put `rootId` on the stored source, on discovery and import, and on activity matching, and the examples have to move with it. Until that ADR, the stored schema still rejects a `rootId` (`extra: 'reject'` on `{ path }`).

The code is behind `workspaceRootIds` (default **off**), on the memory repository and therefore on the service:

| Flag | Ref stored and proposed | Identity | Activity |
| --- | --- | --- | --- |
| off | `{ path }`. A `rootId` on input is dropped | `path`, as today | The relative path, as today |
| on | `{ rootId, path }` | `rootId/path`. `team-a/app` and `team-b/app` are different sources and different candidate keys | The session cwd must mention that root’s absolute path plus the relative path. `app` alone matches neither |

`workspaceRoots` is `[{ id, path }]`, absolute paths, unique ids and unique paths. `id` matches `^[a-z0-9][a-z0-9-]{0,47}$`. With one configured root, a legacy `{ path }` input is stored under that root’s id. With two or more, a missing `rootId` is `root-required`. `createWorkspaceSource({ workspaceRootIds: true, roots })` resolves and checks git containment against the selected root only. `sources.roots` is the same list when the repository flag is on; `sources.root` remains the single-root path while the flag is off.

### Agent actor

The command actor is `owner`, `{ kind: 'agent', agentId }`, or `system`. `resolveActor('timmy')` is refused. `appendHistory` defaults a missing actor to `{ kind: 'agent', agentId }` for the resolver's agent, or for `timmyPersonId` when no resolver is wired. The board filter and the SSE topic stay `with-timmy`. That filter follows the resolver's agent.

Proposed command actor, resolved by the runtime adapter before the domain call:

```ts
type CommandActor =
  | { kind: 'human'; personId: PersonId }
  | { kind: 'agent'; agentId: AgentId }
  | { kind: 'system'; component: 'engine' | 'risk-monitor' | 'scheduler' };
```

`agentId` is the configured or discovered agent. It is not the string `timmy` and it is not assumed to be `main`. The string `timmy` remains only in fixtures (a person whose display name is Timmy). The token route forces `{ kind: 'agent', agentId }` from the token’s agent instead of `actor: 'timmy'`.

Canonical history today stores `ActorRef` with `personId` (data-model §0). This proposal does not change that row until the ADR chooses one of these:

1. The route resolves `agentId` to the agent’s `Person` and history keeps `{ kind: 'agent', personId }`. The domain never sees the shorthand.
2. `ActorRef` gains `agentId` on the agent arm, and `personId` is derived. That is a stored-shape change, so examples move first.

`timmyPersonId` on the repository becomes the person id of that resolved agent (`primaryAgentPersonId`). The filter id `with-timmy` and the topic `projects?filter=with-timmy` are shared with the SSE layer and the examples. Proposed id: `with-agent`, with the old id accepted until the examples move. Not renamed here.

### Code-host providers

GitHub stays the only host that fetches. The ADR should put it behind a provider so GitLab and Gitea can be added without another source kind each:

```ts
interface CodeHostProvider {
  id: 'github';                 // 'gitlab' | 'gitea' only after the ADR and new examples
  parseRef(ref, owners): { owner: string; repo: string };
  fetch(ref, ctx): Repo;        // same cached repo the refresh path stores today
  webUrl(ref): string;
  openGraphUrl(ref, stamp): string | null;
}
```

`createGithubSource` becomes the `github` provider. `refresh` calls `provider.fetch` and does not know about `gh`. Suggested source shape, once examples can change: keep `kind: 'github'` working, and add `kind: 'repository'` with `ref: { provider, owner, repo }` rather than a new kind per host. Until that example lands, `SOURCE_KINDS` stays `github | workspace | sessionGroup | manual`.

### French literals

View-model history text is already a `LabelRef` (`historyKind.*`, `projectStatus.*`, `risk.*`). These places still embed French outside that dictionary. None of them move until the ADR, because several are on a VM or a stored payload the examples already fix.

| Site | French today | Proposed key | Shared? |
| --- | --- | --- | --- |
| `labels.js` `RISK_LABELS` / `riskLabel`, stored on the Bloqué flag and returned as `FlagVM.label` | `Bloqué`, `Flow en échec`, `Cron en échec`, `CI rouge`, `Inactif depuis {n} j` | `risk.<key>` (already in `src/i18n/fr.js`). `FlagVM.label` for a risk becomes a `LabelRef` | yes — examples show a string label |
| `labels.js` `STATUS_LABELS`, dry-run stderr only | `Idée`, `À faire`, `En cours`, `En revue`, `Livré` | `projectStatus.*` (already in `fr.js`) | no |
| `labels.js` `CONFIDENCE_LABELS`, dry-run stderr only. Stored confidence stays `high` \| `medium` \| `low` | `haute`, `moyenne`, `faible` | `confidence.high` \| `confidence.medium` \| `confidence.low` | keys are new |
| `discovery.js` `reason` on `CandidateVM`. `statusBecause` is already a token | `Le dépôt GitHub est archivé.`, `Aucune activité connue.`, `Activité dans les {n} derniers jours.`, `Pas d’activité récente.`, and the shipped-quiet sentence | `candidateReason.<statusBecause>` with `{ n }` | yes — `reason` is a string on `CandidatesVM` |
| Discovery label suggestions | display `client`, `perso`, `site web` | slug `personal` (not `perso`); label key `candidateLabel.client` \| `.personal` \| `.website` | yes if the label string is part of the example |
| `vm.js` `actorVm` / `personName` | `Système`, `Quelqu’un` | `actor.system`, `actor.unknown` | yes — examples use `name: "Système"` |
| Git author stored when the name is an email | `inconnu` | `name: null` | yes — author shape |
| `ProjectError.message` and `validation()` sentences (`Le projet a changé entre-temps.`, and the rest) | French sentence | `error.project.<issue>` plus the existing `issue` code. The HTTP `error.message` stays the dictionary line | yes — the 409 example carries the sentence |
| Session history when the count is unknown | the sentence « nombre de messages inconnu » is documented; the VM already sends `messages: null` on `historyKind.session` | keep the null; the dictionary owns the sentence | no shape change |

The draft skill under `integrations/openclaw-skill/projets/` stays French. It is agent-facing copy, not a portal view model, and it is not installed.

After the ADR: examples and `src/i18n/fr.js` first, then this module. This note does not add those keys.

## Project covers (covers-1)

`src/projects/covers/engine.js` generates covers locally and deterministically. Classification consumes the
name, summary, labels, status and linked source references. The code renderer uses slug-seeded Bureau motifs
and the project title; it has no dependency, model call, remote font or external image reference. Cover
generation never starts an agent turn or invokes an image, delivery or messaging tool.

The service's `onProjectChanged` hook covers commands, imports and runtime tag discovery. Startup observes
all projects too. A changed name/summary/slug or classified type is debounced for 750 ms, with a single
instance-wide worker and a 60 s limit covering local generation. Stale results are discarded by content fingerprint and
job version, without changing the project revision, history or last-activity clock. Scheduling uses a
monotonic clock. The next startup recovers unfinished work from the persisted fingerprints.

Files live in `<dataDir>/project-covers/media/<sha256>.<svg|webp>`; small metadata records are atomically
replaced in `project-covers/records/<projectId>.json`. Generated code output is self-contained SVG at
480×270 / 160×90. Upload output is normalized to WebP with an optional local ImageMagick converter
(single thread, memory/disk limits, 10 s per conversion). Budgets are enforced at 25 KiB / 6 KiB. Without
that executable, code covers still work and raster upload is unavailable.
Immutable files are retained so old hash URLs remain valid.

Project/card VMs have `cover: null | {url, thumbUrl, source: 'agent'|'code'|'upload', generatedAt}`.
When present, `thumb.kind` is `cover` and `thumb.url` is the full cover. Desktop/detail show it; mobile
cards use `cover.thumbUrl`. Cover media URLs use the configured public origin/API prefix, with a local
API path fallback for instances without a public origin. Each image has lazy loading and explicit
intrinsic dimensions. `upload` marks an intentional override and keeps priority across automatic
refreshes and regeneration requests.

Authenticated routes (v2 and v3):
- `GET|HEAD /project-covers/:hashFile`: immutable private cache (1 year), SHA-256 ETag, conditional 304,
  content type, `nosniff`, sandbox CSP and bounded hash-verified reads.
- `POST /projects/:id/cover/regenerate {expectedRevision}`: store-class write, 202, `result.queued`.
- `PUT /projects/:id/cover {expectedRevision, image}`: store-class write; `image` is base64 PNG/JPEG/WebP
  (≤48 KiB decoded). The UI scales uploads to 480×270 before sending. An existing manual cover is replaced
  only by another successful upload. Writes are audited as `projects.regenerateCover` / `projects.uploadCover`.

These routes keep the agent-token allowlist unchanged. Store read-only mode refuses regeneration/uploads
and disables backfill; runtime read-only mode permits code covers/uploads but sends no agent turn.

### Durable conversation-source ownership (T-0174)

Stored session-group links have optional private `connectorIds` (canonical runtime instance IDs, at most 20). The SQL repository persists them in `project_sources.connector_ids_json`; source VMs expose only their existing descriptor, never the private provenance. They are supplied by canonical connector/session/group/project-hint ownership at creation, link, import, and engine refresh, and survive session retention or an application restart. Mixed-instance links retain each proven owner; projects count once per connector.

Migration **030** stamps links whose `addedAt` predates migration 019's multi-runtime checkpoint with its canonical `legacy` instance. It does not assign later unknown links. Append-only history is unchanged. Existing scoped references remain proof of their registered instance even if their session has expired. For `projet:<slug>` links without surviving hints, exactly one registered connector declaring `capabilities.projectHints=true` is sufficient provenance; the service persists that decision at boot/refresh/link time and logs counts only. With zero or multiple producers the tag stays unresolved. Exact scoped/hint ownership and existing persisted owners take priority over this capability fallback. A genuinely unresolved native reference in a multi-runtime registry keeps the generic Conversations label; neither provider names nor arbitrary active/default instances are used as ownership evidence. Metadata comes from the registered connector instance and adapter declaration. Caller-provided provenance is discarded by the source-input parser.
