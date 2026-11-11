import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { openLayoutBrowser, browserSkipReason } from './helpers/layout-browser.js';

test('T-0249 project-team grouping storyboard captures', { skip: browserSkipReason(), timeout: 90000 }, async () => {
  let browser;
  try {
    browser = await openLayoutBrowser({ testTimeoutMs: 90000 });
    const { page } = browser;
    const root = resolve('design/reports/t0249-team-groups');
    let html = await readFile(resolve(root, 'index.html'), 'utf8');
    for (const file of ['atlas.png','scribe.png','nox.png','beacon.png','lumen.png','atlas-stage.png','scribe-stage.png','nox-stage.png','beacon-stage.png','lumen-stage.png','room-office-light.png','room-office-dark.png']) {
      const bytes = await readFile(resolve(root, 'assets', file));
      html = html.replaceAll(`assets/${file}`, `data:image/png;base64,${bytes.toString('base64')}`);
    }
    for (const file of ['openclaw.svg','claude-code.svg','codex.svg']) {
      const bytes = await readFile(resolve('public/v2/assets/connectors', file), 'utf8');
      html = html.replaceAll(`../../../public/v2/assets/connectors/${file}`, `data:image/svg+xml;base64,${Buffer.from(bytes).toString('base64')}`);
    }
    for (const frame of [
      { width: 1440, height: 900, name: '1440' },
      { width: 390, height: 844, name: '390' },
    ]) {
      await page.setViewportSize({ width: frame.width, height: frame.height });
      for (const theme of ['light', 'dark']) {
        await page.setContent(html, { waitUntil: 'load' });
        await page.locator('body').evaluate((body, value) => { body.dataset.theme = value; }, theme);
        await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.locator('.scene-image:visible').count(), 1, `${frame.name} ${theme}: only the matching room image is visible`);
        const codexFilter = await page.locator('.runtime img[data-provider="codex"]').first().evaluate(node => getComputedStyle(node).filter);
        assert.equal(codexFilter.includes(theme === 'dark' ? 'invert(1)' : 'brightness(0)'), true, `${frame.name} ${theme}: Codex mark has contrast on the current surface`);
        assert.equal(await page.locator('[data-team-card]').count(), 2);
        assert.equal(await page.locator('.team-floor-tag').count(), 2, `${frame.name} ${theme}: both team labels are anchored to the floor`);
        assert.equal(await page.locator('.scene-character').count(), 5, `${frame.name} ${theme}: the office stage contains five seated agents`);
        assert.equal(await page.locator('.scene-character[data-agent="atlas"]').count(), 1, `${frame.name} ${theme}: shared lead appears once in the room`);
        assert.match(await page.locator('.team-floor-tag[data-team="vce"]').innerText(), /Plateforme VCE\s+↗ Atlas · responsable partagé/);
        assert.equal(await page.locator('.room-pod, .room-pod-people').count(), 0, 'no floating group/avatar cards over the room');
        assert.equal(await page.locator('.team-card .team-project, .team-card .group-footer').count(), 0, 'no repeated team subtitle/footer labels');
        assert.equal((await page.locator('.team-card').allTextContents()).join(' ').includes('Domaine Kildare'), true);
        assert.equal((await page.locator('.team-card').allTextContents()).join(' ').includes('Plateforme VCE'), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${frame.name} ${theme}: no horizontal overflow`);
        const cards = await page.locator('[data-team-card]').evaluateAll(nodes => nodes.map(node => {
          const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        }));
        assert.ok(cards.every(card => card.left >= 0 && card.right <= frame.width), `${frame.name} ${theme}: team groups stay inside the viewport`);
        const stage = await page.locator('.scene-stage').boundingBox();
        const canvas = await page.locator('.scene-canvas').boundingBox();
        const room = await page.locator('.scene-image:visible').boundingBox();
        assert.ok(canvas.x - stage.x >= 7.5 && stage.x + stage.width - canvas.x - canvas.width >= 7.5, `${frame.name} ${theme}: room art keeps an 8px horizontal inset`);
        assert.ok(room.width >= canvas.width * .98, `${frame.name} ${theme}: room artwork fills its inset canvas`);
        const groupPanel = await page.locator('.groups-card').boundingBox();
        const sceneCard = await page.locator('.scene-card').boundingBox();
        if (frame.width === 390) {
          assert.ok(Math.abs(groupPanel.width - sceneCard.width) <= 2, `${theme}: team panel fills the same content width as the room`);
          assert.ok(Math.abs(groupPanel.x - sceneCard.x) <= 1 && Math.abs(groupPanel.x + groupPanel.width - sceneCard.x - sceneCard.width) <= 1, `${theme}: team panel aligns with the room card edges`);
        }
        const stageNodes = await page.locator('.scene-character, .team-floor-tag').evaluateAll(nodes => nodes.map(node => {
          const r = node.getBoundingClientRect(); return { name: node.className, left:r.left, right:r.right, top:r.top, bottom:r.bottom };
        }));
        assert.ok(stageNodes.every(node => node.left >= canvas.x && node.right <= canvas.x + canvas.width && node.top >= canvas.y && node.bottom <= canvas.y + canvas.height), `${frame.name} ${theme}: characters and floor labels stay inside the 8px room inset`);
        const tags = stageNodes.filter(node => node.name === 'team-floor-tag');
        const chars = stageNodes.filter(node => node.name === 'scene-character');
        const collisions = tags.flatMap(tag => chars.filter(char => !(tag.right <= char.left || tag.left >= char.right || tag.bottom <= char.top || tag.top >= char.bottom)).map(char => `${tag.name} with ${char.name}`));
        assert.equal(collisions.length, 0, `${frame.name} ${theme}: floor labels do not cover characters (${collisions.join(', ')})`);
        const podCenters = await page.locator('.team-pod-zone').evaluateAll(nodes => nodes.map(node => {
          const r=node.getBoundingClientRect(); return { team:node.dataset.team, x:r.left+r.width/2, y:r.top+r.height/2 };
        }));
        assert.equal(podCenters.length, 2, `${frame.name} ${theme}: two separate team desk pods are visible`);
        assert.ok(podCenters[0].x < podCenters[1].x - canvas.width * .25, `${frame.name} ${theme}: desk pods read as distinct left and right teams`);
        const tagCenters = await page.locator('.team-floor-tag').evaluateAll(nodes => nodes.map(node => {
          const r=node.getBoundingClientRect(); return { team:node.dataset.team, x:r.left+r.width/2, y:r.top+r.height/2 };
        }));
        for (const tag of tagCenters) {
          const pod = podCenters.find(item => item.team === tag.team);
          assert.ok(Math.abs(tag.x-pod.x) < canvas.width * .18 && tag.y > pod.y, `${frame.name} ${theme}: ${tag.team} floor label sits in front of its desk pod`);
        }
        if (frame.width === 390) {
          assert.equal(await page.locator('.floor-next').isVisible(), true, `${theme}: mobile floor switcher is visible`);
          const floor = await page.locator('.floor-next').boundingBox();
          assert.ok(floor.x >= 0 && floor.x + floor.width <= frame.width, `${theme}: floor switcher fits the phone viewport`);
        }
        await mkdir('design/reports/t0249-team-groups/captures', { recursive: true });
        await page.screenshot({ path: `design/reports/t0249-team-groups/captures/${frame.name}-${theme}.png`, animations: 'disabled' });
      }
    }
  } finally {
    await browser?.close();
  }
});
