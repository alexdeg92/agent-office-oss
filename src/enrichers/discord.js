'use strict';
/*
 * Discord REST lookups (users, channels, guilds) with the bot token from openclaw.json.
 * The token is only passed to fetch(); it is never logged or returned.
 * Results are cached in memory and, when a store cache is given (S5), in interlocutor_cache: fresh
 * entries are preloaded at boot, so names show at once after a restart without a refetch storm.
 * Resolved profiles are refreshed after 7 days, failed lookups retried after 1 day.
 */
const CHTYPE = { 0: 'Texte', 1: 'DM', 2: 'Vocal', 3: 'Groupe', 4: 'Catégorie', 5: 'Annonces', 10: 'Fil (annonce)', 11: 'Fil public', 12: 'Fil privé', 13: 'Scène', 15: 'Forum' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function snowflakeMs(id) { try { return Number((BigInt(id) >> 22n)) + 1420070400000; } catch (_) { return 0; } }

function mapUser(j) {
  return { id: j.id, username: j.username || null, globalName: j.global_name || null,
    display: j.global_name || j.username || null, bot: !!j.bot, flags: j.public_flags || 0,
    avatar: j.avatar ? `https://cdn.discordapp.com/avatars/${j.id}/${j.avatar}.png?size=128` : null,
    createdMs: snowflakeMs(j.id) };
}
function mapChan(j) {
  return { id: j.id, rawName: j.name || null, name: j.name ? '#' + j.name : null, type: j.type,
    typeLabel: CHTYPE[j.type] || ('type ' + j.type), topic: j.topic || '', guildId: j.guild_id || null,
    parentId: j.parent_id || null, nsfw: !!j.nsfw, rateLimit: j.rate_limit_per_user || 0, createdMs: snowflakeMs(j.id) };
}

const TTL = { resolved: 7 * 86400000, failed: 86400000 };

function createDiscord({ getToken, cache = null, now = () => Date.now() }) {
  const users = new Map(), channels = new Map(), guilds = new Map();
  const userNames = new Map(), channelNames = new Map();   // id → display label (or null)
  let resolving = false;

  if (cache) {
    for (const e of cache.all()) {
      if (now() - e.fetchedAt > TTL[e.resolution]) continue;          // stale: refetched in the background
      const [kind, id] = [e.id.slice(0, e.id.indexOf(':')), e.id.slice(e.id.indexOf(':') + 1)];
      if (kind === 'discord-user') { const u = e.profile || { id }; users.set(id, u); userNames.set(id, u.display || null); }
      else if (kind === 'discord-channel') { const c = e.profile || { id }; channels.set(id, c); channelNames.set(id, c.name || null); }
      else if (kind === 'discord-guild') guilds.set(id, e.profile ? e.profile.name : null);
    }
  }
  // R14-09: listeners are told after every lookup (resolved or failed), so built views refresh their names
  const listeners = [];
  const changed = () => { for (const fn of listeners) { try { fn(); } catch (_) { /* a listener never breaks a lookup */ } } };
  const save = (id, profile) => { if (cache) { try { cache.put(id, profile, now()); } catch (_) { /* a cache write never breaks a lookup */ } } changed(); };

  async function dFetch(url, tok) {
    try { const r = await fetch(url, { headers: { Authorization: 'Bot ' + tok } }); if (!r.ok) return null; return await r.json(); } catch (_) { return null; }
  }
  async function fetchUser(id, tok) {
    const j = await dFetch('https://discord.com/api/v10/users/' + id, tok); const u = j ? mapUser(j) : { id };
    users.set(id, u); userNames.set(id, u.display || null); save('discord-user:' + id, j ? u : null);
  }
  async function fetchChannel(id, tok, pace) {
    const j = await dFetch('https://discord.com/api/v10/channels/' + id, tok); const c = j ? mapChan(j) : { id };
    channels.set(id, c); channelNames.set(id, c.name || null); save('discord-channel:' + id, j ? c : null);
    if (c.guildId && !guilds.has(c.guildId)) {
      const g = await dFetch('https://discord.com/api/v10/guilds/' + c.guildId, tok); guilds.set(c.guildId, g ? g.name : null);
      save('discord-guild:' + c.guildId, g ? { name: g.name || null } : null);
      if (pace) await sleep(120);
    }
  }

  // Background resolution of every id seen in sessions; paced at 120 ms between requests.
  // → true if it ran (even if everything was cached), false if skipped (no token / already running).
  async function resolveAll(userIds, channelIds) {
    const tok = getToken(); if (!tok || resolving) return false;
    resolving = true;
    try {
      for (const id of userIds) { if (users.has(id)) continue; await fetchUser(id, tok); await sleep(120); }
      for (const id of channelIds) { if (channels.has(id)) continue; await fetchChannel(id, tok, true); await sleep(120); }
      return true;
    } finally { resolving = false; }
  }

  // On-demand lookups (interlocutor page): fetch if missing and a token exists, then return the cached profile.
  async function userProfile(id) {
    const tok = getToken();
    if (!users.has(id) && tok) await fetchUser(id, tok);
    return users.get(id) || { id };
  }
  async function channelProfile(id) {
    const tok = getToken();
    if (!channels.has(id) && tok) await fetchChannel(id, tok, false);
    return channels.get(id) || { id };
  }
  const guildName = (gid) => guilds.get(gid) || null;

  // S7b, synchronous: an interlocutor's resolution state and cached profile, without fetching.
  // → { resolution: 'pending' | 'resolved' | 'failed', profile | null }. A failed lookup is cached as { id } only.
  function peek(interlocutorId) {
    const i = String(interlocutorId || '').indexOf(':');
    const kind = interlocutorId.slice(0, i), id = interlocutorId.slice(i + 1);
    const p = kind === 'discord-user' ? users.get(id) : kind === 'discord-channel' ? channels.get(id) : undefined;
    if (p === undefined) return { resolution: 'pending', profile: null };
    return Object.keys(p).length > 1 ? { resolution: 'resolved', profile: p } : { resolution: 'failed', profile: null };
  }

  return { resolveAll, userProfile, channelProfile, guildName, peek, onChange: (fn) => listeners.push(fn), userName: (id) => userNames.get(id), channelName: (id) => channelNames.get(id) };
}

// ---- G7 (ADR-001 §14.2–14.3): Discord as an Enricher ----------------------------------------------------------------
const s = require('../schema');
const nstr = () => s.string().nullable();
// the stored profiles (interlocutor_cache validates rows with these; 'discord-room' is the 3.0 spelling of a channel)
const USER = s.object({ id: s.snowflake(), username: nstr(), globalName: nstr(), display: nstr(), bot: s.boolean(), flags: s.int(),
  avatar: nstr(), createdMs: s.int() }, { extra: 'reject' });
const CHANNEL = s.object({ id: s.snowflake(), rawName: nstr(), name: nstr(), type: s.int(), typeLabel: s.string(), topic: s.string(),
  guildId: s.snowflake().nullable(), parentId: s.snowflake().nullable(), nsfw: s.boolean(), rateLimit: s.int(), createdMs: s.int() }, { extra: 'reject' });
const GUILD = s.object({ name: nstr() }, { extra: 'reject' });
// Discord channel type → a label slug (discordChannelType.*), for the core's InterlocutorProfile.type
const CHANNEL_TYPE = { 0: 'text', 1: 'dm', 2: 'voice', 3: 'group', 4: 'category', 5: 'announcement', 10: 'thread', 11: 'thread', 12: 'thread', 13: 'stage', 15: 'forum' };

const definition = {
  id: 'discord',
  families: ['discord'],
  cacheIds: /^discord-(user|channel|room|guild):\d{17,20}$/,
  cacheProfiles: { 'discord-user': USER, 'discord-channel': CHANNEL, 'discord-room': CHANNEL, 'discord-guild': GUILD },
  /** deps: { secret(name), cache, now, log } → Enricher */
  create({ secret = () => null, cache = null, now = () => Date.now() } = {}) {
    const d = createDiscord({ getToken: () => secret('discord.token'), cache, now });
    const sfOf = (iid) => String(iid).slice(String(iid).indexOf(':') + 1);
    const isUser = (iid) => String(iid).startsWith('discord-user:');
    // Discord's raw cached profile → the core's InterlocutorProfile (what InterlocutorVM shows); no raw field leaves here
    const profileOf = (iid, p) => (isUser(iid)
      ? { displayName: p.display || null, username: p.username || null, avatarUrl: p.avatar || null, isBot: !!p.bot, createdAt: p.createdMs }
      : { name: p.name || null, type: CHANNEL_TYPE[p.type] || 'unrecognized', topic: p.topic || '', guildName: p.guildId ? d.guildName(p.guildId) : null, createdAt: p.createdMs });
    return {
      peek(iid) { const r = d.peek(iid); return r.profile ? { resolution: r.resolution, profile: profileOf(iid, r.profile) } : r; },
      resolve: async (iid) => { if (isUser(iid)) await d.userProfile(sfOf(iid)); else await d.channelProfile(sfOf(iid)); },
      resolveAll: (ids) => d.resolveAll(ids.filter(isUser).map(sfOf), ids.filter((x) => String(x).startsWith('discord-channel:')).map(sfOf)),
      onChange: (fn) => d.onChange(fn),
    };
  },
};

module.exports = { createDiscord, mapUser, mapChan, snowflakeMs, CHTYPE, CHANNEL_TYPE, definition };
