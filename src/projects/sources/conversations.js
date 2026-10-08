'use strict';
/*
 * architect-54 · passive project inference from what the runtime already reports (no change to the agent):
 *   - a conversation room's name (Discord '#PIVOT-2735', '#restaurant-banner'): one candidate per room, linked by the
 *     room (`{by:'interlocutor'}`), so every later conversation there links too;
 *   - a ticket key (PIVOT-2735) in a session's label or goal, or in a scheduled flow's name: one candidate per ticket,
 *     linked by those sessions' keys;
 *   - a working directory outside the workspace root: one candidate per folder, linked by session keys.
 * Each group carries `evidence` (ticket | room | label | workspace) and `confidence` (high | medium | low). The output
 * is session-group input for proposeCandidates (src/projects/discovery.js), which folds a group into a repo or folder
 * candidate of the same slug. Pure: no I/O, no clock.
 */
const path = require('path');

// PIVOT-2735: 2 to 10 letters (the project), a dash, digits (the ticket). In free text (labels, goals, flow names) the
// key must be upper case ('node-24' is not a ticket); room names are matched in any case (Discord lower-cases them).
const TICKET_ANY = /(?:^|[^A-Za-z0-9])([A-Za-z]{2,10})-(\d{1,6})(?![A-Za-z0-9])/;
const TICKET_UPPER = /(?:^|[^A-Za-z0-9])([A-Z]{2,10})-(\d{1,6})(?![A-Za-z0-9])/;
// rooms that name a place, not a project
const GENERIC_ROOMS = new Set(['general', 'generale', 'general-chat', 'random', 'annonces', 'announcements', 'accueil', 'welcome', 'bienvenue',
  'regles', 'rules', 'bot', 'bots', 'bot-commands', 'commands', 'test', 'tests', 'testing', 'logs', 'log', 'alerts', 'alertes', 'notifications',
  'off-topic', 'hors-sujet', 'discussion', 'discussions', 'chat', 'lounge', 'salon', 'questions', 'help', 'aide', 'support', 'memes', 'music',
  'musique', 'voice', 'vocal', 'links', 'liens', 'news', 'nouvelles', 'resources', 'ressources', 'feedback', 'idees', 'ideas', 'todo', 'misc', 'divers']);
// folders that name a place, not a project
const GENERIC_DIRS = new Set(['workspace', 'workspaces', 'home', 'tmp', 'temp', 'src', 'repo', 'repos', 'code', 'dev', 'project', 'projects', 'projets',
  'work', 'desktop', 'documents', 'downloads', 'sandbox', 'scratch', '.openclaw', 'openclaw', 'agent', 'agents']);

function slugOf(value) {
  return String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
// '#PIVOT-2735' → { key: 'PIVOT-2735', slug: 'pivot-2735' }
function ticketOf(text, { anyCase = false } = {}) {
  const m = (anyCase ? TICKET_ANY : TICKET_UPPER).exec(String(text || ''));
  if (!m) return null;
  const key = `${m[1].toUpperCase()}-${Number(m[2])}`;
  return { key, slug: slugOf(key) };
}
// '#restaurant-banner' → 'restaurant banner'; '#PIVOT-2735-menu' → 'PIVOT-2735 menu' (the ticket key kept whole)
function roomTitle(name) {
  const raw = String(name || '').trim().replace(/^#+/, '');
  const t = ticketOf(raw, { anyCase: true });
  const marked = t ? raw.replace(/([A-Za-z]{2,10})-(\d{1,6})(?![A-Za-z0-9])/, ' \u0001 ') : raw;
  return marked.split(/[-_\s]+/).filter(Boolean).map((w) => (w === '\u0001' ? t.key : w)).join(' ').slice(0, 80).trim();
}
const usableRoom = (slug) => slug.length >= 3 && !GENERIC_ROOMS.has(slug) && !/^[0-9a-f]{12,}$/.test(slug.replace(/-/g, '')) && !/^\d+$/.test(slug.replace(/-/g, ''));
const RANK = { low: 0, medium: 1, high: 2 };
// the agent's P0–P9 is the board's own scale since architect-55 (migration 010): taken as it is
function boardPriority(p) {
  return /^P[0-9]$/.test(String(p || '')) ? String(p) : null;
}
const atOf = (s) => (Number.isInteger(s && s.updatedAt) ? s.updatedAt : null);
const maxAt = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));

/**
 * @param {object} p
 * @param {Array} p.sessions       canonical sessions
 * @param {Array} [p.flows]        canonical cron jobs ({ id, name })
 * @param {string[]} [p.roots]     workspace roots (absolute): folders under them are the workspace source's, not ours
 * @param {string} [p.home]        the runtime home: its own directory is never a project
 * @returns {Array<{ name, slug, ref, lastActivityAt, evidence, confidence }>}
 */
function conversationGroups({ sessions = [], flows = [], roots = [], home = null, hints = [] } = {}) {
  const out = [];
  // 1. rooms: one group per room (its conversations share the interlocutor id), the newest name wins
  const rooms = new Map();
  for (const s of sessions) {
    const iid = s && s.class && s.class.interlocutorId;
    if (!iid || !/^discord-channel:\d{17,20}$/.test(iid) || !s.channelName) continue;
    const r = rooms.get(iid) || { iid, name: null, at: null };
    if (r.name == null || (atOf(s) || 0) >= (r.at || 0)) r.name = s.channelName;
    r.at = maxAt(r.at, atOf(s));
    rooms.set(iid, r);
  }
  const roomTickets = new Set();
  for (const r of rooms.values()) {
    const t = ticketOf(r.name, { anyCase: true });
    const title = roomTitle(r.name);
    const slug = t ? t.slug : slugOf(title);
    if (!t && !usableRoom(slug)) continue;
    if (t) roomTickets.add(t.key);
    out.push({ name: title || slug, slug, ref: { by: 'interlocutor', interlocutorId: r.iid }, lastActivityAt: r.at,
      evidence: t ? 'ticket' : 'room', confidence: t ? 'high' : 'medium' });
  }
  // 2. tickets in labels, goals and flow names (rooms that are tickets already have their group)
  const flowName = new Map((flows || []).filter((j) => j && j.id).map((j) => [j.id, j.name || '']));
  const tickets = new Map();
  for (const s of sessions) {
    if (!s || !s.key) continue;
    const texts = [s.label, s.goal && s.goal.objective, s.class && s.class.cronJobId ? flowName.get(s.class.cronJobId) : null];
    for (const text of texts) {
      const t = ticketOf(text);
      if (!t || roomTickets.has(t.key)) continue;
      const g = tickets.get(t.key) || { t, keys: new Set(), at: null };
      g.keys.add(s.key); g.at = maxAt(g.at, atOf(s));
      tickets.set(t.key, g);
      break;
    }
  }
  for (const g of tickets.values()) {
    out.push({ name: g.t.key, slug: g.t.slug, ref: { by: 'keys', sessionKeys: [...g.keys].sort().slice(0, 100) }, lastActivityAt: g.at, evidence: 'ticket', confidence: 'high' });
  }
  // 3. working directories outside every workspace root (and not the runtime's own)
  const inside = (dir, root) => dir === root || dir.startsWith(root.endsWith('/') ? root : root + '/');
  const dirs = new Map();
  for (const s of sessions) {
    if (!s || typeof s.cwd !== 'string' || !s.cwd.startsWith('/')) continue;
    if ((roots || []).some((r) => r && inside(s.cwd, r))) continue;
    if (home && (s.cwd === home || inside(s.cwd, path.join(home, '.openclaw')))) continue;
    const base = path.posix.basename(s.cwd);
    const slug = slugOf(base);
    if (slug.length < 3 || GENERIC_DIRS.has(slug) || base.startsWith('.')) continue;
    const g = dirs.get(s.cwd) || { base, slug, keys: new Set(), at: null };
    g.keys.add(s.key); g.at = maxAt(g.at, atOf(s));
    dirs.set(s.cwd, g);
  }
  for (const g of dirs.values()) {
    out.push({ name: g.base.slice(0, 80), slug: g.slug, ref: { by: 'keys', sessionKeys: [...g.keys].sort().slice(0, 100) }, lastActivityAt: g.at, evidence: 'workspace', confidence: 'medium' });
  }
  // 4. the project tag (a no-op tool call the agent makes; src/adapters/openclaw/project-hint.js): the strongest evidence.
  // A tag on a room's or ticket's slug strengthens that group (and gives it the tagged status); otherwise its own group.
  const tags = new Map();
  for (const h of hints || []) {
    if (!h || typeof h.slug !== 'string' || typeof h.sessionKey !== 'string') continue;
    const g = tags.get(h.slug) || { slug: h.slug, keys: new Set(), at: null, status: null, statusAt: null, priority: null, priorityAt: null, title: null, titleAt: null };
    g.keys.add(h.sessionKey); g.at = maxAt(g.at, Number.isInteger(h.at) ? h.at : null);
    if (h.status && (g.statusAt == null || (h.at || 0) >= g.statusAt)) { g.status = h.status; g.statusAt = h.at || 0; }
    const bp = boardPriority(h.priority);
    if (bp && (g.priorityAt == null || (h.at || 0) >= g.priorityAt)) { g.priority = bp; g.priorityAt = h.at || 0; }
    if (h.title && (g.titleAt == null || (h.at || 0) >= g.titleAt)) { g.title = h.title; g.titleAt = h.at || 0; }
    tags.set(h.slug, g);
  }
  for (const g of tags.values()) {
    const same = out.find((x) => x.slug === g.slug || (/^[a-z]{2,10}-\d{1,6}$/.test(g.slug) && x.slug.startsWith(g.slug + '-')));
    if (same) {
      same.confidence = 'high'; same.evidence = 'tag'; same.lastActivityAt = maxAt(same.lastActivityAt, g.at);
      if (g.status) same.statusHint = g.status;
      if (g.priority) same.priorityHint = g.priority;
      continue;
    }
    const t = g.title || (/^[a-z]{2,10}-\d{1,6}$/.test(g.slug) ? g.slug.toUpperCase() : g.slug.replace(/-/g, ' '));
    // the source names the slug (`projet:<slug>`): an imported project keeps answering to it whatever its display name,
    // so every later tag with that slug, in any conversation, links to it (src/projects/activity.js projectsForSlug)
    out.push(Object.assign({ name: t, slug: g.slug, ref: { by: 'group', groupId: 'projet:' + g.slug, name: g.slug }, lastActivityAt: g.at, evidence: 'tag', confidence: 'high' },
      g.status ? { statusHint: g.status } : {}, g.priority ? { priorityHint: g.priority } : {}));
  }
  // stable order: strongest evidence first, then newest, then slug
  return out.sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || (b.lastActivityAt || 0) - (a.lastActivityAt || 0) || a.slug.localeCompare(b.slug));
}

module.exports = { boardPriority, conversationGroups, ticketOf, roomTitle, slugOf, GENERIC_ROOMS };
