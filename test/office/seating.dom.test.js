'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch, findChrome } = require('./helpers/browser');
const skip = findChrome() ? false : 'no Chrome/Chromium binary';
let browser;
before(async () => { if (!skip) browser = await launch(); });
after(async () => { await browser?.close(); });

describe('office-dev-25: hip-on-seat chair composition', { skip, timeout: 120_000 }, () => {
  it('a long-idle host returns from the sofa to his chair to talk, then resumes lounging', async () => {
    const p = await browser.page('/test/office/harness.html');
    await p.waitFor('window.H?.ready');
    const result = await p.eval(`
      const sc = new H.OfficeScene(stage, { manifest: H.manifest, layout: H.layout, assetBase: H.assetBase, theme: 'day' });
      sc.setReducedMotion(true);
      sc.setOccupants(H.occupants([{ id: 'main', role: 'main', sourceName: 'Atlas', state: 'idle', stateSince: Date.now()-3600000 },
        { id: 'dm:camille', role: 'dm', sourceName: 'Camille', state: 'working', stateSince: Date.now() }]));
      const c = sc.chars.get('main');
      const before = c.seatMode;
      sc.setVisits({ hostId: 'main', desk: ['dm:camille'], meeting: [], talking: true, speaker: 'main' });
      const during = { mode: c.seatMode, drawn: c.renderedPose, deskTalk: c.deskTalk, bubble: c.plate.hasAttribute('data-talking') };
      sc.setVisits(null);
      const after = c.seatMode;
      sc.destroy();return { before, during, after };
    `);
    assert.deepEqual(result, { before: 'sofa', during: { mode: 'desk', drawn: 'sofa-sit-sw', deskTalk: true, bubble: true }, after: 'sofa' });
    await p.close();
  });

  it('every shipped look and seated state keeps its hip on the cushion, between the chair and front armrest, at 1440 and 360', async () => {
    const p = await browser.page('/test/office/harness.html');
    await p.waitFor('window.H?.ready');
    for (const width of [1440, 360]) {
      await p.viewport(width, 900);
      const failures = await p.eval(`
        stage.style.width = '${width}px';
        const sc = new H.OfficeScene(stage, { manifest: H.manifest, layout: H.layout, assetBase: H.assetBase, theme: 'day' });
        sc.setReducedMotion(true);
        const errors = [];
        const states = ['working','writing','researching','thinking','idle','waiting','calling','offline','error'];
        const check = async (label, front = false) => {
          const c = sc.chars.get('main');
          await H.until(() => c.displayed === c.poseEl && c.displayed?.classList.contains('is-in'));
          await H.frames(2);
          const n = sc.itemNodes.get(c.seatUid);
          const img = n.parts['seated:' + (front ? 'chair-turn' : 'chair')];
          const arm = n.parts['seated:' + (front ? 'chair-turn-front' : 'chair-front')];
          const k = parseFloat(c.el.style.width) / c.poseCanvas.w;
          const xy = c.el.style.transform.match(/translate\\(([-.\\d]+)px, ([-.\\d]+)px\\)/).slice(1).map(Number);
          if (Math.abs(xy[0] + c.poseSeat.x * k - n.seatWorld.sx) > .001 || Math.abs(xy[1] + c.poseSeat.y * k - n.seatWorld.sy) > .001) errors.push(label + ': hip misses seat');
          if (!(Number(img.style.zIndex) < Number(c.el.style.zIndex) && Number(c.el.style.zIndex) < Number(arm.style.zIndex))) errors.push(label + ': wrong chair layer order');
          if (img.hidden || arm.hidden || !arm.style.clipPath.startsWith('polygon(')) errors.push(label + ': armrest not painted');
          const chairs = Object.entries(n.parts).filter(([name, el]) => name.includes('chair') && !el.hidden);
          if (chairs.length !== 2) errors.push(label + ': duplicate chair facings');
          if (front && c.renderedPose !== 'sofa-sit-sw') errors.push(label + ': not using the proven seated frame');
          const bodies = [...c.displayed.querySelectorAll('[data-layer=body]')].filter(i => !i.hidden);
          if (bodies.length !== 1 || bodies.some(i => !i.complete || !i.naturalWidth)) errors.push(label + ': body frame missing');
          if ([...c.displayed.querySelectorAll('img')].some(i => i.naturalWidth !== c.poseCanvas.w)) errors.push(label + ': accessory canvas mismatch');
        };
        for (const ch of H.manifest.characters) for (const variant of ch.variants?.length ? ch.variants : [{ id: null }]) {
          const label = ch.id + '/' + variant.id;
          for (const state of states) {
            sc.setOccupants([{ id: 'main', role: 'main', sourceName: label, state, stateSince: Date.now(), stationUid: 'st-timmy', look: { character: ch.id, variant: variant.id, accessories: ['cap','headphones','scarf'] } }]);
            await check(label + ':' + state, state === 'error');
          }
          const c = sc.chars.get('main');
          c.occ.state = 'working'; c.wave = true; sc._renderPose(c);
          await check(label + ':selection', true);
          const expectedOrigin = [c.poseSeat.x * c.poseScale / sc.proj.artScale, c.poseSeat.y * c.poseScale / sc.proj.artScale];
          const origin = c.displayed.style.transformOrigin.split(' ').map(parseFloat);
          if (origin.some((v, i) => Math.abs(v - expectedOrigin[i]) > .001)) errors.push(label + ': wave pivots away from hip');
          c.wave = false;
          for (const cue of ['talking','delegating','celebrating']) {
            c.cue = cue; sc._renderPose(c); await check(label + ':' + cue, true);
            if (c.el.dataset.motion === 'hop') errors.push(label + ': hips leave seat during celebration');
          }
          c.cue = null;
        }
        sc.destroy(); return errors;
      `);
      assert.deepEqual(failures, [], `${width}px seated state matrix`);
    }
    assert.deepEqual(p.logs, []);
    await p.close();
  });
});
