'use strict';
/*
 * Canonical contracts for the S4 types (data-model.md §1, §2.1, §5–7, config, host). Every normalised
 * object is validated against these at runtime (as Session is in model/session.js); an invalid one is
 * quarantined as shape.invalid under '$.canonical.<type>…' and not admitted.
 */
const { safeExternalUrl } = require('../../../public/v2/url-policy.js');
const s = require('../../schema');
const { Sender, Participant } = require('./sender');
const { CHANNEL_REF } = require('./kinds');   // G3b

const ms = () => s.ms().nullable();
const nn = () => s.int().min(0);
const str = () => s.string();
const strN = () => s.string().nullable();
const externalUrlN = () => s.string().refine((v) => safeExternalUrl(v) === v, 'canonical HTTP(S) URL').nullable();
const R = { extra: 'reject' };

const Agent = s.object({
  id: s.string().min(1), name: str(), workspace: strN(),
  model: s.object({ primary: s.string().min(1), provider: strN() }, R).nullable(),
  fallbackModels: s.array(str()), isPrimary: s.boolean(), mainSessionKey: strN(),
}, R);

const Schedule = s.discriminated('kind', {
  cron: s.object({ kind: s.literal('cron'), expr: str(), tz: strN() }, R),
  every: s.object({ kind: s.literal('every'), everyMs: nn(), anchorAt: ms() }, R),
  at: s.object({ kind: s.literal('at'), at: s.ms() }, R),
  unrecognized: s.object({ kind: s.literal('unrecognized'), rawKind: str() }, R),
});
const Payload = s.discriminated('kind', {
  'agent-turn': s.object({ kind: s.literal('agent-turn'), message: str(), timeoutSeconds: s.number().min(0).nullable(), model: strN(),
    toolsAllow: s.array(str()).nullable(), lightContext: s.boolean() }, R),
  heartbeat: s.object({ kind: s.literal('heartbeat') }, R),
  command: s.object({ kind: s.literal('command'), argv: s.array(str()) }, R),
  unrecognized: s.object({ kind: s.literal('unrecognized'), rawKind: str() }, R),
});
const RUN = ['succeeded', 'failed', 'skipped', 'running', 'unrecognized'];

const CronJob = s.object({
  id: s.string().min(1), name: str(), description: str(), enabled: s.boolean(),
  schedule: Schedule, agentId: s.string().min(1).nullable(),   // null = the runtime's default agent (G3b)
  sessionTarget: s.enumOf(['isolated', 'main', 'unrecognized']).nullable(),
  wakeMode: s.enumOf(['now', 'next-heartbeat', 'unrecognized']).nullable(),
  payload: Payload.nullable(),
  delivery: s.object({ mode: s.enumOf(['none', 'announce', 'unrecognized']).nullable(),
    channel: s.string().refine((v) => v === 'last' || CHANNEL_REF.test(v), 'channel ref').nullable(), to: strN() }, R).nullable(),   // R6-09; G3b: ChannelRef
  steps: s.array(str()), createdAt: ms(), updatedAt: ms(), nextRunAt: ms(), lastRunAt: ms(),
  lastRunStatus: s.string().nullable(),          // RUN member, or the raw value while the vocabulary is pending (data-model §5)
  lastRunError: strN(), lastDeliveryStatus: strN(),   // DELIVERY member, or the raw value for an unknown one
  deleteAfterRun: s.boolean(), sessionKey: strN(),
  health: s.enumOf(['ok', 'failing', 'never-run']),
}, R);

const CronRun = s.object({
  id: s.string().min(1), jobId: s.string().min(1), sessionKey: strN(), at: nn(), action: strN(),
  status: s.enumOf(RUN), completionStatus: strN(), durationMs: nn().nullable(), nextRunAt: ms(),
  model: s.object({ id: strN(), provider: strN() }, R).nullable(),
  usage: s.object({ total: nn(), input: nn(), output: nn() }, R).nullable(),
  delivery: s.object({ status: strN(), delivered: s.boolean().nullable(), channel: strN() }, R),
  summary: str(), error: strN(),
}, R);

const Req = s.object({ bins: s.array(str()), anyBins: s.array(str()), env: s.array(str()), config: s.array(str()), os: s.array(str()) }, R);
const SOURCES = ['bundled', 'extra', 'workspace', 'workshop', 'custodian', 'unrecognized'];
const Skill = s.object({
  name: s.string().min(1), emoji: strN(), description: str(), source: s.enumOf(SOURCES), rawSource: strN(), bundled: s.boolean(),
  status: s.enumOf(['active', 'disabled', 'unavailable']),
  visibility: s.object({ model: s.boolean(), command: s.boolean(), user: s.boolean() }, R),
  homepage: externalUrlN(), missing: Req.nullable(),
}, R);
const SkillInfo = s.object({
  name: s.string().min(1), filePath: strN(), always: s.boolean(), source: s.enumOf(SOURCES),
  blockedBy: s.object({ allowlist: s.boolean(), agentFilter: s.boolean(), platform: s.boolean() }, R),
  requirements: Req.nullable(), missing: Req.nullable(),
  install: s.array(s.object({ id: str(), kind: str(), label: str(), bins: s.array(str()) }, R)), homepage: externalUrlN(),
}, R);

const Channel = s.object({
  // G3b: id is a ChannelRef ('unrecognized' only for a raw id that is not a slug)
  id: s.string().refine((v) => CHANNEL_REF.test(v), 'channel ref'), rawId: s.string().min(1), label: str(), configured: s.boolean(),
  health: s.enumOf(['connected', 'running', 'stopped', 'error', 'not-configured']), lastError: strN(), lastStartAt: ms(), lastInboundAt: ms(),
  accounts: s.array(s.object({ accountId: str(), enabled: s.boolean(), lifecycle: s.enumOf(['ready', 'stopped', 'running', 'starting', 'stopping', 'unrecognized']).nullable(),
    busy: s.boolean(), activeRuns: nn(), lastInboundAt: ms(), lastOutboundAt: ms(),
    bot: s.object({ id: str(), username: str() }, R).nullable() }, R)),
  policy: s.object({ dm: strN(), group: strN() }, R),
}, R);

const evId = () => s.string().refine((x) => /^ev:\d+:\d+$/.test(x), 'event id');   // S7b: 'ev:<message>:<part>' (TraceEventVM.id)
const tr = (kind, extra) => s.object(Object.assign({ id: evId(), kind: s.literal(kind), at: nn(), senderInfo: Sender.optional(), text: str(), truncated: s.boolean() }, extra), R);
const TraceEvent = s.discriminated('kind', {
  system: tr('system'), thinking: tr('thinking'), observation: tr('observation'),
  user: tr('user', { sender: strN() }),
  assistant: tr('assistant', { model: strN(), provider: strN(), outputTokens: nn().nullable(),
    stopReason: s.enumOf(['stop', 'toolUse', 'error', 'unrecognized']).nullable(), error: strN() }),
  tool: s.object({ id: evId(), kind: s.literal('tool'), at: nn(), senderInfo: Sender.optional(), callId: strN(), name: str(),
    toolKind: s.enumOf(['search', 'web', 'browser', 'exec', 'file-read', 'file-write', 'memory', 'message', 'image', 'other']),
    input: str(), output: str(), isError: s.boolean(), durationMs: nn().nullable(), truncated: s.boolean() }, R),
});
const Transcript = s.object({
  sessionKey: s.string().min(1), fetchedAt: nn(), messageCount: nn(),
  participants: s.array(Participant).optional(),
  window: s.object({ from: nn(), to: nn() }, R), events: s.array(TraceEvent),
}, R).refine((t) => t.window.to >= t.window.from && t.window.to === t.messageCount, 'window within messages');

// The config projection: the token is a Secret object, checked for presence only.
const Config = s.object({
  discord: s.object({ dmPolicy: strN(), groupPolicy: strN(),
    channels: s.record(s.object({ enabled: s.boolean(), requireMention: s.boolean() }, R)),
    token: s.unknown().refine((t) => t && typeof t.reveal === 'function' && t.toJSON() === '[secret]', 'Secret') }, R).nullable(),
  execSecurity: strN(), skillsEnabled: s.record(s.boolean()),
}, R);

// LiveEvent (data-model §11; R6-06): required nullable identity fields, closed kinds, a coalescing count.
const ActorRef = s.discriminated('kind', {
  human: s.object({ kind: s.literal('human'), personId: s.string().min(1) }, R),
  agent: s.object({ kind: s.literal('agent'), personId: s.string().min(1) }, R),
  system: s.object({ kind: s.literal('system'), component: s.enumOf(['engine', 'risk-monitor', 'scheduler']) }, R),
});
const LiveEvent = s.object({
  id: s.string().refine((x) => /^le_\d+$/.test(x), 'id'), at: nn(),
  kind: s.enumOf(['gateway.connected', 'gateway.disconnected', 'activity', 'run.started', 'run.succeeded', 'run.failed', 'cron.fired',
    'occupant.joined', 'occupant.left', 'agent.removed', 'agent.primary-changed', 'project.status', 'project.risk']),
  actor: ActorRef, occupantId: strN(), sessionKey: strN(), count: s.int().min(1),
  activity: s.enumOf(['thinking', 'writing', 'calling', 'researching', 'working']).optional(),
  cronJobId: s.string().min(1).optional(), projectId: s.string().min(1).optional(),
}, R).refine((e) => (e.kind === 'cron.fired') === (e.cronJobId != null) && (e.kind === 'activity') === (e.activity != null), 'kind fields');

// S7b: one entry of the runtime's session-group catalog (display order = position). Members: Session.group === name.
// `id` is the runtime's stable group id (opaque; OpenClaw: the name); Session.group holds that id.
const SessionGroup = s.object({ id: s.string().min(1).max(200), name: s.string().min(1), position: nn() }, R);

module.exports = { SessionGroup, LiveEvent, ActorRef, Agent, CronJob, CronRun, Skill, SkillInfo, Channel, Transcript, TraceEvent, Config };
