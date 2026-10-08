'use strict';
const { SESSION_KINDS } = require('../../../engine/model/kinds');   // core vocabulary (G2, G3b)
/*
 * SessionKind classifier (replaces legacy classifySession regexes). Ordered rules, first match wins.
 * Grounded in capture-20261005 (docs/architecture/capture-findings.md):
 *   - the key grammar is the primary signal: raw `kind` is 'direct' for almost everything (dashboard,
 *     subagent, cron) and raw `channel` is the LAST delivery channel (agent:main:main says 'whatsapp');
 *   - `isMain` and `subagentRole` are reliable confirmations;
 *   - '<base>:heartbeat' is a background variant of <base>, not a kind; it is classified with the
 *     BASE session's structured evidence when the base row is known (R2-04), never its own isMain.
 */
// G3b (ADR-001 §12.3): the channel family is OPEN. A chat-shaped key on any channel slug classifies; OpenClaw's own
// spellings of a channel are aliased to its ChannelRef ('openclaw-weixin' → 'wechat'); every other slug is itself.
const { channelRefOf, ALIASES: CHANNEL_ALIASES } = require('../normalise/channel');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const DIRECT = ['direct', 'dm'];
const GROUP = ['channel', 'group', 'room', 'thread', 'slash'];
// key segments that are never a channel (the non-chat rules above own them)
const NOT_CHANNELS = new Set(['main', 'subagent', 'cron', 'dashboard', 'acp', 'explicit', 'heartbeat']);

// Each rule: { id, kind, match(key, row) → captures object | null }
const RULES = [
  { id: 'is-main', kind: 'primary', match: (k, r) => (r && r.isMain === true ? {} : null) },
  { id: 'main-key', kind: 'primary', match: (k) => (/^agent:[^:]+:main$/.test(k) ? {} : null) },
  { id: 'subagent', kind: 'subagent', match: (k) => { const m = k.match(/^agent:[^:]+:subagent:([^:]+)$/); return m ? { subagentId: m[1] } : null; } },
  // structured fallback: no key grammar, so the subject is the key itself (minus the agent prefix),
  // which keeps two such sub-agents distinct everywhere (R2-04)
  { id: 'subagent-role', kind: 'subagent', match: (k, r) => (r && typeof r.subagentRole === 'string' && r.subagentRole ? { subagentId: k.replace(/^agent:[^:]+:/, '') || k } : null) },
  { id: 'cron', kind: 'scheduled', match: (k) => { const m = k.match(/^agent:[^:]+:cron:([^:]+)$/); return m ? { cronJobId: m[1] } : null; } },
  { id: 'dashboard', kind: 'dashboard', match: (k) => (/^agent:[^:]+:dashboard:[^:]+$/.test(k) ? {} : null) },
  { id: 'acp', kind: 'acp', match: (k) => (/^agent:[^:]+:acp:[^:]+$/.test(k) ? {} : null) },
  { id: 'explicit', kind: 'explicit', match: (k) => { const m = k.match(/^agent:[^:]+:explicit:(.+)$/); return m ? { explicitKey: m[1] } : null; } },
  { id: 'chat-direct', kind: 'conversation-direct', match: (k) => chat(k, (sc) => DIRECT.includes(sc)) },
  { id: 'chat-group', kind: 'conversation-group', match: (k) => chat(k, (sc) => GROUP.includes(sc)) },
  // chat-shaped (agent:<id>:<channel>:<scope>:<peer>) with a scope we don't know: still a conversation (§12.3)
  { id: 'chat', kind: 'conversation', match: (k) => chat(k, () => true) },
];

function chat(key, scopeOk) {
  const m = key.match(/^agent:[^:]+:([a-z][a-z0-9-]*):([a-z][a-z0-9-]*):(.+)$/);
  if (!m || NOT_CHANNELS.has(m[1]) || !scopeOk(m[2])) return null;
  const channel = channelRefOf(m[1]);
  return channel ? { channel, scope: m[2], peer: m[3] } : null;
}

// Interlocutor id (§12.5): the CHANNEL's grammar decides (ADR-001 §14.1; Discord's keeps its exact 2.x ids)
const { interlocutorIdOf } = require('../../../channels');
const interlocutorOf = (kind, c) => interlocutorIdOf(c.channel, { kind, scope: c.scope, peer: c.peer });

/**
 * @param {string} key  raw session key
 * @param {object} [row] validated raw row of THIS key (sessions.list / describe), when known
 * @param {object} [opts.baseRow] for a heartbeat key: the validated row of its base session, when known
 * @returns SessionClassification (data-model.md §2)
 */
function classifySession(key, row, opts = {}) {
  key = String(key || '');
  const hb = key.match(/^(.*):heartbeat$/);
  const baseKey = hb ? hb[1] : key;
  const r = hb ? opts.baseRow : row;            // a variant uses its base's evidence, never its own
  const agentId = (baseKey.match(/^agent:([^:]+):/) || [])[1] || null;
  const out = { kind: 'unrecognized', ruleId: 'none', agentId, channel: null, heartbeatOf: hb ? baseKey : null,
    background: !!(row && row.isBackground), rawClassification: (row && row.classification) || null };
  for (const rule of RULES) {
    const c = rule.match(baseKey, r);
    if (!c) continue;
    out.kind = rule.kind; out.ruleId = rule.id;
    if (c.subagentId) out.subagentId = c.subagentId;
    if (c.cronJobId) out.cronJobId = c.cronJobId;
    if (c.explicitKey) out.explicitKey = c.explicitKey;
    if (c.channel) {
      out.channel = c.channel; out.chatScope = c.scope;
      const id = interlocutorOf(rule.kind, c);
      if (id) out.interlocutorId = id;
    }
    break;
  }
  return out;
}

// Key shape with ids masked (test/golden readability only; issues use redact.safeKeyShape).
function keyShape(key) {
  return String(key || '').split(':').map((x) => (/^\d{5,}$/.test(x) ? '<number>' : /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(x) ? '<uuid>' : /\d/.test(x) && x.length > 12 ? '<id>' : x)).join(':');
}

module.exports = { classifySession, keyShape, RULES, CHANNEL_ALIASES, channelRefOf, SESSION_KINDS };
