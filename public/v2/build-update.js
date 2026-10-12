import { buildId } from './config.js';
import { getUIBuildId } from './api.js';

// The static UI is authoritative: API and UI releases can roll independently.
// Never import a new page into an old document, even before its next heartbeat.
export function createBuildUpdate({ build = buildId, fetchBuild = getUIBuildId,
  notify = () => {}, reload = (url) => location.assign(url), currentUrl = () => location.href } = {}) {
  let stale = false, pending = null, checkedAt = null;
  function observe(next) {
    if (build && typeof next === 'string' && next && next !== build && !stale) {
      stale = true;
      notify(() => reload(currentUrl()));
    }
    return stale;
  }
  function check({ maxAge = 0 } = {}) {
    if (stale) return Promise.resolve(true);
    if (!pending && maxAge > 0 && checkedAt !== null && Date.now() - checkedAt < maxAge) return Promise.resolve(false);
    if (!pending) {
      let timer;
      // The version endpoint must never hold navigation hostage. Late results still
      // announce an update; the HTTP client aborts its request independently.
      const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(false), 800); });
      const request = Promise.resolve().then(fetchBuild).then(observe, () => false);
      pending = Promise.race([request, deadline]).finally(() => {
        clearTimeout(timer); pending = null; checkedAt = Date.now();
      });
    }
    return pending;
  }
  return {
    get stale() { return stale; }, observe, check,
    async beforeNavigate(url) {
      if (await check()) { reload(url); return false; }
      return true;
    },
    start(win = window) {
      const poll = () => { if (win.document.visibilityState !== 'hidden') void check(); };
      const interval = win.setInterval(poll, 25000);
      win.addEventListener('focus', poll);
      win.document.addEventListener('visibilitychange', poll);
      poll();
      return () => { win.clearInterval(interval); win.removeEventListener('focus', poll); win.document.removeEventListener('visibilitychange', poll); };
    },
  };
}
