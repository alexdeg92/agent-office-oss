import { chunkError } from '../../build-update.js';
import { buildQuery } from '../../config.js';

let pending;

/** Call from a consuming route's existing loadStyles gate, before its first render. */
export function loadStyles() {
  if (pending) return pending;
  const href = new URL('./bureau.css' + buildQuery, import.meta.url);
  pending = new Promise((resolve, reject) => {
    const sheet = document.createElement('link');
    sheet.rel = 'stylesheet';
    sheet.href = href.href;
    sheet.dataset.bureauControlsCss = '';
    sheet.onload = resolve;
    sheet.onerror = () => {
      sheet.remove(); pending = undefined;
      reject(chunkError(new Error('Bureau controls stylesheet unavailable')));
    };
    document.head.append(sheet);
  });
  return pending;
}
