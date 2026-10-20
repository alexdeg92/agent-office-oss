'use strict';

const crypto = require('crypto');
const { CHAT_REF } = require('./chat-constants');

// Chat ownership is keyed by the authenticated account, never by a display
// name, cookie/session id, or a caller-supplied topic parameter. The owner
// keeps the historical chat ref so existing single-owner installations retain
// their conversation; every other account gets a stable opaque ref.
function accountId(session, user, principal) {
  return user?.id || principal?.id || session?.userId || null;
}

function ownerId(store) {
  try { return store?.users?.owner?.()?.id || null; } catch { return null; }
}

function scopeForAccount(id, store) {
  // Every account, including the historical owner, gets an isolated namespace.
  // The old unscoped portal-chat ref may contain messages from several people
  // and must never be adopted as anyone's private conversation.
  if (!id) return crypto.createHash('sha256').update('agent-office:chat-owner:v1\0single-owner').digest('hex');
  return crypto.createHash('sha256').update('agent-office:chat-owner:v1\0').update(String(id)).digest('hex');
}

function scopeForRequest(req, store) {
  return scopeForAccount(accountId(req?.session, req?.user, req?.principal), store);
}

function scopeForSession(session, store) {
  return scopeForAccount(accountId(session), store);
}

function sessionRefForScope(scope) {
  return /^[a-f0-9]{64}$/.test(String(scope || '')) ? CHAT_REF + ':user:' + scope : null;
}

function portalChatIdentity(session) {
  const ref = session?.class?.explicitKey;
  if (ref === CHAT_REF) return { kind: 'legacy', scope: null };
  const match = typeof ref === 'string' && ref.match(/^portal-chat:user:([a-f0-9]{64})(?::session:cs_(?:[A-Za-z0-9_-]{32}|[a-f0-9]{48}))?$/);
  return match ? { kind: 'private', scope: match[1] } : null;
}

function visibleToAccount(session, scope, { legacy = true } = {}) {
  const identity = portalChatIdentity(session);
  if (!identity) return true;
  if (identity.kind === 'legacy') return legacy;
  return identity.scope === scope;
}

function supportsPrincipalChat(capabilities) {
  return !!capabilities?.chat && capabilities.chatSessionScope === 'principal';
}

module.exports = { accountId, ownerId, scopeForAccount, scopeForRequest, scopeForSession, sessionRefForScope, portalChatIdentity, visibleToAccount, supportsPrincipalChat };
