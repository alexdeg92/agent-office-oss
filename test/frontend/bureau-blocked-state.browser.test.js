import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openLayoutBrowser, visit, browserSkipReason } from './helpers/layout-browser.js';

const skip = browserSkipReason();
const captureDir = 'design/reports/office-activity-0113';

async function injectState(page, state) {
  return page.evaluate(async state => {
    const { services } = await import('/services.js');
    const stream = services.stream;
    const office = structuredClone(stream._topics.get('office').state.data);
    const layout = structuredClone(stream._topics.get('layout').state.data);
    stream.stop();
    stream.status.set({ conn: 'open' });
    const occupant = office.occupants.find(row => row.role === 'main' || row.role === 'primary') || office.occupants[0];
    if (!occupant) throw new Error('fixture office has no occupant');
    occupant.state = state;
    occupant.stateActive = false;
    occupant.stateLabel = { key: `agentState.${state}` };
    occupant.stateDetailLabel = { key: `agentState.${state}` };
    occupant.stateLastLabel = { key: `agentState.${state}` };
    stream.applyVM('layout', layout);
    stream.applyVM('office', office);
    return { id: occupant.id, name: occupant.name };
  }, state);
}

test('blocked and executing states use reviewed scene, roster and drawer visuals across themes and breakpoints', { skip, timeout: 180_000 }, async () => {
  await mkdir(captureDir, { recursive: true });
  for (const theme of ['light', 'dark']) for (const [view, width, height, touch] of [
    ['desktop', 1440, 900, false], ['mobile', 390, 844, true], ['mobile-small', 375, 667, true],
  ]) {
    const h = await openLayoutBrowser({ theme, touch });
    const { page } = h;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height });
      await visit(page, h.origin, '/bureau?mock=foule', '.ao-bureau__stage');
      let occupant = null;
      for (const state of ['blocked', 'executing']) {
        occupant = await injectState(page, state);
        const character = page.locator(`.ao-char[data-occupant="${occupant.id}"][data-state="${state}"]`);
        await character.waitFor({ state: 'visible' });
        assert.equal(await character.getAttribute('data-state'), state);
        await character.locator('.ao-pose.is-in img[data-layer="body"]:visible').first().waitFor({ state: 'visible' });
        const markerKind = state === 'blocked' ? 'alert' : 'executing';
        const marker = page.locator(`.ao-marker[data-state="${state}"][data-kind="${markerKind}"]:not([hidden])`);
        await marker.locator(state === 'blocked' ? '.ao-mk--solid' : '.ao-mk--executing').waitFor({ state: 'visible' });
        assert.equal(await marker.getAttribute('data-kind'), markerKind);
        const row = width <= 480
          ? page.locator(`.ao-mobile-roster [data-mobile-agent="${occupant.id}"]`)
          : page.locator(`.ao-bureau__roster [data-occupant="${occupant.id}"]`);
        await row.waitFor({ state: 'visible' });
        const label = state === 'blocked' ? 'Bloqué' : 'Exécute';
        assert.equal((await row.locator('.ao-roster__state').innerText()).trim(), label);
        const icon = await row.locator('.ao-roster__state svg use').getAttribute('href');
        assert.equal(icon, state === 'blocked' ? '#i-state-error' : '#i-tool-exec');
        if (state === 'blocked') {
          const color = await row.locator('.ao-roster__state').evaluate(element => getComputedStyle(element).color);
          const danger = await page.locator('body').evaluate(element => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--bu-state-error)';
            element.append(probe);
            const value = getComputedStyle(probe).color;
            probe.remove();
            return value;
          });
          assert.equal(color, danger, 'blocked label uses the established alert color');
        }
        await page.screenshot({ path: `${captureDir}/${view}-${width}-${theme}-${state}.png`, animations: 'disabled' });
        if (state === 'blocked') await row.click();
        const drawer = page.locator(`.ao-drawer__state[data-agent-state="${state}"]`);
        await drawer.waitFor({ state: 'visible' });
        assert.equal((await drawer.innerText()).trim(), label);
        await page.screenshot({ path: `${captureDir}/${view}-${width}-${theme}-${state}-drawer.png`, animations: 'disabled' });
      }
      assert.deepEqual(errors, []);
    } finally {
      await h.close();
    }
  }
});
