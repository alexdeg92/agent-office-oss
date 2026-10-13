import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openLayoutBrowser, visit, browserSkipReason } from './helpers/layout-browser.js';

const skip = browserSkipReason();
const labels = { fr: ['Inconnu', 'Activité observée', 'Travaille'], en: ['Unknown', 'Activity observed', 'Working'] };

async function capture(page, name) {
  if (process.env.BUREAU_SCREENSHOTS !== '1') return;
  await mkdir('design/reports/office-dev-70/captures', { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)
      .map(a => a.finished.catch(() => {})));
  });
  await page.screenshot({ path: `design/reports/office-dev-70/captures/${name}.jpg`, type: 'jpeg', quality: 88, animations: 'disabled' });
}

test('Office evidence labels and neutral/live states render in the actual shell (FR/EN, desktop/mobile, light/dark)',
  { skip, timeout: 180000 }, async t => {
    const browser = await openLayoutBrowser();
    const { page } = browser;
    t.after(() => browser.close());
    const captures = [];
    for (const lang of ['fr', 'en']) for (const theme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await visit(page, browser.origin, `/bureau?mock=foule&lang=${lang}&theme=${theme}`, '.ao-bureau__stage');
      await page.evaluate(async lang => {
        const { buildQuery } = await import('/config.js');
        const { setLang } = await import('/i18n.js' + buildQuery);
        setLang(lang); document.documentElement.lang = lang;
      }, lang);
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      // Since 0e731fb0 (T-0092) the roster renders the OfficeVM's projected state LabelRefs, not a label derived from
      // `state` in the browser: an injected state carries the same projection.
      const ids = await page.evaluate(async lang => {
        const project = (o, state) => {   // the OfficeVM's server projection of a state (src/api/v2/vm/office-roster.js)
          o.state = state; o.stateActive = !['unknown', 'idle', 'offline'].includes(state);
          o.stateLabel = { key: 'agentState.' + state }; o.stateDetailLabel = { key: 'agentState.' + state };
          o.stateLastLabel = { key: 'office.lastState', params: { state: { key: 'agentState.' + state } } };
        };
        const { services } = await import('/services.js');
        const stream = services.stream;
        const office = structuredClone(stream._topics.get('office').state.data);
        const layout = structuredClone(stream._topics.get('layout').state.data);
        stream.stop(); stream.status.set({ conn: 'open' });
        // Connected and fresh: drop source staleness a REST load may have left on the topic when it answered after the
        // stream snapshot (the mock always reports `cli.skills` stale, which would turn every row into « last state »).
        stream._topics.get('office').meta = null;
        office.occupants.forEach((o, i) => {
          if (i < 3) project(o, ['unknown', 'observed', 'working'][i]);
          // Two conservative states and one verified execution; expose no result or evidence timestamp in the UI.
          o.execution = i === 2
            ? { status: 'running', evidence: { level: 'verified', observedAt: 1791223100000, expiresAt: null } }
            : { status: 'unknown', evidence: { level: 'unknown', observedAt: null, expiresAt: null } };
          for (const field of ['sessionKey', 'parentId', 'lastSeenAt', 'lastActivityAt', 'startedAt', 'summary', 'project', 'model', 'runtime', 'exchanges', 'tokensKnown']) delete o[field];
          o.tokens = 0;
          o.stateSince = 0;
        });
        // An unknown occupant makes the server's active count unknown (office-roster.js rosterSummary).
        if (office.rosterSummary) office.rosterSummary.activeCount = null;
        const active = office.kpis.find(k => k.id === 'active');
        if (active) {
          active.value = null;
          active.sub = { key: 'kpi.stateUnknown' };
        }
        stream.applyVM('layout', layout); stream.applyVM('office', office);
        return office.occupants.slice(0, 3).map(o => o.id);
      }, lang);
      const base = `evidence-${lang}-${width}-${theme}`;
      const mobile = width < 820;
      const rosterRows = mobile ? page.locator('.ao-mobile-roster [data-mobile-agent]') : page.locator('.ao-bureau__side [data-occupant]');
      for (let i = 0; i < ids.length; i++) {
        const row = mobile ? page.locator(`.ao-mobile-roster [data-mobile-agent="${ids[i]}"]`) : page.locator(`.ao-bureau__side [data-occupant="${ids[i]}"]`);
        await row.waitFor({ state: 'visible' });
        const state = row.locator(`.bu-state[data-agent-state="${['unknown', 'observed', 'working'][i]}"]`);
        assert.equal(await state.innerText(), labels[lang][i]);
        assert.equal(await state.locator('svg use').getAttribute('href'), i < 2 ? '#i-info' : '#i-state-working');
      }
      assert.ok(await rosterRows.count() >= 3, 'three state examples appear in the roster');
      await page.waitForFunction(() => document.querySelector('.bu-kpi__value')?.textContent?.trim() === '—');
      assert.ok((await page.locator('.bu-kpi__value').evaluateAll(es => es.map(e => e.textContent.trim()))).includes('—'),
        'an unknown execution never appears as a concrete active count');
      await page.waitForFunction(lang => (document.querySelector('.bu-kpi__sub')?.textContent ?? '').toLowerCase().includes(lang === 'fr' ? 'activité inconnue' : 'activity unknown'), lang);
      if (mobile) assert.match(await page.locator('.ao-mobile-summary summary').innerText(), lang === 'fr' ? /activité inconnue/i : /activity unknown/i,
        'mobile summary preserves unavailable activity instead of counting unknown agents');
      await capture(page, `${base}-roster`); captures.push(`${base}-roster.jpg`);
      for (let i = 0; i < ids.length; i++) {
        const row = mobile ? page.locator(`.ao-mobile-roster [data-mobile-agent="${ids[i]}"]`) : page.locator(`.ao-bureau__side [data-occupant="${ids[i]}"]`);
        await row.click();
        const drawer = page.locator('.bu-drawer'); await drawer.waitFor({ state: 'visible' });
        const drawerState = drawer.locator('.ao-drawer__state');
        await page.waitForFunction(({ id, state }) => document.querySelector('.bu-drawer .ao-drawer__state')?.dataset.agentState === state
          && document.querySelector('.bu-drawer')?.getAttribute('aria-modal') === 'true', { id: ids[i], state: ['unknown', 'observed', 'working'][i] });
        assert.equal((await drawerState.innerText()).trim(), labels[lang][i]);
        if (i === 0) assert.match(await drawer.innerText(), lang === 'fr' ? /Inconnu/ : /Unknown/);
        if (i === 2) assert.match(await drawer.innerText(), lang === 'fr' ? /Vérifié/ : /Verified/);
        assert.doesNotMatch(await drawer.innerText(), /succeeded|failed|réussi|échoué/i, 'limited view does not reveal a run outcome');
        assert.doesNotMatch(await drawer.innerText(), /last activity|dernière activité|open session|ouvrir la session/i,
          'limited view does not expose session navigation or transcript-derived activity');
        await capture(page, `${base}-drawer-${['unknown', 'observed', 'working'][i]}`);
        captures.push(`${base}-drawer-${['unknown', 'observed', 'working'][i]}.jpg`);
        await drawer.getByRole('button', { name: lang === 'fr' ? 'Fermer' : 'Close' }).click();
        await drawer.waitFor({ state: 'hidden' });
      }
      await page.evaluate(async id => {
        const project = (o, state) => {   // the OfficeVM's server projection of a state (src/api/v2/vm/office-roster.js)
          o.state = state; o.stateActive = !['unknown', 'idle', 'offline'].includes(state);
          o.stateLabel = { key: 'agentState.' + state }; o.stateDetailLabel = { key: 'agentState.' + state };
          o.stateLastLabel = { key: 'office.lastState', params: { state: { key: 'agentState.' + state } } };
        };
        const { services } = await import('/services.js');
        const office = structuredClone(services.stream._topics.get('office').state.data);
        const live = office.occupants.find(o => o.id === id);
        project(live, 'working'); live.stateSince = Date.now();
        live.execution = { status: 'running', evidence: { level: 'observed', observedAt: Date.now(), expiresAt: Date.now() + 30000 } };
        services.stream.applyVM('office', office);
      }, ids[0]);
      const liveRow = mobile ? page.locator(`.ao-mobile-roster [data-mobile-agent="${ids[0]}"]`) : page.locator(`.ao-bureau__side [data-occupant="${ids[0]}"]`);
      await page.waitForFunction(id => document.querySelector(`[data-occupant="${id}"] .bu-state[data-agent-state="working"], [data-mobile-agent="${id}"] .bu-state[data-agent-state="working"]`), ids[0]);
      await liveRow.click();
      const liveDrawer = page.locator('.bu-drawer'); await liveDrawer.waitFor({ state: 'visible' });
      assert.match(await liveDrawer.locator('.ao-drawer__state').innerText(), lang === 'fr' ? /Travaille/ : /Working/);
      assert.match(await liveDrawer.innerText(), lang === 'fr' ? /Travaille[\s\S]*Activité observée/ : /Working[\s\S]*Activity observed/);
      await liveDrawer.getByRole('button', { name: lang === 'fr' ? 'Fermer' : 'Close' }).click();
    }
    assert.equal(captures.length, 32);
    if (process.env.BUREAU_SCREENSHOTS === '1') {
      const { writeFile } = await import('node:fs/promises');
      await writeFile('design/reports/office-dev-70/captures/manifest.json', JSON.stringify(captures, null, 2) + '\n');
    }
  });
