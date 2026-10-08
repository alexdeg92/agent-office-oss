import { buildId } from './config.js';
import { getUIBuildId } from './api.js';

// The static UI is authoritative: API and UI releases can roll independently.
// Never import a new page into an old document, even before its next heartbeat.
export function createBuildUpdate({ build = buildId, fetchBuild = getUIBuildId,
  notify = () => {}, reload = (url) => location.assign(url), currentUrl = () => location.href } = {}) {
  let stale = false, pending = null;
  function observe(next) {
    if (build && typeof next === 'string' && next && next !== build && !stale) {
      stale = true;
      notify(() => reload(currentUrl()));
    }
    return stale;
  }
  function check() {
    if (stale) return Promise.resolve(true);
    if (!pending) pending = Promise.resolve().then(fetchBuild).then(observe, () => false).finally(() => { pending = null; });
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
