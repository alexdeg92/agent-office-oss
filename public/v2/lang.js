// UI language choice (F6): the user's explicit choice in the FR/EN switch (cached in localStorage until UiPrefs.locale
// exists), else French. The browser's language is deliberately ignored: the product default is French. Applies to i18n/fmt and <html lang>; App re-renders.
import { negotiate, setLang, intlLocale, setMeta } from './i18n.js';
import * as api from './api.js';
import { services } from './services.js';

const KEY = 'ao.locale';
const readPref = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

/** At boot: pick and apply the language. */
export function initLang() {
  const l = setLang(negotiate(readPref()));
  document.documentElement.lang = intlLocale();
  return l;
}
/**
 * From the switch: apply at once, remember locally, then (G3c) refetch MetaVM so the server's labels come in that
 * language, and save UiPrefs.locale (best effort: a read-only store or an older server just keeps the local choice).
 */
export async function chooseLang(l) {
  try { localStorage.setItem(KEY, l); } catch { /* not persisted */ }
  setLang(l);
  document.documentElement.lang = intlLocale();
  try { const r = await api.get('/api/v2/meta?locale=' + l, { quiet: true }); if (r && r.data) { services.meta = r.data; setMeta(r.data); } } catch { /* keep the current labels */ }
  if (!api.isMock()) api.patch('/api/v2/prefs', { locale: l }, { quiet: true }).catch(() => {});
}
