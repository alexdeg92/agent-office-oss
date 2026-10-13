import { loadModule } from './build-update.js';
// Small shared badge bridge: load release comparison logic after shell paint; the notes data stays on À propos.
import { buildQuery } from './config.js';

export function watchReleaseBadge(email, setBadge) {
  let alive = true;
  let unsubscribe = () => {};
  loadModule(() => import('./release-notes.js' + buildQuery)).then(({ hasUnseenRelease, onReleaseSeen }) => {
    if (!alive) return;
    const update = () => { hasUnseenRelease(email).then((value) => { if (alive) setBadge(value); }); };
    update();
    unsubscribe = onReleaseSeen(update);
  }).catch(() => { if (alive) setBadge(true); });
  return () => { alive = false; unsubscribe(); };
}
