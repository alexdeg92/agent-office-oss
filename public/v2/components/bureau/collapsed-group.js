import { html, useState } from '../../lib.js';
import { useControlId } from './control-id.js';

/** Native disclosure. Count/label and evidence remain caller-owned, with no action nested in summary. */
export function CollapsedGroup({ label, children, defaultOpen = false, id, class: cls = '', testId }) {
  const groupId = useControlId(id, 'bu-collapsed-group');
  const [open, setOpen] = useState(defaultOpen);
  const content = (Array.isArray(children) ? children : [children]).filter(child => child !== null && child !== undefined && child !== false);
  if (!content.length) return null;
  return html`<details id=${groupId} class=${['bu-collapsed-group', cls].filter(Boolean).join(' ')}
    data-testid=${testId} open=${open} onToggle=${event => setOpen(event.currentTarget.open)}>
    <summary><svg class="bu-compact-icon" aria-hidden="true"><use href="#i-chevron-right" /></svg><span>${label}</span></summary>
    <div class="bu-collapsed-group__content">${content}</div>
  </details>`;
}
