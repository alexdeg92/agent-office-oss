import { html, useState } from '../lib.js';
import { msg } from '../i18n.js';
import { Icon } from './ui.js';

export const ordered = (items, order, source = 'asc') => order === source ? items : [...items].reverse();
export function useOrder(view, initial = 'desc') {
  const key = 'ao.order.' + view;
  const [order, set] = useState(() => {
    try { const value = localStorage.getItem(key); return value === 'asc' || value === 'desc' ? value : initial; } catch { return initial; }
  });
  return [order, (value) => { set(value); try { localStorage.setItem(key, value); } catch {} }];
}
export function OrderToggle({ view, order, onChange }) {
  const next = order === 'desc' ? 'asc' : 'desc';
  return html`<button type="button" class="bu-btn bu-btn--ghost bu-btn--sm ao-order" data-order-view=${view} data-order=${order}
    title=${msg('order.' + next)} onClick=${() => onChange(next)}>
    <${Icon} name="arrow-down" /><span>${msg('order.' + order)}</span>
  </button>`;
}
