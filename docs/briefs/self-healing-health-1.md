# self-healing-health-1: health that explains and fixes itself, for every connector — P0 (owner, 2026-10-10)

Owner, on prod Santé (capture design/reports/health-errors-before.png, local): "we seem to have errors in those cases, and we should have a self-correcting system able to fix them. Don't forget our backend and engine need to work properly for any type of agent: you cannot make a feature that only focuses on one type of agent. A core feature must be decentralised, with an adapter per provider that canonicalises their data into our canonical types."

## Defects visible in prod
- Raw labels: « Other (claude-code:transcripts) », « Other (core:host) », « Other (unsupported-format) ». Every source/check needs a localized name and plain explanation, from a registry each adapter declares.
- Stale health record: claude-code:transcripts says « unsupported-format · last success never », though the T-0044 parser now reads real transcripts. Health state must be recomputed and cleared when the condition resolves (and on deploy/restart), never sticky.
- « Gateway call failed: legacy:gw.rpc.sessions.list ×6 »: classify (timeout/auth/protocol), retry with backoff, show impact and action.
- « View failed validation core:vm.health $.<undeclared> ×15 »: a real VM/schema mismatch. Fix the producer or the schema, and add a test.
- « Unclassified session ×31,713 » (legacy:gw.rpc.sessions.list $.sessions[].key): session classification must be canonical and adapter-driven. Unknown kinds map to a generic canonical kind with a reason, counted once (not 31k warnings), with an adapter hook to teach new kinds.

## Self-healing engine (runtime-agnostic)
- Canonical **HealthCheck** model: id, source (adapter), severity, cause code, user text key, impact, `remedy` (none | auto | one-click | guided).
- Adapters declare their checks and remedies (OpenClaw, Claude Code, Codex, herdr, …); the core runs a **remediation loop**: auto-remedies run with bounded retries/backoff and an audit log entry (e.g. re-probe, reset cursor, re-scan, reconnect, clear stale state); one-click remedies surface as « Corriger »; guided ones link to the connector page. « Tout corriger » runs every safe remedy.
- Never: restart the OpenClaw gateway or edit ~/.openclaw automatically (owner rule); those stay guided/explicit.
- Santé UI shows problems in plain French: what, impact, what we did, what you can do. Resolved items move to « Résolu automatiquement » with time.

## Principle (applies to every feature from now on)
Core features live in the engine on canonical types. Providers plug in via adapters that canonicalise their data and declare capabilities. No feature or UI branch is specific to one agent type. Reviewers reject provider-specific core code.

Owner of build: office-codex. Reviewers: critic, security, designer (Santé copy/layout). Tests with synthetic adapters (≥2 providers) for each remedy path.
