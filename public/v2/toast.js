// Toast queue (bu-toast). Errors from api.js land here; SSE `toast` frames too.
import { createStore } from './store.js';

export const toasts = createStore({ items: [] });
let seq = 0;
const DURATION = { info: 5000, success: 4000, warning: 7000, danger: 9000 };

/**
 * level: 'info' | 'success' | 'warning' | 'danger'. `code` is shown in mono under the message.
 * `action` = { label, run } adds a button (e.g. « Annuler »); running it dismisses the toast.
 */
export function toast({ level = 'info', message, code = null, requestId = null, action = null, duration = undefined }) {
  const id = ++seq;
  toasts.set((s) => ({ items: [...s.items.filter((t) => t.message !== message).slice(-3), { id, level, message, code, requestId, action }] }));
  if (duration !== 0) setTimeout(() => dismiss(id), duration ?? ((DURATION[level] || 5000) + (action ? 3000 : 0)));
  return id;
}
export function dismiss(id) { toasts.set((s) => ({ items: s.items.filter((t) => t.id !== id) })); }
