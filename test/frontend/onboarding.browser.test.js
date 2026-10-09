import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { launch, findChrome } = require('../office/helpers/browser');
const { createFrontendServer } = require('../../scripts/serve-frontend');
const { startServer } = require('../helpers/harness');
const { loadScenario } = require('../helpers/scenario');
const { seed, TOKEN } = require('../helpers/onboarding-fixture');
const ROOT = path.resolve(__dirname, '../..');
const SHOTS = path.join(ROOT, 'design/reports/onboarding-1');
const STEPS = ['welcome', 'detection', 'runtime', 'gateway', 'agents', 'identities', 'office', 'skills', 'network', 'review', 'done'];

test('real onboarding DOM/API: every chapter in French, light/dark at 1280/375; naming, all catalog styles, install/uninstall, network test, save', { skip: !findChrome(), timeout: 180000 }, async () => {
  const h = await startServer(loadScenario('foreign-instance'), { setupMode: true, gatewayToken: TOKEN, env: { OC_CONFIG: '' }, prepare: (tmp, context) => seed(tmp, { configuredAgent: true, gateway: context.gateway }),
    handlers: { 'agents.list': () => ({ defaultId: 'atlas', agents: [{ id: 'atlas', name: 'Runtime name' }, { id: 'scribe' }, { id: 'nova' }] }) } });
  const ui = createFrontendServer({ root: path.join(ROOT, 'public/v2'), apiProxy: h.base });
  await new Promise(resolve => ui.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${ui.address().port}`;
  const browser = await launch(); let page;
  try {
    page = await browser.page('/public/v2/index.html');
    await page.eval(`location.assign(${JSON.stringify(url + '/?lang=fr')});`);
    await page.waitFor('document.querySelector("#setup-code")');
    const fill = async (id, value) => page.eval(`const el=document.getElementById(${JSON.stringify(id)}); if(!el) throw new Error('Missing '+${JSON.stringify(id)}); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));`);
    const click = async selector => { await page.eval(`document.querySelector(${JSON.stringify(selector)}).click();`); };
    const next = async index => {
      await click('.ao-setup__body button[type="submit"]');
      await page.waitFor(`new URLSearchParams(location.search).get('etape') === '${index}'`);
      await page.waitFor('!document.querySelector(".ao-setup__body button[type=submit]:disabled")');
      assert.equal(await page.eval('return document.querySelector("[role=alert]")?.textContent || null;'), null);
    };
    const snapshots = async index => {
      for (const width of [1280, 375]) for (const theme of ['light', 'dark']) {
        await page.viewport(width, 950);
        await page.eval(`const theme=await import('/theme.js'); theme.setTheme(${JSON.stringify(theme)}); window.scrollTo(0,0);`);
        await page.eval('await document.fonts.ready; await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));');
        const dom = await page.eval('return { title: document.querySelector("#setup-etape")?.textContent, overflow: document.documentElement.scrollWidth>innerWidth+1, text:document.querySelector(".ao-setup__body").textContent, height:document.documentElement.scrollHeight, lang:document.documentElement.lang, layout:getComputedStyle(document.querySelector(".ao-setup__main")).display };');
        assert.ok(dom.title, STEPS[index] + ' has a heading');
        assert.equal(dom.layout, 'grid', 'setup stylesheet is ready before the chapter renders');
        assert.equal(dom.overflow, false, `${STEPS[index]} ${width} ${theme} has no horizontal overflow`);
        assert.ok(!dom.text.includes('onboarding.') && !dom.text.includes('setup.step.') && !dom.text.includes('Texte indisponible'), 'all labels translated');
        assert.ok(!dom.text.includes(TOKEN), 'no token in DOM');
        if (process.env.ONBOARDING_SCREENSHOTS === '1') {
          fs.mkdirSync(SHOTS, { recursive: true });
          fs.writeFileSync(path.join(SHOTS, `${String(index).padStart(2, '0')}-${STEPS[index]}-fr-${theme}-${width}.png`), await page.screenshot({ x: 0, y: 0, width, height: dom.height }));
        }
      }
    };
    await snapshots(0);
    await fill('setup-owner', 'Operator'); await fill('setup-email', 'owner@example.invalid');
    await fill('setup-password', 'synthetic-owner-password'); await fill('setup-password2', 'synthetic-owner-password'); await fill('setup-code', h.setupCode());
    await next(1); await page.waitFor('document.querySelector("[data-runtime=openclaw]")'); await snapshots(1);
    assert.match(await page.eval('return document.querySelector(".ao-setup__body").textContent;'), /bientôt pris en charge/);
    const rows = await page.eval('return Array.from(document.querySelectorAll("[data-detected-agent]")).map(el=>({id:el.querySelector("code").textContent,name:el.querySelector("strong")?.textContent,missing:el.querySelector("[data-name-missing]")?.textContent,source:el.querySelector("[data-name-source]")?.textContent}));');
    assert.deepEqual(rows, [{ id: 'atlas', name: 'Orion', source: 'IDENTITY.md' }, { id: 'scribe', missing: 'Nom à choisir' }, { id: 'nova', name: 'Vega', source: 'openclaw.json' }]);
    assert.equal(await page.eval('return document.querySelector("[data-runtime=openclaw] [data-detected-connection]").textContent;'), 'Adresse et jeton trouvés');
    await next(2); assert.equal(await page.eval('return document.querySelector("#setup-url").value;'), h.gw.url); assert.equal(await page.eval('return document.querySelector("#setup-token").value;'), ''); await snapshots(2);
    await next(3); // Detection supplies the hidden token; the gateway check starts without a click.
    await page.waitFor('document.querySelector(".ao-setup__status").textContent.includes("Passerelle connectée")'); await snapshots(3);
    await next(4); await page.eval('Array.from(document.querySelectorAll(".ao-setup__body button")).find(b=>b.textContent.includes("Rechercher les agents")).click();');
    await page.waitFor('document.querySelector("#setup-agent-scribe")');
    assert.equal(await page.eval('return document.querySelector("#setup-agent-atlas").value;'), 'Orion');
    assert.equal(await page.eval('return document.querySelector("#setup-agent-scribe").value;'), '');
    await fill('setup-agent-scribe', 'Lyra'); await snapshots(4);
    await next(5); await page.waitFor('document.querySelector(".ao-sc select") || document.querySelector(".ao-sc__character")');
    const choices = await page.eval('return Array.from(document.querySelectorAll(".ao-sc__cards input[type=radio]")).map(e=>e.value);');
    const catalog = (await h.get('/api/v2/setup/catalog')).json.data;
    assert.deepEqual(choices.sort(), [...catalog.characters, ...catalog.characterPacks.packs].map(c => c.id).sort(), 'every Store model and enabled pack is offered');
    await click('.ao-sc__cards input[value=fen]');
    await page.waitFor('document.querySelector(".ao-sc__cards input[value=fen]:checked")');
    await snapshots(5);
    await next(6); await fill('setup-name', 'Bureau synthétique'); await snapshots(6);
    await next(7); await page.waitFor('document.querySelector("#setup-skill-confirm")'); await snapshots(7);
    await click('#setup-skill-confirm'); await click('#setup-install'); await page.waitFor('Array.from(document.querySelectorAll("[data-skill-agent] [role=status]")).every(e=>e.textContent.includes("Installée"))');
    await click('#setup-uninstall'); await page.waitFor('!document.querySelector("#setup-uninstall:disabled")');
    assert.ok(!fs.existsSync(path.join(h.tmp, 'workspaces/atlas/skills/projet')));
    await click('#setup-install'); await page.waitFor('!document.querySelector("#setup-install:disabled")');
    await next(8); await page.waitFor('document.querySelector(".ao-onb-card[role=status]")');
    assert.notEqual(ui.address().port, h.port, 'frontend proxy port differs from the configured product port');
    assert.equal(await page.eval('return Number(document.querySelector("#setup-network-port").value);'), h.port, 'port comes from server configuration, never the browser URL');
    assert.equal(await page.eval('return document.querySelector("#setup-network-mode").value;'), 'local', 'Tailscale does not change the local default');
    assert.match(await page.eval('return document.querySelector("[data-network-suggestion]").textContent;'), /Tailscale est disponible/);
    await fill('setup-domain', 'office.example.invalid');
    await page.eval('Array.from(document.querySelectorAll(".ao-setup__body button")).find(b=>b.textContent.includes("Détecter mon IP")).click();');
    await page.waitFor('document.querySelector(".ao-onb-card[role=status]")?.textContent.includes("203.0.113.42")');
    await snapshots(8);
    await page.eval('Array.from(document.querySelectorAll(".ao-setup__body button")).find(b=>b.textContent.includes("Tester l’accès")).click();');
    await page.waitFor('document.querySelector(".ao-setup__body").textContent.includes("Le bureau répond")');
    await fill('setup-network-mode', 'public'); await fill('setup-public-url', 'http://bureau.example.com');
    await click('.ao-setup__body button[type=submit]'); await page.waitFor('document.querySelector("[role=alert]")');
    assert.equal(await page.eval('return new URLSearchParams(location.search).get("etape");'), '8', 'public HTTP blocked');
    await fill('setup-network-mode', 'local');
    const probes = fs.readFileSync(path.join(h.tmp, 'data/network-probes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual([...new Set(probes.map(p => p.kind))].sort(), ['fetcher', 'findBinary', 'interfaces', 'lookup', 'run'], 'all five network probes ran through injected fixtures');
    assert.ok(probes.filter(p => p.kind === 'run').every(p => p.value === '/synthetic/tailscale'), 'no host executable ran');
    assert.ok(probes.some(p => p.kind === 'fetcher' && p.value === 'https://api.ipify.org?format=json'), 'public IP lookup was stubbed');
    assert.ok(probes.some(p => p.kind === 'fetcher' && p.value === url + '/build.json'), 'browser access check was stubbed too');
    await next(9); await snapshots(9);
    assert.match(await page.eval('return document.querySelector(".ao-setup__review").textContent;'), /Orion, Lyra, Vega/);
    await next(10); await snapshots(10);
    h.withStore(db => assert.equal(db.prepare('SELECT email FROM users').get().email, 'owner@example.invalid'));
    await h.waitReady({ login: false });
    const login = await h.post('/api/login', { email: 'owner@example.invalid', password: 'synthetic-owner-password' });
    assert.equal(login.status, 200); h.cookie = login.headers.get('set-cookie').split(';')[0];
    const layout = (await h.get('/api/v3/office/layout')).json.data.layout.data;
    assert.equal(layout.agents.find(a => a.agentId === 'primary').character, 'fen');
    assert.ok(!h.output.includes(TOKEN));
    assert.ok(!page.logs.some(l => l.type === 'exception'), JSON.stringify(page.logs.filter(l=>l.type==='exception')));
  } finally { await browser.close(); await new Promise(resolve => ui.close(resolve)); await h.stop(); }
});

test('S02-02 browser resume: saved owner is hidden until the setup code is verified', { skip: !findChrome(), timeout: 60000 }, async () => {
  const h = await startServer(loadScenario('foreign-instance'), { setupMode: true, env: { OC_CONFIG: '' }, prepare: seed });
  const owner = { displayName: 'Synthetic Operator', email: 'synthetic-owner@example.invalid', password: 'synthetic-owner-password', passwordConfirmation: 'synthetic-owner-password' };
  assert.equal((await h.post('/api/v2/setup/owner', { setupCode: h.setupCode(), owner })).status, 200);
  const ui = createFrontendServer({ root: path.join(ROOT, 'public/v2'), apiProxy: h.base });
  await new Promise(resolve => ui.listen(0, '127.0.0.1', resolve));
  const browser = await launch();
  try {
    const page = await browser.page('/public/v2/index.html');
    await page.eval(`location.assign(${JSON.stringify('http://127.0.0.1:' + ui.address().port + '/?lang=fr')});`);
    await page.waitFor('document.querySelector("#setup-code") && document.querySelector(".ao-setup__body").textContent.includes("Un compte est déjà enregistré")');
    const text = await page.eval('return document.querySelector(".ao-setup__body").textContent;');
    assert.ok(!text.includes(owner.email) && !text.includes(owner.displayName));
    assert.equal(await page.eval('return !!document.querySelector("#setup-email");'), false, 'public state does not prefill saved identity');
    await page.eval(`const e=document.querySelector('#setup-code');e.value=${JSON.stringify(h.setupCode())};e.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>requestAnimationFrame(r));document.querySelector('.ao-setup__body button[type=submit]').click();`);
    await page.waitFor('new URLSearchParams(location.search).get("etape")==="1" && document.querySelector("[data-runtime=openclaw]")');
    await page.eval('const {services}=await import("/services.js");services.router.setQuery({etape:0});');
    await page.waitFor('document.querySelector(".ao-setup__body").textContent.includes("synthetic-owner@example.invalid")');
    assert.match(await page.eval('return document.querySelector(".ao-setup__body").textContent;'), /Synthetic Operator/);
    await page.eval('Array.from(document.querySelectorAll(".ao-setup__body button")).find(b=>b.textContent.includes("Modifier le compte")).click();');
    await page.waitFor('document.querySelector("#setup-email")');
    await page.eval('const e=document.querySelector("#setup-email");e.value="corrected@example.invalid";e.dispatchEvent(new Event("input",{bubbles:true}));await new Promise(r=>requestAnimationFrame(r));document.querySelector(".ao-setup__body button[type=submit]").click();');
    await page.waitFor('new URLSearchParams(location.search).get("etape")==="1"');
    h.withStore(db => assert.equal(db.prepare('SELECT email FROM users').get().email, 'corrected@example.invalid'));

  } finally { await browser.close(); await new Promise(resolve => ui.close(resolve)); await h.stop(); }
});

test('critic-05: missing secrets shows a locked recovery message in French and English, without an app link', { skip: !findChrome(), timeout: 60000 }, async () => {
  const IC = require('../../src/instance-config');
  const h = await startServer(loadScenario('foreign-instance'), { setupMode: true, env: { OC_CONFIG: '' }, prepare: async tmp => {
    await seed(tmp);
    const paths = IC.configPaths({ HOME: tmp });
    IC.writeInstanceConfig(paths, { version: IC.VERSION, instance: { name: 'Synthetic Office', locale: 'fr', timeZone: 'UTC' },
      owner: { displayName: 'Hidden Synthetic Owner', email: 'hidden-owner@example.invalid', authSource: 'database' },
      runtime: { adapter: 'demo', demo: { seed: 1 } }, agents: { primary: null, looks: {} } },
    { version: IC.VERSION, sessionSecret: 's'.repeat(48), runtimeToken: null });
    fs.unlinkSync(paths.secrets);
  } });
  const ui = createFrontendServer({ root: path.join(ROOT, 'public/v2'), apiProxy: h.base });
  await new Promise(resolve => ui.listen(0, '127.0.0.1', resolve));
  const browser = await launch();
  try {
    const page = await browser.page('/public/v2/index.html');
    await page.eval(`location.assign(${JSON.stringify('http://127.0.0.1:' + ui.address().port + '/?lang=fr')});`);
    await page.waitFor('document.querySelector(".bu-empty__text")?.textContent.includes("secrets.json")');
    for (const lang of ['fr', 'en']) {
      await page.eval(`document.querySelector('button[role=radio][lang=${lang}]').click();`);
      await page.waitFor(`document.querySelector('.bu-empty__text')?.textContent.includes(${JSON.stringify(lang === 'fr' ? 'Restaurez' : 'Restore')})`);
      const text = await page.eval('return document.querySelector("main").textContent;');
      assert.match(text, lang === 'fr' ? /Restaurez.*redémarrez/ : /Restore.*restart/);
      assert.ok(!text.includes('hidden-owner@example.invalid') && !text.includes('Hidden Synthetic Owner'));
      assert.equal(await page.eval('return !!document.querySelector(".bu-empty a, #setup-code, .bu-empty button");'), false);
      if (lang === 'fr') for (const width of [1280, 375]) for (const theme of ['light', 'dark']) {
        await page.viewport(width, 950);
        await page.eval(`const theme=await import('/theme.js');theme.setTheme(${JSON.stringify(theme)});await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));`);
        assert.equal(await page.eval('return document.documentElement.scrollWidth>innerWidth+1;'), false);
        if (process.env.ONBOARDING_SCREENSHOTS === '1') fs.writeFileSync(path.join(SHOTS, `11-missing-secrets-fr-${theme}-${width}.png`), await page.screenshot({ x: 0, y: 0, width, height: await page.eval('return document.documentElement.scrollHeight;') }));
      }
    }
  } finally { await browser.close(); await new Promise(resolve => ui.close(resolve)); await h.stop(); }
});
