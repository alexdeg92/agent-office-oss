'use strict';
// T-0122 B / deployed talk-at-desk hotfix: a legacy visit plan animates each
// participant at their own station. Repeated messages or a legacy `meeting`
// array do not admit a physical meeting. Canonical backend meeting targets are
// covered by office-communication engine/API and real browser tests.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch, findChrome } = require('./helpers/browser');

const skip = findChrome() ? false : 'no Chrome/Chromium binary (set CHROME_BIN)';
let browser;
before(async () => { if (!skip) browser = await launch(); });
after(async () => { await browser?.close(); });

const read = `const sc = document.querySelector('.ao-bureau__stage').aoScene;
  const of = (id) => { const c = sc.chars.get(id); if (!c || c.leaving) return 'gone';
    return { at: c.visit?.key ?? null, talk: c.visit?.talk ?? null, pose: sc._currentPose(c), drawn: c.renderedPose,
      deskTalk: !!c.deskTalk, seatMode: c.seatMode, point: c.pos, stationUid: c.occ.stationUid, targetUid: c.target?.uid }; };
  const m = of('main'), v = of('dm:camille');
  return { main: m, visitor: v,
    bubbles: [...document.querySelectorAll('.ao-life-bubble')].map((p) => p.textContent),
    markers: [...sc.chars.values()].filter(c => !c.marker.hidden).map(c => c.id),
    names: [...document.querySelectorAll('.ao-plate__name')].map((n) => n.textContent),
    pills: [...document.querySelectorAll('.ao-roster')].map((r) => r.querySelector('.ao-roster__name').textContent + ':' + r.querySelector('.ao-roster__state').innerText.trim()) };`;
// wait until nobody walks (the stage element carries its scene: aoScene)
const settle = `const sc0 = document.querySelector('.ao-bureau__stage').aoScene; await window.officeBench.until(() => [...sc0.chars.values()].every((c) => !c.walking), 20000); await new Promise((r) => setTimeout(r, 400));`;
// the clock moves by `ms` (the mock and the page read Date.now); `tick` advances the scenario one step
const later = (ms, tick = false) => `window.__off = (window.__off ?? 0) + ${ms}; const B = window.officeBench; ${tick ? 'B.om.tick();' : ''} await B.publish('office'); await new Promise((r) => setTimeout(r, 300));`;

describe('desk conversations in the Bureau (T-0122 B)', { skip, timeout: 120_000 }, () => {
  it('messages animate each participant at their own desk; repeats do not schedule a physical meeting', async () => {
    const p = await browser.page('/public/v2/office/bureau-dev.html?tick=600000&nom=Orion&scenario=visite');
    await p.eval(`const real = Date.now; Date.now = () => real() + (window.__off ?? 0);`);
    await p.waitFor(`document.querySelector('.ao-char[data-occupant="dm:camille"]')`);
    // 1. A message animates both assigned desks, without overhead bubbles.
    const a = await p.eval(`await new Promise((r) => setTimeout(r, 800)); ${settle} ${read}`);
    for (const row of [a.main,a.visitor]) {
      assert.equal(row.at,null);assert.equal(row.deskTalk,true);assert.equal(row.seatMode,'desk');
      assert.equal(row.targetUid,row.stationUid);assert.equal(row.pose,'seated-talking-sw');
    }
    assert.notEqual(a.main.stationUid,a.visitor.stationUid,'participants keep distinct own stations');
    assert.deepEqual(a.bubbles,[]);assert.deepEqual(a.markers,[]);
    assert.deepEqual(a.names.sort(), ['Camille', 'Orion'], 'names stay visible');
    assert.deepEqual(a.pills, ['Orion:Travaille', 'Camille:Travaille']);
    // 2. Reply/waiting state changes screens; neither participant moves.
    const b = await p.eval(`${later(15_000)} ${read}`);
    assert.deepEqual(b.bubbles,[]);assert.deepEqual(b.markers,[]);
    assert.deepEqual([b.main.point,b.visitor.point],[a.main.point,a.visitor.point]);
    assert.deepEqual([b.visitor.deskTalk,b.main.deskTalk],[true,true]);
    assert.deepEqual(b.pills, ['Orion:Travaille', 'Camille:En attente']);
    // 3. The exchange ends; both keep their home positions and stop talking.
    const c = await p.eval(`${later(1000, true)} ${settle} ${read}`);
    assert.deepEqual(c.bubbles, []);
    assert.deepEqual([c.main.at,c.visitor.at,c.main.deskTalk,c.visitor.deskTalk],[null,null,false,false]);
    assert.deepEqual([c.main.point,c.visitor.point],[a.main.point,a.visitor.point]);
    assert.deepEqual(c.pills, ['Orion:Inactif', 'Camille:Inactif']);
    // 4. a minute later the person walks out
    const d = await p.eval(`${later(61_000)} await window.officeBench.until(() => { const c = document.querySelector('.ao-bureau__stage').aoScene.chars.get('dm:camille'); return !c || c.leaving; }, 10000); ${read}`);
    assert.equal(d.visitor, 'gone');
    // 5. Even the old repeat-message meeting array keeps both at their desks.
    const e = await p.eval(`${later(1000, true)} ${settle} ${read}`);
    for(const row of [e.main,e.visitor]){assert.equal(row.at,null);assert.equal(row.targetUid,row.stationUid);assert.equal(row.deskTalk,true);}
    assert.deepEqual(e.bubbles,[]);assert.deepEqual(e.markers,[]);
    assert.deepEqual([e.main.point,e.visitor.point],[a.main.point,a.visitor.point]);
    await p.close();
  });

  it('reduced motion: legacy meeting requests keep participants at their own desks', async () => {
    const p = await browser.page('/test/office/harness.html');
    await p.waitFor('window.H && window.H.ready');
    const r = await p.eval(`
      const sc = new H.OfficeScene(document.getElementById('stage'), { manifest: H.manifest, layout: H.layout, assetBase: H.assetBase, theme: 'day' });
      sc.setReducedMotion(true);
      sc.setOccupants(H.occupants([{ id: 'main', role: 'main', sourceName: 'Orion', state: 'working', stateSince: Date.now() },
        { id: 'dm:camille', role: 'dm', sourceName: 'Camille', state: 'working', stateSince: Date.now() }]));
      await new Promise((r) => setTimeout(r, 500));
      const at = (id) => { const c = sc.chars.get(id); return { walking: c.walking, there: !!c.target && Math.abs(c.pos.x - c.target.x) < 0.01 && Math.abs(c.pos.y - c.target.y) < 0.01, visit: c.el.dataset.visit ?? null, point: c.pos, stationUid:c.occ.stationUid,targetUid:c.target?.uid,deskTalk:!!c.deskTalk }; };
      const home = {main:at('main'),visitor:at('dm:camille')};
      sc.setVisits({ hostId: 'main', desk: [], meeting: ['main', 'dm:camille'], talking: true, speaker: 'dm:camille' });
      const now = { main: at('main'), visitor: at('dm:camille') };
      sc.setVisits(null);
      const back = at('main');
      return { home, now, back };`);
    for(const id of ['main','visitor']){
      assert.equal(r.now[id].walking,false);assert.equal(r.now[id].there,true);assert.equal(r.now[id].visit,null);
      assert.equal(r.now[id].targetUid,r.home[id].stationUid);assert.deepEqual(r.now[id].point,r.home[id].point);
      assert.equal(r.now[id].deskTalk,true);
    }
    assert.equal(r.back.walking,false);assert.equal(r.back.there,true);assert.equal(r.back.visit,null);
    assert.equal(r.back.deskTalk,false);assert.deepEqual(r.back.point,r.home.main.point);
    await p.close();
  });
});
