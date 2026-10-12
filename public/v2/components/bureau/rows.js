import { html } from '../../lib.js';
import { msg } from '../../i18n.js';
import { useControlId } from './control-id.js';
import './messages.js';

const statusIcons = { error:'error', warn:'warning', info:'info', ok:'success', unknown:'search' };

/** A self-labelled control slot, or a callback receiving associated native control props. */
export function SettingRow({
  label, description, control, status, meta, details, environment,
  id, class: cls = '', testId,
}) {
  const rowId = useControlId(id, 'bu-setting');
  const ids = [description && `${rowId}-description`, environment && `${rowId}-environment`].filter(Boolean);
  const associated = typeof control === 'function';
  const labelNode = associated
    ? html`<label id=${`${rowId}-label`} for=${`${rowId}-control`}>${label}</label>`
    : html`<span id=${`${rowId}-label`}>${label}</span>`;
  return html`<div class=${['bu-setting-row', cls].filter(Boolean).join(' ')} id=${rowId} data-testid=${testId}>
    <div class="bu-setting-row__text">
      <div class="bu-setting-row__label">${labelNode}${status}</div>
      ${description ? html`<p class="bu-setting-row__description" id=${`${rowId}-description`}>${description}</p>` : null}
      ${meta ? html`<div class="bu-setting-row__meta">${meta}</div>` : null}
      ${environment ? html`<p class="bu-setting-row__description" id=${`${rowId}-environment`}>
        ${msg('bureauControl.environment', { variable:environment.variable })}
        ${environment.reason ? html`<span>${environment.reason}</span>` : null}
      </p>` : null}
    </div>
    ${control ? html`<div class="bu-setting-row__control">${associated ? control({
      id:`${rowId}-control`, describedBy:ids.join(' ') || undefined,
    }) : control}</div>` : null}
    ${details ? html`<div class="bu-setting-row__details">${details}</div>` : null}
  </div>`;
}

/** Static semantic list item. Actions remain independent of the title and avatar. */
export function ListRow({
  avatar, title, meta, badges, actions, muted = false, selected = false,
  icon, severity, statusLabel,
  id, class: cls = '', testId, fixTarget = false, memberId, parentMemberId,
}) {
  const state = severity === undefined ? undefined : Object.hasOwn(statusIcons, severity) ? severity : 'unknown';
  const statusName = statusLabel || (state ? msg(`bureauControl.status.${state}`) : undefined);
  return html`<li id=${id} data-testid=${testId} data-fix-target=${fixTarget ? 'true' : undefined} data-member-id=${memberId} data-parent-member-id=${parentMemberId} aria-current=${selected ? 'true' : undefined}
    class=${['bu-list-row', state ? 'bu-list-row--status' : '', muted ? 'bu-list-row--muted' : '', selected ? 'bu-list-row--selected' : '', cls].filter(Boolean).join(' ')}>
    ${icon || state ? html`<span class=${'bu-list-row__icon' + (state ? ` bu-list-row__icon--${state}` : '')}
      role=${statusName ? 'img' : undefined} aria-label=${statusName} aria-hidden=${statusName ? undefined : 'true'} title=${statusName}>
      <span aria-hidden="true">${icon || html`<svg class="bu-compact-icon"><use href=${'#i-' + statusIcons[state]} /></svg>`}</span>
    </span>` : null}
    ${avatar ? html`<div class="bu-list-row__avatar" aria-hidden="true">${avatar}</div>` : null}
    <div class="bu-list-row__text"><div class="bu-list-row__title"><span>${title}</span>${badges}</div>
      ${meta ? html`<div class="bu-list-row__meta">${meta}</div>` : null}
    </div>
    ${actions ? html`<div class="bu-list-row__actions">${actions}</div>` : null}
  </li>`;
}
