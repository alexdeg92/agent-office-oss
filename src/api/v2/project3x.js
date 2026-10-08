'use strict';
/*
 * The 3.0 projection (G5, api-v3.md): contract 3.0 serves the canonical values, so most functions are the identity.
 * Same interface as project2x; the builders call these hooks where 3.0 differs in shape.
 *   D2 session kind: dashboard/acp/explicit → 'internal' + runtimeKind; channel: the ChannelRef
 *   D3 occupants: canonical ids and roles   D5 interlocutors: every channel, kind 'user' | 'room' + channel
 *   D6 health: channel ids are ChannelRefs  D7 flows: agentId resolved, OpenClaw-only fields in job.ext.openclaw
 *   D8 board: 'with-agent' (+ agent); 'with-timmy' is not a 3.0 filter
 */
const INTERNAL = new Set(['dashboard', 'acp', 'explicit']);
const id = (x) => x;

const project3x = {
  version: 3,
  occupantId: id,
  occupantRole: id,
  sessionKind: (kind) => (INTERNAL.has(kind) ? 'internal' : kind),
  runtimeKind: (kind) => (INTERNAL.has(kind) ? kind : null),
  channelId: (ref) => (ref == null || ref === 'unrecognized' ? null : ref),
  liveKind: id,
  interlocutorVisible: () => true,
  // '<family>-user:…' → 'user'; '<family>-room:…' and Discord's 'discord-channel:…' → 'room'
  interlocutorKind: (iid) => (/^[a-z][a-z0-9-]*-user:/.test(String(iid)) ? 'user' : 'room'),
  interlocutorChannel: (iid) => { const head = String(iid).slice(0, String(iid).indexOf(':')); return head.slice(0, head.lastIndexOf('-')); },
  healthChannelId: (c) => (c.id === 'unrecognized' ? c.rawId : c.id),
  flowJobFields: (job, primaryId) => ({ agentId: job.agentId || primaryId || '' }),
  flowJobExt: (job) => ({ openclaw: { sessionTarget: job.sessionTarget || 'unrecognized', wakeMode: job.wakeMode || 'unrecognized' } }),
  // a run's intended channel is the runtime's raw name: a ChannelRef when it is a slug, else unknown (null)
  deliveryChannel: (ch) => (typeof ch === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(ch) && ch !== 'unrecognized' ? ch : null),
  resolution: (r) => r,                                          // G7: 'unresolvable' is a 3.0 value
  boardFilterIn: (f) => f,
  // D4: layout rule names in 3.0 ('main' → 'primary', '*cron' → '*scheduled', '*dm' → '*direct', '*channel' → '*group')
  layoutRuleId: (rid) => (rid == null ? rid : require('./vm/office').officeDefaults().rules.canonicalRuleId(rid) || rid),   // office-dev's mapping
  // a layout rule's own role text stays (custom); the generated one names the 3.0 role
  roleLabel: (role, ruleLabel) => (ruleLabel && ruleLabel.key === 'custom' ? ruleLabel : { key: 'occupantRole.' + role }),
};

// 3.0 inbound session kinds (logs ?kind=): a 3.0 kind → the canonical kinds it selects
const SESSION_KINDS_3X = ['primary', 'subagent', 'scheduled', 'conversation-direct', 'conversation-group', 'conversation', 'internal', 'unrecognized'];
project3x.sessionKindsIn = (kind) => (kind === 'internal' ? [...INTERNAL] : [kind]);
project3x.SESSION_KINDS = SESSION_KINDS_3X;

const projectionFor = (version) => (version === 3 ? project3x : require('./project2x').project2x);

module.exports = { project3x, projectionFor, SESSION_KINDS_3X };
