import { html, useLayoutEffect, useRef, useState } from '../../lib.js';
import { msg } from '../../i18n.js';
import { useControlId } from './control-id.js';
import './messages.js';

/** Selectable evidence. Clipboard success is announced only after writeText resolves. */
export function KeyValue({
  label, value, mono = true, copyable = false, emptyLabel,
  id, class: cls = '', testId,
}) {
  const keyId = useControlId(id, 'bu-key-value');
  const present = value !== null && value !== undefined && value !== '';
  const text = present ? String(value) : '';
  const current = useRef(text); current.current = text;
  const alive = useRef(true), operation = useRef(0), copying = useRef(false);
  const [state, setState] = useState('idle');
  useLayoutEffect(() => { operation.current++; copying.current = false; setState('idle'); }, [text]);
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; operation.current++; copying.current = false; };
  }, []);
  async function copy() {
    if (copying.current) return;
    copying.current = true;
    const token = ++operation.current;
    setState('copying');
    let result = 'copied';
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
    } catch { result = 'error'; }
    if (alive.current && operation.current === token && current.current === text) {
      copying.current = false; setState(result);
    }
  }
  return html`<dl id=${keyId} class=${['bu-key-value', cls].filter(Boolean).join(' ')} data-testid=${testId}>
    <dt>${label}</dt><dd>
      <span class=${mono ? 'bu-key-value__value bu-key-value__value--mono' : 'bu-key-value__value'}>${present ? text : emptyLabel || msg('bureauControl.empty')}</span>
      ${copyable && present ? html`<button type="button" class="bu-key-value__copy" onClick=${copy}
        aria-label=${msg('bureauControl.copyLabel', { label })} aria-busy=${state === 'copying' ? 'true' : undefined}
        aria-disabled=${state === 'copying' ? 'true' : undefined}>
        ${msg(state === 'copying' ? 'common.loading' : 'bureauControl.copy')}
      </button>` : null}
      ${state === 'copied' ? html`<span class="bu-key-value__feedback" role="status">${msg('bureauControl.copied')}</span>` : null}
      ${state === 'error' ? html`<span class="bu-key-value__feedback bu-key-value__feedback--error" role="alert">${msg('bureauControl.copyFailed')}</span>` : null}
    </dd>
  </dl>`;
}
