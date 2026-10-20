// Display names for occupants (platform direction): a nameplate, roster row, drawer or announcement never
// shows a raw id. Order: the occupant's name from the VM → the primary agent's name (MetaVM.primaryAgent) for the
// primary agent → « L’agent » / “The agent” (editorial guide §1); other roles fall back to their role label (UI locale). Pure.
import { s } from './strings.js';
import { canonicalRole } from './layout-rules.js';

export const AGENT_FALLBACK = 'L’agent';
// Role fallbacks in either vocabulary (api-v3 D3): 2.x cron/dm/channel and 3.0 scheduled/direct/group/conversation.
const ROLES = ['subagent', 'scheduled', 'direct', 'group', 'conversation'];
const isPrimary = (occ) => canonicalRole(occ.role) === 'primary';

/** True for an empty name or one that is really an identifier (OccupantId, runtime agent id, session key). */
export function isRawId(name, occ = {}) {
  if (typeof name !== 'string' || !name.trim()) return true;
  const n = name.trim();
  if (n === occ.id || n === occ.agentId || n === occ.sessionKey) return true;
  if (isPrimary(occ) && (n === 'main' || n === 'primary')) return true;     // the contract's primary OccupantId (2.x main, 3.0 primary)
  return /^(main|primary|subagent|cron|dm|channel|scheduled|direct|group|conversation|session|agent):\S+$/.test(n);              // `${role}:${subjectId}`, session keys
}

/**
 * @param {{ id, role, name?, sourceName? }} occ
 * @param {{ primaryName?: string|null }} [opts]  MetaVM.primaryAgent.name (the page passes i18n.agentName())
 */
export function displayName(occ, { primaryName = null, title = null, titleSource = null } = {}) {
  // 2.4 (architect-26) OccupantVM.title: a generated name (« Sous-agent ffff ») is server text in the server's
  // language; its title is the same name in the UI's language. A name the layout or the runtime gave is kept as is:
  // only when the VM name equals the title's server-language text is the localized title shown instead.
  // `title` / `titleSource`: the title in the UI language / in the server's language (the page renders both).
  const generated = occ.title && occ.title.key !== 'sessionTitle.named' && occ.title.key !== 'sessionTitle.main';
  if (generated) {
    if (title && !isRawId(title, occ) && (!occ.name || isRawId(occ.name, occ) || occ.name.trim() === (titleSource ?? '').trim())) return title.trim();
    // A generic role LabelRef is the server's display contract. If the client
    // cannot resolve it, do not silently recreate the label from the role;
    // that would hide a missing locale entry or a renderer that dropped the ref.
    if (occ.role === 'subagent' && occ.title?.key === 'occupantRole.subagent') return s('names.agent');
  }
  for (const n of [occ.name, occ.sourceName]) if (!isRawId(n, occ)) return n.trim();
  if (isPrimary(occ) && !isRawId(primaryName, occ)) return primaryName.trim();
  const role = canonicalRole(occ.role);
  return ROLES.includes(role) ? s(`role.${role}`) : s('names.agent');
}
