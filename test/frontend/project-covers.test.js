import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
const require = createRequire(import.meta.url);
const { loadScenario } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');
const chromeBin = '/usr/bin/google-chrome', skip = !existsSync(chromeBin);
let h, project, chrome, ws, profile, sequence = 0;
const responses = new Map(), errors = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { responses.delete(id); reject(new Error('CDP timeout: ' + method)); }, 30000);
    responses.set(id, (msg) => { clearTimeout(timer); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function ready(expression) {
  try { await waitFor(() => evaluate(expression), { timeoutMs: 15000 }); }
  catch (error) {
    console.log('cover browser diagnostics',await evaluate("JSON.stringify({width:innerWidth,clientWidth:document.documentElement.clientWidth,url:location.pathname,viewport:document.querySelector('meta[name=viewport]')?.content,cards:[...document.querySelectorAll('[data-card]')].map(c=>({classes:c.className,images:[...c.querySelectorAll('img')].map(i=>({src:i.getAttribute('src'),complete:i.complete,naturalWidth:i.naturalWidth,rect:i.getBoundingClientRect().toJSON()}))})),errors:window.__AO_VM_ISSUES||[]})"));
    throw error;
  }
}
async function go(path) { await send('Page.navigate', { url: h.base + path }); await ready("document.readyState === 'complete' && !!document.querySelector('#app > *')"); }
before(async () => {
  if (skip) return;
  h = await startServer(loadScenario('synthetic-basic'), { readonly: true });
  const r = await h.request('POST', '/api/v2/projects', { name: 'Bureau Web', summary: 'Site web de démonstration' });
  project = r.json.data.vm;
  await waitFor(async () => (await h.get('/api/v2/views/projects/' + project.id)).json.data.cover);
  project = (await h.get('/api/v2/views/projects/' + project.id)).json.data;
  profile = mkdtempSync(join(tmpdir(), 'ao-cover-browser-'));
  chrome = spawn(chromeBin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-proxy-server', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let port;
  await waitFor(() => { try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; return port; } catch { return false; } });
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl); await new Promise((r) => ws.once('open', r));
  ws.on('message', (raw) => { const msg = JSON.parse(raw); if (msg.id && responses.has(msg.id)) { responses.get(msg.id)(msg); responses.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
  });
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['https://*'] });
  const at = h.cookie.indexOf('='); await send('Network.setCookie', { name: h.cookie.slice(0, at), value: h.cookie.slice(at + 1), url: h.base, path: '/' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}, { timeout: 60000 });
after(async () => {
  if (ws) ws.close();
  if (chrome) { chrome.kill(); await new Promise((r) => chrome.exitCode !== null ? r() : chrome.once('exit', r)); }
  if (h) await h.stop();
  if (profile) rmSync(profile, { recursive: true, force: true });
});
test('desktop card/detail paint real backend covers, keep image dimensions and show French regeneration/upload controls', { skip, timeout: 30000 }, async () => {
  await go('/v2/projets'); await ready("!!document.querySelector('[data-card] img')?.naturalWidth");
  const card = await evaluate("(() => {const i=document.querySelector('[data-card] img');return {src:i.getAttribute('src'),width:Number(i.getAttribute('width')),height:Number(i.getAttribute('height')),naturalWidth:i.naturalWidth,lazy:i.loading};})()");
  assert.equal(card.src, new URL(project.cover.url, h.base).href); assert.equal(card.width, 480); assert.equal(card.height, 270); assert.equal(card.lazy, 'lazy'); assert.equal(card.naturalWidth, 480);
  await go('/v2/projets/' + project.id); await ready("!!document.querySelector('.bu-project-header [data-cover=cover] img')?.naturalWidth");
  assert.equal(await evaluate("document.querySelector('.bu-project-header [data-cover=cover] img').getAttribute('src')"), card.src);
  assert.match(await evaluate("document.querySelector('.ao-cover-actions').textContent"), /Régénérer l’image/);
  assert.equal(await evaluate("document.querySelector('.ao-cover-actions input').accept"), 'image/png,image/jpeg,image/webp');
  assert.equal(await evaluate("document.querySelector('.ao-cover-actions button').disabled"), false);
});
test('mobile cards render compact covers using only the 160×90 thumbnail URL; mobile detail paints its cover', { skip, timeout: 30000 }, async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await go('/v2/projets'); await ready("!!document.querySelector('.ao-mobile-card img')?.naturalWidth");
  const image = await evaluate("(() => {const i=document.querySelector('.ao-mobile-card img'),r=i.closest('.bu-thumb').getBoundingClientRect();return {src:i.getAttribute('src'),width:r.width,height:r.height,naturalWidth:i.naturalWidth,lazy:i.loading};})()");
  assert.equal(image.src, new URL(project.cover.thumbUrl, h.base).href); assert.equal(image.width, 64); assert.equal(image.height, 48); assert.equal(image.lazy, 'lazy'); assert.equal(image.naturalWidth, 160);
  if (process.env.PROJECTS_SCREENSHOTS) {
    mkdirSync('design/reports/projects-mobile-1', { recursive: true });
    const capture = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('design/reports/projects-mobile-1/backend-cover-mobile-390.png', Buffer.from(capture.data, 'base64'));
  }
  await go('/v2/projets/' + project.id); await ready("!!document.querySelector('.bu-project-header [data-cover=cover] img')?.naturalWidth");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.bu-project-header [data-cover=cover]')).display"), 'block');
  assert.deepEqual(errors, []);
});
