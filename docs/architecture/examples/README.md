# Contract examples (api.md 2.1)

**Authoritative example payloads** for every VM and command shared across agents (PM decision on review-07).
They are the wire contract in executable form. Only the architect edits them.

- **Producers** (projects, architect) assert their builders' output has the same shape:
  `compareShape(loadExample('project-vm').data, buildProjectVM(...))` from `test/helpers/contract-shape.js` returns `[]`.
- **Consumers** (frontend, office-dev) build their mocks FROM these files.
- **A shape change** means: example + api.md changelog first, then producers and consumers.

| File | What | api.md |
| --- | --- | --- |
| `project-vm.json` | `GET /api/v2/views/projects/:id` → `Ok<ProjectVM>` | §3.9 |
| `board-vm.json` | `GET /api/v2/views/projects` → `Ok<BoardVM>` | §3.9 |
| `history-page.json` | `GET /api/v2/views/projects/:id/history` → `Ok<Page<HistoryItemVM>>` | §3.9 |
| `comment-thread-vm.json` | `GET /api/v2/views/projects/:id/comments` → `Ok<CommentThreadVM>` (architect-57; topic `comments:<id>`) | §3.9 |
| `candidates-vm.json` | `GET /api/v2/views/project-candidates` → `Ok<CandidatesVM>` | §3.14 |
| `import-request.json` | `POST /api/v2/projects/import` request body | §5.4 |
| `import-result.json` | its response → `Ok<CommandResult<ImportResult>>` | §5.4 |
| `error-409-project.json` | any project write with a stale `expectedRevision` → `ApiError` with `current.vm: ProjectVM` | §2.2, §5.4 |
| `office-vm.json` | `GET /api/v2/views/office` → `Ok<OfficeVM>` | §3.2 |
| `layout-vm.json` | `GET /api/v2/office/layout` → `Ok<LayoutVM>`; `layout.data` / `default.data` are `design/office/layout.example.json` and `manifest` is a snapshot of `design/office/manifest.example.json` (opaque; the test enforces the same `version`) | §3.10 |
| `health-vm.json` | `GET /api/v2/views/health` → `Ok<HealthVM>` (S6: the server's builder asserts this shape) | §3.8 |
| `session-vm.json` | `GET /api/v2/views/sessions/:key` → `Ok<SessionVM>` | §3.6 |
| `logs-page.json` | `GET /api/v2/views/logs` → `Ok<Page<LogRowVM>>` (S7b) | §3.6 |
| `flow-list-vm.json` | `GET /api/v2/views/flows` → `Ok<FlowListVM>` (S7b) | §3.4 |
| `flow-detail-vm.json` | `GET /api/v2/views/flows/:jobId` → `Ok<FlowDetailVM>` (S7b) | §3.4 |
| `access-vm.json` | `GET /api/v2/views/access` → `Ok<AccessVM>` (S7b) | §3.5 |
| `interlocutor-vm.json` | `GET /api/v2/views/interlocutors/:id` → `Ok<InterlocutorVM>` (S7b) | §3.5 |
| `skill-list-vm.json` | `GET /api/v2/views/skills` → `Ok<SkillListVM>` (S7b) | §3.7 |
| `skill-detail-vm.json` | `GET /api/v2/views/skills/:name` → `Ok<SkillDetailVM>` (S7b) | §3.7 |
| `setup-vm.json` | `GET /api/v2/setup` → `Ok<SetupVM>` (G4) | §5.7 |
| `setup-check-request.json` / `setup-check-result.json` | `POST /api/v2/setup/check` | §5.7 |
| `setup-discover-result.json` | `POST /api/v2/setup/discover` (request = check's) | §5.7 |
| `setup-save-request.json` / `setup-save-result.json` | `PUT /api/v2/setup` | §5.7 |
| `error-403-setup.json` | any setup route with a wrong `setupCode` | §5.7 |

**Strict since S6.2 (R8-08/09):** compare with `compareExample(name, value)`, which also applies the example's sidecar `<name>.types.json` (`nullable` paths, `types` of null-only fields, union `variants`, `opaque` paths). Shape rules (see the checker's header): exact key sets, matching types, `null` compatible with any type, array
elements matched by their `kind`/`type`/`op` variant, records (`params`, `labels`, `enums`, `overrides`) by value.
Pass `{ opaque: ['$.data.manifest'] }` for the layout manifest, whose shape is `manifest.schema.json`'s.
