import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { createFrontendServer } = require('../../scripts/serve-frontend');
const { launch, findChrome } = require('../office/helpers/browser');
const { allowed, rejected } = require('../helpers/external-url-cases');
const skip = !findChrome() ? 'Chrome unavailable' : false;
const uiRoot = process.env.AO_URL_POLICY_UI_ROOT || resolve(import.meta.dirname, '../../public/v2');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Render the shipped SkillPage under the real app's CSP. Inject untrusted data
// directly into its subscription so VM checks cannot mask a missing anchor guard.
for (const basePath of ['/', '/v2/']) test(`skill homepage: rendered anchors and local click under normal CSP at ${basePath}`, { skip, timeout: 60000 }, async () => {
  const server = createFrontendServer({ root: uiRoot, basePath, apiBase: basePath === '/' ? '/backend' : '' });
  let clicks = 0;
  server.prependListener('request', (req) => { if (new URL(req.url, 'http://x').searchParams.get('marker') === 't0004') clicks++; });
  let browser;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(origin + basePath);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' 'sha256-/);
    assert.doesNotMatch(csp, /'unsafe-inline'|'unsafe-eval'/);
    browser = await launch();
    const page = await browser.page(origin + basePath + 'competences/minuteur?mock=1&lecture=1');
    await page.waitFor("!!document.querySelector('#app .ao-skill__actions')");
    await page.eval(`
      const { buildQuery } = await import(${JSON.stringify(basePath + 'config.js')});
      const { services } = await import(${JSON.stringify(basePath + 'services.js')} + buildQuery);
      const { h, render } = await import(${JSON.stringify(basePath + 'lib.js')} + buildQuery);
      const { SkillPage } = await import(${JSON.stringify(basePath + 'pages/skill.js')} + buildQuery);
      const subscribe = services.stream.subscribe.bind(services.stream);
      services.stream.subscribe = (topic, url, listener) => {
        if (topic !== 'skill:url-policy-test') return subscribe(topic, url, listener);
        window.__emitHomepage = listener;
        return () => { delete window.__emitHomepage; };
      };
      const panel = document.createElement('section'); panel.id = 'url-policy-test'; document.body.append(panel);
      render(h(SkillPage, { match: { params: { skillName: 'url-policy-test' } } }), panel);
      window.__urlPolicyMarker = 'inert';
    `);
    await page.waitFor('!!window.__emitHomepage');
    let index = 0;
    async function inject(homepage) {
      const id = `case-${++index}`;
      await page.eval(`window.__emitHomepage({ loading: false, error: null, data: {
        skill: { id: ${JSON.stringify(id)}, description: '<img src=x onerror="window.__urlPolicyMarker=1">',
          emoji: null, source: 'bundled', status: 'active', visibility: { model: true, command: false, user: true },
          homepage: ${JSON.stringify(homepage) ?? 'undefined'} },
        detail: null, markdown: '', flow: { steps: [], outputs: ['agent-reply'] }, needsRestart: false
      } });`);
      await page.waitFor(`document.querySelector('#url-policy-test h2')?.textContent.includes(${JSON.stringify(id)})`);
      return page.eval(`const a = document.querySelector('#url-policy-test .ao-skill__actions a[target="_blank"]');
        return a ? { href: a.getAttribute('href'), target: a.target, rel: a.rel } : null;`);
    }
    for (const input of rejected) {
      assert.equal(await inject(input), null, JSON.stringify(input));
      // Owner interaction on the action area cannot activate a refused homepage.
      await page.eval("document.querySelector('#url-policy-test .ao-skill__actions').click();");
    }
    for (const [input, expected] of allowed) assert.deepEqual(await inject(input), { href: expected, target: '_blank', rel: 'noopener noreferrer' });
    assert.equal(await page.eval("return window.__urlPolicyMarker;"), 'inert');
    assert.equal(await page.eval("return document.querySelector('#url-policy-test .bu-detail-header__desc').children.length;"), 0, 'metadata stays text');
    assert.equal(clicks, 0);
    assert.equal(await page.eval(`return performance.getEntriesByType('resource').every((r) => new URL(r.name).origin === location.origin);`), true, 'all UI resources are local');
    // A real _blank click to an inert loopback route proves HTTP remains usable.
    const local = origin + basePath + 'inert-homepage?mock=1&marker=t0004';
    assert.deepEqual(await inject(local), { href: local, target: '_blank', rel: 'noopener noreferrer' });
    await page.eval("document.querySelector('#url-policy-test .ao-skill__actions a[target=\"_blank\"]').focus();");
    await page.key('Enter');
    for (let i = 0; i < 100 && !clicks; i++) await pause(50);
    assert.equal(clicks, 1, 'browser opened the allowed HTTP homepage');
    assert.equal(await page.eval("return window.__urlPolicyMarker;"), 'inert');
    assert.deepEqual(page.logs, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
