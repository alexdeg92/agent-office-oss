'use strict';
/*
 * v1 raw schemas for the OpenClaw gateway (tested with 2026.9.8, capture-20261005).
 * Rule of thumb: fields Agent Office reads are typed; every other field seen in the capture is
 * listed in `known` (kept, not reported); anything else is reported as 'shape.extra-field' (info),
 * which is how protocol drift shows up on Santé système.
 */
const s = require('../../../schema');

const TESTED = ['2026.9.8'];
const str = () => s.string().optional();
const bool = () => s.boolean().optional();
const int = () => s.int().optional();
const ms = () => s.ms().optional();
const count = () => s.int().min(0).optional();   // token counts, durations: never negative (R2-07)

const SessionRow = s.object({
  key: s.string().min(1),
  sessionId: str(),
  agentId: str(),
  kind: str(), classification: str(), chatType: str(), peerKind: str(), channel: str(),
  isMain: bool(), isBackground: bool(),
  displayName: str().nullable(), label: str().nullable(),
  // S6.1 (live drift): run fields arrive as explicit null in sessions.changed (the protocol's event-only tombstone:
  // null = cleared; omission = unchanged), so they are nullable everywhere
  updatedAt: ms(), startedAt: ms().nullable(), endedAt: ms().nullable(), createdAt: ms(), lastActivityAt: ms(), lastInteractionAt: ms(),
  status: str(), hasActiveRun: bool(), hasActiveSubagentRun: bool(), runtimeMs: count().nullable(), lastRunId: str().nullable(), lastRunError: str().nullable(),
  totalTokens: count(), inputTokens: count(), outputTokens: count(), estimatedCostUsd: s.number().min(0).optional(),
  model: str(), modelProvider: str(),
  subagentRole: str(), subagentRunState: str(), spawnedBy: str(), parentSessionKey: str(),
  childSessions: s.array(s.string()).optional(),
  workspaceDir: str(), spawnedCwd: str(), messageCount: count(),   // 2.1: Session.cwd / messageCount
  groupChannel: str().nullable(),   // architect-54: the room's name ('#PIVOT-2735'), for project inference
  // S7b: session-group membership (a name from sessions.groups.list); null = removed from its group
  category: str().nullable(),
  // 2.1: only messageCount is read; the rest is OpenClaw's context-budget accounting, which we don't use
  contextBudgetStatus: s.object({ messageCount: count() }, { extra: 'ignore' }).nullable().optional(),
  goal: s.object({ objective: str(), status: str(), tokensUsed: count(), tokenBudget: s.int().min(0).nullable().optional() },
    { known: ['schemaVersion', 'id', 'createdAt', 'updatedAt', 'tokenStart', 'tokenStartFresh', 'continuationTurns', 'lastStatusNote', 'completedAt', 'budgetLimitedAt'] }).nullable().optional(),
}, { known: ['visibility', 'permissionModePending', 'archived', 'pinned', 'unread', 'systemSent', 'abortedLastRun', 'thinkingLevels', 'thinkingOptions',
  'thinkingDefault', 'effectiveFastMode', 'effectiveFastModeSource', 'fastAutoOnSeconds', 'totalTokensFresh', 'effectiveResponseUsage', 'effectiveQueueMode',
  'modelOverrideSource', 'runtimeSelectionLocked', 'agentRuntime', 'contextTokens', 'snapshotAt', 'placement', 'activeRunIds', 'sharingRole', 'participants',
  'expandedParticipants', 'participantCount', 'channelAvatarUrl', 'origin', 'deliveryContext', 'lastChannel', 'lastTo', 'lastAccountId',
  'createdVia', 'space', 'lastThreadId', 'forkedFromParent', 'controlOwnerSessionKey', 'spawnedWorkspaceDir', 'spawnDepth',
  'subagentControlScope', 'createdActor', 'owner', 'thinkingLevel', 'forkSource', 'parentSessionId', 'hasAutomation', 'activitySummary',
  'fastMode' /* seen live on staging, absent from capture-20261005; type unknown, so not typed yet */] });

// sessions.changed = a session row keyed `sessionKey`, plus event fields. Built from SessionRow's shape.
function SessionRow_changed() {
  const shape = Object.assign({}, SessionRow.shape);
  delete shape.key;
  return s.object(Object.assign(shape, {
    // S7b: a catalog-only change (group renamed/deleted: `{reason: 'groups'}`) has no sessionKey (2026.9.8 session-change-event)
    sessionKey: s.string().min(1).optional(), reason: str(),
    activitySummary: s.object({ state: str(), updatedAt: ms(), canEnsure: bool() }, { known: ['text'] }).optional(),
  }), { known: SessionRow.known.concat(['createdActor', 'owner', 'archivedAt', 'archivedBy', 'archiveReason', 'pinnedAt', 'markedUnreadAt', 'agentStatus',
    'observerDigest', 'swarm', 'permissionMode', 'autoLabel', 'icon', 'color', 'boardPresentation', 'toolOverrides', 'restartRecoveryStatus',
    'activeModel', 'activeModelProvider', 'ancestorSessions', 'providerReview', 'session',
    // S6.1: event envelope fields (OpenClaw 2026.9.8 session-change-event): the triggering run, the emit time, a catalog flag
    'runId', 'ts', 'catalogChanged']) });
}

// Transcript content parts and message usage (typed in S4: our normalisers read them, and only declared
// field names survive the diagnostics/fixture privacy rule). Part `type` values seen: text, thinking,
// toolCall, tool_use, observation, openai_responses_terminal, agent.
const ContentPart = s.object({
  type: str(), text: str(), thinking: str(), id: str(), name: str(), toolCallId: str(), toolUseId: str(), tool_use_id: str(), toolName: str(),
  arguments: s.unknown().optional(), input: s.unknown().optional(), args: s.unknown().optional(), parameters: s.unknown().optional(), params: s.unknown().optional(),
  content: s.unknown().optional(),   // tool result payload: string or nested parts
}, { known: ['textSignature', 'thinkingSignature', 'openclawReasoningReplay'] });
const Content = s.union([s.string(), s.array(s.union([s.string(), ContentPart])), ContentPart]);
const MessageUsage = s.object({ input: count(), output: count(), cacheRead: count(), cacheWrite: count(), totalTokens: count(), reasoningTokens: count(),
  input_tokens: count(), output_tokens: count(), total_tokens: count() }, { known: ['contextUsage', 'cost'] });
const ChannelAccount = s.object({
  accountId: str(), enabled: bool(), lifecycle: str(), busy: bool(), activeRuns: count(), lastInboundAt: s.ms().nullable().optional(), lastOutboundAt: s.ms().nullable().optional(),
  bot: s.object({ id: str(), username: str() }).nullable().optional(),
}, { known: ['lastStartAt', 'lastStopAt', 'restartPending', 'reconnectAttempts', 'lastConnectedAt', 'lastEventAt', 'lastTransportActivityAt', 'lastRunActivityAt',
  'tokenSource', 'tokenStatus', 'lastDisconnect', 'application', 'groupPolicy', 'guildsConfigured', 'configured', 'running', 'connected', 'lastError',
  'healthState', 'lastMessageAt', 'linked', 'stateReason'] });

const Model = s.union([s.string(), s.object({ primary: s.string(), fallbacks: s.array(s.string()).optional() })]);

const CronRun = s.object({
  ts: ms(), runAtMs: ms(), jobId: str(), runId: str(), sessionId: str(), sessionKey: str(), jobName: str(),
  action: str(), status: str(), completionStatus: str(), durationMs: int(), nextRunAtMs: ms(),
  model: str(), provider: str(), usage: s.object({ input_tokens: int(), output_tokens: int(), total_tokens: int(), totalTokens: int() }, { known: ['cache_read_tokens'] }).optional(),
  delivered: bool(), deliveryStatus: str(),
  delivery: s.object({ intended: s.object({ channel: str().nullable() }, { known: ['to', 'source'] }).optional() }, { known: ['fallbackUsed', 'delivered'] }).optional(),
  summary: str(), error: str(), errorReason: str(),
  diagnostics: s.object({ summary: str(), entries: s.unknown().optional() /* list of {ts, source, severity, message}; typed in S4 */ }).optional(),
});

const schemas = {
  'gw.hello': s.object({
    server: s.object({ version: s.string() }, { known: ['buildId', 'bootId', 'controlUiBuildSource', 'connId'] }),
    protocol: s.int(),
    features: s.object({ methods: s.array(s.string()), events: s.array(s.string()), capabilities: s.array(s.string()).optional() }).optional(),
  }, { known: ['type', 'snapshot', 'controlUiWidgetKinds', 'controlUiLinkReaders', 'pluginSurfaceUrls', 'auth', 'policy'] }),

  'gw.rpc.agents.list': s.object({
    defaultId: str(), mainKey: str(),
    agents: s.array(s.object({ id: s.string().min(1), name: str(), workspace: str(), model: Model.optional() },
      { known: ['workspaceGit', 'agentRuntime', 'thinkingLevels', 'thinkingOptions', 'thinkingDefault', 'defaultPermissionMode'] }), { perItem: true }),
  }, { known: ['ownership', 'selectionRequired', 'scope'] }),

  'gw.rpc.sessions.list': s.object({
    sessions: s.array(SessionRow, { perItem: true }),
    totalCount: int(), count: int(), hasMore: bool(), nextOffset: s.int().nullable().optional(), limitApplied: int(),
  }, { known: ['ts', 'path', 'owners', 'defaults'] }),

  'gw.rpc.sessions.describe': s.object({ session: SessionRow }),

  // S7b: the custom session-group catalog (read scope; path-free). Membership is each session row's `category`.
  'gw.rpc.sessions.groups.list': s.object({
    groups: s.array(s.object({ name: s.string().min(1), position: s.int().min(0) }), { perItem: true }),
    sectionOrder: s.array(s.string()).optional(),
  }),

  // Messages are validated per item; content stays opaque here (string or parts) and is typed by the
  // transcript normaliser in S4 (parts seen: text, thinking, toolCall, observation, openai_responses_terminal, agent).
  'gw.rpc.sessions.get': s.object({
    messages: s.array(s.object({
      role: s.string(), content: Content.nullable().optional(), timestamp: ms(), usage: MessageUsage.optional(),
      toolCallId: str(), toolName: str(), isError: bool(), errorMessage: str(),
      model: str(), provider: str(), api: str(), stopReason: str(), senderName: str(), senderLabel: str(), senderId: str(), displayName: str(), username: str(), channel: str(), sender: s.unknown().optional(),
    }, { known: ['provenance', 'idempotencyKey', '__openclaw', 'responseId', 'responseModel', 'diagnostics', 'display', 'details', 'customType', 'excludeFromContext'] }), { perItem: true }),
  }),

  'gw.rpc.sessions.usage': s.object({}, { extra: 'count', known: ['updatedAt', 'startDate', 'endDate', 'sessions', 'totals', 'aggregates', 'creatorOptions', 'cacheStatus'] }),

  'gw.rpc.cron.list': s.object({
    jobs: s.array(s.object({
      id: s.string().min(1), name: s.string(), description: str(), enabled: s.boolean(), agentId: str(), sessionKey: str(), displayName: str(),
      schedule: s.object({ kind: s.string(), expr: str(), tz: str(), everyMs: int(), anchorMs: s.int().optional(), at: str() }),
      sessionTarget: str(), wakeMode: str(),
      payload: s.object({ kind: s.string(), message: str(), argv: s.array(s.string()).optional(), model: str(), timeoutSeconds: s.number().optional(),
        toolsAllow: s.array(s.string()).optional(), lightContext: bool() }).optional(),
      delivery: s.object({ mode: str(), channel: str(), to: str() }).optional(),
      createdAtMs: ms(), updatedAtMs: ms(), nextRunAtMs: ms(), lastRunAtMs: ms(), lastRunStatus: str(), lastDeliveryStatus: str(), lastRunError: str(),
      deleteAfterRun: bool(),
    }, { known: ['state', 'configRevision', 'lastDelivered', 'effectiveAgentId', 'declarationKey', 'scheduledToolPolicy', 'deliverySuppressionReason',
      'lastFailureNotificationDeliveryStatus' /* seen live on staging */] }), { perItem: true }),
  }, { known: ['snapshotRevision', 'total', 'offset', 'limit', 'hasMore', 'nextOffset', 'deliveryPreviews'] }),

  // cron.runs answers with `entries` (seen live) or `runs` (legacy fallback kept).
  'gw.rpc.cron.runs': s.object({ entries: s.array(CronRun, { perItem: true }).optional(), runs: s.array(CronRun, { perItem: true }).optional() },
    { known: ['total', 'offset', 'limit', 'hasMore', 'nextOffset'] }),

  'gw.rpc.channels.status': s.object({
    ts: ms(),
    channelOrder: s.array(s.string()).optional(),
    channelLabels: s.record(s.string()).optional(),
    channels: s.record(s.object({ configured: s.boolean(), running: bool(), connected: bool(), lastError: s.string().nullable().optional(), lastStartAt: s.ms().nullable().optional(), lifecycle: str() },
      { known: ['lastStopAt', 'tokenSource', 'lastProbeAt', 'statusState', 'linked', 'authAgeMs', 'self', 'reconnectAttempts', 'lastConnectedAt', 'lastDisconnect',
        'lastInboundAt', 'lastMessageAt', 'lastEventAt', 'busy', 'lastRunActivityAt', 'healthState'] })),
    eventLoop: s.object({ degraded: s.boolean(), delayP99Ms: s.number().optional() }, { known: ['degradedSinceMs', 'reasons', 'intervalMs', 'delayMaxMs', 'utilization', 'cpuCoreRatio', 'cpuBreakdown'] }).optional(),
    channelAccounts: s.record(s.array(ChannelAccount, { perItem: true })).optional(),
  }, { known: ['channelDetailLabels', 'channelSystemImages', 'channelMeta', 'channelDefaultAccountId', 'statusIssues'] }),

  // Events. Activity events (session.tool, session.message, session.operation, agent) have NO schema
  // until a capture shows them: they are quarantined as 'event.unknown' (info) while legacy keeps working.
  'gw.event.health': s.object({
    ok: bool(), ts: ms(),
    server: s.object({ version: str() }).optional(),
    eventLoop: s.object({ degraded: s.boolean(), delayP99Ms: s.number().optional() }, { known: ['degradedSinceMs', 'reasons', 'intervalMs', 'delayMaxMs', 'utilization', 'cpuCoreRatio', 'cpuBreakdown'] }).optional(),
    plugins: s.object({ loaded: s.array(s.string()) }, { known: ['errors', 'unavailable'] }).optional(),
  }, { known: ['durationMs', 'deliveryQueues', 'configReload', 'channels', 'channelOrder', 'channelLabels', 'heartbeatSeconds', 'defaultAgentId', 'agents', 'sessions'] }),
  'gw.event.tick': s.object({ ts: ms() }),
  // S6.1: the cron service event (OpenClaw 2026.9.8 server-cron: `{...evt, job}`). action: started | finished |
  // added | updated | removed. On `finished` it carries the run outcome: typed for Flux and the Projets risks.
  'gw.event.cron': s.object(Object.assign({}, CronRun.shape, {
    jobId: str(), name: str(), jobName: str(), action: str(),
    durationMs: count().nullable(), nextRunAtMs: ms().nullable(), runAtMs: ms().nullable(), summary: str().nullable(), error: str().nullable(),
  }), { known: ['job', 'deliveryError', 'deliverySuppressionReason', 'failureNotificationDelivery', 'taskRunId'] }),
  // capture-20261005-active (2026.9.8): during a run, the gateway sends NO session.tool / session.message /
  // session.operation / agent events. sessions.changed carries the FULL session row (sessionKey instead of key)
  // plus `reason` and `activitySummary`; it is the activity signal (data-model §3).
  'gw.event.sessions.changed': SessionRow_changed(),
  'gw.event.chat.metadata.changed': s.object({ agentId: str(), usageUpdatedAt: ms(), modelCatalogChanged: bool(), authChanged: bool() }),
};

// S6.1: events this protocol version sends that Agent Office deliberately doesn't consume: a reviewed vocabulary
// (OpenClaw 2026.9.8 GATEWAY_EVENTS + the broadcasts it doesn't advertise). Accepted as opaque, never reported.
// Activity-bearing events (session.tool, session.message, session.operation, agent, chat) are NOT listed: if a
// future OpenClaw starts sending them, event.unknown says so (finer activity would become possible).
const IGNORED_EVENTS = ['connect.challenge', 'models.snapshot', 'ui.command', 'session.approval', 'session.narration', 'session.observer',
  'session.sharing', 'session.sharing.evidence', 'session.suggestion', 'session.typing', 'controlUi.sessionPullRequests.changed',
  'plugins.controlUi.changed', 'presence', 'talk.mode', 'talk.event', 'talk.voice.change', 'shutdown', 'gateway.suspension', 'heartbeat',
  'task.suggestion', 'node.pair.requested', 'node.pair.resolved', 'node.presence', 'node.hostStats', 'node.runnerInventory.changed',
  'node.invoke.cancel', 'node.invoke.input', 'node.invoke.request', 'device.pair.changed', 'device.pair.requested', 'device.pair.resolved',
  'device.pair.setup.completed', 'device.pair.setup.deliveryUncertain', 'users.prefs.changed', 'skills.changed', 'plugins.changed',
  'plugins.install.progress', 'voicewake.changed', 'voicewake.routing.changed', 'exec.approval.requested', 'exec.approval.resolved',
  'question.requested', 'question.resolved', 'plugin.approval.requested', 'plugin.approval.resolved', 'openclaw.approval.requested',
  'openclaw.approval.resolved', 'terminal.data', 'terminal.exit', 'update.available', 'update.run.changed', 'portal.changed',
  'progressCard.changed', 'mentions.changed',
  // broadcast but not advertised in hello (seen live as event.unknown ×3 on S6 staging)
  'board.changed', 'board.command', 'chat.send_timing', 'chat.side_result', 'config.changed', 'sessions.catalog.host'];
for (const e of IGNORED_EVENTS) schemas['gw.event.' + e] = s.unknown();

module.exports = Object.fromEntries(Object.entries(schemas).map(([channel, schema]) => [channel, { id: channel, version: 1, testedWith: TESTED, schema }]));
