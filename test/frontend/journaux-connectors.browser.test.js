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
  profile = mkdtempSync(join(tmpdir(), 'ao-journaux-'));
  chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let port; for (let i = 0; i < 100 && !port; i++) { try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await pause(100); } }
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => socket.once('open', r));
  socket.on('message', (data) => { const m = JSON.parse(data); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value || a.description).join(' ')); });
  await send('Page.enable'); await send('Runtime.enable');
});
after(async () => { if (process.env.AO_JOURNAUX_DIAGNOSTICS) writeFileSync(process.env.AO_JOURNAUX_DIAGNOSTICS, JSON.stringify(errors, null, 2) + '\n'); socket?.close(); if (chrome) { const exited = new Promise((r) => chrome.once('exit', r)); chrome.kill('SIGTERM'); await exited; } if (server) await new Promise((r) => server.close(r)); if (profile) rmSync(profile, { recursive: true, force: true }); });

// T-0058: Journaux for several connectors and agents (mock data: OpenClaw + Claude Code, adapter-declared marks).
const rowsText = "[...document.querySelectorAll('.ao-logs__table .bu-table__row')].map(r => r.innerText).join('\\n')";
test('Connecteur and Agent columns, canonical titles, no raw keys, unknown tokens hidden, FR and EN', { skip, timeout: 60000 }, async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  for (const [lang, heads] of [['fr', ['CONNECTEUR', 'SESSION', 'AGENT', 'MODÈLE', 'JETONS']], ['en', ['CONNECTOR', 'SESSION', 'AGENT', 'MODEL', 'TOKENS']]]) {
    await navigate('/v2/journaux?mock=1'); await evaluate(`localStorage.setItem('ao.locale', '${lang}'); true`);
    await navigate('/v2/journaux?mock=1');
    await until("document.querySelectorAll('.ao-logs__table .bu-table__row').length > 5");
    const head = (await evaluate("document.querySelector('.ao-logs__table .bu-table__head').innerText")).toUpperCase();
    for (const h of heads) assert.ok(head.includes(h), `${lang}: header ${h} in ${head}`);
    const rows = await evaluate(`[...document.querySelectorAll('.ao-logs__table .bu-table__row')].map(r => ({ text: r.innerText, href: r.getAttribute('href'),
      mark: r.querySelector('.ao-connector__mark')?.textContent, connector: r.querySelector('.ao-connector__name')?.textContent, agent: r.querySelector('.ao-logs__agent')?.textContent,
      tokens: r.querySelectorAll('[role=cell]')[4]?.textContent, color: r.querySelector('.ao-connector__mark') && getComputedStyle(r.querySelector('.ao-connector__mark')).borderTopColor, logo: !!r.querySelector('.ao-connector__mark img.ao-brand-mark__image') }))`);
    const coding = rows.find(r => r.text.includes('Corriger le bureau mobile'));
    assert.equal(coding.mark, 'CC'); assert.equal(coding.connector, 'Claude Code'); assert.equal(coding.agent, 'agent-office');
    assert.equal(coding.tokens, '—', 'unknown tokens are not shown as 0');
    assert.ok(coding.logo, 'the provider logo replaces the initials');
    assert.match(coding.text, lang === 'fr' ? /Activité observée/ : /Activity observed/);
    assert.equal(coding.color, 'rgb(163, 74, 44)', 'the adapter-declared colour frames the logo');
    const main = rows.find(r => /Session principale|Main session/.test(r.text));
    assert.ok(main && main.mark === 'OC' && main.agent && main.agent !== '—', 'the main session names its OpenClaw agent');
    for (const r of rows) assert.ok(!/(^|\s)(agent:main:|rt:claude-code:)/.test(r.text), 'no raw session key in a row: ' + r.text);
    assert.match(rows.map(r => r.text).join('\n'), lang === 'fr' ? /Groupe sans nom · Discord/ : /Unnamed group · Discord/);
    assert.ok(!/\bGroup(e)?\b.*Corriger/.test(coding.text) && /Conversation/.test(coding.text), 'a coding session is a Conversation, not a Group: ' + coding.text);
    if (lang === 'fr') writeFileSync(resolve('design/reports/logs-after.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  assert.deepEqual(errors, []);
});

test('connector and agent filters narrow the server query and keep the URL', { skip, timeout: 60000 }, async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await navigate('/v2/journaux?mock=1'); await evaluate("localStorage.setItem('ao.locale', 'fr'); true");
  await navigate('/v2/journaux?mock=1');
  await until("!!document.querySelector('#logs-connector')");
  const options = await evaluate("[...document.querySelectorAll('#logs-connector option')].map(o => o.textContent)");
  assert.deepEqual(options, ['Tous les connecteurs', 'Claude Code', 'Codex', 'OpenClaw']);
  assert.equal(await evaluate("(() => { const marks = [...document.querySelectorAll('.ao-logs__table .ao-brand-mark')].filter(m => m.querySelector('img[src$=\"codex.svg\"]')); return marks.length > 0 && marks.every(m => m.classList.contains('ao-brand-mark--theme-variants') && m.querySelector('img[src$=\"codex-dark.svg\"]')); })()"), true, 'Codex marks carry the dark logo variant');
  await evaluate("{ const s = document.querySelector('#logs-connector'); s.value = 'claude-code'; s.dispatchEvent(new Event('change', { bubbles: true })); } true");
  await until("location.search.includes('connecteur=claude-code') && [...document.querySelectorAll('.ao-logs__table .bu-table__row')].every(r => r.querySelector('.ao-connector__mark')?.textContent === 'CC')");
  await until("document.querySelectorAll('#logs-agent option').length === 3");
  const agents = await evaluate("[...document.querySelectorAll('#logs-agent option')].map(o => o.textContent)");
  assert.deepEqual(agents, ['Tous les agents', 'agent-office', 'portail-client']);
  await evaluate("{ const s = document.querySelector('#logs-agent'); s.value = 'rt:claude-code:agent:portail-client'; s.dispatchEvent(new Event('change', { bubbles: true })); } true");
  await until("location.search.includes('agent=') && document.querySelectorAll('.ao-logs__table .bu-table__row').length === 1");
  assert.match(await evaluate(rowsText), /Ajouter le menu de la semaine/);
  assert.deepEqual(errors, []);
});

test('mobile cards show the mark, the agent and no 0 tokens', { skip, timeout: 60000 }, async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
  await navigate('/v2/journaux?mock=1'); await evaluate("localStorage.setItem('ao.locale', 'fr'); true");
  await navigate('/v2/journaux?mock=1');
  await until("document.querySelectorAll('.ao-logs__cards li').length > 5");
  const card = await evaluate("[...document.querySelectorAll('.ao-logs__cards li')].map(li => li.innerText).find(t => t.includes('Corriger le bureau mobile'))");
  assert.equal(await evaluate("!![...document.querySelectorAll('.ao-logs__cards li')].find(li => li.innerText.includes('Corriger le bureau mobile'))?.querySelector('img[src*=\"claude-code\"]')"), true, 'card shows the provider logo'); assert.match(card, /agent-office/); assert.doesNotMatch(card, /\b0 jeton/);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, 'no horizontal scroll');
  writeFileSync(resolve('design/reports/logs-after-mobile.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  assert.deepEqual(errors, []);
});
