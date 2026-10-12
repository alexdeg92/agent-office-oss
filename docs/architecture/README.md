# Architecture documents

**Start with `status.md`:** the current state on one page (done, behind flags, deprecated, known gaps).

| Document | What |
| --- | --- |
| `status.md` | Current state map |
| `adr-001-runtime-adapters.md` | **ADR-001**, the platform decision: runtime adapters, open vocabularies, instance config, contract 3.0 (index below) |
| `adr-002-multi-user-rbac.md` | **ADR-002:** multi-user identities, roles/overrides, route policy, filtered views/SSE and revocation |
| `adr-003-split-origin-auth.md` | **ADR-003:** human bearer/refresh auth, SSE tickets, split-origin deployment and setup/Settings access contract |
| `api.md` | The wire contract 2.5 (`/api/v2`): envelopes, errors, views, SSE, commands, setup |
| `api-v3.md` | Contract 3.0 (`/api/v3`): the deltas D1–D10 over 2.5 |
| `migration-v3.md` | Moving the UI from `/api/v2` to `/api/v3` |
| `examples/` | Authoritative payloads (2.x; `examples/v3/` for 3.0; `examples/ops/` for the probes) |
| `data-model.md` | The canonical model |
| `engine.md` | The engine: ingestion, quarantine, sources, LiveEvents |
| `storage.md` | The store: schema, migrations, retention, backups |
| `operations.md` | Health probes, backup and restore, retention policy |
| `go-live.md` | The production profile and checklist |
| `s16-v1-removal.md` | Removing v1 after the rollback window |
| `migration-plan.md` | The original S-step migration plan (historical) |
| `capture-findings.md` | What the OpenClaw capture taught (fixtures, grammar) |
| `projects.md` | Projets (owned by projects) |

## Architecture decisions
| ADR | Title | Status |
| --- | --- | --- |
| **ADR-001** | Agent Office as a platform: runtime adapters, open vocabularies, instance config | **Accepted** (G1, 2026-10-05), amended §12 (R12) and extended §13–§14 |
| **ADR-002** | Multi-user identities and resource permissions | **Accepted**, critic-60/security-40 on `4466b165` (2026-10-10); implementation reviews separate |
| **ADR-003** | Split-origin authentication and the external-access flow | **Accepted**, critic-60/security-40 on `4466b165` (2026-10-10); implementation reviews separate |

### ADR-001 sections
| § | Topic | State |
| --- | --- | --- |
| 1–2 | Context, decision | accepted |
| 3 | The connector interface (adapters) | implemented: `openclaw`, `demo` |
| 4 | Open vocabularies, the label registry | implemented (G3b, G5) |
| 5 | Instance config, languages, packaging | implemented (G3c, G4); leftovers in `status.md` |
| 6 | Tests: the foreign instance, layout | implemented (G3b) |
| 7–8 | Consequences, alternatives | n/a |
| 9 | Contract 3.0 | **served** on `/api/v3` (G5; `api-v3.md` is the contract) |
| 10 | Plan | updated through G9 and S16 |
| 11 | Answers (PM) | n/a |
| 12 | Amendments after review R12 (resolver, open channels, boundary, migrations, projection, time zone, lint) | implemented (G2–G3) |
| 13 | A second adapter (`demo`), what is still OpenClaw-flavoured, what Hermes will need | `demo` done (G6); §13.2 open |
| 14 | Enrichers and channel grammars | implemented (G7) |
