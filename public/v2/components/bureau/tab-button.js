import { html } from '../../lib.js';

/** Native tab trigger. The parent tablist owns roving focus, selection and scrolling. */
export function TabButton({
  id, label, selected = false, controls, tabIndex = selected ? 0 : -1,
  disabled = false, title, onClick, onKeyDown, onFocus, onBlur,
  class: cls = '', testId,
}) {
  return html`<button type="button" role="tab" id=${id} class=${['bu-tab-button',cls].filter(Boolean).join(' ')}
    data-testid=${testId} title=${title} aria-selected=${selected ? 'true' : 'false'} aria-controls=${controls}
    tabindex=${tabIndex} disabled=${disabled} onClick=${onClick} onKeyDown=${onKeyDown} onFocus=${onFocus} onBlur=${onBlur}>
    ${label}
  </button>`;
}
