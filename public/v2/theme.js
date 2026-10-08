// UI theme: 'system' | 'dark' | 'light' (UiPrefs.uiTheme). Cached in localStorage until PATCH /api/v2/prefs exists.
import { createStore } from './lib.js';

const KEY = 'ao.uiTheme';
const read = () => { try { const v = localStorage.getItem(KEY); return v === 'dark' || v === 'light' ? v : 'system'; } catch { return 'system'; } };

export const theme = createStore({ pref: read() });

export function applyTheme(pref, root = document.documentElement) {
  if (pref === 'dark' || pref === 'light') root.setAttribute('data-theme', pref); else root.removeAttribute('data-theme');
  // The browser chrome colour follows the page background token.
  const bg = getComputedStyle(root).getPropertyValue('--bu-bg').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && bg) meta.setAttribute('content', bg);
}

export function setTheme(pref) {
  try { if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref); } catch { /* not persisted */ }
  theme.set({ pref });
  applyTheme(pref);
}

if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme(theme.get().pref));
}
