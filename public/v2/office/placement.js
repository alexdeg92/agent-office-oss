// Boutique placement mode (office-dev-21): the office fills the screen (a fixed overlay over the shell), a ghost of the
// item follows the finger and snaps to tiles, tinted valid/invalid (checkPlacement: footprint, overlap, reachability);
// Pivoter / Annuler / Confirmer in a bottom bar. Tapping an item already in the office selects it: drag it to move it,
// rotate it or remove it. Every change goes to the Boutique's draft (draft.js), so undo and Enregistrer cover it.
// Keyboard: arrows move the ghost, R rotates, Enter confirms, Delete removes, Escape steps back.
import { html, useEffect, useRef, useState } from '../lib.js';
import { Frame, Icon } from '../components/ui.js';
import { OfficeScene } from './scene.js';
import { STATES } from './states.js';
import { addItem, moveItem, removeItem, findFreeSpot, checkPlacement, itemName, footprintOf, collisionTiles, MAX_ITEMS } from './editor-model.js';
import { s as tr, labelOf } from './strings.js';

const orientationsOf = (f) => f?.orientations ?? ['sw'];
const canRotate = (f) => !!f && (f.placement === 'wall' ? !f.wall?.side : orientationsOf(f).length > 1);
const tilesOf = (it, f) => footprintOf(it, f).concat(collisionTiles(it, f));

/** The first candidate for a new item: centre of the room (or a wall), moved to the nearest free spot. */
function startCand(index, layout, asset) {
  const f = index.furniture.get(asset);
  const room = index.rooms.get(layout.room);
  if (f.placement === 'wall') return { asset, wall: f.wall?.side ?? 'right', offset: Math.floor(((f.wall?.side === 'left' ? room.rows : room.cols) - (f.wall?.length ?? 1)) / 2) };
  const c = { asset, x: Math.floor(room.cols / 2) - 1, y: Math.floor(room.rows / 2) - 1, orientation: orientationsOf(f)[0] };
  return findFreeSpot(layout, index, c, c) ?? c;
}

/**
 * @param {object} p
 * @param {object} p.draft      createDraft(...) (data, commit, subscribe)
 * @param {object} p.index      indexManifest
 * @param {object} p.lay        LayoutVM (manifest, theme)
 * @param {object[]} p.occupants  current occupants (shown at their desks; optional)
 * @param {string|null} p.asset  an asset to place (new item), or null
 * @param {string|null} p.uid    an item to select first, or null
 * @param {string} p.assetBase
 * @param {() => void} p.onClose
 */
export function Placement({ draft, index, lay, occupants = [], asset = null, uid = null, assetBase, onClose, primaryName, timeZone }) {
  const host = useRef(null);
  const sceneRef = useRef(null);
  const [, force] = useState(0);
  // placing: { asset, cand, moveUid } while a ghost is shown; selected: an item's uid (move/rotate/delete)
  const st = useRef({ placing: null, selected: uid, said: '' });
  const S = st.current;
  const rerender = () => force((n) => n + 1);
  const say = (text) => { S.said = text; };

  const data = () => draft.data;
  const f = (a) => index.furniture.get(a);
  const name = (a) => labelOf(f(a), 'furniture');

  function ghost() {
    const sc = sceneRef.current;
    if (!sc) return;
    const p = S.placing;
    if (!p) { sc.hideGhost(); return; }
    const cand = p.moveUid ? { ...p.cand, uid: p.moveUid } : p.cand;
    p.check = checkPlacement(data(), index, cand);
    sc.showGhost(p.cand, p.check.ok, p.check.tiles);
  }
  function mark() { sceneRef.current?.markItems({ selected: S.placing ? null : S.selected, tilesOf }); }
  const refresh = () => { ghost(); mark(); rerender(); };

  function startNew(a) {
    if (data().items.length >= MAX_ITEMS) { say(tr('shop.place.max', { max: MAX_ITEMS })); rerender(); return; }
    S.selected = null;
    S.placing = { asset: a, cand: startCand(index, data(), a), moveUid: null };
    say(tr('shop.place.start', { item: name(a) }));
    refresh();
  }
  function startMove(u) {
    const it = data().items.find((i) => i.uid === u);
    if (!it) return;
    S.placing = { asset: it.asset, cand: { ...it }, moveUid: u };
    refresh();
  }
  function confirm() {
    const p = S.placing;
    if (!p) return;
    if (!p.check?.ok) { say(p.check?.reason ? `${p.check.reason}.` : tr('shop.place.blocked')); rerender(); return; }
    const pos = p.cand.wall != null ? { wall: p.cand.wall, offset: p.cand.offset } : { x: p.cand.x, y: p.cand.y, orientation: p.cand.orientation ?? 'sw' };
    if (p.moveUid) {
      { const m = tr('shop.place.moved', { item: itemName(data(), index, p.moveUid) }); draft.commit(moveItem(data(), p.moveUid, pos), m); say(m); }
      S.selected = p.moveUid;
    } else {
      const r = addItem(data(), { asset: p.asset, ...pos });
      { const m = tr('shop.place.placed', { item: name(p.asset) }); draft.commit(r.layout, m); say(m); }
      S.selected = r.uid;
    }
    S.placing = null;
    refresh();
  }
  function cancel() {
    if (S.placing) { S.placing = null; say(tr('shop.place.cancelled')); refresh(); return; }
    if (S.selected) { S.selected = null; refresh(); return; }
    onClose();
  }
  function rotate() {
    const target = S.placing ?? (S.selected ? { cand: data().items.find((i) => i.uid === S.selected), moveUid: S.selected, asset: data().items.find((i) => i.uid === S.selected)?.asset } : null);
    if (!target?.cand) return;
    const ff = f(target.asset);
    if (!canRotate(ff)) { say(tr('shop.place.oneOrientation')); rerender(); return; }
    let next;
    if (ff.placement === 'wall') next = { ...target.cand, wall: target.cand.wall === 'left' ? 'right' : 'left' };
    else { const os = orientationsOf(ff); next = { ...target.cand, orientation: os[(os.indexOf(target.cand.orientation ?? 'sw') + 1) % os.length] }; }
    if (S.placing) { S.placing.cand = next; refresh(); return; }
    // a selected item rotates in place (undoable), when the new footprint fits
    const pos = next.wall != null ? { wall: next.wall, offset: next.offset } : { x: next.x, y: next.y, orientation: next.orientation };
    const check = checkPlacement(data(), index, { ...next, uid: S.selected });
    if (!check.ok) { say(`${check.reason}.`); rerender(); return; }
    { const m = tr('shop.place.rotated', { item: itemName(data(), index, S.selected) }); draft.commit(moveItem(data(), S.selected, pos), m); say(m); }
    refresh();
  }
  function remove() {
    if (!S.selected) return;
    const label = itemName(data(), index, S.selected);
    { const m = tr('shop.place.removed', { item: label }); draft.commit(removeItem(data(), S.selected), m); say(m); }
    S.selected = null;
    refresh();
  }

  /** Grid candidate under a client point for the item being placed (pointer at the footprint centre). */
  function candAt(x, y) {
    const p = S.placing;
    const ff = f(p.asset);
    const g = sceneRef.current.clientToGrid(x, y);
    if (ff.placement === 'wall') {
      const a = g.wx / (index.proj.tileWidth / 2);
      const side = ff.wall?.side ?? (a >= 0 ? 'right' : 'left');
      const along = side === 'right' ? a : -a;
      return { ...p.cand, wall: side, offset: Math.round(along - (ff.wall?.length ?? 1) / 2) };
    }
    const fp = ff.footprint;
    return { ...p.cand, x: Math.round(g.x - fp.w / 2), y: Math.round(g.y - fp.d / 2) };
  }

  // Mount the scene once; it follows the draft.
  useEffect(() => {
    const labels = Object.fromEntries(STATES.map((k) => [k, tr(`state.${k}`)]));
    // Include the selected pack's admitted sprites for the placement ghost.
    const manifest = { ...lay.manifest, furniture: [...index.furniture.values()] };
    const sc = new OfficeScene(host.current, { manifest, layout: data(), assetBase, labels, theme: lay.theme.resolved, primaryName, timeZone });
    sceneRef.current = sc;
    sc.setEditing(true);
    if (occupants.length) sc.setOccupants(occupants);
    // One finger on the scene: drag the ghost (placing), or pick an item (then drag it to move). Two fingers: the
    // scene's own pan and pinch (the handler lets the second pointer through).
    let active = null;
    sc.setPointerHandler((e) => {
      if (active != null && e.pointerId !== active) return false;
      if (S.placing) {
        active = e.pointerId;
        S.placing.cand = candAt(e.clientX, e.clientY); ghost(); rerender();
        const move = (ev) => { if (ev.pointerId !== active || !S.placing) return; S.placing.cand = candAt(ev.clientX, ev.clientY); ghost(); };
        const up = (ev) => { if (ev.pointerId !== active) return; active = null; removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); rerender(); };
        addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
        return true;
      }
      const u = sc.itemAtClient(e.clientX, e.clientY, tilesOf);
      if (!u) { if (S.selected) { S.selected = null; refresh(); } return false; }
      S.selected = u; refresh();
      say(tr('shop.place.selected', { item: itemName(data(), index, u) }));
      // drag a selected item: it becomes a move with a ghost; release outside a valid spot keeps the bar to confirm
      active = e.pointerId;
      const x0 = e.clientX, y0 = e.clientY;
      let dragging = false;
      const move = (ev) => {
        if (ev.pointerId !== active) return;
        if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        if (!dragging) { dragging = true; startMove(u); }
        S.placing.cand = candAt(ev.clientX, ev.clientY); ghost();
      };
      const up = (ev) => { if (ev.pointerId !== active) return; active = null; removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); if (dragging && S.placing?.check?.ok) confirm(); else rerender(); };
      addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
      return true;
    });
    if (asset) startNew(asset); else refresh();
    // On a phone the whole room is small: start zoomed in (two fingers pan; the crosshair fits it again).
    if (innerWidth < 600) setTimeout(() => { if (sceneRef.current) { sc.zoomBy(1.6); sc.cam.user = true; } }, 80);
    const off = draft.subscribe(() => { sc.setLayout(data()); if (S.selected && !data().items.some((i) => i.uid === S.selected)) S.selected = null; refresh(); });
    // keyboard
    const onKey = (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (step && S.placing) {
        e.preventDefault();
        const c = S.placing.cand;
        S.placing.cand = c.wall != null ? { ...c, offset: c.offset + (step[0] || step[1]) } : { ...c, x: c.x + step[0], y: c.y + step[1] };
        refresh();
      } else if (e.key === 'Enter' && S.placing && !e.target.closest?.('button')) { e.preventDefault(); confirm(); }
      else if (e.key.toLowerCase?.() === 'r' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); rotate(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected && !S.placing) { e.preventDefault(); remove(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    document.addEventListener('keydown', onKey);
    // Back (a history entry) leaves placement mode
    try { history.pushState({ aoPlacement: true }, ''); } catch { /* ignore */ }
    const onPop = () => onClose({ fromHistory: true });
    addEventListener('popstate', onPop);
    document.documentElement.classList.add('ao-fs-lock');
    return () => {
      off(); document.removeEventListener('keydown', onKey); removeEventListener('popstate', onPop);
      document.documentElement.classList.remove('ao-fs-lock');
      sc.destroy(); sceneRef.current = null;
    };
  }, []);

  const p = S.placing;
  const sel = !p && S.selected ? data().items.find((i) => i.uid === S.selected) : null;
  const target = p ? f(p.asset) : sel ? f(sel.asset) : null;
  const ok = p?.check?.ok;
  return html`<${Frame} class="ao-place" role="dialog" aria-modal="true" aria-labelledby="ao-place-title" bodyClass="ao-frame__body--framed" head=${html`
    <div class="ao-place__top">
      <button type="button" class="bu-btn bu-btn--icon ao-place__close" aria-label=${tr('shop.place.close')} onClick=${() => onClose()}><${Icon} name="close" /></button>
      <h2 class="ao-place__title" id="ao-place-title">${p ? tr(p.moveUid ? 'shop.place.titleMove' : 'shop.place.title', { item: name(p.asset) }) : sel ? itemName(data(), index, sel.uid) : tr('shop.place.titleIdle')}</h2>
    </div>
`} foot=${html`    <div class="ao-place__bar" role="toolbar" aria-label=${tr('shop.place.actions')}>
      <p class=${'ao-place__hint' + (p ? (ok ? ' is-ok' : ' is-bad') : '')} aria-live="polite">${S.said || (p ? tr(ok ? 'shop.place.hintOk' : 'shop.place.hintBad') : sel ? tr('shop.place.hintSelected') : tr('shop.place.hintIdle'))}</p>
      <div class="ao-place__actions">
        ${p || sel ? html`<button type="button" class="bu-btn" disabled=${!canRotate(target)} title=${canRotate(target) ? '' : tr('shop.place.oneOrientation')} onClick=${rotate}><${Icon} name="refresh" />${tr('shop.place.rotate')}</button>` : null}
        ${sel ? html`<button type="button" class="bu-btn bu-btn--danger-ghost" onClick=${remove}><${Icon} name="close" />${tr('shop.place.remove')}</button>` : null}
        ${p ? html`<button type="button" class="bu-btn" onClick=${cancel}>${tr('shop.place.cancel')}</button>
          <button type="button" class="bu-btn bu-btn--primary" disabled=${!ok} onClick=${confirm}><${Icon} name="check" />${tr('shop.place.confirm')}</button>`
          : html`<button type="button" class="bu-btn bu-btn--primary" onClick=${() => onClose()}><${Icon} name="check" />${tr('shop.place.done')}</button>`}
      </div>
    </div>
`}>
    <div class="bu-stage ao-place__stage" ref=${host} role="region" aria-label=${tr('shop.place.stage')}></div>
  </${Frame}>`;
}
