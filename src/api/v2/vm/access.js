'use strict';
// Habilitations: AccessVM and InterlocutorVM (api.md §3.5). Pure builders over canonical agents, sessions, the config
// projection and the enrichers' cached InterlocutorProfiles (`peek`: no network from a builder). G7 (ADR-001 §14.2): no
// enricher's raw profile reaches here; an id no selected enricher resolves is 'unresolvable'.
const { deriveInterlocutors } = require('../../../engine/derive/interlocutors');
const { project2x: P2 } = require('../project2x');
const { isInterlocutorId } = require('../../../engine/model/kinds');
const NO_ACCESS = () => ({ policy: null, enabled: null, requireMention: null });
const isDiscord = (kind) => kind === 'discord-user' || kind === 'discord-channel';

const { CHANNEL_TYPE } = require('../../../enrichers/discord');   // kept exported for compatibility (unused here)
const isUser = (iid) => /^[a-z][a-z0-9-]*-user:/.test(String(iid));

// The runtime config only has Discord policies today: any other channel's access is unknown (null), never Discord's (G5)
function accessOf(kind, snowflake, config) {
  if (!isDiscord(kind)) return NO_ACCESS();
  const dc = (config && config.discord) || null;
  if (kind === 'discord-user') return { policy: dc ? dc.dmPolicy : null, enabled: null, requireMention: null };
  const c = dc && dc.channels ? dc.channels[snowflake] : null;
  return { policy: dc ? dc.groupPolicy : null, enabled: c ? c.enabled : null, requireMention: c ? c.requireMention : null };
}

// InterlocutorProfile → the list's name and avatar
const nameOf = (iid, p) => (!p ? null : isUser(iid) ? p.displayName || p.username || null : p.name || null);
const avatarOf = (iid, p) => (p && isUser(iid) ? p.avatarUrl || null : null);

/**
 * @param {object} p
 * @param {Array} p.agents     canonical Agent[]
 * @param {Array} p.sessions   canonical Session[]
 * @param {object|null} p.config canonical Config
 * @param {(id) => {resolution, profile}} p.peek  the enrichers' lookup (cached only): InterlocutorProfile or 'unresolvable'
 */
function buildAccessVM({ agents, sessions, config, peek, primaryId = null, P = P2 }) {
  const dc = (config && config.discord) || null;
  const chans = dc && dc.channels ? Object.values(dc.channels) : [];
  return {
    agents: agents.map((a) => ({ id: a.id, name: a.name || a.id, model: a.model ? a.model.primary : null,
      modelSource: a.modelSource ?? null, runtime: a.runtime ?? null, isPrimary: primaryId != null ? a.id === primaryId : a.isPrimary })),
    interlocutors: deriveInterlocutors(sessions).filter((i) => P.interlocutorVisible(i.id)).map((i) => {
      const { resolution, profile } = peek(i.id);
      return Object.assign({ id: i.id, kind: P.interlocutorKind(i.id) }, channelOf(P, i.id), { name: nameOf(i.id, profile),
        avatarUrl: avatarOf(i.id, profile), resolution: P.resolution(resolution),
        sessionCount: i.stats.sessionCount, totalTokens: i.stats.totalTokens, lastSeenAt: i.stats.lastSeenAt,
        access: accessOf(i.kind, i.snowflake, config) });
    }),
    policy: { dm: dc ? dc.dmPolicy : null, group: dc ? dc.groupPolicy : null,
      channelsEnabled: chans.filter((c) => c.enabled).length, channelsTotal: chans.length, execSecurity: config ? config.execSecurity : null },
  };
}

const ID = /^discord-(user|channel):\d{17,20}$/;
// G5: { channel } in 3.0 (right after `kind`), nothing in 2.x
const channelOf = (P, iid) => { const ch = P.interlocutorChannel(iid); return ch === undefined ? {} : { channel: ch }; };

/**
 * → InterlocutorVM | null (no session with this interlocutor). The profile is the enricher's InterlocutorProfile as is.
 */
function buildInterlocutorVM(id, { sessions, config, peek, P = P2 }) {
  if (P.version === 3 ? !isInterlocutorId(String(id)) : !ID.test(String(id))) return null;
  const i = deriveInterlocutors(sessions).find((x) => x.id === id);
  if (!i) return null;
  const { resolution, profile } = peek(id);
  const own = sessions.filter((s) => s.class.interlocutorId === id && !s.class.heartbeatOf)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key));
  return {
    id, kind: P.interlocutorKind(id), ...channelOf(P, id), resolution: P.resolution(resolution), profile: profile ? Object.assign({}, profile) : null,
    access: accessOf(i.kind, i.snowflake, config),
    stats: Object.assign({}, i.stats),
    sessions: own.map((s) => ({ id: s.key, updatedAt: s.updatedAt, tokens: s.usage.total, model: s.model ? s.model.id : null })),
    primarySessionKey: i.primarySessionKey,
  };
}

module.exports = { buildAccessVM, buildInterlocutorVM, CHANNEL_TYPE };
