import { html } from '../../lib.js';
import { msg } from '../../i18n.js';
import { useControlId } from './control-id.js';
import './messages.js';

/** Compact appearance with a full native target. The caller owns navigation and pending effects. */
export function TextAction({
  label, targetName, onPress, href, busy = false, disabled = false, error,
  id, class: cls = '', testId,
}) {
  const actionId = useControlId(id, 'bu-text-action');
  const name = targetName ? msg('bureauControl.actionTarget', { action:label, target:targetName }) : label;
  const activate = event => {
    if (busy || disabled) { event.preventDefault(); return; }
    onPress?.();
  };
  const content = html`<span>${label}</span>
    ${busy ? html`<span class="bu-compact-progress" aria-hidden="true"></span>` : null}
    <svg class="bu-compact-icon" aria-hidden="true"><use href="#i-chevron-right" /></svg>`;
  const describedBy = error ? `${actionId}-error` : undefined;
  return html`<div class=${['bu-text-action', cls].filter(Boolean).join(' ')} data-testid=${testId}>
    ${href !== undefined ? html`<a id=${actionId} class="bu-text-action__control" role="link"
      href=${disabled ? undefined : href} tabindex=${disabled ? '-1' : undefined}
      aria-label=${name} aria-disabled=${busy || disabled ? 'true' : undefined}
      aria-busy=${busy ? 'true' : undefined} aria-describedby=${describedBy}
      onClick=${activate} onKeyDown=${event => {
        if ((busy || disabled) && event.key === 'Enter') event.preventDefault();
      }}>${content}</a>` : html`<button id=${actionId} type="button" class="bu-text-action__control"
      disabled=${disabled} aria-label=${name} aria-disabled=${busy ? 'true' : undefined}
      aria-busy=${busy ? 'true' : undefined} aria-describedby=${describedBy}
      onClick=${activate}>${content}</button>`}
    ${busy ? html`<span class="bu-compact-sr" role="status">${msg('common.loading')}</span>` : null}
    ${error ? html`<span id=${`${actionId}-error`} class="bu-text-action__error" role="alert">${error}</span>` : null}
  </div>`;
}
