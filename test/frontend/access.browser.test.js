import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { createFrontendServer } = require('../../scripts/serve-frontend');
const { launch, findChrome } = require('../office/helpers/browser');

test('agents: shipped AccessPage renders defaults and open harness names in fr/en at desktop/mobile, 15 agents',
  { skip: !findChrome() ? 'Chrome unavailable' : false, timeout: 60000 }, async () => {
    const server = createFrontendServer({ root: resolve(import.meta.dirname, '../../public/v2'), basePath: '/v2/' });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    let browser;
    try {
      browser = await launch();
      const page = await browser.page(`http://127.0.0.1:${server.address().port}/v2/habilitations?mock=1&lecture=1`);
      await page.waitFor("document.querySelector('.ao-access__agents')");
      await page.eval(`
        const { buildQuery } = await import('/v2/config.js');
        const { services } = await import('/v2/services.js' + buildQuery);
        const { h, render } = await import('/v2/lib.js' + buildQuery);
        const { AccessPage } = await import('/v2/pages/access.js' + buildQuery);
        const { setLang } = await import('/v2/i18n.js' + buildQuery);
        const subscribe = services.stream.subscribe.bind(services.stream);
        services.stream.subscribe = (topic, url, listener) => {
          if (topic !== 'access') return subscribe(topic, url, listener);
          window.__emitAgents = listener; return () => {};
        };
        const panel = document.createElement('section'); panel.id = 'execution-test'; document.body.append(panel);
        window.__executionRender = (lang) => { setLang(lang); render(h(AccessPage, { match: { query: {} } }), panel); };
        window.__executionRender('fr');
      `);
      await page.waitFor('window.__emitAgents');
      const agents = Array.from({ length: 15 }, (_, i) => ({ id: 'worker-' + i, name: 'Worker ' + i,
        model: i === 3 ? null : 'vendor/model', modelSource: i === 0 ? 'explicit' : i === 3 ? null : 'inherited',
        runtime: i === 2 ? 'foreign-cli <harness>' : null, isPrimary: i === 0 }));
      await page.eval(`window.__emitAgents({ loading: false, error: null, data: { agents: ${JSON.stringify(agents)}, interlocutors: [],
        policy: { dm: null, group: null, channelsEnabled: 0, channelsTotal: 0, execSecurity: null } } });`);
      await page.waitFor("document.querySelectorAll('#execution-test .ao-access__agents li').length === 15");
      for (const lang of ['fr', 'en']) for (const width of [1440, 390]) {
        await page.viewport(width, 900);
        await page.eval(`window.__executionRender(${JSON.stringify(lang)});`);
        const inherited = `vendor/model (${lang === 'fr' ? 'par défaut' : 'default'})`;
        await page.waitFor(`document.querySelectorAll('#execution-test .bu-row__sub')[1]?.textContent.includes(${JSON.stringify(inherited)})`);
        const rows = await page.eval(`return Array.from(document.querySelectorAll('#execution-test .ao-access__agents .bu-row__sub'), x => x.textContent);`);
        assert.equal(rows.length, 15);
        assert.equal(rows[0], 'agent worker-0 · vendor/model');
        assert.equal(rows[1], 'agent worker-1 · ' + inherited);
        assert.equal(rows[2], 'agent worker-2 · foreign-cli <harness>');
        assert.equal(rows[3], 'agent worker-3 · ' + (lang === 'fr' ? 'Non renseigné' : 'Not provided'));
        assert.equal(await page.eval("return document.querySelector('#execution-test .ao-access__agents harness') === null;"), true, 'harness metadata renders as text');
        if (process.env.AO_ACCESS_EVIDENCE) {
          const clip = await page.eval(`const list = document.querySelector('#execution-test .ao-access__agents'), items = list.querySelectorAll('li');
            items[0].scrollIntoView(); const a = list.getBoundingClientRect();
            const bottom = Math.max(...Array.from(items).slice(0, 4).map(x => x.getBoundingClientRect().bottom));
            return { x: a.x + scrollX, y: a.y + scrollY, width: a.width, height: bottom - a.top };`);
          mkdirSync(process.env.AO_ACCESS_EVIDENCE, { recursive: true });
          writeFileSync(join(process.env.AO_ACCESS_EVIDENCE, 'agents-' + lang + '-' + width + '.png'), await page.screenshot(clip));
        }
      }
      assert.deepEqual(page.logs, []);
    } finally {
      await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
    }
  });
