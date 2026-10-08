// Illustrated office scene: layered DOM renderer (design/office/README.md).
// Plain DOM so it can be mounted from Preact (ref) or a bare page. It only animates what it is told:
// occupants come from OfficeVM.occupants, cues from SSE 'cue' frames.
import { project, imageBox, wallPoint, footprintFor, itemDepth, characterDepth, sortScene } from './geometry.js';
import { buildGrid, findPath, nearestWalkable } from './pathfind.js';
import {
  STATE_LABELS, viewFor, CUES, WALK_TILES_PER_S, CROSSFADE_MS, LOUNGE_AFTER_MS,
  SEATED_VIEW, SEATED_CUES, SOFA_VIEW, SWIVEL_MS, SELECT_WAVE_MS, IDLE_SWIVEL_EVERY_MS, IDLE_SWIVEL_HOLD_MS,
} from './states.js';
import { resolveTheme } from './theme.js';
import { s as tr, labelOf, intlLocale } from './strings.js';
import {
  indexManifest, resolveUrl, furnitureImage, partImage, poseImage, accessoryLayers, landmarksFor, headTopY, renderScale, themeFor, roomImage,
  seatModeFor, isBackPose, deskPoseImage,
} from './assets.js';
import { markerHtml } from './markers.js';
import { displayName } from './names.js';

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

/** SVG overlay of head landmarks on the pose canvas (image px). Missing landmarks draw a "no data" tag. */
function landmarkSvg(ch, lm) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'ao-landmarks');
  svg.setAttribute('viewBox', `0 0 ${ch.canvas.w} ${ch.canvas.h}`);
  const add = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.append(n);
    return n;
  };
  add('circle', { cx: ch.anchor.x, cy: ch.anchor.y, r: 3, class: 'lm-anchor' });
  if (!lm) {
    add('text', { x: 4, y: 12, class: 'lm-none' }).textContent = tr('scene.noLandmarks');
    return svg;
  }
  const pt = (p, cls) => p && add('circle', { cx: p.x, cy: p.y, r: 3.5, class: cls });
  if (lm.headBox) add('rect', { x: lm.headBox.x, y: lm.headBox.y, width: lm.headBox.w, height: lm.headBox.h, class: 'lm-box', transform: lm.tilt && lm.headCentre ? `rotate(${lm.tilt} ${lm.headCentre.x} ${lm.headCentre.y})` : '' });
  if (lm.eyeLine) add('line', { x1: lm.eyeLine.a.x, y1: lm.eyeLine.a.y, x2: lm.eyeLine.b.x, y2: lm.eyeLine.b.y, class: 'lm-eyes' });
  pt(lm.headCentre, 'lm-centre'); pt(lm.earLeft, 'lm-ear'); pt(lm.earRight, 'lm-ear'); pt(lm.neck, 'lm-neck'); pt(lm.chest, 'lm-chest');
  return svg;
}

export class OfficeScene {
  /**
   * @param {HTMLElement} stage  container (gets class ao-office; give it a size)
   * @param {object} opts
   * @param {object} opts.manifest        manifest (design/office/manifest.schema.json)
   * @param {object} opts.layout          layout data (layout.schema.json)
   * @param {string} opts.assetBase       URL prefix for manifest paths (config.assetBase, e.g. "/bureau/")
   * @param {string|(() => string)} [opts.timeZone]  instance IANA zone for « Automatique » (fmt.timeZone())
   * @param {Record<string,string>} [opts.labels]  state labels (MetaVM.labels agentState.*), defaults to strings.js (UI language)
   * @param {'auto'|'day'|'night'} [opts.theme]
   * @param {() => number} [opts.now]
   * @param {(id: string) => void} [opts.onSelect]
   */
  constructor(stage, opts) {
    this.stage = stage;
    this.opts = opts;
    this.assetBase = opts.assetBase;
    this.labels = { ...Object.fromEntries(Object.keys(STATE_LABELS).map((k) => [k, tr(`state.${k}`)])), ...(opts.labels ?? {}) };
    this.now = opts.now ?? (() => Date.now());
    this.onSelect = opts.onSelect ?? null;
    this.index = indexManifest(opts.manifest);
    this.proj = this.index.proj;
    this.chars = new Map();
    this.selected = null;
    this.cam = { zoom: 1, x: 0, y: 0, user: false };
    this.themeMode = opts.theme ?? 'auto';
    this.forcedReduced = null;
    // v1 overlays are a fallback until Batch 5b is complete (manifest.accessoriesV2.complete), then off by default.
    this.legacyAccessories = opts.legacyAccessories ?? !opts.manifest.accessoriesV2?.complete;
    this._mq = matchMedia('(prefers-reduced-motion: reduce)');
    this._raf = 0;
    this._last = 0;
    this._sortDirty = true;
    this._build();
    this.setLayout(opts.layout);
    this._themeTimer = setInterval(() => { this._applyTheme(); this._checkLounge(); }, 30_000);
    this._ro = new ResizeObserver(() => { if (!this.cam.user) this.fit(); else this._applyCamera(); });
    this._ro.observe(this.viewport);
    this._onMq = () => this._syncReduced();
    this._mq.addEventListener('change', this._onMq);
    // Hidden tab: no frame loops, idle swivels or CSS animations (O4); resume on return.
    this._onVis = () => this._syncHidden();
    document.addEventListener('visibilitychange', this._onVis);
    this._onFsChange = () => this._syncFullscreen();
    document.addEventListener('fullscreenchange', this._onFsChange);
    document.addEventListener('webkitfullscreenchange', this._onFsChange);
    // O9: a stage scrolled out of view (an annex below the fold) pauses the same way, so 30 agents cost what is seen.
    this._offscreen = false;
    this._io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => {
      const off = !es[es.length - 1].isIntersecting;
      if (off !== this._offscreen) { this._offscreen = off; this._syncHidden(); }
    }, { rootMargin: '200px 0px' }) : null;
    this._io?.observe(this.stage);
    this._syncReduced();
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
    const id = requestAnimationFrame(() => { c.rafs.delete(id); if (this._alive(c)) fn(); });
    c.rafs.add(id);
  }

  _cancelAll(c) {
    for (const id of c.timers) clearTimeout(id);
    for (const id of c.intervals) clearInterval(id);
    for (const id of c.rafs) cancelAnimationFrame(id);
    c.timers.clear(); c.intervals.clear(); c.rafs.clear();
  }

  // ---------- image keep-alive and prefetch (O4) ----------
  /**
   * Keep one decoded Image per URL the scene has used (bounded LRU). While referenced, the URL stays in
   * the document's list of available images, so a new <img> with it is served without a network
   * revalidation (Express serves images with max-age=0).
   */
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

  /** R27-02: freeze the scene while what it shows is not confirmed live (the stream is down): like a hidden tab. */
  setFrozen(on) {
    if (!!on === !!this._frozen) return;
    this._frozen = !!on;
    this.stage.toggleAttribute('data-frozen', this._frozen);
    this._syncHidden();
  }

  get hidden() { return this._frozen || this._offscreen || (typeof document !== 'undefined' && document.visibilityState === 'hidden'); }

  _syncHidden() {
    const h = this.hidden;
    this.stage.toggleAttribute('data-paused', h);
    for (const c of this.chars.values()) {
      if (h) {
        for (const g of new Set([c.displayed, c.poseEl])) {
          if (!g?._frameTimer) continue;
          clearInterval(g._frameTimer); c.intervals.delete(g._frameTimer); g._frameTimer = null;
        }
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
    // README §4.3, live: walkers snap to their destination, motion cues end, idle swivels stop,
    // frame loops fall back to their first frame.
    for (const c of this.chars.values()) {
      // R7-09 / R4-14: stop every typing loop now (mounted and pending groups) and hold frame 0,
      // independently of any image still decoding.
      for (const g of new Set([c.displayed, c.poseEl])) {
        if (!g) continue;
        clearInterval(g._frameTimer);
        c.intervals.delete(g._frameTimer);
        g._frameTimer = null;
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
      b.addEventListener('click', fn);
      controls.append(b);
      return b;
    };
    const svg = (d) => `<svg class="bu-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    btn(tr('scene.zoomIn'), svg('<path d="M5 12h14"/><path d="M12 5v14"/>'), () => this.zoomBy(1.2));
    btn(tr('scene.zoomOut'), svg('<path d="M5 12h14"/>'), () => this.zoomBy(1 / 1.2));
    // Fit (recentre after a pan or zoom; also the 0 key): a crosshair, so it isn't mistaken for full screen.
    btn(tr('scene.fit'), svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/>'), () => { this.cam.user = false; this.fit(); }).dataset.ctl = 'fit';
    // office-dev-20: real full screen for this stage (the ⛶ icon promised it). Native Fullscreen API where it exists,
    // else (iOS Safari) a fixed overlay over the whole viewport. The same button, Esc and Back leave it.
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
    // Season (layout.theme.season, O4 scaffold): layered on the resolved day/night theme. Its furniture
    // variants are tried first; its extras are decor drawn on top of the layout (no collision).
    const season = this.layout.theme?.season ? this.index.themes.get(this.layout.theme.season) : null;
    const seasonOk = season?.kind === 'season' ? season : null;
    this.stage.dataset.officeSeason = seasonOk?.id ?? '';
    const variants = [...(seasonOk?.furnitureVariants ?? []), ...(theme.furnitureVariants ?? [])];
    this._applySeasonExtras(seasonOk);
    for (const node of this.itemNodes.values()) {
      const img = node.parts[node.f.id];
      setSrc(img, resolveUrl(furnitureImage(node.f, node.it.orientation ?? 'sw', variants), this.assetBase));
    }
    if (changed) for (const uid of this.itemNodes.keys()) this._updateStation(uid);
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
  /**
   * @param {Array<{id:string, role:string, name:string, state:string, stateSince:number, stationUid:string,
   *   look:{character:string, variant:string|null, accessories:string[]}}>} occupants  roster order
   */
  setOccupants(occupants) {
    const ids = new Set(occupants.map((o) => o.id));
    const first = this.chars.size === 0 && !this._seeded;
    this._seeded = true;
    for (const c of this.chars.values()) if (!ids.has(c.id) && !c.leaving) this._leave(c);
    occupants.forEach((o, i) => {
      let c = this.chars.get(o.id);
      if (c && c.leaving) { this._destroyChar(c); c = null; }
      const isNew = !c;
      if (!c) c = this._spawn(o, !first);
      const prevState = c.occ?.state;
      const prevLook = JSON.stringify(c.occ?.look);
      const prevPresence = c.occ?.presence ?? null;
      c.occ = o;
      c.order = i;
      if (prevLook !== JSON.stringify(o.look)) this._prefetchLook(o.look);
      if (prevState !== o.state && c.cue) this._endCue(c, false);
      if (prevState && prevState !== o.state && o.state === 'error') this._shake(c);
      if (prevState !== o.state && prevState) this._announce(c);
      else if (isNew && !first) this._announce(c, 'enter');
      this._retarget(c, false);
      if (prevState !== o.state || prevLook !== JSON.stringify(o.look) || prevPresence !== (o.presence ?? null)) this._renderPose(c);
      this._renderPlate(c);
    });
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
    c.plate.addEventListener('click', () => this.select(c.id, true));
    c.plate.addEventListener('focus', () => this._plateFocus(c, true));
    c.plate.addEventListener('blur', () => this._plateFocus(c, false));
    this.layers.scene.append(c.el);
    this.layers.fx.append(c.ring, c.marker);
    this.chars.set(o.id, c);
    if (walkIn && this.room.entrance) {
      const e = nearestWalkable(this.grid, this.room.entrance.x, this.room.entrance.y) ?? this.room.entrance;
      c.pos = { x: e.x + 0.5, y: e.y + 0.5 };
      c.el.classList.add('ao-enter');
      this._nextFrame(c, () => c.el.classList.remove('ao-enter'));
    }
    return c;
  }

  _leave(c) {
    if (c.meet) this._endMeeting(c.meet.meeting);
    if (c.occ) this._announce(c, 'leave');
    c.leaving = true;
    c.plate.remove();
    c.marker.hidden = true;
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
    if (c.meet) this._endMeeting(c.meet.meeting);
    c.dead = true;
    this._cancelAll(c);
    this._allChars?.delete(c);
    c.el.remove(); c.plate.remove(); c.marker.remove(); c.ring.remove();
    // Only the current instance owns the id: a replacement with the same id keeps its selection (R4-13).
    if (this.chars.get(c.id) === c) {
      this.chars.delete(c.id);
      if (this.selected === c.id) this.selected = null;
    }
    this._sortDirty = true;
  }

  /** Where this occupant should be: own station, or a free lounge after 10 min idle (README §4.2). */
  _targetFor(c) {
    const o = c.occ;
    // Meeting scene (decorative, client-side; cue partnerId): stand at the assigned meeting spot.
    if (c.meet) return { x: c.meet.x, y: c.meet.y, uid: `meet:${c.meet.id}`, mode: 'stand' };
    // office-dev-22 visits: a person at the agent's desk, or everyone at the meeting table (setVisits).
    if (c.visit) return { x: c.visit.x, y: c.visit.y, uid: `visit:${c.visit.key}`, mode: 'stand' };
    let uid = o.stationUid;
    // Server-authoritative destination (OccupantVM.destination, api.md 2.1 §3.2): e.g. the server rack
    // while an exec-class tool runs. It wins over the decorative lounge rule; home again when it clears.
    const dest = o.destination?.stationUid;
    if (dest && this.itemNodes.get(dest)?.f.station) uid = dest;
    else if (!c.deskTalk && o.state === 'idle' && this.now() - (o.stateSince ?? 0) > LOUNGE_AFTER_MS) {
      const taken = new Set([...this.chars.values()].filter((x) => x !== c && !x.leaving).map((x) => x.target?.uid));
      for (const [u, n] of this.itemNodes) if (n.f.station?.kind === 'lounge' && !taken.has(u)) { uid = u; break; }
    }
    const node = this.itemNodes.get(uid);
    if (!node?.f.station) return this._standingSpot(c);
    const mode = seatModeFor(c.ch, o.look.variant, node.f.station);
    const seat = mode === 'stand' ? node.f.station.seat : node.f.station.seated.seat;
    return { x: node.it.x + seat.x, y: node.it.y + seat.y, uid, mode };
  }

  /**
   * Overflow (stationUid null, contract 2.0): stand on a free walkable tile near the entrance, one per
   * occupant, in roster order. Decorative placement, never an assignment.
   */
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
    if (c.leaving) return;
    const t = this._targetFor(c);
    const sameGen = c.targetGen === this.layoutGen;
    if (sameGen && c.target && c.target.uid === t.uid && c.target.x === t.x && c.target.y === t.y && c.pos) { this._scheduleIdleSwivel(c); return; }
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
    this._walkTo(c, t, () => this._arrive(c));
  }

  _walkTo(c, t, done) {
    const prevSeat = c.seatUid;
    c.seatUid = null;
    c.seatMode = null;
    c.walking = true;
    if (prevSeat) this._updateStation(prevSeat);
    const from = { x: Math.floor(c.pos.x), y: Math.floor(c.pos.y) };
    const to = { x: Math.floor(t.x), y: Math.floor(t.y) };
    const tiles = findPath(this.grid, from, to);
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
    if (c.walking) return { se: 'walking-se', sw: 'walking', ne: 'walking-ne', nw: 'walking-nw' }[c.facing] ?? 'walking';
    if (c.visit && !c.meet) return c.visit.talk === false ? (c.visit.facing === 'se' ? 'idle-se' : 'idle') : c.visit.facing === 'se' ? 'talking-se' : 'talking';
    if (c.meet && c.meet.phase !== 'go') {
      const se = c.meet.facing === 'se';
      return c.meet.phase === 'talk' ? (se ? 'talking-se' : 'talking') : (se ? 'idle-se' : 'idle');
    }
    const state = c.occ.state;
    if (c.seatMode === 'desk') {
      if (c.deskTalk) return 'seated-talking-sw';
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
    if (c.seatMode !== 'desk' || c.occ?.state !== 'idle' || this.reducedMotion || this.hidden || c.leaving) { if (c.idleTurn) { c.idleTurn = false; this._renderPose(c); } return; }
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
    if (c.seatUid) this._updateStation(c.seatUid);
    const station = this.itemNodes.get(c.seatUid);
    const composition = station?.composition;
    c.poseScale = renderScale(ch) * (c.seatMode === 'desk' ? (composition?.scaleByCharacter?.[ch.id] ?? 1) : 1);
    const acc = accessoryLayers(this.index, ch.id, c.occ.look.accessories, body.pose, c.occ.look.variant, { legacy: this.legacyAccessories });
    // Contract v2 draw order: accessory back layers → character → accessory front layers (slot order each).
    // Layers: [{path, frame}] — frame null = always shown; i = shown on body frame i (typing loop).
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
    this._positionChar(c);
    if (c.poseKey === key) return;
    c.poseKey = key;
    const k = c.poseScale / this.proj.artScale;
    const group = el('div', 'ao-pose');
    Object.assign(group.style, { width: `${body.canvas.w * k}px`, height: `${body.canvas.h * k}px` });
    if (c.seatMode === 'desk' && body.seatAnchor) group.style.transformOrigin = `${body.seatAnchor.x * k}px ${body.seatAnchor.y * k}px`;
    const imgs = layers.map((l) => {
      const img = el('img', '', { alt: '', draggable: 'false' });
      img.src = this._keep(resolveUrl(l.path, this.assetBase)).src;
      img.dataset.layer = l.role;
      if (l.frame != null) { img.dataset.frame = String(l.frame); img.hidden = l.frame !== 0; }
      return img;
    });
    group.append(...imgs);
    // Frame loops (working-ne typing): body and per-frame accessory layers swap together, in place, no
    // crossfade; frame 0 only under reduced motion.
    if (nFrames) {
      if (!this.reducedMotion && !this.hidden) {
        let i = 0;
        group._frameTimer = this._every(c, () => {
          i = (i + 1) % nFrames;
          for (const img of imgs) if (img.dataset.frame != null) img.hidden = Number(img.dataset.frame) !== i;
        }, body.frameMs);
      }
    }
    if (this.debugLandmarks) group.append(landmarkSvg(ch, landmarksFor(ch, c.occ.look.variant, body.pose)));
    // c.poseEl = the latest request; c.displayed = the group actually mounted (R4-12). A request that
    // is superseded before its images decode is dropped; the swap always fades out what is on screen.
    c.poseEl = group;
    const drop = (g) => { clearInterval(g._frameTimer); c.intervals.delete(g._frameTimer); g.remove(); };
    const swap = () => {
      if (!this._alive(c) || c.poseEl !== group) { drop(group); return; }
      const old = c.displayed;
      c.displayed = group;
      for (const n of [...c.el.children]) if (n !== old && n !== group && n.classList.contains('ao-pose')) drop(n);
      c.el.append(group);
      if (!old) { group.classList.add('is-in'); return; }
      this._nextFrame(c, () => {
        group.classList.add('is-in');
        old.classList.remove('is-in');
        this._later(c, () => { if (c.displayed !== old) drop(old); }, CROSSFADE_MS);
      });
    };
    Promise.all(imgs.map((i) => i.decode().catch(() => {}))).then(swap);
    this._positionChar(c);
  }

  _renderMarker(c) {
    const view = viewFor(c.occ.state);
    const kind = c.cue ? null : view.marker;
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

  // ---------- cues (SSE 'cue' frames) ----------
  /**
   * SSE cue frame (api.md 2.1 §4.4): cue(occupantId, cue, { partnerId, interactionId }).
   * A repeated interactionId is ignored. `delegating` with a partner plays the meeting scene.
   */
  cue(occupantId, cue, { partnerId = null, interactionId = null } = {}) {
    if (interactionId) {
      this._interactions ??= new Set();
      if (this._interactions.has(interactionId)) return;
      this._interactions.add(interactionId);
      if (this._interactions.size > 200) this._interactions.delete(this._interactions.values().next().value);
    }
    if (cue === 'delegating' && partnerId && !this.reducedMotion && this._meetingSeats()) {
      if (this.chars.get(partnerId)) this._startMeeting(occupantId, partnerId, interactionId);
      else this._pendingMeet = { aId: occupantId, bId: partnerId, interactionId, until: this.now() + 4000 };
      return;
    }
    const c = this.chars.get(occupantId);
    const def = CUES[cue];
    if (!c || !def || c.leaving) return;
    if (cue === 'celebrating' && this.reducedMotion) return;
    if (c.cue) this._endCue(c, false);
    c.cue = cue;
    c.cueTimer = this._later(c, () => this._endCue(c, true), def.ms);
    this._renderPose(c);
  }

  // ---------- visits (office-dev-22): the people the agent talks with come to him ----------
  /**
   * plan = { hostId, desk: [visitorId…], meeting: [id…], talking, speaker } (visits.js). Desk: the visitor stands in
   * front of the host's desk. A seated host swivels to talk from the chair; a look without seated art stands beside them.
   * Meeting: everyone around the meeting table (falls back to the desk
   * when the room has none). Only `speaker` shows the « … » bubble. When the exchange is over the host goes back to his
   * desk and the visitor stands idle where they are until the page drops them (they walk out).
   * Reduced motion: people snap to their spot (as every walk does).
   */
  setVisits(plan) {
    this._visitPlan = plan ?? null;
    this._applyVisits();
  }

  _applyVisits() {
    const plan = this._visitPlan;
    const want = new Map();
    let deskHost = null;
    if (plan && !this.editing) {
      const talking = plan.talking !== false;
      const host = this.chars.get(plan.hostId);
      const meeting = plan.meeting?.length ? this._tableSpots(plan.meeting.length) : null;
      if (meeting) plan.meeting.forEach((id, i) => { if (id !== plan.hostId || talking) want.set(id, { ...meeting[i], key: `t${i}` }); });
      const deskVisitors = meeting ? [] : [...(plan.desk ?? []), ...(plan.meeting ?? []).filter((id) => id !== plan.hostId)];
      const at = host ? this._homeOf(host) : null;
      if (deskVisitors.length && at) {
        // the host's talking spot in front of the desk; the visitor beside it on the same screen row, facing each other
        // (among the nearest free spots, the first with a free tile on its screen-left, else on its right)
        const near = this._spotsNear(at.x, at.y, 6);
        const pick = (side) => near.find((c) => this._besides(c, 1, [side]).length);
        const h = pick(-1) ?? pick(1) ?? near[0];
        const spots = h ? this._besides(h, deskVisitors.length) : [];
        spots.forEach((s, i) => want.set(deskVisitors[i], { ...s, key: `d${i}` }));
        const home = host && this.itemNodes.get(host.occ.stationUid);
        const canSit = home && seatModeFor(host.ch, host.occ.look.variant, home.f.station) === 'desk' && !host.occ.destination;
        if (talking && canSit) deskHost = host.id;
        else if (h && talking) {
          const v = spots[0];
          want.set(plan.hostId, { x: h.x, y: h.y, key: 'dh', facing: v && v.x - v.y < h.x - h.y ? 'sw' : 'se' });
        }
      }
      for (const [id, w] of want) { w.talk = talking; w.bubble = talking && plan.speaker === id; }
    }
    for (const c of this.chars.values()) {
      if (c.leaving || !c.occ) continue;
      const w = want.get(c.id) ?? null;
      const deskTalk = c.id === deskHost;
      const changedDeskTalk = !!c.deskTalk !== deskTalk;
      const deskBubble = deskTalk && plan?.speaker === c.id;
      const moved = (c.visit?.key ?? null) !== (w?.key ?? null) || c.visit?.x !== w?.x || c.visit?.y !== w?.y;
      if (!moved && c.visit?.talk === w?.talk && c.visit?.bubble === w?.bubble && c.visit?.facing === w?.facing && !!c.deskTalk === deskTalk && !!c.deskBubble === deskBubble) continue;
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

  /**
   * n free spots beside a standing spot on the same screen row ((x+k, y−k): same depth, side by side), nearest first,
   * each facing the spot; nearest free tiles when the row is blocked.
   */
  _besides(h, n, sides = null) {
    const hx = Math.floor(h.x), hy = Math.floor(h.y);
    const taken = new Set([...this.chars.values()].filter((c) => !c.leaving && c.target && !c.visit).map((c) => `${Math.floor(c.target.x)},${Math.floor(c.target.y)}`));
    taken.add(`${hx},${hy}`);
    const out = [];
    // screen-left first: the visitor faces SE, the host SW, the side with the drawn talking pose (talking-se is not
    // delivered yet; its fallback is the still SE walk, and sprites are never mirrored, README §4)
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
    // Candidates up to 3 tiles away; nearest first, and in front of the point (toward the camera, larger x + y) before
    // behind it, so a visitor stands where they can be seen rather than behind a desk.
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
    // Seated (Batch 6) or standing (v1) composition: chair part and stack follow the occupant's look;
    // an empty station shows the seated chair as soon as the manifest has seated art.
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
    if (seatPart && base?.parts?.[seatPart]?.seatAnchor) {
      const part = base.parts[seatPart], img = node.parts[`seated:${seatPart}`];
      node.seatWorld = { sx: parseFloat(img.style.left) + part.seatAnchor.x / this.proj.artScale, sy: parseFloat(img.style.top) + part.seatAnchor.y / this.proj.artScale };
    }
    const view = occ ? viewFor(occ.state) : null;
    let mon = view?.monitor ?? 'off';
    if (occ && this.theme?.monitors === 'on' && mon === 'off' && occ.state !== 'offline') mon = 'on';
    const monitor = node.parts.monitor;
    if (monitor) {
      setSrc(monitor, resolveUrl(partImage(node.f.station.parts.monitor, mon === 'off' ? null : 'on'), this.assetBase));
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
    const label = o.presenceLabel ?? this.labels[o.state] ?? o.state;
    const shown = this._name(o);
    c.plate.setAttribute('aria-label', `${shown}, ${label}`);
    c.plate.dataset.state = o.state;
    c.plate.toggleAttribute('data-talking', !!c.visit?.bubble || !!c.deskBubble);
    if (o.presence) { c.plate.dataset.presence = o.presence; c.plate.title = label; } else { delete c.plate.dataset.presence; c.plate.removeAttribute('title'); }
    c.plate.innerHTML = '';
    c.plateSize = null;
    const dot = el('span', 'ao-dot', { 'aria-hidden': 'true' });
    const name = el('span', 'ao-plate__name');
    name.textContent = shown;
    const small = el('small', 'ao-plate__state', { 'aria-hidden': 'true' });
    small.textContent = label;
    c.plate.append(dot, name, small);
    if (this.selected === c.id) c.plate.setAttribute('aria-current', 'true'); else c.plate.removeAttribute('aria-current');
  }

  _plateFocus(c, on) {
    c.el.classList.toggle('is-focus', on);
  }

  /**
   * Polite live-region announcements (O4), throttled: changes are collected for 1.5 s and spoken as one
   * sentence, at most one announcement every 4 s; nothing while the tab is hidden. Latest change per agent wins.
   */
  _announce(c, kind = 'state') {
    if (!this.live || document.visibilityState === 'hidden') return;   // scrolled out of view still speaks (O9)
    (this._pending ??= new Map()).set(c.id, { kind, name: this._name(c.occ), state: c.occ.state });
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
      : tr('scene.state', { name: x.name, state: (this.labels[x.state] ?? x.state).toLocaleLowerCase(intlLocale()) }));
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

  /** Select an occupant (ring + aria-current). fromUser fires onSelect (opens the drawer). */
  select(id, fromUser = false) {
    this.selected = id;
    for (const c of this.chars.values()) {
      const on = c.id === id;
      c.ring.classList.toggle('is-on', on);
      if (on) c.plate.setAttribute('aria-current', 'true'); else c.plate.removeAttribute('aria-current');
    }
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
    if (!this._raf && !this.destroyed) this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  _frame(t) {
    this._raf = 0;
    const dt = this._last ? Math.min(0.1, (t - this._last) / 1000) : 0;
    this._last = t;
    let moving = false;
    for (const c of this.chars.values()) {
      if (!c.walking || !c.path.length) continue;
      moving = true;
      let step = WALK_TILES_PER_S * dt;
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
    const seatAt = seatNode?.seatWorld && c.poseSeat ? seatNode.seatWorld : null;
    const box = seatAt
      ? imageBox(seatAt.sx, seatAt.sy, c.poseSeat, c.poseCanvas ?? ch.canvas, this.proj, c.poseScale ?? renderScale(ch))
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
        entries.push({ id: `${c.seatUid}:character:${c.id}`, depth: seat.depth, sub: i < 0 ? seat.stack.length : i, x: seat.it.x, node: c.el });
      } else entries.push({ id: `~${c.id}`, depth: characterDepth(c.pos.x, c.pos.y), sub: 5, x: c.pos.x, node: c.el });
    }
    sortScene(entries).forEach((e, i) => { zOf.set(e.node, i + 1); });
    for (const [node, z] of zOf) node.style.zIndex = String(z);
  }

  _positionLabels() {
    const { zoom, x, y } = this.cam;
    // office-dev-24: plates never cover each other (two people side by side on a small stage, a visit): the one nearer
    // the camera keeps its place, one it would overlap moves up above it. Sizes are read first, then written.
    const items = [];
    for (const c of this.chars.values()) {
      if (!c.head || c.leaving) continue;
      c.plateSize ??= { w: c.plate.offsetWidth, h: c.plate.offsetHeight };   // reset when the plate changes
      // a speaker's « … » bubble sits above their plate: it counts as part of it
      items.push({ c, vx: (c.head.sx + this.origin.x) * zoom + x, vy: (c.head.sy + this.origin.y) * zoom + y, ...c.plateSize, bh: c.plate.hasAttribute('data-talking') ? 22 : 0 });
    }
    items.sort((a, b) => b.vy - a.vy);
    const placed = [];
    for (const it of items) {
      let top = it.vy - 6 - it.h;
      for (let moved = true, n = 0; moved && n < 8; n++) {
        moved = false;
        for (const p of placed) {
          if (Math.abs(it.vx - p.vx) < (it.w + p.w) / 2 + 2 && top - it.bh < p.top + p.h + 2 && top + it.h + 2 > p.top - p.bh) { top = p.top - p.bh - it.h - 2; moved = true; }
        }
      }
      placed.push({ vx: it.vx, top, w: it.w, h: it.h, bh: it.bh });
      it.c.plate.style.transform = `translate(${Math.round(it.vx)}px, ${Math.round(top)}px) translateX(-50%)`;
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
    // O9: a crowded room drawn small (a phone, an annex) would be all nameplates: plates shrink to their state dot,
    // and the name shows on hover, focus and selection. Their accessible names stay whole.
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
    vp.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey && !this.editing) return;
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    // O9 touch: one finger scrolls the page (CSS touch-action: pan-x pan-y) and a tap selects an agent; two fingers pan
    // and pinch the office (the page doesn't scroll while two fingers are down). A mouse drags the office as before.
    vp.addEventListener('touchmove', (e) => { if (e.touches.length >= 2 || this.editing) e.preventDefault(); }, { passive: false });
    const pts = new Map();
    let pinch = null, mid = null, tap = null;
    const midOf = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
    vp.addEventListener('pointerdown', (e) => {
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
    vp.addEventListener('pointermove', (e) => {
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
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);
    vp.addEventListener('keydown', (e) => {
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

  /**
   * Ghost of an item being placed: footprint diamonds (valid: accent fill; invalid: danger hatch) and a
   * translucent sprite. ghost = { asset, x, y, orientation } | { asset, wall, offset }, ok, tiles.
   */
  showGhost(ghost, ok, tiles) {
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
      addEventListener('popstate', this._onFsPop);
      document.addEventListener('keydown', this._onFsKey);
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
    b.addEventListener('click', async (e) => { if (this.fullscreen) await this.toggleFullscreen(false); onClick(e); });
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
    this.destroyed = true;
    clearTimeout(this._announceTimer);
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    clearInterval(this._themeTimer);
    this._ro.disconnect();
    this._mq.removeEventListener('change', this._onMq);
    document.removeEventListener('visibilitychange', this._onVis);
    document.removeEventListener('fullscreenchange', this._onFsChange);
    document.removeEventListener('webkitfullscreenchange', this._onFsChange);
    if (this.stage.hasAttribute('data-fake-fullscreen')) this._fakeFullscreen(false);
    else if ((document.fullscreenElement ?? document.webkitFullscreenElement) === this.stage) this._fsApi()?.exit().catch?.(() => {});
    this._io?.disconnect();
    this._imgKeep?.clear();
    for (const c of this._allChars ?? []) { c.dead = true; this._cancelAll(c); }
    this._allChars?.clear();
    this.chars.clear();
    this._camListeners?.clear();
    this.pointerHandler = null;
    this.stage.replaceChildren();
    this.stage.classList.remove('ao-office');
  }
}
