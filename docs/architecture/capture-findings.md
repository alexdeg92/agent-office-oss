# Capture findings: `capture-20261005` (OpenClaw 2026.9.8)

Status: 2026-10-05. Source: `test/fixtures/scenarios/capture-20261005.json`. The capture was taken from the live gateway while Timmy was **idle**: 175 sessions, 10 cron jobs, 75 skills, 2 agents. The analysis covers field names, types and enum values only. Values that the first redaction scrambled are marked *(scrambled)*. The redactor now keeps them (see "Next capture").

The data model ([data-model.md](data-model.md)) and the engine ([engine.md](engine.md)) were updated where the capture contradicted them; the bullets below say what changed.

## Sessions (`sessions.list`, `sessions.describe`)
- **Rich structured fields exist.** Classification should read these first and the key second:
  - `kind`: `direct` ×118, `group` ×57;
  - `classification`: 9 distinct values *(scrambled)*;
  - `isMain`: exactly one, `agent:main:main`;
  - `isBackground`: true ×57;
  - `chatType`, `peerKind` *(scrambled)*;
  - `channel`: `discord` ×122, `whatsapp` ×2, `wechat` ×1;
  - `origin.{provider,surface,chatType,to,from,label,nativeChannelId,nativeDirectUserId,threadId}`;
  - `subagentRole` and `subagentRunState` on 38/81 sessions;
  - `spawnedBy`, `parentSessionKey`, `childSessions[]`, `spawnDepth`;
  - `category`: user-defined labels;
  - `goal{objective,status,tokensUsed,tokenBudget…}`;
  - `participants[]`, `participantCount`;
  - `lastRunId`, `lastRunError`, `runtimeMs`;
  - `estimatedCostUsd`, `inputTokens`, `outputTokens`, `totalTokens`;
  - `channelAvatarUrl`.
- **Key shapes**, by count:

  | count | shape |
  | --- | --- |
  | 52 | `agent:main:discord:channel:<sf>` |
  | **50** | **`agent:main:dashboard:<uuid>`** |
  | 38 | `agent:main:subagent:<uuid>` |
  | 5 | `agent:main:dashboard:<uuid>:heartbeat` |
  | **5** | **`agent:claude:acp:<uuid>`** |
  | 4+3 | `agent:main:explicit:<id>` |
  | 4 | `agent:main:cron:<uuid>` |
  | 2+2+2+1 | `…:heartbeat` suffixes on discord direct and channel sessions and on `main` |
  | 2 | `agent:main:discord:direct:<sf>` |

  - The legacy guess `discord:dm` never occurs. The real segment is `direct`.
  - **`heartbeat` is a suffix on another session, not a kind of its own.**
- **Session `status` values:** `done` ×143, `complete` ×18, `failed` ×12, `active` ×3, `killed` ×2, `timeout` ×2, `budget_limited` ×1. Legacy only knows `running/active/done/failed`.
- **Paging:** `count`, `totalCount`, `limitApplied`, `hasMore`, `nextOffset`. With 175 sessions, the limit of 300 still covers everything.
- **No `portal-chat` key** exists in this capture. The Discuter page's `--session-key portal-chat` most likely lands as `agent:main:explicit:portal-chat`. To confirm after one Discuter message.

**What the legacy code gets wrong** (pinned by the goldens, to fix in S3):
- the 50 dashboard sessions and the 5 ACP sessions are classified `other`, shown as « portail », and labelled with their raw key;
- `channel:<sf>:heartbeat` sessions are labelled « Système ».

## Agents (`agents.list`)
- There are two agents: `main` and `claude-code`. The ACP sessions use the key prefix `agent:claude:` (to confirm).
- `agents.list` also returns `defaultId`, `mainKey` *(scrambled; now kept)*, `scope`, `ownership`, `selectionRequired`, and per agent `model.fallbacks[]`, `defaultPermissionMode` and `workspaceGit`.
- **The main session key should come from `mainKey`,** not the hard-coded `'agent:main:main'`.

## Cron (`cron.list`, `cron.runs`)
- **Schedule kinds:** `cron` ×5 (`expr`, `tz`), **`every` ×3** (`everyMs`, `anchorMs`), **`at` ×2** (`at`: an ISO date string). Legacy `humanCron` shows nothing for `every`/`at`.
- **Payload kinds:** **`agentTurn` ×7** (`message`, `timeoutSeconds`, `model`, `toolsAllow[]`, `lightContext`), **`heartbeat` ×1**, **`command` ×2** (`argv[]`). The synthetic fixture's `message` kind was wrong.
- **`sessionTarget`:** `isolated` ×9, `main` ×1. **`wakeMode`:** `now` ×7, `next-heartbeat` ×3.
- **`delivery.mode`:** `none` ×6, `announce` ×3 (plus `channel` and `to`). **`scheduledToolPolicy.mode`:** `trusted` ×3.
- **Jobs carry their own run state:**
  - `nextRunAtMs`, `lastRunAtMs`;
  - `lastRunStatus` (2 values *(scrambled)*), `lastDelivered`, `lastDeliveryStatus`, `lastRunError`;
  - `deliverySuppressionReason`, `deleteAfterRun`, `sessionKey`, `displayName`, `effectiveAgentId`, `declarationKey`, `configRevision`.

  This means `CronJob.health` can come straight from the job, without fetching runs.
- **`cron.list` metadata:** paging (`total`, `offset`, `limit`, `hasMore`), `snapshotRevision`, and `deliveryPreviews` (keyed by id).
- **Runs** (`entries[]`):
  - `status`: `ok` ×61, `error` ×5; `action`: `finished`;
  - `completionStatus` *(scrambled)*;
  - `runId`, `sessionId` and `sessionKey` on some entries (data-model.md assumed there was no run id);
  - `summary` on some entries and `diagnostics.summary` + `diagnostics.entries[{ts,source,severity,message}]` on others;
  - `delivery.intended.channel` can be **`last`**, which is not a channel id;
  - usage is present only on some entries.

## Skills (CLI)
- **Sources:** `openclaw-bundled` ×49, `openclaw-workspace` ×9, `openclaw-workshop` ×8, `openclaw-extra` ×5, **`openclaw-custodian` ×4**. Workshop and custodian weren't in the model.
- **The list's top level** has `workspaceDir`, `managedSkillsDir` and `skills`.
- **List items have no `homepage` or `missing`:** the legacy `missingBins` is always `[]` from the list. Those fields only come from `skills info`.

## Channels (`channels.status`)
- **Values:** `lifecycle` `stopped|ready`; `healthState` `stopped`; `statusState` `not-linked`; `tokenStatus` `available`; `groupPolicy` `allowlist`.
- **Ids disagree between sources:** sessions say `wechat`, while `channels.status` says `openclaw-weixin`. The channel id needs an alias table.

## Transcripts (`sessions.get`)
- **Roles:** `user`, `assistant`, `toolResult`, **`system`**.
- **Content part types:** `text`, **`thinking`** ×20, `toolCall`, **`observation`** ×25, **`openai_responses_terminal`**, **`agent`**. Legacy `buildTrace` drops everything except `text` and `toolCall`.
- **Per message:** `api` (`openai-chatgpt-responses`, `cli`, `openclaw-transcript`, `openai-responses`), `provider` (`openai`, `claude-cli`, `openclaw`), `stopReason` (`stop`, `toolUse`, `error`), `errorMessage`, `display`, `idempotencyKey`, `responseId`.

## Events and hello
- **Events seen in 60 s** (Timmy idle): only `tick` and `health`. The activity events the legacy code relies on (`session.tool`, `session.message`, `session.operation`, `agent`) were **not observed**. Their names and shapes are still unconfirmed.
- **`health` is rich:** `ok`, `durationMs`, `plugins`, `deliveryQueues`, `configReload`, `channels`, `channelOrder`, `heartbeatSeconds`, `defaultAgentId`, `agents`, `sessions`, `eventLoop`. It may replace part of the 10 s polling (S4).
- **The hello frame** lists the gateway's 495 methods and 64 events (`features.methods/events/capabilities`, names *(scrambled)*, now kept). It also has `policy.tickIntervalMs`, the granted `auth.scopes`, `server.version` and `server.buildId`. `auth.deviceToken` was redacted.

## Next capture (asked of the PM)
1. **Keep list:** the redactor now keeps OpenClaw protocol vocabulary:
   - classification enums (`classification`, `peerKind`, `chatType`, `subagentRunState`, `completionStatus`, `lastRunStatus`…);
   - `mainKey`;
   - the hello `methods`, `events` and `capabilities` names;
   - ISO dates, which are now time-shifted instead of scrambled.

   Free text such as `category` stays scrambled. Tests cover it.
2. **Take it while Timmy is working,** ideally with a sub-agent running and one Discuter message sent, and with a longer `--events-seconds 180`. That confirms the activity event names, `active` sessions and the portal-chat key.
