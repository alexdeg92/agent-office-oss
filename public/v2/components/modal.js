// Modal dialog (Modal README): focus trap, Escape closes, focus returns to the opener. A bottom sheet on mobile (CSS).
import { msg } from '../i18n.js';
import { html, useLayoutEffect, useRef } from '../lib.js';
import { Icon } from './ui.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, desc, onClose, footer, children, size = 'sm' }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const opener = document.activeElement;
    const first = ref.current.querySelector('[autofocus]') || ref.current.querySelector(FOCUSABLE);
    if (first) first.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const items = [...ref.current.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const [a, z] = [items[0], items[items.length - 1]];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey, true); document.body.style.overflow = overflow; if (opener && opener.focus) opener.focus(); };
  }, []);
  return html`<div class="bu-scrim" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref=${ref} class=${'bu-modal' + (size === 'sm' ? ' bu-modal--sm' : '')} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="bu-modal__header">
        <div class="bu-modal__headtext"><h2 class="bu-modal__title" id="modal-title">${title}</h2>${desc ? html`<p class="bu-modal__desc">${desc}</p>` : null}</div>
        <button type="button" class="bu-btn bu-btn--ghost bu-btn--icon bu-btn--sm" aria-label=${msg('common.close')} title=${msg('common.close')} onClick=${onClose}><${Icon} name="close" /></button>
      </div>
      <div class="bu-modal__body">${children}</div>
      ${footer ? html`<div class="bu-modal__footer">${footer}</div>` : null}
    </div>
  </div>`;
}
