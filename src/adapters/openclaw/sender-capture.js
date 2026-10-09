'use strict';
const { classifySession } = require('./classify/session-kind');
const { structuredSender, messageKey } = require('./sender');
const MAX_PENDING = 32;
const DEBOUNCE_MS = 500;

// Uses durable, per-message producer metadata. It never opens or writes runtime storage.
function createSenderCapture(repo) {
  const context = (key, session) => ({ sessionKey: key, session: session || { class: classifySession(key) } });
  function observe(sessionKey, messages, session) {
    const ctx = context(sessionKey, session);
    if (ctx.session.class?.kind !== 'conversation-group' || !Array.isArray(messages)) return 0;
    const entries = [];
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const sender = structuredSender(message, ctx), eventKey = messageKey(message);
      if (sender && eventKey) entries.push({ runtime: 'openclaw', sessionKey, eventKey, sender });
    }
    return entries.length ? repo.putMany(entries) : 0;
  }
  const lookup = (sessionKey, key) => { try { return repo.get('openclaw', sessionKey, key); } catch { return null; } };
  function watch(gw, sessionOf = () => null) {
    const pending = new Map();
    let closed = false;
    const event = (name, payload) => {
      if (closed || !payload || typeof payload.sessionKey !== 'string' || payload.sessionKey.length > 1024) return;
      const key = payload.sessionKey, session = sessionOf(key);
      if (context(key, session).session.class?.kind !== 'conversation-group') return;
      if (name === 'session.message' || name === 'chat') {
        // A failed cache write cannot interrupt gateway ingestion; no payload is logged.
        try { observe(key, [payload.message], session); } catch {}
      }
      if (name !== 'sessions.changed' || payload.reason === 'deleted' || pending.has(key) || pending.size >= MAX_PENDING) return;
      const timer = setTimeout(async () => {
        try {
          if (!closed && gw.connected) {
            const value = await gw.call('sessions.get', { key }, { background: true });
            if (!closed) observe(key, value?.messages, sessionOf(key));
          }
        } catch { /* The normal read path owns freshness; no raw errors or identities are logged here. */ }
        finally { if (pending.get(key) === timer) pending.delete(key); }
      }, DEBOUNCE_MS);
      timer.unref?.(); pending.set(key, timer);
    };
    const clear = () => { for (const timer of pending.values()) clearTimeout(timer); pending.clear(); };
    gw.on('gwevent', event); gw.on('close', clear);
    return () => { closed = true; clear(); gw.removeListener('gwevent', event); gw.removeListener('close', clear); };
  }
  return { observe, lookup, watch };
}
module.exports = { createSenderCapture, MAX_PENDING, DEBOUNCE_MS };
