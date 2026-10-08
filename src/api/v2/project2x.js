'use strict';
/*
 * The 2.x compatibility projection (ADR-001 §12.6, G3a). Every value whose canonical form changes in G3b passes
 * through one of these functions on its way into a v2 VM. In G3a canonical values ARE the 2.x values, so each
 * function is the identity (the v2 golden diff is empty); G3b changes the canonical vocabulary behind them and only
 * this file maps it back:
 *   occupant id  'primary'      → 'main'; '<role>:<subject>' with its role projected (OccupantVM.id, journal ids)
 *   interlocutors: only Discord's are visible in 2.x
 *   occupant role 'primary'     → 'main'; 'scheduled' → 'cron'; 'direct' → 'dm'; 'group' and 'conversation' → 'channel'
 *   session kind 'primary' → 'main'; 'scheduled' → 'cron'; 'conversation-direct' → 'chat-direct';
 *                'conversation-group' and 'conversation' → 'chat-group' (inbound: the reverse, for the logs filter)
 *   channel      any ChannelRef → a 2.x ChannelId ('discord' | 'whatsapp' | 'wechat' | 'unrecognized')
 *   live kind    unchanged in 2.x
 *   board filter (inbound) 'with-timmy' ≡ 'with-agent' for the primary
 * The 3.0 contract (G5) uses the canonical values directly; these aliases never appear in 3.0.
 */
const OCCUPANT_ID = { primary: 'main' };
const ROLE = { primary: 'main', scheduled: 'cron', direct: 'dm', group: 'channel', conversation: 'channel' };
const SESSION_KIND = { primary: 'main', scheduled: 'cron', 'conversation-direct': 'chat-direct', 'conversation-group': 'chat-group', conversation: 'chat-group' };
const SESSION_KIND_IN = { main: 'primary', cron: 'scheduled', 'chat-direct': 'conversation-direct', 'chat-group': 'conversation-group' };
const SESSION_KINDS_2X = ['main', 'dashboard', 'subagent', 'cron', 'chat-direct', 'chat-group', 'acp', 'explicit', 'unrecognized'];
const CHANNELS_2X = new Set(['discord', 'whatsapp', 'wechat', 'unrecognized']);

const project2x = {
  // 'primary' → 'main'; '<role>:<subject>' gets its role prefix projected ('scheduled:j1' → 'cron:j1')
  occupantId: (id) => {
    if (id == null) return id;
    if (Object.prototype.hasOwnProperty.call(OCCUPANT_ID, id)) return OCCUPANT_ID[id];
    const cut = String(id).indexOf(':');
    return cut > 0 ? project2x.occupantRole(id.slice(0, cut)) + id.slice(cut) : id;
  },
  // 2.x knows Discord interlocutors only (InterlocutorVM.kind 'discord-user' | 'discord-channel'); other families are 3.0
  interlocutorVisible: (id) => /^discord-(user|channel):/.test(String(id)),
  occupantRole: (role) => (Object.prototype.hasOwnProperty.call(ROLE, role) ? ROLE[role] : role),
  sessionKind: (kind) => (Object.prototype.hasOwnProperty.call(SESSION_KIND, kind) ? SESSION_KIND[kind] : kind),
  // inbound: a 2.x SessionKind (logs ?kind=) → the canonical kinds it stands for
  sessionKindsIn: (kind) => (kind === 'chat-group' ? ['conversation-group', 'conversation'] : [Object.prototype.hasOwnProperty.call(SESSION_KIND_IN, kind) ? SESSION_KIND_IN[kind] : kind]),
  channelId: (ref) => (ref == null ? null : CHANNELS_2X.has(ref) ? ref : 'unrecognized'),
  liveKind: (kind) => kind,
  // inbound: a 2.x board filter → the canonical filter. Applied from G3b, when projects knows 'with-agent' (unused in G3a)
  // G7: 'unresolvable' (no enricher for the family) is 3.0; 2.x says 'pending', its old "no lookup will come"
  resolution: (r) => (r === 'unresolvable' ? 'pending' : r),
  boardFilterIn: (f) => (f === 'with-timmy' ? 'with-agent' : f),
  // G5: the hooks the builders call where 3.0 differs in SHAPE (project3x.js); here they keep the 2.x shapes exactly
  version: 2,
  runtimeKind: () => undefined,                                        // 2.x has no runtimeKind field
  interlocutorKind: (id) => String(id).slice(0, String(id).indexOf(':')),   // 'discord-user' | 'discord-channel'
  interlocutorChannel: () => undefined,                                // 2.x has no channel field on interlocutors
  healthChannelId: (c) => (project2x.channelId(c.id) === 'unrecognized' ? 'raw:' + c.rawId : c.id),
  flowJobFields: (job, primaryId) => ({ agentId: job.agentId || primaryId || '', sessionTarget: job.sessionTarget || 'unrecognized', wakeMode: job.wakeMode || 'unrecognized' }),
  flowJobExt: () => undefined,
  // G5: stored layouts are in 3.0 names (D4); 2.x shows a rule id in its 2.x name (office-dev's toVocabulary)
  layoutRuleId: (rid) => {
    if (rid == null) return rid;
    const lr = require('./vm/office').officeDefaults().rules;
    return lr.canonicalRuleId(rid) ? lr.toVocabulary({ agents: [{ agentId: rid }] }, '2.x').agents[0].agentId : rid;
  },
  roleLabel: (role, ruleLabel) => ruleLabel,
  deliveryChannel: (ch) => ch,
};

project2x.SESSION_KINDS = SESSION_KINDS_2X;

module.exports = { project2x, SESSION_KINDS_2X };
