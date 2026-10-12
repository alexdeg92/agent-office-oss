import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { browserSkipReason, openLayoutBrowser } from './helpers/layout-browser.js';
import { META } from '../../public/v2/mock/meta.js';

const sizes = [[1440, 900], [1280, 800], [390, 844], [375, 667], [390, 460], [390, 320]];

test('production login: full office blend, four distinct families, couch guest, preserved authentication and responsive frame', {
  skip:browserSkipReason(), timeout:120000,
}, async () => {
  const b = await openLayoutBrowser({ theme:'light' }), p = b.page;
  const errors = [], screenshots = [], loginRequests = [];
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding:'utf8' }).trim();
  await p.emulateMedia({ reducedMotion:'reduce' });
  p.on('pageerror', error => errors.push(error.message));
  await p.route('**/backend/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/backend/api/v2/meta') return route.fulfill({ json:{ data:{ ...META, env:'production' } } });
    if (url.pathname === '/backend/api/v2/me' || url.pathname === '/backend/api/me') {
      return route.fulfill({ status:401, contentType:'application/json', body:JSON.stringify({ error:{ code:'unauthorized', message:'Unauthorized' } }) });
    }
    if (url.pathname === '/backend/api/login') {
      loginRequests.push({ body:JSON.parse(route.request().postData()), requestHeader:route.request().headers()['x-ao-request'] });
      return route.fulfill({ status:401, contentType:'application/json', body:JSON.stringify({ error:{ code:'unauthorized', message:'Unauthorized' } }) });
    }
    return route.fulfill({ status:404, contentType:'application/json', body:'{}' });
  });
  try {
    await p.goto(b.origin + '/connexion', { waitUntil:'networkidle' });
    await p.locator('#login-email').waitFor({ state:'visible' });
    await p.locator('.bu-login__scene[data-scene-ready="true"]').waitFor({ state:'attached', timeout:30000 });
    const identity = await p.locator('.bu-login__scene').evaluate(host => {
      const scene = host.aoScene;
      return {
        characters:scene._packOccupants.map(o => ({ id:o.look.character, variant:o.look.variant, accessories:o.look.accessories, station:o.stationUid })),
        rendered:scene.chars.size,
        reducedMotion:scene.reducedMotion,
        scarfLayers:[...host.querySelectorAll('img')].filter(img => /\/Characters\/fen\/33\.webp/.test(img.currentSrc || img.src)).length,
      };
    });
    assert.equal(identity.rendered, 4);
    assert.equal(identity.reducedMotion,true,'the idle office honors reduced motion');
    assert.deepEqual(identity.characters.map(c=>c.id), ['fen','timmy','filo','cosmo']);
    assert.ok(identity.characters[0].accessories.includes('scarf'), 'Renard wears the scarf accessory');
    assert.deepEqual(identity.characters.map(c=>c.station), ['sofa','st-timmy','st-5','st-3']);
    const deskPositions = [{x:9,y:8},{x:6,y:1},{x:2,y:4},{x:6,y:7}];
    assert.ok(Math.max(...deskPositions.map(p=>p.x))-Math.min(...deskPositions.map(p=>p.x)) >= 7);
    assert.ok(Math.max(...deskPositions.map(p=>p.y))-Math.min(...deskPositions.map(p=>p.y)) >= 7);
    assert.equal(identity.characters[0].station, 'sofa', 'Fen is relaxed on the couch');
    assert.equal(new Set(identity.characters.map(c=>c.id)).size, 4, 'all character families are distinct');
    assert.ok(identity.scarfLayers > 0, 'the character pack rendered Fen’s scarf front layer');

    for (const theme of ['light','dark']) {
      await p.evaluate(themeName => document.documentElement.setAttribute('data-theme', themeName), theme);
      await p.locator(`.bu-login__scene[data-office-theme="${theme === 'dark' ? 'night' : 'day'}"]`).waitFor({ state:'attached' });
      for (const [width,height] of sizes) {
        await p.setViewportSize({ width, height });
        await p.waitForTimeout(80);
        const metrics = await p.evaluate(() => {
          const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
          const panel = document.querySelector('.bu-login__form');
          const style = getComputedStyle(panel);
          return {
            viewport:{ width:innerWidth, height:innerHeight },
            document:{ width:document.documentElement.scrollWidth, height:document.documentElement.scrollHeight },
            root:rect('.bu-login'), outerBody:rect('.bu-login>.ao-frame__body'), scene:rect('.bu-login__scene'), form:rect('.bu-login__form'), foot:rect('.bu-login__form>.ao-frame__foot'),
            inputs:[...document.querySelectorAll('#login-email,#login-password')].map(el=>el.getBoundingClientRect().toJSON()),
            characters:[...document.querySelectorAll('.bu-login__scene .ao-char')].map(el=>el.getBoundingClientRect().toJSON()),
            panelStyle:{ background:style.backgroundColor, border:style.borderTopWidth, shadow:style.boxShadow },
            footBackground:getComputedStyle(document.querySelector('.bu-login__form>.ao-frame__foot')).backgroundColor,
            sceneTheme:document.querySelector('.bu-login__scene').dataset.officeTheme,
            pageHasPortal:/Private portal|Portail privé/.test(document.body.innerText),
          };
        });
        assert.ok(metrics.document.width <= width && metrics.document.height <= height, JSON.stringify(metrics));
        assert.ok(metrics.scene.width >= width * (width > 820 ? .7 : .98), JSON.stringify(metrics));
        assert.ok(metrics.form.left >= 0 && metrics.form.right <= width + .1, JSON.stringify(metrics.form));
        assert.ok(metrics.foot.bottom <= height + .1, JSON.stringify(metrics.foot));
        assert.ok(metrics.inputs.every(input=>input.height >= (width <= 820 ? 44 : 40) - .1));
        assert.deepEqual(metrics.panelStyle,{ background:'rgba(0, 0, 0, 0)', border:'0px', shadow:'none' });
        assert.equal(metrics.footBackground,'rgba(0, 0, 0, 0)','the action and caption stay blended into the form');
        assert.equal(metrics.pageHasPortal,false);
        if (width <= 820) assert.ok(metrics.scene.bottom > metrics.form.top + 8, 'scene fade continues into the form area: ' + JSON.stringify(metrics));
        if (width <= 820 && height > 550) assert.ok(metrics.characters.every(c=>c.height >= 50), 'mobile figures stay large enough to read: ' + JSON.stringify(metrics.characters));
        if (process.env.LOGIN_PRODUCTION_SCREENSHOTS === '1') {
          const dir = 'design/reports/login-1-production';
          await mkdir(dir,{recursive:true});
          const filename = `login-${width}x${height}-${theme}.png`;
          await p.screenshot({ path:`${dir}/${filename}` });
          screenshots.push({ filename, width, height, theme, source, sceneTheme:metrics.sceneTheme, metrics });
        }
      }
    }

    await p.locator('#login-email').fill(' owner@example.invalid ');
    await p.locator('#login-password').fill('abc');
    await p.getByRole('button',{ name:'Se connecter', exact:true }).click();
    await p.getByRole('alert').waitFor({ state:'visible' });
    assert.match(await p.getByRole('alert').innerText(), /Identifiants invalides/);
    assert.equal(await p.locator('#login-email').inputValue(), 'owner@example.invalid');
    assert.equal(await p.locator('#login-password').inputValue(), 'abc');
    assert.deepEqual(loginRequests,[{ body:{ email:'owner@example.invalid', password:'abc' }, requestHeader:'1' }]);
    assert.deepEqual(errors,[]);
    if (screenshots.length) await writeFile('design/reports/login-1-production/captures.json', JSON.stringify(screenshots,null,2)+'\n');
  } finally { await b.close(); }
});

test('production login keeps a native sign-in form when Bureau controls and office-scene assets fail', {
  skip:browserSkipReason(), timeout:60000,
}, async () => {
  const b = await openLayoutBrowser({ theme:'light' }), p = b.page;
  const errors = [], loginRequests = [];
  let controlStylesheetRequests = 0;
  p.on('pageerror', error => errors.push(error.message));
  await p.route('**/components/bureau/bureau.css*', async route => { controlStylesheetRequests++; await route.abort(); });
  await p.route('**/office/manifest.example.json*', route => route.abort());
  await p.route('**/backend/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/backend/api/v2/meta') return route.fulfill({ json:{ data:{ ...META, env:'production' } } });
    if (url.pathname === '/backend/api/v2/me' || url.pathname === '/backend/api/me') {
      return route.fulfill({ status:401, contentType:'application/json', body:JSON.stringify({ error:{ code:'unauthorized', message:'Unauthorized' } }) });
    }
    if (url.pathname === '/backend/api/login') {
      loginRequests.push({ body:JSON.parse(route.request().postData()), requestHeader:route.request().headers()['x-ao-request'] });
      return route.fulfill({ status:401, contentType:'application/json', body:JSON.stringify({ error:{ code:'unauthorized', message:'Unauthorized' } }) });
    }
    return route.fulfill({ status:404, contentType:'application/json', body:'{}' });
  });
  try {
    await p.goto(b.origin + '/connexion', { waitUntil:'networkidle' });
    await p.locator('#login-email').waitFor({ state:'visible' });
    await p.locator('.bu-login__controls-error').waitFor({ state:'visible' });
    await p.locator('.bu-login__scene[data-scene-error="true"]').waitFor({ state:'attached' });
    assert.equal(await p.locator('#login-email').getAttribute('class'),'bu-input');
    assert.equal(await p.locator('#login-password').getAttribute('class'),'bu-input');
    assert.ok(await p.getByRole('button',{ name:'Se connecter', exact:true }).isVisible());
    assert.ok(await p.getByRole('button',{ name:'Réessayer', exact:true }).isVisible());
    await p.getByRole('button',{ name:'Réessayer', exact:true }).click();
    await p.waitForTimeout(100);
    assert.ok(controlStylesheetRequests >= 2,'the control retry attempts to load the stylesheet again');
    await p.locator('#login-email').fill('fallback@example.invalid');
    await p.locator('#login-password').fill('unchanged');
    await p.getByRole('button',{ name:'Se connecter', exact:true }).click();
    await p.getByRole('alert').waitFor({ state:'visible' });
    assert.deepEqual(loginRequests,[{ body:{ email:'fallback@example.invalid', password:'unchanged' }, requestHeader:'1' }]);
    assert.deepEqual(errors,[]);
  } finally { await b.close(); }
});
