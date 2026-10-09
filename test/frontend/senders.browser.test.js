import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { createFrontendServer } = require('../../scripts/serve-frontend');
const WebSocket = require('ws');
const chromePath = process.env.CHROME || '/usr/bin/google-chrome';
const skip = !existsSync(chromePath) ? 'Chrome unavailable' : false;
let server, chrome, socket, profile, origin, seq = 0;
const waiting = new Map(), errors = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function send(method, params = {}) { return new Promise((res, rej) => { const id = ++seq; waiting.set(id, (m) => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); socket.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
async function until(expression) { for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await pause(50); } throw new Error('Timeout: ' + expression + '\nBrowser errors: ' + JSON.stringify(errors)); }
async function navigate(path) { await send('Page.navigate', { url: origin + path }); await until("!!document.querySelector('#app .bu-page') && document.readyState === 'complete'"); }
before(async () => {
  if (skip) return;
  server = createFrontendServer({ root: resolve('public/v2'), basePath: '/v2/', apiBase: '', apiVersion: 3 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${server.address().port}`;
  profile = mkdtempSync(join(tmpdir(), 'ao-senders-'));
  chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let port; for (let i = 0; i < 100 && !port; i++) { try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await pause(100); } }
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => socket.once('open', r));
  socket.on('message', (data) => { const m = JSON.parse(data); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value || a.description).join(' ')); });
  await send('Page.enable'); await send('Runtime.enable');
});
after(async () => { if (process.env.AO_SENDER_DIAGNOSTICS) writeFileSync(process.env.AO_SENDER_DIAGNOSTICS, JSON.stringify(errors, null, 2) + '\n'); socket?.close(); if (chrome) { const exited = new Promise((r) => chrome.once('exit', r)); chrome.kill('SIGTERM'); await exited; } if (server) await new Promise((r) => server.close(r)); if (profile) rmSync(profile, { recursive: true, force: true }); });
test('three-human group: names, stable avatars, grouped messages, Request summary and both layouts', { skip, timeout: 30000 }, async () => {
  for (const width of [1440, 360]) for (const view of ['arbre', 'chronologie']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width === 360 });
    await navigate('/v2/journaux/' + encodeURIComponent('agent:main:discord:channel:projets') + '?mock=1&vue=' + view);
    await until("!!document.querySelector('.ao-session__participants') && document.querySelector('.ao-session__participants').textContent.includes('Noor')");
    assert.match(await evaluate("document.querySelector('.ao-session__participants').textContent"), /4 participants : Mira, Jules, Noor, Atlas/);
    assert.match(await evaluate("document.querySelector('.ao-conversation-summary').textContent"), /Mira : Préparons/);
    if (view === 'arbre') {
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.bu-trace__node--human .bu-trace__who')].map(e=>e.textContent).sort()"), ['Jules', 'Mira', 'Noor']);
      assert.equal(await evaluate("[...document.querySelectorAll('.bu-trace__node--human')].find(e=>e.querySelector('.bu-trace__who').textContent==='Mira').querySelectorAll('.bu-trace__body').length"), 2);
    } else for (const name of ['Mira', 'Jules', 'Noor']) assert.ok((await evaluate("document.querySelector('.bu-waterfall').textContent")).includes(name));
    assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no horizontal overflow at ' + width);
    if (process.env.AO_SENDER_SCREENSHOTS === '1') {
      await evaluate('document.fonts.ready');
      const dir = resolve('design/reports/backend-2'); mkdirSync(dir, { recursive: true });
      const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(dir, `group-${view}-${width}.png`), Buffer.from(result.data, 'base64'));
    }
  }
  assert.deepEqual(errors, []);
});
test('Discuter shows the local operator and sender avatar', { skip, timeout: 15000 }, async () => {
  await navigate('/v2/discuter?mock=1'); await until("!!document.querySelector('.bu-msg--user .bu-msg__who')");
  assert.equal(await evaluate("document.querySelector('.bu-msg--user .bu-msg__who').textContent"), 'Camille');
  assert.ok(await evaluate("!!document.querySelector('.bu-msg--user .ao-sender-avatar')")); assert.deepEqual(errors, []);
});
test('inline History preview keeps each human sender and the Request name', { skip, timeout: 15000 }, async () => {
  await navigate('/v2/journaux/' + encodeURIComponent('agent:main:discord:channel:projets') + '?mock=1');
  await evaluate(`(async () => {
    const { buildQuery } = await import('/v2/config.js');
    const { h, render } = await import('/v2/lib.js' + buildQuery);
    const { ConversationPreview } = await import('/v2/components/conversation.js' + buildQuery);
    const panel = document.createElement('aside'); panel.id = 'sender-preview-test'; document.body.append(panel);
    render(h(ConversationPreview, { sessionKey: 'agent:main:discord:channel:projets', href: '#' }), panel);
  })()`);
  await until("!!document.querySelector('#sender-preview-test .ao-conversation-messages')");
  assert.match(await evaluate("document.querySelector('#sender-preview-test .ao-conversation-summary').textContent"), /Mira : Préparons/);
  const names = await evaluate("[...document.querySelectorAll('#sender-preview-test .ao-conversation-bubble--user b')].map(e=>e.textContent)");
  // The preview's recent-message window may omit the oldest human; every remaining human retains their own name.
  assert.ok(names.every((name) => ['Mira', 'Jules', 'Noor'].includes(name)) && names.includes('Noor'));
  assert.deepEqual(errors, []);
});

test('delegated roster expands nine linked tasks and summaries render Markdown as plain text', { skip, timeout: 15000 }, async () => {
  await navigate('/v2/journaux/' + encodeURIComponent('agent:main:discord:channel:projets') + '?mock=1');
  const resultText = JSON.stringify('**Completed** for `main` with [details](https://example.test).');
  await evaluate(`(async () => {
    const { buildQuery } = await import('/v2/config.js');
    const { h, render } = await import('/v2/lib.js' + buildQuery);
    const { SessionParticipants } = await import('/v2/components/session-participants.js' + buildQuery);
    const { ConversationSummary } = await import('/v2/components/conversation.js' + buildQuery);
    const panel = document.createElement('aside'); panel.id = 'delegation-preview-test'; document.body.append(panel);
    const sender = (id, name, kind='agent') => ({ id, name, kind, runtime:'foreign', channel:null, avatarHint:null });
    const human = sender('human','Mira','human'), agent = sender('primary','Atlas');
    const children = Array.from({length:9}, (_,i) => ({...sender('child/' + i,null), delegation:{sessionKey:'child/' + i,label:i===0?'Inspect the logs':null}}));
    render(h('div', {}, h(SessionParticipants, { participants:[human,human,agent,agent], subagents:[...children,children[0]] }),
      h(ConversationSummary, { events:[{id:'ask',kind:'user',text:'Please **review**',senderInfo:human}, {id:'reply',kind:'assistant',text:${resultText}}] })), panel);
  })()`);
  assert.equal(await evaluate("document.querySelector('#delegation-preview-test .ao-session__participants').textContent"), '2 participants : Mira, Atlas');
  assert.equal(await evaluate("document.querySelector('#delegation-preview-test summary').textContent"), '+ 9 sous-agents');
  assert.equal(await evaluate("document.querySelector('#delegation-preview-test details').open"), false);
  await evaluate("document.querySelector('#delegation-preview-test summary').click()");
  assert.equal(await evaluate("document.querySelector('#delegation-preview-test details').open"), true);
  const links = await evaluate("[...document.querySelectorAll('#delegation-preview-test li a')].map(a=>({name:a.textContent,href:a.getAttribute('href')}))");
  assert.equal(links.length, 9); assert.equal(links[0].name, 'Inspect the logs');
  assert.ok(links[0].href.includes(encodeURIComponent('child/0')));
  assert.equal(new Set(links.map((a) => a.name)).size, 9);
  const summary = await evaluate("document.querySelector('#delegation-preview-test .ao-conversation-summary').textContent");
  assert.match(summary, /Mira : Please review/); assert.match(summary, /Completed for main with details\./);
  assert.doesNotMatch(summary, /\*\*|`|\[details\]/); assert.deepEqual(errors, []);
});
