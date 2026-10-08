'use strict';
// office-dev-22/24 in the Bureau (harness, scenario « visite », a Discord DM, API 2.x). A message → the person comes to
// the agent's desk; while the exchange is in flight the agent swivels in his chair to face the visitor in seated talking
// poses, and the « … » bubble alternates (the person's message first, then the agent's reply run, the person « En
// attente »). The run over → no bubble, the agent back at his desk, the person idle for a minute, then walks out. A
// second message within 10 min → both at the meeting table. Names stay visible. Reduced motion: people snap.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launch, findChrome } = require('./helpers/browser');

const skip = findChrome() ? false : 'no Chrome/Chromium binary (set CHROME_BIN)';
let browser;
before(async () => { if (!skip) browser = await launch(); });
after(async () => { await browser?.close(); });

const read = `const sc = document.querySelector('.ao-bureau__stage').aoScene;
  const of = (id) => { const c = sc.chars.get(id); if (!c || c.leaving) return 'gone';
    return { at: c.visit?.key ?? null, talk: c.visit?.talk ?? null, facing: c.visit?.facing ?? null, pose: sc._currentPose(c), drawn: c.renderedPose, deskTalk: !!c.deskTalk, seatMode: c.seatMode }; };
  const pos = (id) => { const r = document.querySelector('.ao-char[data-occupant="' + id + '"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom }; };
  const m = of('main'), v = of('dm:camille');
  return { main: m, visitor: v, dist: m !== 'gone' && v !== 'gone' ? Math.round(Math.hypot(pos('main').x - pos('dm:camille').x, pos('main').y - pos('dm:camille').y)) : null,
    bubbles: [...document.querySelectorAll('.ao-plate[data-talking]')].map((p) => p.querySelector('.ao-plate__name').textContent),
    names: [...document.querySelectorAll('.ao-plate__name')].map((n) => n.textContent),
    pills: [...document.querySelectorAll('.ao-roster')].map((r) => r.querySelector('.ao-roster__name').textContent + ':' + r.querySelector('.ao-roster__state').innerText.trim()) };`;
// wait until nobody walks (the stage element carries its scene: aoScene)
const settle = `const sc0 = document.querySelector('.ao-bureau__stage').aoScene; await window.officeBench.until(() => [...sc0.chars.values()].every((c) => !c.walking), 20000); await new Promise((r) => setTimeout(r, 400));`;
// the clock moves by `ms` (the mock and the page read Date.now); `tick` advances the scenario one step
const later = (ms, tick = false) => `window.__off = (window.__off ?? 0) + ${ms}; const B = window.officeBench; ${tick ? 'B.om.tick();' : ''} await B.publish('office'); await new Promise((r) => setTimeout(r, 300));`;

describe('visits in the Bureau (office-dev-22, office-dev-24)', { skip, timeout: 120_000 }, () => {
  it('message → talking with the agent at his desk (bubble alternates); over → idle, then out; again → meeting table', async () => {
    const p = await browser.page('/public/v2/office/bureau-dev.html?tick=600000&nom=Orion&scenario=visite');
    await p.eval(`const real = Date.now; Date.now = () => real() + (window.__off ?? 0);`);
    await p.waitFor(`document.querySelector('.ao-char[data-occupant="dm:camille"]')`);
    // 1. the person's message: the visitor talks (bubble), the host turns in his chair to face them
    const a = await p.eval(`await new Promise((r) => setTimeout(r, 800)); ${settle} ${read}`);
    assert.deepEqual([a.visitor.at, a.visitor.talk, a.main.at, a.main.talk], ['d0', true, null, null]);
    assert.equal(a.main.deskTalk, true);
    assert.equal(a.main.seatMode, 'desk', 'the host stays seated');
    assert.equal(a.visitor.facing, 'se', 'visitor faces the seated host');
    assert.deepEqual([a.main.pose, a.main.drawn, a.visitor.pose], ['seated-talking-sw', 'sofa-sit-sw', 'talking-se'], 'the host uses the proven seated frame');
    assert.ok(a.dist < 140, `side by side (${a.dist}px)`);
    assert.deepEqual(a.bubbles, ['Camille']);
    assert.deepEqual(a.names.sort(), ['Camille', 'Orion'], 'names stay visible');
    assert.deepEqual(a.pills, ['Orion:Exécute', 'Camille:Exécute']);
    // 2. the agent's reply run (still running): his bubble; the person waits for the reply
    const b = await p.eval(`${later(15_000)} ${read}`);
    assert.deepEqual(b.bubbles, ['Orion']);
    assert.deepEqual([b.visitor.talk, b.main.deskTalk], [true, true]);
    assert.deepEqual(b.pills, ['Orion:Exécute', 'Camille:En attente']);
    // 3. the run is over: no bubble, no talking; the agent back at his desk, the person idle where they stood
    const c = await p.eval(`${later(1000, true)} ${settle} ${read}`);
    assert.deepEqual(c.bubbles, []);
    assert.deepEqual([c.main.at, c.visitor.at, c.visitor.talk], [null, 'd0', false]);
    assert.match(c.visitor.pose, /^idle/);
    assert.deepEqual(c.pills, ['Orion:Inactif', 'Camille:Inactif']);
    // 4. a minute later the person walks out
    const d = await p.eval(`${later(61_000)} await window.officeBench.until(() => { const c = document.querySelector('.ao-bureau__stage').aoScene.chars.get('dm:camille'); return !c || c.leaving; }, 10000); ${read}`);
    assert.equal(d.visitor, 'gone');
    // 5. a second message within 10 minutes: a conversation → both at the meeting table, the person's bubble
    const e0 = await p.eval(`${later(1000, true)} ${read}`);
    assert.deepEqual(e0.bubbles, ['Camille'], 'the person’s message first');
    const e = await p.eval(`${settle} ${read}`);
    assert.deepEqual([e.main.at?.[0], e.visitor.at?.[0], e.main.talk, e.visitor.talk], ['t', 't', true, true]);
    await p.close();
  });

  it('reduced motion: visitors and the agent snap to their spots (no walk)', async () => {
    const p = await browser.page('/test/office/harness.html');
    await p.waitFor('window.H && window.H.ready');
    const r = await p.eval(`
      const sc = new H.OfficeScene(document.getElementById('stage'), { manifest: H.manifest, layout: H.layout, assetBase: H.assetBase, theme: 'day' });
      sc.setReducedMotion(true);
      sc.setOccupants(H.occupants([{ id: 'main', role: 'main', sourceName: 'Orion', state: 'working', stateSince: Date.now() },
        { id: 'dm:camille', role: 'dm', sourceName: 'Camille', state: 'working', stateSince: Date.now() }]));
      await new Promise((r) => setTimeout(r, 500));
      sc.setVisits({ hostId: 'main', desk: [], meeting: ['main', 'dm:camille'], talking: true, speaker: 'dm:camille' });
      const at = (id) => { const c = sc.chars.get(id); return { walking: c.walking, there: !!c.target && Math.abs(c.pos.x - c.target.x) < 0.01 && Math.abs(c.pos.y - c.target.y) < 0.01, visit: c.el.dataset.visit ?? null }; };
      const now = { main: at('main'), visitor: at('dm:camille') };
      sc.setVisits(null);
      const back = at('main');
      return { now, back };`);
    assert.deepEqual(r.now, { main: { walking: false, there: true, visit: 'meeting' }, visitor: { walking: false, there: true, visit: 'meeting' } });
    assert.deepEqual(r.back, { walking: false, there: true, visit: null });
    await p.close();
  });
});
