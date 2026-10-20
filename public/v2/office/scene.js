import { loadModule } from '../build-update.js';
// Layered DOM scene (design/office/README.md), driven by OfficeVM occupants and SSE cues.
import { project, unproject, imageBox, wallPoint, footprintFor, itemDepth, characterDepth, sortScene } from './geometry.js';
import { buildGrid, findPath, nearestWalkable, isWalkable } from './pathfind.js';
import {
  atComputer, viewFor, CUES, WALK_TILES_PER_S, CROSSFADE_MS, LOUNGE_AFTER_MS,
  SEATED_VIEW, SEATED_CUES, SOFA_VIEW, SWIVEL_MS, SELECT_WAVE_MS, IDLE_SWIVEL_EVERY_MS, IDLE_SWIVEL_HOLD_MS,
} from './states.js';
import { resolveTheme } from './theme.js';
import { s as tr, labelOf, intlLocale } from './strings.js';
import {
  indexManifest, resolveUrl, furnitureImage, partImage, poseImage, accessoryLayers, headTopY, renderScale, themeFor, roomImage,
  seatModeFor, isBackPose, deskPoseImage,
} from './assets.js';
import { markerHtml } from './markers.js';
import { displayName } from './names.js';
import { buildQuery } from '../config.js';
import { SURPRISES, EGGS, EGG_KINDS, surprisesEnabled, acquireSurprise, releaseSurprise, eggEligible, pickEgg, surpriseHistory, rememberSurprise } from './surprises.js';
import { LIFE, ACTIVITIES, REACTIONS, canIdle, pickActivity, reactionFor, SIGNALS, acquireWander, releaseWander, wanderCount, watchLife } from './life.js';

const ZOOM_MAX = 1.5;
const ANNOUNCE_BATCH_MS = 1500;
const ANNOUNCE_MIN_GAP_MS = 4000;
const ZOOM_MIN = 0.5;

const el = (tag, cls, attrs) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
};
/** A manifest asset path that is safe inside CSS url("…") (manifest.schema.json $defs.path). */
const SAFE_ASSET = /^assets\/(Office|Characters|Logos)\/[A-Za-z0-9_./@-]+\.(png|webp|svg)$/;
const setSrc = (img, url) => {
  if (img.dataset.src !== url) { img.dataset.src = url; img.src = url; }
};
const place = (node, box) => {
  node.style.left = `${box.left}px`;
  node.style.top = `${box.top}px`;
  node.style.width = `${box.width}px`;
  node.style.height = `${box.height}px`;
};


export class OfficeScene {
  /**
   * @param {HTMLElement} stage sized container
   * @param {object} opts
   * @param {object} opts.manifest scene manifest
   * @param {object} opts.layout room layout
   * @param {string} opts.assetBase manifest asset URL prefix
   * @param {string|(() => string)} [opts.timeZone] instance IANA zone
   * @param {Record<string,string>} [opts.labels] localized state labels
   * @param {'auto'|'day'|'night'} [opts.theme]
   * @param {() => number} [opts.now]
   * @param {(id: string) => void} [opts.onSelect]
   */
  constructor(stage, opts) {
    this.stage = stage;
    this.opts = opts;
    this._intents = opts.intents;
    this.chars = new Map();
    this._events = new AbortController();
    try {
      this.assetBase = opts.assetBase;
      this.lifeConfig = { ...LIFE, ...opts.life };
      this.surpriseConfig = { ...SURPRISES, ...opts.surprises };
      this._onSurpriseSetting = e => { if (!e.detail && !this.opts.surprisesEnabled) for (const c of this.chars.values()) this._cancelEgg(c); };
      this._listen(window, 'office-surprises-setting', this._onSurpriseSetting);
      this.now = opts.now ?? (() => Date.now());
      this.onSelect = opts.onSelect ?? null;
      this.index = indexManifest(opts.manifest);
      this.proj = this.index.proj;
      this.selected = null;
      this.cam = { zoom: 1, x: 0, y: 0, user: false };
      this.themeMode = opts.theme ?? 'auto';
      this.forcedReduced = null;
      // Legacy overlays remain until the v2 accessory manifest is complete.
      this.legacyAccessories = opts.legacyAccessories ?? !opts.manifest.accessoriesV2?.complete;
      this._mq = matchMedia('(prefers-reduced-motion: reduce)');
      this._raf = 0;
      this._last = 0;
      this._sortDirty = true;
      this._build();
      this.setLayout(opts.layout);
      this._nextLifeCheck = this.now() + this.lifeConfig.intervalMs;
      this._lifeTimer = watchLife(() => this._tickLife());
      this._themeTimer = setInterval(() => { this._applyTheme(); this._checkLounge(); }, 30_000);
      this._ro = new ResizeObserver(() => { if (!this.cam.user) this.fit(); else this._applyCamera(); });
      this._ro.observe(this.viewport);
      this._onMq = () => this._syncReduced();
      this._listen(this._mq, 'change', this._onMq);
      // Hidden tab: no frame loops, idle swivels or CSS animations (O4); resume on return.
      this._onVis = () => this._syncHidden();
      this._listen(document, 'visibilitychange', this._onVis);
      this._onPageHide = () => { this._pageHidden = true; this._syncHidden(); };
      this._onPageShow = () => { this._pageHidden = false; this._syncHidden(); };
      this._onFreeze = () => { this._lifecycleFrozen = true; this._syncHidden(); };
      this._onResume = () => { this._lifecycleFrozen = false; this._syncHidden(); };
      this._listen(window, 'pagehide', this._onPageHide);
      this._listen(window, 'pageshow', this._onPageShow);
      this._listen(document, 'freeze', this._onFreeze);
      this._listen(document, 'resume', this._onResume);
      this._onFsChange = () => this._syncFullscreen();
      this._listen(document, 'fullscreenchange', this._onFsChange);
      this._listen(document, 'webkitfullscreenchange', this._onFsChange);
      // Offscreen stages pause like hidden tabs.
      this._offscreen = false;
      this._io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => {
        const off = !es[es.length - 1].isIntersecting;
        if (off !== this._offscreen) { this._offscreen = off; this._syncHidden(); }
      }, { rootMargin: '200px 0px' }) : null;
      this._io?.observe(this.stage);
      this._syncReduced();
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  _listen(target, type, callback, options = {}) {
    target.addEventListener(type, callback, { ...options, signal: this._events.signal });
  }

  // ---------- per-character async work: every timer/frame is owned and cancelled with its character (R4-13) ----------
  _alive(c) { return !c.dead && !this.destroyed; }

  _later(c, fn, ms) {
    const id = setTimeout(() => { c.timers.delete(id); if (this._alive(c)) fn(); }, ms);
    c.timers.add(id);
    return id;
  }

  /** Cancel one owned timer and forget its id (the sets stay bounded). */
  _clear(c, id) {
    if (id == null || !c) return;
    clearTimeout(id);
    c.timers.delete(id);
  }

  _every(c, fn, ms) {
    const id = setInterval(() => { if (this._alive(c)) fn(); else clearInterval(id); }, ms);
    c.intervals.add(id);
    return id;
  }

  _nextFrame(c, fn) {
    if (!this._alive(c)) return;
    if (this.hidden) { fn(); return; }
    const tasks = (c.frameTasks ??= new Map());
    const id = requestAnimationFrame(() => { c.rafs.delete(id); tasks.delete(id); if (this._alive(c)) fn(); });
    tasks.set(id, fn);
    c.rafs.add(id);
    return id;
  }

  _stopPoseLoop(c, group) {
    if (!group) return;
    clearInterval(group._frameTimer); c.intervals.delete(group._frameTimer); group._frameTimer = null;
  }

  _dropPose(c, group) {
    if (!group || group._disposed) return;
    group._disposed = true;
    this._stopPoseLoop(c, group);
    group._cancelDecode?.(); group._cancelDecode = null;
    this._clear(c, group._fadeTimer);
    cancelAnimationFrame(group._swapFrame); c.rafs.delete(group._swapFrame); c.frameTasks?.delete(group._swapFrame);
    group.remove();
    for (const img of group.querySelectorAll('img')) img.removeAttribute('src');
    c.poseGroups?.delete(group);
    if (c.poseEl === group) c.poseEl = null;
    if (c.displayed === group) c.displayed = null;
  }

  _cancelAll(c) {
    for (const group of c.poseGroups ?? []) this._dropPose(c, group);
    for (const id of c.timers) clearTimeout(id);
    for (const id of c.intervals) clearInterval(id);
    for (const id of c.rafs) cancelAnimationFrame(id);
    c.frameTasks?.clear();
    c.timers.clear(); c.intervals.clear(); c.rafs.clear();
  }

  // ---------- image keep-alive and prefetch (O4) ----------
  /** Bounded decoded-image LRU avoids revalidation when poses reuse a URL. */
  _keep(url) {
    const m = (this._imgKeep ??= new Map());
    const hit = m.get(url);
    if (hit) { m.delete(url); m.set(url, hit); return hit; }
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    m.set(url, img);
    if (m.size > 240) m.delete(m.keys().next().value);
    return img;
  }

  /** Warm a look's likely poses (+ accessory layers) when the browser is idle. */
  _prefetchLook(look) {
    // Pack art loads on pose use; warming a whole pose/accessory set defeats lazy packs.
    if (this.index.characters.get(look.character)?.packManifest) return;
    const key = JSON.stringify(look);
    if ((this._prefetched ??= new Set()).has(key)) return;
    this._prefetched.add(key);
    const ch = this.index.characters.get(look.character);
    if (!ch) return;
    const poses = ['idle', 'walking', 'walking-se', 'talking', 'celebrating', 'alert', 'working-ne', 'thinking-ne', 'reading-ne', 'seated-turn-sw', 'sofa-sit-sw'];
    const run = () => {
      if (this.destroyed) return;
      for (const p of poses) {
        const body = poseImage(ch, look.variant, p);
        for (const path of body.frames ?? [body.path]) this._keep(resolveUrl(path, this.assetBase));
        const acc = accessoryLayers(this.index, ch.id, look.accessories, body.pose, look.variant, { legacy: this.legacyAccessories });
        for (const a of [...acc.back, ...acc.front]) this._keep(resolveUrl(a.path, this.assetBase));
      }
    };
    (globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, 200)))(run, { timeout: 2000 });
  }

  _releaseUnusedPackImages() {
    const active = [...this.chars.values()].map(c => c.occ?.look).filter(Boolean);
    for (const c of this.index.characters.values()) {
      if (!c.packLoaded) continue;
      const used = new Set(active.filter(l => l.character === c.id).map(l => l.variant));
      for (const v of c.variants) if (!used.has(v.id)) {
        const paths = new Set();
        for (const pose of Object.values(v.poses)) for (const file of pose.frames ?? [pose.image]) paths.add(resolveUrl(file, this.assetBase));
        for (const a of this.index.accessories.values()) for (const pose of Object.values(a.layers?.[c.id + '/' + v.id] ?? {})) {
          for (const pair of pose.frames ?? [pose]) for (const file of [pair.back, pair.front]) if (file) paths.add(resolveUrl(file, this.assetBase));
        }
        for (const url of paths) this._imgKeep?.delete(url);
      }
    }
  }

  /** R27-02: freeze the scene while what it shows is not confirmed live (the stream is down): like a hidden tab. */
  setFrozen(on) {
    if (!!on === !!this._frozen) return;
    this._frozen = !!on;
    this.stage.toggleAttribute('data-frozen', this._frozen);
    this._syncHidden();
  }

  get hidden() { return this._frozen || this._offscreen || this._pageHidden || this._lifecycleFrozen || (typeof document !== 'undefined' && document.visibilityState === 'hidden'); }

  _syncHidden() {
    if (this.destroyed) return;
    const h = this.hidden;
    if (h) { cancelAnimationFrame(this._raf); this._raf = 0; this._last = 0; }
    if (h) for (const c of this.chars.values()) { this._cancelEgg(c, { immediate:true }); this._cancelActivity(c); }
    this.stage.toggleAttribute('data-paused', h);
    for (const c of this.chars.values()) {
      if (h) {
        // Finish enter/crossfade DOM changes immediately; leave no decorative rAF queued.
        for (const [id, finish] of c.frameTasks ?? []) { cancelAnimationFrame(id); c.rafs.delete(id); finish(); }
        c.frameTasks?.clear();
        for (const g of c.poseGroups ?? []) this._stopPoseLoop(c, g);
        this._clear(c, c.idleTimer);
      } else if (c.occ && !c.leaving) {
        c.poseKey = null;          // restart frame loops
        this._renderPose(c);
        this._scheduleIdleSwivel(c);
      }
    }
    if (!h) { this._last = 0; this._kick(); }
  }

  get reducedMotion() {
    return this.forcedReduced ?? this._mq.matches;
  }

  /** Force reduced motion on/off (null = follow the OS setting). */
  setReducedMotion(v) {
    this.forcedReduced = v;
    this._syncReduced();
  }

  _syncReduced() {
    const on = this.reducedMotion;
    this.stage.toggleAttribute('data-reduced-motion', on);
    if (!on || !this.chars) return;
    // Reduced motion snaps walkers, ends cues and holds frame 0.
    for (const c of this.chars.values()) {
      // Stop all pose loops immediately, including pending decodes.
      for (const g of c.poseGroups ?? []) {
        this._stopPoseLoop(c, g);
        for (const img of g.querySelectorAll('img[data-frame]')) img.hidden = img.dataset.frame !== '0';
      }
      if (c.walking) {
        const last = c.path[c.path.length - 1] ?? c.target ?? c.pos;
        c.pos = { x: last.x, y: last.y };
        c.path = [];
        c.walking = false;
        const done = c.onArrive; c.onArrive = null;
        if (done) done(); else this._arrive(c);
        this._flash(c);
      }
      if (c.cue === 'celebrating') this._endCue(c, false);
      if (c.meet) this._endMeeting(c.meet.meeting);
      c.idleTurn = false; c.wave = false;
      this._clear(c, c.idleTimer); this._clear(c, c.waveTimer); this._clear(c, c.swivelTimer);
      c.poseKey = null;
      if (c.occ && !c.leaving) this._renderPose(c);
    }
    this._sortDirty = true;
    this._kick();
  }

  // ---------- DOM skeleton (README §3 layers 0–8) ----------
  _build() {
    const s = this.stage;
    s.classList.add('ao-office');
    s.replaceChildren();
    this.viewport = el('div', 'ao-viewport', { tabindex: '0', role: 'group', 'aria-roledescription': tr('scene.roledesc'), 'aria-label': tr('scene.viewport') });
    this.world = el('div', 'ao-world', { 'aria-hidden': 'true' });
    this.layers = {};
    for (const name of ['shell', 'wall', 'decal', 'scene', 'light', 'fx']) {
      this.layers[name] = el('div', `ao-layer ao-layer--${name}`);
      this.world.append(this.layers[name]);
    }
    this.labelsLayer = el('div', 'ao-layer ao-layer--labels');
    this.viewport.append(this.world, this.labelsLayer);

    const controls = el('div', 'bu-stage__controls ao-controls');
    this.controls = controls;
    const btn = (label, icon, fn) => {
      const b = el('button', 'bu-btn bu-btn--sm bu-btn--icon', { type: 'button', 'aria-label': label, title: label });
      b.innerHTML = icon;
      this._listen(b, 'click', fn);
      controls.append(b);
      return b;
    };
    const svg = (d) => `<svg class="bu-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    btn(tr('scene.zoomIn'), svg('<path d="M5 12h14"/><path d="M12 5v14"/>'), () => this.zoomBy(1.2));
    btn(tr('scene.zoomOut'), svg('<path d="M5 12h14"/>'), () => this.zoomBy(1 / 1.2));
    // Fit (recentre after a pan or zoom; also the 0 key): a crosshair, so it isn't mistaken for full screen.
    btn(tr('scene.fit'), svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/>'), () => { this.cam.user = false; this.fit(); }).dataset.ctl = 'fit';
    // Native fullscreen where supported; overlay fallback otherwise. Esc and Back leave it.
    this.fsButton = btn(tr('scene.fullscreen'), '', () => this.toggleFullscreen());
    this.fsButton.dataset.ctl = 'fullscreen';
    this._fsIcon = { enter: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'), exit: svg('<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>') };
    this._syncFullscreen();
    this.live = el('div', 'ao-sr', { 'aria-live': 'polite' });
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    defs.setAttribute('class', 'ao-defs');
    defs.setAttribute('aria-hidden', 'true');
    defs.innerHTML = '<defs><pattern id="ao-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="8" class="ao-hatch-line"/></pattern></defs>';
    s.append(defs);
    // O7 focus order: the stage tools (zoom, fit, Personnaliser) come before the scene and its nameplates, as they read.
    s.append(controls, this.viewport, this.live);
    this._bindCamera();
  }

  // ---------- layout & static furniture ----------
  setLayout(layout) {
    for (const c of this.chars.values()) this._cancelEgg(c, { dispose:true });
    for (const c of this.chars.values()) this._cancelActivity(c, false);
    this.layout = layout;
    this.layoutGen = (this.layoutGen ?? 0) + 1;   // invalidates every planned path (R4-15)
    this.room = this.index.rooms.get(layout.room) ?? this.index.manifest.rooms[0];
    this.items = new Map(layout.items.map((it) => [it.uid, it]));
    this.grid = buildGrid(this.room.cols, this.room.rows, layout.items.filter((i) => i.wall == null), this.index.furniture);
    const shellBox = imageBox(0, 0, this.room.anchor, this.room.size, this.proj);
    this.bounds = shellBox;
    for (const name of ['shell', 'wall', 'decal', 'scene', 'light', 'fx']) {
      const L = this.layers[name];
      if (name === 'scene' || name === 'fx') { L.querySelectorAll('[data-item]').forEach((n) => n.remove()); continue; }
      L.replaceChildren();
    }
    Object.assign(this.world.style, { width: `${shellBox.width}px`, height: `${shellBox.height}px` });
    // World children are positioned relative to grid (0,0); the world box starts at the shell's top-left.
    this.origin = { x: -shellBox.left, y: -shellBox.top };
    for (const name in this.layers) this.layers[name].style.transform = `translate(${this.origin.x}px, ${this.origin.y}px)`;

    this.shellImg = el('img', 'ao-shell', { alt: '', draggable: 'false' });
    place(this.shellImg, shellBox);
    this.layers.shell.append(this.shellImg);
    this.lightImg = el('img', 'ao-light', { alt: '', draggable: 'false' });
    place(this.lightImg, shellBox);
    this.layers.light.append(this.lightImg);

    this.itemNodes = new Map();
    const walls = [];
    for (const it of layout.items) {
      const f = this.index.furniture.get(it.asset);
      if (!f) continue;
      if (f.placement === 'wall') walls.push({ it, f });
      else this._buildItem(it, f);
    }
    walls.sort((a, b) => (a.it.wall === b.it.wall ? a.it.offset - b.it.offset : a.it.wall === 'left' ? -1 : 1));
    for (const { it, f } of walls) {
      const p = wallPoint(it.wall, it.offset, f.wall?.length ?? 1, f.wall?.elevation ?? 0, this.proj);
      const img = this._img(f.image, imageBox(p.sx, p.sy, f.anchor, f.size, this.proj), it.label ?? labelOf(f, 'furniture'));
      img.dataset.item = it.uid;
      this.layers.wall.append(img);
      this.itemNodes.set(it.uid, { it, f, parts: { [f.id]: img } });
    }
    for (const c of this.chars.values()) this._retarget(c, true);
    this._applyTheme();
    this._sortDirty = true;
    this._kick();
    if (!this.cam.user) this.fit();
    this._loadDecor();
  }

  _loadDecor() {
    const ids = [...new Set(this.layout.items.map(it => it.asset))].filter(id => {
      const f = this.index.furniture.get(id); return f?.packManifest && !f.packLoaded;
    });
    const revision = this._decorRevision = (this._decorRevision ?? 0) + 1;
    const previous = this._decorLoad;
    if (!ids.length) { previous?.abort(); this._decorLoad = null; delete this.stage.dataset.decorError; return; }
    const controller = this._decorLoad = new AbortController();
    this._decorReady = loadModule(() => import('./decor-pack-loader.js' + buildQuery)).then(m => {
      if (this.destroyed || controller.signal.aborted) { previous?.abort(); return; }
      const ready = m.ensureDecorPacks(this.index, ids, this.assetBase, { signal: controller.signal });
      // Admit replacement consumers before releasing previous consumers of shared requests.
      previous?.abort(); return ready;
    }).then(() => {
      if (!this.destroyed && revision === this._decorRevision && !controller.signal.aborted) this.setLayout(this.layout);
    }).catch(error => {
      if (!this.destroyed && revision === this._decorRevision && error.name !== 'AbortError') {
        this.stage.dataset.decorError = 'true'; this.opts.onAssetError?.(error);
      }
    });
  }

  _img(path, box, title) {
    const img = el('img', 'ao-sprite', { alt: '', draggable: 'false', decoding: 'async' });
    if (path) setSrc(img, resolveUrl(path, this.assetBase));
    if (title) img.title = title;
    place(img, box);
    return img;
  }

  _buildItem(it, f) {
    const o = it.orientation ?? 'sw';
    const fp = footprintFor(f.footprint, o);
    const p = project(it.x, it.y, this.proj);
    const title = it.label ?? labelOf(f, 'furniture');
    const node = { it, f, parts: {}, depth: itemDepth(it.x, it.y, fp, f.layerBias ?? 0), stack: [f.id] };
    const main = this._img(furnitureImage(f, o), imageBox(p.sx, p.sy, f.anchor, f.size, this.proj), title);
    main.dataset.item = it.uid;
    node.parts[f.id] = main;
    if (f.placement === 'decal') {
      this.layers.decal.append(main);
      this.itemNodes.set(it.uid, node);
      return;
    }
    if (f.station) {
      node.stack = f.station.stack ?? [f.id, 'character'];
      node.stacks = { stand: node.stack, seated: f.station.seated?.stack ?? node.stack };
      const allParts = [...Object.entries(f.station.parts ?? {})];
      // Seated (Batch 6) parts, e.g. chair@ne behind the occupant; shown only in seated mode.
      for (const [name, part] of Object.entries(f.station.seated?.parts ?? {})) allParts.push([`seated:${name}`, part]);
      for (const [name, part] of allParts) {
        const at = typeof part === 'object' && part.at ? part.at : { x: 0, y: 0 };
        const pp = project(it.x + at.x, it.y + at.y, this.proj);
        const anchor = (typeof part === 'object' && part.anchor) || f.anchor;
        const size = (typeof part === 'object' && part.size) || f.size;
        const img = this._img(partImage(part), imageBox(pp.sx, pp.sy, anchor, size, this.proj), title);
        img.dataset.item = it.uid;
        img.dataset.part = name;
        if (typeof part === 'object' && part.mirror) img.classList.add('ao-mirror');
        if (part.clip) img.style.clipPath = `polygon(${part.clip.map(([x, y]) => `${x}% ${y}%`).join(', ')})`;
        node.parts[name] = img;
      }
      // Seat contact in world px (Batch 6): seated poses put their seatAnchor here.
      const seated = f.station.seated;
      if (seated?.seatFrom === 'chair' && node.parts['seated:chair']) {
        const ch = seated.parts.chair;
        const img = node.parts['seated:chair'];
        node.seatWorld = { sx: parseFloat(img.style.left) + ch.seatAnchor.x / this.proj.artScale, sy: parseFloat(img.style.top) + ch.seatAnchor.y / this.proj.artScale };
      } else if (seated?.seatPoint) {
        node.seatWorld = { sx: parseFloat(main.style.left) + seated.seatPoint.x / this.proj.artScale, sy: parseFloat(main.style.top) + seated.seatPoint.y / this.proj.artScale };
      }
      if (seated?.seats?.length) node.seatWorlds = seated.seats.map(seat => ({
        sx: parseFloat(main.style.left) + seat.seatPoint.x / this.proj.artScale,
        sy: parseFloat(main.style.top) + seat.seatPoint.y / this.proj.artScale,
      }));
      for (const [name, img] of Object.entries(node.parts)) img.dataset.baseLeft = img.style.left, img.dataset.baseTop = img.style.top, void name;
      if (f.station.screen) {
        const box = imageBox(p.sx, p.sy, f.anchor, f.size, this.proj);
        const k = 1 / this.proj.artScale;
        node.screen = { sx: box.left + f.station.screen.x * k, sy: box.top + f.station.screen.y * k };
        node.glow = el('div', 'ao-glow');
        node.glow.dataset.item = it.uid;
        node.glow.style.left = `${node.screen.sx}px`;
        node.glow.style.top = `${node.screen.sy}px`;
        this.layers.fx.append(node.glow);
        if (node.parts.monitor) {
          node.tint = el('div', 'ao-tint');
          node.tint.hidden = true;
          node.tint.dataset.item = it.uid;
          const mon = node.parts.monitor;
          node.tint.style.cssText = mon.style.cssText;
          this.layers.scene.append(node.tint);
        }
      }
    }
    for (const img of Object.values(node.parts)) this.layers.scene.append(img);
    this.itemNodes.set(it.uid, node);
  }

  // ---------- theme ----------
  setTheme(mode) {
    this.themeMode = mode;
    this._applyTheme();
  }

  _applyTheme() {
    const tz = typeof this.opts.timeZone === 'function' ? this.opts.timeZone() : this.opts.timeZone;   // instance zone (frontend-07 §6)
    const id = resolveTheme(this.themeMode === 'auto' ? { ...this.layout.theme, mode: 'auto' } : this.themeMode, new Date(this.now()), tz || undefined);
    const theme = themeFor(this.index, id);
    const changed = theme.id !== this.theme?.id;
    this.theme = theme;
    this.stage.dataset.officeTheme = theme.kind === 'season' ? (themeFor(this.index, theme.base).kind) : theme.kind;
    setSrc(this.shellImg, resolveUrl(roomImage(this.room, theme), this.assetBase));
    if (theme.light?.image) {
      setSrc(this.lightImg, resolveUrl(theme.light.image, this.assetBase));
      this.lightImg.style.mixBlendMode = theme.light.blend ?? 'normal';
      this.lightImg.style.opacity = String(theme.light.opacity ?? 1);
      this.lightImg.hidden = false;
    } else this.lightImg.hidden = true;
    // Season variants override theme art; decorative extras have no collision.
    const season = this.layout.theme?.season ? this.index.themes.get(this.layout.theme.season) : null;
    const seasonOk = season?.kind === 'season' ? season : null;
    this.stage.dataset.officeSeason = seasonOk?.id ?? '';
    const variants = [...(seasonOk?.furnitureVariants ?? []), ...(theme.furnitureVariants ?? [])];
    this._applySeasonExtras(seasonOk);
    for (const node of this.itemNodes.values()) {
      const img = node.parts[node.f.id];
      setSrc(img, resolveUrl(furnitureImage(node.f, node.it.orientation ?? 'sw', variants), this.assetBase));
    }
    // A layout/pack rebuild creates new station parts even in the same theme.
    for (const uid of this.itemNodes.keys()) this._updateStation(uid);
    if (changed) {
      for (const c of this.chars.values()) this._renderPose(c);
    }
  }

  _applySeasonExtras(season) {
    const key = season?.id ?? '';
    if (this._seasonKey === key && this._seasonLayoutGen === this.layoutGen) return;
    this._seasonKey = key;
    this._seasonLayoutGen = this.layoutGen;
    for (const n of this._seasonNodes ?? []) n.img.remove();
    this._seasonNodes = [];
    for (const [i, x] of (season?.extras ?? []).entries()) {
      const f = this.index.furniture.get(x.asset);
      if (!f) continue;
      if (x.wall != null) {
        const p = wallPoint(x.wall, x.offset ?? 0, f.wall?.length ?? 1, f.wall?.elevation ?? 0, this.proj);
        const img = this._img(f.image, imageBox(p.sx, p.sy, f.anchor, f.size, this.proj), null);
        img.dataset.season = String(i);
        this.layers.wall.append(img);
        this._seasonNodes.push({ img, wall: true });
        continue;
      }
      const p = project(x.x, x.y, this.proj);
      const img = this._img(f.image, imageBox(p.sx, p.sy, f.anchor, f.size, this.proj), null);
      img.dataset.season = String(i);
      img.style.pointerEvents = 'none';
      (f.placement === 'decal' ? this.layers.decal : this.layers.scene).append(img);
      const fp = f.footprint ?? { w: 1, d: 1 };
      this._seasonNodes.push({ img, depth: itemDepth(Math.floor(x.x), Math.floor(x.y), fp, 0.05), x: x.x, decal: f.placement === 'decal' });
    }
    this._sortDirty = true;
    this._kick();
  }

  // ---------- occupants ----------
  setTravelIntents(occupants, floorId, memory) {
    this._travelRows = occupants;
    this._floorId = floorId;
    this._travelMemory = memory ?? this._travelMemory ?? new Map();
    this._intents?.setTravel(this);
  }
  /**
   * @param {Array<{id:string, role:string, name:string, state:string, stateSince:number, stationUid:string,
   *   look:{character:string, variant:string|null, accessories:string[]}}>} occupants  roster order
   */
  setOccupants(occupants) {
    this._packOccupants = occupants;
    const missing = [...new Set(occupants.map(o => o.look.character))].filter(id => {
      const c = this.index.characters.get(id); return c?.packManifest && !c.packLoaded;
    });
    if (missing.length) {
      const previousLoad = this._packLoad;
      const controller = this._packLoad = new AbortController();
      const revision = this._packRevision = (this._packRevision ?? 0) + 1;
      return loadModule(() => import('./character-pack-loader.js' + buildQuery))
        .then(m => {
          const loaded = m.ensureCharacterPacks(this.index, missing, this.assetBase, { signal: controller.signal });
          previousLoad?.abort(); return loaded;
        })
        .then(() => { if (!this.destroyed && revision === this._packRevision) this.setOccupants(this._packOccupants); })
        .catch(error => { if (!this.destroyed && revision === this._packRevision && error.name !== 'AbortError') { this.stage.dataset.packError = 'true'; this.opts.onAssetError?.(error); } });
    }
    this._packLoad?.abort(); this._packLoad = null;
    this._packRevision = (this._packRevision ?? 0) + 1;
    delete this.stage.dataset.packError;
    const ids = new Set(occupants.map((o) => o.id));
    const first = this.chars.size === 0 && !this._seeded;
    this._seeded = true;
    for (const c of this.chars.values()) if (!ids.has(c.id) && !c.leaving) this._leave(c);
    occupants.forEach((o, i) => {
      let c = this.chars.get(o.id);
      if (c && c.leaving) { this._destroyChar(c); c = null; }
      const isNew = !c;
      if (!c) c = this._spawn(o, !first);
      const previous = c.occ;
      const prevState = c.occ?.state;
      const prevLook = JSON.stringify(c.occ?.look);
      const prevPresence = c.occ?.presence ?? null;
      const communicationChanged = JSON.stringify(c.occ?.communication) !== JSON.stringify(o.communication) || JSON.stringify(c.occ?.screenIntent) !== JSON.stringify(o.screenIntent);
      const activityChanged = c.occ?.activity?.id !== o.activity?.id || c.occ?.activity?.kind !== o.activity?.kind;
      c.occ = o;
      if (activityChanged) { c._sipNext = null; c._sipRest = false; }
      if (prevState !== o.state) { c.signalState = null; c.signalBusy = false; }
      if (!canIdle(o)) c.carryProp = null;
      if (c.egg && !canIdle(o)) this._cancelEgg(c);
      if (c.social && !canIdle(o)) this._cancelActivity(this.chars.get(c.social.owner));
      if (c.activity && !canIdle(o)) this._cancelActivity(c);
      const reaction = reactionFor(previous, o, this.now(), this.lifeConfig);
      if (reaction && (reaction !== 'stretch' || this.now() - (c.lastStretch ?? -Infinity) > this.lifeConfig.longRunMs)) this.react(c.id, reaction);
      c.order = i;
      if (prevLook !== JSON.stringify(o.look)) this._prefetchLook(o.look);
      if (prevState !== o.state && c.cue) this._endCue(c, false);
      if (prevState && prevState !== o.state && o.state === 'error') this._shake(c);
      if (prevState !== o.state && prevState) this._announce(c);
      else if (isNew && !first) this._announce(c, 'enter');
      this._retarget(c, false);
      if (communicationChanged || activityChanged || prevState !== o.state || prevLook !== JSON.stringify(o.look) || prevPresence !== (o.presence ?? null)) this._renderPose(c);
      this._renderPlate(c);
    });
    for (const event of this._packSignals?.values() ?? []) if (ids.has(event.occupantId)) this.signal(event.occupantId, event);
    this._packSignals?.clear();
    this._releaseUnusedPackImages();
    // A delegation cue that arrived before its partner was on stage.
    const pm = this._pendingMeet;
    if (pm && this.now() <= pm.until && this.chars.get(pm.bId)) { this._pendingMeet = null; this._startMeeting(pm.aId, pm.bId, pm.interactionId); }
    else if (pm && this.now() > pm.until) this._pendingMeet = null;
    // Tab order follows roster order (README §5).
    const plates = [...this.chars.values()].filter((c) => !c.leaving).sort((a, b) => a.order - b.order).map((c) => c.plate);
    this.labelsLayer.append(...plates);
    if (this._visitPlan) this._applyVisits();   // office-dev-22: visitors follow their (new) hosts
    for (const uid of this.itemNodes.keys()) this._updateStation(uid);
    this._sortDirty = true;
    this._kick();
  }

  _spawn(o, walkIn) {
    const ch = this.index.characters.get(o.look.character) ?? this.index.manifest.characters[0];
    const c = {
      id: o.id, occ: null, ch, el: el('div', 'ao-char'), poseEl: null, path: [], pos: null, seatUid: null,
      plate: el('button', 'bu-nameplate ao-plate', { type: 'button' }), marker: el('div', 'ao-marker'), ring: el('div', 'ao-ring'),
      cue: null, leaving: false, facing: 'sw', walking: false,
      timers: new Set(), intervals: new Set(), rafs: new Set(), dead: false, displayed: null,
    };
    (this._allChars ??= new Set()).add(c);
    c.el.dataset.occupant = o.id;
    this._listen(c.plate, 'click', () => this.select(c.id, true));
    this._listen(c.plate, 'focus', () => this._plateFocus(c, true));
    this._listen(c.plate, 'blur', () => this._plateFocus(c, false));
    this.layers.scene.append(c.el);
    this.layers.fx.append(c.ring, c.marker);
    this.chars.set(o.id, c);
    const arrival = this._intents?.arrival(this, o);
    if (arrival && !this.reducedMotion) {
      c.pos = { x: arrival.target.x, y: arrival.target.y };
      c.el.dataset.journey = arrival.id; c.el.dataset.travelPhase = 'arrival';
    } else if (walkIn && this.room.entrance) {
      const e = nearestWalkable(this.grid, this.room.entrance.x, this.room.entrance.y) ?? this.room.entrance;
      c.pos = { x: e.x + 0.5, y: e.y + 0.5 };
      c.el.classList.add('ao-enter');
      this._nextFrame(c, () => c.el.classList.remove('ao-enter'));
    }
    return c;
  }

  _leave(c) {
    this._cancelEgg(c,{dispose:true});
    if (c.social) this._cancelActivity(this.chars.get(c.social.owner));
    this._cancelActivity(c, false);
    releaseWander(c);
    if (c.meet) this._endMeeting(c.meet.meeting);
    if (c.occ) this._announce(c, 'leave');
    c.leaving = true;
    c.plate.remove();
    c.sleepLetters?.remove();c.sleepLetters=null;
    c.marker.hidden = true;
    const departure = this._intents?.departure(this, c);
    if (departure && this.reducedMotion) return this._destroyChar(c);
    if (departure && c.pos) {
      c.target = departure.target;
      c.el.dataset.journey = departure.id; c.el.dataset.travelPhase = 'departure';
      this._walkTo(c, c.target, () => this._fadeOut(c));
      return;
    }
    const e = this.room.entrance;
    if (this.reducedMotion || !e || !c.pos) return this._fadeOut(c);
    c.target = { x: e.x + 0.5, y: e.y + 0.5, uid: null };
    this._walkTo(c, c.target, () => this._fadeOut(c));
  }

  _fadeOut(c) {
    c.el.classList.add('ao-exit');
    c.ring.remove();
    this._later(c, () => this._destroyChar(c), CROSSFADE_MS + 20);
  }

  _destroyChar(c) {
    this._cancelEgg(c,{dispose:true});
    this._cancelActivity(c, false);
    releaseWander(c);
    if (c.meet) this._endMeeting(c.meet.meeting);
    c.dead = true;
    this._cancelAll(c);
    this._allChars?.delete(c);
    c.el.remove(); c.plate.remove(); c.marker.remove(); c.ring.remove(); c.sleepLetters?.remove();
    // Only the current instance owns the id: a replacement with the same id keeps its selection (R4-13).
    if (this.chars.get(c.id) === c) {
      this.chars.delete(c.id);
      if (this.selected === c.id) this.selected = null;
    }
    this._releaseUnusedPackImages();
    this._sortDirty = true;
  }

  /** Where this occupant should be: own station, or a free lounge after 10 min idle (README §4.2). */
  _targetFor(c) {
    const o = c.occ;
    if (this._intents && Object.hasOwn(o, 'sceneTarget')) return this._intents.target(c);
    if (o.floorTravel?.point) return { x: o.floorTravel.point.x + 0.5, y: o.floorTravel.point.y + 0.5, uid: `floor-trip:${o.floorTravel.phase}`, mode: 'stand' };
    if (c.egg && !c.egg.returning) return c.egg.target ?? c.target ?? this._standingSpot(c);
    if (c.activity) return c.activity.target;
    if (c.social) return c.social.target;
    // Meeting scene (decorative, client-side; cue partnerId): stand at the assigned meeting spot.
    if (c.meet) return { x: c.meet.x, y: c.meet.y, uid: `meet:${c.meet.id}`, mode: 'stand' };
    // office-dev-22 visits: a person at the agent's desk, or everyone at the meeting table (setVisits).
    if (c.visit) return { x: c.visit.x, y: c.visit.y, uid: `visit:${c.visit.key}`, mode: 'stand' };
    let uid = o.stationUid;
    // Canonical destinations override decorative lounging; return home when they clear.
    const dest = o.destination?.stationUid;
    if (dest && this.itemNodes.get(dest)?.f.station) uid = dest;
    else if (!c.deskTalk && !c.signalBusy && this.now() - (c.lifeFinished ?? -Infinity) >= this.lifeConfig.cooldownMs && o.state === 'idle' && this.now() - (o.stateSince ?? 0) > LOUNGE_AFTER_MS) {
      for (const [u, n] of this.itemNodes) {
        if (n.f.station?.kind !== 'lounge') continue;
        const capacity = n.f.station.seated?.seats?.length || 1;
        const occupied = [...this.chars.values()].filter(x => x !== c && !x.leaving && x.target?.uid === u).length;
        if (occupied < capacity) { uid = u; break; }
      }
    }
    const node = this.itemNodes.get(uid);
    if (!node?.f.station) {
      const point = o.standingPoint;
      return point && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? { x: point.x + 0.5, y: point.y + 0.5, uid: `standing:${o.floorId || '1'}`, mode: 'stand' }
        : this._standingSpot(c);
    }
    const mode = seatModeFor(c.ch, o.look.variant, node.f.station);
    const seatRows = mode === 'sofa' && node.f.station.seated?.seats?.length ? node.f.station.seated.seats : null;
    let seatIndex = null, seat;
    if (seatRows) {
      const prior = c.target?.uid === uid ? c.target.seatIndex : null;
      const occupied = new Set([...this.chars.values()].filter(x => x !== c && !x.leaving && x.target?.uid === uid)
        .map(x => Number.isInteger(x.target.seatIndex) ? x.target.seatIndex : 0));
      seatIndex = Number.isInteger(prior) && !occupied.has(prior) ? prior : seatRows.findIndex((_, i) => !occupied.has(i));
      seatIndex = Math.max(0, seatIndex);
      seat = seatRows[seatIndex].seat;
      if (!seat) {
        // Convert the absolute projected contact back to a furniture-relative grid offset.
        seat = unproject(node.seatWorlds[seatIndex].sx, node.seatWorlds[seatIndex].sy, this.proj);
        seat = { x: seat.x - node.it.x, y: seat.y - node.it.y };
      }
    } else seat = mode === 'stand' ? node.f.station.seat : node.f.station.seated.seat;
    return { x: node.it.x + seat.x, y: node.it.y + seat.y, uid, mode, ...(seatIndex == null ? {} : { seatIndex }) };
  }

  /** Unassigned occupants stand on separate free entrance tiles, in roster order. */
  _standingSpot(c) {
    const e = this.room.entrance ?? { x: 0, y: this.room.rows - 1 };
    const taken = new Set();
    for (const x of this.chars.values()) {
      if (x === c || x.leaving || !x.target) continue;
      taken.add(`${Math.floor(x.target.x)},${Math.floor(x.target.y)}`);
    }
    for (let r = 1; r < this.room.cols + this.room.rows; r++) {
      for (let dx = -r; dx <= r; dx++) {
        const dy = r - Math.abs(dx);
        for (const y of dy === 0 ? [e.y] : [e.y - dy, e.y + dy]) {
          const x = e.x + dx;
          if (x < 0 || y < 0 || x >= this.room.cols || y >= this.room.rows) continue;
          if (this.grid.blocked[y * this.grid.cols + x] || taken.has(`${x},${y}`)) continue;
          return { x: x + 0.5, y: y + 0.5, uid: null, mode: 'stand' };
        }
      }
    }
    return { x: e.x + 0.5, y: e.y + 0.5, uid: null, mode: 'stand' };
  }

  _checkLounge() {
    for (const c of this.chars.values()) if (!c.leaving && c.occ) this._retarget(c, false);
  }

  _retarget(c, instant) {
    if (c.egg?.returning && c.egg.phase!=='return' && !instant) return;
    if (c.leaving) return;
    const t = this._targetFor(c);
    if (!t) return;
    const sameGen = c.targetGen === this.layoutGen;
    if (sameGen && c.target && c.target.uid === t.uid && c.target.x === t.x && c.target.y === t.y && c.target.mode === t.mode && c.target.seatIndex === t.seatIndex && c.target.facing === t.facing && c.pos) { c.target = t; this._scheduleIdleSwivel(c); return; }
    c.target = t;
    c.targetGen = this.layoutGen;
    if (!c.pos || instant || this.reducedMotion || this.editing) {
      const had = !!c.pos;
      c.pos = { x: t.x, y: t.y };
      c.path = [];
      this._arrive(c);
      if (had) this._flash(c);
      return;
    }
    // The walking feet stop beside the chair. Only a seated body enters its footprint.
    if (t.approachPoint && t.mode !== 'stand') {
      this._walkTo(c, t.approachPoint, () => { c.pos = { x: t.x, y: t.y }; this._arrive(c); });
      return;
    }
    if (t.mode === 'desk') {
      const from = { x: Math.floor(c.pos.x), y: Math.floor(c.pos.y) };
      const grid = { ...this.grid, blocked: this.grid.blocked.slice() };
      grid.blocked[Math.floor(t.y) * grid.cols + Math.floor(t.x)] = 1;
      const options = [[2, 0], [-2, 0], [0, 2], [0, -2]].map(([dx, dy]) => ({ x: Math.floor(t.x) + dx, y: Math.floor(t.y) + dy }))
        .filter(p => isWalkable(this.grid, p.x, p.y))
        .map(p => ({ p, path: findPath(grid, from, p) })).filter(o => o.path)
        .sort((a, b) => a.path.length - b.path.length);
      const approach = options[0]?.p;
      if (approach) {
        this._walkTo(c, { x: approach.x + .5, y: approach.y + .5 }, () => {
          c.pos = { x: t.x, y: t.y };
          this._arrive(c);
        }, grid);
        return;
      }
      c.pos = { x: t.x, y: t.y }; this._arrive(c); this._flash(c); return;
    }
    this._walkTo(c, t, () => this._arrive(c));
  }

  _walkTo(c, t, done, grid = this.grid) {
    const prevSeat = c.seatUid;
    c.seatUid = null;
    c.seatMode = null;
    c.walking = true;
    if (prevSeat) this._updateStation(prevSeat);
    const from = { x: Math.floor(c.pos.x), y: Math.floor(c.pos.y) };
    const to = { x: Math.floor(t.x), y: Math.floor(t.y) };
    const tiles = findPath(grid, from, to);
    if (!tiles) { c.pos = { x: t.x, y: t.y }; c.path = []; this._flash(c); done(); return; }
    c.path = tiles.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
    if (c.path.length) c.path[c.path.length - 1] = { x: t.x, y: t.y };
    else c.path.push({ x: t.x, y: t.y });
    c.onArrive = done;
    c.walking = true;
    this._renderPose(c);
    this._kick();
  }

  _arrive(c) {
    c.walking = false;
    c.path = [];
    delete c.el.dataset.travelPhase;
    if (c.target?.facing) c.facing = c.target.facing;
    if (c.target?.mode === 'desk') {
      if (c.carryProp === 'cup') {
        const node = this.itemNodes.get(c.target.uid);
        if (node) node.coffeeReturned = true;
      }
      // A standing frame must never be repositioned using the incoming seated hip.
      if (c.seatMode !== 'desk') {
        for (const group of c.poseGroups ?? []) this._dropPose(c, group);
        c.displayed = null; c.poseEl = null; c.poseKey = null;
      }
    }
    c.carryProp = null;
    if (!c.activity && !c.social) releaseWander(c);
    if (c.social) { c.social.phase = 'ready'; this.chars.get(c.social.owner)?.activity?.startSocial?.(); }
    if (c.meet && c.target?.uid === `meet:${c.meet.id}`) {
      c.seatUid = null;
      c.seatMode = null;
      this._positionChar(c);
      this._sortDirty = true;
      this._meetArrived(c);
      for (const uid of this.itemNodes.keys()) this._updateStation(uid);
      this._kick();
      return;
    }
    c.seatUid = c.target?.uid ?? null;
    c.seatMode = c.seatUid ? (c.target.mode ?? 'stand') : null;
    if (c.egg?.returning) c.egg.controller?.finish();
    this._renderPose(c);
    this._scheduleIdleSwivel(c);
    this._sortDirty = true;
    this._positionChar(c);
    for (const uid of this.itemNodes.keys()) this._updateStation(uid);
    this._kick();
  }

  /** 120 ms fade used for teleports (reduced motion, unreachable seats). */
  _flash(c) {
    c.el.classList.remove('ao-flash');
    void c.el.offsetWidth;
    c.el.classList.add('ao-flash');
  }

  // ---------- pose, accessories, crossfade ----------
  _seatedArt() {
    if (this._seatedArtCache === undefined) this._seatedArtCache = [...this.index.characters.values()].some((ch) => ch.poses?.['working-ne'] || ch.variants?.some((v) => v.poses?.['working-ne']));
    return this._seatedArtCache;
  }

  _currentPose(c) {
    // Walking toward the camera shows the front walks; away from it the back walks (fallback: front).
    if (c.walking) return c.carryProp === 'cup' ? `life-cupwalk-${c.facing}` : { se: 'walking-se', sw: 'walking', ne: 'walking-ne', nw: 'walking-nw' }[c.facing] ?? 'walking';
    const intentPose = this._intents?.pose(c);
    if (intentPose) return intentPose;
    if (c.egg?.pose) return c.egg.pose;
    if (c.activity?.phase === 'interact') {
      if (c.activity.kind === 'sleep' && c.seatMode === 'desk') return 'life-sleep-ne';
      if (c.activity.kind === 'highfive' || c.activity.kind === 'wave') return `life-highfive-${c.facing === 'se' ? 'se' : 'sw'}`;
      const d = ACTIVITIES[c.activity.kind];
      const held = c.activity.drinkRest ? d.restFrames : d.frames;
      if (held) return held.replace('{facing}', c.facing);
      if (c.facing === 'ne' || c.facing === 'nw') return `walking-${c.facing}`;
      return c.facing === 'se' ? 'talking-se' : ACTIVITIES[c.activity.kind].pose;
    }
    if (c.social?.phase === 'interact') return c.social.kind === 'highfive' ? `life-highfive-${c.facing === 'se' ? 'se' : 'sw'}` : (c.facing === 'se' ? 'talking-se' : 'talking');
    if (c.seatMode === 'desk') {
      const reaction = c.reaction ?? (c.occ.state === 'error' ? 'error' : null);
      const pose = REACTIONS[reaction]?.pose;
      if (pose) return pose;
    }
    if (!Object.hasOwn(c.occ, 'sceneTarget') && c.visit && !c.meet) return c.visit.talk === false ? (c.visit.facing === 'se' ? 'idle-se' : 'idle') : c.visit.facing === 'se' ? 'talking-se' : 'talking';
    if (!Object.hasOwn(c.occ, 'sceneTarget') && c.meet && c.meet.phase !== 'go') {
      const se = c.meet.facing === 'se';
      return c.meet.phase === 'talk' ? (se ? 'talking-se' : 'talking') : (se ? 'idle-se' : 'idle');
    }
    const state = c.signalState ?? c.occ.state;
    if (c.seatMode === 'desk') {
      if (c.deskTalk || c.social) return 'seated-talking-sw';
      if (c.cue) return SEATED_CUES[c.cue] ?? 'seated-turn-sw';
      const v = SEATED_VIEW[state] ?? SEATED_VIEW.idle;
      if (v.turn) return v.pose;
      if (c.wave) return 'seated-wave-sw';
      if (c.idleTurn && state === 'idle') return 'seated-turn-sw';
      return v.pose;
    }
    if (c.seatMode === 'sofa') return state === 'offline' ? SOFA_VIEW.offline : SOFA_VIEW.default;
    if (c.cue) return CUES[c.cue].pose;
    return viewFor(state).pose;
  }

  /** Seated swivel (back ↔ camera): cross through an intermediate seated pose (BRIEF, facing). */
  _swivelVia(c, from, to) {
    if (c.seatMode !== 'desk' || !from || this.reducedMotion) return null;
    if (isBackPose(from) === isBackPose(to)) return null;
    const look = c.occ.look;
    const mid = poseImage(c.ch, look.variant, 'seated-swivel').pose === 'seated-swivel' ? 'seated-swivel' : 'seated-ne';
    // Compare resolved poses: 'seated-ne' may itself resolve to working-ne (Batch 6).
    const midResolved = poseImage(c.ch, look.variant, mid).pose;
    if (from === midResolved || to === midResolved) return null;
    return mid;
  }

  _scheduleIdleSwivel(c) {
    this._clear(c, c.idleTimer);
    if (c.egg || c.activity || c.seatMode !== 'desk' || c.occ?.state !== 'idle' || this.reducedMotion || this.hidden || c.leaving) { if (c.idleTurn) { c.idleTurn = false; this._renderPose(c); } return; }
    const [a, b] = IDLE_SWIVEL_EVERY_MS;
    c.idleTimer = this._later(c, () => {
      c.idleTurn = true;
      this._renderPose(c);
      c.idleTimer = this._later(c, () => { c.idleTurn = false; this._renderPose(c); this._scheduleIdleSwivel(c); }, IDLE_SWIVEL_HOLD_MS);
    }, a + Math.random() * (b - a));
  }

  _renderPose(c) {
    if (!c.occ) return;
    const ch = this.index.characters.get(c.occ.look.character) ?? c.ch;
    c.ch = ch;
    c.el.dataset.locomotion = ch.locomotion?.type ?? 'walks';
    c.el.classList.toggle('ao-char--elevator', ['ride', 'ride-home'].includes(c.occ.floorTravel?.phase));
    let want = this._currentPose(c);
    const resolve = c.seatMode === 'desk' ? deskPoseImage : poseImage;
    const via = c.swivelDone ? null : this._swivelVia(c, c.renderedPose, resolve(ch, c.occ.look.variant, want).pose);
    c.swivelDone = false;
    this._clear(c, c.swivelTimer);
    if (via) {
      want = via;
      c.swivelTimer = this._later(c, () => { c.swivelDone = true; this._renderPose(c); }, SWIVEL_MS);
    }
    const body = { ...resolve(ch, c.occ.look.variant, want) };
    // Only working-ne loops; a state that falls back to it (idle, offline) holds the first frame still.
    if (body.frames && want !== 'working-ne') { body.path = body.frames[0]; body.frames = null; }
    c.renderedPose = body.pose;
    c.poseSeat = body.seatAnchor;
    c.poseAnchor = body.anchor;
    c.poseCanvas = body.canvas;
    c.poseHand = body.handAnchor;
    c.poseFx = body.fxAnchor;
    if (c.seatUid) this._updateStation(c.seatUid);
    const station = this.itemNodes.get(c.seatUid);
    const composition = station?.composition;
    c.poseScale = renderScale(ch) * (c.seatMode === 'desk' ? (composition?.scaleByCharacter?.[ch.id] ?? 1) : 1);
    const accessoryMode = this.stage.dataset.officeTheme === 'night' ? 'night' : 'day';
    if (c.occ.look.accessories?.some(id => this.index.accessories.get(id)?.packManifest))
      loadModule(() => import('./accessory-pack-loader.js' + buildQuery)).then(m => m.prepareSceneAccessories(this,c,body.pose,accessoryMode)).catch(() => {});
    const acc = accessoryLayers(this.index, ch.id, c.occ.look.accessories, body.pose, c.occ.look.variant, { legacy: this.legacyAccessories, mode: accessoryMode });
    // Back accessories → body → front accessories. A null frame is always shown.
    const nFrames = body.frames ? body.frames.length : 0;
    const expand = (a, role) => (nFrames && a.frames?.length === nFrames
      ? a.frames.map((p, i) => ({ path: p ?? a.path, frame: i, role }))
      : [{ path: a.path, frame: null, role }]);
    const layers = [
      ...acc.back.flatMap((a) => expand(a, 'back')),
      ...(body.frames ? body.frames.map((p, i) => ({ path: p, frame: i, role: 'body' })) : [{ path: body.path, frame: null, role: 'body' }]),
      ...acc.front.flatMap((a) => expand(a, 'front')),
    ];
    const key = layers.map((l) => l.path).join('|') + `|${c.poseScale}` + (this.debugLandmarks ? '|lm' : '');
    c.headY = headTopY(ch, c.occ.look.variant, body.pose);
    const view = viewFor(c.occ.state);
    c.el.dataset.state = c.occ.state;
    // O8: an agent seen recently but no longer on stage (presence 'seen') stays at its desk, greyed.
    if (c.occ.presence) c.el.dataset.presence = c.occ.presence; else delete c.el.dataset.presence;
    // Keep the hip planted, including celebrations: the standing hop would lift it off the cushion.
    const seatedMotion = c.seatMode === 'desk' ? (c.wave ? 'wave' : '') : c.cue ? (CUES[c.cue].motion ?? '') : (body.frames ? '' : null);
    c.el.dataset.motion = c.walking ? 'walk' : (seatedMotion ?? (c.cue ? (CUES[c.cue].motion ?? '') : (view.motion ?? '')));
    this._renderMarker(c);
    this._renderLife(c);
    this._positionChar(c);
    if (c.poseKey === key) return;
    c.poseKey = key;
    if (c.poseEl && c.poseEl !== c.displayed) this._dropPose(c, c.poseEl);
    for (const g of c.poseGroups ?? []) this._stopPoseLoop(c, g);
    const k = c.poseScale / this.proj.artScale;
    const group = el('div', 'ao-pose');
    (c.poseGroups ??= new Set()).add(group);
    group.dataset.pose = body.pose;
    Object.assign(group.style, { width: `${body.canvas.w * k}px`, height: `${body.canvas.h * k}px` });
    if (c.seatMode === 'desk' && body.seatAnchor) group.style.transformOrigin = `${body.seatAnchor.x * k}px ${body.seatAnchor.y * k}px`;
    const imgs = layers.map((l) => {
      const img = el('img', '', { alt: '', draggable: 'false' });
      img.src = this._keep(resolveUrl(l.path, this.assetBase)).src;
      img.dataset.layer = l.role;
      if (l.frame != null) {
        img.dataset.frame = String(l.frame); img.hidden = l.frame !== 0;
        const hip = body.frameSeatAnchors?.[l.frame];
        if (hip && body.seatAnchor) img.style.translate = `${(body.seatAnchor.x - hip.x) * k}px ${(body.seatAnchor.y - hip.y) * k}px`;
      }
      return img;
    });
    group.append(...imgs);
    if (this.debugLandmarks) {
      const variant = c.occ.look.variant;
      loadModule(() => import('./scene-landmarks.js' + buildQuery)).then(m => {
        if (this._alive(c) && c.poseEl === group && this.debugLandmarks) group.append(m.landmarkSvg(ch,variant,body.pose));
      }).catch(() => {});
    }
    // Drop superseded pose requests; crossfade from the currently mounted group.
    c.poseEl = group;
    const drop = (g) => this._dropPose(c, g);
    const swap = () => {
      if (!this._alive(c) || c.poseEl !== group) { drop(group); return; }
      const old = c.displayed;
      c.displayed = group;
      for (const n of [...c.el.children]) if (n !== old && n !== group && n.classList.contains('ao-pose')) drop(n);
      c.el.append(group);
      // Only the decoded, mounted winner may animate; outgoing art stays still during the fade.
      this._stopPoseLoop(c, old);
      if (nFrames && !this.reducedMotion && !this.hidden) {
        let i = 0;
        group._frameTimer = this._every(c, () => {
          i = (i + 1) % nFrames;
          for (const img of imgs) if (img.dataset.frame != null) img.hidden = Number(img.dataset.frame) !== i;
        }, body.frameMs);
      }
      if (!old) { group.classList.add('is-in'); return; }
      group._swapFrame = this._nextFrame(c, () => {
        group.classList.add('is-in');
        old.classList.remove('is-in');
        old._fadeTimer = this._later(c, () => { if (c.displayed !== old) drop(old); }, CROSSFADE_MS);
      });
    };
    // Native decode has no abort signal. Race cancellation releases the swap closure immediately;
    // dropping a pending group also clears its image sources so the browser can abandon decoding.
    const cancelled = new Promise(resolve => { group._cancelDecode = resolve; });
    Promise.race([Promise.all(imgs.map(i => i.decode().catch(() => {}))), cancelled]).then(() => {
      group._cancelDecode = null; swap();
    });
    this._positionChar(c);
  }

  _renderMarker(c) {
    const view = viewFor(c.occ.state);
    const kind = atComputer(c) ? null : this._intents?.marker ? this._intents.marker(c, view.marker) : c.cue ? null : view.marker;
    if (c.markerKind !== kind) {
      c.markerKind = kind;
      c.marker.innerHTML = kind ? markerHtml(kind) : '';
      c.marker.dataset.kind = kind ?? '';
    }
    c.marker.dataset.state = c.occ.state;
    c.marker.hidden = !kind || c.leaving;
  }

  _shake(c) {
    if (this.reducedMotion) return;
    c.el.classList.remove('ao-shake');
    void c.el.offsetWidth;
    c.el.classList.add('ao-shake');
  }

  // ---------- office life: owned walk → interaction → return sequences ----------
  _activityTarget(c, kind, partnerId = null) {
    const d = ACTIVITIES[kind];
    if (!d || !c.pos) return null;
    if (d.home) {
      const n = this.itemNodes.get(c.occ.stationUid);
      const seat = n?.f.station?.seated?.seat;
      return seat ? { x: n.it.x + seat.x, y: n.it.y + seat.y, uid: n.it.uid, mode: 'desk' } : null;
    }
    let landmark = null, partner = null;
    if (d.partner || d.visitor) {
      partner = [...this.chars.values()].find(x => x !== c && !x.leaving && !x.activity && !x.egg && !x.walking
        && !x.social && (partnerId ? x.id === partnerId && canIdle(x.occ) : d.visitor ? /^(dm|direct|group|conversation)/.test(x.occ.role) : canIdle(x.occ)));
      if (!partner) return null;
      if (d.partner) {
        // Two adjacent diagonal tiles share one screen row, giving one tile of social distance.
        const spots = this._spotsNear(partner.pos.x, partner.pos.y, 30);
        for (const at of spots) for (const side of [-1, 1]) {
          const other = { x: at.x + side, y: at.y - side };
          const tx = Math.floor(other.x), ty = Math.floor(other.y);
          if (tx < 0 || ty < 0 || tx >= this.grid.cols || ty >= this.grid.rows || this.grid.blocked[ty * this.grid.cols + tx]) continue;
          if ([...this.chars.values()].some(x => x !== c && x !== partner && !x.leaving && x.target && Math.floor(x.target.x) === tx && Math.floor(x.target.y) === ty)) continue;
          const from = x => ({x:Math.floor(x.pos.x),y:Math.floor(x.pos.y)});
          if (!findPath(this.grid, from(c), {x:Math.floor(at.x),y:Math.floor(at.y)}) || !findPath(this.grid, from(partner), {x:tx,y:ty}) || !this._socialVisible(at) || !this._socialVisible(other)) continue;
          const facing = side > 0 ? 'se' : 'sw', partnerFacing = side > 0 ? 'sw' : 'se';
          const own = { ...at }, peer = { ...other };
          if (kind === 'highfive') {
            // Reserve separate foot tiles; align authored palms across different heights.
            const hand = (who, dir) => {
              const p = poseImage(who.ch, who.occ.look.variant, `life-highfive-${dir}`);
              const k = renderScale(who.ch) / this.proj.artScale;
              return p.handAnchor && { x:(p.handAnchor.x-p.anchor.x)*k, y:(p.handAnchor.y-p.anchor.y)*k };
            };
            const h = hand(c, facing), ph = hand(partner, partnerFacing);
            if (h && ph) {
              const dx = (side*this.proj.tileWidth - (h.x-ph.x))/2;
              const dy = -(h.y-ph.y)/2;
              const gx = dx/this.proj.tileWidth + dy/this.proj.tileHeight;
              const gy = -dx/this.proj.tileWidth + dy/this.proj.tileHeight;
              if (Math.abs(gx) < .45 && Math.abs(gy) < .45) {
                own.x += gx; own.y += gy; peer.x -= gx; peer.y -= gy;
              }
            }
          }
          return { ...own, uid:`life:${kind}`, mode:'stand', partnerId:partner.id, facing,
            partnerTarget:{...peer,uid:`social:${c.id}`,mode:'stand',facing:partnerFacing} };
        }
        return null;
      }
      landmark = { x: partner.pos.x, y: partner.pos.y };
    } else {
      const n = [...this.itemNodes.values()].find(n => d.asset.split('|').includes(n.f.id));
      if (!n) return null;
      landmark = n.f.placement === 'wall'
        ? (n.it.wall === 'left' ? { x: 0, y: n.it.offset + (n.f.wall?.length ?? 1) / 2 } : { x: n.it.offset + (n.f.wall?.length ?? 1) / 2, y: 0 })
        : { x: n.it.x, y: n.it.y };
    }
    const spots = this._spotsNear(landmark.x, landmark.y, 20);
    const target = spots.find(t => findPath(this.grid, { x: Math.floor(c.pos.x), y: Math.floor(c.pos.y) }, { x: Math.floor(t.x), y: Math.floor(t.y) }));
    return target ? { ...target, uid: `life:${kind}`, mode: 'stand', landmark, partnerId: partner?.id } : null;
  }

  /** Check painted foreground furniture, excluding transparent margins, for torso occlusion. */
  _socialVisible(at) {
    const p = project(at.x, at.y, this.proj), depth = characterDepth(at.x, at.y);
    const probes = [-100,-70,-40].flatMap(y => [-15,0,15].map(x => ({x:p.sx+x,y:p.sy+y})));
    this._socialAlpha ??= new WeakMap();
    for (const n of this.itemNodes.values()) {
      if (n.f.placement !== 'floor' || n.depth <= depth) continue;
      for (const img of Object.values(n.parts)) {
        if (img.hidden || !img.naturalWidth) continue;
        const left = parseFloat(img.style.left), top = parseFloat(img.style.top);
        const w = parseFloat(img.style.width), h = parseFloat(img.style.height);
        const inside = probes.filter(p => p.x >= left && p.x < left+w && p.y >= top && p.y < top+h);
        if (!inside.length) continue;
        let cached = this._socialAlpha.get(img);
        if (cached?.src !== img.src) {
          const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d', {willReadFrequently:true});
          try { ctx.drawImage(img,0,0); cached = {src:img.src, pixels:ctx.getImageData(0,0,canvas.width,canvas.height).data}; }
          catch { continue; } // An external asset provider may disallow pixel reads.
          this._socialAlpha.set(img,cached);
        }
        if (inside.some(p => cached.pixels[(Math.floor((p.y-top)*img.naturalHeight/h)*img.naturalWidth+Math.floor((p.x-left)*img.naturalWidth/w))*4+3] > 120)) return false;
      }
    }
    return true;
  }

  // One life clock per scene; deadlines are data, never one timer per occupant.
  _tickLife() {
    if (this.hidden || this.editing || this.destroyed) return;
    const now = this.now();
    for (const c of this.chars.values()) {
      c.egg?.controller?.tick(now);
      this._intents?.tick(this, c, now);
      if (c.reaction && now >= c.reactionUntil) { c.reaction = null; this._renderPose(c); }
      const a = c.activity, d = a && ACTIVITIES[a.kind];
      if (a?.phase === 'interact') {
        if (now >= a.until) this._cancelActivity(c);
        else if (d.sipMs && !this.reducedMotion && now >= a.nextSip) {
          a.nextSip = now + d.sipMs; a.drinkRest = !a.drinkRest; this._renderPose(c);
        }
      }
    }
    this._intents?.tickScreens?.(this, now);
    if (now >= this._nextLifeCheck) { this._nextLifeCheck = now + this.lifeConfig.intervalMs; this._checkLife(); }
  }

  /** Neutral engine signal, with an opaque occupant id and canonical category. */
  signal(id, signal) {
    const c = this.chars.get(id), d = SIGNALS[signal?.kind];
    if (!c || !d || c.leaving) return false;
    if (signal.id) {
      const signature = `${signal.at}/${signal.count ?? 1}`;
      this._signalIds ??= new Map();
      if (this._signalIds.get(signal.id) === signature) return false;
      this._signalIds.set(signal.id, signature);
      if (this._signalIds.size > 128) this._signalIds.delete(this._signalIds.keys().next().value);
    }
    if (d.preempt) { this._cancelEgg(c); this._cancelActivity(c); c.carryProp = null; }
    c.signalBusy = signal.kind.startsWith('run.') ? signal.kind === 'run.started' : d.preempt || c.signalBusy;
    const state = d.state ?? d.categories?.[signal.toolKind] ?? (d.stateField && signal[d.stateField]);
    if (state && SEATED_VIEW[state]) c.signalState = state;
    else if (signal.kind === 'run.started' || signal.kind.startsWith('run.')) c.signalState = null;
    if (d.preempt) { c.lifeFinished = this.now(); c.target = null; this._retarget(c, false); }
    if (d.reaction) this.react(id, d.reaction);
    if (d.cue) this.cue(id, d.cue, signal);
    this._renderPose(c); return true;
  }

  /** Seed history without replay; changed id/at/count signatures are processed once. */
  setSignals(signals = []) {
    const next = new Map(signals.map(e => [e.id, `${e.at}/${e.count ?? 1}`]));
    if (this._signalsSeen) for (const e of [...signals].reverse()) {
      if (next.get(e.id) !== this._signalsSeen.get(e.id) && e.occupantId) {
        if (this._packLoad) (this._packSignals ??= new Map()).set(e.id, e);
        else this.signal(e.occupantId, e);
      }
    }
    this._signalsSeen = next;
  }

  _checkLife() {
    if (this.hidden || this.editing || this.destroyed) return;
    for (const c of this.chars.values()) {
      if (Object.hasOwn(c.occ || {}, 'sceneTarget')) continue;
      if (c.occ?.floorTravel || c.egg || c.leaving || c.walking || c.activity || c.social || c.visit || c.meet || c.deskTalk) continue;
      if (!canIdle(c.occ) || c.signalBusy) {
        if (reactionFor(c.occ, c.occ, this.now(), this.lifeConfig) === 'stretch'
          && this.now() - (c.lastStretch ?? -Infinity) > this.lifeConfig.longRunMs) this.react(c.id, 'stretch');
        continue;
      }
      if (wanderCount() >= this.lifeConfig.maxWanderers || this.now() - (c.lifeFinished ?? -Infinity) < this.lifeConfig.cooldownMs) continue;
      const random=this.opts.random ?? Math.random, past=surpriseHistory(c.id);
      if((this.opts.surprisesEnabled ?? surprisesEnabled)() && !c.signalBusy && eggEligible(c.occ,this.now(),past?.at,this.surpriseConfig) && random()<this.surpriseConfig.chance) {
        const egg=pickEgg(past?.kind,k=>!EGGS[k].landmark || [...this.itemNodes.values()].some(n=>EGGS[k].landmark.split('|').includes(n.f.id)),random);
        if(egg && wanderCount()<this.lifeConfig.maxWanderers) {this.surprise(c.id,egg);continue;}
      }
      const kind = pickActivity({ now: this.now(), idleSince: c.occ.stateSince ?? this.now(), history: c.lifeHistory,
        last: c.lastActivity, available: k => !!this._activityTarget(c, k), config: this.lifeConfig, random: this.opts.random });
      if (kind) this.interact(c.id, kind);
    }
  }

  /** QA entry point bypasses timing, never the idle/work or reachability guards. */
  interact(id, kind, { durationMs, partnerId } = {}) {
    const c = this.chars.get(id), def = ACTIVITIES[kind];
    if (!c || !def || !canIdle(c.occ) || c.signalBusy || c.leaving || c.egg || c.activity || c.social || c.visit || c.meet || c.deskTalk || this.editing || this.hidden) return false;
    const target = this._activityTarget(c, kind, partnerId);
    if (!target) return false;
    const peers = def.partner ? [this.chars.get(target.partnerId)] : [];
    if (!acquireWander(c, peers, this.lifeConfig.maxWanderers)) return false;
    const a = c.activity = { kind, target, phase: 'walk' };
    c.lastActivity = kind; (c.lifeHistory ??= {})[kind] = this.now();
    c.wave = false; c.idleTurn = false;
    this._clear(c, c.idleTimer); this._clear(c, c.waveTimer);
    c.target = target; c.targetGen = this.layoutGen;
    const begin = () => {
      if (c.activity !== a) return;
      const partner = this.chars.get(target.partnerId);
      if (def.partner && partner?.walking) { a.phase = 'ready'; return; }
      a.phase = 'interact'; c.walking = false;
      if (def.home) { c.seatUid = target.uid; c.seatMode = target.mode; }
      if (def.partner) {
        c.facing = target.facing;
        partner.social.phase = 'interact'; partner.facing = target.partnerTarget.facing;
        this._renderPose(partner); this._renderPlate(partner);
      } else if (target.landmark) c.facing = this._facingToward(c.pos, target.landmark);
      if (def.visitor && target.partnerId) this.react(target.partnerId, 'message');
      this._renderPose(c); this._renderPlate(c); this._sortDirty = true; this._kick();
      a.until = this.now() + (durationMs ?? def.ms);
      if (def.sipMs) a.nextSip = this.now() + def.sipMs;
    };
    a.startSocial = () => { if (!c.walking && a.phase === 'ready') begin(); };
    if (def.partner) {
      const partner = this.chars.get(target.partnerId);
      partner.social = { owner:c.id, kind, target:target.partnerTarget, phase:'walk' };
      this._retarget(partner, false);
    }
    const arrived = begin;
    if (this.reducedMotion) { const seat = c.seatUid; c.seatUid = null; c.seatMode = null; c.pos = { x: target.x, y: target.y }; c.path = []; if (seat) this._updateStation(seat); arrived(); }
    else this._walkTo(c, target, arrived);
    this._renderPlate(c);
    return true;
  }

  /** QA bypasses rarity only: busy agents, settings and the shared lease still apply. */
  async surprise(id, kind, config = {}) {
    const c = this.chars.get(id);
    if (!c || !EGG_KINDS.includes(kind) || !(this.opts.surprisesEnabled ?? surprisesEnabled)() || !canIdle(c.occ) || c.signalBusy || c.egg || c.walking || c.activity || c.social || c.visit || c.meet || c.deskTalk || c.leaving || this.editing || this.hidden || this.destroyed) return false;
    if (EGGS[kind].landmark && ![...this.itemNodes.values()].some(n => EGGS[kind].landmark.split('|').includes(n.f.id))) return false;
    if (!acquireSurprise(c)) return false;
    if (!acquireWander(c,[],this.lifeConfig.maxWanderers)) {releaseSurprise(c);return false;}
    const egg = c.egg = {kind, phase:'loading', target:c.target};
    c.lastSurprise = this.now(); c.lastEgg = kind; rememberSurprise(c.id,c.lastSurprise,kind);
    try {
      const { EggController } = await loadModule(() => import('./egg-controller.js' + buildQuery));
      if (c.egg !== egg || !this._alive(c) || !canIdle(c.occ)) { if (c.egg === egg) this._cancelEgg(c, {dispose:true}); return false; }
      egg.controller = new EggController(this,c,kind,{...this.surpriseConfig,...config});
      egg.controller.start(); return true;
    } catch { this._cancelEgg(c,{dispose:true}); return false; }
  }

  _cancelEgg(c, options = {}) {
    if (!c?.egg) return;
    if (c.egg.controller) c.egg.controller.cancel(options);
    else { c.egg=null; releaseSurprise(c); releaseWander(c); }
  }

  _cancelActivity(c, returnHome = true) {
    if (!c?.activity) return;
    const partner = this.chars.get(c.activity.target.partnerId);
    if (partner?.social?.owner === c.id) { partner.social = null; if (!returnHome) releaseWander(partner); partner.target = null; partner.onArrive = null; partner.walking = false; partner.path = []; this._retarget(partner, false); this._renderPose(partner); this._renderPlate(partner); }
    c.carryProp = returnHome && canIdle(c.occ) && c.activity.phase === 'interact' ? ACTIVITIES[c.activity.kind].carry ?? null : null;
    this._clear(c, c.activity.timer); this._clear(c, c.activity.sipTimer); c.activity = null; c.lifeFinished = this.now();
    c.onArrive = null; c.path = []; c.walking = false;
    c.target = null; this._renderLife(c);
    if (!returnHome) releaseWander(c);
    if (returnHome && c.occ && !c.dead && !c.leaving) { this._retarget(c, false); this._renderPose(c); this._renderPlate(c); }
  }

  react(id, kind, { durationMs } = {}) {
    const c = this.chars.get(id), def = REACTIONS[kind];
    if (!c || !def || c.leaving) return false;
    this._clear(c, c.reactionTimer); c.reaction = kind;
    if (kind === 'stretch') c.lastStretch = this.now();
    this._renderPose(c); this._kick();
    c.reactionUntil = this.now() + (durationMs ?? def.ms);
    return true;
  }

  _facingToward(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'se' : 'nw') : (dy > 0 ? 'sw' : 'ne');
  }

  _renderLife(c) {
    const action = this._intents?.activity(c) || (c.social?.phase === 'interact' ? c.social.kind : c.activity?.phase === 'interact' ? c.activity.kind : '');
    c.el.dataset.activity = action; c.el.dataset.facing = c.facing; c.el.dataset.reaction = c.reaction ?? '';
    // Objects and gripping fingers are one authored raster. Only environmental FX are overlays.
    const fx = action === 'smoke' ? 'smoke' : c.carryProp === 'cup' || action === 'coffee' && (c.activity?.drinkRest || c._sipRest) ? 'steam' : action === 'water' ? 'drops' : null;
    if (fx !== c.lifeFxKind) {
      c.lifeFx?.remove();c.lifeFx=null;c.lifeFxKind=fx;
      if(fx){c.lifeFx=el('div',`ao-life-fx ao-life-fx--${fx}`,{'aria-hidden':'true'});for(let i=0;i<3;i++)c.lifeFx.append(el('i'));c.el.append(c.lifeFx);}
    }
    c.el.toggleAttribute('data-carry', !!c.carryProp);
    let clap = c.el.querySelector('.ao-life-clap');
    if (action === 'highfive' && c.activity && c.poseHand) {
      if (!clap) { clap = el('span','ao-life-clap',{'aria-hidden':'true'}); clap.textContent = '✦'; c.el.append(clap); }
      clap.style.left = `${c.poseHand.x / c.poseCanvas.w * 100}%`;
      clap.style.top = `${c.poseHand.y / c.poseCanvas.h * 100}%`;
    } else clap?.remove();
    if (c.lifeFx) {
      const hand = c.poseFx ?? c.poseHand ?? { x: c.poseCanvas.w * (c.facing === 'nw' || c.facing === 'sw' ? .29 : .7), y: c.poseCanvas.h * .68 };
      c.lifeFx.style.left = `${hand.x / c.poseCanvas.w * 100}%`;
      c.lifeFx.style.top = `${hand.y / c.poseCanvas.h * 100}%`;
    }
    // Screen-space bubbles remain readable when the mobile camera fits the whole office.
    if(action==='sleep'&&!c.leaving){
      if(!c.sleepLetters){c.sleepVersion=(c.sleepVersion??0)+1;c.sleepLetters=el('span','ao-sleep-letters',{'aria-hidden':'true','data-occupant':c.id});c.sleepLetters.hidden=true;for(const letter of ['z','Z','z']){const node=el('i');node.textContent=letter;c.sleepLetters.append(node);}this.labelsLayer.append(c.sleepLetters);}
      this._sleepReady??=loadModule(()=>import('./sleep-letters.js'+buildQuery)).then(m=>{if(!this.destroyed){this._positionSleep=m.positionSleep;this._positionLabels();}}).catch(()=>{this._sleepReady=null;});
    }else{c.sleepLetters?.remove();c.sleepLetters=null;}
    const rawGlyph = action === 'sleep' ? null : c.reaction ? REACTIONS[c.reaction].symbol
      : action === 'highfive' ? '✦' : action === 'chat' ? '…' : action === 'wave' ? '👋'
      : ({ waiting:'…', error:'!' }[c.occ?.state]);
    const glyph = atComputer(c) ? null : this._intents?.bubble ? this._intents.bubble(c, rawGlyph) : rawGlyph;
    let bubble = c.plate.querySelector('.ao-life-bubble');
    if (glyph) {
      if (!bubble) { bubble = el('span','ao-life-bubble',{'aria-hidden':'true'}); c.plate.append(bubble); }
      bubble.textContent = glyph; bubble.dataset.kind = action || c.reaction || c.occ?.state;
      c.bubbleHeight = 36;
    } else { bubble?.remove(); c.bubbleHeight = 0; }
  }

  // ---------- cues (SSE 'cue' frames) ----------
  /** Deduplicate interactionId; delegating with a partner plays a meeting. */
  cue(occupantId, cue, { partnerId = null, interactionId = null } = {}) {
    if (interactionId) {
      this._interactions ??= new Set();
      if (this._interactions.has(interactionId)) return;
      this._interactions.add(interactionId);
      if (this._interactions.size > 200) this._interactions.delete(this._interactions.values().next().value);
    }
    if (cue === 'delegating' && partnerId && !Object.hasOwn(this.chars.get(occupantId)?.occ ?? {}, 'sceneTarget') && !this.reducedMotion && this._meetingSeats()) {
      if (this.chars.get(partnerId)) this._startMeeting(occupantId, partnerId, interactionId);
      else this._pendingMeet = { aId: occupantId, bId: partnerId, interactionId, until: this.now() + 4000 };
      return;
    }
    const c = this.chars.get(occupantId);
    const def = CUES[cue];
    if (!c || !def || c.leaving) return;
    this._cancelEgg(c);
    if (cue === 'celebrating') this.react(occupantId, 'success');
    if (cue === 'celebrating' && this.reducedMotion) return;
    if (c.cue) this._endCue(c, false);
    c.cue = cue;
    c.cueTimer = this._later(c, () => this._endCue(c, true), def.ms);
    this._renderPose(c);
  }

  // ---------- visits (office-dev-22): the people the agent talks with come to him ----------
  /** Visits: {hostId, desk, meeting, talking, speaker}. Meeting falls back to desk; only the speaker gets a bubble. */
  setVisits(plan) {
    this._visitPlan = plan ?? null;
    this._applyVisits();
  }

  _applyVisits() {
    if ([...this.chars.values()].some(c => Object.hasOwn(c.occ ?? {}, 'sceneTarget'))) {
      for (const c of this.chars.values()) { c.visit = null; c.deskTalk = false; c.deskBubble = false; c.plate?.removeAttribute('data-talking'); }
      return;
    }
    const plan = this._visitPlan;
    const want = new Map();
    // Conversations happen from each participant's own desk (no crowding at one desk or table);
    // only participants without a station stay where they are. Physical meetings come back later, rarely.
    const deskTalkers = new Set();
    if (plan && !this.editing && plan.talking !== false) {
      for (const id of [plan.hostId, ...(plan.hosts ?? []).map(host => host.id), ...(plan.desk ?? []), ...(plan.meeting ?? [])]) {
        const c = id && this.chars.get(id);
        if (c?.occ?.stationUid && !c.occ.destination) deskTalkers.add(id);
      }
    }
    for (const c of this.chars.values()) {
      if (c.leaving || !c.occ) continue;
      const w = want.get(c.id) ?? null;
      const deskTalk = deskTalkers.has(c.id);
      const changedDeskTalk = !!c.deskTalk !== deskTalk;
      const deskBubble = deskTalk && plan?.speaker === c.id;
      const moved = (c.visit?.key ?? null) !== (w?.key ?? null) || c.visit?.x !== w?.x || c.visit?.y !== w?.y;
      if (!moved && c.visit?.talk === w?.talk && c.visit?.bubble === w?.bubble && c.visit?.facing === w?.facing && !!c.deskTalk === deskTalk && !!c.deskBubble === deskBubble) continue;
      if (w || deskTalk) { this._cancelEgg(c); this._cancelActivity(c, false); }
      c.visit = w;
      c.deskTalk = deskTalk;
      c.deskBubble = deskBubble;
      if (moved || changedDeskTalk) this._retarget(c, false);
      this._renderPose(c);
      c.plate?.toggleAttribute('data-talking', !!w?.bubble || deskBubble);
      if (w) { c.el.dataset.visit = w.key.startsWith('t') ? 'meeting' : 'desk'; c.el.toggleAttribute('data-talk', !!w.talk); }
      else { delete c.el.dataset.visit; c.el.removeAttribute('data-talk'); }
    }
  }

  /** Where a character belongs when not visiting (its desk, lounge or destination). */
  _homeOf(c) {
    const v = c.visit;
    c.visit = null;
    try { return this._targetFor(c); } finally { c.visit = v; }
  }

  /** Nearest free spots on the same screen row (x+k, y−k), facing the host. */
  _besides(h, n, sides = null) {
    const hx = Math.floor(h.x), hy = Math.floor(h.y);
    const taken = new Set([...this.chars.values()].filter((c) => !c.leaving && c.target && !c.visit).map((c) => `${Math.floor(c.target.x)},${Math.floor(c.target.y)}`));
    taken.add(`${hx},${hy}`);
    const out = [];
    // Prefer screen-left: visitor SE, host SW. Never mirror sprites.
    for (const k of sides ?? [-1, 1, -2, 2]) {
      const tx = hx + k, ty = hy - k;
      if (tx < 0 || ty < 0 || tx >= this.grid.cols || ty >= this.grid.rows || this.grid.blocked[ty * this.grid.cols + tx] || taken.has(`${tx},${ty}`)) continue;
      taken.add(`${tx},${ty}`);
      out.push({ x: tx + 0.5, y: ty + 0.5, facing: k > 0 ? 'sw' : 'se' });   // right of the host on screen → faces left
      if (out.length >= n) return out;
    }
    if (sides) return out;
    return [...out, ...this._spotsNear(h.x, h.y, n - out.length + 1).filter((s) => Math.floor(s.x) !== hx || Math.floor(s.y) !== hy)].slice(0, n);
  }

  /** n free floor spots around a point, nearest first, each facing it (front poses: SW or SE). */
  _spotsNear(x, y, n) {
    const cx = Math.floor(x), cy = Math.floor(y);
    const taken = new Set([...this.chars.values()].filter((c) => !c.leaving && c.target && !c.visit).map((c) => `${Math.floor(c.target.x)},${Math.floor(c.target.y)}`));
    taken.add(`${cx},${cy}`);
    // Prefer visible tiles in front of the host; search within three tiles.
    const cand = [];
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
      if (!dx && !dy) continue;
      cand.push({ dx, dy, score: Math.abs(dx) + Math.abs(dy) + (dx + dy < 0 ? 3 : dx + dy === 0 ? 1 : 0) });
    }
    cand.sort((a, b) => a.score - b.score || (b.dx + b.dy) - (a.dx + a.dy));
    const out = [];
    for (const { dx, dy } of cand) {
      const tx = cx + dx, ty = cy + dy;
      if (tx < 0 || ty < 0 || tx >= this.grid.cols || ty >= this.grid.rows || this.grid.blocked[ty * this.grid.cols + tx] || taken.has(`${tx},${ty}`)) continue;
      taken.add(`${tx},${ty}`);
      out.push({ x: tx + 0.5, y: ty + 0.5, facing: (x - tx) >= (y - ty) ? 'se' : 'sw' });
      if (out.length >= n) break;
    }
    return out;
  }

  /** n spots around the first meeting table: its seats first, then free tiles around it; null without a table. */
  _tableSpots(n) {
    for (const node of this.itemNodes.values()) {
      const st = node.f.station;
      if (st?.kind !== 'meeting') continue;
      const seats = (st.seats ?? []).map((p) => ({ x: node.it.x + p.x, y: node.it.y + p.y, facing: p.facing === 'se' ? 'se' : 'sw' }))
        .filter((p) => { const tx = Math.floor(p.x), ty = Math.floor(p.y); return tx >= 0 && ty >= 0 && tx < this.grid.cols && ty < this.grid.rows && !this.grid.blocked[ty * this.grid.cols + tx]; });
      const fp = node.f.footprint ?? { w: 1, d: 1 };
      const cx = node.it.x + fp.w / 2, cy = node.it.y + fp.d / 2;
      const more = seats.length < n ? this._spotsNear(cx, cy, n - seats.length + 2).filter((s) => !seats.some((q) => Math.floor(q.x) === Math.floor(s.x) && Math.floor(q.y) === Math.floor(s.y))) : [];
      const all = [...seats, ...more];
      return all.length >= Math.min(n, 2) ? all.slice(0, n) : null;
    }
    return null;
  }

  // ---------- meeting scene (delegation): the two face each other, then the partner goes to its desk ----------
  /** The first meeting station's two spots on screen: { left (faces SE), right (faces SW), node }, or null. */
  _meetingSeats() {
    for (const node of this.itemNodes.values()) {
      const seats = node.f.station?.kind === 'meeting' ? node.f.station.seats : null;
      if (!seats || seats.length < 2) continue;
      const pick = (facing) => seats.find((p) => p.facing === facing);
      const left = pick('se'), right = pick('sw');
      if (!left || !right) continue;
      const at = (p) => ({ x: node.it.x + p.x, y: node.it.y + p.y, facing: p.facing });
      const free = (p) => {
        const tx = Math.floor(p.x), ty = Math.floor(p.y);
        return tx >= 0 && ty >= 0 && tx < this.grid.cols && ty < this.grid.rows && !this.grid.blocked[ty * this.grid.cols + tx];
      };
      const L = at(left), R = at(right);
      if (free(L) && free(R)) return { left: L, right: R, node };
    }
    return null;
  }

  _startMeeting(aId, bId, interactionId) {
    const a = this.chars.get(aId), b = this.chars.get(bId);
    if ([a, b].some(c => Object.hasOwn(c?.occ ?? {}, 'sceneTarget'))) return;
    const seats = this._meetingSeats();
    if (!a || !b || a.leaving || b.leaving || !seats || a.meet || b.meet) return;
    const id = interactionId ?? `m${(this._meetSeq = (this._meetSeq ?? 0) + 1)}`;
    const meeting = { id, members: [a, b] };
    // The delegator stands on the right (faces SW), the new sub-agent on the left (faces SE).
    a.meet = { ...seats.right, id, phase: 'go', meeting };
    b.meet = { ...seats.left, id, phase: 'go', meeting };
    // Safety: never hold anyone longer than 15 s (unreachable spot, stalled walk).
    meeting.owner = a;
    meeting.timer = this._later(a, () => this._endMeeting(meeting), 15_000);
    for (const c of meeting.members) this._retarget(c, false);
  }

  _meetArrived(c) {
    const m = c.meet?.meeting;
    if (!m) return;
    c.meet.phase = 'wait';
    this._renderPose(c);
    if (!m.members.every((x) => x.meet?.phase === 'wait' && !x.walking)) return;
    for (const x of m.members) { x.meet.phase = 'talk'; this._renderPose(x); }
    this._clear(m.owner, m.timer);
    m.owner = m.members[0];
    m.timer = this._later(m.owner, () => this._endMeeting(m), CUES.delegating.ms);
  }

  _endMeeting(m) {
    this._clear(m.owner, m.timer);
    for (const x of m.members) {
      if (x.meet?.meeting !== m) continue;
      x.meet = null;
      if (!x.dead && !x.leaving && x.occ) { this._retarget(x, false); this._renderPose(x); }
    }
  }

  _endCue(c, render) {
    this._clear(c, c.cueTimer);
    c.cue = null;
    if (render) this._renderPose(c);
  }

  // ---------- stations: monitor on/off/error, offline dim ----------
  _updateStation(uid) {
    const node = this.itemNodes.get(uid);
    if (!node?.f.station) return;
    const seated = [...this.chars.values()].find((c) => !c.leaving && c.occ && c.target?.uid === uid && !c.walking);
    const occ = seated?.occ;
    // Empty stations use seated chairs when the look supports seated art.
    const mode = seated ? (seated.seatMode === 'stand' || !seated.seatMode ? 'stand' : 'seated') : (node.f.station.seated && this._seatedArt() ? 'seated' : 'stand');
    const base = node.f.station.seated;
    const turned = mode === 'seated' && seated?.seatMode === 'desk' && seated.renderedPose && !isBackPose(seated.renderedPose);
    const composition = turned && base?.turned ? base.turned : base;
    const stack = mode === 'seated' ? (composition?.stack ?? node.stacks.seated) : node.stacks.stand;
    node.composition = composition;
    // Per-family part offsets (keyboard within the smaller agents' reach), from the occupant's character.
    for (const [name, part] of Object.entries(node.f.station.seated?.parts ?? {})) {
      if (!part?.offsetByCharacter) continue;
      const img = node.parts[`seated:${name}`];
      const off = (seated && part.offsetByCharacter[seated.ch.id]) || { x: 0, y: 0 };
      img.style.left = `${parseFloat(img.dataset.baseLeft) + off.x / this.proj.artScale}px`;
      img.style.top = `${parseFloat(img.dataset.baseTop) + off.y / this.proj.artScale}px`;
    }
    if (node.mode !== mode || node.stack !== stack) {
      node.mode = mode;
      node.stack = stack;
      for (const [name, img] of Object.entries(node.parts)) {
        if (name.startsWith('seated:')) img.hidden = mode !== 'seated' || !stack.includes(name.slice(7));
        else if (mode === 'seated' && node.parts[`seated:${name}`]) img.hidden = true;
        else img.hidden = false;
      }
      this._sortDirty = true;
      this._kick();
    }
    const seatPart = composition?.seatFrom;
    if (node.parts['seated:mug']) node.parts['seated:mug'].hidden = !node.coffeeReturned;
    if (seatPart && base?.parts?.[seatPart]?.seatAnchor) {
      const part = base.parts[seatPart], img = node.parts[`seated:${seatPart}`];
      node.seatWorld = { sx: parseFloat(img.style.left) + part.seatAnchor.x / this.proj.artScale, sy: parseFloat(img.style.top) + part.seatAnchor.y / this.proj.artScale };
    }
    const view = occ ? viewFor(occ.state) : null;
    let mon = view?.monitor ?? 'off';
    if (occ && this.theme?.monitors === 'on' && mon === 'off' && !['idle', 'offline'].includes(occ.state)) mon = 'on';
    const monitor = node.parts.monitor;
    if (monitor) {
      const screen = this._intents?.screen(this, occ, this.now());
      setSrc(monitor, resolveUrl(screen || partImage(node.f.station.parts.monitor, mon === 'off' ? null : 'on'), this.assetBase));
      monitor.dataset.screen = screen ? screen.split('/').pop() : '';
      if (screen && mon === 'off') mon = 'on';
    }
    if (node.tint) {
      node.tint.hidden = mon !== 'error';
      const maskPath = partImage(node.f.station.parts.monitor, 'on');
      // Manifest data never reaches CSS unvalidated: only a plain asset path can become a mask URL.
      node.tint.style.maskImage = node.tint.style.webkitMaskImage = SAFE_ASSET.test(maskPath) ? `url("${resolveUrl(maskPath, this.assetBase)}")` : 'none';
    }
    if (node.glow) node.glow.dataset.mode = mon;
    const dim = occ?.state === 'offline';
    for (const img of Object.values(node.parts)) img.classList.toggle('ao-dim', dim);
    const shown = occ && this._name(occ);
    const name = occ ? (this.layout.items.find((i) => i.uid === uid)?.label ?? (node.f.station.kind === 'desk' ? tr('scene.deskOf', { name: shown }) : tr('scene.itemOf', { item: labelOf(node.f, 'furniture'), name: shown }))) : (node.it.label ?? labelOf(node.f, 'furniture'));
    for (const img of Object.values(node.parts)) img.title = name;
  }

  // ---------- nameplates, selection, a11y ----------
  _renderPlate(c) {
    const o = c.occ;
    // O8: a seen agent's plate says when it was last seen (« vu il y a 12 min »), as text, name and tooltip.
    const label = o.sourceStale ? o.stateLastLabelText
      : o.presenceLabel ?? ((o.activity || o.communication) && this._intents ? this._intents.label(c) : c.egg ? tr(`egg.${c.egg.kind}`) : c.activity ? tr(`life.${c.activity.kind}`) : o.stateLabelText);
    const shown = this._name(o);
    c.plate.setAttribute('aria-label', `${shown}, ${label}`);
    c.plate.dataset.state = o.state;
    c.plate.toggleAttribute('data-source-stale', !!o.sourceStale);
    c.plate.dataset.role = o.role;
    c.plate.toggleAttribute('data-talking', !!c.visit?.bubble || !!c.deskBubble);
    if (o.presence) c.plate.dataset.presence = o.presence; else delete c.plate.dataset.presence;
    c.plate.title = `${shown}, ${label}`;
    c.plate.innerHTML = '';
    c.plateSize = null;
    const dot = el('span', 'ao-dot', { 'aria-hidden': 'true' });
    const name = el('span', 'ao-plate__name');
    c.plateName = name; c.plateNameText = shown;
    name.textContent = c.plate.hidden ? '' : shown;
    const small = el('small', 'ao-plate__state', { 'aria-hidden': 'true' });
    small.textContent = label;
    c.plate.append(dot, name, small);
    this._renderLife(c);
    if (this.selected === c.id) c.plate.setAttribute('aria-current', 'true'); else c.plate.removeAttribute('aria-current');
  }

  _plateFocus(c, on) {
    c.el.classList.toggle('is-focus', on);
    if(this.stage.hasAttribute('data-plates-primary')) {c.plateSize=null;this._positionLabels();}
  }

  _showPlate(c, show) {
    c.plate.hidden = !show;
    // Only displayed names have a text node; accessible identity stays on the button.
    const text = show ? c.plateNameText : '';
    if (c.plateName && c.plateName.textContent !== text) c.plateName.textContent = text;
  }

  /** Batch announcements for 1.5s, at least 4s apart; latest change wins, silent while hidden. */
  _announce(c, kind = 'state') {
    if (!this.live || document.visibilityState === 'hidden') return;   // scrolled out of view still speaks (O9)
    (this._pending ??= new Map()).set(c.id, { kind, name: this._name(c.occ), stateLabelText: c.occ.stateLabelText });
    if (this._announceTimer) return;
    const wait = Math.max(ANNOUNCE_BATCH_MS, (this._lastAnnounce ?? 0) + ANNOUNCE_MIN_GAP_MS - Date.now());
    this._announceTimer = setTimeout(() => this._flushAnnounce(), wait);
  }

  _flushAnnounce() {
    this._announceTimer = null;
    const items = [...(this._pending ?? new Map()).values()];
    this._pending = new Map();
    if (!items.length || this.destroyed) return;
    // Whole sentences, joined by spaces (guide §2: no fragment concatenation), in the UI language.
    const phrase = (x) => (x.kind === 'enter' ? tr('scene.enter', { name: x.name })
      : x.kind === 'leave' ? tr('scene.leave', { name: x.name })
      : tr('scene.state', { name: x.name, state: (x.stateLabelText || '').toLocaleLowerCase(intlLocale()) }));
    const shown = items.slice(0, 3).map(phrase);
    const more = items.length - shown.length;
    this.live.textContent = [items.length > 1 ? tr('scene.changes', { n: items.length }) : null, ...shown, more > 0 ? tr('scene.andMore', { n: more }) : null].filter(Boolean).join(' ');
    this._lastAnnounce = Date.now();
  }

  /** Never a raw id on screen: VM name → primary agent name (opts.primaryName) → « L’agent » / role label. */
  _name(o) {
    const p = this.opts.primaryName;
    return displayName(o, { primaryName: typeof p === 'function' ? p() : p });
  }

  /** Test/QA hook: what the live region last said. */
  get announcement() { return this.live?.textContent ?? ''; }

  /** Compact presentation consumes the backend's ordered floor shortlist. */
  setPrimaryLabels(on, mobileLabelIds = []) {
    this.stage.toggleAttribute('data-plates-primary',!!on);
    this.mobileLabelIds = mobileLabelIds;
    for(const c of this.chars.values()) { c.plateSize=null; this._showPlate(c,true); }
    this._positionLabels();
  }

  /** Select an occupant (ring + aria-current). fromUser fires onSelect (opens the drawer). */
  select(id, fromUser = false) {
    this.selected = id;
    for (const c of this.chars.values()) {
      const on = c.id === id;
      c.ring.classList.toggle('is-on', on);
      if (on) c.plate.setAttribute('aria-current', 'true'); else c.plate.removeAttribute('aria-current');
    }
    if(this.stage.hasAttribute('data-plates-primary')) {for(const c of this.chars.values())c.plateSize=null;this._positionLabels();}
    const c = this.chars.get(id);
    if (fromUser && c && c.seatMode === 'desk') {
      this._clear(c, c.waveTimer);
      c.wave = true;
      this._renderPose(c);
      c.waveTimer = this._later(c, () => { c.wave = false; this._renderPose(c); }, SELECT_WAVE_MS);
    }
    if (fromUser && this.onSelect) {
      // the agent's card (drawer) opens outside the stage: leave full screen first so it can be seen
      if (this.fullscreen) this.toggleFullscreen(false).then(() => this.onSelect?.(id)); else this.onSelect(id);
    }
  }

  // ---------- frame loop ----------
  _kick() {
    // Cached/frozen snapshots still need correct static furniture/character
    // stacking after a layout or decoded-pose update; only motion is paused.
    if (!this.destroyed && this._frozen && this._sortDirty) this._sort();
    if (!this._raf && !this.destroyed && !this.hidden) this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  _frame(t) {
    this._raf = 0;
    if (this.destroyed || this.hidden) { this._last = 0; return; }
    const dt = this._last ? Math.min(0.1, (t - this._last) / 1000) : 0;
    this._last = t;
    let moving = false;
    for (const c of this.chars.values()) {
      if (!c.walking || !c.path.length) continue;
      moving = true;
      let step = (this.opts.walkTilesPerS ?? WALK_TILES_PER_S) * dt;
      while (step > 0 && c.path.length) {
        const n = c.path[0];
        const dx = n.x - c.pos.x, dy = n.y - c.pos.y;
        const d = Math.hypot(dx, dy);
        // Screen-right movement (+x or −y) uses the separately painted SE walk; never mirror (README §4).
        const facing = dx > 0.01 ? 'se' : dy > 0.01 ? 'sw' : dx < -0.01 ? 'nw' : dy < -0.01 ? 'ne' : c.facing;
        if (facing !== c.facing) { c.facing = facing; this._renderPose(c); }
        if (d <= step) { c.pos = { x: n.x, y: n.y }; c.path.shift(); step -= d; }
        else { c.pos = { x: c.pos.x + (dx / d) * step, y: c.pos.y + (dy / d) * step }; step = 0; }
      }
      this._positionChar(c);
      this._sortDirty = true;
      if (!c.path.length) { const done = c.onArrive; c.onArrive = null; c.walking = false; done?.(); }
    }
    if (this._sortDirty) this._sort();
    this._positionLabels();
    if (moving) this._kick(); else this._last = 0;
  }

  _positionChar(c) {
    if (!c.pos) return;
    const ch = c.ch;
    const p = project(c.pos.x, c.pos.y, this.proj);
    // Seated (desk/sofa, Batch 6): the pose's hip contact lands on the seat contact; else feet on the floor.
    const seatNode = !c.walking && (c.seatMode === 'desk' || c.seatMode === 'sofa') && c.seatUid ? this.itemNodes.get(c.seatUid) : null;
    const seatAt = seatNode?.seatWorld && c.poseSeat ? (seatNode.seatWorlds?.[c.target?.seatIndex] ?? seatNode.seatWorld) : null;
    const activitySeat = !c.walking && c.occ.activity && c.target?.seatContact && c.poseSeat ? project(c.target.seatContact.x, c.target.seatContact.y, this.proj) : null;
    const contact = activitySeat || seatAt;
    const box = contact
      ? imageBox(contact.sx, contact.sy, c.poseSeat, c.poseCanvas ?? ch.canvas, this.proj, c.poseScale ?? renderScale(ch))
      : imageBox(p.sx, p.sy, c.poseAnchor ?? ch.anchor, c.poseCanvas ?? ch.canvas, this.proj, c.poseScale ?? renderScale(ch));
    c.el.style.transform = `translate(${box.left}px, ${box.top}px)`;
    Object.assign(c.el.style, { width: `${box.width}px`, height: `${box.height}px` });
    const headY = box.top + ((c.headY ?? ch.head?.y ?? 40) * (c.poseScale ?? renderScale(ch))) / this.proj.artScale;
    const headX = box.left + (c.poseCanvas ?? ch.canvas).w * (c.poseScale ?? renderScale(ch)) / this.proj.artScale / 2;
    c.head = { sx: headX, sy: headY };
    c.marker.style.transform = `translate(${headX + 26}px, ${headY + 22}px)`;
    c.ring.style.transform = `translate(${p.sx}px, ${p.sy}px)`;
  }

  _sort() {
    this._sortDirty = false;
    const entries = [];
    const zOf = new Map();
    for (const [uid, node] of this.itemNodes) {
      if (node.f.placement !== 'floor') continue;
      node.stack.forEach((name, i) => {
        if (name === 'character') return;
        const img = (node.mode === 'seated' && node.parts[`seated:${name}`]) || node.parts[name];
        if (img) entries.push({ id: `${uid}:${name}`, depth: node.depth, sub: i, x: node.it.x, node: img });
        if (name === 'monitor' && node.tint) entries.push({ id: `${uid}:tint`, depth: node.depth, sub: i + 0.5, x: node.it.x, node: node.tint });
      });
    }
    for (const [i, n] of (this._seasonNodes ?? []).entries()) {
      if (!n.wall && !n.decal) entries.push({ id: `season:${i}`, depth: n.depth, sub: 9, x: n.x, node: n.img });
    }
    for (const c of this.chars.values()) {
      if (!c.pos) continue;
      const seat = !c.walking && c.seatUid ? this.itemNodes.get(c.seatUid) : null;
      if (seat && seat.f.placement === 'floor') {
        const i = seat.stack.indexOf('character');
        const seatOrder = Number.isInteger(c.target?.seatIndex) ? c.target.seatIndex / 10 : 0;
        entries.push({ id: `${c.seatUid}:character:${c.id}`, depth: seat.depth, sub: (i < 0 ? seat.stack.length : i) + seatOrder, x: seat.it.x + (c.target?.x ?? 0), node: c.el });
      } else entries.push({ id: `~${c.id}`, depth: characterDepth(c.pos.x, c.pos.y), sub: 5, x: c.pos.x, node: c.el });
    }
    sortScene(entries).forEach((e, i) => { zOf.set(e.node, i + 1); });
    for (const [node, z] of zOf) node.style.zIndex = String(z);
  }

  _positionLabels() {
    const { zoom, x, y } = this.cam;
    const width = this.viewport.clientWidth, height = this.viewport.clientHeight;
    if (this.stage.hasAttribute('data-plates-primary')) {
      const viewport = this.viewport.getBoundingClientRect();
      const placed = [...(this.stage.parentElement?.querySelectorAll('.bu-stage__controls, .ao-mobile-options') ?? [])]
        .map(node => node.getBoundingClientRect()).filter(r => r.width && r.height)
        .map(r => ({ left: r.left - viewport.left, right: r.right - viewport.left, top: r.top - viewport.top, bottom: r.bottom - viewport.top }));
      const labelIds = this.selected ? [this.selected, ...(this.mobileLabelIds ?? []).filter(id => id !== this.selected)] : this.mobileLabelIds ?? [];
      placed.push(...(this._positionSleep?.(this,placed)??[]));
      for (const c of this.chars.values()) if (!labelIds.includes(c.id) || !c.head || c.leaving) this._showPlate(c,false);
      // Geometry may suppress a supplied label, but never substitutes another occupant.
      for (const id of labelIds) {
        const c = this.chars.get(id);
        if (!c?.head || c.leaving) continue;
        if (!c.plateSize) this._showPlate(c,true);
        c.plateSize ??= { w: c.plate.offsetWidth, h: c.plate.offsetHeight };
        const w = Math.max(44, c.plateSize.w), h = Math.max(44, c.plateSize.h), inset = (h - c.plateSize.h) / 2;
        let vx = (c.head.sx + this.origin.x) * zoom + x;
        const vy = (c.head.sy + this.origin.y) * zoom + y;
        const bubble = c.plate.matches(':focus-visible, [aria-current="true"]') ? c.bubbleHeight ?? 0 : 0;
        const bh = Math.max(0, bubble - inset, c.plate.hasAttribute('data-talking') ? 22 - inset : 0);
        if (id === this.selected) vx = Math.max(w / 2 + 2, Math.min(width - w / 2 - 2, vx));
        const left = vx - w / 2, right = vx + w / 2;
        // Shortlist names stay near the head; selected feedback may fit inside the viewport.
        const candidates = [vy - 6 - h + inset, vy + 6 + inset + bh];
        if (id === this.selected) candidates.push(...candidates.map(top => Math.max(bh + 2, Math.min(height - h - 2, top))), ...placed.map(p => p.bottom + bh + 2));
        const top = candidates.find(top =>
          left >= 2 && right <= width - 2 && top - bh >= 2 && top + h <= height - 2 &&
          !placed.some(p => left < p.right + 2 && right > p.left - 2 && top - bh < p.bottom + 2 && top + h > p.top - 2))
          ?? (id === this.selected ? Math.max(2, Math.min(height - h - 2, vy - 6 - h + inset)) : undefined);
        if (top === undefined) { this._showPlate(c,false); continue; }
        this._showPlate(c,true);
        placed.push({ left, right, top: top - bh, bottom: top + h });
        c.plate.style.transform = `translate(${Math.round(vx)}px, ${Math.round(top + inset)}px) translateX(-50%)`;
      }
      return;
    }
    // Resolve label overlaps toward the camera first; read sizes before writing positions.
    const items = [];
    for (const c of this.chars.values()) {
      if (!c.head || c.leaving) continue;
      c.plateSize ??= { w: c.plate.offsetWidth, h: c.plate.offsetHeight };   // reset when the plate changes
      // a speaker's « … » bubble sits above their plate: it counts as part of it
      // Reserve the nameplate's 44px pseudo-element hit area as well as its visible pill.
      const h = Math.max(44, c.plateSize.h), inset = (h - c.plateSize.h) / 2;
      const bubble = !this.stage.hasAttribute('data-plates-primary') || c.plate.matches(':focus-visible, [aria-current="true"]') ? c.bubbleHeight ?? 0 : 0;
      items.push({ c, vx: (c.head.sx + this.origin.x) * zoom + x, vy: (c.head.sy + this.origin.y) * zoom + y,
        w: Math.max(44, c.plateSize.w), h, inset, bh: Math.max(0, bubble - inset, c.plate.hasAttribute('data-talking') ? 22 - inset : 0) });
    }
    items.sort((a, b) => b.vy - a.vy);
    const viewport = this.viewport.getBoundingClientRect();
    const placed = [...(this.stage.parentElement?.querySelectorAll('.bu-stage__controls, .ao-mobile-options') ?? [])]
      .map(node => node.getBoundingClientRect()).filter(rect => rect.width && rect.height)
      .map(rect => ({ vx: rect.left - viewport.left + rect.width / 2, top: rect.top - viewport.top, w: rect.width, h: rect.height, bh: 0 }));
    placed.push(...(this._positionSleep?.(this,placed)??[]).map(b=>({vx:(b.left+b.right)/2,top:b.top,w:b.right-b.left,h:b.bottom-b.top,bh:0})));
    for (const it of items) {
      it.vx = Math.max(it.w / 2 + 2, Math.min(width - it.w / 2 - 2, it.vx));
      const min = it.bh + 2, max = Math.max(min, height - it.h - 2);
      const preferred = Math.max(min, Math.min(max, it.vy - 6 - it.h + it.inset));
      const edges = [it.w / 2 + 2, width - it.w / 2 - 2];
      const columns = [it.vx, ...edges];
      const positions = columns.flatMap(vx => {
        const intervals = placed.filter(p => Math.abs(vx - p.vx) < (it.w + p.w) / 2 + 2)
          .map(p => ({ lo: p.top - p.bh - it.h - 2, hi: p.top + p.h + it.bh + 2 })).sort((a,b) => a.lo - b.lo);
        const gaps = [];
        let low = min;
        const gap = high => {
          if (low > high) return;
          const top = Math.max(low, Math.min(high, preferred));
          gaps.push({ vx, top, score: Math.abs(vx - it.vx) + Math.abs(top - preferred) });
        };
        for (const interval of intervals) {
          if (interval.hi <= low) continue;
          if (interval.lo > max) break;
          gap(Math.min(max, interval.lo));
          low = Math.max(low, interval.hi);
          if (low > max) break;
        }
        gap(max);
        return gaps;
      }).sort((a, b) => a.score - b.score || a.top - b.top);
      const chosen = positions[0] ?? { vx: it.vx, top: preferred };
      it.vx = chosen.vx;
      const top = chosen.top;
      placed.push({ vx: it.vx, top, w: it.w, h: it.h, bh: it.bh });
      it.c.plate.style.transform = `translate(${Math.round(it.vx)}px, ${Math.round(top + it.inset)}px) translateX(-50%)`;
    }
  }

  // ---------- camera: fit, zoom, pan ----------
  fit() {
    const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
    if (!vw || !vh || !this.bounds) return;
    const z = Math.min(vw / this.bounds.width, vh / this.bounds.height) * 0.98;
    this.minZoom = Math.min(ZOOM_MIN, z);
    this.cam.zoom = Math.min(ZOOM_MAX, z);
    this.cam.x = (vw - this.bounds.width * this.cam.zoom) / 2;
    this.cam.y = (vh - this.bounds.height * this.cam.zoom) / 2;
    this._applyCamera();
  }

  zoomBy(f, cx = this.viewport.clientWidth / 2, cy = this.viewport.clientHeight / 2) {
    const z0 = this.cam.zoom;
    const z = Math.max(this.minZoom ?? ZOOM_MIN, Math.min(ZOOM_MAX, z0 * f));
    this.cam.x = cx - ((cx - this.cam.x) * z) / z0;
    this.cam.y = cy - ((cy - this.cam.y) * z) / z0;
    this.cam.zoom = z;
    this.cam.user = true;
    this._applyCamera();
  }

  panBy(dx, dy) {
    this.cam.x += dx;
    this.cam.y += dy;
    this.cam.user = true;
    this._applyCamera();
  }

  _applyCamera() {
    const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
    const w = this.bounds.width * this.cam.zoom, h = this.bounds.height * this.cam.zoom;
    // Keep at least a third of the room on screen.
    const mx = Math.min(w, vw) / 3, my = Math.min(h, vh) / 3;
    this.cam.x = Math.min(vw - mx, Math.max(mx - w, this.cam.x));
    this.cam.y = Math.min(vh - my, Math.max(my - h, this.cam.y));
    this.world.style.transform = `translate(${this.cam.x}px, ${this.cam.y}px) scale(${this.cam.zoom})`;
    // Crowded rooms keep full accessible names; focus and selection reveal them.
    const crowded = this.chars.size > 8 && w < 600;
    if (crowded !== this.stage.hasAttribute('data-plates-compact')) {
      this.stage.toggleAttribute('data-plates-compact', crowded);
      for (const c of this.chars.values()) c.plateSize = null;
    }
    this._positionLabels();
    for (const fn of this._camListeners ?? []) fn();
  }

  /** O9: the occupant whose figure is under a viewport point (topmost first), or null. Tap and click both use it. */
  _occupantAt(x, y) {
    let best = null, bestZ = -Infinity;
    for (const [id, c] of this.chars) {
      if (!c.occ || c.leaving) continue;
      const r = (c.poseEl ?? c.el).getBoundingClientRect();
      if (!r.width || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const z = Number(getComputedStyle(c.el).zIndex) || 0;
      if (z >= bestZ) { best = id; bestZ = z; }
    }
    return best;
  }

  _bindCamera() {
    const vp = this.viewport;
    // O9, no scroll trap: the wheel scrolls the page; Ctrl/⌘ + wheel (and a trackpad pinch, which sends ctrlKey) zooms.
    this._listen(vp, 'wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey && !this.editing) return;
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    // One finger scrolls, two pan/pinch; mouse drags the camera.
    this._listen(vp, 'touchmove', (e) => { if (e.touches.length >= 2 || this.editing) e.preventDefault(); }, { passive: false });
    const pts = new Map();
    let pinch = null, mid = null, tap = null;
    const midOf = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
    this._listen(vp, 'pointerdown', (e) => {
      if (e.target.closest('button')) return;
      if (this.pointerHandler && this.pointerHandler(e)) return;
      tap = pts.size === 0 ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() } : null;
      if (e.pointerType === 'touch' && !this.editing) {
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size === 2) { const m = midOf(); mid = m; pinch = m.d; vp.classList.add('is-panning'); }
        return;
      }
      vp.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      vp.classList.add('is-panning');
    });
    this._listen(vp, 'pointermove', (e) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      pts.set(e.pointerId, cur);
      if (tap && Math.hypot(cur.x - tap.x, cur.y - tap.y) > 8) tap = null;
      const r = vp.getBoundingClientRect();
      if (pts.size === 2) {
        const m = midOf();
        if (mid) this.panBy(m.x - mid.x, m.y - mid.y);
        if (pinch) this.zoomBy(m.d / pinch, m.x - r.left, m.y - r.top);
        mid = m; pinch = m.d;
      } else if (e.pointerType !== 'touch' || this.editing) this.panBy(cur.x - prev.x, cur.y - prev.y);
    });
    const end = (e) => {
      const wasTap = tap && tap.id === e.pointerId && e.type === 'pointerup' && performance.now() - tap.t < 500 && pts.size <= 1;
      pts.delete(e.pointerId);
      if (pts.size < 2) { pinch = null; mid = null; }
      if (!pts.size) vp.classList.remove('is-panning');
      if (wasTap && !this.editing) { const id = this._occupantAt(e.clientX, e.clientY); if (id) this.select(id, true); }
      tap = null;
    };
    this._listen(vp, 'pointerup', end);
    this._listen(vp, 'pointercancel', end);
    this._listen(vp, 'keydown', (e) => {
      if (e.target !== vp) return;
      const s = e.shiftKey ? 120 : 40;
      const k = { ArrowLeft: [s, 0], ArrowRight: [-s, 0], ArrowUp: [0, s], ArrowDown: [0, -s] }[e.key];
      if (k) { e.preventDefault(); this.panBy(...k); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomBy(1.2); }
      else if (e.key === '-') { e.preventDefault(); this.zoomBy(1 / 1.2); }
      else if (e.key === '0') { e.preventDefault(); this.cam.user = false; this.fit(); }
    });
  }

  // ---------- editor hooks (design/office/editor.md; the editor UI lives in editor.js) ----------

  /** Editing: occupants teleport instead of walking; the stage gets [data-editing]. */
  setEditing(on) {
    if (on) for (const c of this.chars.values()) { this._cancelEgg(c,{immediate:true}); this._cancelActivity(c); }
    this.editing = !!on;
    this.stage.toggleAttribute('data-editing', this.editing);
    if (!on) { this.hideGhost(); this.markItems({}); }
    if (this._visitPlan) this._applyVisits();   // visits pause while editing (everyone at their place)
  }

  /** fn(pointerEvent) → true to take the gesture (no camera pan). null restores panning. */
  setPointerHandler(fn) { this.pointerHandler = fn; }

  onCamera(fn) {
    (this._camListeners ??= new Set()).add(fn);
    return () => this._camListeners.delete(fn);
  }

  /** Client (page) px → fractional grid point. */
  clientToGrid(clientX, clientY) {
    const r = this.viewport.getBoundingClientRect();
    const wx = (clientX - r.left - this.cam.x) / this.cam.zoom - this.origin.x;
    const wy = (clientY - r.top - this.cam.y) / this.cam.zoom - this.origin.y;
    const a = wx / (this.proj.tileWidth / 2), b = wy / (this.proj.tileHeight / 2);
    return { x: (a + b) / 2, y: (b - a) / 2, wx, wy };
  }

  /** World px → viewport px (for overlays that must not scale, e.g. the item toolbar). */
  worldToViewport(sx, sy) {
    return { x: (sx + this.origin.x) * this.cam.zoom + this.cam.x, y: (sy + this.origin.y) * this.cam.zoom + this.cam.y };
  }

  gridToViewport(x, y) {
    const p = project(x, y, this.proj);
    return this.worldToViewport(p.sx, p.sy);
  }

  /** Top-centre of an item's sprite in viewport px (toolbar anchor). */
  itemTopViewport(uid) {
    const n = this.itemNodes.get(uid);
    const img = n?.parts[n.f.id];
    if (!img) return null;
    const left = parseFloat(img.style.left), top = parseFloat(img.style.top), w = parseFloat(img.style.width);
    return this.worldToViewport(left + w / 2, top);
  }

  /** Item under a client point: wall sprites first (they sit above the floor), then floor footprints, then decals. */
  itemAtClient(clientX, clientY, collision) {
    for (const node of document.elementsFromPoint(clientX, clientY)) {
      if (node.dataset?.item && node.closest('.ao-layer--wall')) return node.dataset.item;
    }
    const g = this.clientToGrid(clientX, clientY);
    const t = { x: Math.floor(g.x), y: Math.floor(g.y) };
    let decal = null;
    for (const [uid, n] of this.itemNodes) {
      if (n.it.wall != null) continue;
      const tiles = collision(n.it, n.f);
      if (tiles.some((p) => p.x === t.x && p.y === t.y)) {
        if (n.f.placement === 'decal') decal ??= uid; else return uid;
      }
    }
    return decal;
  }

  _diamond(t, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const poly = document.createElementNS(ns, 'polygon');
    const pts = [[t.x, t.y], [t.x + 1, t.y], [t.x + 1, t.y + 1], [t.x, t.y + 1]].map(([x, y]) => project(x, y, this.proj)).map((p) => `${p.sx},${p.sy}`).join(' ');
    poly.setAttribute('points', pts);
    poly.setAttribute('class', cls);
    return poly;
  }

  _overlaySvg(name) {
    let svg = this[name];
    if (!svg) {
      svg = this[name] = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', `ao-edit-svg ${name}`);
      svg.setAttribute('overflow', 'visible');
      this.layers.fx.prepend(svg);
    }
    return svg;
  }

  /** Placement preview: ghost={asset,x,y,orientation} or {asset,wall,offset}; footprint reflects validity. */
  showGhost(ghost, ok, tiles) {
    if (!this.editing) { this.hideGhost(); return; }
    const svg = this._overlaySvg('_ghostSvg');
    // Invalid = danger fill + diagonal hatch + dashed edge: never colour alone (editor.md §6).
    svg.replaceChildren(...tiles.flatMap((t) => (ok ? [this._diamond(t, 'ghost ok')] : [this._diamond(t, 'ghost bad'), this._diamond(t, 'ghost hatch')])));
    svg.dataset.ok = String(ok);
    const f = this.index.furniture.get(ghost.asset);
    if (!this._ghostImg) {
      this._ghostImg = el('img', 'ao-sprite ao-ghost-img', { alt: '', draggable: 'false' });
      this.layers.fx.append(this._ghostImg);
    }
    const img = this._ghostImg;
    let box;
    if (ghost.wall != null) {
      const p = wallPoint(ghost.wall, ghost.offset, f.wall?.length ?? 1, f.wall?.elevation ?? 0, this.proj);
      box = imageBox(p.sx, p.sy, f.anchor, f.size, this.proj);
    } else {
      const p = project(ghost.x, ghost.y, this.proj);
      box = imageBox(p.sx, p.sy, f.anchor, f.size, this.proj);
    }
    setSrc(img, resolveUrl(furnitureImage(f, ghost.orientation ?? 'sw'), this.assetBase));
    place(img, box);
    img.classList.toggle('is-bad', !ok);
    img.hidden = false;
  }

  hideGhost() {
    this._ghostSvg?.replaceChildren();
    if (this._ghostImg) this._ghostImg.hidden = true;
  }

  /** Editor rings: selected item (accent floor outline + lifted sprite) and a highlighted station (hover/focus). */
  markItems({ selected = null, highlight = null, tilesOf = null } = {}) {
    if (!this.editing) selected = highlight = null;
    const svg = this._overlaySvg('_markSvg');
    const polys = [];
    for (const n of this.itemNodes.values()) for (const img of Object.values(n.parts)) img.classList.remove('ao-selected', 'ao-highlight');
    for (const [uid, cls] of [[highlight, 'mark hl'], [selected, 'mark sel']]) {
      const n = uid && this.itemNodes.get(uid);
      if (!n) continue;
      for (const img of Object.values(n.parts)) img.classList.add(cls.includes('sel') ? 'ao-selected' : 'ao-highlight');
      if (tilesOf && n.it.wall == null) for (const t of tilesOf(n.it, n.f)) polys.push(this._diamond(t, cls));
    }
    svg.replaceChildren(...polys);
  }

  // ---------- full screen (office-dev-20) ----------
  /** True while this stage is shown full screen (native or the overlay fallback). */
  get fullscreen() {
    const d = typeof document !== 'undefined' ? document : null;
    return !!d && ((d.fullscreenElement ?? d.webkitFullscreenElement) === this.stage || this.stage.hasAttribute('data-fake-fullscreen'));
  }
  /** The Fullscreen API on this stage, when the browser has it (Android Chrome, desktop); null on iOS Safari. */
  _fsApi() {
    const s = this.stage, d = document;
    const req = s.requestFullscreen ?? s.webkitRequestFullscreen;
    const exit = d.exitFullscreen ?? d.webkitExitFullscreen;
    return req && exit && (d.fullscreenEnabled ?? d.webkitFullscreenEnabled ?? true) ? { req: () => req.call(s), exit: () => exit.call(d) } : null;
  }
  async toggleFullscreen(on = !this.fullscreen) {
    if (on === this.fullscreen) return;
    const api = this.forceFakeFullscreen ? null : this._fsApi();
    if (on) {
      if (api) { try { await api.req(); return; } catch { /* refused (no user gesture, policy): use the overlay */ } }
      this._fakeFullscreen(true);
    } else if (this.stage.hasAttribute('data-fake-fullscreen')) {
      this._fakeFullscreen(false);
    } else if (api) {
      try { await api.exit(); } catch { /* already left */ }
    }
  }
  /** Fallback: a fixed overlay over the viewport; Back leaves it (a history entry), Esc too. */
  _fakeFullscreen(on) {
    if (on) {
      this.stage.setAttribute('data-fake-fullscreen', '');
      document.documentElement.classList.add('ao-fs-lock');
      try { history.pushState({ aoFullscreen: true }, ''); this._fsHistory = true; } catch { this._fsHistory = false; }
      this._onFsPop = () => { this._fsHistory = false; this._fakeFullscreen(false); };
      this._onFsKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); this._fakeFullscreen(false); } };
      this._listen(window, 'popstate', this._onFsPop);
      this._listen(document, 'keydown', this._onFsKey);
    } else {
      if (!this.stage.hasAttribute('data-fake-fullscreen')) return;
      this.stage.removeAttribute('data-fake-fullscreen');
      document.documentElement.classList.remove('ao-fs-lock');
      removeEventListener('popstate', this._onFsPop);
      document.removeEventListener('keydown', this._onFsKey);
      if (this._fsHistory) { this._fsHistory = false; try { history.back(); } catch { /* ignore */ } }
    }
    this._syncFullscreen();
  }
  /** Button label, icon and aria-pressed; the scene re-fits to its new size (enter, leave, rotate). */
  _syncFullscreen() {
    const on = this.fullscreen;
    this.stage.toggleAttribute('data-fullscreen', on);
    if (this.fsButton) {
      const label = tr(on ? 'scene.exitFullscreen' : 'scene.fullscreen');
      this.fsButton.setAttribute('aria-label', label);
      this.fsButton.title = label;
      this.fsButton.setAttribute('aria-pressed', String(on));
      this.fsButton.innerHTML = this._fsIcon[on ? 'exit' : 'enter'];
    }
    const was = this._fsWas;
    this._fsWas = on;
    if (was !== undefined && on !== was) {
      this.cam.user = false;
      requestAnimationFrame(() => { if (!this.destroyed) this.fit(); });
    }
  }

  /** Add a page-level button to the stage controls (e.g. « Personnaliser »). Returns the button. */
  addControl({ label, icon, onClick, text = false }) {
    const b = el('button', `bu-btn bu-btn--sm${text ? '' : ' bu-btn--icon'}`, { type: 'button', 'aria-label': label, title: label });
    // icon is page-supplied SVG path markup (fixed constants); the label is always text.
    b.innerHTML = `<svg class="bu-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>`;
    if (text) { const span = document.createElement('span'); span.className = 'ao-ctl-text'; span.textContent = label; b.append(span); }
    // a page action (the editor) renders outside the stage: leave full screen first, then act
    this._listen(b, 'click', async (e) => { if (this.fullscreen) await this.toggleFullscreen(false); onClick(e); });
    b.dataset.pageControl = '';   // page actions hide while the editor is open (office.css)
    this.controls.append(b);
    return b;
  }

  /** Deprecated single-layer accessory overlays as a fallback until contract-v2 layers exist (default on). */
  setLegacyAccessories(on) {
    this.legacyAccessories = !!on;
    for (const c of this.chars.values()) { c.poseKey = null; this._renderPose(c); }
  }

  /** Demo/QA: draw each pose's head landmarks (head box, ears, eye line, neck, chest) over the characters. */
  setDebugLandmarks(on) {
    this.debugLandmarks = !!on;
    for (const c of this.chars.values()) this._renderPose(c);
  }

  destroy() {
    if (this.destroyed) return;
    this._events.abort();
    this._decorLoad?.abort();
    this._packLoad?.abort(); this._packSignals?.clear();
    for(const c of this.chars?.values() ?? []) this._cancelEgg(c,{dispose:true});
    window.removeEventListener('office-surprises-setting',this._onSurpriseSetting);
    this.destroyed = true;
    if (this.stage.aoScene === this) delete this.stage.aoScene;
    clearTimeout(this._announceTimer);
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    clearInterval(this._themeTimer);
    this._lifeTimer?.();
    this._ro?.disconnect();
    if (this._onMq) this._mq?.removeEventListener('change', this._onMq);
    document.removeEventListener('visibilitychange', this._onVis);
    document.removeEventListener('fullscreenchange', this._onFsChange);
    document.removeEventListener('webkitfullscreenchange', this._onFsChange);
    window.removeEventListener('pagehide', this._onPageHide);
    window.removeEventListener('pageshow', this._onPageShow);
    document.removeEventListener('freeze', this._onFreeze);
    document.removeEventListener('resume', this._onResume);
    if (this.stage.hasAttribute('data-fake-fullscreen')) this._fakeFullscreen(false);
    else if ((document.fullscreenElement ?? document.webkitFullscreenElement) === this.stage) this._fsApi()?.exit().catch?.(() => {});
    this._io?.disconnect();
    this._imgKeep?.clear();
    for (const c of this._allChars ?? []) { releaseWander(c); c.dead = true; this._cancelAll(c); }
    this._allChars?.clear();
    this.chars?.clear();
    this._camListeners?.clear();
    this.pointerHandler = null;
    this.stage.replaceChildren();
    this.stage.classList.remove('ao-office');
  }
}
