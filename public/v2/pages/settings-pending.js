import { Button, ListRow, TextAction } from '../components/bureau/index.js';
import { html } from '../lib.js';
import { msg } from '../i18n.js';
import { Modal } from '../components/modal.js';
import { settingsLabel } from './settings-labels.js';
import { SETTINGS_TABS } from './settings-rules.js';

function pendingValue(change, value) {
  if (value == null || value === '') return msg('settings.pending.empty');
  if (change.translate && typeof value === 'string') return msg(value);
  return String(value);
}

/** Modal/sheet listing pending field edits; Reveal jumps to the field. */
export function PendingDetailsSheet({ changes, onClose, onReveal }) {
  const sections = SETTINGS_TABS.filter(tab => changes.some(change => change.section === tab));
  // Skip restoring focus to Details so Reveal can move focus onto the pending field.
  return html`<${Modal} size="md" restoreFocus=${false} title=${msg('settings.pending.title')} desc=${msg('settings.pending.text')} onClose=${onClose}
    footer=${html`<${Button} type="button" onClick=${onClose} variant="secondary" size="md" label=${msg('common.close')} />`}>
    <div class="ao-settings__pending-details" data-testid="settings-pending-details">
      ${sections.map(section => html`<section key=${section} class="ao-settings__group" aria-labelledby=${'settings-pending-section-' + section}>
        <h3 class="bu-heading-sm" id=${'settings-pending-section-' + section}>${msg('settings.tab.' + section)}</h3>
        <ul class="ao-settings__list">${changes.filter(change => change.section === section).map(change => {
          const title = change.labelKey ? msg(change.labelKey) : settingsLabel(change.label);
          return html`<${ListRow} key=${change.id} testId=${'settings-pending-' + change.id}
            title=${title}
            meta=${html`<p class="ao-settings__pending-diff"><span class="ao-settings__pending-before">${pendingValue(change, change.before)}</span>
              <span aria-hidden="true"> → </span><span class="ao-settings__pending-after">${pendingValue(change, change.after)}</span></p>`}
            actions=${html`<${TextAction} targetName=${title} onPress=${() => onReveal(change)} label=${msg('settings.pending.go')} />`} />`;
        })}</ul>
      </section>`)}
    </div>
  </${Modal}>`;
}

/** Navigate then scroll/focus the pending field once the panel paints. */
export function revealPendingTarget(change, setQuery) {
  if (change.sectionIntegrations) setQuery({
    onglet: 'connexion', connecteur: change.connecteur || null, runtime: change.runtime || null, section: 'integrations', agent: null, orchestrateur: null,
  });
  else if (change.section === 'connexion') setQuery({
    onglet: 'connexion', connecteur: change.connecteur || 'all', section: null, runtime: null, agent: null,
    orchestrateur: change.connecteur === 'herdr' ? 'herdr' : null,
  });
  else if (change.section === 'agents') setQuery({
    onglet: 'agents', connecteur: change.runtime || null, section: null, runtime: null, agent: null, orchestrateur: null,
  });
  else setQuery({ onglet: change.section === 'diagnostic' ? null : change.section, section: null, runtime: null, connecteur: null, orchestrateur: null, agent: null });
  const find = () => change.testId
    ? document.querySelector(`[data-testid="${CSS.escape(change.targetId)}"]`)
    : document.getElementById(change.targetId);
  const focus = () => {
    const el = find();
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const target = el.matches('input,select,textarea,button,[href]') ? el
      : el.querySelector('input,select,textarea,button,[href],[tabindex]:not([tabindex="-1"])');
    (target || el).focus?.({ preventScroll: true });
    return true;
  };
  const retry = (attempt = 0) => {
    if (focus() || attempt >= 10) return;
    setTimeout(() => retry(attempt + 1), 16);
  };
  requestAnimationFrame(() => retry());
}
