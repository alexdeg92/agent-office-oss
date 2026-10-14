import { html, useRef, useReducer, useLayoutEffect } from '../../lib.js';
import { msg } from '../../i18n.js';
import { useControlId } from './control-id.js';
import './messages.js';

const classes = (...values) => values.filter(Boolean).join(' ');
const progress = (label) => html`<span class="bu-compact-progress" aria-hidden="true"></span>
  <span class="bu-compact-sr" role="status" aria-label=${label || msg('common.loading')}></span>`;

/** Association/layout only: the caller owns draft values and environment policy. */
export function Field({ id, label, control, hint, error, environment, required = false, class: cls, testId }) {
  const controlId = useControlId(id, 'bu-field');
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const environmentId = environment ? `${controlId}-environment` : undefined;
  const describedBy = [hintId, errorId, environmentId].filter(Boolean).join(' ') || undefined;
  return html`<div class=${classes('bu-field', cls)} data-testid=${testId}>
    <label class="bu-field__label" id=${`${controlId}-label`} for=${controlId}>${label}${required ? html`<span aria-hidden="true"> *</span>` : null}</label>
    ${control({ id:controlId, labelledBy:`${controlId}-label`, describedBy, invalid:Boolean(error), required })}
    ${hint ? html`<p class="bu-field__hint" id=${hintId}>${hint}</p>` : null}
    ${error ? html`<p class="bu-field__error" id=${errorId} role="alert">${error}</p>` : null}
    ${environment ? html`<p class="bu-field__hint" id=${environmentId}>${msg('bureauControl.environment', { variable:environment.variable })}
      ${environment.reason ? html`<span>${environment.reason}</span>` : null}</p>` : null}
  </div>`;
}

// Repair a declined or transformed edit after native callbacks have read the real event.
// Comparing values avoids moving the caret during accepted edits.
function useValue({ value, busy, disabled, readOnly, onValueChange, onInput, onChange }, select = false) {
  const ref = useRef(null);
  const [, repair] = useReducer(n => n + 1, 0);
  const committed = value == null ? '' : String(value);
  useLayoutEffect(() => {
    if (ref.current && ref.current.value !== committed) ref.current.value = committed;
  });
  const edit = event => {
    if (!busy && !disabled && !readOnly) {
      onValueChange?.(event.currentTarget.value);
      (select ? onChange : onInput)?.(event);
    }
    repair();
  };
  return { ref, committed, edit };
}

export function TextInput({
  id, name, type = 'text', form, autoComplete, autocomplete, min, max, step, maxLength, maxlength,
  minLength, pattern, placeholder, inputMode, spellCheck, spellcheck, value, onValueChange, onInput, onChange,
  label, labelledBy, describedBy, invalid = false, required = false, disabled = false, readOnly = false,
  busy = false, width = 'full', class: cls, testId, onBlur, onFocus, onKeyDown,
}) {
  const { ref, committed, edit } = useValue({ value, busy, disabled, readOnly, onValueChange, onInput });
  return html`<span class=${classes('bu-input-control', `bu-input-control--${['content','short','medium','full'].includes(width) ? width : 'full'}`, cls)}>
    <input ref=${ref} id=${id} data-testid=${testId} class="bu-text-input" name=${name} type=${type} form=${form}
      autocomplete=${autoComplete ?? autocomplete} min=${min} max=${max} step=${step} maxlength=${maxLength ?? maxlength}
      minlength=${minLength} pattern=${pattern} placeholder=${placeholder} inputmode=${inputMode} spellcheck=${spellCheck ?? spellcheck}
      value=${committed} onInput=${edit} onChange=${event => { if (!busy && !disabled && !readOnly) onChange?.(event); }} onBlur=${onBlur} onFocus=${onFocus} onKeyDown=${onKeyDown}
      aria-label=${label} aria-labelledby=${labelledBy} aria-describedby=${describedBy} aria-invalid=${invalid ? 'true' : undefined}
      aria-busy=${busy ? 'true' : undefined} aria-disabled=${busy ? 'true' : undefined}
      disabled=${disabled} readonly=${readOnly || busy} required=${required} />
    ${busy ? progress() : null}
  </span>`;
}

export function TextArea({
  id, name, form, autoComplete, autocomplete, rows = 3, maxLength, maxlength, minLength,
  placeholder, spellCheck, spellcheck, value, onValueChange, onInput, onChange, onBlur, onFocus,
  label, labelledBy, describedBy, invalid = false, required = false, disabled = false, readOnly = false,
  busy = false, mono = false, class: cls, testId,
}) {
  const { ref, committed, edit } = useValue({ value, busy, disabled, readOnly, onValueChange, onInput });
  return html`<span class=${classes('bu-input-control', 'bu-input-control--full', cls)}>
    <textarea ref=${ref} id=${id} data-testid=${testId} class=${classes('bu-text-input', mono && 'bu-text-input--mono')}
      name=${name} form=${form} autocomplete=${autoComplete ?? autocomplete} rows=${rows} maxlength=${maxLength ?? maxlength}
      minlength=${minLength} placeholder=${placeholder} spellcheck=${spellCheck ?? spellcheck} value=${committed}
      onInput=${edit} onChange=${event => { if (!busy && !disabled && !readOnly) onChange?.(event); }} onBlur=${onBlur} onFocus=${onFocus}
      aria-label=${label} aria-labelledby=${labelledBy} aria-describedby=${describedBy} aria-invalid=${invalid ? 'true' : undefined}
      aria-busy=${busy ? 'true' : undefined} aria-disabled=${busy ? 'true' : undefined}
      disabled=${disabled} readonly=${readOnly || busy} required=${required} />
    ${busy ? progress() : null}
  </span>`;
}

export function Select({
  id, name, form, value, onValueChange, onChange, onInput, options = [],
  label, labelledBy, describedBy, invalid = false, required = false, disabled = false, busy = false,
  width = 'content', class: cls, testId, onBlur, onFocus,
}) {
  const { ref, committed, edit } = useValue({ value, busy, disabled, onValueChange, onChange }, true);
  return html`<span class=${classes('bu-input-control', `bu-input-control--${['content','short','medium','full'].includes(width) ? width : 'content'}`, cls)}>
    <select ref=${ref} id=${id} name=${name} form=${form} data-testid=${testId} class="bu-text-input" value=${committed}
      onChange=${edit} onInput=${event => { if (!busy && !disabled) onInput?.(event); }} onBlur=${onBlur} onFocus=${onFocus}
      onMouseDown=${event => { if (busy) event.preventDefault(); }}
      onPointerDown=${event => { if (busy) event.preventDefault(); }}
      onClick=${event => { if (busy) event.preventDefault(); }}
      onKeyDown=${event => { if (busy && event.key !== 'Tab') event.preventDefault(); }}
      aria-label=${label} aria-labelledby=${labelledBy} aria-describedby=${describedBy} aria-invalid=${invalid ? 'true' : undefined}
      aria-busy=${busy ? 'true' : undefined} aria-disabled=${busy ? 'true' : undefined} disabled=${disabled} required=${required}>
      ${options.map(option => html`<option key=${option.value} value=${option.value} disabled=${option.disabled}>${option.label}</option>`)}
    </select>${busy ? progress() : null}
  </span>`;
}

// DOM bookkeeping only: restoring a declined native radio edit must also restore
// its previously checked sibling. Unrelated forms and non-library inputs are untouched.
const committedRadios = new WeakMap();
function Choice({
  kind, id, name, form, value, checked, onCheckedChange, onInput, onChange, onBlur, onFocus,
  label, labelledBy, describedBy, invalid = false, required = false, disabled = false,
  busy = false, mixed = false, class: cls, testId,
}) {
  const controlId = useControlId(id, `bu-${kind}`);
  const ref = useRef(null);
  const [, repair] = useReducer(n => n + 1, 0);
  useLayoutEffect(() => () => { if (ref.current) committedRadios.delete(ref.current); }, []);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.checked = Boolean(checked);
    if (kind === 'checkbox') input.indeterminate = Boolean(mixed);
    else {
      committedRadios.set(input, Boolean(checked));
      if (input.name) for (const peer of input.getRootNode().querySelectorAll('input[type="radio"]')) {
        if (peer.name === input.name && peer.form === input.form && committedRadios.has(peer)) peer.checked = committedRadios.get(peer);
      }
    }
  });
  return html`<label class=${classes('bu-choice', cls)} for=${controlId}>
    <input ref=${ref} id=${controlId} data-testid=${testId} type=${kind} name=${name} form=${form} value=${value}
      checked=${Boolean(checked)} disabled=${disabled} required=${required}
      aria-labelledby=${labelledBy || (label ? `${controlId}-label` : undefined)} aria-describedby=${describedBy}
      aria-invalid=${invalid ? 'true' : undefined} aria-busy=${busy ? 'true' : undefined} aria-disabled=${busy ? 'true' : undefined}
      onClick=${event => { if (busy) event.preventDefault(); }} onBlur=${onBlur} onFocus=${onFocus}
      onInput=${event => { if (!busy && !disabled) onInput?.(event); }}
      onChange=${event => {
        if (!busy && !disabled) { onCheckedChange?.(event.currentTarget.checked); onChange?.(event); }
        repair();
      }} />
    ${label ? html`<span id=${`${controlId}-label`}>${label}</span>` : null}${busy ? progress() : null}
  </label>`;
}
/** Staged values: no persistence or service writes occur here. */
export const Checkbox = props => html`<${Choice} ...${props} kind="checkbox" />`;
export const Radio = props => html`<${Choice} ...${props} kind="radio" mixed=${false} />`;

export function Button({
  id, label, icon, iconOnly = false, title, variant = 'secondary', size = 'md', type = 'button', form, name, value,
  formAction, formMethod, formEncType, formTarget, formNoValidate, onPress, onClick, onBlur, onFocus,
  busy = false, busyLabel, disabled = false, describedBy, pressed, class: cls, testId, children,
}) {
  const style = ['primary','secondary','ghost','danger'].includes(variant) ? variant : 'secondary';
  const scale = ['sm','md','lg'].includes(size) ? size : 'md';
  return html`<button id=${id} data-testid=${testId} class=${classes('bu-button', `bu-button--${style}`, `bu-button--${scale}`, iconOnly && 'bu-button--icon', cls)}
    type=${type} form=${form} name=${name} value=${value} formaction=${formAction} formmethod=${formMethod} formenctype=${formEncType}
    formtarget=${formTarget} formnovalidate=${formNoValidate} disabled=${disabled} title=${title || (iconOnly ? label : undefined)}
    aria-label=${label} aria-describedby=${describedBy} aria-pressed=${pressed === undefined ? undefined : String(!!pressed)} aria-busy=${busy ? 'true' : undefined}
    aria-disabled=${busy ? 'true' : undefined} onBlur=${onBlur} onFocus=${onFocus}
    onClick=${event => {
      if (busy || disabled) { event.preventDefault(); return; }
      onPress?.(); onClick?.(event);
    }}>
    ${icon ? html`<span class="bu-button__icon" aria-hidden="true">${icon}</span>` : null}
    ${children !== undefined ? children : iconOnly ? null : html`<span>${label}</span>`}${busy ? progress(busyLabel) : null}
  </button>`;
}
