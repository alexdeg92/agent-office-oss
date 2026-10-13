'use strict';
// DOM-level office tests in headless Chrome (review R4-18): the real OfficeScene and editor modules,
// the shipped manifest/layout and delivered art. Each case reproduces a reviewed failure:
// R4-12 superseded decodes, R4-13 destruction/selection, R4-14 live reduced motion, R4-15 replanning,
// keyboard focus/activation, and the editor's keyboard placement, undo, save, 409 and reset flows.
// Skipped when no Chrome binary exists (helpers/browser.js).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch, findChrome } = require('./helpers/browser');

const skip = findChrome() ? false : 'no Chrome/Chromium binary (set CHROME_BIN)';

// One browser for the file: a fresh headless profile stalls ~20–25 s on its first navigation
// (measured independently of the server), so it is paid once.
let browser;
before(async () => { if (!skip) browser = await launch(); });
after(async () => { await browser?.close(); });

describe('office scene in a real DOM', { skip, timeout: 120_000 }, () => {
  async function harness() {
    const p = await browser.page('/test/office/harness.html');
    await p.waitFor('window.H && window.H.ready');
    await p.eval(`
      window.stage = document.getElementById('stage');
      window.selectedIds = [];
      window.sc = new H.OfficeScene(stage, { manifest: H.manifest, layout: H.layout, assetBase: H.assetBase, theme: 'day', onSelect: (id) => selectedIds.push(id) });
      window.src = [{ id: 'main', role: 'main', sourceName: 'Timmy', state: 'working', stateSince: Date.now() }];
      window.push = () => sc.setOccupants(H.occupants(src));
      push();
    `);
    await p.waitFor(`sc.chars.get('main').displayed`);
    return p;
  }

  it('R4-12: a superseded decode never leaves two poses mounted', async () => {
    const p = await harness();
    const r = await p.eval(`
      const held = H.holdDecodes();
      src[0].state = 'thinking'; push();            // request B (held)
      const nB = held.length;
      src[0].state = 'error'; push();               // request C (held) supersedes B
      for (let i = nB; i < held.length; i++) H.release(i);   // C decodes first…
      await H.frames(2);                                      // (its decode callback and swap have run)
      for (let i = 0; i < nB; i++) H.release(i);             // …then the stale B
      await H.frames(2);
      H.releaseAll();                                         // the swivel's final pose, requested after its intermediate
      const el = sc.chars.get('main').el;
      // Settled: decodes keep being answered (requests made later, e.g. after the swivel, are held too) until the
      // final pose is the one displayed and faded in.
      await H.until(() => { H.releaseAll(); return /life-error-sw\.webp$/.test(sc.chars.get('main').displayed?.querySelector('[data-layer=body]')?.getAttribute('src') ?? '')
        && sc.chars.get('main').displayed.classList.contains('is-in'); });
      // Any stale group would be dropped by the crossfade timer: wait for that timer to have run (no pose group fading).
      await H.until(() => [...el.querySelectorAll('.ao-pose')].every((g) => g === sc.chars.get('main').displayed));
      const groups = [...el.querySelectorAll('.ao-pose')];
      return { count: groups.length, body: groups[0]?.querySelector('[data-layer=body]')?.getAttribute('src') ?? '' };
    `);
    assert.equal(r.count, 1);
    // Timmy works seated (Batch 6): an error swivels him to face the camera.
    assert.match(r.body, /timmy\/life-error-sw\.webp$/);
    await p.close();
  });

  it('normal same-theme room rebuild never paints empty desks red or retains editor ghosts',async()=>{
    const p=await harness();
    try{
      const result=await p.eval(`
        sc.setOccupants([]);
        sc.setLayout(H.layout);sc.setLayout(H.layout);
        const tints=[...sc.stage.querySelectorAll('.ao-tint')];
        const hidden=tints.every(n=>n.hidden&&getComputedStyle(n).display==='none');
        const desk=H.layout.items.find(i=>i.asset==='desk');
        sc.showGhost(desk,false,[{x:desk.x,y:desk.y}]);
        const browseGhosts=sc.stage.querySelectorAll('.ghost.bad').length;
        sc.setEditing(true);sc.showGhost(desk,false,[{x:desk.x,y:desk.y}]);
        const editGhosts=sc.stage.querySelectorAll('.ghost.bad').length;
        sc.setEditing(false);
        return {tints:tints.length,hidden,browseGhosts,editGhosts,after:sc.stage.querySelectorAll('.ghost.bad').length,
          ghostHidden:!sc._ghostImg||sc._ghostImg.hidden};
      `);
      assert.ok(result.tints>0);assert.equal(result.hidden,true);
      assert.equal(result.browseGhosts,0);assert.ok(result.editGhosts>0);
      assert.equal(result.after,0);assert.equal(result.ghostHidden,true);
    }finally{await p.close();}
  });

  it('uses the OfficeVM standingPoint when no station is assigned', async () => {
    const p = await harness();
    const target = await p.eval(`
      const c = sc.chars.get('main');
      c.occ = { ...c.occ, stationUid: null, standingPoint: { x: 3, y: 4 }, floorId: '2' };
      return sc._targetFor(c);
    `);
    assert.deepEqual(target, { x: 3.5, y: 4.5, uid: 'standing:2', mode: 'stand' });
    await p.close();
  });

  it('R4-13: a replaced occupant keeps its selection; destroy() cancels pending work', async () => {
    const p = await harness();
    const r = await p.eval(`
      sc.setReducedMotion(true);
      src.push({ id: 'subagent:a', role: 'subagent', sourceName: 'Scout', state: 'working', stateSince: Date.now() });
      push(); await H.until(() => sc.chars.get('subagent:a')?.displayed);
      src.pop(); push();                                  // leaves: fade-out timer pending
      src.push({ id: 'subagent:a', role: 'subagent', sourceName: 'Scout', state: 'working', stateSince: Date.now() });
      push();                                             // replacement with the same id
      sc.select('subagent:a');
      // Settled: the leaving instance is gone (destroyed by the replacement or by its fade-out timer).
      await H.until(() => [...(sc._allChars ?? [])].every((c) => !c.leaving) && sc.chars.get('subagent:a')?.displayed);
      const selectedAfter = sc.selected;
      const present = sc.chars.has('subagent:a');
      // destroy() while a decode is pending: nothing may be appended afterwards
      H.holdDecodes();
      src[0].state = 'thinking'; push();
      const el = sc.chars.get('main').el;
      const before = el.querySelectorAll('.ao-pose').length;
      sc.destroy();
      H.releaseAll();
      // Proving nothing is appended: the released decodes' callbacks and any frame they would schedule have run.
      await H.frames(3);
      return { selectedAfter, present, before, after: el.querySelectorAll('.ao-pose').length, raf: sc._raf, stageEmpty: stage.children.length === 0 };
    `);
    assert.equal(r.selectedAfter, 'subagent:a');
    assert.equal(r.present, true);
    assert.ok(r.before > 0, 'there was mounted art before destruction');
    assert.equal(r.after, 0, 'destruction releases mounted art; late decodes append nothing');
    assert.equal(r.raf, 0);
    assert.equal(r.stageEmpty, true);
    assert.deepEqual(p.logs, []);
    await p.close();
  });

  it('R4-14: turning reduced motion on mid-walk snaps to the destination', async () => {
    const p = await harness();
    const r = await p.eval(`
      src.push({ id: 'subagent:w', role: 'subagent', sourceName: 'Plume', state: 'working', stateSince: Date.now() });
      push();
      const c = await H.until(() => { const x = sc.chars.get('subagent:w'); return x?.walking && x.path.length > 1 && x; });
      const walkingBefore = c.walking;
      sc.setReducedMotion(true);
      const t = c.target;
      return { walkingBefore, walking: c.walking, path: c.path.length, at: [c.pos.x, c.pos.y], target: [t.x, t.y], seat: c.seatUid };
    `);
    assert.equal(r.walkingBefore, true);
    assert.equal(r.walking, false);
    assert.equal(r.path, 0);
    assert.deepEqual(r.at, r.target);
    assert.ok(r.seat);
    await p.close();
  });

  it('R4-15: a layout change invalidates a planned path even when the destination is unchanged', async () => {
    const p = await harness();
    const r = await p.eval(`
      src.push({ id: 'subagent:w', role: 'subagent', sourceName: 'Plume', state: 'working', stateSince: Date.now() });
      push();
      const c = await H.until(() => { const x = sc.chars.get('subagent:w'); return x?.walking && x.path.length > 1 && x; });
      // Drop a plant on the next tile of the route (not the destination).
      const next = c.path.find((p, i) => i < c.path.length - 1);
      const tx = Math.floor(next.x), ty = Math.floor(next.y);
      const layout2 = structuredClone(H.layout);
      layout2.items.push({ uid: 'block-1', asset: 'plant-small', x: tx, y: ty });
      const targetBefore = [c.target.x, c.target.y];
      sc.setLayout(layout2);
      const blocked = (x, y) => sc.grid.blocked[y * sc.grid.cols + x] === 1;
      const pathHitsObstacle = c.path.slice(0, -1).some((p) => blocked(Math.floor(p.x), Math.floor(p.y)));
      return { targetBefore, target: [c.target.x, c.target.y], pathHitsObstacle, onObstacle: Math.floor(c.pos.x) === tx && Math.floor(c.pos.y) === ty && c.walking };
    `);
    assert.deepEqual(r.target, r.targetBefore);
    assert.equal(r.pathHitsObstacle, false);
    assert.equal(r.onObstacle, false);
    await p.close();
  });

  it('R7-07: exactly one typing frame is painted; reduced motion paints frame 0', async () => {
    const p = await harness();
    const painted = `[...sc.chars.get('main').displayed.querySelectorAll('img[data-layer=body]')].map((i) => getComputedStyle(i).display !== 'none')`;
    const r = await p.eval(`
      const shown = () => ${painted}.indexOf(true);
      await H.until(() => ${painted}.length === 3 && sc.chars.get('main').intervals.size === 1);
      const a = ${painted};
      const f0 = shown();
      await H.until(() => shown() !== f0);                  // the loop advanced one frame
      const b = ${painted};
      sc.setReducedMotion(true);
      await H.until(() => sc.chars.get('main').intervals.size === 0 && shown() === 0);
      const c = ${painted};
      return { a, b, c };
    `);
    assert.equal(r.a.length, 3, 'Timmy types on three frames');
    assert.equal(r.a.filter(Boolean).length, 1);
    assert.equal(r.b.filter(Boolean).length, 1);
    assert.deepEqual(r.c.length ? r.c : [true], r.c.length ? [true, false, false].slice(0, r.c.length) : [true]);
    await p.close();
  });

  it('R7-09 / R4-14: turning reduced motion on stops the typing loop at once, even with decodes held', async () => {
    const p = await harness();
    const r = await p.eval(`
      const c = await H.until(() => { const x = sc.chars.get('main'); return x.intervals.size === 1 && x.displayed?.querySelectorAll('img[data-layer=body]').length === 3 && x; });
      const flags = () => [...c.displayed.querySelectorAll('img[data-layer=body]')].map((i) => i.hidden);
      H.holdDecodes();
      sc.setReducedMotion(true);
      // Proving the frames STOP changing needs an observation window: several frame periods (frameMs), anchored on
      // the loop having run. Under load, timers only fire later, so a slow run can't produce a false failure.
      const seen = [];
      for (let i = 0; i < 6; i++) { seen.push(flags().join()); await new Promise((x) => setTimeout(x, 175)); }
      return { seen, intervals: c.intervals.size };
    `);
    assert.equal(r.intervals, 0, 'no frame interval survives');
    assert.deepEqual(new Set(r.seen).size, 1, 'mounted frames stop changing');
    assert.equal(r.seen[0], 'false,true,true', 'frame 0 is held');
    await p.close();
  });

  for (const width of [390, 360]) it(`T-0077: pending pose decodes keep typing intervals bounded and pause at ${width}px`, async t => {
    const p = await harness();
    try {
      await p.viewport(width, 844); await p.cpu(4);
      const r = await p.eval(`
        stage.style.width = '${width}px'; stage.style.height = '480px'; sc.fit();
        sc._nextLifeCheck = Infinity;
        const c = await H.until(() => { const c = sc.chars.get('main'); return c.intervals.size === 1 && c; });
        const counts = [], pending = [], hidden = [], resumed = [];
        H.holdDecodes();
        for (let i = 0; i < 16; i++) {
          src[0].state = i % 2 ? 'working' : 'idle'; push();
          counts.push(c.intervals.size);
          pending.push([...c.poseGroups].filter(g => g._cancelDecode).length);
        }
        for (let i = 0; i < 3; i++) {
          Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
          hidden.push(c.intervals.size);
          src[0].state = 'idle'; push(); src[0].state = 'working'; push();
          H.releaseAll(); await H.frames(2);
          hidden.push(c.intervals.size);
          H.restoreDecodes();
          delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange'));
          await H.until(() => c.intervals.size === 1 && c.displayed === c.poseEl);
          resumed.push(c.intervals.size);
          H.holdDecodes();
        }
        src[0].state = 'idle'; push(); src[0].state = 'working'; push();
        sc.destroy(); H.releaseAll(); await H.frames(2); H.restoreDecodes();
        return { counts, pending, hidden, resumed, destroyed: c.intervals.size, groups: c.poseGroups.size, frames: c.rafs.size, nodes: stage.childElementCount };
      `);
      t.diagnostic(JSON.stringify(r));
      assert.ok(r.counts.every(n => n <= 1), 'one typing interval per character, including pending decodes: ' + r.counts);
      assert.ok(r.pending.every(n => n <= 1), 'one owned decode request per character');
      assert.deepEqual(r.hidden, Array(6).fill(0), 'nothing ticks while hidden, even when decoding completes');
      assert.deepEqual(r.resumed, [1, 1, 1], 'one loop resumes for the winning displayed pose');
      assert.deepEqual([r.destroyed, r.groups, r.frames, r.nodes], [0, 0, 0, 0], 'late decode completion cannot resurrect destroyed work');
    } finally { await p.close(); }
  });

  it('destination (2.1): the occupant goes to the server rack, then home when it clears', async () => {
    const p = await harness();
    const r = await p.eval(`
      sc.setReducedMotion(true);
      const occ = H.occupants([{ id: 'main', role: 'main', sourceName: 'Timmy', state: 'calling', stateSince: Date.now() }]);
      sc.setOccupants([{ ...occ[0], destination: { kind: 'server', stationUid: 'rack' } }]);
      const at = sc.chars.get('main').target.uid;
      sc.setOccupants([{ ...occ[0], destination: null }]);
      const back = sc.chars.get('main').target.uid;
      sc.setOccupants([{ ...occ[0], destination: { kind: 'server', stationUid: 'gone' } }]);
      return { at, back, unknown: sc.chars.get('main').target.uid };
    `);
    assert.deepEqual(r, { at: 'rack', back: 'st-timmy', unknown: 'st-timmy' });
    await p.close();
  });

  it('delegation (cue partnerId): both meet at the table facing each other, then go to their desks', async () => {
    const p = await harness();
    const r = await p.eval(`
      // The cue arrives before the partner is on stage (as the server may send it).
      sc.cue('main', 'delegating', { partnerId: 'subagent:n', interactionId: 'int-1' });
      src.push({ id: 'subagent:n', role: 'subagent', sourceName: 'Nova', state: 'working', stateSince: Date.now() });
      push();
      const a = sc.chars.get('main'), b = sc.chars.get('subagent:n');
      const started = { a: a.target.uid, b: b.target.uid, fa: a.meet?.facing, fb: b.meet?.facing };
      const seen = new Set();
      // Sample every poll until the meeting has happened and ended (walk, talk, walk home).
      await H.until(() => {
        if (a.meet?.phase === 'talk' && b.meet?.phase === 'talk') {
          seen.add('talk');
          seen.add(a.renderedPose + '|' + b.renderedPose);
        }
        return a.meet == null && b.meet == null && seen.has('talk');
      }, 60_000);
      sc.cue('main', 'delegating', { partnerId: 'subagent:n', interactionId: 'int-1' });   // repeated → ignored
      const repeated = !!a.meet;
      return { started, seen: [...seen], after: { a: a.target.uid, b: b.target.uid, bStation: H.occupants(src)[1].stationUid }, repeated };
    `);
    assert.equal(r.started.a, 'meet:int-1');
    assert.equal(r.started.b, 'meet:int-1');
    assert.deepEqual([r.started.fa, r.started.fb], ['sw', 'se'], 'delegator on the right facing SW, partner on the left facing SE');
    assert.ok(r.seen.includes('talk'), 'they talk');
    assert.ok(r.seen.includes('talking|walking-se'), 'poses: talking / SE stand-in');
    assert.equal(r.after.a, 'st-timmy');
    assert.equal(r.after.b, r.after.bStation);
    assert.equal(r.repeated, false);
    await p.close();
  });

  it('delegation under reduced motion: no walk to the table, just the talking cue', async () => {
    const p = await harness();
    const r = await p.eval(`
      sc.setReducedMotion(true);
      src.push({ id: 'subagent:q', role: 'subagent', sourceName: 'Orion', state: 'working', stateSince: Date.now() });
      push();
      sc.cue('main', 'delegating', { partnerId: 'subagent:q', interactionId: 'int-2' });
      return { meet: !!sc.chars.get('main').meet, cue: sc.chars.get('main').cue };
    `);
    assert.deepEqual(r, { meet: false, cue: 'delegating' });
    await p.close();
  });

  it('O4: state changes are announced politely, batched and throttled', async () => {
    const p = await harness();
    const r = await p.eval(`
      src.push({ id: 'subagent:a', role: 'subagent', sourceName: 'Scout', state: 'working', stateSince: Date.now() });
      // Every live-region change, timestamped when it happens (a MutationObserver runs right after the write), so
      // the throttle is checked on the scene's own timeline, not on when this test gets to look.
      const region = document.querySelector('.ao-office [aria-live]');
      const said = [];
      new MutationObserver(() => said.push({ at: Date.now(), text: region.textContent })).observe(region, { childList: true, characterData: true, subtree: true });
      src.push({ id: 'subagent:b', role: 'subagent', sourceName: 'Plume', state: 'working', stateSince: Date.now() });
      push();
      await H.until(() => said.length >= 1);
      const arrivals = said[0].text;
      src[0].state = 'thinking'; src[1].state = 'error'; src[2].state = 'writing'; push();
      src[1].state = 'idle'; push();                                   // latest change per agent wins
      await H.until(() => said.length >= 2);
      // What was on air during the 4 s gap: the last text written before arrivals + 4 s.
      const early = said.filter((x) => x.at < said[0].at + 4000).at(-1).text;
      const batch = said[1].text;
      return { arrivals, early, batch, live: document.querySelector('.ao-office [aria-live]').getAttribute('aria-live') };
    `);
    assert.match(r.arrivals, /^2 changements\. Scout arrive au bureau\. Plume arrive au bureau\.$/);
    assert.equal(r.early, r.arrivals, 'no second announcement within 4 s');
    assert.match(r.batch, /^3 changements\. Timmy : réfléchit\. Scout : erreur|^3 changements\./);
    assert.ok(r.batch.includes('Scout : inactif') || r.batch.includes('Scout'), r.batch);
    assert.equal(r.live, 'polite');
    await p.close();
  });

  it('O4: a hidden tab pauses frame loops, idle swivels and CSS animation; they resume on return', async () => {
    const p = await harness();
    const r = await p.eval(`
      const c = await H.until(() => sc.chars.get('main')?.intervals.size === 1 && sc.chars.get('main'));
      const vis = (v) => { Object.defineProperty(document, 'visibilityState', { value: v, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); };
      const before = c.intervals.size;
      vis('hidden');
      const hidden = { intervals: c.intervals.size, paused: document.getElementById('stage').hasAttribute('data-paused') };
      vis('visible');
      await H.until(() => c.intervals.size === 1 && !document.getElementById('stage').hasAttribute('data-paused'));
      return { before, hidden, after: c.intervals.size, paused: document.getElementById('stage').hasAttribute('data-paused') };
    `);
    assert.equal(r.before, 1, 'Timmy types');
    assert.deepEqual(r.hidden, { intervals: 0, paused: true });
    assert.equal(r.after, 1);
    assert.equal(r.paused, false);
    await p.close();
  });

  it('office-dev-20: ⛶ is real full screen (native API on a real tap; the overlay fallback elsewhere); same button, Esc and Back leave', async () => {
    const p = await harness();
    const st = `const b = document.querySelector('[data-ctl="fullscreen"]'); const r = stage.getBoundingClientRect();
      return { pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'), native: document.fullscreenElement === stage,
        fake: stage.hasAttribute('data-fake-fullscreen'), attr: stage.hasAttribute('data-fullscreen'), w: Math.round(r.width), h: Math.round(r.height),
        vw: innerWidth, vh: innerHeight, zoom: sc.cam.zoom, fitBtn: !!document.querySelector('[data-ctl="fit"]') };`;
    const before = await p.eval(`await new Promise((r) => setTimeout(r, 300)); ${st}`);
    assert.deepEqual([before.pressed, before.label, before.attr, before.fitBtn], ['false', 'Plein écran', false, true]);
    // 1) fallback overlay (iOS Safari has no Fullscreen API): fills the viewport, re-fits, Esc leaves
    await p.eval(`sc.forceFakeFullscreen = true; document.querySelector('[data-ctl="fullscreen"]').click(); await new Promise((r) => setTimeout(r, 300));`);
    const fake = await p.eval(st);
    assert.deepEqual([fake.fake, fake.attr, fake.pressed, fake.label], [true, true, 'true', 'Quitter le plein écran']);
    assert.equal(fake.w, fake.vw); assert.equal(fake.h, fake.vh);
    assert.ok(fake.zoom > before.zoom, `re-fit to the bigger stage: ${before.zoom} → ${fake.zoom}`);
    await p.key('Escape');
    const out = await p.eval(`await new Promise((r) => setTimeout(r, 300)); ${st}`);
    assert.deepEqual([out.fake, out.attr, out.pressed], [false, false, 'false']);
    assert.ok(Math.abs(out.zoom - before.zoom) < 0.01, 'back to the page size');
    // Back (the history entry) leaves the overlay too; the same button as well
    await p.eval(`document.querySelector('[data-ctl="fullscreen"]').click(); await new Promise((r) => setTimeout(r, 200)); history.back(); await new Promise((r) => setTimeout(r, 400));`);
    assert.equal((await p.eval(st)).fake, false, 'Back leaves');
    await p.eval(`const b = document.querySelector('[data-ctl="fullscreen"]'); b.click(); await new Promise((r) => setTimeout(r, 200)); b.click(); await new Promise((r) => setTimeout(r, 300));`);
    assert.equal((await p.eval(st)).fake, false, 'the same button leaves');
    // 2) the native API on a real (trusted) tap
    await p.eval(`sc.forceFakeFullscreen = false;`);
    await p.emulateTouch();
    const at = await p.eval(`const r = document.querySelector('[data-ctl="fullscreen"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
    await p.touch('touchStart', [[at.x, at.y]]); await p.touch('touchEnd', []);
    const nat = await p.eval(`await new Promise((r) => setTimeout(r, 500)); ${st}`);
    assert.ok(nat.native || nat.fake, 'full screen engaged');
    assert.equal(nat.attr, true); assert.equal(nat.pressed, 'true');
    // 3) choosing an agent leaves full screen first (its card opens outside the stage), then selects
    await p.eval(`selectedIds.length = 0; sc.select('main', true); await new Promise((r) => setTimeout(r, 500));`);
    const sel = await p.eval(`return { ids: selectedIds, native: document.fullscreenElement === stage, fake: stage.hasAttribute('data-fake-fullscreen') };`);
    assert.deepEqual(sel, { ids: ['main'], native: false, fake: false });
    await p.close();
  });

  it('O9: one finger scrolls the page (no pan), two fingers pan and pinch, a tap on an agent selects it', async () => {
    const p = await harness();
    await p.emulateTouch();
    const r0 = await p.eval(`
      document.body.style.minHeight = '3000px';
      window._sel = []; sc.onSelect = (id) => window._sel.push(id);
      const b = document.getElementById('stage').getBoundingClientRect();
      return { x: sc.cam.x, y: sc.cam.y, z: sc.cam.zoom, cx: b.left + b.width / 2, cy: b.top + b.height / 2,
        ta: getComputedStyle(sc.viewport).touchAction };`);
    assert.equal(r0.ta, 'pan-x pan-y', 'one finger is left to the page');
    await p.touch('touchStart', [[r0.cx, r0.cy]]);
    for (let i = 1; i <= 6; i++) await p.touch('touchMove', [[r0.cx, r0.cy - i * 25]]);
    await p.touch('touchEnd', []);
    const r1 = await p.eval(`await new Promise((r) => setTimeout(r, 300)); return { x: sc.cam.x, y: sc.cam.y, z: sc.cam.zoom, scroll: window.scrollY, sel: window._sel.length };`);
    assert.equal(r1.x, r0.x); assert.equal(r1.y, r0.y);
    assert.ok(r1.scroll > 40, `the page scrolled (${r1.scroll})`);
    assert.equal(r1.sel, 0, 'a swipe is not a tap');
    // Let the swipe's fling settle, then go back to the top.
    const m = await p.eval(`let last = -1; while (last !== window.scrollY) { last = window.scrollY; await new Promise((r) => setTimeout(r, 200)); }
      window.scrollTo(0, 0); await new Promise((r) => setTimeout(r, 100));
      const b = document.getElementById('stage').getBoundingClientRect(); return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 };`);
    // Two fingers moving together pan; spreading them zooms. The page stays put.
    await p.touch('touchStart', [[m.cx - 40, m.cy], [m.cx + 40, m.cy]]);
    for (let i = 1; i <= 5; i++) await p.touch('touchMove', [[m.cx - 40 + i * 10, m.cy], [m.cx + 40 + i * 10, m.cy]]);
    const panned = await p.eval(`return { x: sc.cam.x, z: sc.cam.zoom };`);
    assert.ok(panned.x > r1.x + 30, `two-finger pan ${r1.x} → ${panned.x}`);
    assert.ok(Math.abs(panned.z - r1.z) < 0.01, 'moving together does not zoom');
    for (let i = 1; i <= 5; i++) await p.touch('touchMove', [[m.cx + 10 - i * 15, m.cy], [m.cx + 90 + i * 15, m.cy]]);
    await p.touch('touchEnd', []);
    const r2 = await p.eval(`return { x: sc.cam.x, z: sc.cam.zoom, scroll: window.scrollY, sel: window._sel.length };`);
    assert.ok(r2.z > r1.z * 1.3, `pinch zoom ${r1.z} → ${r2.z}`);
    assert.equal(r2.scroll, 0, 'no page scroll while two fingers are down');
    assert.equal(r2.sel, 0);
    // A tap on an agent opens its card (onSelect); a tap on the floor selects nothing.
    const at = await p.eval(`const r = sc.chars.get('main').el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 };`);
    await p.touch('touchStart', [[at.x, at.y]]); await p.touch('touchEnd', []);
    const fl = await p.eval(`const b = sc.viewport.getBoundingClientRect(); return { x: b.left + 6, y: b.bottom - 6 };`);
    await p.touch('touchStart', [[fl.x, fl.y]]); await p.touch('touchEnd', []);
    assert.deepEqual(await p.eval(`await new Promise((r) => setTimeout(r, 100)); return window._sel;`), ['main']);
    await p.close();
  });

  it('O4: seasons layer on day/night (variants first, decor extras); the editor offers them', async () => {
    const p = await harness();
    const r = await p.eval(`
      const m = structuredClone(H.manifest);
      const hiver = m.themes.find((t) => t.id === 'hiver');
      hiver.extras = [{ asset: 'plant-small', x: 5, y: 5 }];
      m.furniture.find((f) => f.id === 'window').images['sw@hiver'] = 'assets/Office/furniture/window@night.png';
      const l = structuredClone(H.layout);
      l.theme = { ...l.theme, mode: 'fixed', fixed: 'day', season: 'hiver' };
      const s2 = new H.OfficeScene(document.getElementById('stage'), { manifest: m, layout: l, assetBase: H.assetBase, theme: 'day' });
      const win = () => document.querySelector('.ao-layer--wall [data-item="win"]').getAttribute('src');
      const on = { season: s2.stage.dataset.officeSeason, window: win(), decor: document.querySelectorAll('[data-season]').length, theme: s2.stage.dataset.officeTheme };
      s2.setLayout({ ...l, theme: { ...l.theme, season: null } });
      const off = { season: s2.stage.dataset.officeSeason, window: win(), decor: document.querySelectorAll('[data-season]').length };
      const valid = H.validateLayout(l, H.index).length;
      const store = H.createMockLayoutStore({ data: l, defaultData: H.layout, manifest: m });
      const ed = await H.openEditor({ scene: s2, store, assetBase: H.assetBase, barHost: document.getElementById('bar'), asideHost: document.getElementById('aside'), getOccupants: () => [] });
      ed.setMode('theme');
      await H.until(() => [...document.querySelectorAll('.ao-editpanel select')].some((x) => [...x.options].some((o) => o.value === 'hiver')));
      const sel = [...document.querySelectorAll('.ao-editpanel select')].find((x) => [...x.options].some((o) => o.value === 'hiver'));
      return { on, off, valid, options: sel ? [...sel.options].map((o) => o.textContent) : null, disabled: sel?.disabled, vmSeason: (await store.get()).theme.season };
    `);
    assert.deepEqual(r.on, { season: 'hiver', window: '/design/assets/Office/furniture/window@night.png', decor: 1, theme: 'day' });
    assert.deepEqual(r.off, { season: '', window: '/design/assets/Office/furniture/window.png', decor: 0 });
    assert.equal(r.valid, 0);
    assert.deepEqual(r.options, ['Aucune', 'Hiver', 'Automne']);
    assert.equal(r.disabled, false);
    assert.equal(r.vmSeason, 'hiver');
    await p.close();
  });

  it('the v1 accessory fallback turns off by itself once Batch 5b is complete', async () => {
    const p = await harness();
    const r = await p.eval(`
      const done = { ...H.manifest, accessoriesV2: { complete: true, covered: 1, total: 1 } };
      const s2 = new H.OfficeScene(document.createElement('div'), { manifest: done, layout: H.layout, assetBase: H.assetBase });
      const r = { now: sc.legacyAccessories, complete: s2.legacyAccessories, forced: new H.OfficeScene(document.createElement('div'), { manifest: done, layout: H.layout, assetBase: H.assetBase, legacyAccessories: true }).legacyAccessories };
      return r;
    `);
    assert.deepEqual(r, { now: !(await p.eval('return H.manifest.accessoriesV2.complete;')), complete: false, forced: true });
    await p.close();
  });

  it('nameplates: Tab reaches them in roster order and Enter selects', async () => {
    const p = await harness();
    await p.eval(`src.push({ id: 'subagent:k', role: 'subagent', sourceName: 'Atlas', state: 'error', stateSince: Date.now() }); sc.setReducedMotion(true); push(); await H.until(() => document.querySelectorAll('.ao-plate').length === 2 && [...document.querySelectorAll('.ao-plate')].some((x) => x.getAttribute('aria-label') === 'Atlas, Erreur'));
      // O7: the stage tools come first in Tab order, then the scene and its nameplates.
      const order = [...document.querySelectorAll('.ao-office button, .ao-office [tabindex="0"]')].map((n) => n.matches('.ao-controls *') ? 'tools' : n.matches('.ao-viewport') ? 'scene' : 'plate');
      if (order.indexOf('tools') > order.indexOf('scene')) throw new Error('tools after the scene: ' + order.join(','));
      document.querySelector('.ao-viewport').focus();`);
    await p.key('Tab');   // first nameplate
    const first = await p.eval(`return document.activeElement.getAttribute('aria-label');`);
    await p.key('Tab');
    const second = await p.eval(`return document.activeElement.getAttribute('aria-label');`);
    await p.key('Enter');
    const r = await p.eval(`return { sel: selectedIds.slice(), current: document.activeElement.getAttribute('aria-current') };`);
    assert.match(first, /^Timmy, /);
    assert.equal(second, 'Atlas, Erreur');
    assert.deepEqual(r.sel, ['subagent:k']);
    assert.equal(r.current, 'true');
    await p.close();
  });
});

describe('office editor in a real DOM', { skip, timeout: 120_000 }, () => {
  async function editorPage() {
    const p = await browser.page('/test/office/harness.html');
    await p.waitFor('window.H && window.H.ready');
    await p.eval(`
      window.sc = new H.OfficeScene(document.getElementById('stage'), { manifest: H.manifest, layout: H.layout, assetBase: H.assetBase, theme: 'day' });
      window.src = [{ id: 'main', role: 'main', sourceName: 'Timmy', state: 'working', stateSince: Date.now() }];
      sc.setOccupants(H.occupants(src));
      window.store = H.createMockLayoutStore({ data: H.layout, defaultData: structuredClone(H.layout), manifest: H.manifest, validate: (d) => H.validateLayout(d, H.index) });
      window.exits = []; window.toasts = [];
      window.open = async () => { window.ed = await H.openEditor({ scene: sc, store, assetBase: H.assetBase,
        barHost: document.getElementById('bar'), asideHost: document.getElementById('aside'),
        getOccupants: () => src, toast: (m) => toasts.push(m), onExit: (r) => exits.push(r) }); };
      await open();
      await H.until(() => document.querySelector('.ao-editbar') && document.querySelector('.ao-editpanel'));
    `);
    return p;
  }

  it('places furniture with the keyboard, refuses an occupied spot, and undoes/redoes', async () => {
    const p = await editorPage();
    const n0 = await p.eval(`return ed.draft.items.length;`);
    await p.eval(`[...document.querySelectorAll('.ao-tile')].find((b) => b.getAttribute('aria-label').startsWith('Petite plante')).focus();`);
    await p.key('Enter');
    const placing = await p.eval(`return { on: !!ed.placing, ok: ed.placing.check.ok, ghost: !!document.querySelector('.ao-edit-svg .ghost') };`);
    assert.deepEqual(placing, { on: true, ok: true, ghost: true });
    // Arrows move the ghost one tile; keep going right until the spot is free, then place.
    const x0 = await p.eval(`return ed.placing.cand.x;`);
    await p.key('ArrowRight');
    assert.equal(await p.eval(`return ed.placing.cand.x;`), x0 + 1);
    for (let i = 0; i < 6 && !(await p.eval(`return ed.placing.check.ok;`)); i++) await p.key('ArrowRight');
    await p.key('Enter');
    const n1 = await p.eval(`return { n: ed.draft.items.length, said: ed.announcement };`);
    assert.equal(n1.n, n0 + 1);
    assert.match(n1.said, /^Petite plante placé en \d+, \d+\.$/);

    // An occupied spot: start on a desk tile.
    await p.eval(`ed.startPlace('plant-small', { via: 'keyboard' }); ed.movePlaceTo({ x: 6, y: 1 });`);
    await p.key('Enter');
    const refused = await p.eval(`return { n: ed.draft.items.length, said: ed.announcement, still: !!ed.placing, hatch: !!document.querySelector('.ao-edit-svg .ghost.hatch') };`);
    assert.equal(refused.n, n0 + 1);
    assert.match(refused.said, /^Occupé par /);
    assert.equal(refused.still, true);
    assert.equal(refused.hatch, true);
    await p.key('Escape');

    await p.key('z', { code: 'KeyZ', modifiers: 2 });
    assert.equal(await p.eval(`return ed.draft.items.length;`), n0);
    await p.key('Z', { code: 'KeyZ', modifiers: 2 | 8 });
    assert.equal(await p.eval(`return ed.draft.items.length;`), n0 + 1);
    await p.close();
  });

  it('saves with expectedRevision, survives a 409 with Écraser, and reloads with Recharger', async () => {
    const p = await editorPage();
    const r = await p.eval(`
      const saveBtn = () => H.until(() => { const b = document.querySelector('.ao-editbar .bu-btn--primary'); return b && !b.disabled && b; });   // Preact renders asynchronously
      ed.patchTheme({ mode: 'fixed', fixed: 'night' });
      (await saveBtn()).click();
      await H.until(() => exits.length === 1);
      const first = { exits: exits.length, saved: exits[0]?.saved, rev: store.revision, toast: toasts[0] };
      await open();
      store.externalEdit((d) => { d.theme = { mode: 'auto', nightFrom: '20:00', nightTo: '06:00' }; });
      ed.patchTheme({ mode: 'fixed', fixed: 'day' });
      (await saveBtn()).click();
      const title = (await H.until(() => document.querySelector('#ao-modal-title'))).textContent;
      (await H.until(() => [...document.querySelectorAll('.bu-modal button')].find((b) => b.textContent === 'Écraser' && !b.disabled))).click();
      await H.until(() => exits.length === 2);
      const second = { title, rev: store.revision, saved: exits[1]?.saved };
      // Recharger
      await open();
      store.externalEdit((d) => { d.theme = { mode: 'fixed', fixed: 'night' }; });
      ed.patchTheme({ mode: 'auto' });
      (await saveBtn()).click();
      (await H.until(() => [...document.querySelectorAll('.bu-modal button')].find((b) => b.textContent === 'Recharger'))).click();
      await H.until(() => !ed.modal && !ed.dirty);
      const third = { rev: ed.vm.layout.revision, theme: ed.draft.theme, dirty: ed.dirty };
      return { first, second, third, server: (await store.get()).layout.data.theme };
    `);
    assert.deepEqual(r.first, { exits: 1, saved: true, rev: 2, toast: 'Bureau enregistré' });
    assert.equal(r.second.title, 'Le bureau a été modifié ailleurs.');
    assert.equal(r.second.rev, 4);
    assert.equal(r.second.saved, true);
    assert.equal(r.third.rev, 5);
    assert.deepEqual(r.third.theme, { mode: 'fixed', fixed: 'night' });
    assert.equal(r.third.dirty, false);
    await p.close();
  });

  it('R7-05: an edit made during a pending save stays unsaved; leaving during a save exits once', async () => {
    const p = await editorPage();
    const r = await p.eval(`
      // Delay the PUT under test control.
      const realPut = store.put.bind(store);
      let release; const gate = new Promise((res) => { release = res; });
      store.put = async (b) => { await gate; return realPut(b); };
      const saveBtn = () => H.until(() => { const b = document.querySelector('.ao-editbar .bu-btn--primary'); return b && !b.disabled && b; });
      ed.patchTheme({ mode: 'fixed', fixed: 'night' });
      (await saveBtn()).click();
      await H.until(() => ed.saving);
      ed.patchTheme({ mode: 'fixed', fixed: 'day' });          // edited while the PUT is pending
      release();
      await H.until(() => !ed.saving && toasts.length === 1);
      const a = { exits: exits.length, dirty: ed.dirty, server: (await store.get()).layout.data.theme.fixed, draft: ed.draft.theme.fixed, toasts: toasts.slice() };
      // Second case: ask to leave while a save is pending, then let it succeed.
      let release2; const gate2 = new Promise((res) => { release2 = res; });
      store.put = async (b) => { await gate2; return realPut(b); };
      (await saveBtn()).click();
      await H.until(() => ed.saving);
      ed.requestClose();
      const leaveBlocked = exits.length;
      release2();
      await H.until(() => exits.length >= 1 && !ed.saving);
      await H.frames(2);   // a second (wrong) exit would follow in the same turn: let it show if it exists
      return { a, leaveBlocked, exits: exits.map((e) => e.saved), server2: (await store.get()).layout.data.theme.fixed };
    `);
    assert.deepEqual(r.a, { exits: 0, dirty: true, server: 'night', draft: 'day', toasts: ['Bureau enregistré'] });
    assert.equal(r.leaveBlocked, 0);
    assert.deepEqual(r.exits, [true]);
    assert.equal(r.server2, 'day');
    await p.close();
  });

  it('server data never reaches CSS or HTML unvalidated (swatch, control label, mask URL)', async () => {
    const p = await browser.page('/test/office/harness.html');
    await p.waitFor('window.H && window.H.ready');
    const r = await p.eval(`
      const m = structuredClone(H.manifest);
      const sub = m.characters.find((c) => c.id === 'subagent');
      sub.variants[0].swatch = 'red;background-image:url(https://evil.example/x.png)';
      sub.variants[1].swatch = 'rgb(10, 20, 30)';
      const desk = m.furniture.find((f) => f.id === 'desk');
      desk.station.parts.monitor.variants.on = 'assets/Office/x.png") , url("https://evil.example/y.png';
      const sc = new H.OfficeScene(document.getElementById('stage'), { manifest: m, layout: H.layout, assetBase: H.assetBase, theme: 'day' });
      sc.setOccupants(H.occupants([{ id: 'main', role: 'main', sourceName: 'Timmy', state: 'error', stateSince: Date.now() }]));
      const b = sc.addControl({ label: '<img src=x onerror="window.pwned=1">', icon: '<path d="M1 1"/>', text: true });
      const store = H.createMockLayoutStore({ data: H.layout, defaultData: H.layout, manifest: m });
      const ed = await H.openEditor({ scene: sc, store, assetBase: H.assetBase, barHost: document.getElementById('bar'), asideHost: document.getElementById('aside'), getOccupants: () => [{ id: 'main', role: 'main', sourceName: 'Timmy', state: 'idle', stateSince: Date.now() }] });
      ed.agentSel = '*subagent'; ed.setMode('characters');
      await H.until(() => document.querySelectorAll('.ao-sc__dot').length >= 2);
      const dots = [...document.querySelectorAll('.ao-sc__dot')].map((d) => ({ bi: d.style.backgroundImage, bc: d.style.backgroundColor }));
      const masks = [...document.querySelectorAll('.ao-tint')].map((t) => t.style.maskImage || t.style.webkitMaskImage);
      return { dots, label: b.textContent, injectedImg: !!b.querySelector('img'), pwned: !!window.pwned, evilMask: masks.some((x) => x.includes('evil')) };
    `);
    assert.deepEqual(r.dots[0], { bi: '', bc: '' }, 'invalid swatch is dropped');
    assert.equal(r.dots[1].bc, 'rgb(10, 20, 30)');
    assert.equal(r.injectedImg, false);
    assert.equal(r.pwned, false);
    assert.match(r.label, /<img src=x/);
    assert.equal(r.evilMask, false);
    await p.close();
  });

  it('R7-08: editor dialogs trap Tab / Maj+Tab and give focus back on close (reset, leave, rename, 409)', async () => {
    const p = await editorPage();
    const inDialog = `!!document.activeElement.closest('[role=dialog]')`;
    async function cycle(openExpr, openerSel) {
      await p.eval(`${openExpr}; await H.until(() => document.activeElement.closest('[role=dialog]'));`);
      const seen = [];
      for (let i = 0; i < 6; i++) { await p.key('Tab'); seen.push(await p.eval(`return ${inDialog};`)); }
      for (let i = 0; i < 3; i++) { await p.key('Tab', { modifiers: 8 }); seen.push(await p.eval(`return ${inDialog};`)); }
      const behindInert = await p.eval(`return document.getElementById('stage').inert === true;`);
      await p.key('Escape');
      await p.eval(`await H.until(() => !document.querySelector('[role=dialog]') && !document.getElementById('stage').inert);`);
      const back = await p.eval(`return document.activeElement.matches(${JSON.stringify(openerSel)});`);
      return { trapped: seen.every(Boolean), behindInert, back };
    }
    // O7: « Réinitialiser… » lives in the « Plus d’actions » menu; focus comes back to that menu button.
    const reset = await cycle(`const more = document.querySelector('.ao-more > button'); more.focus(); more.click();
      const item = await H.until(() => [...document.querySelectorAll('.ao-more__item')].find((b) => b.textContent.startsWith('Réinitialiser'))); item.click()`, '.ao-more > button');
    assert.deepEqual(reset, { trapped: true, behindInert: true, back: true }, "reset");
    await p.eval(`ed.patchTheme({ mode: 'fixed', fixed: 'night' }); await H.until(() => [...document.querySelectorAll('.ao-editbar .bu-chip')].length);`);
    const leave = await cycle(`const b = [...document.querySelectorAll('.ao-editbar button')].find((x) => x.textContent === 'Annuler'); b.focus(); b.click()`, '.ao-editbar button.bu-btn--ghost');
    assert.deepEqual(leave, { trapped: true, behindInert: true, back: true }, "leave");
    const rename = await cycle(`ed.select('st-2'); await H.until(() => document.querySelector('.ao-itembar [aria-label="Renommer"]')); const b = document.querySelector('.ao-itembar [aria-label="Renommer"]'); b.focus(); b.click()`, '.ao-itembar [aria-label="Renommer"]');
    assert.deepEqual(rename, { trapped: true, behindInert: true, back: true }, "rename");
    const conflict = await cycle(`store.externalEdit(); const b = document.querySelector('.ao-editbar .bu-btn--primary'); b.focus(); b.click()`, '.ao-editbar .bu-btn--primary');
    assert.deepEqual(conflict, { trapped: true, behindInert: true, back: true }, "conflict");
    await p.close();
  });

  it('reset loads the shipped default (undoable); leaving with changes asks first', async () => {
    const p = await editorPage();
    const r = await p.eval(`
      const uid = ed.draft.items[0].uid;
      ed.remove(uid);
      ed.confirmReset();
      const restored = ed.draft.items.some((i) => i.uid === uid);
      ed.undo();
      const undone = !ed.draft.items.some((i) => i.uid === uid);
      ed.requestClose();
      const asked = (await H.until(() => document.querySelector('#ao-modal-title'))).textContent;
      [...document.querySelectorAll('.bu-modal button')].find((b) => b.textContent === 'Quitter').click();
      await H.until(() => exits.length === 1 && !document.getElementById('stage').hasAttribute('data-editing'));
      return { restored, undone, asked, exit: exits[0], rev: store.revision, editing: document.getElementById('stage').hasAttribute('data-editing') };
    `);
    assert.equal(r.restored, true);
    assert.equal(r.undone, true);
    assert.equal(r.asked, 'Quitter sans enregistrer ?');
    assert.equal(r.exit.saved, false);
    assert.equal(r.rev, 1);
    assert.equal(r.editing, false);
    await p.close();
  });
});

describe('Bureau page in a real DOM (S14a/b)', { skip, timeout: 120_000 }, () => {
  async function bureau(query = 'steps=6&tick=600000') {
    const p = await browser.page(`/public/v2/office/bureau-dev.html?${query}`);
    await p.waitFor(`document.querySelectorAll('.ao-roster').length >= 4 && document.querySelectorAll('.ao-plate').length >= 4`);
    return p;
  }
  const rosterAndPlates = `({
    roster: [...document.querySelectorAll('.ao-bureau__roster .ao-roster')].map((b) => b.querySelector('.ao-roster__name').textContent + ', ' + b.querySelector('.ao-roster__state').dataset.agentState),
    plates: [...document.querySelectorAll('.ao-plate')].map((b) => b.querySelector('.ao-plate__name').textContent + ', ' + b.dataset.state),
  })`;

  it('platform: the stage is named after MetaVM.primaryAgent, « l’agent » without it (no literal)', async () => {
    const p = await bureau();
    const r = await p.eval(`
      const i18n = await import('/public/v2/i18n.js');
      const label = () => document.querySelector('.ao-bureau__stage').getAttribute('aria-label');
      const withMeta = { label: label(), name: i18n.agentName() };
      i18n.setMeta({ labels: {}, enums: {} });
      window.officeBench.om.tick(); await window.officeBench.publish('office');
      await window.officeBench.until(() => label() !== withMeta.label);
      return { withMeta, fallback: label() };
    `);
    assert.equal(r.withMeta.label, `Le bureau de ${r.withMeta.name}`);
    assert.equal(r.fallback, 'Le bureau de l’agent');
    await p.close();
  });

  it('platform: no nameplate, roster row or drawer title is ever a raw agent id', async () => {
    // Bare scene fed raw ids as names (the staging regression), then the Bureau page and the demo.
    const raw = /^(main|(subagent|cron|dm|channel|agent):\S+)$/;
    const p = await browser.page('/test/office/harness.html');
    await p.waitFor('window.H && window.H.ready');
    const bare = await p.eval(`
      const sc = new H.OfficeScene(document.getElementById('stage'), { manifest: H.manifest, layout: H.layout, assetBase: H.assetBase, theme: 'day' });
      const occ = H.occupants([
        { id: 'main', role: 'main', sourceName: 'main', state: 'working', stateSince: Date.now() },
        { id: 'subagent:4f2a', role: 'subagent', sourceName: 'subagent:4f2a', state: 'thinking', stateSince: Date.now() },
      ]);
      sc.setOccupants(occ);
      return [...document.querySelectorAll('.ao-plate')].map((b) => b.querySelector('.ao-plate__name').textContent);
    `);
    assert.deepEqual(bare, ['L’agent', 'Sous-agent']);
    await p.close();
    for (const url of ['/public/v2/office/bureau-dev.html?steps=6&tick=600000&agent=main', '/public/v2/office/demo.html?scenario=mix']) {
      const q = await browser.page(url);
      await q.waitFor(`document.querySelectorAll('.ao-plate').length >= 3`);
      const names = await q.eval(`return [...document.querySelectorAll('.ao-plate__name, .ao-roster__name, #ao-drawer-title')].map((n) => n.textContent.trim());`);
      assert.ok(names.length >= 3, url);
      for (const n of names) assert.ok(n && !raw.test(n), `${url}: « ${n} » is a raw id`);
      assert.ok(names.includes('Timmy'), `${url}: the mock primary agent shows its data name`);
      await q.close();
    }
  });

  it('F7: assets follow config.basePath (/ and /v2/); « Automatique » follows the instance time zone', async () => {
    const p = await bureau();
    const r = await p.eval(`
      const cfg = await import('/public/v2/config.js');
      const page = await import('/public/v2/office/page.js');
      const H = await import('/public/v2/office/scene.js');
      const saved = window.officeBench.services.officeAssetBase;
      delete window.officeBench.services.officeAssetBase;        // the harness seam off: the runtime config decides
      const out = {};
      for (const basePath of ['/', '/v2/']) {
        cfg.configure({ basePath, apiBase: '' });
        out[basePath] = page.officeAssetBase();
      }
      window.officeBench.services.officeAssetBase = saved;
      // a scene at 16:30 UTC: night in Tokyo (01:30), day in Toronto (12:30)
      const m = window.officeBench.om.layoutVM();
      const at = Date.parse('2026-10-05T16:30:00Z');
      const mk = (tz) => { const el = document.createElement('div'); el.style.cssText = 'width:400px;height:300px'; document.body.append(el);
        const s = new H.OfficeScene(el, { manifest: m.manifest, layout: m.layout.data, assetBase: '/design/', theme: 'auto', now: () => at, timeZone: tz });
        const r = s.stage.dataset.officeTheme; s.destroy(); el.remove(); return r; };
      out.tokyo = mk('Asia/Tokyo'); out.toronto = mk(() => 'America/Toronto');
      return out;
    `);
    assert.equal(r['/'], '/bureau/');
    assert.equal(r['/v2/'], '/v2/bureau/');
    assert.equal(r.tokyo, 'night');
    assert.equal(r.toronto, 'day');
    await p.close();
  });

  it('roster and scene read the same occupants, in the same order, with the same state', async () => {
    const p = await bureau();
    const r = await p.eval(`return ${rosterAndPlates};`);
    assert.deepEqual(r.roster, r.plates);
    assert.equal(r.roster.length, 4);
    // A tick changes states: both sides follow.
    const r2 = await p.eval(`const prev = JSON.stringify(${rosterAndPlates}.roster); window.officeBench.om.tick(); await window.officeBench.publish('office');
      return await window.officeBench.until(() => { const x = ${rosterAndPlates}; return JSON.stringify(x.roster) !== prev && JSON.stringify(x.roster) === JSON.stringify(x.plates) && x; });`);
    assert.deepEqual(r2.roster, r2.plates);
    assert.notDeepEqual(r2.roster, r.roster);
    await p.close();
  });

  it('selecting opens the drawer (URL ?agent=), rings the agent; Escape closes and restores focus', async () => {
    const p = await bureau();
    const r = await p.eval(`
      const btn = [...document.querySelectorAll('.ao-roster')].find((b) => b.querySelector('.ao-roster__name').textContent === 'Plume');
      btn.focus(); btn.click();
      await window.officeBench.until(() => document.querySelector('#ao-drawer-title') && document.activeElement.getAttribute('aria-label') === 'Fermer' && document.querySelector('.ao-plate[aria-current="true"]'));
      const c = [...document.querySelectorAll('.ao-char')].find((e) => e.dataset.occupant === 'subagent:plume');
      return { url: location.search, drawer: document.querySelector('#ao-drawer-title')?.textContent, focus: document.activeElement.getAttribute('aria-label'),
        current: btn.getAttribute('aria-current'), plate: document.querySelector('.ao-plate[aria-current="true"]')?.getAttribute('aria-label'),
        bodyParagraphs: [...document.querySelectorAll('.bu-modal__body > p')].map(p => p.textContent.trim()) };
    `);
    assert.match(r.url, /agent=subagent%3Aplume/);
    assert.equal(r.drawer, 'Plume');
    assert.equal(r.focus, 'Fermer');
    assert.equal(r.current, 'true');
    assert.match(r.plate, /^Plume, /);
    assert.equal(r.bodyParagraphs.length, 1, 'the drawer shows the selected occupant state without appending a fabricated unknown label');
    await p.key('Escape');
    const after = await p.eval(`await window.officeBench.until(() => !document.querySelector('.bu-drawer') && document.activeElement.closest('.ao-roster')); return { drawer: !!document.querySelector('.bu-drawer'), focus: (document.activeElement.querySelector('.ao-roster__name') ?? document.activeElement).textContent.trim(), url: location.search };`);
    assert.deepEqual(after, { drawer: false, focus: 'Plume', url: '?steps=6&tick=600000' });
    await p.close();
  });

  it('SSE cue frames reach the scene; the theme toggle writes the layout and switches the scene', async () => {
    const p = await bureau();
    const r = await p.eval(`
      for (const fn of window.officeBench.services.cueListeners) fn({ type: 'cue', occupantId: 'main', cue: 'celebrating', at: Date.now() });
      const scene = document.querySelector('.ao-bureau__stage').aoScene;
      await window.officeBench.until(() => scene.chars.get('main').cue === 'celebrating' && scene.chars.get('main').renderedPose === 'life-success-sw');
      const motion = scene.chars.get('main').el.dataset.motion;
      [...document.querySelectorAll('.ao-bureau__theme .bu-segmented__opt')].find((b) => b.textContent === 'Nuit').click();
      await window.officeBench.until(() => document.querySelector('.ao-office').dataset.officeTheme === 'night' && document.querySelector('.ao-bureau__theme [aria-pressed="true"]')?.textContent === 'Nuit');
      return { motion, theme: document.querySelector('.ao-office').dataset.officeTheme, rev: (await window.officeBench.om.layoutVM()).layout.revision,
        pressed: document.querySelector('.ao-bureau__theme [aria-pressed="true"]').textContent };
    `);
    assert.equal(r.motion, '', 'a seated celebration keeps the hips on the seat');
    assert.deepEqual([r.theme, r.rev, r.pressed], ['night', 2, 'Nuit']);
    await p.close();
  });

  it('R8-10: cancelling a furniture edit restores the server layout in the scene', async () => {
    const p = await bureau();
    const r = await p.eval(`
      const items = () => new Set([...document.querySelectorAll('.ao-world [data-item]')].map((n) => n.dataset.item)).size;
      const before = items();
      document.querySelector('.ao-controls [data-page-control]').click();
      const placed = await window.officeBench.until(() => document.querySelector('.ao-editbar') && document.querySelector('[data-placed]'));
      placed.focus(); placed.click();
      await window.officeBench.until(() => placed.getAttribute('aria-current') === 'true');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      await window.officeBench.until(() => items() === before - 1);
      const during = items();
      [...document.querySelectorAll('.ao-editbar button')].find((b) => b.textContent === 'Annuler').click();
      (await window.officeBench.until(() => [...document.querySelectorAll('.bu-modal button')].find((b) => b.textContent === 'Quitter'))).click();
      await window.officeBench.until(() => !document.querySelector('.ao-editbar') && !document.querySelector('.ao-office').hasAttribute('data-editing'));
      const data = window.officeBench.om.layoutVM().layout.data;
      return { before, during, after: items(), server: data.items.length, serverHasElevator: data.items.some(x => x.asset === 'elevator-door') };
    `);
    assert.equal(r.during, r.before - 1, 'the edit was previewed');
    assert.equal(r.after, r.before, 'scene restored to the layout that was loaded before editing');
    assert.equal(r.before, r.server + Number(!r.serverHasElevator), 'the selected-floor adapter supplies its local elevator without persisting it in the root layout');
    await p.close();
  });

  it('R8-11: an editor-load failure leaves edit mode cleanly, with an error and a way back', async () => {
    const p = await bureau();
    const r = await p.eval(`
      const { ApiError } = await import('/public/v2/api.js');
      window.officeBench.services.officeApi.forFloor('1').get = () => Promise.reject(new ApiError({ status: 503, code: 'upstream_unavailable', message: 'La passerelle OpenClaw est injoignable.' }));
      document.querySelector('.ao-controls [data-page-control]').click();
      await window.officeBench.until(() => document.querySelector('[role=alert], .bu-toast--danger') && !document.querySelector('.ao-office').hasAttribute('data-editing'));
      return { editing: document.querySelector('.ao-office').hasAttribute('data-editing'), roster: document.querySelectorAll('.ao-bureau__roster .ao-roster').length,
        editbar: !!document.querySelector('.ao-editbar'), alert: document.querySelector('[role=alert], .bu-toast--danger')?.textContent ?? null,
        controlBack: getComputedStyle(document.querySelector('.ao-controls [data-page-control]')).display !== 'none' };
    `);
    assert.equal(r.editing, false);
    assert.equal(r.roster, 4);
    assert.equal(r.editbar, false);
    assert.match(r.alert ?? '', /injoignable/);
    assert.equal(r.controlBack, true);
    assert.deepEqual(p.logs.filter((l) => /Unhandled|EXC/.test(l)), []);
    await p.close();
  });

  it('R8-12: the theme toggle retry re-applies only the mode on top of the current theme', async () => {
    const p = await bureau();
    const r = await p.eval(`
      // Another device changes the night window just before the toggle (the page still shows the old VM).
      window.officeBench.om.externalEdit((d) => { d.theme = { ...d.theme, mode: 'auto', nightFrom: '21:00', nightTo: '06:30' }; });
      [...document.querySelectorAll('.ao-bureau__theme .bu-segmented__opt')].find((b) => b.textContent === 'Nuit').click();
      await window.officeBench.until(() => window.officeBench.om.layoutVM().layout.data.theme.mode === 'fixed' && !document.querySelector('.ao-bureau__theme [aria-busy]'));
      return window.officeBench.om.layoutVM().layout.data.theme;
    `);
    assert.equal(r.mode, 'fixed');
    assert.equal(r.fixed, 'night');
    assert.equal(r.nightFrom, '21:00', 'the concurrent schedule survives');
    assert.equal(r.nightTo, '06:30');
    await p.close();
  });

  it('R8-13: the agent drawer traps Tab / Maj+Tab with the background inert', async () => {
    const p = await bureau();
    await p.eval(`const b = [...document.querySelectorAll('.ao-roster')].find((x) => x.querySelector('.ao-roster__name').textContent === 'Scout'); b.focus(); b.click(); await window.officeBench.until(() => document.activeElement.closest('[role=dialog]'));`);
    const seen = [];
    for (let i = 0; i < 6; i++) { await p.key('Tab'); seen.push(await p.eval(`return !!document.activeElement.closest('[role=dialog]');`)); }
    for (let i = 0; i < 3; i++) { await p.key('Tab', { modifiers: 8 }); seen.push(await p.eval(`return !!document.activeElement.closest('[role=dialog]');`)); }
    const inert = await p.eval(`return document.querySelector('.ao-bureau__main').inert === true;`);
    await p.key('Escape');
    const back = await p.eval(`await window.officeBench.until(() => !document.querySelector('.bu-drawer') && !document.querySelector('.ao-bureau__main').inert && document.activeElement.closest('.ao-roster')); return { inert: document.querySelector('.ao-bureau__main').inert, focus: (document.activeElement.querySelector('.ao-roster__name') ?? document.activeElement).textContent.trim() };`);
    assert.ok(seen.every(Boolean), 'focus stays in the drawer');
    assert.equal(inert, true);
    assert.deepEqual(back, { inert: false, focus: 'Scout' });
    await p.close();
  });

  it('O4: the editor works with the keyboard only (open, Personnages, colour, Thème, save)', async () => {
    const p = await bureau();
    const tabTo = async (expr, max = 80) => {
      for (let i = 0; i < max; i++) {
        if (await p.eval(`const a = document.activeElement; return !!(a && (${expr}));`)) return true;
        await p.key('Tab');
      }
      return false;
    };
    await p.eval(`document.body.focus();`);
    assert.ok(await tabTo(`a.matches('.ao-controls [data-page-control]')`), 'reach Personnaliser');
    await p.key('Enter');
    await p.eval(`await window.officeBench.until(() => document.querySelector('.ao-editbar'));`);
    assert.equal(await p.eval(`return !!document.activeElement.closest('.ao-editbar');`), true, 'opening the editor focuses its toolbar');
    assert.ok(await tabTo(`a.matches('.ao-editbar .bu-segmented__opt') && a.textContent === 'Personnages'`), 'reach Personnages');
    await p.key('Enter');
    await p.eval(`await window.officeBench.until(() => document.querySelector('.ao-sc__list'));`);
    // O6: the agent list is the setup step's (one tab stop; arrows move between agents).
    assert.ok(await tabTo(`a.matches('.ao-sc__agent')`), 'reach the agent list');
    for (let i = 0; i < 12 && !(await p.eval(`return document.activeElement.querySelector('.ao-sc__name')?.textContent === 'Nouveaux sous-agents';`)); i++) await p.key('ArrowDown');
    assert.equal(await p.eval(`return document.activeElement.querySelector('.ao-sc__name')?.textContent;`), 'Nouveaux sous-agents', 'reach the default rule');
    await p.key('Enter');
    await p.eval(`await window.officeBench.until(() => document.querySelector('#ao-sc-editing')?.textContent === 'Apparence de Nouveaux sous-agents');`);
    assert.ok(await tabTo(`a.matches('input[name^=ao-sc-var-]')`), 'reach the colour radios');
    const before = await p.eval(`return document.querySelector('input[name^=ao-sc-var-]:checked').parentElement.textContent.trim();`);
    await p.key('ArrowRight');
    await p.eval(`await window.officeBench.until(() => document.querySelector('input[name^=ao-sc-var-]:checked').parentElement.textContent.trim() !== ${JSON.stringify(before)});`);
    const afterColour = await p.eval(`return document.querySelector('input[name^=ao-sc-var-]:checked').parentElement.textContent.trim();`);
    assert.notEqual(afterColour, before, 'arrow keys change the colour');
    assert.ok(await tabTo(`a.matches('.ao-editbar .bu-segmented__opt') && a.textContent === 'Thème'`), 'reach Thème');
    await p.key('Enter');
    await p.eval(`await window.officeBench.until(() => document.querySelector('#ao-theme-title'));`);
    assert.ok(await tabTo(`a.matches('.ao-editpanel .bu-segmented__opt') && a.textContent === 'Nuit'`), 'reach Nuit');
    await p.key('Enter');
    assert.ok(await tabTo(`a.matches('.ao-editbar .bu-btn--primary')`), 'reach Enregistrer');
    await p.key('Enter');
    const r = await p.eval(`await window.officeBench.until(() => !document.querySelector('.ao-office').hasAttribute('data-editing')); const t = window.officeBench.om.layoutVM().layout.data.theme; return { editing: document.querySelector('.ao-office').hasAttribute('data-editing'), fixed: t.fixed, rev: window.officeBench.om.layoutVM().layout.revision };`);
    assert.deepEqual(r, { editing: false, fixed: 'night', rev: 2 });
    await p.close();
  });

  it('the drawer opens the editor on that agent; Annuler returns to the roster', async () => {
    const p = await bureau();
    const r = await p.eval(`
      [...document.querySelectorAll('.ao-roster')].find((b) => b.querySelector('.ao-roster__name').textContent === 'Atlas').click();
      (await window.officeBench.until(() => [...document.querySelectorAll('.bu-drawer button')].find((b) => b.textContent.includes('Personnaliser')))).click();
      await window.officeBench.until(() => document.querySelector('#ao-sc-editing'));
      const card = document.querySelector('#ao-sc-editing')?.textContent;
      const ctrlHidden = getComputedStyle(document.querySelector('.ao-controls [data-page-control]')).display === 'none';
      [...document.querySelectorAll('.ao-editbar button')].find((b) => b.textContent === 'Annuler').click();
      await window.officeBench.until(() => !document.querySelector('.ao-editbar'));
      return { card, ctrlHidden, roster: document.querySelectorAll('.ao-bureau__roster .ao-roster').length, editing: document.querySelector('.ao-office').hasAttribute('data-editing') };
    `);
    assert.deepEqual(r, { card: 'Apparence de Atlas', ctrlHidden: true, roster: 4, editing: false });
    await p.close();
  });
});
