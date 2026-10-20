'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planOfficePlacement } = require('../../src/engine/office/placement.js');
const { launch, findChrome } = require('./helpers/browser');

const skip = findChrome() ? false : 'no Chrome/Chromium binary';
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../design/office/manifest.example.json')));
const layout = JSON.parse(fs.readFileSync(path.join(__dirname, '../../design/office/layout.example.json')));
const index = { manifest,
  rooms: new Map(manifest.rooms.map(row => [row.id, row])),
  furniture: new Map(manifest.furniture.map(row => [row.id, row])),
  characters: new Map(manifest.characters.map(row => [row.id, row])),
  accessories: new Map(manifest.accessories.map(row => [row.id, row])),
  themes: new Map(manifest.themes.map(row => [row.id, row])) };
const out = process.env.T0158_CAPTURE_DIR || path.join(__dirname, '../../design/reports/t0158-monitor-states');

describe('T-0158 active agents return to their desk monitors', { skip, timeout: 120_000 }, () => {
  it('migrates a legacy sofa home on break and shows the active state on the assigned monitor', async () => {
    const now = Date.UTC(2026, 9, 14, 12);
    const occupants = [{ id: 'agent:resume', role: 'agent', state: 'idle', stateSince: now },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `agent:worker-${i}`, role: 'agent', state: 'working', stateSince: now + i + 1 }))];
    const homeAssignments = { 'agent:resume': { floorId: '1', stationUid: 'sofa' } };
    const resumed = planOfficePlacement({ index, layout, occupants: occupants.map(row =>
      row.id === 'agent:resume' ? { ...row, state: 'thinking', stateSince: now + 1 } : row), homeAssignments, now: now + 1 });
    const placement = resumed.placements.find(row => row.id === 'agent:resume');
    assert.ok(placement?.stationUid, 'resumed worker gets a desk when desk capacity exists');
    assert.notEqual(placement.stationUid, 'sofa');
    assert.equal(placement.sceneTarget.mode, 'desk');

    const browser = await launch();
    try {
      const page = await browser.page('/test/office/harness.html');
      await page.waitFor('window.H?.ready');
      const rendered = await page.eval(`
        const intents = await import('/public/v2/office/scene-intents.js');
        const sc = new H.OfficeScene(stage, { manifest: H.manifest, layout: H.layout, assetBase: H.assetBase, theme: 'day', intents });
        sc.setReducedMotion(true);
        const base = { ...H.occupants([{ id: 'agent:resume', role: 'agent', name: 'Reprise', state: 'idle', stateSince: Date.now() }])[0], stationUid: 'sofa' };
        sc.setOccupants([base]);
        const idle = sc.chars.get(base.id);
        await H.until(() => idle?.target?.mode === 'sofa');
        const active = { ...base, state: 'thinking', stateSince: Date.now(), stationUid: ${JSON.stringify(placement.stationUid)} };
        sc.setOccupants([active]);
        await H.until(() => {
          const c = sc.chars.get(active.id);
          return c && !c.walking && c.seatMode === 'desk' && c.target?.uid === active.stationUid
            && c.displayed?.classList.contains('is-in')
            && Number(getComputedStyle(c.displayed).opacity) >= 0.999
            && Number(getComputedStyle(c.el).opacity) >= 0.999
            && !c.el.getAnimations({ subtree: true }).some(animation => animation.playState === 'running');
        });
        const c = sc.chars.get(active.id);
        const monitor = sc.itemNodes.get(active.stationUid)?.parts?.monitor;
        const result = { initialMode: 'sofa', finalSeatMode: c.seatMode, targetMode: c.target?.mode,
          targetUid: c.target?.uid, stationUid: c.occ.stationUid, pose: c.renderedPose,
          monitorSrc: monitor?.getAttribute('src') ?? monitor?.style?.backgroundImage ?? null };
        window.activeScene = sc; return result;
      `);
      assert.equal(rendered.initialMode, 'sofa');
      assert.equal(rendered.finalSeatMode, 'desk');
      assert.equal(rendered.targetMode, 'desk');
      assert.equal(rendered.stationUid, placement.stationUid);
      assert.match(String(rendered.monitorSrc), /thinking-1\.png/);
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'break-to-active.png'), await page.screenshot());

      // Active-from-start follows the same server placement and monitor path.
      const activeFromStart = await page.eval(`
        window.activeScene?.destroy();
        const intents = await import('/public/v2/office/scene-intents.js');
        const sc = new H.OfficeScene(stage, { manifest: H.manifest, layout: H.layout, assetBase: H.assetBase, theme: 'day', intents });
        sc.setReducedMotion(true);
        sc.setOccupants(H.occupants([{ id: 'agent:resume', role: 'agent', name: 'Reprise', state: 'thinking', stateSince: Date.now(), stationUid: ${JSON.stringify(placement.stationUid)} }]));
        await H.until(() => {
          const c = sc.chars.get('agent:resume');
          return c && !c.walking && c.seatMode === 'desk' && c.target?.uid === ${JSON.stringify(placement.stationUid)}
            && c.displayed?.classList.contains('is-in')
            && Number(getComputedStyle(c.displayed).opacity) >= 0.999
            && Number(getComputedStyle(c.el).opacity) >= 0.999
            && !c.el.getAnimations({ subtree: true }).some(animation => animation.playState === 'running');
        });
        const c = sc.chars.get('agent:resume'); const monitor = sc.itemNodes.get(c.occ.stationUid)?.parts?.monitor;
        const value = { seatMode: c.seatMode, target: c.target?.mode, screen: monitor?.getAttribute('src') ?? monitor?.style?.backgroundImage ?? null };
        window.activeScene = sc; return value;
      `);
      assert.equal(activeFromStart.seatMode, 'desk');
      assert.equal(activeFromStart.target, 'desk');
      assert.match(String(activeFromStart.screen), /thinking-1\.png/);
      fs.writeFileSync(path.join(out, 'active-from-start.png'), await page.screenshot());
      await page.eval('window.activeScene?.destroy();');
      await page.close();
    } finally { await browser.close(); }
  });
});
