import { createStore } from './lib.js';
import { identityRegistry } from './identity-themes/registry.js';
import { buildQuery } from './config.js';

const valid = new Set(identityRegistry.themes.map(theme => theme.id));
const identityKey = user => `ao.identity.user.${encodeURIComponent(user || 'owner')}`;
const userKey = me => me?.id != null ? String(me.id) : me?.email ? String(me.email).trim().toLowerCase() : 'owner';
const read = key => {
  try { const id = localStorage.getItem(identityKey(key)); return valid.has(id) ? id : identityRegistry.default; }
  catch { return identityRegistry.default; }
};
const initialUser = (() => { try { return localStorage.getItem('ao.identity.lastUser') || 'owner'; } catch { return 'owner'; } })();
export const identityTheme = createStore({ id: read(initialUser), user: initialUser });

function apply(id) {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.setAttribute('data-identity', id);
    let link = document.getElementById('ao-identity-theme');
    if (!link) {
      link = document.createElement('link');
      link.id = 'ao-identity-theme';
      link.rel = 'stylesheet';
      document.head.append(link);
    }
    link.onload = () => {
      const background = getComputedStyle(root).getPropertyValue('--bu-bg').trim();
      const color = document.querySelector('meta[name="theme-color"]');
      if (color && background) color.content = background;
    };
    link.href = `identity-themes/${id}/theme.css${buildQuery}`;
    const background = getComputedStyle(root).getPropertyValue('--bu-bg').trim();
    const color = document.querySelector('meta[name="theme-color"]');
    if (color && background) color.content = background;
  }
}
apply(identityTheme.get().id);

const previewStyles = new Map();
export function loadIdentityPreviewStyles() {
  if (typeof document === 'undefined') return Promise.resolve();
  return Promise.all(identityRegistry.themes.map(({ id }) => {
    if (!previewStyles.has(id)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.dataset.identityPreview = id;
      link.href = `identity-themes/${id}/theme.css${buildQuery}`;
      previewStyles.set(id, new Promise((resolve, reject) => {
        link.onload = resolve;
        link.onerror = () => { link.remove(); previewStyles.delete(id); reject(Error(`Identity preview unavailable: ${id}`)); };
      }));
      document.head.append(link);
    }
    return previewStyles.get(id);
  }));
}

export function syncIdentityTheme(me) {
  const user = userKey(me), id = read(user);
  try { localStorage.setItem('ao.identity.lastUser', user); } catch { /* preference is still usable for this session */ }
  apply(id);
  identityTheme.set({ id, user });
}
if (typeof window !== 'undefined') window.addEventListener('ao-identity-theme-change', () => {
  let user = 'owner';
  try { user = localStorage.getItem('ao.identity.lastUser') || user; } catch { /* instance owner */ }
  const id = read(user);
  apply(id);
  identityTheme.set({ id, user });
});

export function setIdentityTheme(id) {
  if (!valid.has(id)) return false;
  const user = identityTheme.get().user;
  try {
    localStorage.setItem(identityKey(user), id);
    localStorage.setItem('ao.identity.lastUser', user);
  } catch { /* keep the current session preference */ }
  apply(id);
  identityTheme.set({ id, user });
  return true;
}
export { identityRegistry };
