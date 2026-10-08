// Keyboard shortcuts sheet (F13): every shortcut the UI has, as data, in a dialog opened with « ? » (outside text
// fields) and from « À propos ». The office entries describe office-dev's handlers (office/scene.js: pan, zoom, fit;
// office/editor.js: the layout editor); keep them in step when those change.
import { html } from '../lib.js';
import { msg } from '../i18n.js';
import { createStore } from '../store.js';
import { Modal } from './modal.js';

// [keys, label, 'or'?]: keys are tokens rendered by keyLabel() (Mod = Ctrl, or ⌘ on Apple; Shift, Enter, Esc, Space,
// Delete, arrows), pressed together; with 'or' they are alternatives (← / →).
export const SHORTCUTS = [
  { group: 'global', items: [
    [['?'], 'shortcut.sheet'],
    [['Esc'], 'shortcut.close'],
    [['Tab'], 'shortcut.skip'],
  ] },
  { group: 'chat', items: [
    [['Mod', 'Enter'], 'shortcut.send'],
  ] },
  { group: 'board', items: [
    [['Space'], 'shortcut.pick'],
    [['←', '→'], 'shortcut.move', 'or'],
    [['Enter'], 'shortcut.drop'],
    [['Esc'], 'shortcut.cancelMove'],
  ] },
  { group: 'office', items: [
    [['←', '↑', '→', '↓'], 'shortcut.pan', 'or'],
    [['Shift', '←'], 'shortcut.panFast'],
    [['+', '−'], 'shortcut.zoom', 'or'],
    [['0'], 'shortcut.fit'],
  ] },
  { group: 'editor', items: [
    [['Mod', 'Z'], 'shortcut.undo'],
    [['Mod', 'Shift', 'Z'], 'shortcut.redo'],
    [['←', '↑', '→', '↓'], 'shortcut.nudge', 'or'],
    [['Mod', 'D'], 'shortcut.duplicate'],
    [['R'], 'shortcut.rotate'],
    [['Delete'], 'shortcut.delete'],
    [['Enter'], 'shortcut.place'],
    [['Esc'], 'shortcut.deselect'],
  ] },
];

const apple = () => { try { return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || ''); } catch { return false; } };
/** A key token in the reader's words (Ctrl / ⌘, Entrée / Enter, Échap / Esc, Maj / Shift…). */
export function keyLabel(k) {
  if (k === 'Mod') return apple() ? '⌘' : msg('key.ctrl');
  const named = { Shift: 'key.shift', Enter: 'key.enter', Esc: 'key.esc', Space: 'key.space', Delete: 'key.delete', Tab: 'key.tab' }[k];
  return named ? msg(named) : k;
}

/** The open state of the sheet (one for the whole app). */
export const shortcutsSheet = createStore({ open: false });
export const openShortcuts = () => shortcutsSheet.set({ open: true });
const editable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
/** « ? » opens the sheet, unless the reader is typing or a modifier is held. Installed once by app.js. */
export function installShortcutKey(doc = document) {
  doc.addEventListener('keydown', (e) => {
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || editable(e.target)) return;
    if (doc.querySelector('[role=dialog]')) return;   // another dialog owns the keyboard
    e.preventDefault();
    openShortcuts();
  });
}

export function ShortcutsList({ headingLevel = 3, idPrefix = 'keys-' }) {   // the page and the sheet can be on screen together
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return html`<div class="ao-keys">${SHORTCUTS.map((g) => html`<section key=${g.group} class="ao-keys__group" aria-labelledby=${idPrefix + g.group}>
    <${H} class="ao-keys__title" id=${idPrefix + g.group}>${msg('shortcut.group.' + g.group)}</${H}>
    <dl class="ao-keys__list">${g.items.map(([keys, label, or]) => html`<div key=${label + keys.join()} class="ao-keys__row">
      <dt>${keys.map((k, i) => html`${i ? (or ? html`<span class="ao-keys__plus"><span aria-hidden="true">/</span><span class="bu-sr-only"> ${msg('key.or')} </span></span>`
        : html`<span class="ao-keys__plus">+</span>`) : null}<kbd class="ao-kbd">${keyLabel(k)}</kbd>`)}</dt>
      <dd>${msg(label)}</dd></div>`)}</dl>
  </section>`)}</div>`;
}

export function ShortcutsDialog({ onClose }) {
  return html`<${Modal} title=${msg('shortcut.title')} desc=${msg('shortcut.desc')} onClose=${onClose} size="md"><${ShortcutsList} idPrefix="sheet-keys-" /></${Modal}>`;
}
