'use strict';
// Canonical Session contract (data-model.md §2–3) as a DSL schema. Every normalised Session is
// validated against it at runtime; a violation is quarantined and the session is not admitted (R2-07).
const s = require('../../schema');
const { SESSION_KINDS, CHANNEL_REF, isInterlocutorId } = require('./kinds');

const nn = () => s.int().min(0);
const msOrNull = () => s.ms().nullable();

const Classification = s.object({
  kind: s.enumOf(SESSION_KINDS), ruleId: s.string().min(1), agentId: s.string().nullable(),
  channel: s.string().refine((v) => CHANNEL_REF.test(v), 'channel ref').nullable(),   // G3b: an open ChannelRef
  heartbeatOf: s.string().nullable(), background: s.boolean(), rawClassification: s.string().nullable(),
  subagentId: s.string().min(1).optional(), cronJobId: s.string().min(1).optional(),   // PM after R26-01: any length (never hide real activity)   // R24-01: occupant subjects
  explicitKey: s.string().min(1).optional(),
  chatScope: s.string().optional(), interlocutorId: s.string().refine(isInterlocutorId, 'interlocutor id').optional(),
}, { extra: 'reject' }).refine((c) => c.kind !== 'subagent' || !!c.subagentId, 'subagent has subagentId')
  .refine((c) => c.kind !== 'scheduled' || !!c.cronJobId, 'scheduled has cronJobId');

const RunState = s.object({
  status: s.enumOf(['idle', 'running', 'succeeded', 'failed']),
  endReason: s.enumOf(['error', 'timeout', 'killed', 'budget-limited']).nullable(),
  evidence: s.enumOf(['gateway-flag', 'status-field', 'start-without-end', 'live-activity', 'none']),
  startedAt: msOrNull(), endedAt: msOrNull(), hasActiveSubagentRun: s.boolean(),
  runtimeMs: nn().nullable(), lastRunId: s.string().nullable(), lastError: s.string().nullable(),
}, { extra: 'reject' });

const Session = s.object({
  key: s.string().min(1), sessionId: s.string().nullable(), class: Classification,
  displayName: s.string().nullable(),
  model: s.object({ id: s.string().min(1), provider: s.string().nullable() }, { extra: 'reject' }).nullable(),
  provider: s.string().nullable(),
  usage: s.object({ total: nn(), input: nn().nullable(), output: nn().nullable() }, { extra: 'reject' }),
  updatedAt: msOrNull(), run: RunState,
  costUsd: s.number().min(0).nullable(),
  parentKey: s.string().nullable(), childKeys: s.array(s.string()),
  goal: s.object({ objective: s.string(), status: s.string(), tokensUsed: nn().nullable(), tokenBudget: nn().nullable() }, { extra: 'reject' }).nullable(),
  cwd: s.string().refine((c) => c.startsWith('/'), 'absolute').nullable(), messageCount: nn().nullable(),   // 2.1
  interactive: s.boolean(),
  group: s.string().min(1).nullable(),       // S7b: the runtime's session group (a SessionGroup id), null = none
  // architect-54: the room's display name as the runtime shows it (Discord '#PIVOT-2735'), and the session's label
  // (a spawn's or an operator's). Inputs to project inference only; no view shows them.
  channelName: s.string().min(1).max(200).nullable().optional(),
  label: s.string().min(1).max(200).nullable().optional(),
}, { extra: 'reject' });   // PM after R26-01: no id length bound here; the inventory leaves out what it can't store

module.exports = { Session, RunState, Classification };
