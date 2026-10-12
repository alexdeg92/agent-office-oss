import { html, useState } from '../../lib.js';
import { msg, getLang } from '../../i18n.js';
import { useControlId } from './control-id.js';
import { Field, TextInput, Button } from './forms.js';
import { Modal } from '../modal.js';
import { EmptyState, Icon, Frame } from '../ui.js';
import './messages.js';

const statusTone = { ok:'success', warn:'warning', error:'danger', info:'info' };
const statusText = {
  fr: { ok:'En ordre', warn:'À vérifier', error:'Erreur', info:'Information', unknown:'Non vérifié', checking:'Vérification…', disabled:'Inactif', unsupported:'Non pris en charge' },
  en: { ok:'Healthy', warn:'Needs attention', error:'Error', info:'Information', unknown:'Not checked', checking:'Checking…', disabled:'Inactive', unsupported:'Unsupported' },
};

export function SettingsSection({ title, description, actions, children, level = 2, id, class: cls = '', testId }) {
  const headingId = useControlId(id, 'bu-section');
  const Heading = level === 3 ? 'h3' : 'h2';
  return html`<section id=${headingId} data-testid=${testId} class=${['bu-section', 'bu-settings-section', cls].filter(Boolean).join(' ')} aria-labelledby=${`${headingId}-title`}>
    <header class="bu-settings-section__head"><div><${Heading} id=${`${headingId}-title`} class="bu-settings-section__title">${title}</${Heading}>${description ? html`<p class="bu-settings-section__description">${description}</p>` : null}</div>${actions ? html`<div class="bu-settings-section__actions">${actions}</div>` : null}</header>
    <div class="bu-settings-section__body">${children}</div>
  </section>`;
}

export function Badge({ label, kind = 'metadata', class: cls = '', testId }) {
  const style = kind === 'primary' ? 'bu-badge--primary' : 'bu-badge--metadata';
  return html`<span data-testid=${testId} class=${['bu-badge', style, cls].filter(Boolean).join(' ')}>${label}</span>`;
}

export function StatusChip({ state = 'unknown', label, class: cls = '', testId }) {
  const known = Object.hasOwn(statusText.fr, state) ? state : 'unknown';
  const name = label || statusText[getLang() === 'en' ? 'en' : 'fr'][known];
  const tone = statusTone[known];
  return html`<span data-testid=${testId} class=${['bu-chip', 'bu-chip--sm', tone ? `bu-chip--${tone}` : '', cls].filter(Boolean).join(' ')} data-status=${known}>
    <${Icon} name=${known === 'ok' ? 'success' : known === 'error' ? 'error' : known === 'warn' ? 'warning' : known === 'checking' ? 'refresh' : known === 'disabled' ? 'close' : 'info'} />${name}
  </span>`;
}

export function Banner({ tone = 'info', title, text, action, details, class: cls = '', testId }) {
  const safeTone = ['info','success','warning','danger'].includes(tone) ? tone : 'info';
  const role = safeTone === 'danger' ? 'alert' : 'status';
  return html`<div data-testid=${testId} class=${['bu-banner', safeTone === 'info' ? '' : `bu-banner--${safeTone}`, cls].filter(Boolean).join(' ')} role=${role}>
    <${Icon} name=${safeTone === 'danger' ? 'error' : safeTone === 'warning' ? 'warning' : safeTone === 'success' ? 'success' : 'info'} />
    <span class="bu-banner__text">${title ? html`<strong>${title}</strong> ` : null}${text}${details ? html`<details class="bu-banner__details"><summary>${msg('bureauControl.details')}</summary><div>${details}</div></details>` : null}</span>
    ${action ? html`<${Button} class="bu-btn bu-btn--sm" label=${action.label} onPress=${action.onPress} busy=${action.busy} />` : null}
  </div>`;
}

export function Link({ href, label, icon, class: cls = '', testId }) {
  return html`<a href=${href} data-testid=${testId} class=${['bu-library-link', cls].filter(Boolean).join(' ')}>${icon}${label}</a>`;
}

export function InlineEditableText({ value, label, onCommit, emptyLabel, maxLength = 80, disabled = false, class: cls = '', testId }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const [error, setError] = useState('');
  const id = useControlId(undefined, 'bu-inline-edit');
  const start = () => { setDraft(value == null ? '' : String(value)); setError(''); setEditing(true); };
  const cancel = () => { setDraft(value == null ? '' : String(value)); setError(''); setEditing(false); };
  const commit = () => {
    const next = draft.trim();
    if (!next) { setError(msg('bureauControl.inlineRequired')); return; }
    if (next.length > maxLength) { setError(msg('bureauControl.inlineMax', { n:maxLength })); return; }
    onCommit?.(next); setError(''); setEditing(false);
  };
  const content = editing
    ? html`<span class="bu-inline-edit__form"><${TextInput} id=${id} label=${label} value=${draft} maxLength=${maxLength} onValueChange=${setDraft} onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { e.preventDefault(); cancel(); } }} />
        <${Button} label=${msg('bureauControl.accept')} size="sm" variant="primary" onPress=${commit} />
        <${Button} label=${msg('common.cancel')} size="sm" onPress=${cancel} />
      </span>${error ? html`<span class="bu-inline-edit__error" role="alert">${error}</span>` : null}`
    : html`<span class="bu-inline-edit__view">${value || emptyLabel || ''}<${Button} label=${msg('bureauControl.editName', { name:label })} size="sm" variant="ghost" disabled=${disabled} onPress=${start} /></span>`;
  return html`<span data-testid=${testId} class=${['bu-inline-edit', cls].filter(Boolean).join('')}>${content}</span>`;
}

export function SecretField({ label, tokenSet = false, replacement = null, onReplacementChange, environment, error, disabled = false, id, class: cls = '', testId }) {
  const [replacing, setReplacing] = useState(false);
  const inputId = useControlId(id, 'bu-secret');
  const isEditing = replacing || !tokenSet;
  const keep = () => { setReplacing(false); onReplacementChange?.(null); };
  return html`<div data-testid=${testId} class=${['bu-secret-field', cls].filter(Boolean).join('')}>
    ${tokenSet && !isEditing ? html`<div class="bu-secret-field__stored"><span>${msg('bureauControl.secretStored')}</span><${Button} label=${msg('bureauControl.replace')} size="sm" variant="ghost" disabled=${disabled} onPress=${() => { setReplacing(true); onReplacementChange?.(''); }} /></div>` : null}
    ${isEditing ? html`<${Field} id=${inputId} label=${label} error=${error} environment=${environment} control=${props => html`<${TextInput} ...${props} type="password" autoComplete="new-password" value=${replacement || ''} onValueChange=${onReplacementChange} disabled=${disabled} />`} />
      ${tokenSet && replacing ? html`<p class="bu-field__hint">${msg('bureauControl.secretKeep')}</p><${Button} label=${msg('common.cancel')} size="sm" onPress=${keep} disabled=${disabled} />` : null}` : null}
  </div>`;
}

export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel, onConfirm, onCancel, busy = false, error, children }) {
  if (!open) return null;
  const footer = html`<${Button} label=${cancelLabel || msg('common.cancel')} disabled=${busy} onPress=${onCancel} />
    <${Button} label=${confirmLabel} variant="danger" busy=${busy} onPress=${onConfirm} />`;
  return html`<${Modal} title=${title} desc=${description} footer=${footer} onClose=${busy ? () => {} : onCancel}>
    ${children}${error ? html`<p role="alert" class="bu-field__error">${error}</p>` : null}
  </${Modal}>`;
}

export function Disclosure({ title, open, onOpenChange, children, id, class: cls = '', testId }) {
  return html`<details id=${id} data-testid=${testId} class=${['bu-library-disclosure', cls].filter(Boolean).join('')} open=${open} onToggle=${e => onOpenChange?.(e.currentTarget.open)}>
    <summary>${title}</summary><div class="bu-library-disclosure__content">${children}</div>
  </details>`;
}

export { EmptyState, Icon, Frame };
