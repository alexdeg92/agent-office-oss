import { Button, TabButton } from '../components/bureau/index.js';
import { html, useRef, useLayoutEffect } from '../lib.js';
import { Frame, Icon } from '../components/ui.js';
import { msg, getLang } from '../i18n.js';
import { services } from '../services.js';
import { SETTINGS_TABS, settingsTab, canManageUsers } from './settings-rules.js';

export { SETTINGS_TABS, settingsTab };
export function settingsHref(tab = 'diagnostic', query = {}) {
  return services.router.href('parametres', {}, { ...query, onglet: settingsTab(tab) });
}

export function SettingsTabs({ tab, onSelect, busy = false, me }) {
  const tabs=SETTINGS_TABS.filter(id=>!['users','roles'].includes(id)||canManageUsers(me));
  const tablist = useRef(null);
  useLayoutEffect(() => {
    const list = tablist.current;
    let disposed = false;
    const edges = () => {
      list.dataset.overflowStart = String(list.scrollLeft > 1);
      list.dataset.overflowEnd = String(list.scrollLeft + list.clientWidth < list.scrollWidth - 1);
    };
    const reveal = () => {
      const active = list?.querySelector('[aria-selected=true]');
      if (!active) return;
      list.style.removeProperty('--ao-tabs-end-space');
      const row = list.getBoundingClientRect(), item = active.getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(list).scrollPaddingLeft) || 0;
      if (inset) {
        // Pick a whole-tab boundary that keeps the selected label in the viewport.
        const buttons = [...list.querySelectorAll('[role=tab]')];
        const minimum = Math.max(0, item.right - row.left + list.scrollLeft - list.clientWidth + inset);
        const starts = buttons.map(button => Math.max(0, button.getBoundingClientRect().left - row.left + list.scrollLeft - inset));
        const start = starts.find(value => value >= minimum - 1) ?? starts.at(-1);
        const end = buttons.at(-1).getBoundingClientRect().right - row.left + list.scrollLeft;
        // Let the last selection align too, rather than clamping between tab labels.
        list.style.setProperty('--ao-tabs-end-space', Math.max(inset, start + list.clientWidth - end) + 'px');
        list.scrollLeft = start;
      }
      else if (item.left < row.left) list.scrollLeft -= row.left - item.left;
      else if (item.right > row.right) list.scrollLeft += item.right - row.right;
      edges();
    };
    reveal();
    const resize = new ResizeObserver(reveal);
    resize.observe(list);
    list.addEventListener('scroll', edges, { passive: true });
    document.fonts?.ready.then(() => { if (!disposed) reveal(); });
    return () => { disposed = true; resize.disconnect(); list.removeEventListener('scroll', edges); };
  }, [tab, getLang()]);
  function select(id, focus = false) {
    if (busy) return;
    onSelect(id);
    if (focus) requestAnimationFrame(() => document.getElementById('settings-tab-' + id)?.focus({preventScroll:true}));
  }
  function keys(e) {
    const current = tabs.indexOf(tab);
    const index = e.key === 'ArrowRight' ? (current + 1) % tabs.length
      : e.key === 'ArrowLeft' ? (current + tabs.length - 1) % tabs.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (index == null) return;
    e.preventDefault(); select(tabs[index], true);
  }
  return html`<div ref=${tablist} class="bu-tabs ao-settings__tabs" role="tablist" aria-label=${msg('settings.tabs.label')} onKeyDown=${keys}>
    ${tabs.map(id => html`<${TabButton} key=${id} id=${'settings-tab-' + id}
      selected=${tab===id} controls="settings-panel" tabIndex=${tab===id?0:-1}
      disabled=${busy} onClick=${()=>select(id)} label=${msg('settings.tab.'+id)} />`)}
  </div>`;
}

export function SettingsFrame({ tab, onSelect, head, foot, children, busy = false, bodyRef, me }) {
  return html`<${Frame} class="ao-settings" head=${head} bar=${html`<${SettingsTabs} tab=${tab} onSelect=${onSelect} busy=${busy} me=${me} />`}
    foot=${foot} bodyLabel=${msg('settings.tab.' + tab)} bodyProps=${{ref: bodyRef}}>
    <div id="settings-panel" class="bu-page ao-settings__content" role="tabpanel" aria-labelledby=${'settings-tab-' + tab}>
      ${children}
    </div>
  </${Frame}>`;
}

export function SettingsFooter({ dirty, pendingSections = [], busy, writable, onDetails, onCancel, onSave, saveLabel, saveTestId, canSave = true, form = 'settings-section-form' }) {
  const status = busy ? msg('settings.busy') : pendingSections.length ? msg('settings.dirtySections',{sections:pendingSections.map(id => msg('settings.tab.' + id)).join(', ')}) : msg('settings.clean');
  return html`<div class="ao-settings__footer">
    <span class=${'bu-caption ao-settings__dirty' + (pendingSections.length ? ' ao-settings__dirty--active' : '')} role="status" aria-live="polite" title=${status}>
      ${pendingSections.length ? html`<${Icon} name="pencil" />` : html`<${Icon} name="check" />`}
      <span class="ao-settings__dirty-text">${status}</span>
    </span>
    <div class="bu-btn-group">
      <${Button} type="button" disabled=${!pendingSections.length || busy} onClick=${onDetails} variant="ghost" size="md" label=${msg('settings.saveDetails')} />
      <${Button} type="button"  disabled=${!dirty || busy || !writable} onClick=${onCancel} variant="secondary" size="md" label=${msg('common.cancel')} />
      <${Button} testId=${saveTestId} type=${form ? 'submit' : 'button'} form=${form || undefined}  disabled=${!dirty || !canSave || busy || !writable} onClick=${form ? undefined : onSave}
        busy=${busy} variant="primary" size="md" label=${saveLabel || msg('settings.save')} />
    </div>
  </div>`;
}
