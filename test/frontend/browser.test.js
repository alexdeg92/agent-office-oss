// Real-browser tests for /v2 (R4-18): headless Chrome over the DevTools protocol, no extra dependency (ws is one already).
// Covers the auth gate, logout failure, real keyboard focus/activation, the Kanban keyboard path and topic retry.
// Skipped when Chrome isn't installed or AO_SKIP_BROWSER=1. The UI is served by scripts/serve-frontend.js (F7) twice:
// at /v2/ with the API at the same root (dev/staging), and at / with the API behind /backend (production topology).
// Neither has an API (every API path is a 404), so the app runs on its standalone mocks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import serveFrontend from '../../scripts/serve-frontend.js';
import firstLoad from '../../scripts/first-load.js';
import { DEFAULTS } from '../../public/v2/config.js';
import { STEPS } from '../../public/v2/pages/setup-rules.js';

const CHROME = process.env.CHROME_BIN || process.env.CHROME || '/usr/bin/google-chrome';
const skip = process.env.AO_SKIP_BROWSER === '1' || !existsSync(CHROME) ? 'no headless Chrome (set CHROME=… or unset AO_SKIP_BROWSER)' : false;
const UI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../public/v2');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server, rootServer, v3Server, base, rootBase, v3Base, chrome, profile, ws, seq = 0;
const responses = [];   // { url, status } of every HTTP response the page received
const requestFailures = []; // failed browser requests with the network error from CDP
const badResponses = []; // { url, status } for HTTP errors
const pageErrors = [];
const consoleApiErrors = [];
// The contract the suite runs on (frontend-21): AO_TEST_API_VERSION, else the UI's own default.
const API = '/api/v' + (process.env.AO_TEST_API_VERSION ? Number(process.env.AO_TEST_API_VERSION) : DEFAULTS.apiVersion);
const requests = [];    // { url, by } of every request: `by` is the script that initiated it (CDP initiator), for F11
const pending = new Map();
const consoleErrors = [];
const vmIssues = [];   // [vm] console errors: a VM that doesn't match its server schema (vmcheck.js, architect-23)

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (msg) => (msg.error ? reject(new Error(method + ': ' + msg.error.message)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('evaluate: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function waitFor(expression, timeout = 6000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await evaluate(`(() => { try { return ${expression}; } catch { return false; } })()`);
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + expression);
    await sleep(50);
  }
}
async function go(path, origin = base) {
  const marker = 'navigation-' + seq;
  await evaluate(`window.__testNavigation = ${JSON.stringify(marker)}`);
  await send('Page.navigate', { url: origin + path });
  // An event, not a delay; the deadline only bounds a real failure, so it is generous for a loaded CI machine.
  await waitFor(`window.__testNavigation !== ${JSON.stringify(marker)} && location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete' && !!document.querySelector('#app > *')`, 20_000);
}
async function openChat(){
 await waitFor(`document.querySelector('[data-chat-agent]')`,15000);
 await evaluate(`document.querySelector('[data-chat-agent]').click()`);
 await waitFor(`document.querySelector('[data-chat-session]')`,15000);
 await evaluate(`document.querySelector('[data-chat-session]').click()`);
 await waitFor(`document.getElementById('chat-texte')`,15000);
}
async function key(k, extra = {}) {
  const codes = { Tab: 9, Enter: 13, ' ': 32, ArrowLeft: 37, ArrowRight: 39, Escape: 27 };
  const common = { key: k, code: k === ' ' ? 'Space' : k, windowsVirtualKeyCode: codes[k] || 0, ...extra };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(k === 'Enter' ? { text: '\r' } : k === ' ' ? { text: ' ' } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

before(async () => {
  if (skip) return;
  const listen = async (srv) => { await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${srv.address().port}`; };
  // AO_TEST_API_VERSION=3 runs the whole suite on contract 3.0 (frontend-21); unset: the UI's own default (config.js).
  const TEST_API = process.env.AO_TEST_API_VERSION ? Number(process.env.AO_TEST_API_VERSION) : undefined;
  server = serveFrontend.createFrontendServer({ root: UI_ROOT, basePath: '/v2/', apiBase: '', apiVersion: TEST_API });
  base = await listen(server);
  rootServer = serveFrontend.createFrontendServer({ root: UI_ROOT, basePath: '/', apiBase: '/backend', apiVersion: TEST_API });
  rootBase = await listen(rootServer);
  v3Server = serveFrontend.createFrontendServer({ root: UI_ROOT, basePath: '/v3/', apiBase: '', apiVersion: 3 });   // G5: the whole client on contract 3.0
  v3Base = await listen(v3Server);
  profile = mkdtempSync(join(tmpdir(), 'ao-chrome-'));
  chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--metrics-recording-only',
    '--disable-features=OptimizationHints,Translate,MediaRouter,DialMediaRouteProvider', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100 && !port; i++) { try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await sleep(100); } }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Network.responseReceived') {
      const row = { url: msg.params.response.url, status: msg.params.response.status };
      responses.push(row);
      if (row.status >= 400) badResponses.push(row);
    }
    if (msg.method === 'Network.loadingFailed') {
      const request = requests.find(row => row.id === msg.params.requestId);
      requestFailures.push({ url: request?.url || null, error: msg.params.errorText, canceled: msg.params.canceled || false, blockedReason: msg.params.blockedReason || null });
    }
    if (msg.method === 'Network.requestWillBeSent') {
      const i = msg.params.initiator || {};
      const frames = (i.stack && i.stack.callFrames) || [];
      requests.push({ id: msg.params.requestId, url: msg.params.request.url, type: i.type, by: (frames[0] && frames[0].url) || i.url || null });
    }
    // F11: a module load answered by the HTTP cache (no network round trip) is not a waterfall step.
    const cached = (id) => { for (const r of requests) if (r.id === id) r.cached = true; };
    if (msg.method === 'Network.requestServedFromCache') cached(msg.params.requestId);
    if (msg.method === 'Network.loadingFinished') for (const r of requests) if (r.id === msg.params.requestId) r.done = true;
    if (msg.method === 'Network.responseReceived' && (msg.params.response.fromDiskCache || msg.params.response.fromPrefetchCache)) cached(msg.params.requestId);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = msg.params.args.map((x) => x.value ?? x.description ?? '').join(' ');
      consoleApiErrors.push(text);
      if (text.startsWith('[vm]')) vmIssues.push(text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const text = msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text;
      pageErrors.push(text);
      consoleErrors.push(text);
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  // These tests read French UI text: pin the language a user would have chosen (headless Chrome negotiates en-US).
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!sessionStorage.getItem('ao.test.nopin') && !localStorage.getItem('ao.locale')) localStorage.setItem('ao.locale', 'fr'); } catch {}" });
  // F12: every page runs under serve-frontend's CSP; any violation is recorded here, and asserted empty below.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "document.addEventListener('securitypolicyviolation', (e) => { try { const l = JSON.parse(sessionStorage.getItem('ao.csp') || '[]'); l.push(e.effectiveDirective + ' ' + (e.blockedURI || 'inline') + ' ' + location.pathname + ' ' + (e.sourceFile || '').split('/').pop() + ':' + e.lineNumber); sessionStorage.setItem('ao.csp', JSON.stringify(l)); } catch {} });" });
  // Web fonts come from Google Fonts; offline or sandboxed hosts would stall page load on them.
  await send('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  // Warm-up: on some hosts headless Chrome's first HTTP request stalls for ~25 s (network service start-up);
  // pay it once here (node:test reports this hook's time inside the first test's duration).
  await send('Page.navigate', { url: base + '/v2/bureau.png' });
}, { timeout: 90_000 });

after(async () => {
  if (ws) ws.close();
  if (chrome) chrome.kill();
  if (server) server.close();
  if (rootServer) rootServer.close();
  if (v3Server) v3Server.close();
  if (profile) { await sleep(200); rmSync(profile, { recursive: true, force: true }); }
});

test('auth gate: logged out → /v2/connexion?suite=…; a bad password shows the linked error; a good one returns', { skip, timeout: 30_000 }, async () => {
  await go('/v2/sante?mock=1');
  await waitFor(`document.querySelector('.bu-sidebar')`);
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Se déconnecter').click()`);
  await waitFor(`location.pathname === '/v2/connexion'`);
  await waitFor(`document.querySelector('.bu-text-input#login-email')`);
  assert.equal(await evaluate('new URLSearchParams(location.search).get("suite")'), '/v2/sante?mock=1');
  await evaluate(`document.getElementById('login-email').focus()`);
  assert.equal(await evaluate('document.activeElement.id'), 'login-email');
  await key('Tab');
  assert.equal(await evaluate('document.activeElement.id'), 'login-password', 'Tab order: e-mail → password');
  await evaluate(`(() => { document.getElementById('login-email').value = 'nom@example.invalid'; document.getElementById('login-password').value = 'x'; })()`);
  await key('Enter');
  await waitFor(`document.getElementById('login-error')`);
  assert.equal(await evaluate(`document.getElementById('login-password').getAttribute('aria-describedby')`), 'login-error');
  assert.equal(await evaluate(`document.getElementById('login-password').getAttribute('aria-invalid')`), 'true');
  await evaluate(`document.getElementById('login-password').value = 'secret1'`);
  await key('Enter');
  await waitFor(`location.pathname === '/v2/sante' && document.querySelector('.bu-sidebar')`);
});

test('R4-11: a failed logout stays signed in and says so', { skip, timeout: 20_000 }, async () => {
  await go('/v2/sante?mock=1&echec-deconnexion=1');
  await waitFor(`document.querySelector('.bu-sidebar')`);
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Se déconnecter').click()`);
  const toast = await waitFor(`document.querySelector('.bu-toast--danger')?.textContent`);
  assert.match(toast, /déconnexion a échoué/);
  assert.equal(await evaluate('location.pathname'), '/v2/sante');
  assert.ok(await evaluate(`!!document.querySelector('.bu-sidebar') && !document.querySelector('.bu-login')`));
});

test('keyboard: the skip link and a nav link are reachable and activate with Enter', { skip, timeout: 20_000 }, async () => {
  await go('/v2/sante?mock=1');
  await waitFor(`document.querySelector('.bu-sidebar')`);
  await evaluate('document.activeElement.blur(); window.focus()');
  await key('Tab');
  assert.equal(await evaluate('document.activeElement.className'), 'ao-skip', 'first Tab reaches « Aller au contenu »');
  await evaluate(`[...document.querySelectorAll('.bu-nav__item')].find(a => a.textContent.trim() === 'Projets').focus()`);
  await key('Enter');
  await waitFor(`location.pathname === '/v2/projets' && document.querySelector('.ao-projects-server__card[data-card]')`);
  assert.equal(await evaluate(`document.querySelector('.bu-nav__item[aria-current="page"]').textContent.trim()`), 'Projets');
  assert.equal(await evaluate('new URLSearchParams(location.search).get("mock")'), '1', 'mock mode survives navigation');
});

test('Projects keyboard path: Espace opens move destinations, Escape cancels and Enter moves via the server VM', { skip, timeout: 20_000 }, async () => {
  await go('/v2/projets?mock=1');
  await waitFor(`document.querySelector('.ao-projects-server__card[data-card]')`);
  const card = await evaluate(`document.querySelector('.ao-projects-server__card[data-card]').dataset.card`);
  await evaluate(`document.querySelector('.ao-projects-server__card[data-card="${card}"]').focus()`);
  await key(' ');
  await waitFor(`document.querySelector('[role=dialog]')`);
  await key('Escape');
  await waitFor(`!document.querySelector('[role=dialog]')`);
  await evaluate(`document.querySelector('.ao-projects-server__card[data-card="${card}"]').focus()`);
  await key(' ');
  await waitFor(`document.querySelector('[role=dialog]')`);
  const inProgress = await evaluate(`([...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent.includes('En cours')) || {}).textContent || ''`);
  assert.match(inProgress, /En cours/, 'the move sheet exposes the server-provided destination label');
  await evaluate(`([...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent.includes('En cours')).focus())`);
  await key('Enter');
  await waitFor(`document.querySelector('.bu-toast--success')?.textContent.includes('En cours')`);
  await waitFor(`document.querySelector('[data-card="${card}"]').closest('[data-column]').dataset.column === 'in-progress'`);
  assert.equal(await evaluate('location.pathname'), '/v2/projets', 'Espace never follows the card link');
});

test('R4-09: a failed topic change shows « Reconnexion… », is retried, then goes live', { skip, timeout: 20_000 }, async () => {
  await go('/v2/projets/importer?mock=1&echecs=2');  // a page without topics (a one-shot GET), so the injected failures hit the next page's subscription
  await waitFor(`document.querySelector('.bu-topbar .bu-live')?.textContent === 'En direct'`);
  await evaluate(`[...document.querySelectorAll('.bu-nav__item')].find(a => a.textContent.trim() === 'Santé système').click()`);
  await waitFor(`document.querySelector('.bu-topbar .bu-live--stale')`);
  await waitFor(`document.querySelector('.bu-topbar .bu-live')?.textContent === 'En direct'`, 10_000);
  assert.ok(await evaluate(`!!document.querySelector('.ao-health:not([aria-busy=true]) .bu-stat, .ao-health:not([aria-busy=true]) .bu-empty')`), 'Santé rendered');
});

test('Santé resolved checks have a cause-specific label and no stale action in French and English', { skip, timeout: 20_000 }, async () => {
  await go('/v2/sante?mock=1');
  await waitFor(`document.querySelector('.ao-health-check')`);
  const row = '.ao-health-check';
  assert.match(await evaluate(`document.querySelector('${row} .ao-health-check__head strong').textContent`), /liste des sessions/i);
  assert.equal(await evaluate(`!!document.querySelector('${row}').querySelector('a')`), false, 'resolved check must not offer settings');
  assert.equal(await evaluate(`[...document.querySelectorAll('.ao-section-head button')].some(b => b.textContent.includes('Tout corriger'))`), false,
    'resolved/non-actionable checks do not offer Fix all');
  assert.match(await evaluate(`document.querySelector('.ao-issue__title').textContent`), /Source: Moteur.*Cause: liste des compétences/i,
    'data issue shows its source connector and concrete schema cause in the row');
  await evaluate(`document.querySelector('.ao-lang button[lang="en"]').click()`);
  await waitFor(`document.documentElement.lang.startsWith('en') && document.querySelector('${row} .ao-health-check__head strong').textContent.toLowerCase().includes('session list')`);
  assert.match(await evaluate(`document.querySelector('${row} .ao-health-check__head strong').textContent`), /session list could not be refreshed/i);
  assert.equal(await evaluate(`!!document.querySelector('${row}').querySelector('a')`), false, 'resolved check must not offer settings in English');
  assert.match(await evaluate(`document.querySelector('.ao-issue__title').textContent`), /Source: Runtime.*Cause: skills list/i,
    'English data issue shows source and cause');
  assert.ok(!(await evaluate(`document.querySelector('.ao-issue__title').textContent`)).includes('A data check failed'));
  if (process.env.AO_HEALTH_CAPTURE_DIR) {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(`document.querySelector('${row}').scrollIntoView({block:'center'})`);
    await sleep(250);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    mkdirSync(process.env.AO_HEALTH_CAPTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.AO_HEALTH_CAPTURE_DIR, 'health-en-checks-390.png'), Buffer.from(shot.data, 'base64'));
  }
  await evaluate(`document.querySelector('.ao-lang button[lang="fr"]').click()`);
  await waitFor(`document.documentElement.lang.startsWith('fr') && document.querySelector('${row} .ao-health-check__head strong').textContent.includes('liste des sessions')`);
});

test('Santé transcript failure gives terminal bilingual guidance without exposing a path or session ID', { skip, timeout: 30_000 }, async () => {
  const route = '/v2/sante?mock=transcript-terminal';
  const row = '.ao-health-check';
  const states = [
    { lang: 'fr', theme: 'light', width: 1440, height: 900, file: 'transcript-fr-light-1440.png', heading: /format de cette conversation/i, target: /transcription de conversation/i, guidance: /application source/i },
    { lang: 'fr', theme: 'dark', width: 1440, height: 900, file: 'transcript-fr-dark-1440.png', heading: /format de cette conversation/i, target: /transcription de conversation/i, guidance: /application source/i },
    { lang: 'fr', theme: 'light', width: 390, height: 844, file: 'transcript-fr-light-390.png', heading: /format de cette conversation/i, target: /transcription de conversation/i, guidance: /application source/i },
    { lang: 'fr', theme: 'dark', width: 390, height: 844, file: 'transcript-fr-dark-390.png', heading: /format de cette conversation/i, target: /transcription de conversation/i, guidance: /application source/i },
    { lang: 'en', theme: 'light', width: 1440, height: 900, file: 'transcript-en-light-1440.png', heading: /conversation format is not recognized/i, target: /conversation transcript/i, guidance: /source app/i },
    { lang: 'en', theme: 'dark', width: 1440, height: 900, file: 'transcript-en-dark-1440.png', heading: /conversation format is not recognized/i, target: /conversation transcript/i, guidance: /source app/i },
    { lang: 'en', theme: 'light', width: 390, height: 844, file: 'transcript-en-light-390.png', heading: /conversation format is not recognized/i, target: /conversation transcript/i, guidance: /source app/i },
    { lang: 'en', theme: 'dark', width: 390, height: 844, file: 'transcript-en-dark-390.png', heading: /conversation format is not recognized/i, target: /conversation transcript/i, guidance: /source app/i },
  ];
  for (const state of states) {
    await evaluate(`localStorage.setItem('ao.locale',${JSON.stringify(state.lang)});localStorage.setItem('ao.uiTheme',${JSON.stringify(state.theme)})`);
    await send('Emulation.setDeviceMetricsOverride', { width: state.width, height: state.height, deviceScaleFactor: 1, mobile: state.width < 600 });
    await go(route);
    await waitFor(`document.querySelector('${row}') && document.querySelector('${row} .ao-health-check__head strong').textContent`);
    const text = await evaluate(`document.querySelector('${row}').textContent`);
    assert.match(text, state.heading);
    assert.match(text, state.target);
    assert.match(text, state.guidance);
    assert.equal(await evaluate(`!!document.querySelector('${row} button')`), false, 'a terminal failure offers no automatic retry action');
    assert.equal(await evaluate(`[...document.querySelectorAll('.ao-section-head button')].some(b => /Tout corriger|Fix all/.test(b.textContent))`), false);
    assert.ok(!text.includes('private-customer') && !text.includes('synthetic-session-7e3d7'), 'HealthVM UI never includes the private path/session sentinel');
    if (process.env.AO_HEALTH_CAPTURE_DIR) {
      await evaluate(`document.querySelector('${row}').scrollIntoView({block:'center'})`);
      await sleep(200);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(process.env.AO_HEALTH_CAPTURE_DIR, { recursive: true });
      writeFileSync(join(process.env.AO_HEALTH_CAPTURE_DIR, state.file), Buffer.from(shot.data, 'base64'));
    }
  }
  await evaluate(`localStorage.setItem('ao.locale','fr');localStorage.removeItem('ao.uiTheme')`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
});

test('Journaux: Enter opens a session; the view switch is in the URL; a live transcript grows over SSE', { skip, timeout: 30_000 }, async () => {
  await go('/v2/journaux?mock=1');
  // The mock's live trace is the main session's; since T-0070 a newer observed-only Claude row may sort above it
  const liveRow = `[...document.querySelectorAll('.ao-logs .bu-table__row')].find(a => new URL(a.href).pathname.endsWith('/journaux/agent%3Amain%3Amain'))`;
  await waitFor(liveRow);
  const selectedPath = await evaluate(`new URL(${liveRow}.href).pathname`);
  await evaluate(`${liveRow}.focus()`);
  await key('Enter');
  await waitFor(`location.pathname === ${JSON.stringify(selectedPath)} && document.querySelector('.bu-trace')`);
  const before = await evaluate(`document.querySelectorAll('.bu-trace__node, .bu-trace__tools > li, .ao-thinking').length`);
  await waitFor(`document.querySelectorAll('.bu-trace__node, .bu-trace__tools > li, .ao-thinking').length > ${before}`, 8000);
  await evaluate(`[...document.querySelectorAll('.bu-segmented__opt')].find(b => b.textContent.includes('Chronologie')).focus()`);
  await key(' ');
  await waitFor(`new URLSearchParams(location.search).get('vue') === 'chronologie' && document.querySelector('.bu-waterfall__bar')`);
  await evaluate(`document.querySelector('.bu-backlink').focus()`);
  await key('Enter');
  await waitFor(`location.pathname === '/v2/journaux' && document.querySelector('.ao-logs .bu-table__row')`);
});

test('Chat: send → pending, draft retained; reply arrives; unsafe failures have no retry', { skip, timeout: 40_000 }, async () => {
  await evaluate(`localStorage.removeItem('ao.chat.draft')`);
  await go('/v3/discuter?mock=1', v3Base); await openChat();
  await waitFor(`document.querySelector('.ao-chat__msg')`);
  const before = await evaluate(`document.querySelectorAll('.ao-chat__msg').length`);
  await evaluate(`(() => { const t = document.getElementById('chat-texte'); t.value = 'Résume la semaine.'; t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); })()`);
  await key('Enter', { modifiers: 2 });   // Ctrl + Enter sends
  await waitFor(`document.querySelector('.ao-chat__pending') && document.querySelectorAll('.ao-chat__msg').length === ${before + 1}`);
  assert.match(await evaluate(`document.querySelector('.ao-chat__pending').textContent`), /Réponse en cours/);
  await evaluate(`(() => { const t = document.getElementById('chat-texte'); t.value = 'Brouillon pendant le tour'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.equal(await evaluate(`document.querySelector('.ao-chat__composer button[type=submit]').disabled`), true, 'one pending turn at a time');
  await waitFor(`!document.querySelector('.ao-chat__pending') && document.querySelectorAll('.ao-chat__msg--assistant').length > 0 && document.querySelectorAll('.ao-chat__msg').length === ${before + 2}`, 10_000);
  assert.equal(await evaluate(`document.getElementById('chat-texte').value`), 'Brouillon pendant le tour', 'the draft survives the turn');

  await go('/v2/discuter?mock=1&echec-chat=1'); await openChat();
  await waitFor(`document.querySelector('.ao-chat__composer')`);
  await evaluate(`(() => { const t = document.getElementById('chat-texte'); t.value = 'Vérifie le portail.'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('.ao-chat__composer button[type=submit]').click()`);
  await waitFor(`document.querySelector('.ao-chat__msg--error')`, 10_000);
  assert.equal(await evaluate(`document.querySelectorAll('.ao-chat__retry').length`),0,'no retry is invented for a noneligible failure');

  await go('/v2/discuter?mock=1&lecture=1'); await openChat();
  await waitFor(`document.querySelector('.ao-chat__composer')`);
  assert.match(await evaluate(`document.querySelector('.ao-messenger__hint').textContent`), /L’envoi est indisponible/);
  assert.equal(await evaluate(`document.querySelector('.ao-chat__composer button[type=submit]').disabled`), true);
  await evaluate(`localStorage.removeItem('ao.chat.draft')`);
});

test('T-0185: Discuter desktop/mobile shell shows Atlas, the PM team, read-only state and admin composer', { skip, timeout: 40_000 }, async () => {
  const capture = async (name) => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../design/reports/t0185-chat-shell');
    mkdirSync(dir, { recursive: true });
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(dir, name), Buffer.from(shot.data, 'base64'));
  };
  await evaluate(`localStorage.setItem('ao.locale','fr');localStorage.setItem('ao.uiTheme','light');localStorage.removeItem('ao.chat.draft')`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await go('/v2/discuter?mock=capture-t0185');
  await waitFor(`document.querySelectorAll('[data-chat-agent]').length === 7`, 15_000);
  const names = await evaluate(`[...document.querySelectorAll('[data-chat-agent]')].map(row=>row.textContent)`);
  assert.doesNotMatch(await evaluate(`document.body.innerText`), /Autre \(|Other \(/, 'all backend label refs resolve in the capture locale');
  assert.ok(names.some(name=>name.includes('Atlas')));assert.ok(names.some(name=>name.includes('PM')));
  assert.ok(names.some(name=>name.includes('backend-codex')));assert.ok(names.some(name=>name.includes('security-claude')));
  const primary = await evaluate(`[...document.querySelectorAll('[data-chat-agent]')].find(row=>row.textContent.includes('Atlas')).getAttribute('data-chat-agent')`);
  await evaluate(`document.querySelector('[data-chat-agent="${primary}"]').click()`);
  await waitFor(`document.querySelector('[data-chat-session]')`, 10_000);
  await evaluate(`document.querySelector('[data-chat-session]').click()`);
  await waitFor(`document.querySelector('.ao-chat__composer')`, 10_000);
  const sentStatus=await evaluate(`document.querySelector('[data-queue-state="sent"]')?.innerText||''`);
  assert.match(sentStatus,/Envoyé à Atlas/,'sent pane status is rendered in French');
  assert.doesNotMatch(sentStatus,/pane\.messageSent/,'pane sent status never renders its raw LabelRef key');
  assert.doesNotMatch(await evaluate(`document.body.innerText`), /Autre \(|Other \(/, 'session labels resolve too');
  assert.equal(await evaluate(`document.getElementById('chat-texte').disabled`), false, 'administrator can compose to the primary agent');
  assert.ok(await evaluate(`(() => {const img=document.querySelector('[data-chat-agent="${primary}"] .ao-messenger__portrait');return img?.getAttribute('src')?.endsWith('/bureau/assets/Characters/timmy/portrait.png')&&img.naturalWidth>0})()`), 'primary keeps the loaded canonical portrait');
  await capture('discuter-desktop-admin-composer.png');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await go('/v2/discuter?mock=capture-t0185');
  await waitFor(`document.querySelectorAll('[data-chat-agent]').length === 7`, 15_000);
  assert.doesNotMatch(await evaluate(`document.querySelector('[data-chat-pane="agents"]').innerText`), /Autre \(|Other \(/, 'mobile agent list has no fallback labels');
  await waitFor(`document.querySelectorAll('[data-chat-agent] .ao-character-avatar[data-avatar-ready="true"]').length === 5`, 15_000);
  await capture('discuter-mobile-agents.png');
  await evaluate(`[...document.querySelectorAll('[data-chat-agent]')].find(row=>row.textContent.includes('critic')).click()`);
  await waitFor(`document.querySelector('[data-chat-session]')`, 10_000);
  await evaluate(`document.querySelector('[data-chat-session]').click()`);
  await waitFor(`document.querySelector('.ao-chat__composer')`, 10_000);
  assert.equal(await evaluate(`document.getElementById('chat-texte').disabled`), true, 'a read-only pane has no enabled composer');
  assert.match(await evaluate(`document.querySelector('.ao-messenger__hint').textContent`), /lecture seule|indisponible/i);
  assert.doesNotMatch(await evaluate(`document.body.innerText`), /Autre \(|Other \(/, 'read-only state labels are localized');
  await capture('discuter-mobile-read-only.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`localStorage.setItem('ao.uiTheme','light')`);
});

test('T-0223: Chat attachments preview in composer and message with a full image viewer', { skip, timeout: 60_000 }, async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../design/reports/t0223-attachment-previews');
  mkdirSync(dir, { recursive: true });
  const capture = async (name) => writeFileSync(join(dir, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
  const uploadPair = async () => {
    await evaluate(`(() => {
      const input = document.querySelector('.ao-messenger__compose input[type=file]');
      const files = new DataTransfer();
      files.items.add(new File([new Uint8Array(128)], 'atelier-equipe.jpg', {type:'image/jpeg'}));
      files.items.add(new File([new Uint8Array(256)], 'compte-rendu.pdf', {type:'application/pdf'}));
      Object.defineProperty(input, 'files', {configurable:true, value:files.files});
      input.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await waitFor(`document.querySelectorAll('.ao-chat-attachment-strip--composer li[data-upload-state="ready"]').length === 2`, 10_000);
    assert.equal(await evaluate(`document.querySelectorAll('.ao-chat-attachment-strip--composer [data-preview-kind="image"],.ao-chat-attachment-strip--composer [data-preview-kind="pdf"]').length`), 2);
  };
  const sendPair = async () => {
    await evaluate(`(() => { const t=document.getElementById('chat-texte');t.value='Voici les fichiers.';t.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await evaluate(`document.querySelector('.ao-chat__composer button[type=submit]').click()`);
    await waitFor(`document.querySelectorAll('.ao-chat__msg [data-preview-kind="image"],.ao-chat__msg [data-preview-kind="pdf"]').length === 2`, 10_000);
    await waitFor(`!document.querySelector('.ao-chat__pending')`, 10_000);
    assert.equal(await evaluate(`document.querySelectorAll('.ao-chat__msg [data-preview-kind="image"],.ao-chat__msg [data-preview-kind="pdf"]').length`), 2, 'the sent attachments stay inside the sender bubble');
  };
  await evaluate(`localStorage.setItem('ao.locale','fr');localStorage.setItem('ao.uiTheme','light');localStorage.removeItem('ao.chat.draft')`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await go('/v3/discuter?mock=capture-t0223', v3Base); await openChat();
  const issuesBefore = vmIssues.length;
  await uploadPair(); await capture('desktop-composer.png');
  await sendPair(); await capture('desktop-sent.png');
  await evaluate(`document.querySelector('.ao-chat__msg [data-preview-kind="image"] button').click()`);
  await waitFor(`document.querySelector('.ao-chat-attachment-viewer__image')?.complete && document.querySelector('.ao-chat-attachment-viewer__image')?.naturalWidth > 0`); await sleep(350); await capture('desktop-image-viewer.png');
  assert.equal(vmIssues.length, issuesBefore, 'strict VM validation accepts attachment.preview');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await go('/v3/discuter?mock=capture-t0223', v3Base); await openChat();
  await uploadPair(); await capture('phone-composer.png');
  await sendPair(); await capture('phone-sent.png');
  await evaluate(`document.querySelector('.ao-chat__msg [data-preview-kind="image"] button').click()`);
  await waitFor(`document.querySelector('.ao-chat-attachment-viewer__image')?.complete && document.querySelector('.ao-chat-attachment-viewer__image')?.naturalWidth > 0`); await sleep(350); await capture('phone-image-viewer.png');
  assert.equal(vmIssues.length, issuesBefore, 'desktop and phone capture VMs pass strict validation');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
});

test('R7-04: a hostile image URL cannot inject CSS into the card', { skip, timeout: 20_000 }, async () => {
  await go('/v2/projets?mock=1&image-hostile=1');
  await waitFor(`document.querySelector('[data-card=prj_lucie] .bu-thumb')`);
  const r = await evaluate(`(() => {
    const thumb = document.querySelector('[data-card=prj_lucie] .bu-thumb');
    const all = [thumb, ...thumb.querySelectorAll('*')].map((el) => getComputedStyle(el));
    return { fixed: all.some((c) => c.position === 'fixed'), z: all.some((c) => c.zIndex === '999999'), red: all.some((c) => c.backgroundColor === 'rgb(255, 0, 0)'),
             styleAttr: thumb.getAttribute('style') || '' };
  })()`);
  assert.deepEqual({ fixed: r.fixed, z: r.z, red: r.red }, { fixed: false, z: false, red: false });
  assert.doesNotMatch(r.styleAttr, /url\(/, 'no URL is interpolated into a style attribute');
});

test('Compétences: on a read-only instance a toggle shows « Instance de test : actions désactivées. » and changes nothing', { skip, timeout: 20_000 }, async () => {
  await go('/v2/competences/meteo?mock=1&lecture=1');
  await waitFor(`document.querySelector('.bu-switch input')`);
  assert.match(await evaluate(`document.querySelector('.ao-skill__ro').textContent`), /Instance de test : actions désactivées\./);
  await evaluate(`document.querySelector('.bu-switch input').focus()`);
  await key(' ');
  const toast = await waitFor(`document.querySelector('.bu-toast')?.textContent`);
  assert.match(toast, /Instance de test : actions désactivées\./);
  assert.equal(await evaluate(`document.querySelector('.bu-switch input').checked`), true, 'the skill stays enabled');
  // The page is office-dev's since F6; check the state, not a particular header markup.
  assert.ok(await evaluate(`document.querySelector('main').innerText.toLowerCase().includes('active')`), 'the skill still reads as active');
});

// Owner's iPad review: stacked avatars must not cover each other's initials; the detail aside starts level with the header.
const STACK_CHECK = `(() => {
  const bad = [];
  for (const ul of document.querySelectorAll('.bu-avatar-stack')) {
    const items = [...ul.children].map((li) => li.firstElementChild).filter(Boolean);
    for (let i = 0; i < items.length; i++) {
      const a = items[i].getBoundingClientRect();
      if (Math.abs(a.width - a.height) > 0.5) bad.push('not a disc: ' + items[i].className);
      const next = items[i + 1];
      if (!next) continue;
      const b = next.getBoundingClientRect();
      if (Math.abs(b.width - a.width) > 0.5) bad.push('size mismatch: ' + next.className);
      const overlap = a.right - b.left;
      if (overlap > a.width * 0.3) bad.push('overlap ' + overlap.toFixed(1) + 'px > 30%');
      const text = [...items[i].childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      if (text) {
        const r = document.createRange(); r.selectNodeContents(text);
        const glyphs = r.getBoundingClientRect();
        if (glyphs.right > b.left - 2) bad.push('initials ' + text.textContent + ' covered by ' + (glyphs.right - (b.left - 2)).toFixed(1) + 'px');
      }
    }
  }
  return { stacks: document.querySelectorAll('.bu-avatar-stack').length, bad };
})()`;

test('avatar stacks: project detail header keeps equal discs, overlap ≤ 30 %, initials uncovered', { skip, timeout: 30_000 }, async () => {
  for (const [w, path] of [[1180, '/v2/projets/prj_portail?mock=1'], [1440, '/v2/projets/prj_portail?mock=1']]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 820, deviceScaleFactor: 2, mobile: false });
    await go(path);
    await waitFor(`document.querySelector('.bu-avatar-stack')`);
    const r = await evaluate(STACK_CHECK);
    assert.ok(r.stacks > 0);
    assert.deepEqual(r.bad, [], path + ' @' + w);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
});

test('project detail: the right column starts level with the header (1024, 1180, 1440 px)', { skip, timeout: 30_000 }, async () => {
  for (const w of [1024, 1180, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 820, deviceScaleFactor: 1, mobile: false });
    await go('/v2/projets/prj_portail?mock=1');
    await waitFor(`document.querySelector('.ao-section--repo') && document.querySelector('.bu-project-header')`);
    const r = await evaluate(`(() => { const h = document.querySelector('.bu-project-header').getBoundingClientRect(); const a = document.querySelector('.ao-project__col--aside').getBoundingClientRect();
      return { headerTop: Math.round(h.top), asideTop: Math.round(a.top), side: a.left > h.right - 1 }; })()`);
    assert.ok(r.side, 'two columns at ' + w);
    assert.ok(Math.abs(r.asideTop - r.headerTop) <= 2, `aside top ${r.asideTop} vs header top ${r.headerTop} at ${w}`);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
});

test('every view model received on the pages visited matches its server schema (vmcheck, dev/test only)', { skip }, () => {
  assert.deepEqual(vmIssues, []);
});

test('no uncaught exceptions on the pages visited', { skip }, () => {
  assert.deepEqual(consoleErrors, []);
});

// ---- F7: the same UI at both mount points, API through the configured base ----

for (const [label, origin, mount, apiBase] of [['basePath / with API at /backend (production topology)', () => rootBase, '', '/backend'], ['basePath /v2/ with API at the same root (dev/staging)', () => base, '/v2', '']]) {
  test(`F7 ${label}: assets, deep links, links, API calls, manifest, login return`, { skip, timeout: 40_000 }, async () => {
    responses.length = 0;
    await go(mount + '/projets/prj_portail?mock=1', origin());
    await waitFor(`document.querySelector('.bu-sidebar') && document.querySelector('.bu-detail-header, .ao-project')`);
    // every asset of a deep link loads (relative URLs resolve against <base>, not against /projets/)
    const failed = responses.filter((r) => r.status >= 400 && !r.url.includes('/api/'));
    assert.deepEqual(failed, [], 'no asset 404 on a deep link');
    assert.ok(await evaluate(`getComputedStyle(document.body).fontFamily.length > 0 && !!document.querySelector('link[href^="bureau/bundle.css?v="]').sheet`), 'stylesheets applied');
    assert.ok(await evaluate(`[...document.images].filter(i => i.complete && i.src.includes('/bureau/assets/')).every(i => i.naturalWidth > 0)`), 'images decode');
    // the API was asked under apiBase, never under the UI's mount point
    assert.ok(responses.some((r) => new URL(r.url).pathname === apiBase + API + '/meta'), 'meta read at ' + apiBase + API + '/meta');
    // in-app links carry the mount point; a click stays client-side
    const navHrefs = await evaluate(`[...document.querySelectorAll('.bu-sidebar a[href]')].map(a => a.getAttribute('href'))`);
    assert.ok(navHrefs.length > 3 && navHrefs.every((h) => h.startsWith(mount + '/') && !h.startsWith(mount + '/v2')), JSON.stringify(navHrefs));
    await evaluate(`window.__noReload = 1; [...document.querySelectorAll('.bu-sidebar a')].find(a => a.textContent.includes('Journaux')).click()`);
    await waitFor(`location.pathname === '${mount}/journaux' && document.querySelector('.ao-logs .bu-table__row')`);
    assert.equal(await evaluate('window.__noReload'), 1, 'client-side navigation, no reload');
    // the manifest's start_url and scope resolve to the mount point
    const m = await evaluate(`(async () => { const l = document.querySelector('link[rel=manifest]').href; const j = await (await fetch(l)).json();
      return { start: new URL(j.start_url, l).pathname, scope: new URL(j.scope, l).pathname, icon: new URL(j.icons[0].src, l).pathname, iconOk: (await fetch(new URL(j.icons[0].src, l))).ok }; })()`);
    assert.deepEqual(m, { start: mount + '/', scope: mount + '/', icon: mount + '/bureau/assets/Logos/favicon.svg', iconOk: true });
    // runtime config as served
    assert.deepEqual(await evaluate(`fetch('${mount}/config.json').then(r => r.json())`), { basePath: mount + '/', apiBase, ...(process.env.AO_TEST_API_VERSION ? { apiVersion: Number(process.env.AO_TEST_API_VERSION) } : {}) });
    // logout → login keeps the mount point in suite, and logging in returns there
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Se déconnecter').click()`);
    await waitFor(`location.pathname === '${mount}/connexion'`);
    assert.equal(await evaluate('new URLSearchParams(location.search).get("suite")'), mount + '/journaux?mock=1');
    // The login scene loads its manifest/layout through api.getAsset; both stay
    // under the UI asset base, independent of the configured API base.
    await waitFor(`!!document.querySelector('.bu-login__scene[data-scene-ready="true"]')`);
    for (const asset of ['bureau/office/manifest.example.json', 'bureau/office/layout.example.json']) {
      const pathname = mount + '/' + asset;
      assert.ok(responses.some(r => new URL(r.url).pathname === pathname && r.status === 200), `login scene asset loaded at ${pathname}`);
    }
    const loginAssetFailures = responses.filter(r => r.status >= 400 && !r.url.includes('/api/'));
    assert.deepEqual(loginAssetFailures, [], 'no login scene asset 404 at either mount point');
    await waitFor(`document.querySelector('.bu-text-input#login-email')`);
    await evaluate(`(() => { document.getElementById('login-email').value = 'nom@example.invalid'; document.getElementById('login-password').value = 'secret1'; document.getElementById('login-password').focus(); })()`);
    await key('Enter');
    await waitFor(`location.pathname === '${mount}/journaux' && document.querySelector('.bu-sidebar')`);
  });
}

test('Carnet reader, traceState (R16-07): stale says the trace is the last good one; unavailable replaces « no events »', { skip, timeout: 20_000 }, async () => {
  await go('/v2/journaux/agent%3Amain%3Amain?mock=1&trace=stale');
  await waitFor(`document.querySelector('.ao-session__tracestate')`);
  assert.match(await evaluate(`document.querySelector('.ao-session__tracestate').textContent`), /dernière lue avec succès/);
  assert.ok(await evaluate(`!!document.querySelector('.bu-trace')`), 'the last good trace stays visible');
  await go('/v2/journaux/agent%3Amain%3Amain?mock=1&trace=unavailable');
  await waitFor(`document.querySelector('.ao-session__tracestate')`);
  assert.match(await evaluate(`document.querySelector('.ao-session__tracestate').textContent`), /ne permet pas de lire/);
});

test('Q03-F01: switching to English translates the shell and the page in place; filters and URL state stay', { skip, timeout: 20_000 }, async () => {
  await go('/v2/journaux?mock=1&q=menu');
  await waitFor(`document.querySelector('.ao-workspace__count')`);
  await evaluate(`[...document.querySelectorAll('.ao-lang [role=radio]')].find(b => b.lang === 'en').click()`);
  await waitFor(`document.documentElement.lang === 'en-CA' && document.querySelector('.bu-topbar__title').textContent === 'Logs'`);
  const nav = await evaluate(`[...document.querySelectorAll('.bu-nav__item')].map(a => a.textContent.trim())`);
  assert.deepEqual(nav, ['Office', 'Chat', 'Workflows', 'Projects', 'Access', 'Logs', 'Skills', 'System health', 'Store', 'Settings']);
  assert.match(await evaluate(`document.querySelector('.ao-workspace__count').textContent`), /loaded sessions? match/);
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('q')`), 'menu', 'the filter survives the switch');
  assert.equal(await evaluate(`document.querySelector('.ao-logs__search input').value`), 'menu');
  assert.match(await evaluate(`document.querySelector('.bu-live').textContent`), /^(Live|Reconnecting…)$/);
  await evaluate(`[...document.querySelectorAll('.ao-lang [role=radio]')].find(b => b.lang === 'fr').click()`);
  await waitFor(`document.documentElement.lang === 'fr-CA' && document.querySelector('.bu-topbar__title').textContent === 'Journaux'`);
});

test('default language: an English browser with no saved choice gets French; the EN choice is kept (PM, 2026-10-06)', { skip, timeout: 30_000 }, async () => {
  const { userAgent } = await send('Browser.getVersion');
  await send('Emulation.setUserAgentOverride', { userAgent, acceptLanguage: 'en-US,en' });
  try {
    await go('/v2/journaux?mock=1');
    await evaluate(`sessionStorage.setItem('ao.test.nopin', '1'); localStorage.removeItem('ao.locale'); location.reload(); true`);
    await waitFor(`document.querySelector('.bu-topbar__title') && navigator.language === 'en-US' && !localStorage.getItem('ao.locale')`);
    assert.equal(await evaluate(`document.documentElement.lang`), 'fr-CA');
    assert.equal(await evaluate(`document.querySelector('.bu-topbar__title').textContent`), 'Journaux');
    // frontend-23: the server's labels follow the same language (its stored preference may come from another device)
    // The shell can render before the probe's response completes (its resource entry appears then): wait for the event.
    await waitFor(`performance.getEntriesByType('resource').some((e) => /\\/api\\/v2\\/meta\\?locale=/.test(e.name))`).catch(() => {});
    assert.ok(await evaluate(`performance.getEntriesByType('resource').some((e) => /\\/api\\/v2\\/meta\\?locale=fr$/.test(e.name))`), 'the meta probe asks for ?locale=fr');
    await evaluate(`[...document.querySelectorAll('.ao-lang [role=radio]')].find(b => b.lang === 'en').click()`);
    await waitFor(`document.documentElement.lang === 'en-CA'`);
    await evaluate(`location.reload(); true`);
    await waitFor(`document.querySelector('.bu-topbar__title')?.textContent === 'Logs'`);
    assert.equal(await evaluate(`document.documentElement.lang`), 'en-CA', 'the explicit choice survives a reload');
  } finally {
    await evaluate(`localStorage.setItem('ao.locale', 'fr'); sessionStorage.removeItem('ao.test.nopin'); true`);
    await send('Emulation.setUserAgentOverride', { userAgent, acceptLanguage: 'fr-CA,fr' });
  }
});

const typeDraft = (text) => evaluate(`(() => { const t = document.getElementById('chat-texte'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

test('frontend-23: a phone conversation fills the screen: the page never scrolls, the thread does, the composer reaches the viewport edge', { skip, timeout: 30_000 }, async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  try {
    await go('/v2/discuter?mock=1&chat-plein=1'); await openChat();
    await waitFor(`document.querySelector('.ao-chat__msg') && document.querySelector('.ao-messenger__workspace[data-chat-screen="conversation"]')`);
    await sleep(300);
    const m = await evaluate(`(() => { const t = document.querySelector('.ao-chat .bu-chat__thread'); const send = document.querySelector('.ao-chat__send').getBoundingClientRect();
      return { page: document.scrollingElement.scrollHeight, vh: innerHeight, threadScrolls: t.scrollHeight > t.clientHeight && getComputedStyle(t).overflowY === 'auto', atEnd: Math.abs(t.scrollHeight - t.clientHeight - t.scrollTop) < 4,
        composer: Math.round(document.querySelector('.ao-chat__card').getBoundingClientRect().bottom), tabsVisible: getComputedStyle(document.querySelector('.bu-bottombar')).display !== 'none',
        round: Math.round(send.width) === Math.round(send.height), card: getComputedStyle(document.querySelector('.ao-chat__card')).borderTopWidth }; })()`);
    assert.equal(m.page, m.vh, 'the page itself does not scroll');
    assert.ok(m.threadScrolls, 'the thread scrolls');
    assert.ok(m.atEnd, 'it opens on the latest exchange');
    assert.equal(m.tabsVisible, false, 'the approved full-screen phone conversation hides app tabs');
    assert.ok(Math.abs(m.composer - m.vh) <= 1, 'composer ends at the viewport edge: ' + JSON.stringify(m));
    assert.ok(m.round, 'a round send button');
    assert.equal(m.card, '0px', 'no outer card border');
    await typeDraft('un\ndeux\ntrois');
    assert.ok(await evaluate(`document.getElementById('chat-texte').getBoundingClientRect().height > 60`), 'the composer grows with its text');
    await typeDraft('');
  } finally {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  }
});

test('frontend-24 (architect-55): the v3 Projects VM renders P0–P9 priority badges and server-owned stage controls', { skip, timeout: 30_000 }, async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: true });
  try {
    await go('/v2/projets?mock=1');
    await waitFor(`document.querySelector('[data-card=prj_accueil] .bu-priority') && document.getElementById('project-stage')`);
    const badge = (id) => evaluate(`(() => { const b = document.querySelector('[data-card=${id}] .bu-priority'); return [b.textContent, b.className, b.title]; })()`);
    assert.deepEqual(await badge('prj_accueil'), ['P9', 'bu-priority bu-priority--p9', 'P9 · minimale']);
    assert.deepEqual(await badge('prj_factures'), ['P0', 'bu-priority bu-priority--p0', 'P0 · critique']);
    assert.ok(await evaluate(`document.scrollingElement.scrollWidth <= innerWidth`), 'no sideways page scroll at 700 px');
    const options = await evaluate(`[...document.querySelectorAll('#project-stage option')].map(option=>option.value)`);
    assert.ok(options.includes('all') && options.includes('in-progress'), 'stage values come from the server VM');
    await evaluate(`(() => {const select=document.getElementById('project-stage');select.value='in-progress';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`new URLSearchParams(location.search).get('etape')==='in-progress' && document.querySelector('[data-card=prj_portail]') && !document.querySelector('.ao-projects-server[aria-busy=true]')`);
    assert.ok(await evaluate(`[...document.querySelectorAll('.ao-projects-server__card')].every(card=>card.closest('[data-column]').dataset.column==='in-progress')`), 'server-selected stage controls visible membership');
  } finally {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  }
});

test('Boutique (office-dev-21): a route of its own, in the mobile Plus list before Settings, with a title in the current language', { skip, timeout: 30_000 }, async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  try {
    await go('/v2/plus?mock=1');
    await waitFor(`document.querySelector('.bu-morelist a[href$="/boutique?mock=1"], .bu-morelist a[href$="/boutique"]')`);
    const items = await evaluate(`[...document.querySelectorAll('.bu-morelist__item')].map((a) => a.textContent.replace(a.querySelector('.ao-new-release')?.textContent || '', '').trim())`);
    assert.deepEqual(items.slice(-3), ['Boutique', 'Paramètres', 'À propos'], 'Store and Settings precede About');
    await evaluate(`document.querySelector('.bu-morelist a[href*="/boutique"]').click()`);
    await waitFor(`location.pathname === '/v2/boutique' && document.querySelector('.bu-mtopbar .ao-mtitle')?.textContent === 'Boutique'`, 8000);
    assert.equal(await evaluate(`document.querySelector('.bu-bottombar [aria-current=page]')?.getAttribute('href').split('?')[0]`), '/v2/plus', 'the Plus tab stays current');
  } finally {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  }
});

test('R19-01: a late 202 for message A never erases draft B typed meanwhile (in-memory viewer-scoped draft)', { skip, timeout: 30_000 }, async () => {
  await evaluate(`localStorage.removeItem('ao.chat.draft')`);
  await go('/v2/discuter?mock=1&chat-lent=1'); await openChat();
  await waitFor(`document.getElementById('chat-texte')`);
  await typeDraft('Message A');
  await sleep(100);
  await evaluate(`document.querySelector('.ao-chat__composer button[type=submit]').click()`);
  await sleep(400);                       // the 202 is still on its way (1.5 s)
  await typeDraft('Brouillon B');
  await waitFor(`document.querySelector('.ao-chat__pending')`, 6000);   // A was accepted
  await sleep(300);
  assert.equal(await evaluate(`document.getElementById('chat-texte').value`), 'Brouillon B');
  assert.equal(await evaluate(`localStorage.getItem('ao.chat.draft')`), null,'private drafts are not stored in browser storage');
  await evaluate(`localStorage.removeItem('ao.chat.draft')`);
});

test('R19-05: with a full 50-message window, every reply is announced, the same text twice included', { skip, timeout: 40_000 }, async () => {
  await evaluate(`localStorage.removeItem('ao.chat.draft')`);
  await go('/v2/discuter?mock=1&chat-plein=1'); await openChat();
  await waitFor(`document.querySelectorAll('.ao-chat__msg').length >= 50`);
  await evaluate(`(() => { window.__said = []; const r = document.querySelector('.ao-chat [aria-live=polite]'); new MutationObserver(() => { if (r.textContent) window.__said.push(r.textContent); }).observe(r, { childList: true, characterData: true, subtree: true }); return true; })()`);
  for (const [i, text] of [[1, 'Première question.'], [2, 'Deuxième question.']]) {
    await typeDraft(text);
    await sleep(100);
    await evaluate(`document.querySelector('.ao-chat__composer button[type=submit]').click()`);
    await waitFor(`window.__said.length >= ${i}`, 10_000);
    await waitFor(`!document.querySelector('.ao-chat__pending')`, 6000);
  }
  const said = await evaluate(`window.__said`);
  assert.equal(said.length, 2, JSON.stringify(said));
  assert.ok(said.every((x) => /Nouveau message reçu\./.test(x)));
  assert.equal(await evaluate(`document.querySelectorAll('.ao-chat__msg').length`), 50, 'the window stays at 50');
});

const fill = (id, text) => evaluate(`(() => { const t = document.getElementById(${JSON.stringify(id)}); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const submitStep = () => evaluate(`document.querySelector('.ao-setup__nav button[type=submit]').click()`);
const onStep = (chapter) => waitFor(`new URLSearchParams(location.search).get('etape') === ${JSON.stringify(String(STEPS.indexOf(chapter)))} && document.getElementById('setup-etape')`, 8000);
const setupReady = () => waitFor(`document.querySelector('.ao-setup__nav button[type=submit]:not(:disabled)')`, 8000);
const ownerFields = async (code = 'AO-7Q2K-91MX', confirmation = 'mot-de-passe-test') => {
  await fill('setup-code', code); await fill('setup-owner', 'Camille'); await fill('setup-email', 'camille@example.invalid');
  await fill('setup-password', 'mot-de-passe-test'); await fill('setup-password2', confirmation); await sleep(80);
};
const startSetup = async () => {
  await ownerFields(); await submitStep(); await onStep('detection');
  await waitFor(`document.querySelector('.ao-setup__body > [role=status]')`); await setupReady();
  // Exercise the explicit retry and wait for its actual busy/completion cycle, including when auto-detection is still starting.
  await evaluate(`document.querySelector('.ao-setup__body > button').click()`);
  await waitFor(`document.querySelector('.ao-setup__body > button:disabled')`); await setupReady();
  await submitStep(); await onStep('runtime');
};
const setupPress = (label) => evaluate(`[...document.querySelectorAll('.ao-setup__body > .bu-btn')].find(b => b.textContent.includes(${JSON.stringify(label)})).click()`);
const toSetupSkills = async () => {
  await submitStep(); await onStep('identities');
  await waitFor(`document.querySelectorAll('input[name=setup-primary]').length === 2 && document.querySelectorAll('.ao-sc:not([aria-busy=true]) .ao-sc__look').length === 2`);
  assert.ok(await evaluate(`document.querySelector('input[name=setup-primary]').checked`), 'runtime primary is suggested');
  await sleep(100); await submitStep(); await onStep('office');
  await fill('setup-name', 'Bureau de démonstration'); await fill('setup-zone', 'Europe/Paris'); await sleep(80);
  await submitStep(); await onStep('skills'); await waitFor(`document.querySelectorAll('[data-skill-agent]').length === 2`); await setupReady();
};
// T-0033: the network chapter is the external-access wizard (mode → security → summary → verify); keep the bureau local.
// e618481c: its Continue lives in the setup frame's fixed footer.
const ACCESS = '[data-external-access=setup]';
const accessPress = async (sel, ready) => { await waitFor(`document.querySelector(${JSON.stringify(sel)})`, 8000); await evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`); if (ready) await waitFor(`document.querySelector(${JSON.stringify(ready)})`, 8000); };
const skillsToReview = async () => {
  await submitStep();
  await waitFor(`new URLSearchParams(location.search).get('etape') === ${JSON.stringify(String(STEPS.indexOf('network')))} && document.querySelector('${ACCESS} [data-step=mode]')`, 8000);
  await accessPress(`${ACCESS} [data-step=mode] input[name="external-access-mode"][value="local"]`);
  await accessPress(`.ao-setup > .ao-frame__foot .ao-external__footer button[aria-label="Continuer"]`, `${ACCESS} [data-step=security]`);
  await accessPress(`.ao-setup > .ao-frame__foot .ao-external__footer button[aria-label="Continuer"]`, `${ACCESS} [data-step=review]`);
  await accessPress(`${ACCESS} [data-step=review] button[aria-label="Préparer le résumé"]`, `${ACCESS} [data-step=review] .ao-external__confirm`);
  await accessPress(`${ACCESS} [data-step=review] .ao-external__confirm input[type="checkbox"]`);
  await accessPress(`${ACCESS} [data-step=review] button[aria-label="Préparer pour la publication finale"]`, `${ACCESS} [data-step=verify]`);
  await accessPress(`${ACCESS} [data-step=verify] button[aria-label="Continuer"]`);
  await onStep('review');
};

/**
 * R27-07: the requested route really rendered: the shell's main region, no boot screen, no lazy-page placeholder, and a loaded page (or the « Plus » list, or an empty state) with text; the title lives in the shell. Throws on timeout, naming the route.
 */
const READY = `(() => { const m = document.querySelector('#contenu'); if (!m || document.querySelector('.ao-boot') || m.querySelector('.bu-page[aria-busy=true]')) return false;
  const h = m.querySelector('.bu-page, .bu-morelist, .ao-state__title, .bu-empty__title'); return !!h && h.textContent.trim().length > 0; })()`;
async function routeReady(route, timeout = 10_000) {
  try { await waitFor(`decodeURIComponent(location.pathname).endsWith(${JSON.stringify('/' + decodeURIComponent(route))}) && (${READY})`, timeout); } catch { throw new Error(`route ${route} did not render (no main content)`); }
  const at = decodeURIComponent(await evaluate('location.pathname'));
  if (!at.endsWith('/' + decodeURIComponent(route))) throw new Error(`route ${route} rendered ${at} instead (a redirect is not the page)`);
}

test('R27-07: the readiness check fails when the application module is unavailable (the a11y guards never scan a blank page)', { skip, timeout: 60_000 }, async () => {
  await send('Network.setBlockedURLs', { urls: ['*/v2/app.js*'] });
  await send('Network.clearBrowserCache');
  try {
    await send('Page.navigate', { url: base + '/v2/journaux?mock=1' });
    await sleep(500);
    await assert.rejects(routeReady('journaux', 3000), /route journaux did not render/);
  } finally { await send('Network.setBlockedURLs', { urls: [] }); }
  await go('/v2/journaux?mock=1');
  await routeReady('journaux');
});

// F10 a11y guard: axe-core (devDependency) on every main route at 375 and 1280, light and dark. Serious and critical
// issues fail, except KNOWN (owner and report named, removed when fixed). `target-size` is left to the 44 px check and
// the focus walk below: axe counts a control scrolled under a sticky bar as « obscured », which depends on scroll.
const AXE = (() => { try { return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../node_modules/axe-core/axe.min.js'), 'utf8'); } catch { return null; } })();
const A11Y_ROUTES = ['bureau', 'discuter', 'flux', 'flux/ffffffff-0c01-4000-8000-000000000006', 'projets', 'projets/prj_k3v9q2m8x1c4d7fz', 'projets/importer',
  'habilitations', 'habilitations/discord-user%3A100000000000000001', 'journaux', 'journaux/agent%3Amain%3Asubagent%3Ascout-veille', 'competences', 'sante', 'plus', 'nulle-part', 'a-propos', 'boutique'];
const KNOWN = {};   // (office-dev fixed the Bureau roster's accessible name in O8, office-dev-15)
test('F10: axe finds no serious or critical issue on the main routes (375/1280, light/dark)', { skip: skip || !AXE ? 'no Chrome or no axe-core' : false, timeout: 240_000 }, async () => {
  const found = [];
  const from = responses.length;
  for (const [w, scheme] of [[375, 'light'], [1280, 'dark']]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 820, deviceScaleFactor: 1, mobile: w < 600 });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    for (const route of A11Y_ROUTES) {
      await go('/v2/' + route + '?mock=1');
      await routeReady(route);   // R27-07: a page that never renders fails here, it is never scanned blank
      await sleep(400);
      if (!(await evaluate('!!window.axe'))) await evaluate(AXE);   // injected by CDP, not eval(): the page's CSP has no 'unsafe-eval'
      const v = await evaluate(`(async () => {
        const r = await axe.run(document, { resultTypes: ['violations'], rules: { 'target-size': { enabled: false } },
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
        return r.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => x.id + ' ' + x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(', ')); })()`);
      for (const issue of v || []) if (!(KNOWN[route] || []).includes(issue.split(' ')[0])) found.push(`${route} ${w} ${scheme}: ${issue}`);
    }
  }
  await send('Emulation.setEmulatedMedia', { features: [] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(found, []);
  // Self-hosted fonts (frontend-17): across these 30 page loads, nothing is fetched from another origin.
  assert.deepEqual(responses.slice(from).map((r) => r.url).filter((u) => /^https?:/.test(u) && !/^https?:\/\/127\.0\.0\.1[:/]/.test(u)), []);
});

test('F10: at 375 px, keyboard focus never lands under the sticky bars (WCAG 2.4.11)', { skip, timeout: 90_000 }, async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 700, deviceScaleFactor: 1, mobile: true });
  const hidden = [];
  for (const route of ['journaux/agent%3Amain%3Asubagent%3Ascout-veille', 'projets/prj_k3v9q2m8x1c4d7fz', 'habilitations']) {
    await go('/v2/' + route + '?mock=1');
    await routeReady(route);
    await sleep(300);
    for (let i = 0; i < 40; i++) {
      await key('Tab');
      const r = await evaluate(`(() => { const el = document.activeElement; if (!el || el === document.body || el.closest('.bu-bottombar')) return null;
        const b = el.getBoundingClientRect(); if (!b.height) return null;
        const at = document.elementFromPoint(Math.min(b.left + 8, innerWidth - 1), Math.min(Math.max(b.top + b.height / 2, 0), innerHeight - 1));
        return at && !el.contains(at) && at.closest('.bu-bottombar, .bu-mtopbar, .bu-topbar') ? (el.className || el.tagName) + ' under ' + (at.closest('.bu-bottombar, .bu-mtopbar, .bu-topbar').className) : null; })()`);
      if (r) hidden.push(route + ': ' + r);
    }
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(hidden, []);
});

test('F10: offline shows the connection banner after 3 s; back online, the stream reconnects and the banner goes', { skip, timeout: 60_000 }, async () => {
  await go('/v2/journaux?mock=1');
  await waitFor(`document.querySelector('.bu-live:not(.bu-live--stale):not(.bu-live--off)')`, 8000);
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(1500);
  assert.equal(await evaluate(`!!document.querySelector('.ao-connbanner')`), false, 'no banner for a short drop');
  await waitFor(`document.querySelector('.ao-connbanner')`, 6000);
  assert.match(await evaluate(`document.querySelector('.ao-connbanner').textContent`), /hors ligne/);
  assert.equal(await evaluate(`document.querySelector('.ao-connbanner').getAttribute('role')`), 'status');
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await waitFor(`!document.querySelector('.ao-connbanner') && document.querySelector('.bu-live:not(.bu-live--stale):not(.bu-live--off)')`, 8000);
});

test('F11: a deep link fetches its page chunk with the core (no waterfall); hovering a link preloads that page', { skip, timeout: 60_000 }, async () => {
  const { routesOf } = await import('../../scripts/first-load.js').then((m) => m.default || m);
  const routes = routesOf();
  await send('Network.clearBrowserCache');
  requests.length = 0;
  await go('/v2/journaux/agent%3Amain%3Asubagent%3Ascout-veille?mock=1');
  await waitFor(`document.querySelector('.ao-session:not([aria-busy=true])')`, 10_000);
  // Event-based (no wall time): who initiated each module's request. T-0106: route-preload.js no longer injects
  // <link rel=modulepreload> (a failed one stays cached as failed in the module map for the document's lifetime): it
  // queues the route's modules and api.js's prewarm (the transport layer) fetches them into the HTTP cache as soon as
  // app.js attaches it, before the page is imported. The page's own import of a module is then a second request, which
  // must be answered by the HTTP cache, never the network: no module of the chunk waits for its parent to arrive.
  const name = (r) => (r.by || r.type || '').split('/').pop().split('?')[0];
  const of = (m) => requests.filter((r) => new URL(r.url).pathname.endsWith('/v2/' + m));
  const network = (m) => of(m).filter((r) => !r.cached).map(name);
  const wrong = routes.session.modules.map((m) => [m, network(m)]).filter(([m, b]) => b.length !== 1 || b[0] !== 'api.js' || name(of(m)[0]) !== 'api.js');
  assert.deepEqual(wrong, [], 'every module of the session chunk is fetched once from the network, up front, by the route prewarm (api.js); an import of it is served by the HTTP cache');
  const flux = routes.flux.modules.filter((m) => !routes.session.modules.includes(m));   // shared modules are already there
  const warmed = (done = false) => flux.filter((m) => of(m).some((r) => name(r) === 'api.js' && (!done || r.done)));
  assert.deepEqual(warmed(), [], 'not preloaded yet');
  await evaluate(`document.querySelector('.bu-sidebar a[href*="/flux"]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
  const until = Date.now() + 5000;
  while (warmed(true).length < flux.length && Date.now() < until) await sleep(50);
  assert.deepEqual(warmed(true), flux, 'hover preloads the whole chunk');
  await evaluate(`document.querySelector('.bu-sidebar a[href*="/flux"]').click()`);
  await waitFor(`location.pathname.endsWith('/flux') && document.querySelector('main .ao-frame__body .ao-flows:not([aria-busy=true])')`, 8000);
  assert.deepEqual(flux.map((m) => [m, network(m)]).filter(([, b]) => b.length !== 1 || b[0] !== 'api.js'), [], 'the hovered page then loads from the warmed HTTP cache');
});

test('artist-15 state spots: only the active theme\'s variant is fetched and shown', { skip, timeout: 60_000 }, async () => {
  await evaluate(`localStorage.removeItem('ao.uiTheme')`); // do not inherit frontend-27's explicit dark-theme choice
  for (const scheme of ['dark', 'light']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await go('/v2/connexion?mock=1');   // leave the page, and drop the previous pass's images from every cache
    await send('Network.clearBrowserCache');
    const from = responses.length;
    await go('/v2/nulle-part?mock=1');
    await waitFor(`[...document.querySelectorAll('.ao-stateart img')].some((i) => i.complete && i.naturalWidth > 0 && getComputedStyle(i).display !== 'none')`, 8000);
    const shown = await evaluate(`[...document.querySelectorAll('.ao-stateart img')].filter((i) => getComputedStyle(i).display !== 'none').map((i) => i.getAttribute('src').split('/').pop())`);
    assert.deepEqual(shown, [`state-not-found-${scheme}.webp`]);
    const fetched = responses.slice(from).map((r) => r.url.split('/').pop()).filter((u) => u.startsWith('state-'));
    assert.deepEqual(fetched, [`state-not-found-${scheme}.webp`], 'the other variant is never downloaded');
  }
  await send('Emulation.setEmulatedMedia', { features: [] });
});

// F12, split per state (frontend-21): ~70 navigations in one test outlived its deadline under full-suite load, and its
// timeout cascaded into the next tests. Each state is its own test now; the waits are events, the deadlines generous.
const CSP_ROUTES = ['bureau', 'discuter', 'flux', 'flux/ffffffff-0c01-4000-8000-000000000006', 'projets', 'projets/prj_k3v9q2m8x1c4d7fz', 'projets/importer',
  'habilitations', 'habilitations/discord-user%3A100000000000000001', 'journaux', 'journaux/agent%3Amain%3Asubagent%3Ascout-veille', 'competences',
  'sante', 'plus', 'nulle-part', 'connexion', 'a-propos', 'boutique'];
async function cspSweep(paths) {
  const seen = [];
  await evaluate(`sessionStorage.removeItem('ao.csp')`);
  for (const path of paths) {
    await go('/v2/' + path);
    await sleep(500);
    seen.push(...JSON.parse(await evaluate(`sessionStorage.getItem('ao.csp') || '[]'`)));
    await evaluate(`sessionStorage.removeItem('ao.csp')`);
  }
  return [...new Set(seen)];
}

test('F12: the security headers are set (strict CSP, no HSTS over http, nosniff, referrer, COOP, permissions)', { skip, timeout: 60_000 }, async () => {
  const head = await fetch(base + '/v2/journaux');
  const csp = head.headers.get('content-security-policy');
  for (const d of ["default-src 'self'", "style-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"]) assert.ok(csp.includes(d), d);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.deepEqual(csp.split('; ').filter((d) => /https?:/.test(d)), ["img-src 'self' data: blob: https:"], 'only images may come from another origin (api.md: public https thumbnails and avatars)');
  assert.deepEqual(['x-content-type-options', 'referrer-policy', 'cross-origin-opener-policy'].map((h) => head.headers.get(h)), ['nosniff', 'strict-origin-when-cross-origin', 'same-origin']);
  assert.match(head.headers.get('permissions-policy'), /camera=\(\)/);
  assert.equal(head.headers.get('strict-transport-security'), null, 'no HSTS over plain http');
});
for (const variant of ['?mock=1', '?mock=vide', '?mock=erreur', '?mock=1&lecture=tout']) {
  test(`F12: zero CSP violations on every route (${variant})`, { skip, timeout: 300_000 }, async () => {
    assert.deepEqual(await cspSweep(CSP_ROUTES.map((r) => r + variant)), []);
  });
}
test('F12: zero CSP violations in the first-run setup, the locked setup and the office editor', { skip, timeout: 120_000 }, async () => {
  const seen = await cspSweep(['?mock=installation', '?mock=installation&installation=verrouille', 'bureau?mock=1&edit=1']);
  await evaluate(`sessionStorage.removeItem('ao.mock.configured')`);
  assert.deepEqual(seen, []);
});

test('R27-02: offline, the Bureau shows its last snapshot as stale and frozen, not live; back online it resumes', { skip, timeout: 60_000 }, async () => {
  const state = `(() => ({ kind: document.getElementById('ao-bureau-lead')?.dataset.kind, live: document.querySelectorAll('.ao-roster__state--live').length,
    frozen: !!document.querySelector('[data-frozen]'), cap: !!document.querySelector('.ao-bureau__stagecap--offline') }))()`;
  await go('/v2/bureau?mock=1');
  await routeReady('bureau');
  await waitFor(`document.querySelectorAll('.ao-roster__state--live').length > 0 && document.getElementById('ao-bureau-lead')`, 10_000);
  const live = await evaluate(state);
  assert.ok(live.kind !== 'stale' && live.live > 0 && !live.frozen, JSON.stringify(live));
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  try {
    // Wait for the whole offline state (the scene freezes on its next frame, after the headline): events, not time.
    await waitFor(`(() => { const s = ${state}; return s.kind === 'stale' && s.live === 0 && s.frozen && s.cap; })()`, 5000)
      .catch(async () => assert.fail('offline state never complete: ' + JSON.stringify(await evaluate(state))));
  } finally { await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); }
  await waitFor(`document.getElementById('ao-bureau-lead')?.dataset.kind !== 'stale' && !document.querySelector('[data-frozen]')`, 10_000);
  assert.ok((await evaluate(state)).live > 0, 'live again');
});

test('F13: « À propos » from the user menu (versions, API, notices with their licences); « ? » opens the shortcuts sheet', { skip, timeout: 60_000 }, async () => {
  const capture = async (name) => writeFileSync(join(dirname(fileURLToPath(import.meta.url)), `../../design/reports/office-dev-64-${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
  const setTheme = async (mode) => {
    await evaluate(`document.querySelector('.ao-theme [title="${mode === 'light' ? 'Clair' : 'Sombre'}"]').click()`);
    await waitFor(`document.documentElement.dataset.theme === '${mode}'`);
  };
  const resetSeen = async () => evaluate(`(() => { for (let i=localStorage.length-1;i>=0;i--) { const k=localStorage.key(i); if (k.startsWith('ao.release-notes.v1.')) localStorage.removeItem(k); } window.dispatchEvent(new StorageEvent('storage',{key:'ao.release-notes.v1.reset'})); })()`);
  const reportDir = join(dirname(fileURLToPath(import.meta.url)), '../../design/reports');
  mkdirSync(reportDir, { recursive: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await resetSeen();
  await go('/v2/journaux?mock=1');
  await routeReady('journaux');
  await waitFor(`document.querySelector('.bu-usercard .ao-new-release')`);
  const badgeOverlap = await evaluate(`(() => { const a=document.querySelector('.bu-usercard .ao-new-release')?.getBoundingClientRect(), b=document.querySelector('.bu-usercard__role')?.getBoundingClientRect(); return !!a&&!!b&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top; })()`);
  assert.equal(badgeOverlap, false, 'the release badge on the About icon never overlaps the account role');
  await setTheme('light'); await capture('badge-1440-light');
  await setTheme('dark'); await capture('badge-1440-dark');
  await setTheme('light');
  const releaseRequestStart = requests.length;
  await evaluate(`document.querySelector('.bu-usercard a[href*="/a-propos"]').click()`);
  await routeReady('a-propos');
  await waitFor(`document.querySelectorAll('.ao-release-notes__item').length === 15`, 6000);
  await waitFor(`!document.querySelector('.bu-usercard .ao-new-release')`, 6000);
  const desktopScroll = await evaluate(`(() => { const body=document.querySelector('.ao-frame__body'); return {document:document.scrollingElement.scrollHeight<=innerHeight,frame:body.scrollHeight>body.clientHeight}; })()`);
  assert.ok(desktopScroll.document && desktopScroll.frame, JSON.stringify(desktopScroll));
  const releaseRequest = requests.slice(releaseRequestStart).find((request) => new URL(request.url).pathname.endsWith('/releases.json'));
  assert.ok(releaseRequest, 'release notes load with the About route');
  assert.equal(new URL(releaseRequest.url).searchParams.get('v'), await evaluate(`document.querySelector('meta[name="ao-build"]').content`), 'release data is pinned to this frontend build');
  let releasesText = await evaluate(`document.querySelector('.ao-release-notes').innerText`);
  assert.match(releasesText, /Nouveautés[\s\S]*11 oct\.[\s\S]*01:47 UTC — Suivre les agents délégués[\s\S]*Version 1\.1\.0/);
  assert.equal(await evaluate(`document.querySelectorAll('.ao-release-notes__latest').length`), 1, 'only newest release is highlighted');
  assert.equal(await evaluate(`new Set([...document.querySelectorAll('.ao-release-notes__title strong')].map((n) => n.textContent)).size`), 15, 'each release has a distinct identity');
  assert.match(releasesText, /agents délégués affichent maintenant le nom de l’agent/i);
  await evaluate(`document.querySelector('.ao-frame__body').scrollTop = 0`);
  await capture('about-1440-light');
  await setTheme('dark'); await capture('about-1440-dark'); await setTheme('light');
  await evaluate(`document.querySelector('.ao-lang button[lang="en"]').click()`);
  await waitFor(`document.querySelector('.ao-release-notes').innerText.includes('What’s new')`);
  releasesText = await evaluate(`document.querySelector('.ao-release-notes').innerText`);
  assert.match(releasesText, /What’s new[\s\S]*Oct 11, 2026[\s\S]*01:47 UTC — Follow delegated agents[\s\S]*Version 1\.1\.0/);
  assert.match(releasesText, /Latest/);
  await evaluate(`document.querySelector('.ao-lang button[lang="fr"]').click()`);
  await waitFor(`document.querySelector('.ao-release-notes').innerText.includes('Nouveautés')`);
  await waitFor(`document.querySelectorAll('.ao-about__notice').length >= 6`, 6000);   // the notices list arrives after the page
  const text = await evaluate(`document.querySelector('.ao-about').innerText`);
  for (const s of ['Cette installation', 'Version du serveur', 'maquette', API, 'Raccourcis clavier', 'Logiciels tiers', 'Preact', 'htm', 'Lucide', 'Inter', 'Sora', 'JetBrains Mono', 'OFL-1.1'])
    assert.ok(text.includes(s), s);
  assert.ok(!/axe/i.test(text), 'dev-only tools are not listed');
  // a licence text loads when its notice is opened
  await evaluate(`[...document.querySelectorAll('.ao-about__notice')].find((n) => n.textContent.includes('Sora')).querySelector('summary').click()`);
  await waitFor(`[...document.querySelectorAll('.ao-about__text')].some((p) => /SIL OPEN FONT LICENSE/i.test(p.textContent))`, 6000);
  // « ? » opens the sheet; not while typing; Escape closes it and gives focus back
  await evaluate(`document.querySelector('.ao-about__keysbtn').focus()`);
  await key('?', { text: '?' });
  // Ready when focus is inside it: the modal's effect moves focus and installs its keys (Escape) together.
  await waitFor(`document.querySelector('[role=dialog] .ao-keys') && document.activeElement && !!document.activeElement.closest('[role=dialog]')`, 3000);
  assert.match(await evaluate(`document.querySelector('[role=dialog]').textContent`), /Raccourcis clavier[\s\S]*Envoyer le message/);
  await key('Escape');
  await waitFor(`!document.querySelector('[role=dialog]')`, 3000).catch(async () => assert.fail('sheet still open: ' + await evaluate(`document.querySelectorAll('[role=dialog]').length + ' ' + document.activeElement.outerHTML.slice(0, 100)`)));
  await waitFor(`document.activeElement && document.activeElement.classList.contains('ao-about__keysbtn')`, 3000);   // focus returns to where it was
  for (const width of [390, 375]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await resetSeen(); await go('/v2/plus?mock=1'); await routeReady('plus');
    await waitFor(`document.querySelector('.bu-morelist .ao-new-release')`);
    await setTheme('light'); await capture(`badge-${width}-light`);
    await setTheme('dark'); await capture(`badge-${width}-dark`);
    await setTheme('light');
    await evaluate(`document.querySelector('.bu-morelist a[href*="/a-propos"]').click()`);
    await routeReady('a-propos'); await waitFor(`document.querySelectorAll('.ao-release-notes__item').length === 15`);
    await waitFor(`!document.querySelector('.bu-morelist .ao-new-release')`);
    const mobileNotes = await evaluate(`(() => { const body=document.querySelector('.ao-frame__body'); return {width:document.documentElement.clientWidth, page:document.querySelector('.ao-release-notes').getBoundingClientRect().width, title:document.querySelector('#about-releases').textContent, document:document.scrollingElement.scrollHeight<=innerHeight, frame:body.scrollHeight>body.clientHeight}; })()`);
    assert.equal(mobileNotes.width, width);
    assert.ok(mobileNotes.page <= mobileNotes.width && mobileNotes.title === 'Nouveautés' && mobileNotes.document && mobileNotes.frame, JSON.stringify(mobileNotes));
    await evaluate(`document.querySelector('.ao-frame__body').scrollTop = 0`);
    await capture(`about-${width}-light`);
    await setTheme('dark'); await capture(`about-${width}-dark`);
    await setTheme('light');
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await go('/v2/discuter?mock=1'); await openChat();
  await routeReady('discuter');
  await waitFor(`document.querySelector('main textarea')`, 8000);
  await evaluate(`document.querySelector('main textarea').focus()`);
  await key('?', { text: '?' });
  await sleep(300);
  assert.equal(await evaluate(`!!document.querySelector('[role=dialog]')`), false, 'typing « ? » in a field types it');
});

test('G5: the whole UI on contract 3.0 (mock /api/v3): no /api/v2 call, 3.0 values read, no « Autre », no error', { skip, timeout: 60_000 }, async () => {
  const errorsBefore = consoleErrors.length;
  const from = responses.length;
  const text = () => evaluate(`document.querySelector('main').innerText`);
  await go('/v3/journaux?mock=1', v3Base);
  await waitFor(`document.querySelector('.ao-logs .bu-table__row')`, 8000);
  const logs = await text();
  assert.match(logs, /Tâche planifiée/); assert.doesNotMatch(logs, /Autre \(|sessionKind\./);
  await go('/v3/journaux?mock=1&type=internal', v3Base);
  await go('/v3/habilitations?mock=1', v3Base);
  await waitFor(`document.querySelectorAll('.ao-access a[href*="/habilitations/"]').length > 1`, 8000);
  assert.doesNotMatch(await text(), /Autre \(|interlocutorKind\./);
  await evaluate(`document.querySelector('.ao-access a[href*="/habilitations/"]').click()`);
  await waitFor(`document.getElementById('il-titre')`, 8000);
  assert.match(await evaluate(`document.querySelector('.ao-interlocutor .bu-detail-header').textContent`), /Personne[^]*Discord/);
  await go('/v3/projets?mock=1&filtre=with-timmy', v3Base);   // an old link: read as with-agent
  await waitFor(`document.querySelector('.ao-projects-server__card[data-card]')`, 8000);
  assert.equal(await evaluate(`document.querySelector('.ao-projects-server__card[data-card=prj_portail]')?.closest('[data-column]')?.dataset.column`), 'in-progress',
    'the legacy primary-agent filter still resolves and returns the server-selected projects');
  await go('/v3/sante?mock=1', v3Base);
  await waitFor(`document.querySelector('.ao-health:not([aria-busy=true])')`, 8000);
  await sleep(400);
  const calls = responses.slice(from).map((r) => new URL(r.url).pathname).filter((u) => u.startsWith('/api/'));
  assert.ok(!calls.some((u) => u.startsWith('/api/v2/')), calls.join(' '));
  assert.ok(calls.includes('/api/v3/meta'), 'the boot probe asks /api/v3/meta');
  assert.deepEqual(consoleErrors.slice(errorsBefore), []);
});

test('R20-02: a late check or discovery never validates a connection changed meanwhile', { skip, timeout: 60_000 }, async () => {
  const back = () => evaluate(`document.querySelector('.ao-setup__nav button[type=button]').click()`);
  const press = (label) => evaluate(`[...document.querySelectorAll('.ao-setup__body > .bu-btn')].find(b => b.textContent.includes(${JSON.stringify(label)})).click()`);
  const ready = () => waitFor(`!document.querySelector('.ao-setup__nav button[type=submit]').disabled`, 8000);
  const status = () => evaluate(`document.querySelector('.ao-setup__status')?.textContent || ''`);
  await evaluate(`sessionStorage.removeItem('ao.mock.configured')`);
  await go('/v2/?mock=installation&setup-lent=2000');
  await waitFor(`document.getElementById('setup-code')`);
  await startSetup();
  await fill('setup-url', 'ws://127.0.0.1:18789'); await fill('setup-token', 'jeton-a'); await sleep(80); await submitStep(); await onStep('gateway');
  await press('Tester');                                   // gateway A, answered in 2 s
  await sleep(150); await back(); await onStep('runtime');
  await fill('setup-url', 'ws://127.0.0.1:18790'); await sleep(2600);   // gateway B; A's success lands meanwhile
  await ready(); await submitStep(); await onStep('gateway');
  assert.doesNotMatch(await status(), /connectée/, 'A’s answer is not shown beside B');
  await submitStep(); await sleep(200);
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('etape')`), String(STEPS.indexOf('gateway')), 'B still has to be checked');

  await press('Tester'); await waitFor(`document.querySelector('.ao-setup__status')?.textContent.includes('connectée')`, 6000);
  await submitStep(); await onStep('agents');
  await press('Rechercher');                               // discovery through B, answered in 2 s
  await sleep(150); await back(); await onStep('gateway'); await back(); await onStep('runtime');
  await fill('setup-token', 'jeton-c'); await sleep(2600);   // B's agents land meanwhile
  await ready(); await submitStep(); await onStep('gateway');
  await press('Tester'); await waitFor(`document.querySelector('.ao-setup__status')?.textContent.includes('connectée')`, 6000);
  await submitStep(); await onStep('agents');
  assert.doesNotMatch(await status(), /2 agents/, 'the old discovery’s agents are not restored');
  await submitStep(); await sleep(200);
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('etape')`), String(STEPS.indexOf('agents')), 'a new discovery is required');
});

test('frontend-25: at 360 px the skills opt-out fits, leaves workspaces unchanged, and is preserved in review and save', { skip, timeout: 60_000 }, async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
  try {
    await evaluate(`sessionStorage.removeItem('ao.mock.configured')`);
    await go('/v2/?mock=installation&installation=etiquette-deja'); await waitFor(`document.getElementById('setup-code')`);
    await startSetup(); await fill('setup-url', 'ws://127.0.0.1:18789'); await fill('setup-token', 'jeton-de-test'); await sleep(80);
    await submitStep(); await onStep('gateway'); await setupPress('Tester');
    await waitFor(`document.querySelector('.ao-setup__status').textContent.includes('connectée')`);
    await submitStep(); await onStep('agents'); await setupPress('Rechercher'); await waitFor(`document.querySelector('[data-project-tag=installed]')`);
    await toSetupSkills();
    assert.match(await evaluate(`document.querySelector('[data-skill-agent=atelier-agent] [role=status]').textContent`), /^Installée$/);
    assert.ok(await evaluate(`(() => { const c = document.querySelector('[data-skill-agent]').getBoundingClientRect(); const footer=document.querySelector('.ao-setup__footer').getBoundingClientRect(); return c.left >= 0 && c.right <= innerWidth && document.scrollingElement.scrollWidth <= innerWidth && document.scrollingElement.scrollHeight <= innerHeight && footer.bottom <= innerHeight; })()`), 'skills and anchored footer fit at 360 px without document scroll');
    for (const id of ['atelier-agent', 'code-agent']) {
      await evaluate(`document.querySelector('[data-skill-agent="${id}"] input').click()`);
      await waitFor(`!document.querySelector('[data-skill-agent="${id}"] input').checked`); await sleep(80);
    }
    assert.equal(await evaluate(`document.querySelectorAll('[data-skill-agent] input:checked').length`), 0);
    assert.ok(await evaluate(`document.getElementById('setup-install').disabled`));
    await skillsToReview();
    assert.match(await evaluate(`document.querySelector('.ao-setup__review').textContent`), /Orion : Installée, Lyra : À installer/);
    const planned = await evaluate(`(async()=>{const {post}=await import('/v2/api.js?v='+document.querySelector('meta[name=ao-build]').content);return (await post('/api/v2/setup/integrations/plan',{setupCode:'AO-7Q2K-91MX',runtime:{adapter:'openclaw',gatewayUrl:'ws://127.0.0.1:18789'},locale:'fr'},{quiet:true})).data.result.agents.map(a=>[a.id,a.status]);})()`);
    assert.deepEqual(planned,[['atelier-agent','installed'],['code-agent','absent']], 'opt-out leaves both agent workspace statuses unchanged');
    await submitStep(); await onStep('done');
    assert.equal(await evaluate(`document.querySelector('[data-tag-result]')`), null, 'save does not claim an automatic installation after explicit skill review');
    assert.match(await evaluate(`document.querySelector('.ao-setup h2').textContent`), /bureau est prêt/);
  } finally {
    await evaluate(`sessionStorage.removeItem('ao.mock.configured')`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  }
});

test('F8 first-run setup: owner → detection → runtime → check → agents → identities → office → skills → network → review (no secret) → saved', { skip, timeout: 60_000 }, async () => {
  await evaluate(`sessionStorage.removeItem('ao.mock.configured')`);
  await go('/v2/?mock=installation&installation=injoignable'); await waitFor(`document.getElementById('setup-code')`);
  assert.ok(await evaluate(`!document.querySelector('.bu-sidebar')`), 'no shell before configuration');
  await startSetup(); await fill('setup-url', 'ws://127.0.0.1:18789'); await fill('setup-token', 'jeton-secret-de-test'); await sleep(80);
  await submitStep(); await onStep('gateway'); await setupPress('Tester');
  await waitFor(`document.querySelector('.ao-setup__status').textContent.includes('injoignable')`);
  await submitStep(); await sleep(200);
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('etape')`), String(STEPS.indexOf('gateway')), 'unreachable gateway blocks next');
  assert.match(await evaluate(`document.getElementById('setup-erreur').textContent`), /doit répondre/);

  await go('/v2/?mock=installation'); await waitFor(`document.getElementById('setup-code')`);
  await ownerFields('MAUVAIS'); await submitStep();
  await waitFor(`document.getElementById('setup-erreur')?.textContent.includes('code d’installation n’est pas valide')`);
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('etape')`), null, 'wrong code cannot create an owner or leave welcome');
  await ownerFields('AO-7Q2K-91MX', 'mot-de-passe-tesT'); await submitStep();
  await waitFor(`document.getElementById('setup-erreur')?.textContent.includes('ne correspondent pas')`);
  await startSetup();
  await fill('setup-url', 'ws://127.0.0.1:18789'); await fill('setup-token', 'jeton-secret-de-test'); await sleep(80);
  await submitStep(); await onStep('gateway'); await setupPress('Tester'); await waitFor(`document.querySelector('.ao-setup__status').textContent.includes('connectée')`);
  await submitStep(); await onStep('agents'); await setupPress('Rechercher'); await waitFor(`document.querySelector('.ao-setup__status').textContent.includes('2 agents')`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.ao-setup__agents [data-project-tag]')].map(c=>c.dataset.projectTag+':'+c.textContent)`), ['absent:Sans étiquette projet','outdated:Étiquette projet à mettre à jour']);
  await toSetupSkills();
  assert.ok(await evaluate(`[...document.querySelectorAll('[data-skill-agent] input')].every(c=>c.checked)`), 'supported agents selected by default');
  assert.ok(await evaluate(`document.getElementById('setup-install').disabled`), 'installation requires explicit confirmation');
  await evaluate(`document.getElementById('setup-skill-confirm').click()`); await sleep(80); await evaluate(`document.getElementById('setup-install').click()`);
  await waitFor(`document.querySelector('[data-skill-agent=atelier-agent] [role=status]').textContent === 'Installée'`);
  await skillsToReview();
  const review=await evaluate(`document.querySelector('.ao-setup__review').textContent`);
  assert.match(review,/Fourni \(non affiché\)/); assert.match(review,/Orion : Installée/);
  const persisted=await evaluate(`location.href+JSON.stringify(localStorage)+JSON.stringify(sessionStorage)`);
  assert.ok(!(review+persisted).includes('jeton-secret-de-test') && !(review+persisted).includes('mot-de-passe-test'), 'token and password never reach review, URL or storage');
  await submitStep(); await onStep('done'); assert.match(await evaluate(`document.querySelector('.ao-setup h2').textContent`), /bureau est prêt/);
  await evaluate(`document.querySelector('.ao-setup .bu-btn--primary').click()`); await waitFor(`document.querySelector('.bu-sidebar')`);
  await evaluate(`sessionStorage.removeItem('ao.mock.configured')`);

  await go('/v2/?mock=installation&setup-lent=50'); await waitFor(`document.getElementById('setup-code')`); await startSetup();
  await evaluate(`(() => {const s=document.getElementById('setup-adapter');s.value='demo';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`!document.getElementById('setup-url') && !document.getElementById('setup-token') && document.getElementById('setup-sans-passerelle')`);
  await submitStep(); await onStep('gateway'); await setupPress('Tester'); await waitFor(`document.querySelector('.ao-setup__status').textContent.includes('aucune connexion nécessaire')`);
  await submitStep(); await onStep('agents'); await setupPress('Rechercher'); await waitFor(`document.querySelector('.ao-setup__status').textContent.includes('2 agents')`);
  for(const hook of ['verrouille','concurrent','lecture']) {
    await go('/v2/?mock=installation&installation='+hook);
    if(hook==='concurrent') { await waitFor(`document.getElementById('setup-code')`); await ownerFields(); await submitStep(); }
    await waitFor(`document.querySelector('.ao-setup__h')?.textContent.includes(${JSON.stringify(hook==='lecture'?'lecture seule':'déjà configuré')})`);
    assert.ok(await evaluate(`!document.getElementById('setup-code') && !document.getElementById('setup-url')`),'locked/read-only state closes form');
  }
  await go('/v2/?mock=installation&setup-lent=50'); await waitFor(`document.getElementById('setup-code')`); await ownerFields('MAUVAIS');
  for(let i=0;i<7;i++) { await setupReady(); await submitStep(); await sleep(600); await waitFor(`document.getElementById('setup-erreur')`); }
  assert.match(await evaluate(`document.getElementById('setup-erreur').textContent`), /Trop de tentatives, réessayez dans 30/);
  await evaluate(`sessionStorage.removeItem('ao.mock.configured')`);
});

// frontend-21 (last on purpose): across every page load of this suite, the client spoke one contract only.
test('frontend-21: the whole suite called one API version only (AO_TEST_API_VERSION, else the default)', { skip }, () => {
  const other = API === '/api/v3' ? '/api/v2/' : '/api/v3/';
  // The G5 walk has its own server pinned to 3 (another origin): its calls are not this client's.
  const leaks = responses.filter((r) => !r.url.startsWith(v3Base)).map((r) => new URL(r.url).pathname).filter((p) => p.includes(other));
  assert.deepEqual([...new Set(leaks)], []);
  assert.ok(responses.some((r) => new URL(r.url).pathname.includes(API + '/')), 'and it did call ' + API);
});

test('frontend-26: comments autocomplete, live replies and system lines, summary request, readable linked history at 360/1440', { skip, timeout: 90_000 }, async () => {
  try {
    for (const width of [360,1440]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===360});
      await go('/v2/projets/prj_portail?mock=1&agent=Atlas');
      await waitFor(`document.querySelector('#project-comment')`);
      assert.ok(await evaluate(`document.scrollingElement.scrollWidth <= innerWidth`),'no sideways scroll at '+width);
      const agent = await evaluate(`document.querySelector('.ao-project button').textContent`);
      assert.ok(agent);
      await fill('project-comment','@sc');
      await waitFor(`document.querySelector('[role=option]')`);
      assert.match(await evaluate(`document.querySelector('[role=option]').textContent`),/Scout/);
      await evaluate(`document.getElementById('project-comment').focus()`);
      await key('ArrowDown'); await key('Enter');
      assert.equal(await evaluate(`document.getElementById('project-comment').value`),'@scout ');
      await fill('project-comment','@scout Peux-tu vérifier le suivi ?');
      await key('Enter',{modifiers:2});
      await waitFor(`document.querySelector('[data-delivery=pending]')`);
      await waitFor(`document.querySelector('.ao-comment--agent .ao-comment__body')`,8000);
      assert.ok(await evaluate(`document.querySelector('[data-delivery=replied]')`));
      assert.ok(await evaluate(`document.querySelector('[data-comment-kind=system]').textContent.includes('→')`),'system line keeps the status change');
      await evaluate(`[...document.querySelectorAll('.bu-summary button')].find(b=>b.textContent.includes('Demander un résumé à Atlas')).click()`);
      await waitFor(`document.querySelector('[data-comment-kind=event]')`);
      await waitFor(`document.querySelectorAll('.ao-comment--agent').length >= 2`,8000);
      assert.ok(await evaluate(`[...document.querySelectorAll('.ao-comment__reply')].every(a=>document.getElementById(a.getAttribute('href').slice(1)))`),'reply links target both comments and summary events');
      await evaluate(`(() => {const event=document.querySelector('[data-comment-kind=event]');document.querySelector('.ao-comment__reply[href="#'+event.id+'"]').click();})()`);
      assert.ok(await evaluate(`(() => {const r=document.querySelector('[data-comment-kind=event]').getBoundingClientRect();return location.pathname.endsWith('/projets/prj_portail') && r.top>=0 && r.bottom<innerHeight;})()`),'reply link scrolls to its parent without route navigation');
      assert.match(await evaluate(`document.querySelector('.bu-summary__text').textContent`),/plan de suivi/);
      await evaluate(`[...document.querySelectorAll('.ao-comment__actions button')].find(b=>b.textContent==='Modifier').click()`);
      await waitFor(`document.querySelector('label[for=project-comment]').textContent.includes('Modifier')`);
      await fill('project-comment','Commentaire corrigé');
      await evaluate(`document.querySelector('.ao-comments__composer button[type=submit]').click()`);
      await waitFor(`[...document.querySelectorAll('.ao-comment__body')].some(p=>p.textContent==='Commentaire corrigé')`);
      await evaluate(`[...document.querySelectorAll('.ao-comment__body')].find(p=>p.textContent==='Commentaire corrigé').closest('li').querySelectorAll('button')[1].click()`);
      await waitFor(`[...document.querySelectorAll('.ao-comment__body')].some(p=>p.textContent==='Message supprimé')`);
      assert.doesNotMatch(await evaluate(`document.querySelector('.ao-section--history').textContent`),/historyKind|\{messages\}|agent:main:/);
      const row = await evaluate(`(() => { const a=document.querySelector('.ao-history-session[href]'); return {href:a.getAttribute('href'), text:a.textContent}; })()`);
      assert.match(row.href,/\/journaux\/agent%3Amain%3Adiscord/);
      assert.match(row.text,/14 messages/);
      await evaluate(`document.querySelector('.ao-history-session[href]').focus()`); await key('Enter');
      await waitFor(`location.pathname.includes('/journaux/agent%3Amain') && document.querySelector('.bu-trace')`);
    }
    await go('/v2/projets/prj_portail?mock=1&lecture=tout');
    await waitFor(`document.getElementById('project-comment')`);
    assert.equal(await evaluate(`document.getElementById('project-comment').disabled`),true);
    assert.match(await evaluate(`document.getElementById('project-comment-help').textContent`),/lecture seule/);
    await go('/v2/projets/prj_portail?mock=1&lecture=1');
    await waitFor(`document.getElementById('project-comment')`);
    assert.equal(await evaluate(`document.getElementById('project-comment').disabled`),false);
    await fill('project-comment','@main Lecture seule du moteur');
    await evaluate(`document.querySelector('.ao-comments__composer button[type=submit]').click()`);
    await waitFor(`document.querySelector('[data-delivery=unavailable]')`);
    await go('/v2/projets/prj_portail?mock=1&echec-commentaire=1');
    await waitFor(`document.getElementById('project-comment')`);
    await fill('project-comment','@main Vérifie');
    await evaluate(`document.querySelector('.ao-comments__composer button[type=submit]').click()`);
    await waitFor(`document.querySelector('[data-delivery=failed]')`,8000);
    if (AXE) {
      await fill('project-comment','@sc');
      await waitFor(`document.querySelector('[role=option]')`);
      await evaluate(AXE);
      const issues=await evaluate(`axe.run(document.querySelector('.ao-project'),{rules:{'target-size':{enabled:false}}}).then(r=>r.violations.filter(v=>v.impact==='serious'||v.impact==='critical').map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})))`);
      assert.deepEqual(issues,[],'discussion and open mention picker are accessible');
    }
    await evaluate(`localStorage.setItem('ao.locale','en')`);
    await go('/v2/projets/prj_portail?mock=1&agent=Atlas');
    await waitFor(`document.querySelector('#commentaires')?.textContent==='Comments'`);
    assert.match(await evaluate(`document.querySelector('.ao-history-session').textContent`),/14 messages/);
    assert.ok(await evaluate(`[...document.querySelectorAll('.bu-summary button')].some(b=>b.textContent==='Ask Atlas for a summary')`));
    assert.deepEqual(consoleErrors,[],'no runtime exceptions');
    assert.deepEqual(vmIssues,[],'GET and SSE match the VM schemas');
  } finally {
    await evaluate(`localStorage.setItem('ao.locale','fr')`);
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  }
});

test('frontend-27: mobile Projects renders the v3 server board, controls and detail at 360/412', {skip,timeout:60_000},async()=>{
  const errorsFrom=consoleErrors.length;
  const checkAxe=async()=>{if(!AXE)return;await evaluate(AXE);const issues=await evaluate(`axe.run(document,{rules:{'target-size':{enabled:false}}}).then(r=>r.violations.filter(v=>v.impact==='serious'||v.impact==='critical').map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})))`);assert.deepEqual(issues,[]);};
  try {
    await evaluate(`localStorage.setItem('ao.locale','fr');localStorage.setItem('ao.uiTheme','dark')`);
    for(const [width,height] of [[360,780],[412,915]]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
      await go('/v2/projets?mock=1');
      await waitFor(`document.querySelector('.ao-projects-server__card[data-card=prj_portail]') && document.getElementById('project-stage')`);
      assert.ok(await evaluate(`document.scrollingElement.scrollWidth<=innerWidth`));
      assert.ok(await evaluate(`(() => {const board=document.querySelector('.ao-projects-server__board'),body=document.querySelector('.ao-projects-server > .ao-frame__body');return board.hasAttribute('data-scroll-body')&&getComputedStyle(board).overflowY==='auto'&&body.scrollWidth<=body.clientWidth+1;})()`),'the board is the contained mobile scroll region');
      assert.equal(await evaluate(`document.querySelector('[data-project-source=all]').getAttribute('aria-pressed')`),'true','the backend-selected all-source filter is rendered');
      await evaluate(`(() => {const s=document.getElementById('project-stage');s.value='in-progress';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitFor(`new URLSearchParams(location.search).get('etape')==='in-progress'&&document.querySelector('[data-card=prj_portail]')&&!document.querySelector('.ao-projects-server[aria-busy=true]')`);
      assert.ok(await evaluate(`[...document.querySelectorAll('.ao-projects-server__card')].every(card=>card.closest('[data-column]').dataset.column==='in-progress')`),'stage membership is returned by the server');
      await checkAxe();
      await evaluate(`document.querySelector('[data-card=prj_portail] .ao-projects-server__link').click()`);
      await waitFor(`document.querySelector('.ao-project-status')`);
      assert.ok(await evaluate(`document.scrollingElement.scrollWidth<=innerWidth`),'detail has no horizontal overflow');
      assert.ok(await evaluate(`document.querySelector('.bu-project-header')&&document.querySelector('#commentaires')`),'compact detail retains its header and discussion');
      await checkAxe();
      assert.deepEqual(JSON.parse(await evaluate(`sessionStorage.getItem('ao.csp') || '[]'`)),[],'mobile views obey CSP');
    }
    await go('/v2/projets?mock=1&lecture=tout');await waitFor(`document.querySelector('.ao-projects-server__card[data-card]')`);
    assert.equal(await evaluate(`document.querySelectorAll('.ao-projects-server__card .ao-projects-move').length`),0,'read-only hides project writes');
    assert.deepEqual(consoleErrors.slice(errorsFrom),[]);
    const build=await evaluate(`document.querySelector('meta[name=ao-build]').content`);
    assert.ok(requests.filter(r=>new URL(r.url).pathname.endsWith('.js') || new URL(r.url).pathname.endsWith('.mjs')).every(r=>new URL(r.url).searchParams.get('v')===build),'every executed module uses the release URL');
  } finally {await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await evaluate(`localStorage.removeItem('ao.projects.view')`);}
});

test('frontend-28: full-row conversation links, lazy previews, people, trace ordering and persisted per-view orders at 360/1440', {skip,timeout:120_000}, async()=>{
  const errorsFrom=consoleErrors.length, issuesFrom=vmIssues.length;
  const capture=async(name)=>{
    if(!process.env.AO_FRONTEND28_CAPTURES)return;
    mkdirSync(process.env.AO_FRONTEND28_CAPTURES,{recursive:true});
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    writeFileSync(join(process.env.AO_FRONTEND28_CAPTURES,name+'.png'),Buffer.from(shot.data,'base64'));
    if(name.startsWith('project-')) {
      await evaluate(`(()=>{const row=document.querySelector('.ao-history-conversation');window.scrollTo(0,scrollY+row.getBoundingClientRect().top-80)})()`);
      const clip=await evaluate(`({x:0,y:scrollY,width:innerWidth,height:innerHeight,scale:1})`);
      const viewport=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip});
      writeFileSync(join(process.env.AO_FRONTEND28_CAPTURES,name+'-viewport.png'),Buffer.from(viewport.data,'base64'));
    }
  };
  const toggle=async(view)=>evaluate(`document.querySelector('[data-order-view=${view}]').click()`);
  const historyOrder=()=>evaluate(`[...document.querySelectorAll('.bu-history > li')].map(n=>n.textContent)`);
  const traceOrder=()=>evaluate(`[...document.querySelectorAll('.bu-trace > li')].map(n=>n.textContent)`);
  try {
    await go('/projets/prj_portail?mock=1&agent=Atlas',rootBase);
    await evaluate(`localStorage.setItem('ao.locale','fr'); for(const v of ['trace','history','comments'])localStorage.removeItem('ao.order.'+v);sessionStorage.setItem('ao.csp','[]')`);
    for(const width of [360,1440]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===360});
      for(const theme of ['dark','light']) {
        await evaluate(`localStorage.setItem('ao.uiTheme',${JSON.stringify(theme)});for(const v of ['trace','history','comments'])localStorage.removeItem('ao.order.'+v)`);
        await go('/projets/prj_portail?mock=1&agent=Atlas',rootBase);
        await waitFor(`document.querySelector('.ao-history-session__cta') && document.getElementById('project-comment')`);
        assert.equal(await evaluate(`document.querySelector('[data-order-view=history]').dataset.order`),'desc');
        assert.equal(await evaluate(`document.querySelector('[data-order-view=comments]').dataset.order`),'asc');
        assert.ok(await evaluate(`document.querySelector('.ao-history-session__cta').textContent.includes('Voir la conversation')`));
        assert.match(await evaluate(`document.querySelector('.ao-history-session__people').textContent`),/Guest Tremblay.*Discord/);
        assert.match(await evaluate(`document.querySelector('.ao-section--people').textContent`),/Guest Tremblay/);
        assert.ok(await evaluate(`document.querySelector('.ao-section--comments .ao-section__head').textContent.includes('Voir la session du projet')`));
        const first=await historyOrder(); await toggle('history');
        assert.deepEqual(await historyOrder(),[...first].reverse());
        await evaluate(`document.querySelector('.ao-history-disclosure').focus()`);await key('Enter');
        await waitFor(`document.querySelector('.ao-conversation-bubble')`);
        assert.equal(await evaluate(`document.querySelector('.ao-history-disclosure').getAttribute('aria-expanded')`),'true');
        assert.equal(await evaluate(`document.querySelectorAll('.ao-conversation-bubble').length`),4);
        assert.ok(await evaluate(`!!document.querySelector('.ao-conversation-bubble--user') && !!document.querySelector('.ao-conversation-bubble--assistant')`));
        assert.match(await evaluate(`document.querySelector('.ao-conversation-summary').textContent`),/Demande.*Actions de l’agent.*Résultat/);
        assert.ok(await evaluate(`document.scrollingElement.scrollWidth<=innerWidth`),'expanded preview fits '+width);
        await capture(`project-${width}-${theme}-preview`);
        if(AXE) {
          await evaluate(AXE);
          assert.deepEqual(await evaluate(`axe.run(document.querySelector('.ao-section--history'),{rules:{'target-size':{enabled:false}}}).then(r=>r.violations.filter(v=>v.impact==='serious'||v.impact==='critical').map(v=>v.id))`),[]);
        }
        await evaluate(`document.querySelector('.ao-history-session').focus()`);await key('Enter');
        await waitFor(`location.pathname.includes('/journaux/agent%3Amain%3Adiscord') && document.querySelector('.bu-trace')`);
        assert.equal(await evaluate(`document.querySelector('[data-order-view=trace]').dataset.order`),'desc');
        const nodes=await traceOrder();await toggle('trace');assert.deepEqual(await traceOrder(),[...nodes].reverse());
        assert.ok(await evaluate(`document.querySelector('.bu-trace__node--human .bu-trace__body').textContent.length>0`));
        assert.ok(await evaluate(`[...document.querySelectorAll('.bu-tool')].every(d=>!d.open)`));
        await evaluate(`document.querySelector('.ao-session__bar [role=radio][aria-checked=false]').click()`);
        await waitFor(`document.querySelector('.bu-waterfall__label')`);
        const rows=await evaluate(`[...document.querySelectorAll('.bu-waterfall__label')].map(n=>n.textContent)`);
        await toggle('trace');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('.bu-waterfall__label')].map(n=>n.textContent)`),[...rows].reverse());
        assert.ok(await evaluate(`document.scrollingElement.scrollWidth<=innerWidth`),'timeline fits '+width);
        await capture(`session-${width}-${theme}-timeline`);
        await go('/projets/prj_veille?mock=1&agent=Atlas',rootBase);
        await waitFor(`document.querySelector('.ao-history-session')`);
        await evaluate(`document.querySelector('.ao-history-session').click()`);
        await waitFor(`location.pathname.includes('/journaux/agent%3Amain%3Asubagent') && document.querySelector('.bu-trace')`);
        assert.equal(await evaluate(`document.querySelector('[data-order-view=trace]').dataset.order`),'desc');
        assert.ok(await evaluate(`!!document.querySelector('.bu-trace__node--human') && document.querySelectorAll('.bu-trace__body').length>=2`));
        assert.ok(await evaluate(`[...document.querySelectorAll('.bu-tool')].every(d=>!d.open)`));
        assert.ok(await evaluate(`document.scrollingElement.scrollWidth<=innerWidth`),'sub-agent fits '+width);
        await capture(`session-${width}-${theme}-subagent`);
      }
    }
    // Comment pagination always loads older items at the opposite end from new updates.
    await go('/projets/prj_portail?mock=1&agent=Atlas&commentaires-pages=1&historique-pages=1',rootBase);
    await waitFor(`document.querySelector('.ao-section--comments > .ao-more')`);
    assert.equal(await evaluate(`document.querySelector('[data-order-view=history]').dataset.order`),'asc','history choice survives route changes');
    assert.ok(await evaluate(`document.querySelector('.ao-section--history > .ao-more').nextElementSibling.matches('.bu-history')`),'older history loads above an oldest-first timeline');
    const historyCount=await evaluate(`document.querySelectorAll('.bu-history > li').length`);
    await evaluate(`document.querySelector('.ao-section--history > .ao-more').click()`);
    await waitFor(`document.querySelectorAll('.bu-history > li').length>${historyCount}`);
    await toggle('history');
    assert.ok(await evaluate(`document.querySelector('.ao-section--history > .ao-more').previousElementSibling.matches('.bu-history')`),'older history loads below a newest-first timeline');
    await toggle('comments');
    assert.equal(await evaluate(`document.querySelector('.ao-section--comments > .ao-more').previousElementSibling.matches('.ao-comments')`),true,'older pages are below a newest-first thread');
    const last=await evaluate(`document.querySelector('.ao-comments > li:last-child').dataset.comment`);
    await evaluate(`document.querySelector('.ao-section--comments > .ao-more').click()`);
    await waitFor(`document.querySelectorAll('.ao-comments > li').length>50`);
    assert.notEqual(await evaluate(`document.querySelector('.ao-comments > li:last-child').dataset.comment`),last,'older records append at the bottom');
    await fill('project-comment','Nouveau suivi en direct');
    await evaluate(`document.querySelector('.ao-comments__composer button[type=submit]').click()`);
    await waitFor(`document.querySelector('.ao-comments > li:first-child').textContent.includes('Nouveau suivi en direct')`);
    await toggle('comments');
    await fill('project-comment','Nouveau suivi en ordre de discussion');
    await evaluate(`document.querySelector('.ao-comments__composer button[type=submit]').click()`);
    await waitFor(`document.querySelector('.ao-comments > li:last-child').textContent.includes('Nouveau suivi en ordre de discussion')`);
    await toggle('comments');
    const beforeMove=await evaluate(`document.querySelector('.bu-history > li:first-child').textContent`);
    await evaluate(`(()=>{const s=document.getElementById('move-to');s.value='in-review';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('.bu-history > li:first-child').textContent!==${JSON.stringify(beforeMove)} && document.querySelector('.bu-history > li:first-child').textContent.includes('→')`);
    await toggle('history');
    const firstAt=await evaluate(`document.querySelector('.bu-history > li:first-child time').dateTime`);
    await evaluate(`(()=>{const s=document.getElementById('move-to');s.value='shipped';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('.bu-history > li:last-child').textContent.includes('Livré')`);
    assert.equal(await evaluate(`document.querySelector('.bu-history > li:first-child time').dateTime`),firstAt,'oldest-first history receives live changes at the bottom');
    await go('/projets/prj_portail?mock=1&agent=Atlas',rootBase);
    await waitFor(`document.querySelector('[data-order-view=comments]')`);
    assert.equal(await evaluate(`document.querySelector('[data-order-view=comments]').dataset.order`),'desc');
    await go('/journaux/agent%3Amain%3Amain?mock=1&agent=Atlas',rootBase);
    await waitFor(`document.querySelector('.bu-trace')`);
    const newest=await evaluate(`document.querySelector('.bu-trace > li:first-child').textContent`);
    await waitFor(`document.querySelector('.bu-trace > li:first-child').textContent!==${JSON.stringify(newest)}`,12000);
    await toggle('trace');
    const oldest=await evaluate(`document.querySelector('.bu-trace > li:first-child').textContent`);
    await sleep(3500);
    assert.equal(await evaluate(`document.querySelector('.bu-trace > li:first-child').textContent`),oldest,'oldest-first live updates keep the beginning stable');
    assert.deepEqual(await evaluate(`JSON.parse(sessionStorage.getItem('ao.csp')||'[]')`),[]);
    assert.deepEqual(consoleErrors.slice(errorsFrom),[]);
    assert.deepEqual(vmIssues.slice(issuesFrom),[]);
  } finally {
    await evaluate(`for(const v of ['trace','history','comments'])localStorage.removeItem('ao.order.'+v);localStorage.setItem('ao.uiTheme','dark')`);
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  }
});


test('frontend-28 deployment: old tabs reload before loading new chunks; comment avatars and system lines align at 1440/360', {skip,timeout:90000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ao-frontend28-deploy-'));
  const copy=join(dir,'ui'); cpSync(UI_ROOT,copy,{recursive:true});
  const errorsFrom=consoleErrors.length,issuesFrom=vmIssues.length;
  let deployedServer;
  const capture=async(name)=>{
    if(!process.env.AO_FRONTEND28_CAPTURES)return;
    mkdirSync(process.env.AO_FRONTEND28_CAPTURES,{recursive:true});
    const clip=await evaluate(`({x:0,y:scrollY,width:innerWidth,height:innerHeight,scale:1})`);
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip});
    writeFileSync(join(process.env.AO_FRONTEND28_CAPTURES,name+'.png'),Buffer.from(shot.data,'base64'));
  };
  try {
    for(const [width,prefix,detect] of [[1440,'/',true],[360,'/v2/',false]]) {
      deployedServer=serveFrontend.createFrontendServer({root:copy,basePath:prefix});
      await new Promise(r=>deployedServer.listen(0,'127.0.0.1',r));
      const origin=`http://127.0.0.1:${deployedServer.address().port}`;
      await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===360});
      await go(prefix+'sante?mock=1&agent=Atlas',origin);
      await waitFor(`document.querySelector('.ao-health__cards') && document.querySelector('#sante-canaux')`);
      await evaluate(`window.__AO_OLD_DOCUMENT=true;localStorage.setItem('ao.locale','fr');sessionStorage.setItem('ao.csp','[]')`);
      const oldBuild=await evaluate(`document.querySelector('meta[name=ao-build]').content`);
      const title='Commentaires après déploiement '+width;
      const messages=join(copy,'messages.js');
      writeFileSync(messages,readFileSync(messages,'utf8').replace(/"project.comments.title": "Commentaires[^"\n]*"/, '"project.comments.title": '+JSON.stringify(title)).replace('  fr: {','  fr: {\n    "deploy.test.'+width+'": "Version cohérente",').replace('  en: {','  en: {\n    "deploy.test.'+width+'": "Consistent version",'));
      writeFileSync(join(copy,'pages/project.js'),readFileSync(join(copy,'pages/project.js'),'utf8')+`\nwindow.__AO_PROJECT_BUILD=${width};window.__AO_NEW_MESSAGE=msg('deploy.test.${width}');\n`);
      firstLoad.writePreloads(copy);
      const newBuild=firstLoad.buildId(copy);assert.notEqual(newBuild,oldBuild);
      const from=responses.length;
      if(detect) {
        await evaluate(`window.dispatchEvent(new Event('focus'))`);
        await waitFor(`document.querySelector('.bu-toast')?.textContent.includes('Nouvelle version disponible')`);
        assert.equal(await evaluate('window.__AO_OLD_DOCUMENT'),true,'toast leaves the current document intact');
        assert.equal(await evaluate(`document.querySelector('.bu-toast button').textContent`),'Recharger');
        await capture('deployment-'+width+'-toast');
      }
      await evaluate(`(()=>{const a=document.createElement('a');a.href=${JSON.stringify(prefix+'projets/prj_portail?mock=1&agent=Atlas')};document.body.append(a);a.click();})()`);
      await waitFor(`document.querySelector('.ao-comments > li .bu-avatar') && document.querySelector('meta[name=ao-build]').content===${JSON.stringify(newBuild)}`,15000);
      assert.equal(await evaluate('window.__AO_OLD_DOCUMENT'),undefined,'route navigation replaced the complete document');
      assert.equal(await evaluate('window.__AO_PROJECT_BUILD'),width,'new page executed in the new document');
      assert.equal(await evaluate('window.__AO_NEW_MESSAGE'),'Version cohérente','a newly introduced key resolves from the matching translation module');
      assert.ok(await evaluate(`document.querySelector('.ao-section--comments h3').textContent.includes(${JSON.stringify(title)})`),'new translations and page match');
      const chunks=responses.slice(from).filter(r=>/\.(js|css)\?v=/.test(r.url));
      assert.ok(chunks.some(r=>r.url.includes('/pages/project.js?v='+newBuild)));
      assert.deepEqual(chunks.filter(r=>!r.url.endsWith('?v='+newBuild)),[],'no obsolete/new route graph mixed across the reload');
      for(const theme of ['dark','light']) {
        await evaluate(`import(${JSON.stringify(origin+prefix+'theme.js?v='+newBuild)}).then(m=>m.setTheme(${JSON.stringify(theme)}))`);
        const geometry=await evaluate(`(()=>{const cards=[...document.querySelectorAll('.ao-comment')];return cards.map(c=>{const a=c.querySelector('.bu-avatar,.bu-icon'),content=c.querySelector('.ao-comment__content'),author=c.querySelector('.ao-comment__head'),r=c.getBoundingClientRect(),ar=a.getBoundingClientRect(),cr=content.getBoundingClientRect();return {marker:getComputedStyle(c).listStyleType,inside:ar.left>r.left&&ar.right<r.right&&ar.top>r.top&&ar.bottom<r.bottom,contentX:cr.left,cardX:r.left,aligned:!author||Math.abs(author.getBoundingClientRect().top-ar.top)<3,system:c.classList.contains('ao-comment--system')}})})()`);
        assert.ok(geometry.some(g=>g.system),'fixture includes system lines');
        assert.ok(geometry.every(g=>g.marker==='none'&&g.inside&&g.aligned),'avatar/icon inside each card and aligned with author');
        assert.equal(new Set(geometry.map(g=>g.contentX)).size,1,'system and person/agent content use the same column');
        assert.equal(new Set(geometry.map(g=>g.cardX)).size,1,'reply groups retain the same left edge');
        assert.ok(await evaluate(`document.scrollingElement.scrollWidth<=innerWidth`));
        assert.equal(await evaluate(`document.querySelector('.ao-comments').getAttribute('role')`),'list');
        assert.ok(await evaluate(`[...document.querySelectorAll('link[rel=stylesheet]')].every(l=>new URL(l.href).searchParams.get('v')===${JSON.stringify(newBuild)})`));
        await evaluate(`(()=>{const c=document.querySelector('.ao-section--comments');window.scrollTo(0,scrollY+c.getBoundingClientRect().top-80)})()`);
        await capture('comments-'+width+'-'+theme+'-cards');
      }
      // Route-owned stylesheets also use the build, beyond the three startup links.
      await evaluate(`import(${JSON.stringify(origin+prefix+'router.js?v='+newBuild)}).then(()=>document.querySelector('a[href*="/boutique"]').click())`);
      await waitFor(`document.querySelector('link[data-office]')`);
      assert.ok(await evaluate(`[...document.querySelectorAll('link[rel=stylesheet]')].every(l=>new URL(l.href).searchParams.get('v')===${JSON.stringify(newBuild)})`));
      assert.deepEqual(await evaluate(`JSON.parse(sessionStorage.getItem('ao.csp')||'[]')`),[]);
      await go('/sante?mock=1',rootBase);
      await new Promise(r=>deployedServer.close(r));deployedServer=null;
    }
    assert.deepEqual(consoleErrors.slice(errorsFrom),[]);assert.deepEqual(vmIssues.slice(issuesFrom),[]);
  } finally {
    if(deployedServer)await new Promise(r=>deployedServer.close(r));
    rmSync(dir,{recursive:true,force:true});
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  }
});


test('frontend-29: owned retries, working indicator, inline nested mentions and actual history order at 1440/360', {skip,timeout:60000}, async()=>{
  const errorsFrom=consoleErrors.length,issuesFrom=vmIssues.length;
  const historyDates=()=>evaluate(`[...document.querySelectorAll('.bu-history > li')].map(li=>Number(li.dataset.historyAt))`);
  try {
    for(const width of [1440,360]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===360});
      await go('/projets/prj_portail?mock=1&agent=Atlas&livraison='+ (width===1440 ? 'failed':'no-reply'),rootBase);
      await evaluate(`localStorage.removeItem('ao.order.history')`);
      await go('/projets/prj_portail?mock=1&agent=Atlas&livraison='+ (width===1440 ? 'failed':'no-reply'),rootBase);
      await waitFor(`document.querySelectorAll('[data-retry]').length===2`);
      assert.equal(await evaluate(`document.querySelector('[data-order-view=history]').textContent.trim()`),'Plus récent en haut');
      const desc=await historyDates();assert.deepEqual(desc,[...desc].sort((a,b)=>b-a));
      await evaluate(`document.querySelector('[data-order-view=history]').click()`);
      assert.equal(await evaluate(`document.querySelector('[data-order-view=history]').textContent.trim()`),'Plus ancien en haut');
      const asc=await historyDates();assert.deepEqual(asc,[...asc].sort((a,b)=>a-b));
      // Both a person's comment and their summary request can be retried in place.
      for(const kind of ['comment','event']) {
        const selector=`[data-comment-kind=${kind}] [data-retry]`;
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
        await waitFor(`document.querySelector('[data-comment-kind=${kind}] [data-delivery=working]')`);
        assert.match(await evaluate(`document.querySelector('[data-comment-kind=${kind}] [data-delivery=working]').textContent`),/Atlas y travaille…/);
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ao-comment__working')).animationName`),'ao-working');
        await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ao-comment__working')).animationName`),'none');
        await send('Emulation.setEmulatedMedia',{features:[]});
        await waitFor(`document.querySelector('[data-comment-kind=${kind}] [data-delivery=replied]')`);
      }
      const root=await evaluate(`document.querySelector('[data-comment-kind=comment][data-comment]').dataset.comment`);
      await evaluate(`document.getElementById('comment-'+${JSON.stringify(root)}).querySelector('[data-reply]').click()`);
      await waitFor(`document.querySelector('form[data-reply-to]')`);
      assert.equal(await evaluate(`document.querySelector('form[data-reply-to]').closest('[data-comment]').dataset.comment`),root);
      await waitFor(`document.activeElement.id==='project-comment'`);
      await fill('project-comment','@at');
      await waitFor(`document.querySelector('[role=option]')`);
      await key('Enter');
      assert.match(await evaluate(`document.getElementById('project-comment').value`),/^@main /);
      await fill('project-comment','@main Réponse imbriquée '+width);
      await evaluate(`document.querySelector('form[data-reply-to] button[type=submit]').click()`);
      await waitFor(`[...document.querySelectorAll('.ao-comment__body')].some(p=>p.textContent==='@main Réponse imbriquée '+${width})`);
      const child=await evaluate(`[...document.querySelectorAll('.ao-comment__body')].find(p=>p.textContent==='@main Réponse imbriquée '+${width}).closest('[data-comment]').dataset.comment`);
      assert.equal(await evaluate(`document.getElementById('comment-'+${JSON.stringify(child)}).dataset.replyTo`),root);
      await waitFor(`document.getElementById('comment-'+${JSON.stringify(child)}).nextElementSibling?.dataset.replyTo===${JSON.stringify(child)}`);
      assert.ok(await evaluate(`document.getElementById('comment-'+${JSON.stringify(child)}).nextElementSibling.classList.contains('ao-comment--agent')`));
      assert.ok(await evaluate(`!document.querySelector('form[data-reply-to]')`));
      assert.ok(await evaluate(`document.scrollingElement.scrollWidth<=innerWidth`));
    }
    await go('/projets/prj_portail?mock=1&livraison=failed&lecture=1',rootBase);
    await waitFor(`document.querySelector('[data-delivery=failed]')`);
    assert.equal(await evaluate(`document.querySelectorAll('[data-retry]').length`),0);
    assert.deepEqual(consoleErrors.slice(errorsFrom),[]);assert.deepEqual(vmIssues.slice(issuesFrom),[]);
  } finally {
    await evaluate(`localStorage.removeItem('ao.order.history')`);
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  }
});

test('Discuter: lifecycle menu, inline rename, swipe delete and undo captures', { skip, timeout: 60_000 }, async () => {
  const diagnosticStart = { requests: requests.length, failures: requestFailures.length, responses: badResponses.length, pageErrors: pageErrors.length, consoleErrors: consoleApiErrors.length };
  const captureDir = join(UI_ROOT, '../../design/reports/t0189-captures');
  mkdirSync(captureDir, { recursive: true });
  const capture = async name => {
    await sleep(180);
    const issue = await evaluate(`(() => {const text=[document.body.innerText,...[...document.querySelectorAll('[aria-label]')].map(el=>el.getAttribute('aria-label'))].join(' ');const workspace=document.querySelector('.ao-messenger__workspace')?.getBoundingClientRect(),slot=document.querySelector('.ao-messenger__conversation-slot')?.getBoundingClientRect(),pane=document.querySelector('.ao-messenger__conversation-slot > .ao-messenger__pane')?.getBoundingClientRect();return {rawLabel:/Autre\\s*\\(/.test(text),error:/NOT_FOUND|Discussion introuvable/i.test(text)||!!document.querySelector('.bu-empty--error'),right:workspace?.right??null,paneRight:pane?.right??null,slotRight:slot?.right??null,width:innerWidth}})()`);
    assert.equal(issue.rawLabel, false, `untranslated chat label in ${name}`);
    assert.equal(issue.error, false, `chat error state in ${name}`);
    if (name.startsWith('desktop-')) assert.ok(issue.right >= issue.width - 2, `chat workspace leaves an empty right strip in ${name}: ${JSON.stringify(issue)}`);
    if (name.startsWith('desktop-')) assert.ok(issue.paneRight >= issue.slotRight - 2, `conversation pane does not fill its slot in ${name}: ${JSON.stringify(issue)}`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(captureDir, name), Buffer.from(shot.data, 'base64'));
  };
  const diagnostics = () => ({requestFailed:requestFailures.slice(diagnosticStart.failures),httpErrors:badResponses.slice(diagnosticStart.responses),pageErrors:pageErrors.slice(diagnosticStart.pageErrors),consoleErrors:consoleApiErrors.slice(diagnosticStart.consoleErrors)});
  await send('Emulation.setEmulatedMedia',{features:[{name:'hover',value:'hover'},{name:'pointer',value:'fine'}]});
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await go('/v3/discuter?mock=capture-t0189', v3Base);
  try {
    await openChat();
    // Headless Chrome reports hover:none even after CDP media emulation. Mirror the fine-pointer CSS branch for captures.
    await evaluate(`(()=>{if(matchMedia('(hover:hover) and (pointer:fine)').matches)return;const sheet=[...document.styleSheets].find(item=>item.href?.includes('chat.css'));if(!sheet)throw Error('chat stylesheet unavailable for fine-pointer capture');window.__t0189PointerRules=[sheet,sheet.cssRules.length];sheet.insertRule('.ao-messenger__row-menu .bu-control-menu__trigger{opacity:0!important}',sheet.cssRules.length);sheet.insertRule('.ao-messenger__session-line:hover .ao-messenger__row-menu .bu-control-menu__trigger,.ao-messenger__session-line:focus-within .ao-messenger__row-menu .bu-control-menu__trigger{opacity:1!important}',sheet.cssRules.length);})()`);
    await waitFor(`document.querySelector('[data-chat-thread]') && !document.body.innerText.includes('NOT_FOUND')`);
    const sessionId = await evaluate(`document.querySelector('[data-chat-session]')?.getAttribute('data-chat-session')`);
    assert.ok(sessionId);
    await capture('desktop-active-1440.png');
    const desktopVisibility=await evaluate(`({hover:matchMedia('(hover:hover) and (pointer:fine)').matches,current:getComputedStyle(document.querySelector('[data-chat-session="${sessionId}"]').closest('li').querySelector('.bu-control-menu__trigger')).opacity,other:getComputedStyle(document.querySelector('[data-chat-list="sessions"] li:last-child .bu-control-menu__trigger')).opacity})`);
    assert.equal(desktopVisibility.current,'0','desktop action button stays hidden until hover or keyboard focus');
    assert.equal(desktopVisibility.other,'0');
    const rowGeometry=await evaluate(`(()=>{const row=document.querySelector('[data-chat-session="${sessionId}"]'),li=row.closest('li'),button=li.querySelector('.bu-control-menu__trigger'),r=row.getBoundingClientRect(),l=li.getBoundingClientRect(),b=button.getBoundingClientRect();return {row:r.width,item:l.width,buttonInside:b.left>=r.left&&b.right<=r.right,edgeGap:r.right-b.right}})()`);
    assert.ok(rowGeometry.row>=rowGeometry.item-2&&rowGeometry.row<=rowGeometry.item+2&&rowGeometry.buttonInside&&rowGeometry.edgeGap>=0&&rowGeometry.edgeGap<=24,`desktop action button overlays inside a full-width session row: ${JSON.stringify(rowGeometry)}`);

    const firstTrigger = `document.querySelector('[data-chat-session="${sessionId}"]').closest('li').querySelector('.bu-control-menu__trigger')`;
    const hoverPoint=await evaluate(`(()=>{const r=document.querySelector('[data-chat-session="${sessionId}"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:hoverPoint.x,y:hoverPoint.y});
    await waitFor(`getComputedStyle(${firstTrigger}).opacity==='1'`);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2});
    await waitFor(`getComputedStyle(${firstTrigger}).opacity==='0'`);
    await evaluate(`${firstTrigger}.focus()`);
    await waitFor(`getComputedStyle(${firstTrigger}).opacity==='1'`);
    await evaluate(`${firstTrigger}.click()`);
    await waitFor(`document.querySelector('[role=menu]')`);
    await waitFor(`(() => {const m=document.querySelector('[role=menu]'),b=${firstTrigger}.getBoundingClientRect();return m&&m.getBoundingClientRect().top>=b.bottom})()`);
    const menuAnchor=await evaluate(`(()=>{const m=document.querySelector('[role=menu]').getBoundingClientRect(),b=${firstTrigger}.getBoundingClientRect();return {menuRight:m.right,buttonRight:b.right}})()`);
    assert.ok(Math.abs(menuAnchor.menuRight-menuAnchor.buttonRight)<2,`menu aligns to the trigger's right edge: ${JSON.stringify(menuAnchor)}`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[role=menuitem]')].map(item=>item.textContent.trim())`),['Renommer','Supprimer']);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[role=menuitem]')].map(item=>!!item.querySelector('svg'))`),[true,true]);
    assert.equal(await evaluate(`Math.round(document.querySelector('[role=menu]').getBoundingClientRect().width)`),180);
    await capture('desktop-menu-below-1440.png');
    await key('Escape');
    await waitFor(`!document.querySelector('[role=menu]')`);

    await evaluate(`(() => {const list=document.querySelector('[data-chat-list="sessions"]');list.scrollTop=list.scrollHeight;})()`);
    const lastTrigger = `document.querySelector('[data-chat-list="sessions"] li:last-child .bu-control-menu__trigger')`;
    await evaluate(`${lastTrigger}.focus()`);
    await evaluate(`${lastTrigger}.click()`);
    await waitFor(`document.querySelector('[role=menu]')`);
    await waitFor(`(() => {const m=document.querySelector('[role=menu]'),b=${lastTrigger}.getBoundingClientRect();return m&&m.getBoundingClientRect().bottom<=b.top})()`);
    await capture('desktop-menu-above-1440.png');
    await key('Escape');

    await evaluate(`${firstTrigger}.click()`);
    await waitFor(`document.querySelector('[role=menuitem]')`);
    await evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(item=>item.textContent.includes('Renommer')).click()`);
    await waitFor(`document.querySelector('[data-chat-rename]') && document.activeElement===document.querySelector('[data-chat-rename]')`);
    assert.equal(await evaluate(`(()=>{const i=document.querySelector('[data-chat-rename]');return i.selectionStart===0&&i.selectionEnd===i.value.length})()`),true);
    const renamePresentation=await evaluate(`(()=>{const i=document.querySelector('[data-chat-rename]'),row=i.closest('.ao-messenger__session-line'),title=row.querySelector('.ao-messenger__session-row strong'),a=i.getBoundingClientRect(),b=title.getBoundingClientRect(),style=getComputedStyle(i);return {sameX:Math.abs(a.left-b.left)<2,sameY:Math.abs(a.top-b.top)<3,sameFont:style.font===getComputedStyle(title).font,border:style.borderTopWidth,background:style.backgroundColor,rowWidth:row.getBoundingClientRect().width}})()`);
    assert.ok(renamePresentation.sameX&&renamePresentation.sameY&&renamePresentation.sameFont&&renamePresentation.border==='0px'&&renamePresentation.background==='rgba(0, 0, 0, 0)',`rename is visually in place without a box: ${JSON.stringify(renamePresentation)}`);
    await capture('desktop-inline-rename-1440.png');
    await evaluate(`(() => {const input=document.querySelector('[data-chat-rename]');input.focus();input.select();})()`);
    await send('Input.insertText',{text:'Revue hebdomadaire'});
    await key('Enter');
    await waitFor(`document.querySelector('[data-chat-session="${sessionId}"] strong')?.textContent==='Revue hebdomadaire'`).catch(async error=>{const state=await evaluate(`(()=>({body:document.body.innerText.slice(-500),input:document.querySelector('[data-chat-rename]')?.value,focused:document.activeElement?.getAttribute('data-chat-rename'),row:document.querySelector('[data-chat-session="${sessionId}"]')?.innerText,alerts:[...document.querySelectorAll('[role=alert]')].map(x=>x.innerText)}))()`);console.error('T-0189 rename diagnostic '+JSON.stringify({state,chatRequests:requests.slice(diagnosticStart.requests).filter(x=>x.url.includes('/chat/sessions/')).map(x=>x.url),httpErrors:badResponses.slice(diagnosticStart.responses)}));throw error;});

    const targetId = await evaluate(`new URLSearchParams(location.search).get('cible')`);
    await evaluate(`(()=>{const stored=window.__t0189PointerRules;if(stored){stored[0].deleteRule(stored[1]+1);stored[0].deleteRule(stored[1]);delete window.__t0189PointerRules;}})()`);
    await send('Emulation.setEmulatedMedia',{features:[{name:'hover',value:'none'},{name:'pointer',value:'coarse'}]});
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await go('/v3/discuter?mock=capture-t0189&cible='+encodeURIComponent(targetId)+'&vue=sessions',v3Base);
    await waitFor(`document.querySelector('[data-chat-session]')`);
    const mobileId = await evaluate(`document.querySelector('[data-chat-session]')?.getAttribute('data-chat-session')`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ao-messenger__row-menu')).display`),'none','phones use swipe gestures without a three-dot action button');
    await capture('mobile-session-list-swipe-only-390.png');
    const swipe = async (id,from,to) => evaluate(`(() => {const row=document.querySelector('[data-chat-session="${id}"]').closest('li');const start=new Touch({identifier:1,target:row,clientX:${from},clientY:240});const end=new Touch({identifier:1,target:row,clientX:${to},clientY:240});row.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[start],changedTouches:[start]}));row.dispatchEvent(new TouchEvent('touchend',{bubbles:true,touches:[],changedTouches:[end]}));})()`);
    await swipe(mobileId,280,200);
    await waitFor(`document.querySelector('[data-chat-rename]') && document.activeElement===document.querySelector('[data-chat-rename]')`);
    await capture('mobile-swipe-left-rename-390.png');
    await evaluate(`(() => {const input=document.querySelector('[data-chat-rename]');input.focus();input.select();})()`);
    await send('Input.insertText',{text:'Nom mobile'});
    await key('Enter');
    await waitFor(`document.querySelector('[data-chat-session="${mobileId}"] strong')?.textContent==='Nom mobile'`);

    const deleteId = await evaluate(`document.querySelectorAll('[data-chat-session]')[1]?.getAttribute('data-chat-session')`);
    assert.ok(deleteId);
    await swipe(deleteId,200,280);
    await waitFor(`document.querySelector('[role=dialog]')?.textContent.includes('Supprimer cette discussion')`);
    await waitFor(`document.querySelector('[role=dialog] .bu-modal__desc')?.textContent.trim().length>0`);
    assert.match(await evaluate(`document.querySelector('[role=dialog] .bu-modal__desc')?.textContent||''`),/transcript|conversation/i,'delete dialog shows the backend retention notice');
    const deleteTitleLayout=await evaluate(`(()=>{const title=document.querySelector('[role=dialog] .bu-modal__title'),node=title?.firstChild,range=document.createRange();if(!node)return {text:title?.textContent||'',punctuationRects:0};range.setStart(node,node.length-2);range.setEnd(node,node.length);return {text:title.textContent,punctuationRects:range.getClientRects().length};})()`);
    assert.match(deleteTitleLayout.text,/discussion\u202f\?$/,'French delete title keeps punctuation attached with a narrow no-break space');
    assert.equal(deleteTitleLayout.punctuationRects,1,'delete title keeps the question mark on the same line');
    const deleteDialogGeometry=await evaluate(`(()=>{const r=document.querySelector('[role=dialog]').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,viewport:innerWidth}})()`);
    assert.ok(deleteDialogGeometry.left>0&&deleteDialogGeometry.right<deleteDialogGeometry.viewport&&deleteDialogGeometry.top>0,`phone delete confirmation stays a compact centered dialog: ${JSON.stringify(deleteDialogGeometry)}`);
    await capture('mobile-swipe-right-delete-confirm-390.png');
    await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find(button=>button.textContent.includes('Supprimer la discussion')).click()`);
    await waitFor(`document.querySelector('.bu-toast.ao-chat-undo-toast button.ao-toast-action--text')?.textContent.trim()==='Annuler'`);
    const undoToastLayout=await evaluate(`(()=>{const toast=document.querySelector('.bu-toast.ao-chat-undo-toast'),text=toast?.querySelector('.bu-toast__text'),action=toast?.querySelector('.ao-toast-action--text'),range=document.createRange();if(!toast||!text||!action)return null;range.selectNodeContents(text);const r=toast.getBoundingClientRect(),t=text.getBoundingClientRect(),a=action.getBoundingClientRect();return {message:text.textContent.trim(),action:action.textContent.trim(),messageLines:range.getClientRects().length,toastWidth:r.width,actionWidth:a.width,actionHeight:a.height,viewport:innerWidth}})()`);
    assert.ok(undoToastLayout&&undoToastLayout.message==='Discussion supprimée'&&undoToastLayout.action==='Annuler'&&undoToastLayout.messageLines===1&&undoToastLayout.actionWidth<80&&undoToastLayout.toastWidth<undoToastLayout.viewport,`phone undo toast stays a single line with a compact text action: ${JSON.stringify(undoToastLayout)}`);
    await capture('mobile-delete-undo-toast-390.png');
    await evaluate(`document.querySelector('.bu-toast.ao-chat-undo-toast .ao-toast-action--text').click()`);
    await waitFor(`document.querySelector('[data-chat-session="${deleteId}"]')`);

    await go('/v3/discuter?mock=capture-t0189&cible='+encodeURIComponent(targetId)+'&discussion='+encodeURIComponent(mobileId)+'&vue=conversation',v3Base);
    await waitFor(`document.querySelector('[data-chat-thread]') && document.querySelector('.ao-messenger__workspace[data-chat-screen="conversation"]')`);
    const phoneConversationLayout=await evaluate(`(()=>{const shell=document.querySelector('.bu-shell'),workspace=document.querySelector('.ao-messenger__workspace'),top=document.querySelector('.bu-mtopbar'),nav=document.querySelector('.bu-bottombar'),pane=document.querySelector('.ao-messenger__conversation'),bar=pane?.querySelector('.ao-messenger__pane-head'),thread=pane?.querySelector('[data-chat-thread]'),compose=pane?.querySelector('.ao-messenger__compose'),rect=el=>{const r=el?.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom,height:r.height}:null};return {screen:workspace?.dataset.chatScreen,topDisplay:getComputedStyle(top).display,navDisplay:getComputedStyle(nav).display,pane:rect(pane),bar:rect(bar),thread:rect(thread),compose:rect(compose),height:innerHeight}})()`);
    assert.ok(phoneConversationLayout.screen==='conversation'&&phoneConversationLayout.topDisplay==='none'&&phoneConversationLayout.navDisplay==='none',`phone conversation hides the app header and bottom navigation: ${JSON.stringify(phoneConversationLayout)}`);
    assert.ok(phoneConversationLayout.bar&&phoneConversationLayout.thread&&phoneConversationLayout.compose&&phoneConversationLayout.pane.top===0&&Math.abs(phoneConversationLayout.pane.bottom-phoneConversationLayout.height)<2,`phone conversation uses the full viewport for its bar, messages and composer: ${JSON.stringify(phoneConversationLayout)}`);
    await capture('mobile-conversation-fullscreen-390.png');
    await evaluate(`document.querySelector('.ao-messenger__conversation .ao-messenger__pane-head button').click()`);
    await waitFor(`document.querySelector('.ao-messenger__workspace[data-chat-screen="sessions"]') && document.querySelector('[data-chat-list="sessions"]')`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.bu-mtopbar')).display`),'flex','returning to the list restores the app header');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.bu-bottombar')).display`),'grid','returning to the list restores the bottom navigation');

    await send('Emulation.setDeviceMetricsOverride',{width:820,height:1180,deviceScaleFactor:1,mobile:true});
    await send('Emulation.setEmulatedMedia',{features:[{name:'hover',value:'none'},{name:'pointer',value:'coarse'}]});
    await go('/v3/discuter?mock=capture-t0189&cible='+encodeURIComponent(targetId)+'&vue=sessions',v3Base);
    await waitFor(`document.querySelector('.ao-messenger__row-menu .bu-control-menu__trigger')`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ao-messenger__row-menu .bu-control-menu__trigger')).opacity`),'1');
    await capture('tablet-touch-menu-visible-820.png');
    await send('Emulation.setEmulatedMedia',{features:[{name:'hover',value:'hover'},{name:'pointer',value:'fine'}]});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await go('/v3/discuter?mock=capture-t0189-empty&cible='+encodeURIComponent(targetId)+'&vue=sessions',v3Base);
    await waitFor(`document.querySelector('.ao-messenger__list > .bu-empty .bu-empty__title')?.textContent.includes('Aucune discussion')`);
    await capture('desktop-empty-sessions-1440.png');
    await send('Emulation.setEmulatedMedia',{features:[]});
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  } catch (error) {
    console.error('T-0189 browser diagnostics '+JSON.stringify(diagnostics()));
    throw error;
  }
});

test('T-0207 iPad: safe-area shell and Discuter conversation fill the viewport', { skip, timeout: 60_000 }, async () => {
  const captureDir = join(UI_ROOT, '../../design/reports/t0207-ipad');
  mkdirSync(captureDir, { recursive: true });
  const targetUrl = async () => {
    await go('/v3/discuter?mock=capture-t0189', v3Base);
    await openChat();
    const query = await evaluate(`location.search`);
    return '/v3/discuter' + query;
  };
  const inspect = async name => {
    const layout = await evaluate(`(()=>{const shell=document.querySelector('.bu-shell'),main=document.querySelector('.bu-shell__main'),sidebar=document.querySelector('.bu-sidebar'),header=document.querySelector('.bu-topbar'),workspace=document.querySelector('.ao-messenger__workspace'),conversation=document.querySelector('.ao-messenger__conversation'),rect=el=>{const r=el?.getBoundingClientRect();return r?{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}:null};return {viewport:{width:document.documentElement.clientWidth,height:innerHeight},shell:rect(shell),main:rect(main),sidebar:rect(sidebar),sidebarPaddingTop:getComputedStyle(sidebar).paddingTop,sidebarBasePaddingTop:getComputedStyle(document.documentElement).getPropertyValue('--bu-space-4').trim(),header:rect(header),workspace:rect(workspace),conversation:rect(conversation),shellTop:getComputedStyle(shell).top,screen:workspace?.dataset.chatScreen}})()`);
    assert.ok(layout.conversation, `conversation is open in ${name}: ${JSON.stringify(layout)}`);
    assert.ok(layout.header.top >= layout.shell.top - 1, `app header stays inside the safe-area shell in ${name}: ${JSON.stringify(layout)}`);
    assert.ok(layout.sidebar.top >= layout.shell.top - 1 && layout.sidebarPaddingTop === layout.sidebarBasePaddingTop, `sidebar adds only normal spacing after the shell safe-area inset in ${name}: ${JSON.stringify(layout)}`);
    assert.ok(layout.workspace.right >= layout.viewport.width - 2, `Discuter workspace reaches the iPad right edge in ${name}: ${JSON.stringify(layout)}`);
    assert.ok(layout.conversation.right >= layout.workspace.right - 2, `conversation pane fills its slot in ${name}: ${JSON.stringify(layout)}`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(captureDir, name + '.png'), Buffer.from(shot.data, 'base64'));
    return layout;
  };
  try {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 1024, deviceScaleFactor: 2, mobile: true });
    const landscape = await targetUrl();
    await evaluate(`document.querySelector('.bu-shell').style.setProperty('--bu-safe-area-top','24px')`);
    await evaluate(`document.documentElement.setAttribute('data-theme','light')`);
    const landscapeLayout = await inspect('ipad-landscape-light-1366x1024');
    assert.equal(landscapeLayout.viewport.width, 1366);
    assert.equal(landscapeLayout.shellTop, '24px', 'the shell consumes the simulated iPad top inset once');

    await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true });
    await go(landscape, v3Base);
    await waitFor(`document.querySelector('[data-chat-thread]')`);
    await evaluate(`document.querySelector('.bu-shell').style.setProperty('--bu-safe-area-top','24px')`);
    await evaluate(`document.documentElement.setAttribute('data-theme','dark')`);
    const portraitLayout = await inspect('ipad-portrait-dark-1024x1366');
    assert.equal(portraitLayout.viewport.width, 1024);
  } finally {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [] });
  }
});

test('T-0209 capture compact Discuter agent rows at phone, desktop and iPad sizes', { skip, timeout: 60_000 }, async () => {
  const captureDir = join(UI_ROOT, '../../design/reports/t0209-agent-list/after');
  const vmIssuesFrom = vmIssues.length;
  mkdirSync(captureDir, { recursive: true });
  const capture = async (name, width, height, mobile) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await go('/v3/discuter?mock=capture-t0185', v3Base);
    await waitFor(`document.querySelectorAll('[data-chat-agent]').length>=7`);
    const rows = await evaluate(`Array.from(document.querySelectorAll('[data-chat-agent]')).map(button=>{const rect=el=>{const r=el.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right}},portrait=button.querySelector('.ao-messenger__portrait'),primary=button.querySelector('.ao-messenger__row-primary'),dot=button.querySelector('.ao-messenger__state-dot'),badge=button.querySelector('.bu-count');return {row:rect(button),portrait:rect(portrait),primary:rect(primary),dotLabel:dot?.getAttribute('aria-label'),dotTitle:dot?.title,badge:badge?rect(badge):null}})`);
    const emptyState = await evaluate(`({conversationTitles:[...document.querySelectorAll('.ao-messenger__conversation-slot .bu-empty__title')].map(node=>node.textContent.trim()),sessionsNotice:document.querySelector('[data-chat-list="sessions"] .ao-messenger__notice')?.textContent.trim()})`);
    assert.ok(rows.length>=7, `fixture renders its agent and team rows at ${width}px`);
    assert.equal(emptyState.conversationTitles.filter(title=>title==='Choisissez un agent').length,1,`only the conversation pane has the large empty state at ${width}px`);
    assert.match(emptyState.sessionsNotice||'',/Sélectionnez un agent/,`sessions pane uses the concise hint at ${width}px`);
    for (const row of rows) {
      assert.equal(row.portrait.width,40,`portrait width at ${width}px`);
      assert.equal(row.portrait.height,40,`portrait height at ${width}px`);
      assert.ok(row.primary.height<=24,`name and role stay on one line at ${width}px: ${JSON.stringify(row)}`);
      assert.ok(row.dotLabel&&row.dotTitle,`status dot exposes the supplied state label at ${width}px`);
      if (row.badge) assert.ok(row.badge.right<=row.row.right-6,`unread badge stays inside the row edge at ${width}px`);
    }
    const teamRole = await evaluate(`document.querySelector('[data-chat-agent][data-chat-kind="team"] .ao-messenger__row-primary')?.textContent||''`);
    assert.equal(teamRole,'Équipe du PM·Équipe',`team target uses its backend name and context label at ${width}px`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(captureDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  try {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] });
    await capture('mobile-390x844', 390, 844, true);
    await capture('desktop-1440x1000', 1440, 1000, false);
    await capture('ipad-portrait-1024x1366', 1024, 1366, true);
    assert.deepEqual(vmIssues.slice(vmIssuesFrom), [], 'strict browser vmcheck accepts the captured v3 agent rows and their contextLabel');
  } finally {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [] });
  }
});
