// Office customization editor (design/office/editor.md, S14c). Preact + htm (vendored, import map).
// openEditor() wraps an existing OfficeScene: the top bar, the side panel and the item toolbar render
// into hosts the page provides; the scene itself is the live preview. Every rule comes from
// layout-rules.js (shared with the server); the store is the layout API (or mock-store.js).
import { h, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import {
  History, addItem, moveItem, removeItem, renameItem, duplicateItem, findFreeSpot, updateAgent, updateTheme,
  toggleAccessory, effectiveAccessories, checkPlacement, validateLayout, resolveOccupants, itemName,
  collisionTiles, footprintOf, homeStations, ruleKind, MAX_ITEMS, NAME_MAX, ROLE_MAX,
} from './editor-model.js';
import { poseImage, accessoryLayers, resolveUrl, furnitureImage, roomImage, themeFor } from './assets.js';
import { STATES, viewFor } from './states.js';
import { displayName } from './names.js';
import { SetupCharacters } from './setup-characters.js';
import { agentRows as sharedAgentRows } from './agent-looks.js';
import { config } from '../config.js';
import { duration as words } from './strings.js';
import { defaultAccessoriesFor, canonicalRuleId, canonicalRole, roleOfRule, presenceMinutes } from './layout-rules.js';
const PRESENCE_CHOICES = [0, 15, 30, 60, 120, 240];
const presenceText = (m) => words(m * 60_000);
import { resolveTheme } from './theme.js';
import { SurpriseSetting } from './surprise-setting.js';
import { s as tr, labelOf, intlLocale } from './strings.js';

const html = htm.bind(h);

/** Colours from server data (manifest swatches): hex, rgb() or hsl() only; anything else is dropped. */
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|hsla?\(\s*[\d.]+(deg)?\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+%?\s*)?\))$/i;
export const safeColor = (c) => (typeof c === 'string' && COLOR_RE.test(c.trim()) ? c.trim() : '');
const NARROW = '(max-width: 820px)';

// ---------- icons (Lucide, ISC) ----------
const ICON = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  rename: '<path d="M12 20h9"/><path d="M16.38 3.62a1 1 0 0 1 3 3L7.37 18.64a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  boutique: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};
const Icon = ({ name }) => html`<svg class="bu-icon" viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ICON[name] }}></svg>`;

// UI text: strings.js (FR + EN), read at render time so a language switch applies on the next render.
const CATEGORY_LABEL = (c) => tr(`ed.cat.${c}`);
const SLOT_LABEL = (slot) => tr(`ed.slot.${slot}`);
const DEFAULT_RULE_LABEL = (id) => tr(`ed.rule.${canonicalRuleId(id) ?? id}`);
const ROLE_LABEL = (role) => tr(`role.${canonicalRole(role) ?? role}`);
const furnitureLabel = (f) => labelOf(f, 'furniture');
const DAY_MS = 86_400_000;

// ---------- controller ----------
class EditorController {
  constructor(opts) {
    this.o = opts;
    this.scene = opts.scene;
    this.index = this.scene.index;
    this.listeners = new Set();
    this.mode = matchMedia(NARROW).matches ? 'characters' : 'layout';
    this.selected = null;
    this.highlight = null;
    this.placing = null;
    this.modal = null;
    this.saving = false;
    this.agentSel = null;   // the first row (the primary agent) until one is picked
    this.previewState = 'working';
    this.announcement = '';
    this.notice = null;
    this.narrow = matchMedia(NARROW).matches;
  }

  async init() {
    this.vm = await this.o.store.get();
    this.history = new History(this.vm.layout.data);
    this.scene.setEditing(true);
    this.scene.setPointerHandler((e) => this.onScenePointer(e));
    this.offCam = this.scene.onCamera(() => this.emit());
    this.mq = matchMedia(NARROW);
    this.onMq = () => { this.narrow = this.mq.matches; if (this.narrow && this.mode === 'layout') this.mode = 'characters'; this.emit(); };
    this.mq.addEventListener('change', this.onMq);
    this.onKey = (e) => this.onKeyDown(e);
    document.addEventListener('keydown', this.onKey, true);
    this.apply();
  }

  get draft() { return this.history.current; }
  get dirty() { return this.history.dirty; }
  get errors() { return validateLayout(this.draft, this.index); }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.version = (this.version ?? 0) + 1; for (const fn of this.listeners) fn(); }

  say(text) { this.announcement = text; this.emit(); }

  // -- scene preview --
  occupantsPreview() {
    const live = this.o.getOccupants();
    const resolved = resolveOccupants(this.draft, this.index, live.map((o) => ({ id: o.id, role: o.role, sourceName: o.sourceName ?? o.name })));
    return resolved.map((r, i) => ({
      ...live[i], ...r,
      // Disposition pauses states on « Inactif » so nobody acts up while furniture moves (editor.md §1).
      state: this.mode === 'layout' ? 'idle' : live[i].state,
      stateSince: this.mode === 'layout' ? Date.now() : live[i].stateSince,
    }));
  }

  apply() {
    const d = this.draft;
    this.scene.setLayout(d);
    this.scene.setTheme(d.theme.mode === 'fixed' ? d.theme.fixed : 'auto');
    this.scene.setOccupants(this.occupantsPreview());
    this.mark();
    this.emit();
  }

  mark() {
    this.scene.markItems({ selected: this.mode === 'layout' ? this.selected : null, highlight: this.highlight, tilesOf: (it, f) => footprintOf(it, f).concat(collisionTiles(it, f)) });
  }

  commit(next, announce) {
    if (this.history.push(next)) this.apply();
    if (announce) this.say(announce);
  }

  undo() { if (this.history.canUndo) { this.history.undo(); this.fixSelection(); this.apply(); this.say(tr('ed.undone')); } }
  redo() { if (this.history.canRedo) { this.history.redo(); this.fixSelection(); this.apply(); this.say(tr('ed.redone')); } }
  fixSelection() { if (this.selected && !this.draft.items.some((i) => i.uid === this.selected)) this.selected = null; }

  setMode(m) {
    if (m === 'layout' && this.narrow) return;
    this.cancelPlace();
    this.mode = m;
    this.highlight = null;
    this.apply();
  }

  // -- selection and item commands (Disposition) --
  select(uid, { focus = false } = {}) {
    this.selected = uid;
    this.mark();
    if (uid) this.say(tr('ed.selected', { item: itemName(this.draft, this.index, uid) }));
    this.emit();
    if (focus) requestAnimationFrame(() => document.querySelector(`[data-placed="${uid}"]`)?.focus());
  }

  nudge(uid, dx, dy) {
    const it = this.draft.items.find((i) => i.uid === uid);
    const cand = it.wall != null ? { ...it, offset: it.offset + (dx || dy) } : { ...it, x: it.x + dx, y: it.y + dy };
    const c = checkPlacement(this.draft, this.index, cand);
    if (!c.ok) return this.say(`${c.reason}.`);
    const pos = it.wall != null ? { offset: cand.offset } : { x: cand.x, y: cand.y };
    this.commit(moveItem(this.draft, uid, pos), it.wall != null ? tr('ed.moved', { item: itemName(this.draft, this.index, uid) }) : tr('ed.movedTo', { item: itemName(this.draft, this.index, uid), x: cand.x, y: cand.y }));
  }

  rotate(uid) {
    const it = this.draft.items.find((i) => i.uid === uid);
    const f = this.index.furniture.get(it?.asset);
    if (!f || (f.orientations ?? ['sw']).length < 2) return this.say(tr('ed.oneOrientation'));
    const o = (it.orientation ?? 'sw') === 'sw' ? 'se' : 'sw';
    const c = checkPlacement(this.draft, this.index, { ...it, orientation: o });
    if (!c.ok) return this.say(`${c.reason}.`);
    this.commit(moveItem(this.draft, uid, { orientation: o }), tr('ed.rotated', { item: itemName(this.draft, this.index, uid) }));
  }

  duplicate(uid) {
    if (this.draft.items.length >= MAX_ITEMS) return this.say(tr('ed.maxItems', { max: MAX_ITEMS }));
    const r = duplicateItem(this.draft, this.index, uid);
    if (!r) return this.say(tr('ed.noFreeSpot'));
    this.commit(r.layout, tr('ed.duplicated', { item: itemName(r.layout, this.index, r.uid) }));
    this.select(r.uid, { focus: true });
  }

  remove(uid) {
    const name = itemName(this.draft, this.index, uid);
    const holders = this.draft.agents.filter((a) => a.station === uid);
    this.selected = null;
    this.commit(removeItem(this.draft, uid), tr(holders.length ? 'ed.removedHolders' : 'ed.removed', { item: name }));
  }

  rename(uid, label) {
    this.modal = null;
    this.commit(renameItem(this.draft, uid, label), label?.trim() ? tr('ed.renamed', { label: label.trim() }) : tr('ed.renamedDefault'));
  }

  // -- placing (palette → scene, or moving an item) --
  startPlace(asset, { via = 'keyboard', moveUid = null } = {}) {
    if (!moveUid && this.draft.items.length >= MAX_ITEMS) return this.say(tr('ed.maxItems', { max: MAX_ITEMS }));
    const f = this.index.furniture.get(asset);
    const room = this.index.rooms.get(this.draft.room);
    const existing = moveUid && this.draft.items.find((i) => i.uid === moveUid);
    let cand;
    if (existing) cand = { ...existing };
    else if (f.placement === 'wall') cand = { asset, wall: f.wall?.side ?? 'right', offset: Math.floor(((f.wall?.side === 'left' ? room.rows : room.cols) - (f.wall?.length ?? 1)) / 2) };
    else {
      const c = { asset, x: Math.floor(room.cols / 2) - 1, y: Math.floor(room.rows / 2) - 1, orientation: 'sw' };
      cand = via === 'keyboard' ? (findFreeSpot(this.draft, this.index, c, c) ?? c) : c;
    }
    this.placing = { asset, via, moveUid, cand, check: null, visible: via === 'keyboard' || !!existing };
    this.updateGhost();
    if (via === 'keyboard') this.say(tr('ed.placeHelp', { item: furnitureLabel(f).toLocaleLowerCase(intlLocale()) }));
  }

  movePlaceTo(cand) {
    if (!this.placing) return;
    this.placing.cand = { ...this.placing.cand, ...cand };
    this.placing.visible = true;
    this.updateGhost();
  }

  updateGhost() {
    const p = this.placing;
    if (!p || !p.visible) { this.scene.hideGhost(); this.emit(); return; }
    const cand = p.moveUid ? { ...p.cand, uid: p.moveUid } : p.cand;
    p.check = checkPlacement(this.draft, this.index, cand);
    this.scene.showGhost(p.cand, p.check.ok, p.check.tiles);
    this.emit();
  }

  commitPlace() {
    const p = this.placing;
    if (!p) return;
    if (!p.visible || !p.check) return this.cancelPlace();
    if (!p.check.ok) { this.say(`${p.check.reason}.`); if (p.via === 'pointer') this.cancelPlace(); return; }
    this.placing = null;
    this.scene.hideGhost();
    const f = this.index.furniture.get(p.asset);
    const at = p.cand.wall != null ? null : { x: p.cand.x, y: p.cand.y };
    if (p.moveUid) {
      const pos = p.cand.wall != null ? { wall: p.cand.wall, offset: p.cand.offset } : { x: p.cand.x, y: p.cand.y };
      this.commit(moveItem(this.draft, p.moveUid, pos), tr(at ? 'ed.movedTo' : 'ed.moved', { item: itemName(this.draft, this.index, p.moveUid), ...at }));
    } else {
      const item = p.cand.wall != null ? { asset: p.asset, wall: p.cand.wall, offset: p.cand.offset } : { asset: p.asset, x: p.cand.x, y: p.cand.y, orientation: p.cand.orientation ?? 'sw' };
      const r = addItem(this.draft, item);
      this.commit(r.layout, tr(at ? 'ed.placedAt' : 'ed.placed', { item: furnitureLabel(f), ...at }));
      this.selected = r.uid;
      this.mark();
    }
    this.emit();
  }

  cancelPlace() {
    if (!this.placing) return;
    const was = this.placing;
    this.placing = null;
    this.scene.hideGhost();
    if (was.via === 'keyboard') this.say(tr('ed.placeCancelled'));
    this.emit();
  }

  /** Grid candidate under the pointer for the item being placed (pointer at the footprint centre). */
  candAt(clientX, clientY) {
    const p = this.placing;
    const f = this.index.furniture.get(p.asset);
    const g = this.scene.clientToGrid(clientX, clientY);
    if (f.placement === 'wall') {
      const a = g.wx / (this.index.proj.tileWidth / 2);   // position along the wall plane
      const side = f.wall?.side ?? (a >= 0 ? 'right' : 'left');
      const along = side === 'right' ? a : -a;
      return { wall: side, offset: Math.round(along - (f.wall?.length ?? 1) / 2) };
    }
    const fp = f.footprint;
    return { x: Math.round(g.x - fp.w / 2), y: Math.round(g.y - fp.d / 2) };
  }

  /** Pointer gesture from the palette: the ghost follows the pointer over the scene. */
  dragFromPalette(e, asset) {
    if (this.mode !== 'layout') return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    const vp = this.scene.viewport;
    const move = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      if (!dragging) { dragging = true; this.startPlace(asset, { via: 'pointer' }); }
      const r = vp.getBoundingClientRect();
      const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (inside) this.movePlaceTo(this.candAt(ev.clientX, ev.clientY));
      else { this.placing.visible = false; this.updateGhost(); }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!dragging) { this.startPlace(asset, { via: 'keyboard' }); return; }   // a click = keyboard-style placement
      this.commitPlace();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Scene pointerdown in Disposition: select an item, drag it to move. Empty floor: deselect and pan. */
  onScenePointer(e) {
    if (this.mode !== 'layout') return false;
    if (this.placing) {
      if (this.placing.via === 'keyboard') { this.movePlaceTo(this.candAt(e.clientX, e.clientY)); this.commitPlace(); return true; }
      return true;
    }
    const uid = this.scene.itemAtClient(e.clientX, e.clientY, collisionTiles.length ? (it, f) => footprintOf(it, f).concat(collisionTiles(it, f)) : footprintOf);
    if (!uid) { if (this.selected) { this.selected = null; this.mark(); this.emit(); } return false; }
    this.select(uid);
    const it = this.draft.items.find((i) => i.uid === uid);
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    const move = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      if (!dragging) { dragging = true; this.startPlace(it.asset, { via: 'pointer', moveUid: uid }); }
      this.movePlaceTo(this.candAt(ev.clientX, ev.clientY));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (dragging) this.commitPlace();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return true;
  }

  onKeyDown(e) {
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const mod = e.ctrlKey || e.metaKey;
    if (this.modal) {
      if (e.key === 'Escape') { e.preventDefault(); this.closeModal(); return; }
      if (e.key === 'Tab') trapTab(e, document.querySelector('.ao-scrim [role=dialog]'));   // R7-08
      return;
    }
    if (mod && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
    if (this.mode !== 'layout' || typing) return;
    const step = e.shiftKey ? 3 : 1;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    // Keys the editor handles stop here, so a focused palette tile doesn't also act on them.
    const take = () => { e.preventDefault(); e.stopPropagation(); };
    if (this.placing) {
      if (arrows[e.key]) {
        take();
        const [dx, dy] = arrows[e.key];
        const c = this.placing.cand;
        this.movePlaceTo(c.wall != null ? { offset: c.offset + (dx || dy) } : { x: c.x + dx, y: c.y + dy });
        const ch = this.placing.check;
        this.say(ch.ok ? (c.wall != null ? tr('ed.spotFree') : tr('ed.spotFreeAt', { x: this.placing.cand.x, y: this.placing.cand.y })) : `${ch.reason}.`);
      } else if (e.key === 'Enter') { take(); this.commitPlace(); }
      else if (e.key === 'Escape') { take(); this.cancelPlace(); }
      return;
    }
    if (!this.selected) return;
    if (arrows[e.key]) { take(); this.nudge(this.selected, ...arrows[e.key]); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { take(); this.remove(this.selected); }
    else if (mod && e.key.toLowerCase() === 'd') { take(); this.duplicate(this.selected); }
    else if (!mod && e.key.toLowerCase() === 'r') { take(); this.rotate(this.selected); }
    else if (e.key === 'Escape') { take(); this.select(null); }
  }

  // -- Personnages --
  agentRows() {
    // One implementation with the Boutique (agent-looks.js): rows keyed canonically, the existing rule's id kept.
    return sharedAgentRows(this.draft, this.o.getOccupants(), this.vm.agentsSeen ?? this.o.inventory ?? [], DEFAULT_RULE_LABEL);
  }

  /** The rule the agent editor writes to: its exact rule, created on first change from the resolved look. */
  ruleView(row) {
    const exact = this.draft.agents.find((a) => canonicalRuleId(a.agentId) === canonicalRuleId(row.id));
    if (exact) return { rule: exact, own: true };
    const [r] = resolveOccupants(this.draft, this.index, [{ id: row.id, role: row.role, sourceName: row.sourceName }]);
    return { rule: { agentId: row.id, match: { kind: row.role }, character: r.look.character, variant: r.look.variant, name: null, role: null, station: 'auto' }, own: false, resolved: r };
  }

  patchAgent(row, patch, announce) {
    const { rule, own } = this.ruleView(row);
    let next = this.draft;
    if (!own) next = updateAgent(next, row.id, { ...rule, accessories: undefined });
    const clean = { ...patch };
    next = updateAgent(next, row.id, clean);
    const a = next.agents.find((x) => x.agentId === row.id);
    for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
    this.commit(next, announce);
  }

  // -- Thème --
  patchTheme(patch, announce) { this.commit(updateTheme(this.draft, patch), announce); }
  /** O8 (3.0): how long a seen agent stays at its desk (layout.presence.seenMinutes). */
  patchPresence(minutes, announce) { this.commit({ ...this.draft, presence: { seenMinutes: minutes } }, announce); }

  // -- save, reset, conflicts, versions --
  async save({ overwrite = false } = {}) {
    if (this.saving || this.closed) return;
    const errors = this.errors;
    if (errors.length) return this.say(errors[0].message);
    // The save button disables itself while saving; remember it to give focus back after a 409 dialog.
    this.saveOpener = document.activeElement;
    this.saving = true;
    this.emit();
    // R7-05: the PUT carries a frozen snapshot; only that snapshot is marked saved. Edits made while the
    // request is pending stay unsaved (dirty), and a completion after close() is ignored.
    const submitted = structuredClone(this.draft);
    const submittedKey = JSON.stringify(submitted);
    try {
      // Overwrite = a deliberate resubmission with the revision the 409 reported (api.md §5.5).
      const expectedRevision = overwrite ? this.modal.current.revision : this.vm.layout.revision;
      const res = await this.o.store.put({ expectedRevision, data: submitted });
      if (this.closed) return;
      this.vm = res.vm ?? { ...this.vm, layout: { ...this.vm.layout, revision: res.revision, data: submitted } };
      this.history.markSaved(submitted);
      this.saving = false;
      this.modal = null;
      this.o.toast?.(tr('ed.saved'), 'success');
      const unchanged = JSON.stringify(this.draft) === submittedKey;
      const leave = this.closeAfterSave;
      this.closeAfterSave = false;
      if (unchanged) { this.close({ saved: true }); return; }
      if (leave) { this.modal = { kind: 'leave' }; }
      this.say(tr('ed.savedLater'));
    } catch (err) {
      if (this.closed) return;
      this.saving = false;
      this.closeAfterSave = false;
      const e = err?.error ?? err;
      if (e?.code === 'conflict' && e.current) { this.modal = { kind: 'conflict', current: e.current }; this.emit(); return; }
      this.o.toast?.(e?.message ?? tr('ed.saveFailed'), 'danger');
      this.emit();
    }
  }

  /** Recharger after a 409: adopt the server version the conflict carried (no extra request). */
  async reload() {
    this.vm = this.modal?.current?.vm ?? (await this.o.store.get());
    this.history = new History(this.vm.layout.data);
    this.modal = null;
    this.selected = null;
    this.apply();
    this.say(tr('ed.reloaded'));
  }

  confirmReset() {
    this.modal = null;
    this.commit(structuredClone(this.vm.default.data), tr('ed.resetDone'));
    this.selected = null;
  }

  async openVersions() {
    const fresh = await this.o.store.get();
    this.vm = { ...this.vm, revisions: fresh.revisions };
    this.modal = { kind: 'versions' };
    this.emit();
  }

  async loadRevision(rev) {
    const r = await this.o.store.getRevision(rev);
    this.modal = null;
    this.commit(r.data, tr('ed.revisionLoaded', { rev }));
  }

  requestClose() {
    if (this.closed) return;
    // R7-05: leaving while a save is pending waits for its outcome (then exits once, or asks if more changed).
    if (this.saving) { this.closeAfterSave = true; this.say(tr('ed.closeAfterSave')); return; }
    if (this.dirty) { this.modal = { kind: 'leave' }; this.emit(); return; }
    this.close({ saved: false });
  }

  closeModal() { this.modal = null; this.emit(); }

  close({ saved }) {
    if (this.closed) return;   // exit runs once (R7-05)
    this.cancelPlace();
    document.removeEventListener('keydown', this.onKey, true);
    this.mq.removeEventListener('change', this.onMq);
    this.offCam?.();
    this.scene.setPointerHandler(null);
    this.scene.setEditing(false);
    this.closed = true;
    this.o.onExit?.({ saved, layout: saved ? this.draft : this.vm.layout.data, revision: this.vm.layout.revision, vm: this.vm });
  }
}

// ---------- hooks ----------
function useCtl(ctl) {
  const [, force] = useState(0);
  const seen = ctl.version;
  useEffect(() => {
    const off = ctl.subscribe(() => force((n) => n + 1));
    // Effects run after paint: catch up on changes emitted between this render and the subscription.
    if (ctl.version !== seen) force((n) => n + 1);
    return off;
  }, [ctl]);
  return ctl;
}

// ---------- top bar ----------
function EditorBar({ ctl }) {
  useCtl(ctl);
  const errors = ctl.errors;
  const saveBlocked = errors.length ? errors[0].message : !ctl.dirty ? tr('ed.nothingToSave') : null;
  const modes = ['layout', 'characters', 'theme'].map((id) => [id, tr(`ed.mode.${id}`)]);
  return html`
    <div class="ao-editbar" role="toolbar" aria-label=${tr('ed.title')}>
      <h2 class="ao-editbar__title">${tr('ed.title')}</h2>
      <div class="bu-segmented" role="group" aria-label=${tr('ed.mode')}>
        ${modes.map(([id, label]) => html`<button type="button" class="bu-segmented__opt" aria-pressed=${String(ctl.mode === id)}
          disabled=${id === 'layout' && ctl.narrow} title=${id === 'layout' && ctl.narrow ? tr('ed.layoutNarrow') : null}
          onClick=${() => ctl.setMode(id)}>${label}</button>`)}
      </div>
      <div class="ao-editbar__history">
        <button type="button" class="bu-btn bu-btn--icon bu-btn--ghost bu-btn--sm" aria-label=${tr('ed.undo')} title=${tr('ed.undo')} disabled=${!ctl.history.canUndo} onClick=${() => ctl.undo()}><${Icon} name="undo" /></button>
        <button type="button" class="bu-btn bu-btn--icon bu-btn--ghost bu-btn--sm" aria-label=${tr('ed.redo')} title=${tr('ed.redo')} disabled=${!ctl.history.canRedo} onClick=${() => ctl.redo()}><${Icon} name="redo" /></button>
      </div>
      ${ctl.dirty ? html`<span class="bu-chip bu-chip--warning" title=${tr('ed.dirty')}>${tr('ed.dirtyShort')}</span>` : null}
      <span class="ao-editbar__spacer"></span>
      <${MoreMenu} items=${[
        { id: 'versions', icon: 'history', label: tr('ed.versions'), run: () => ctl.openVersions() },
        { id: 'reset', icon: 'rotate', label: tr('ed.reset'), run: () => { ctl.modal = { kind: 'reset' }; ctl.emit(); } },
        // office-dev-21: the Boutique (catalog, mobile-first placement); unsaved edits are saved or cancelled first
        ...(ctl.o.onOpenShop ? [{ id: 'boutique', icon: 'boutique', label: tr('ed.openShop'), run: () => { if (ctl.dirty) { ctl.say(tr('ed.openShopDirty')); ctl.emit(); return; } ctl.close({ saved: false }); ctl.o.onOpenShop(); } }] : []),
      ]} />
      <button type="button" class="bu-btn bu-btn--ghost bu-btn--sm" onClick=${() => ctl.requestClose()}>${tr('ed.cancel')}</button>
      <span class="ao-editbar__save" title=${saveBlocked ?? tr('ed.saveTitle')}>
        <button type="button" class="bu-btn bu-btn--primary bu-btn--sm" disabled=${!!saveBlocked || ctl.saving} aria-describedby=${saveBlocked ? 'ao-save-why' : null} onClick=${() => ctl.save()}>${ctl.saving ? tr('ed.saving') : tr('ed.save')}</button>
      </span>
      ${saveBlocked && ctl.dirty ? html`<span id="ao-save-why" class="ao-sr">${saveBlocked}</span>` : null}
      <div class="ao-sr" aria-live="polite">${ctl.announcement}</div>
    </div>
    <${Modal} ctl=${ctl} />`;
}

/** O7: secondary actions (Versions, Réinitialiser…) in a menu button, so the bar holds one row at 1280 in the shell.
 *  Menu pattern: Enter/Space/Down opens on the first item, Up/Down/Home/End move, Escape or Tab closes and returns focus. */
function MoreMenu({ items }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const menu = useRef(null);
  const focusItem = (i) => { const els = menu.current?.querySelectorAll('[role=menuitem]'); if (els?.length) els[(i + els.length) % els.length].focus(); };
  useEffect(() => {
    if (!open) return undefined;
    requestAnimationFrame(() => focusItem(0));
    const away = (e) => { if (!menu.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  const close = (refocus = true) => { setOpen(false); if (refocus) requestAnimationFrame(() => btn.current?.focus()); };
  function onMenuKey(e) {
    const els = [...menu.current.querySelectorAll('[role=menuitem]')];
    const i = els.indexOf(document.activeElement);
    const k = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: els.length - 1 }[e.key];
    if (k !== undefined) { e.preventDefault(); e.stopPropagation(); focusItem(k); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close(false);
  }
  return html`<span class="ao-more">
    <button type="button" class="bu-btn bu-btn--ghost bu-btn--sm" ref=${btn} aria-haspopup="menu" aria-expanded=${open ? 'true' : 'false'} aria-controls="ao-more-menu"
      onClick=${() => setOpen(!open)} onKeyDown=${(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}>${tr('ed.more')}<${Icon} name="chevron" /></button>
    ${open ? html`<ul class="ao-more__menu" id="ao-more-menu" role="menu" aria-label=${tr('ed.more')} ref=${menu} onKeyDown=${onMenuKey}>
      ${items.map((it) => html`<li key=${it.id} role="none"><button type="button" role="menuitem" class="ao-more__item" tabindex="-1"
        onClick=${() => { setOpen(false); btn.current?.focus(); it.run(); }}>${it.icon ? html`<${Icon} name=${it.icon} />` : null}${it.label}</button></li>`)}
    </ul>` : null}
  </span>`;
}

// ---------- side panel ----------
function EditorPanel({ ctl }) {
  useCtl(ctl);
  return html`<div class="ao-editpanel">
    ${ctl.mode === 'layout' ? html`<${LayoutPanel} ctl=${ctl} />` : ctl.mode === 'characters' ? html`<${CharactersPanel} ctl=${ctl} />` : html`<${ThemePanel} ctl=${ctl} />`}
  </div>`;
}

function LayoutPanel({ ctl }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const idx = ctl.index;
  const all = [...idx.furniture.values()];
  const cats = ['poste', 'assise', 'rangement', 'plante', 'equipement', 'mur', 'sol', 'deco'].filter((c) => all.some((f) => f.category === c));
  const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const list = all.filter((f) => (cat === 'all' || f.category === cat) && (!q || norm(furnitureLabel(f)).includes(norm(q)) || norm(f.label).includes(norm(q))));
  const draft = ctl.draft;
  const errors = ctl.errors;
  const desks = homeStations(draft, idx).length;
  const placing = ctl.placing;
  return html`
    <section aria-labelledby="ao-pal-title">
      <h3 class="ao-panel__title" id="ao-pal-title">${tr('ed.furniture')}</h3>
      <div class="bu-input-group ao-search"><${Icon} name="search" />
        <input class="bu-input bu-input--sm" type="search" placeholder=${tr('ed.search')} aria-label=${tr('ed.search')} value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
      <nav class="bu-filter ao-cats" aria-label=${tr('ed.categories')}>
        <ul class="bu-filter__list">
          <li><button type="button" class="bu-filter__item" aria-current=${String(cat === 'all')} onClick=${() => setCat('all')}>${tr('ed.all')} <span class="bu-count">${all.length}</span></button></li>
          ${cats.map((c) => html`<li><button type="button" class="bu-filter__item" aria-current=${String(cat === c)} onClick=${() => setCat(c)}>${CATEGORY_LABEL(c)} <span class="bu-count">${all.filter((f) => f.category === c).length}</span></button></li>`)}
        </ul>
      </nav>
      <ul class="ao-palette" aria-label=${tr('ed.palette')}>
        ${list.map((f) => html`<li>
          <button type="button" class="bu-card bu-card--interactive ao-tile" aria-pressed=${String(placing?.asset === f.id && !placing.moveUid)}
            aria-label=${tr('ed.tileAria', { item: furnitureLabel(f), size: f.placement === 'wall' ? tr('ed.wallSize', { n: f.wall?.length ?? 1 }) : `${f.footprint.w} × ${f.footprint.d}` })}
            onPointerDown=${(e) => ctl.dragFromPalette(e, f.id)}
            onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctl.startPlace(f.id, { via: 'keyboard' }); } }}>
            <span class="ao-tile__img"><img src=${resolveUrl(f.image, ctl.o.assetBase)} alt="" draggable="false" /></span>
            <span class="ao-tile__label">${furnitureLabel(f)}</span>
            <span class="ao-tile__fp">${f.placement === 'wall' ? tr('ed.wallShort', { n: f.wall?.length ?? 1 }) : `${f.footprint.w} × ${f.footprint.d}`}</span>
          </button></li>`)}
        ${list.length ? null : html`<li class="ao-empty">${tr('ed.noMatch')}</li>`}
      </ul>
      ${placing && placing.check && !placing.check.ok ? html`<p class="ao-reason" role="status"><${Icon} name="alert" />${placing.check.reason}</p>` : null}
      ${placing && placing.via === 'keyboard' ? html`<p class="bu-field__hint">${tr('ed.keysHelp')}</p>` : null}
    </section>
    <section aria-labelledby="ao-placed-title">
      <h3 class="ao-panel__title" id="ao-placed-title">${tr('ed.placedTitle')} <span class="bu-count">${draft.items.length} / ${MAX_ITEMS}</span></h3>
      <p class="bu-field__hint">${tr('ed.capacity', { n: desks })} ${tr('ed.selectionHelp')}</p>
      <ul class="ao-placed">
        ${draft.items.map((it) => html`<li><button type="button" class="bu-filter__item" data-placed=${it.uid} aria-current=${String(ctl.selected === it.uid)}
          onFocus=${() => { if (ctl.selected !== it.uid) ctl.select(it.uid); }} onClick=${() => ctl.select(it.uid)}>
          ${itemName(draft, idx, it.uid)}<span class="ao-placed__pos">${it.wall != null ? tr(it.wall === 'left' ? 'ed.wallLeft' : 'ed.wallRight', { n: it.offset }) : `${it.x}, ${it.y}`}</span></button></li>`)}
      </ul>
    </section>
    <${Problems} errors=${errors} />`;
}

function Problems({ errors }) {
  if (!errors.length) return html`<p class="ao-ok" role="status">${tr('ed.allGood')}</p>`;
  return html`<section class="ao-problems" role="status" aria-label=${tr('ed.problems')}>
    <h3 class="ao-panel__title"><${Icon} name="alert" />${tr('ed.problemsTitle')}</h3>
    <ul>${errors.slice(0, 6).map((e) => html`<li>${e.message}</li>`)}</ul>
  </section>`;
}

function CharactersPanel({ ctl }) {
  const idx = ctl.index;
  const rows = ctl.agentRows();
  const row = rows.find((r) => r.id === ctl.agentSel) ?? rows[0];
  const { rule } = ctl.ruleView(row);
  const isDefault = !!row.isDefault;
  const desks = homeStations(ctl.draft, idx);
  // Generic desks are numbered in layout order so the options can be told apart (« Poste de travail 3 »).
  const stationOption = (u) => {
    const it = ctl.draft.items.find((i) => i.uid === u);
    const name = itemName(ctl.draft, idx, u);
    if (it?.label || ctl.draft.agents.some((a) => a.station === u && a.name)) return name;
    const same = desks.filter((d) => ctl.draft.items.find((i) => i.uid === d)?.asset === it?.asset);
    return same.length > 1 ? tr('ed.stationNumbered', { item: name, n: same.indexOf(u) + 1 }) : name;
  };
  const nameOfRow = (r) => (r.isDefault ? r.sourceName : displayName({ id: r.id, role: r.role, name: ctl.draft.agents.find((a) => a.agentId === r.id)?.name, sourceName: r.sourceName }, { primaryName: ctl.o.primaryName ?? null }));
  const shownName = nameOfRow(row);
  // O6: looks are edited with the setup step's component (one implementation for setup and the editor). Its value
  // is each row's effective look in the draft; a change is written to that row's rule, so undo, save, 409 and the
  // shared validator work as for any other edit. Explicit gear equal to the colour's defaults is stored as « default ».
  // Agents without an own rule are resolved together, in roster order, so a default rule's colour rotation holds.
  const people = rows.filter((r) => !r.isDefault);
  const resolvedLooks = new Map(resolveOccupants(ctl.draft, idx, people.map((r) => ({ id: r.id, role: r.role, sourceName: r.sourceName }))).map((o, i) => [people[i].id, o.look]));
  const lookOf = (r) => {
    const { rule: ru, own } = ctl.ruleView(r);
    if (r.isDefault || own) {
      const c = idx.characters.get(ru.character);
      return { character: ru.character, variant: ru.variant ?? c?.variants?.[0]?.id ?? null, accessories: effectiveAccessories(idx, ru) };
    }
    return resolvedLooks.get(r.id);
  };
  const value = Object.fromEntries(rows.map((r) => [r.id, lookOf(r)]));
  const same = (a, b) => a.character === b.character && (a.variant ?? null) === (b.variant ?? null) && a.accessories.length === b.accessories.length && a.accessories.every((x) => b.accessories.includes(x));
  function onLooks(next) {
    for (const r of rows) {
      const want = next[r.id];
      if (!want || same(want, value[r.id])) continue;
      const defaults = defaultAccessoriesFor(idx, want.character, want.variant);
      const accessories = want.accessories.length === defaults.length && want.accessories.every((x) => defaults.includes(x)) ? undefined : want.accessories;
      ctl.patchAgent(r, { character: want.character, variant: want.variant, accessories }, null);
    }
  }
  const agents = rows.map((r) => ({ id: r.id, name: nameOfRow(r), primary: canonicalRole(r.role) === 'primary' && !r.isDefault, group: r.isDefault ? 'defaults' : 'agents',
    note: r.isDefault ? tr('ed.defaultRule') : r.live === false ? tr('ed.seenRecently', { role: ROLE_LABEL(r.role) }) : ROLE_LABEL(r.role) }));
  return html`
    <section aria-labelledby="ao-agents-title">
      <h3 class="ao-panel__title" id="ao-agents-title">${tr('ed.agents')}</h3>
      <${SetupCharacters} embedded agents=${agents} value=${value} onChange=${onLooks} manifest=${ctl.vm.manifest} assetBase=${ctl.o.assetBase}
        selected=${row.id} onSelect=${(id) => { ctl.agentSel = id; ctl.emit(); }} />
      ${isDefault ? html`<p class="bu-field__hint">${tr('ed.defaultRuleHelp')}</p>` : null}
    </section>
    <section class="ao-agentcard" aria-labelledby="ao-agentcard-title">
      <h3 class="ao-panel__title" id="ao-agentcard-title">${tr('ed.detailsOf', { name: shownName })}</h3>
      <label class="bu-field"><span class="bu-field__label">${tr('ed.name')}</span>
        <input class="bu-input" maxlength=${NAME_MAX} disabled=${isDefault} placeholder=${isDefault ? tr('ed.namePlaceholderDefault') : displayName({ id: row.id, role: row.role, sourceName: row.sourceName }, { primaryName: ctl.o.primaryName ?? null })} value=${rule.name ?? ''}
          onChange=${(e) => ctl.patchAgent(row, { name: e.target.value.trim() || null }, tr('ed.nameSet'))} />
        <span class="bu-field__hint">${tr('ed.nameHelp')}</span></label>
      <label class="bu-field"><span class="bu-field__label">${tr('ed.role')}</span>
        <input class="bu-input" maxlength=${ROLE_MAX} placeholder=${ROLE_LABEL(row.role)} value=${rule.role ?? ''}
          onChange=${(e) => ctl.patchAgent(row, { role: e.target.value.trim() || null }, tr('ed.roleSet'))} /></label>
      <label class="bu-field"><span class="bu-field__label">${tr('ed.station')}</span>
        <select class="bu-select" disabled=${isDefault} value=${rule.station ?? 'auto'}
          onFocus=${() => { ctl.highlight = rule.station && rule.station !== 'auto' ? rule.station : null; ctl.mark(); }}
          onBlur=${() => { ctl.highlight = null; ctl.mark(); }}
          onChange=${(e) => { ctl.highlight = e.target.value === 'auto' ? null : e.target.value; ctl.patchAgent(row, { station: e.target.value }, tr('ed.stationSet')); }}>
          <option value="auto">${tr('ed.stationAuto')}</option>
          ${desks.map((u) => { const taken = ctl.draft.agents.find((a) => a.station === u && a.agentId !== row.id); const label = stationOption(u); return html`<option value=${u} disabled=${!!taken}>${taken ? tr('ed.stationTaken', { station: label }) : label}</option>`; })}
        </select>
        <span class="bu-field__hint">${isDefault ? tr('ed.stationHelpDefault') : tr('ed.stationHelp')}</span></label>
    </section>
    <${Problems} errors=${ctl.errors} />`;
}

function ThemePanel({ ctl }) {
  const t = ctl.draft.theme;
  const idx = ctl.index;
  const room = idx.rooms.get(ctl.draft.room);
  const mode = t.mode === 'fixed' ? t.fixed : 'auto';
  const seasons = [...idx.themes.values()].filter((x) => x.kind === 'season');
  const tz = ctl.o.timeZone || undefined;
  const now = resolveTheme({ ...t, mode: 'auto' }, new Date(), tz);
  const zoneName = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const set = (m) => ctl.patchTheme(m === 'auto' ? { mode: 'auto', nightFrom: t.nightFrom ?? '19:00', nightTo: t.nightTo ?? '07:00' } : { mode: 'fixed', fixed: m }, tr('ed.themeSet', { theme: m === 'auto' ? tr('office.theme.auto') : labelOf(themeFor(idx, m), 'theme') }));
  return html`
    <section aria-labelledby="ao-theme-title">
      <h3 class="ao-panel__title" id="ao-theme-title">${tr('ed.themeTitle')}</h3>
      <${SurpriseSetting} />
      <div class="bu-segmented" role="group" aria-label=${tr('ed.themeGroup')}>
        ${['auto', 'day', 'night'].map((id) => [id, tr(`office.theme.${id}`)]).map(([id, label]) => html`<button type="button" class="bu-segmented__opt" aria-pressed=${String(mode === id)} onClick=${() => set(id)}>${label}</button>`)}
      </div>
      ${t.mode === 'auto' ? html`<div class="ao-night">
        <label class="bu-field"><span class="bu-field__label">${tr('ed.nightFrom')}</span><input class="bu-input" type="time" value=${t.nightFrom ?? '19:00'} onChange=${(e) => ctl.patchTheme({ nightFrom: e.target.value }, tr('ed.nightFromSet', { time: e.target.value }))} /></label>
        <label class="bu-field"><span class="bu-field__label">${tr('ed.nightTo')}</span><input class="bu-input" type="time" value=${t.nightTo ?? '07:00'} onChange=${(e) => ctl.patchTheme({ nightTo: e.target.value }, tr('ed.nightToSet', { time: e.target.value }))} /></label>
        <p class="bu-field__hint">${tr(now === 'night' ? 'ed.zoneHint.night' : 'ed.zoneHint.day', { zone: zoneName })}</p>
      </div>` : null}
      <div class="ao-themecards">
        ${['day', 'night'].map((id) => { const th = themeFor(idx, id); return html`<button type="button" class="bu-card bu-card--interactive ao-themecard" aria-pressed=${String(mode === id)} onClick=${() => set(id)}>
          <img src=${resolveUrl(roomImage(room, th), ctl.o.assetBase)} alt="" /><span>${labelOf(th, 'theme')}</span></button>`; })}
      </div>
      <label class="bu-field"><span class="bu-field__label">${tr('ed.season')}</span>
        <select class="bu-select" value=${t.season ?? ''} disabled=${!seasons.length} onChange=${(e) => ctl.patchTheme({ season: e.target.value || null }, tr('ed.seasonSet'))}>
          <option value="">${tr('ed.seasonNone')}</option>
          ${seasons.map((x) => html`<option value=${x.id}>${labelOf(x, 'theme')}</option>`)}
        </select>
        <span class="bu-field__hint">${seasons.length ? tr('ed.seasonHelp') : tr('ed.seasonNoneAvailable')}</span></label>
      <p class="bu-field__hint">${tr('ed.themeIndependent')}</p>
      ${config.apiVersion === 3 ? html`<label class="bu-field"><span class="bu-field__label">${tr('ed.presence')}</span>
        <select class="bu-select" value=${String(presenceMinutes(ctl.draft))} onChange=${(e) => { const m = Number(e.target.value); ctl.patchPresence(m, m ? tr('ed.presenceSet', { duration: presenceText(m) }) : tr('ed.presenceOff')); }}>
          ${PRESENCE_CHOICES.map((m) => html`<option value=${String(m)}>${m ? presenceText(m) : tr('ed.presenceNone')}</option>`)}
        </select>
        <span class="bu-field__hint">${tr('ed.presenceHelp')}</span></label>` : null}
    </section>
    <${Problems} errors=${ctl.errors} />`;
}

// ---------- item toolbar (floats over the selected item) ----------
function ItemToolbar({ ctl }) {
  useCtl(ctl);
  const uid = ctl.mode === 'layout' && !ctl.placing ? ctl.selected : null;
  const it = uid && ctl.draft.items.find((i) => i.uid === uid);
  if (!it) return null;
  const f = ctl.index.furniture.get(it.asset);
  const at = ctl.scene.itemTopViewport(uid);
  if (!at) return null;
  const canRotate = (f.orientations ?? ['sw']).length > 1;
  return html`<div class="ao-itembar" role="toolbar" aria-label=${tr('ed.itemActions', { item: itemName(ctl.draft, ctl.index, uid) })} style=${`left:${Math.round(at.x)}px;top:${Math.round(at.y)}px`}>
    <span class="ao-sr">${itemName(ctl.draft, ctl.index, uid)}</span>
    <span title=${canRotate ? tr('ed.rotateKey') : tr('ed.oneOrientation')}><button type="button" class="bu-btn bu-btn--icon bu-btn--ghost bu-btn--sm" aria-label=${tr('ed.rotate')} disabled=${!canRotate} onClick=${() => ctl.rotate(uid)}><${Icon} name="rotate" /></button></span>
    <button type="button" class="bu-btn bu-btn--icon bu-btn--ghost bu-btn--sm" aria-label=${tr('ed.duplicate')} title=${tr('ed.duplicate')} onClick=${() => ctl.duplicate(uid)}><${Icon} name="copy" /></button>
    ${f.station ? html`<button type="button" class="bu-btn bu-btn--icon bu-btn--ghost bu-btn--sm" aria-label=${tr('ed.rename')} title=${tr('ed.rename')} onClick=${() => { ctl.modal = { kind: 'rename', uid }; ctl.emit(); }}><${Icon} name="rename" /></button>` : null}
    <button type="button" class="bu-btn bu-btn--icon bu-btn--ghost bu-btn--sm ao-itembar__danger" aria-label=${tr('ed.delete')} title=${tr('ed.delete')} onClick=${() => ctl.remove(uid)}><${Icon} name="trash" /></button>
  </div>`;
}

// ---------- modals ----------
/** Keep Tab / Maj+Tab inside the dialog (R7-08). */
function trapTab(e, dialog) {
  if (!dialog) return;
  const items = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled && n.offsetParent !== null);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  const inside = dialog.contains(document.activeElement);
  if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
}

function Modal({ ctl }) {
  const m = ctl.modal;
  const first = useRef(null);
  // R7-08: the background is inert while a dialog is open; focus returns to the opener on close.
  useEffect(() => {
    if (!m) return undefined;
    const opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : ctl.saveOpener;
    const behind = [ctl.scene.stage, ctl.o.asideHost, ctl.o.barHost.querySelector('.ao-editbar')].filter(Boolean);
    for (const n of behind) n.inert = true;
    requestAnimationFrame(() => first.current?.focus());
    return () => {
      for (const n of behind) n.inert = false;
      if (opener && opener.isConnected && !ctl.closed) opener.focus();
    };
  }, [m?.kind]);
  if (!m) return null;
  const frame = (title, desc, body, footer) => html`<div class="bu-scrim ao-scrim" onClick=${(e) => { if (e.target === e.currentTarget) ctl.closeModal(); }}>
    <div class="bu-modal bu-modal--sm" role="dialog" aria-modal="true" aria-labelledby="ao-modal-title">
      <div class="bu-modal__header"><div style="flex:1"><h2 class="bu-modal__title" id="ao-modal-title">${title}</h2>${desc ? html`<p class="bu-modal__desc">${desc}</p>` : null}</div>
        <button type="button" class="bu-btn bu-btn--icon bu-btn--ghost" aria-label=${tr('ed.close')} onClick=${() => ctl.closeModal()}><${Icon} name="x" /></button></div>
      ${body ? html`<div class="bu-modal__body">${body}</div>` : null}
      <div class="bu-modal__footer">${footer}</div></div></div>`;
  if (m.kind === 'leave') return frame(tr('ed.leave.title'), tr('ed.leave.desc'), null, html`
    <button type="button" class="bu-btn bu-btn--ghost" ref=${first} onClick=${() => ctl.closeModal()}>${tr('ed.stay')}</button>
    <button type="button" class="bu-btn bu-btn--danger" onClick=${() => { ctl.modal = null; ctl.close({ saved: false }); }}>${tr('ed.quit')}</button>`);
  if (m.kind === 'reset') return frame(tr('ed.reset.title'), tr('ed.reset.desc'), null, html`
    <button type="button" class="bu-btn bu-btn--ghost" ref=${first} onClick=${() => ctl.closeModal()}>${tr('ed.cancel')}</button>
    <button type="button" class="bu-btn bu-btn--primary" onClick=${() => ctl.confirmReset()}>${tr('ed.reset.confirm')}</button>`);
  if (m.kind === 'conflict') { const by = m.current?.vm?.revisions?.[0]?.updatedBy?.name; return frame(tr('ed.conflict.title'), tr(by ? 'ed.conflict.descBy' : 'ed.conflict.desc', { rev: m.current?.revision ?? '?', by }), html`<p>${tr('ed.conflict.body')}</p>`, html`
    <button type="button" class="bu-btn bu-btn--ghost" ref=${first} onClick=${() => ctl.reload()}>${tr('ed.reload')}</button>
    <button type="button" class="bu-btn bu-btn--danger" disabled=${ctl.saving} onClick=${() => ctl.save({ overwrite: true })}>${tr('ed.overwrite')}</button>`); }
  if (m.kind === 'rename') {
    const it = ctl.draft.items.find((i) => i.uid === m.uid);
    let value = it?.label ?? '';
    return frame(tr('ed.rename.title'), tr('ed.rename.desc'), html`
      <label class="bu-field"><span class="bu-field__label">${tr('ed.rename.name')}</span><input class="bu-input" ref=${first} maxlength="48" value=${value} placeholder=${itemName({ ...ctl.draft, items: ctl.draft.items.map((i) => (i.uid === m.uid ? { ...i, label: undefined } : i)) }, ctl.index, m.uid)}
        onInput=${(e) => { value = e.target.value; }} onKeyDown=${(e) => { if (e.key === 'Enter') ctl.rename(m.uid, e.target.value); }} /></label>`, html`
      <button type="button" class="bu-btn bu-btn--ghost" onClick=${() => ctl.closeModal()}>${tr('ed.cancel')}</button>
      <button type="button" class="bu-btn bu-btn--primary" onClick=${() => ctl.rename(m.uid, value)}>${tr('ed.rename')}</button>`);
  }
  if (m.kind === 'versions') {
    const fmt = new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: ctl.o.timeZone || undefined });
    return frame(tr('ed.versions.title'), tr('ed.versions.desc'), html`
      <ul class="ao-versions">${ctl.vm.revisions.map((r, i) => html`<li>
        <span><strong>${tr('ed.versions.item', { rev: r.revision })}</strong>${i === 0 ? ` · ${tr('ed.versions.current')}` : ''}<br /><small>${fmt.format(r.updatedAt)} · ${r.updatedBy?.name ?? ''}</small></span>
        <button type="button" class="bu-btn bu-btn--sm" ref=${i === 0 ? first : null} onClick=${() => ctl.loadRevision(r.revision)}>${tr('ed.load')}</button></li>`)}</ul>`, html`
      <button type="button" class="bu-btn bu-btn--ghost" onClick=${() => ctl.closeModal()}>${tr('ed.close')}</button>`);
  }
  return null;
}

/**
 * Open the editor over a scene.
 * @param {object} opts
 * @param {import('./scene.js').OfficeScene} opts.scene
 * @param {HTMLElement} opts.barHost      top bar (above the stage)
 * @param {HTMLElement} opts.asideHost    side panel
 * @param {object} opts.store             { get, getRevision, put } (layout API or mock-store.js)
 * @param {() => {id, role, name, sourceName?, state, stateSince}[]} opts.getOccupants  live roster (unresolved sources)
 * @param {{id, role, name, lastSeenAt}[]} [opts.inventory]  agents seen in the last 30 days (LayoutVM.agentsSeen)
 * @param {string} opts.assetBase
 * @param {(msg: string, level: string) => void} [opts.toast]
 * @param {(result: {saved: boolean, layout: object, revision: number}) => void} [opts.onExit]
 */
export async function openEditor(opts) {
  const ctl = new EditorController(opts);
  await ctl.init();
  const overlay = document.createElement('div');
  overlay.className = 'ao-editoverlay';
  opts.scene.stage.append(overlay);
  render(html`<${EditorBar} ctl=${ctl} />`, opts.barHost);
  render(html`<${EditorPanel} ctl=${ctl} />`, opts.asideHost);
  render(html`<${ItemToolbar} ctl=${ctl} />`, overlay);
  const origExit = opts.onExit;
  ctl.o.onExit = (r) => {
    render(null, opts.barHost);
    render(null, opts.asideHost);
    render(null, overlay);
    overlay.remove();
    origExit?.(r);
  };
  return ctl;
}
