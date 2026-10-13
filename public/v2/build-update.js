import { buildId } from './config.js';
import { getUIBuildId } from './api.js';
import { hasDirtyDraft, allowReload } from './services.js';

// The static UI is authoritative: API and UI releases can roll independently.
// Never import a new page into an old document, even before its next heartbeat.
export function createBuildUpdate({ build = buildId, fetchBuild = getUIBuildId,
  notify = () => {}, reload = (url) => location.assign(url), currentUrl = () => location.href } = {}) {
  let stale = false, pending = null, checkedAt = null, navigationChecked = false;
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
      // A slow radio is not evidence of a current build. Await the complete
      // bounded HTTP request, sharing it with concurrent navigation/poll checks.
      pending = Promise.resolve().then(fetchBuild).then(next => {
        if (typeof next === 'string' && next) checkedAt = Date.now();
        return observe(next);
      }, () => false).finally(() => { pending = null; });
    }
    return pending;
  }
  return {
    get stale() { return stale; }, observe, check,
    async beforeNavigate(url) {
      if (await check()) { reload(url); return false; }
      navigationChecked = true;
      return true;
    },
    beforePageLoad() {
      if (navigationChecked) { navigationChecked = false; return Promise.resolve(stale); }
      return check();
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


const GUARD = 'ao.chunk-reload';
let checkBuild = async () => {}, recovery, recovering = false, navigationUrl = () => null, notifyRecovery = () => {};
export function configureChunkRecovery(check, target = () => null, notify = () => {}) { checkBuild = check; navigationUrl = target; notifyRecovery = notify; }

// Failed imports remain cached in the document's module map. A fresh document
// is the recovery path; session storage bounds automatic reloads per build.
export function reloadChunks({ manual = false, url = null } = {}) {
  if (manual && !recovering) recovery = null;
  if (!recovery) { recovering = true; recovery = (async () => {
    if (typeof window === 'undefined') return false;
    if (!manual && hasDirtyDraft()) { notifyRecovery(); return false; }
    if (navigator.onLine === false) await new Promise(resolve => window.addEventListener('online', resolve, { once: true }));
    await checkBuild().catch(() => {});
    if (manual ? !await allowReload() : hasDirtyDraft()) { notifyRecovery(); return false; }
    const build = buildId || 'unversioned';
    try {
      if (!manual && sessionStorage.getItem(GUARD) === build) return false;
      sessionStorage.setItem(GUARD, build);
    } catch { if (!manual) return false; } // unavailable storage must not cause a reload loop
    const target = url || navigationUrl();
    if (target && new URL(target, location.href).origin === location.origin) location.assign(target); else location.reload();
    return true;
  })().finally(() => { recovering = false; }); }
  return recovery;
}

export async function recoverChunk(error) {
  if (error && typeof error === 'object') error.chunkFailure = true;
  await reloadChunks();
}

export function chunkError(error) { void recoverChunk(error); return error; }

/** Preserve the caller's relative import and let its existing error UI handle a guarded failure. */
export async function loadModule(load) {
  try { return await load(); }
  catch (error) { await recoverChunk(error); throw error; }
}
