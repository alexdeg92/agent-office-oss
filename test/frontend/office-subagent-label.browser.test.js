import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openLayoutBrowser, visit, browserSkipReason } from './helpers/layout-browser.js';

const skip = browserSkipReason();

test('empty generic sub-agent names render the backend LabelRef in the Office roster (FR/EN, 390/1440)',
  { skip, timeout: 90000 }, async t => {
    const browser = await openLayoutBrowser({ touch: true, apiVersion: 3 });
    const { page, origin } = browser;
    t.after(() => browser.close());
    await page.setViewportSize({ width: 390, height: 844 });
    await visit(page, origin, '/bureau?mock=foule&lang=fr', '.ao-bureau__stage');

    const id = 'subagent-label-browser-regression';
    await page.evaluate(async id => {
      const { services } = await import('/services.js');
      const stream = services.stream;
      stream.stop(); stream.status.set({ conn: 'open' });
      const office = structuredClone(stream._topics.get('office').state.data);
      const base = structuredClone(office.occupants[0]);
      const child = { ...base, id, role: 'subagent', name: '', title: { key: 'occupantRole.subagent' },
        roleLabel: null, runtime: 'Claude Code', parentId: null, parentName: null, rosterDepth: 0,
        rosterOrder: office.occupants.length, groupId: id, teamId: null };
      office.occupants.push(child);
      const item = { id, kind: 'occupant', isGroup: false, rootId: id, occupantIds: [id], childIds: [],
        previewOccupantIds: [], overflowCount: 0, openLabel: { key: 'occupantRole.subagent' }, teamLabel: null,
        delegatesLabel: { key: 'office.mobile.delegates', params: { n: 0 } }, overflowLabel: null,
        order: child.rosterOrder, count: 0, label: { key: 'occupantRole.subagent' } };
      office.rosterItems = [...office.rosterItems, item];
      office.rosterPreviewItems = [item];
      office.rosterOverflowCount = 0;
      const floor = office.rosterFloors[0];
      if (floor) {
        floor.occupantIds.push(id); floor.items.push({ kind: 'occupant', id: `occupant:${id}`, occupantId: id });
        floor.count += 1;
      }
      stream.applyVM('office', office);
    }, id);

    const locales = [
      { lang: 'fr', expected: 'Sous-agent' },
      { lang: 'en', expected: 'Sub-agent' },
    ];
    for (const { lang, expected } of locales) {
      await page.evaluate(async lang => {
        const { setLang } = await import('/i18n.js');
        setLang(lang); document.documentElement.lang = lang;
      }, lang);
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const card = width === 390
          ? page.locator(`.ao-mobile-roster [data-mobile-agent="${id}"]`)
          : page.locator(`.ao-bureau__side [data-occupant="${id}"]`);
        await card.waitFor({ state: 'visible' });
        const name = card.locator('.ao-agentcard__name');
        await page.waitForFunction(({ id, expected }) => {
          const row = document.querySelector(`.ao-mobile-roster [data-mobile-agent="${id}"] .ao-agentcard__name`)
            || document.querySelector(`.ao-bureau__side [data-occupant="${id}"] .ao-agentcard__name`);
          return row?.textContent?.trim() === expected;
        }, { id, expected });
        assert.equal((await name.innerText()).trim(), expected, `${lang} visible roster name at ${width}px`);
        assert.notEqual((await name.innerText()).trim(), '', 'the mounted Office never shows a blank sub-agent label');
        const subtitle = card.locator(width === 390 ? '.bu-cell-main .bu-cell-sub' : '.ao-roster__summary').first();
        assert.notEqual((await subtitle.innerText()).trim(), expected, `${lang} card role/subtitle is not a duplicate of its name at ${width}px`);
        const box = await card.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width, `the Office card fits within the ${width}px viewport`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the Office has no horizontal overflow');
        // This is the client-side LabelRef fallback under test. If page.js stops
        // resolving/passing the ref, displayName returns the neutral agent name
        // rather than masking the regression with a server-language literal.
        if (process.env.OFFICE_CAPTURE === '1') {
          await mkdir('design/reports/t0234-subagent-label/captures', { recursive: true });
          await card.screenshot({ path: `design/reports/t0234-subagent-label/captures/${width}-${lang}.png`, animations: 'disabled' });
        }
      }
    }
  });
