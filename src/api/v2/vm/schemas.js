'use strict';
/*
 * One schema (and class) per view model (PM audit (B), part 2): the api.md §3 types as schemas. Every VM the server
 * sends is checked against its schema at RUNTIME (vm/check.js). The examples in docs/architecture/examples/ are
 * tested against these schemas, so the contract, the examples and the runtime check can't drift apart.
 * Strings are not length-capped here (the builders cap them); enums are closed where api.md closes them.
 */
const s = require('../../../schema');

const R = { extra: 'reject' };
const str = () => s.string();
const strN = () => s.string().nullable();
const nn = () => s.int().min(0);
const num = () => s.number();
const ms = () => s.int().min(0);
const msN = () => s.int().min(0).nullable();
const bool = () => s.boolean();
const arr = (x) => s.array(x);
const obj = (shape) => s.object(shape, R);
const oneOf = (...values) => s.enumOf(values);

// A Collection: an array whose items have unique string ids (display order).
const collection = (item) => s.array(item).refine((list) => new Set(list.map((x) => x.id)).size === list.length, 'unique ids');

// LabelRef: params are raw values (string | number) or nested LabelRefs, recursively (api.md §3.0)
function paramsOk(p, depth = 0) {
  if (p === null || typeof p !== 'object' || Array.isArray(p) || depth > 4) return false;
  return Object.values(p).every((v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
    || (v && typeof v === 'object' && typeof v.key === 'string' && Object.keys(v).every((k) => k === 'key' || k === 'params') && (v.params === undefined || paramsOk(v.params, depth + 1))));
}
const LabelRef = obj({ key: s.string().min(1), params: s.unknown().refine(paramsOk, 'label params').optional() });
const LabelRefN = () => LabelRef.nullable();

const AGENT_STATE = ['idle', 'thinking', 'working', 'researching', 'writing', 'calling', 'waiting', 'error', 'offline'];
const PersonChip = obj({ id: str(), kind: oneOf('human', 'agent', 'git'), name: str(), avatarUrl: strN(), state: s.enumOf(AGENT_STATE).nullable() });
const ActorVM = s.union([PersonChip, obj({ kind: s.literal('system'), name: str() })]);
const UNIT = oneOf('count', 'tokens', 'percent', 'bytes', 'ms');
const Kpi = obj({ id: str(), label: LabelRef, value: num().nullable(), unit: UNIT, sub: LabelRefN() });
const LEVEL = oneOf('ok', 'warn', 'alert');
const SESSION_KIND = oneOf('main', 'dashboard', 'subagent', 'cron', 'chat-direct', 'chat-group', 'acp', 'explicit', 'unrecognized');
const CHANNEL_ID = s.enumOf(['wechat', 'discord', 'whatsapp', 'unrecognized']).nullable();
const ROLE = oneOf('main', 'subagent', 'cron', 'dm', 'channel');

// ---- §3.1 ----
const MetaVM = obj({
  modelVersion: nn(), apiVersion: s.literal(2), contractVersion: str(), serverVersion: str(), env: oneOf('production', 'staging', 'dev'),
  capabilities: obj({ openclawWrites: bool(), storeWrites: bool() }), readonly: bool(),
  runtime: obj({ id: str(), name: str(), gatewayLabel: str() }).nullable(),
  primaryAgent: obj({ id: str(), name: str(), avatarUrl: strN() }).nullable(),   // 2.4, G3a
  instance: obj({ timeZone: str(), locale: str(), configured: bool() }),        // 2.4, G3a; configured 2.5, G4
  locale: oneOf('fr', 'en'), labels: s.record(str()), enums: s.record(arr(str())),
});
const MeVM = obj({ email: str(), displayName: str(), gateway: oneOf('up', 'down'), capabilities: obj({ openclawWrites: bool(), storeWrites: bool() }), sessionExpiresAt: ms() });

// ---- §3.2 OfficeVM ----
// a person's messages the agent answered, from the session's transcript: within the last windowMs, and the newest one
const Exchanges = obj({ recent: nn(), windowMs: s.int().min(1), lastAt: ms() }).optional();
const OccupantVM = obj({
  id: str(), role: ROLE, name: str(), title: LabelRef /* 2.4, Q03-A01 */, roleLabel: LabelRef, state: s.enumOf(AGENT_STATE), stateSince: ms(),
  stationUid: strN(), look: obj({ character: str(), variant: strN(), accessories: arr(str()) }), ruleId: strN(),
  destination: obj({ kind: oneOf('server', 'meeting'), stationUid: str() }).nullable(),
  sessionKey: strN(), tokens: nn(), lastSeenAt: msN(),
  exchanges: Exchanges,   // architect-55 (office-dev-22 §3): conversation occupants with a known transcript
});
const LIVE_KIND = ['gateway.connected', 'gateway.disconnected', 'activity', 'run.started', 'run.succeeded', 'run.failed', 'cron.fired',
  'occupant.joined', 'occupant.left', 'agent.removed', 'agent.primary-changed', 'project.status', 'project.risk'];
const OfficeVM = obj({
  connection: obj({ gateway: oneOf('up', 'down'), since: msN() }),
  kpis: collection(Kpi), occupants: collection(OccupantVM),
  journal: collection(obj({ id: str(), at: ms(), count: s.int().min(1), actor: ActorVM, text: LabelRef, kind: s.enumOf(LIVE_KIND) })),
  layoutRevision: nn(),
  queue: collection(obj({ id: str(), name: str(), schedule: LabelRef })),
});

// ---- §3.3 ChatVM ----
const ChatVM = obj({
  sessionKey: str(), turnPending: obj({ turnId: str(), since: ms() }).nullable(),
  messages: collection(obj({ id: str(), role: oneOf('user', 'assistant', 'error'), at: ms(), text: str(),
    meta: obj({ model: strN(), tokens: nn().nullable(), durationMs: nn().nullable() }).nullable() })),
});

// ---- §3.4 Flows ----
const ScheduleVM = s.discriminated('kind', {
  cron: obj({ kind: s.literal('cron'), expr: str(), tz: strN(), sentence: LabelRef }),
  every: obj({ kind: s.literal('every'), everyMs: nn(), anchorAt: msN(), sentence: LabelRef }),
  at: obj({ kind: s.literal('at'), at: ms(), sentence: LabelRef }),
  unrecognized: obj({ kind: s.literal('unrecognized'), sentence: LabelRef }),
});
const FlowSummaryShape = { id: str(), name: str(), description: str(), enabled: bool(), schedule: ScheduleVM, health: oneOf('ok', 'failing', 'never-run'), nextRunAt: msN(), lastRunAt: msN() };
const FlowListVM = obj({ flows: collection(obj(FlowSummaryShape)), counts: obj({ total: nn(), enabled: nn() }) });
const PayloadVM = s.discriminated('kind', {
  'agent-turn': obj({ kind: s.literal('agent-turn'), message: str(), model: strN(), timeoutSeconds: num().nullable() }),
  heartbeat: obj({ kind: s.literal('heartbeat') }),
  command: obj({ kind: s.literal('command'), argv: arr(str()) }),
  unrecognized: obj({ kind: s.literal('unrecognized') }),
});
const CronRunVM = obj({
  id: str(), at: ms(), status: oneOf('succeeded', 'failed', 'skipped', 'running', 'unrecognized'), durationMs: nn().nullable(), nextRunAt: msN(), model: strN(),
  tokens: obj({ total: nn(), input: nn(), output: nn() }).nullable(),
  delivery: obj({ status: strN(), delivered: bool().nullable(), channel: strN() }), summary: str(), error: strN(),
});
const FlowDetailVM = obj({
  job: obj(Object.assign({}, FlowSummaryShape, { agentId: str(), sessionTarget: oneOf('isolated', 'main', 'unrecognized'), wakeMode: oneOf('now', 'next-heartbeat', 'unrecognized'),
    payload: PayloadVM, createdAt: msN(), updatedAt: msN() })),
  editable: bool(),
  diagram: obj({ nodes: arr(obj({ kind: oneOf('trigger', 'step', 'decision', 'output'), label: str() })) }),
  runs: collection(CronRunVM),
});

// ---- §3.5 Access ----
const AccessOf = obj({ policy: strN(), enabled: bool().nullable(), requireMention: bool().nullable() });
const RESOLUTION = oneOf('pending', 'resolved', 'failed');
const AccessVM = obj({
  agents: collection(obj({ id: str(), name: str(), model: strN(), isPrimary: bool() })),
  interlocutors: collection(obj({ id: str(), kind: oneOf('discord-user', 'discord-channel'), name: strN(), avatarUrl: strN(), resolution: RESOLUTION,
    sessionCount: nn(), totalTokens: nn(), lastSeenAt: msN(), access: AccessOf })),
  policy: obj({ dm: strN(), group: strN(), channelsEnabled: nn(), channelsTotal: nn(), execSecurity: strN() }),
});
const InterlocutorVM = obj({
  id: str(), kind: oneOf('discord-user', 'discord-channel'), resolution: RESOLUTION,
  profile: s.union([obj({ displayName: strN(), username: strN(), avatarUrl: strN(), isBot: bool(), createdAt: nn() }),
    obj({ name: strN(), type: str(), topic: str(), guildName: strN(), createdAt: nn() })]).nullable(),
  access: AccessOf,
  stats: obj({ sessionCount: nn(), totalTokens: nn(), firstSeenAt: msN(), lastSeenAt: msN() }),
  sessions: collection(obj({ id: str(), updatedAt: msN(), tokens: nn(), model: strN() })),
  primarySessionKey: strN(),
});

// ---- §3.6 Logs, SessionVM ----
const LogRowVM = obj({ id: str(), kind: SESSION_KIND, channel: CHANNEL_ID, label: str(), title: LabelRef /* 2.4 */, model: strN(), modelProvider: strN(), tokens: nn(), updatedAt: msN(), live: bool(), heartbeat: bool() });
const LogsPage = obj({ items: collection(LogRowVM), nextCursor: strN() });
const tr = (kind, extra) => obj(Object.assign({ id: str(), kind: s.literal(kind), at: nn(), text: str(), truncated: bool() }, extra));
const TraceEventVM = s.discriminated('kind', {
  system: tr('system'), thinking: tr('thinking'), observation: tr('observation'), user: tr('user', { sender: strN() }),
  assistant: tr('assistant', { model: strN(), provider: strN(), outputTokens: nn().nullable(), stopReason: s.enumOf(['stop', 'toolUse', 'error', 'unrecognized']).nullable(), error: strN() }),
  tool: obj({ id: str(), kind: s.literal('tool'), at: nn(), callId: strN(), name: str(),
    toolKind: oneOf('search', 'web', 'browser', 'exec', 'file-read', 'file-write', 'memory', 'message', 'image', 'other'),
    input: str(), output: str(), isError: bool(), durationMs: nn().nullable(), truncated: bool() }),
});
const SessionVM = obj({
  key: str(), label: str(), title: LabelRef /* 2.4 */, kind: SESSION_KIND, model: strN(), modelProvider: strN(), tokens: nn(), updatedAt: msN(), cwd: strN(),
  run: obj({ status: oneOf('idle', 'running', 'succeeded', 'failed'), endReason: s.enumOf(['error', 'timeout', 'killed', 'budget-limited']).nullable() }),
  messageCount: nn().nullable(), window: obj({ from: nn(), to: nn() }), toolCount: nn(),
  traceState: oneOf('fresh', 'stale', 'unavailable'),   // 2.4 (R16-07)
  events: collection(TraceEventVM),
});

// ---- §3.7 Skills ----
const SOURCES = oneOf('bundled', 'extra', 'workspace', 'workshop', 'custodian', 'unrecognized');
const SkillRowShape = { id: str(), emoji: strN(), description: str(), source: SOURCES, status: oneOf('active', 'disabled', 'unavailable'),
  visibility: obj({ model: bool(), command: bool(), user: bool() }) };
const SkillListVM = obj({ skills: collection(obj(SkillRowShape)), counts: obj({ total: nn(), active: nn() }) });
const Req = obj({ bins: arr(str()), anyBins: arr(str()), env: arr(str()), config: arr(str()), os: arr(str()) });
const SkillDetailVM = obj({
  skill: obj(Object.assign({}, SkillRowShape, { homepage: strN() })),
  detail: obj({ always: bool(), blockedBy: obj({ allowlist: bool(), agentFilter: bool(), platform: bool() }), requirements: Req.nullable(), missing: Req.nullable(),
    install: arr(obj({ id: str(), kind: str(), label: str(), bins: arr(str()) })) }).nullable(),
  markdown: str(),
  flow: obj({ steps: arr(str()), outputs: arr(oneOf('files', 'message', 'tool-actions', 'agent-reply')) }),
  needsRestart: bool(),
});

// ---- §3.8 HealthVM ----
const SourceStatusVM = obj({ id: str(), state: oneOf('fresh', 'stale', 'down'), lastOkAt: msN(), lastErrorAt: msN(), lastError: strN(),
  channels: arr(obj({ channel: str(), state: oneOf('fresh', 'stale'), lastOkAt: msN(), lastErrorAt: msN(), lastError: strN() })) });
const HealthVM = obj({
  level: LEVEL,
  cards: collection(obj({ id: oneOf('gateway', 'cpu', 'memory', 'disk', 'event-loop', 'uptime', 'cron', 'plugins'), level: LEVEL,
    value: s.union([obj({ n: num(), unit: UNIT }), obj({ key: str() })]), sub: LabelRefN() })),
  channels: collection(obj({ id: str(), label: str(), health: oneOf('connected', 'running', 'stopped', 'error', 'not-configured'), lastError: strN(), accounts: nn() })),
  sources: collection(SourceStatusVM),
  dataQuality: obj({ open: obj({ error: nn(), warn: nn(), info: nn() }),
    issues: collection(obj({ id: str(), code: str(), severity: oneOf('error', 'warn', 'info'), channel: str(), path: strN(), count: nn(), firstSeenAt: ms(), lastSeenAt: ms(),
      state: oneOf('open', 'resolved', 'muted'), mutable: bool() })) }),
  series: obj({ cpu: arr(num()), mem: arr(num()), at0: ms(), stepMs: nn() }),
});

// ---- §3.9 Projects ----
const PRIORITY = oneOf('P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9');   // data-model Priority (P0–P9 since architect-55)
const STATUS = oneOf('idea', 'todo', 'in-progress', 'in-review', 'shipped');
const ACCENT = oneOf('slate', 'indigo', 'teal', 'amber', 'rose', 'green');
const ImageShape = { kind: oneOf('screenshot', 'opengraph', 'monogram', 'cover'), url: strN(), initials: str(), accent: ACCENT };
const CoverVM = obj({ url: str(), thumbUrl: str(), source: oneOf('agent', 'code', 'upload'), generatedAt: ms() }).nullable().optional();
const ThumbVM = obj(Object.assign({}, ImageShape, { repoLabel: strN() }));
const FlagVM = s.discriminated('kind', {
  priority: obj({ kind: s.literal('priority'), key: str(), label: str() }),
  risk: obj({ kind: s.literal('risk'), key: str(), label: str(), severity: oneOf('high', 'medium', 'low'), acked: bool(), removable: bool() }),
  feature: obj({ kind: s.literal('feature'), key: str(), label: str(), state: oneOf('on', 'off', 'unknown') }),
  label: obj({ kind: s.literal('label'), key: str(), label: str(), removable: s.literal(true) }),
});
const SourceRef = s.union([obj({ owner: str(), repo: str() }), obj({ path: str() }), obj({ rootId: str(), path: str() }),
  obj({ by: s.literal('group'), groupId: str(), name: str() }), obj({ by: s.literal('interlocutor'), interlocutorId: str() }), obj({ by: s.literal('keys'), sessionKeys: arr(str()) })]);
const SOURCE_KIND = oneOf('github', 'workspace', 'sessionGroup', 'manual');
// architect-57: a session item carries who, what it did (a sentence from its transcript), the counts and where to open it
const HistorySession = obj({ key: str(), label: LabelRef, summary: strN(), messages: nn().nullable(), tokens: nn(), route: str(),
  people: arr(PersonChip).optional(), channel: strN().optional() }).optional();
const HistoryItemVM = obj({ id: str(), at: ms(), kind: str(), group: s.int().min(1), actor: ActorVM, text: LabelRef, session: HistorySession });
const ProjectCardVM = obj({
  id: str(), name: str(), priority: PRIORITY, revision: nn(), status: STATUS, thumb: ThumbVM, cover: CoverVM,
  flags: obj({ visible: arr(FlagVM), hiddenCount: nn() }), people: obj({ visible: arr(PersonChip), hiddenCount: nn() }), lastActivityAt: ms(),
});
const BoardVM = obj({ filter: oneOf('all', 'at-risk', 'with-timmy', 'archived'),
  columns: collection(obj({ id: STATUS, count: nn(), cards: collection(ProjectCardVM) })) });
const ProjectVM = obj({
  id: str(), revision: nn(), name: str(), status: STATUS, priority: PRIORITY, archived: bool(),
  summary: str(), summaryMeta: obj({ author: ActorVM, at: ms() }).nullable(), thumb: ThumbVM, cover: CoverVM, flags: arr(FlagVM),
  sources: collection(obj({ id: str(), kind: SOURCE_KIND, label: str(), ref: SourceRef.nullable(), addedAt: ms(), sessionCount: nn().nullable() })),
  repo: obj({ state: oneOf('pending', 'ok', 'error'), url: str(), owner: str(), name: str(), image: obj(ImageShape), defaultBranch: strN(), branch: strN(),
    ci: obj({ state: oneOf('passing', 'failing', 'running', 'none', 'unrecognized'), at: msN(), url: strN() }).nullable(),
    commits: arr(obj({ sha: str(), at: ms(), author: str(), message: str() })), fetchedAt: msN(), lastError: strN() }).nullable(),
  people: collection(obj({ id: str(), kind: oneOf('human', 'agent', 'git'), name: str(), avatarUrl: strN(), state: s.enumOf(AGENT_STATE).nullable(),
    role: strN(), origin: oneOf('derived', 'manual'), commitCount: nn().nullable() })),
  recentHistory: collection(HistoryItemVM), historyNextCursor: strN(), lastActivityAt: ms(), createdAt: ms(),
});
const HistoryPage = obj({ items: collection(HistoryItemVM), nextCursor: strN() });
// architect-57 (B): a project's comment thread. kind: a comment, an event line (text: « X a demandé un résumé »), or a
// system line (the agent's status/priority change, from the history). Oldest first; nextCursor loads older items.
const DELIVERY = oneOf('pending', 'working', 'replied', 'failed', 'no-reply', 'unavailable');
const CommentItemVM = obj({ id: str(), kind: oneOf('comment', 'event', 'system'), at: ms(), author: ActorVM, body: strN(), text: LabelRefN(),
  mentions: arr(obj({ id: str(), name: str() })), replyTo: strN(), delivery: arr(obj({ agentId: str(), status: DELIVERY, reason: strN() })),
  editedAt: msN(), deleted: bool(), editable: bool(), deletable: bool() });
const CommentThreadVM = obj({ projectId: str(), items: collection(CommentItemVM), nextCursor: strN(),
  mentionable: collection(obj({ id: str(), name: str(), avatarUrl: strN(), primary: bool() })), canComment: bool(), canMention: bool(),
  session: obj({ key: str(), route: str() }).nullable() });
const CandidatesVM = obj({ scannedAt: ms(), candidates: collection(obj({
  id: str(), key: str(), name: str(), summary: str(), suggestedStatus: STATUS, confidence: oneOf('high', 'medium', 'low'), reason: str(),
  labels: arr(str()), sources: arr(obj({ kind: SOURCE_KIND, label: str(), ref: SourceRef.nullable() })), lastActivityAt: msN() })) });

// ---- §3.10 Layout, prefs ----
const LayoutData = s.object({ version: s.literal(1), manifestVersion: nn(), room: str(), theme: s.unknown(), items: arr(s.unknown()), agents: arr(s.unknown()) }, R);
const LayoutVM = obj({
  layout: obj({ id: str(), name: str(), revision: s.int().min(1), updatedAt: ms(), updatedBy: ActorVM, data: LayoutData }),
  manifest: s.unknown(),
  theme: obj({ resolved: str(), mode: oneOf('auto', 'fixed'), nextChangeAt: msN(), season: strN() }),
  default: obj({ data: LayoutData }),
  revisions: collection(obj({ id: str(), revision: s.int().min(1), updatedAt: ms(), updatedBy: ActorVM })),
  agentsSeen: collection(obj({ id: str(), role: ROLE, name: str(), lastSeenAt: ms() })),
});
const UiPrefs = obj({ uiTheme: oneOf('system', 'dark', 'light'), locale: s.enumOf(['fr', 'en']).nullable() });

// Topic name / route → VM schema
const VM_SCHEMAS = { meta: MetaVM, me: MeVM, office: OfficeVM, chat: ChatVM, flows: FlowListVM, flow: FlowDetailVM, access: AccessVM, interlocutor: InterlocutorVM,
  logs: LogsPage, session: SessionVM, skills: SkillListVM, skill: SkillDetailVM, health: HealthVM, projects: BoardVM, project: ProjectVM, history: HistoryPage,
  candidates: CandidatesVM, layout: LayoutVM, prefs: UiPrefs, comments: CommentThreadVM };

// ==== Contract 3.0 (G5, api-v3.md): the VMs that differ, built from the same pieces; every other VM is the 2.x one ====
const ROLE3 = oneOf('primary', 'subagent', 'scheduled', 'direct', 'group', 'conversation');                              // D3
const SESSION_KIND3 = oneOf('primary', 'subagent', 'scheduled', 'conversation-direct', 'conversation-group', 'conversation', 'internal', 'unrecognized');   // D2
const CHANNEL_REF = s.string().refine((v) => /^[a-z][a-z0-9-]{0,31}$/.test(v) && v !== 'unrecognized', 'channel ref');      // D2, D5
const RESOLUTION3 = oneOf('pending', 'resolved', 'failed', 'unresolvable');                                                 // D5
const MetaVM3 = obj({
  modelVersion: nn(), apiVersion: s.literal(3), contractVersion: str(), serverVersion: str(), env: oneOf('production', 'staging', 'dev'),
  capabilities: obj({ openclawWrites: bool(), storeWrites: bool() }), readonly: bool(),
  runtime: obj({ id: str(), name: str(), gatewayLabel: str(), version: strN(), capabilities: s.record(s.unknown()) }).nullable(),   // D1
  primaryAgent: obj({ id: str(), name: str(), avatarUrl: strN() }).nullable(),
  instance: obj({ name: strN(), timeZone: str(), locale: str(), configured: bool() }),
  locale: oneOf('fr', 'en'), locales: arr(oneOf('fr', 'en')), labels: s.record(str()), enums: s.record(arr(str())),
});
const OfficeVM3 = obj({
  connection: obj({ gateway: oneOf('up', 'down'), since: msN() }),
  kpis: collection(Kpi), occupants: collection(obj(Object.assign({}, {
    id: str(), role: ROLE3, name: str(), title: LabelRef, roleLabel: LabelRef, state: s.enumOf(AGENT_STATE), stateSince: ms(),
    stationUid: strN(), look: obj({ character: str(), variant: strN(), accessories: arr(str()) }), ruleId: strN(),
    destination: obj({ kind: oneOf('server', 'meeting'), stationUid: str() }).nullable(), sessionKey: strN(), tokens: nn(), lastSeenAt: msN(), exchanges: Exchanges }))),
  journal: collection(obj({ id: str(), at: ms(), count: s.int().min(1), actor: ActorVM, text: LabelRef, kind: s.enumOf(LIVE_KIND) })),
  layoutRevision: nn(),
  queue: collection(obj({ id: str(), name: str(), schedule: LabelRef })),
});
const LogRowVM3 = obj({ id: str(), kind: SESSION_KIND3, runtimeKind: strN(), channel: CHANNEL_REF.nullable(), label: str(), title: LabelRef, model: strN(), modelProvider: strN(),
  tokens: nn(), updatedAt: msN(), live: bool(), heartbeat: bool() });
const SessionVM3 = obj({
  key: str(), label: str(), title: LabelRef, kind: SESSION_KIND3, runtimeKind: strN(), model: strN(), modelProvider: strN(), tokens: nn(), updatedAt: msN(), cwd: strN(),
  run: obj({ status: oneOf('idle', 'running', 'succeeded', 'failed'), endReason: s.enumOf(['error', 'timeout', 'killed', 'budget-limited']).nullable() }),
  messageCount: nn().nullable(), window: obj({ from: nn(), to: nn() }), toolCount: nn(), traceState: oneOf('fresh', 'stale', 'unavailable'),
  events: collection(TraceEventVM),
});
const AccessVM3 = obj({
  agents: collection(obj({ id: str(), name: str(), model: strN(), isPrimary: bool() })),
  interlocutors: collection(obj({ id: str(), kind: oneOf('user', 'room'), channel: CHANNEL_REF, name: strN(), avatarUrl: strN(), resolution: RESOLUTION3,
    sessionCount: nn(), totalTokens: nn(), lastSeenAt: msN(), access: AccessOf })),
  policy: obj({ dm: strN(), group: strN(), channelsEnabled: nn(), channelsTotal: nn(), execSecurity: strN() }),
});
const InterlocutorVM3 = obj({
  id: str(), kind: oneOf('user', 'room'), channel: CHANNEL_REF, resolution: RESOLUTION3,
  profile: s.union([obj({ displayName: strN(), username: strN(), avatarUrl: strN(), isBot: bool(), createdAt: nn() }),
    obj({ name: strN(), type: str(), topic: str(), guildName: strN(), createdAt: nn() })]).nullable(),
  access: AccessOf,
  stats: obj({ sessionCount: nn(), totalTokens: nn(), firstSeenAt: msN(), lastSeenAt: msN() }),
  sessions: collection(obj({ id: str(), updatedAt: msN(), tokens: nn(), model: strN() })),
  primarySessionKey: strN(),
});
const FlowDetailVM3 = obj({
  job: obj(Object.assign({}, FlowSummaryShape, { agentId: str(), payload: PayloadVM, ext: s.record(s.unknown()), createdAt: msN(), updatedAt: msN() })),   // D7
  editable: bool(),
  diagram: obj({ nodes: arr(obj({ kind: oneOf('trigger', 'step', 'decision', 'output'), label: str() })) }),
  runs: collection(obj({
    id: str(), at: ms(), status: oneOf('succeeded', 'failed', 'skipped', 'running', 'unrecognized'), durationMs: nn().nullable(), nextRunAt: msN(), model: strN(),
    tokens: obj({ total: nn(), input: nn(), output: nn() }).nullable(),
    delivery: obj({ status: strN(), delivered: bool().nullable(), channel: CHANNEL_REF.nullable() }), summary: str(), error: strN() })),
});
const BoardVM3 = obj({ filter: oneOf('all', 'at-risk', 'with-agent', 'archived'), agent: strN(),                                // D8
  columns: collection(obj({ id: STATUS, count: nn(), cards: collection(ProjectCardVM) })) });
// O8: a 3.0 layout may carry presence { seenMinutes: 0–1440 } (2.x never shows it)
const LayoutData3 = s.object({ version: s.literal(1), manifestVersion: nn(), room: str(), theme: s.unknown(), items: arr(s.unknown()), agents: arr(s.unknown()),
  presence: obj({ seenMinutes: s.int().min(0).max(1440) }).optional() }, R);
const LayoutVM3 = obj({
  layout: obj({ id: str(), name: str(), revision: s.int().min(1), updatedAt: ms(), updatedBy: ActorVM, data: LayoutData3 }),
  manifest: s.unknown(),
  theme: obj({ resolved: str(), mode: oneOf('auto', 'fixed'), nextChangeAt: msN(), season: strN() }),
  default: obj({ data: LayoutData3 }),
  revisions: collection(obj({ id: str(), revision: s.int().min(1), updatedAt: ms(), updatedBy: ActorVM })),
  agentsSeen: collection(obj({ id: str(), role: ROLE3, name: str(), lastSeenAt: ms() })),                                   // D4
});
const VM_SCHEMAS_V3 = Object.assign({}, VM_SCHEMAS, { meta: MetaVM3, office: OfficeVM3, logs: obj({ items: collection(LogRowVM3), nextCursor: strN() }), session: SessionVM3,
  access: AccessVM3, interlocutor: InterlocutorVM3, flow: FlowDetailVM3, projects: BoardVM3, layout: LayoutVM3 });
const schemasFor = (version) => (version === 3 ? VM_SCHEMAS_V3 : VM_SCHEMAS);

module.exports = { VM_SCHEMAS, VM_SCHEMAS_V3, schemasFor, LabelRef, ActorVM, PersonChip, paramsOk, MetaVM, MeVM, OfficeVM, ChatVM, FlowListVM, FlowDetailVM, AccessVM, InterlocutorVM, LogsPage,
  SessionVM, SkillListVM, SkillDetailVM, HealthVM, BoardVM, ProjectVM, HistoryPage, CandidatesVM, LayoutVM, UiPrefs };
