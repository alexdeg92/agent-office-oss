// office-dev-22 · visits: the people the agent talks with (conversation occupants: direct messages, group channels,
// conversations) come to the agent. Pure: no DOM; the page tracks exchanges and hands the plan to the scene
// (scene.setVisits). Tested in test/office/visits.test.js.
//
// An exchange is read from what the client sees: a conversation occupant going from idle to active is one exchange (a
// person's message, then the agent's reply run). Where: a visit at the agent's desk; a meeting at the table for at least
// MEETING_TURNS exchanges from the same person within WINDOW_MS (≥ 2 messages and ≥ 2 replies), a group channel, or two
// people visiting at once.
//
// office-dev-23: when the server gives OccupantVM.exchanges { recent, windowMs, lastAt } (architect-55: answered messages
// from the transcript, so exchanges from before the page was opened count too), it is preferred; an exchange in progress
// (the occupant active since after lastAt) adds one. Without it, the client's own count above is the fallback.
//
// office-dev-24 (Owner): a visit has phases (phaseOf). Only an exchange in flight talks:
//   - 'person': the person's message is the latest: their run started less than PERSON_TURN_MS ago and no reply is
//     known since (exchanges.lastAt); the person has the « … » bubble;
//   - 'agent': the agent's reply run is still active (it may be waiting on a sub-agent: the conversation's run spans
//     the whole job, which is why the person's occupant stays « working » on the server); the agent has the bubble and
//     the person « attend une réponse »;
//   - 'linger': the run is over: no bubble, no talking; the person stands idle LINGER_MS, then walks out, and the agent
//     is back at his desk.
import { canonicalRole } from './layout-rules.js';

export const VISIT = { WINDOW_MS: 10 * 60_000, MEETING_TURNS: 2, LINGER_MS: 60_000, PERSON_TURN_MS: 12_000 };
const CONVERSATION = new Set(['direct', 'group', 'conversation']);
const ACTIVE = (s) => !!s && s !== 'idle' && s !== 'offline';
export const isVisitor = (o) => CONVERSATION.has(canonicalRole(o.role));

/**
 * Update the exchange log from a new occupant list: { [id]: { turns: number[], active: boolean, lastActiveAt } }.
 * A visitor going from inactive (or unseen) to active adds a turn at its stateSince (else now). Old turns drop out.
 */
export function trackTurns(prev, occupants, now = Date.now(), cfg = VISIT) {
  const next = {};
  for (const o of occupants ?? []) {
    if (!isVisitor(o)) continue;
    const p = prev?.[o.id] ?? { turns: [], active: false, lastActiveAt: null };
    const active = ACTIVE(o.state) && o.presence !== 'seen';
    const turns = p.turns.filter((t) => now - t < cfg.WINDOW_MS);
    if (active && !p.active) turns.push(Math.min(now, o.stateSince ?? now));
    const server = validExchanges(o.exchanges) ?? p.server ?? null;  // kept while the person is off stage or only « seen »
    // office-dev-24: the last live occupant, so the person can linger after their run ends (API 2.x has no « seen »)
    const occ = o.presence !== 'seen' ? snapshot(o) : p.occ ?? null;
    next[o.id] = { turns, active, lastActiveAt: active ? now : p.lastActiveAt, ...(server ? { server } : {}), ...(occ ? { occ } : {}) };
  }
  // someone not on stage right now (between two exchanges): keep their recent history
  for (const [id, p] of Object.entries(prev ?? {})) {
    if (next[id]) continue;
    const turns = p.turns.filter((t) => now - t < cfg.WINDOW_MS);
    const last = lastActivity(p);
    if (turns.length || (last != null && now - last < cfg.WINDOW_MS)) next[id] = { ...p, turns, active: false };
  }
  return next;
}

const snapshot = (o) => ({ id: o.id, role: o.role, name: o.name, ...(o.sourceName ? { sourceName: o.sourceName } : {}), roleLabel: o.roleLabel,
  title: o.title, look: o.look, ruleId: o.ruleId, sessionKey: o.sessionKey ?? null, stateSince: o.stateSince, lastSeenAt: o.lastSeenAt ?? null, tokens: o.tokens ?? 0 });

/**
 * office-dev-24: visitors whose run just ended and who are no longer in the list (2.x drops them at once): their last
 * occupant, idle, while they linger (LINGER_MS after their last activity). They then walk out.
 */
export function lingering(track, occupants, now = Date.now(), cfg = VISIT) {
  const here = new Set((occupants ?? []).map((o) => o.id));
  return Object.entries(track ?? {}).filter(([id, t]) => !here.has(id) && t.occ && !t.active
    && phaseOf({ ...t.occ, state: 'idle' }, t, now, cfg) === 'linger')
    .map(([, t]) => ({ ...t.occ, state: 'idle', stateSince: t.lastActiveAt ?? t.occ.stateSince, stationUid: null, destination: null }));
}

const validExchanges = (x) => (x && Number.isFinite(x.recent) && Number.isFinite(x.lastAt) ? x : null);

/** The newest activity known for a tracked person: seen active by the client, or the server's last answered exchange. */
export function lastActivity(t) {
  const a = t?.lastActiveAt ?? null, b = t?.server?.lastAt ?? null;
  return a == null ? b : b == null ? a : Math.max(a, b);
}

/**
 * Exchanges within the window: the server's count when known (OccupantVM.exchanges, or the last one tracked), plus one
 * exchange in progress; otherwise the client's own turns.
 */
export function exchangeCount(o, t, now = Date.now(), cfg = VISIT) {
  const server = validExchanges(o?.exchanges) ?? t?.server ?? null;
  if (!server) return (t?.turns ?? []).filter((x) => now - x < cfg.WINDOW_MS).length;
  const fresh = now - server.lastAt < (server.windowMs ?? cfg.WINDOW_MS) ? server.recent : 0;
  const inProgress = ACTIVE(o?.state) && o?.presence !== 'seen' && (o?.stateSince ?? now) > server.lastAt;
  return fresh + (inProgress ? 1 : 0);
}

const activeNow = (o) => ACTIVE(o?.state) && o?.presence !== 'seen';

/** A visitor's phase: 'person' | 'agent' (an exchange in flight) | 'linger' (just over) | null (not visiting). */
export function phaseOf(o, t, now = Date.now(), cfg = VISIT) {
  if (!activeNow(o)) {
    const last = lastActivity(validExchanges(o?.exchanges) ? { ...t, server: o.exchanges } : t);
    return last != null && now - last < cfg.LINGER_MS ? 'linger' : null;
  }
  const since = o.stateSince ?? now;
  const x = validExchanges(o.exchanges) ?? t?.server ?? null;
  const replied = !!x && x.lastAt >= since;
  return !replied && now - since < cfg.PERSON_TURN_MS ? 'person' : 'agent';
}

/**
 * Who visits whom: { hostId, desk: [visitorId…], meeting: [id…] (host first), talking, speaker, until }. `talking`: an
 * exchange is in flight (both in talking poses, facing each other); `speaker`: who has the bubble (a visitor id, the
 * host's, or null); `until`: when the plan changes by time alone (the page re-plans then), or null.
 * The scene falls back to standing by the desk when the room has no meeting table.
 */
export function planVisits(occupants, track, now = Date.now(), cfg = VISIT) {
  const host = (occupants ?? []).find((o) => canonicalRole(o.role) === 'primary' && o.presence !== 'seen') ?? null;
  const empty = { hostId: host?.id ?? null, desk: [], meeting: [], talking: false, speaker: null, until: null };
  if (!host) return empty;
  const phases = new Map();
  for (const o of occupants ?? []) if (isVisitor(o)) { const p = phaseOf(o, track?.[o.id], now, cfg); if (p) phases.set(o, p); }
  const visiting = [...phases.keys()];
  if (!visiting.length) return empty;
  const turnsOf = (o) => exchangeCount(o, track?.[o.id], now, cfg);
  const meeting = visiting.length > 1 || visiting.some((o) => canonicalRole(o.role) === 'group') || visiting.some((o) => turnsOf(o) >= cfg.MEETING_TURNS);
  const talker = visiting.find((o) => phases.get(o) === 'person');
  const talking = visiting.some((o) => phases.get(o) !== 'linger');
  const ends = visiting.map((o) => {
    const p = phases.get(o);
    if (p === 'person') return (o.stateSince ?? now) + cfg.PERSON_TURN_MS;
    if (p === 'linger') { const t = track?.[o.id]; return lastActivity(validExchanges(o.exchanges) ? { ...t, server: o.exchanges } : t) + cfg.LINGER_MS; }
    return Infinity;
  }).filter(Number.isFinite);
  const ids = visiting.map((o) => o.id);
  return { hostId: host.id, desk: meeting ? [] : ids, meeting: meeting ? [host.id, ...ids] : [], talking,
    speaker: talker ? talker.id : talking ? host.id : null, until: ends.length ? Math.min(...ends) : null };
}
