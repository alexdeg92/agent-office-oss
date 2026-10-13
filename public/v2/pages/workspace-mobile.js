import { chunkError } from '../build-update.js';
// Route-owned controls and layout: never loaded by the Bureau landing page.
import { useState, useEffect } from '../lib.js';
import { buildQuery } from '../config.js';
import { loadStyles as loadBureauStyles } from '../components/bureau/index.js';
import '../messages/workspace.js';

let pending;
export function loadStyles() {
  if (!pending) pending = new Promise((resolve, reject) => {
    const sheet = document.createElement('link');
    sheet.rel = 'stylesheet';
    sheet.href = new URL('./workspace-mobile.css' + buildQuery, import.meta.url).href;
    sheet.onload = resolve;
    sheet.onerror = () => { sheet.remove(); pending = undefined; reject(chunkError(new Error('Workspace stylesheet unavailable'))); };
    document.head.append(sheet);
  });
  return Promise.all([loadBureauStyles(), pending]);
}

export function useSmallWorkspace() {
  const [small, setSmall] = useState(() => matchMedia('(max-width: 820px)').matches);
  useEffect(() => {
    const media = matchMedia('(max-width: 820px)'), change = () => setSmall(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return small;
}
