import { html, useLayoutEffect, useRef, useState } from '../../lib.js';
import { useControlId } from './control-id.js';

const normalized = text => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
const menuItems = panel => [...panel.querySelectorAll('[role=menuitem]')];

/** Anchored menu. Native popover keeps the panel above contained row/body scrollers. */
export function Menu({ label, items = [], id, class: cls = '', testId, triggerLabel, disabled = false }) {
  const menuId = useControlId(id, 'bu-menu');
  const root = useRef(null), trigger = useRef(null), panel = useRef(null), first = useRef(0);
  const search = useRef({ text:'', at:0 });
  const [open, setOpen] = useState(false);
  const close = (restore = true) => {
    setOpen(false);
    if (restore && trigger.current?.isConnected) trigger.current.focus();
  };
  function show(last = false) { first.current = last ? -1 : 0; search.current = { text:'', at:0 }; setOpen(true); }
  useLayoutEffect(() => {
    if (!open) return;
    const element = panel.current;
    element.showPopover?.();
    function position() {
      const anchor = trigger.current.getBoundingClientRect();
      const style = getComputedStyle(element), gutter = parseFloat(style.getPropertyValue('--bu-space-4'));
      const gap = parseFloat(style.getPropertyValue('--bu-space-1'));
      const viewportWidth = window.visualViewport?.width || innerWidth;
      const viewportHeight = window.visualViewport?.height || innerHeight;
      element.style.maxHeight = `${Math.max(0, viewportHeight - 2 * gutter)}px`;
      const box = element.getBoundingClientRect();
      element.style.left = `${Math.max(gutter, Math.min(anchor.right - box.width, viewportWidth - gutter - box.width))}px`;
      const above = anchor.top - gap - box.height;
      const desired = anchor.bottom + gap + box.height > viewportHeight - gutter && above >= gutter ? above : anchor.bottom + gap;
      element.style.top = `${Math.max(gutter, Math.min(desired, viewportHeight - gutter - box.height))}px`;
    }
    position();
    const choices = menuItems(element);
    ((first.current === -1 ? choices.at(-1) : choices[0]) || element).focus();
    const outside = event => { if (!root.current?.contains(event.target)) close(false); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      if (element.hidePopover && element.matches(':popover-open')) element.hidePopover();
    };
  }, [open]);
  useLayoutEffect(() => {
    if (open && !panel.current.contains(document.activeElement)) (menuItems(panel.current)[0] || panel.current).focus();
  }, [items]);
  function choose(event, item) {
    if (item.disabled) { event.preventDefault(); return; }
    const opener = trigger.current, list = root.current.closest('li')?.parentElement;
    const rowIndex = list ? [...list.children].indexOf(root.current.closest('li')) : -1;
    close(true);
    item.onSelect?.();
    // A local row-removal action may unmount the opener; keep focus in the surviving list.
    requestAnimationFrame(() => {
      if (opener.isConnected || document.activeElement !== document.body || !list?.isConnected) return;
      const rows = [...list.children];
      const row = rows[Math.min(rowIndex, rows.length - 1)];
      const target = row?.querySelector('button:not([disabled]),a[href],input:not([disabled]),[tabindex="0"]');
      if (target) target.focus();
      else { if (!list.hasAttribute('tabindex')) list.tabIndex = -1; list.focus(); }
    });
  }
  function keydown(event) {
    const choices = menuItems(panel.current), index = choices.indexOf(document.activeElement);
    let next;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { setTimeout(() => close(false), 0); return; }
    if (event.key === 'ArrowDown') next = (index + 1) % choices.length;
    if (event.key === 'ArrowUp') next = (index - 1 + choices.length) % choices.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = choices.length - 1;
    if (next !== undefined) { event.preventDefault(); event.stopPropagation(); choices[next]?.focus(); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choices[index]?.click(); return; }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation();
      const letter = normalized(event.key), now = Date.now();
      const previous = now - search.current.at < 500 ? search.current.text : '';
      const text = previous === letter ? letter : previous + letter;
      search.current = { text, at:now };
      for (let offset = 1; offset <= choices.length; offset++) {
        const candidate = choices[(index + offset) % choices.length];
        if (normalized(candidate.dataset.menuLabel).startsWith(text)) { candidate.focus(); break; }
      }
    }
  }
  return html`<div ref=${root} class=${['bu-control-menu', cls].filter(Boolean).join(' ')} data-testid=${testId}>
    <button ref=${trigger} type="button" class="bu-control-menu__trigger" aria-label=${label}
      disabled=${disabled} aria-haspopup="menu" aria-expanded=${open ? 'true' : 'false'} aria-controls=${open ? menuId : undefined}
      onClick=${() => open ? close() : show()} onKeyDown=${event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp'); }
      }}>
      ${triggerLabel ? html`<span>${triggerLabel}</span>` : null}
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
    </button>
    ${open ? html`<div ref=${panel} id=${menuId} role="menu" aria-label=${label} tabindex="-1" popover="manual"
      class="bu-control-menu__panel" onKeyDown=${keydown}>
      ${items.map(item => item.kind === 'separator'
        ? html`<hr key=${item.id} role="separator" />`
        : item.kind === 'link'
          ? html`<a key=${item.id} class=${'bu-control-menu__item' + (item.danger ? ' bu-control-menu__item--danger' : '')}
              role="menuitem" tabindex="-1" href=${item.disabled ? undefined : item.href} aria-disabled=${item.disabled ? 'true' : undefined}
              data-menu-label=${item.label} onClick=${event => choose(event, item)}>
              ${item.icon}<span>${item.label}${item.reason ? html`<small>${item.reason}</small>` : null}</span>
            </a>`
          : html`<button key=${item.id} type="button" class=${'bu-control-menu__item' + (item.danger ? ' bu-control-menu__item--danger' : '')}
              role="menuitem" tabindex="-1" aria-disabled=${item.disabled ? 'true' : undefined}
              data-menu-label=${item.label} onClick=${event => choose(event, item)}>
              ${item.icon}<span>${item.label}${item.reason ? html`<small>${item.reason}</small>` : null}</span>
            </button>`)}
    </div>` : null}
  </div>`;
}
