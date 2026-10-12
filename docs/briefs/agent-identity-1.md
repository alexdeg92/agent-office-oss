# agent-identity-1: every agent has a real name and a « what it's doing » description — P0

Owner (2026-10-10), on live prod after the Claude Code fix (captures: design/reports/agent-names-before-office.png, agent-names-before-drawer.png): "make sure each agent does have a name, and when we press on it or in the list of agents we can see the description of what they do in their session."

## Today (defects in the captures)
- Claude Code sessions are labelled with the bare project folder: two cards and two desks both read « agent-office-portal »; others read « project », « workspace ».
- The drawer shows a raw `rt:claude-code:session:…` blob as « Session », « Tokens 0 », and only « Idle for less than a minute ». No hint of what the session is about.

## Target (runtime-agnostic: canonical fields, adapters fill them)
1. **Canonical `displayName` + `summary` on Agent** (engine model, not Claude-specific). Adapters supply:
   - Claude Code: `ai-title` line (latest) → summary/title; fall back to the first user prompt's first line (bounded, sanitized) — never the full prompt. Project folder becomes a secondary label (« dans agent-office-portal »).
   - OpenClaw: the agent's configured name/role/description; the session's label/task for subagents.
   - Codex/herdr/teams (T-0045): pane/agent name + role/task title when available.
2. **Unique, human names:** no two visible agents share a label. Name = title when present (truncated ~32 chars), else project + short disambiguator (« agent-office-portal · 2 »). Owner rename (existing Customize) always wins.
3. **Office label + roster card:** name on line 1; line 2 = role or the session summary (one line, ellipsis). Desk labels show the name only.
4. **Drawer:** a « En cours » / « Ce qu'il fait » section with the summary (2–4 lines), project, runtime, model if known, started/last activity, tokens when the adapter knows them (hide the row rather than show 0 when unknown). **Remove the raw session id** from the main view (copyable under « Détails techniques », collapsed).
5. **Privacy/RBAC:** summaries are transcript-derived: declare them under the transcripts/sessions read permission (T-0031 registry); redaction pipeline applies; users without read see the name and status only. Bounded size, no secrets (run through the existing redactor).
6. Scale: works for N agents; titles cached per session with mtime; no extra full-transcript reads (reuse the tail window).

Tests: adapter unit tests (ai-title, fallback, duplicates → unique names), VM/projection permission test, browser test on roster + drawer (no raw id, summary visible, no « 0 » tokens when unknown), FR/EN copy.
Reviewers: designer (drawer and card), critic, security (privacy of summaries).
