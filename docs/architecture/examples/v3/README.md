# Contract 3.0 examples (api-v3.md)

Authoritative payloads for **`/api/v3`**, the same role as `../README.md` for 2.x: producers assert their output with
`compareExample`, and consumers build their mocks from these files. Only the architect edits them.

- **VMs that change in 3.0 or later are here** (deltas D1–D8 plus versioned additions). Any other VM's 3.0 example is its 2.x file in `../`.
- **They model a foreign instance**: primary `atlas` « Atlas », a Telegram user, Europe/Paris. No home-instance value appears; `test/api/contract-v3-examples.test.js` enforces that, the 3.0 vocabularies, and that each file differs from its 2.x example in shape **only** by the documented deltas.

| File | What | api-v3.md |
| --- | --- | --- |
| `meta-vm.json` | `GET /api/v3/meta` → `Ok<MetaVM>` (labels and enums are an excerpt) | D1 |
| `office-vm.json` | `GET /api/v3/views/office` | D3 |
| `layout-vm.json` | `GET /api/v3/office/layout` (rules in 3.0 names; manifest opaque) | D4 |
| `logs-page.json`, `session-vm.json` | logs and session views (`kind`, `runtimeKind`, `channel`) | D2 |
| `chat-vm.json` | ChatVM delegated-result and appearance fields | 3.6 |
| `access-vm.json`, `interlocutor-vm.json` | every channel's interlocutors (`kind` user/room + `channel`) | D5 |
| `health-vm.json` | channel ids are ChannelRefs | D6 |
| `flow-detail-vm.json` | `job.agentId` resolved; `job.ext.openclaw` | D7 |
| `board-vm.json` | `filter: 'with-agent'` + `agent` | D8 |
