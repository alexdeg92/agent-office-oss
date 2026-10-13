'use strict';

const { MAX_SESSION_PAGE_SIZE, MAX_SESSION_PAGES } = require('../../engine/session-limits');

// A superseded snapshot may still have an RPC in flight. Fence its result and
// ingestion tap before allowing the next walk to start.
function createSessionWalker({ gw, nextAcquisitionGeneration = null, onFailure = () => {}, onSuccess = () => {}, pageSize = MAX_SESSION_PAGE_SIZE, maxPages = MAX_SESSION_PAGES }) {
  let generation = 0;
  async function walk({ signal } = {}) {
    const own = ++generation;
    const acquisitionGeneration = typeof nextAcquisitionGeneration === 'function' ? nextAcquisitionGeneration() : own;
    const current = () => own === generation && !signal?.aborted;
    let offset = 0;
    for (let i = 0; i < maxPages; i++) {
      if (!current()) return null;
      let page;
      try { page = await gw.call('sessions.list', offset ? { limit: pageSize, offset } : { limit: pageSize }, { shouldIngest: current, acquisitionGeneration }); }
      catch (error) {
        if (!current()) return null;
        const message = String(error?.message || '').toLowerCase();
        onFailure(/timeout|timed out/.test(message) ? 'timeout' : /auth|unauthori[sz]ed|credential/.test(message) ? 'auth' : 'protocol');
        return null;
      }
      if (!current()) return null;
      if (!page || !Array.isArray(page.sessions)) { onFailure('protocol'); return null; }
      if (page.hasMore !== true) { onSuccess(); return page; }
      const next = Number.isInteger(page.nextOffset) ? page.nextOffset : offset + page.sessions.length;
      if (next <= offset) { onFailure('protocol'); return null; }
      offset = next;
    }
    if (current()) onFailure('protocol');
    return null;
  }
  return { walk, invalidate() { generation++; } };
}

module.exports = { createSessionWalker };
