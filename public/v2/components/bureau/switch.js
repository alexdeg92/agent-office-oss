import { html } from '../../lib.js';
import { msg } from '../../i18n.js';
import { useControlId } from './control-id.js';

/** Immediate preference. The parent owns the committed value and any request. */
export function Switch({
  id, checked, onCheckedChange, label, busy = false, error,
  disabled = false, required = false, invalid = false, name, describedBy,
  class: cls = '', testId,
}) {
  const controlId = useControlId(id, 'bu-switch');
  const errorId = error ? `${controlId}-error` : undefined;
  const description = [describedBy, errorId].filter(Boolean).join(' ') || undefined;
  const change = (event) => {
    const requested = event.currentTarget.checked;
    // Native activation must never become uncommitted visible state.
    event.currentTarget.checked = Boolean(checked);
    if (!busy && !disabled) onCheckedChange?.(requested);
  };
  return html`<div class=${['bu-control-switch', cls].filter(Boolean).join(' ')} data-testid=${testId}>
    <label class="bu-control-switch__label" for=${controlId}>
      <input id=${controlId} name=${name} type="checkbox" role="switch" checked=${Boolean(checked)}
        aria-labelledby=${`${controlId}-label`}
        disabled=${disabled} required=${required} aria-disabled=${busy || disabled ? 'true' : undefined}
        aria-busy=${busy ? 'true' : undefined} aria-invalid=${invalid || error ? 'true' : undefined}
        aria-describedby=${description} onChange=${change}
        onClick=${(event) => { if (busy) event.preventDefault(); }} />
      <span class="bu-control-switch__text" id=${`${controlId}-label`}>${label}</span>
      ${busy ? html`<span class="bu-control-switch__progress" role="status" aria-label=${msg('common.loading')}></span>` : null}
      <span class="bu-control-switch__track" aria-hidden="true"></span>
    </label>
    ${error ? html`<p class="bu-control-switch__error" id=${errorId} role="alert">${error}</p>` : null}
  </div>`;
}
