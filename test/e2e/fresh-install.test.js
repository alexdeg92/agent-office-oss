'use strict';
// Fresh install, end to end, the way a new user does it: `agent-office setup` (the published CLI entry) in a scratch
// HOME with a synthetic Claude Code home, then the browser wizard from the first page to the Office, a Settings save
// and the Store, with no unexpected 4xx/5xx and no page error. Twice: on the printed loopback URL, and behind a
// TLS-terminating reverse proxy on another hostname that the server does not trust (the owner's real topology),
// configured the documented way (AO_PUBLIC_URL in the environment).
// Skips without Chrome or playwright-core, and on an unbuilt checkout (run `node scripts/build-frontend.js`).
// AO_ONBOARDING_SHOTS=<dir> saves every step at desktop and phone width.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const http = require('node:http'), https = require('node:https');
const { spawn, execFileSync } = require('node:child_process');
const { findChrome } = require('../office/helpers/browser');

const ROOT = path.resolve(__dirname, '../..');
const SHOTS = process.env.AO_ONBOARDING_SHOTS || null;
const EMAIL = 'owner@example.invalid', PASSWORD = 'synthetic-owner-password';
const PUBLIC_HOST = 'office.example.test';
function skipReason() {
  if (process.env.AO_SKIP_BROWSER === '1') return 'AO_SKIP_BROWSER=1';
  try { require.resolve('playwright-core'); } catch { return 'no playwright-core'; }
  if (!findChrome()) return 'no Chrome (set CHROME_BIN)';
  if (!fs.existsSync(path.join(ROOT, 'public/v2/bureau/bundle.css'))) return 'unbuilt checkout (node scripts/build-frontend.js)';
  return false;
}
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Every wait below is on a condition; this is only its ceiling, generous because the suite may share the machine.
const WAIT = 60000;
async function until(predicate, what, child = null) {
  const deadline = Date.now() + WAIT;
  for (;;) {
    if (predicate()) return;
    if (child && child.exitCode != null) throw new Error(what + ': the server exited (' + child.exitCode + ')');
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
    await sleep(50);
  }
}
// A port chosen by freePort() can be taken by a parallel test before the server binds it: start again on a new port
// when, and only when, the server says the port is in use.
async function startServer(t, args, env, ready, { cwd } = {}) {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, args(port), { env: env(port), cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = { log: '' }; child.stdout.on('data', (d) => { out.log += d; }); child.stderr.on('data', (d) => { out.log += d; });
    t.after(async () => { if (child.exitCode == null && child.signalCode == null) { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); } });
    try { await until(() => ready.test(out.log), 'the server to be ready', child); return { port, child, out }; }
    catch (error) {
      if (attempt < 5 && /EADDRINUSE|already in use/.test(out.log)) continue;
      throw new Error(error.message + '\n' + out.log.slice(-2000));
    }
  }
}
// Sign in through the real form. The app renders the form, probes GET /api/v2/me (401 while signed out) and renders it
// again: wait for that probe before typing, so the typed values are not replaced, then require the login POST to succeed.
async function signIn(page, navigate, onForm = async () => {}) {
  const probe = page.waitForResponse((r) => /\/api\/v2\/me$/.test(new URL(r.url()).pathname), { timeout: WAIT });
  await navigate();
  await probe;
  await page.waitForSelector('input[type=password]', { timeout: WAIT });
  await onForm();
  await page.fill('input[type=email]', EMAIL); await page.fill('input[type=password]', PASSWORD);
  const login = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/login$/.test(new URL(r.url()).pathname), { timeout: WAIT });
  await page.keyboard.press('Enter');
  assert.equal((await login).status(), 200, 'the owner signs in');
  await page.waitForFunction(() => !location.pathname.endsWith('/connexion') && !document.querySelector('input[type=password]'), null, { timeout: WAIT });
}
// Two animation frames: the layout after a viewport change or a navigation has painted.
const painted = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

function scratchHome({ sessions = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-fresh-install-'));
  if (!sessions) { fs.mkdirSync(path.join(home, '.claude/projects'), { recursive: true }); return home; }
  const project = path.join(home, '.claude/projects/-synthetic-project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'synthetic-session.jsonl'), JSON.stringify({ type: 'user', uuid: 'synthetic-event', sessionId: 'synthetic-session',
    cwd: '/synthetic/project', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Synthetic hello' } }) + '\n');
  return home;
}

// A TLS proxy that keeps the Host, adds X-Forwarded-*, and connects from an address the server is told not to trust.
async function tlsProxy(home, upstreamPort) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(home, 'proxy.key'), '-out', path.join(home, 'proxy.crt'),
    '-days', '1', '-subj', '/CN=' + PUBLIC_HOST], { stdio: 'ignore' });
  const forward = (req) => ({ ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': PUBLIC_HOST });
  const server = https.createServer({ key: fs.readFileSync(path.join(home, 'proxy.key')), cert: fs.readFileSync(path.join(home, 'proxy.crt')) }, (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: forward(req) }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

async function walk({ proxied = false, sessions = true }, t) {
  const { chromium } = require('playwright-core');
  const home = scratchHome({ sessions });
  let proxy = null, browser = null;
  t.after(async () => { await browser?.close().catch(() => {}); proxy?.close(); fs.rmSync(home, { recursive: true, force: true }); });
  // Registered after the cleanup above, so it runs first: the server stops before its home is removed.
  const { port, out } = await startServer(t, (p) => [path.join(ROOT, 'packaging/bin/agent-office.js'), 'setup', '--port', String(p)],
    () => ({ PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TZ: 'UTC', XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      AO_PROJECTS_DISCOVERY: '0', OC_BIN: path.join(home, 'no-openclaw'), ...(proxied ? { AO_TRUST_PROXY: '192.0.2.1', AO_PUBLIC_URL: 'https://' + PUBLIC_HOST } : {}) }),
    /^(?=[\s\S]*setup code: AO-[A-Z2-9]{4}-[A-Z2-9]{4})(?=[\s\S]*agent-office on http)/);
  const code = /setup code: (AO-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(out.log)[1];
  let url = `http://127.0.0.1:${port}`, args = [];
  if (proxied) {
    proxy = await tlsProxy(home, port);
    url = `https://${PUBLIC_HOST}`; args = [`--host-resolver-rules=MAP ${PUBLIC_HOST}:443 127.0.0.1:${proxy.address().port}`];
  }
  browser = await chromium.launch({ executablePath: findChrome(), args });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(WAIT);
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror ' + e.message));
  // The single expected 4xx: GET /api/v2/me answers 401 while signed out (API contract; PM accepted it as P2), and
  // the app probes it before the owner logs in.
  page.on('response', (r) => { if (r.status() >= 400 && !(r.status() === 401 && /\/api\/v2\/me$/.test(new URL(r.url()).pathname))) problems.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  const label = proxied ? 'proxy' : sessions ? 'local' : 'no-agents';
  let n = 0;
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    for (const [width, height, kind] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
      await page.setViewportSize({ width, height }); await painted(page);
      await page.screenshot({ path: path.join(SHOTS, `${label}-${String(n).padStart(2, '0')}-${name}-${kind}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 }); n++;
  };
  const step = () => page.evaluate(() => new URLSearchParams(location.search).get('etape'));
  // A step can refuse Continue until its data has loaded (e.g. identities waits for the character catalog): the wizard
  // then shows why and stays put. So click again, but only while the page is still on the previous step and Continue
  // is enabled, checked and clicked in one page task: it can never skip a step.
  const next = async (want) => {
    const deadline = Date.now() + WAIT;
    for (;;) {
      const state = await page.evaluate((w) => {
        const at = Number(new URLSearchParams(location.search).get('etape') || 0), button = document.querySelector('.ao-setup__nav button[type=submit]');
        if (at === w) return 'there';
        if (at === w - 1 && button && !button.disabled) { button.click(); return 'clicked'; }
        return 'busy';
      }, want);
      if (state === 'there') break;
      if (Date.now() > deadline) assert.fail(`stuck before step ${want}: ${(await page.textContent('.ao-setup__body')).replace(/\s+/g, ' ').slice(-600)}`);
      await page.waitForFunction((w) => new URLSearchParams(location.search).get('etape') === String(w), want, { timeout: 1000 }).catch(() => {});
    }
    await page.waitForFunction(() => !document.querySelector('.ao-setup__nav button[type=submit]:disabled'), null, { timeout: WAIT });
  };

  await page.goto(url + '/');
  await page.waitForSelector('#setup-code');
  await shot('welcome');
  await page.fill('#setup-owner', 'Synthetic Owner'); await page.fill('#setup-email', EMAIL);
  await page.fill('#setup-password', PASSWORD); await page.fill('#setup-password2', PASSWORD); await page.fill('#setup-code', code);
  await next(1); await page.waitForSelector('[data-runtime=claude-code]'); await shot('detection');
  await next(2);
  if (await page.$eval('#setup-adapter', (e) => e.value) !== 'claude-code') await page.selectOption('#setup-adapter', 'claude-code');
  await shot('runtime');
  await next(3);   // no gateway: the readiness test runs on its own
  await page.waitForFunction(() => document.querySelector('.ao-setup__status')?.textContent.trim() && !document.querySelector('.ao-setup__status .bu-spinner') && !/Aucun test|No test/.test(document.querySelector('.ao-setup__status').textContent), null, { timeout: WAIT });
  await shot('check');
  await next(4);
  if (!(await page.$('input[id^="setup-agent-"], [data-agents-later]'))) await page.locator('.ao-setup__body button', { hasText: /Rechercher les agents|Find the agents/ }).click();
  await page.waitForSelector(sessions ? 'input[id^="setup-agent-"]' : '[data-agents-later]', { timeout: WAIT });
  for (const input of await page.$$('input[id^="setup-agent-"]')) if (!(await input.inputValue())) await input.fill('Synthetic Agent');
  await shot('agents');
  await next(5); await shot('identities');
  await next(6); await page.fill('#setup-name', 'Synthetic Office'); await shot('office');
  await next(7); await shot('skills');
  await next(8); await page.waitForSelector('[data-external-access=setup] [data-step=mode]'); await shot('access');
  const foot = '.ao-setup > .ao-frame__foot .ao-external__footer button[aria-label="Continuer"]', access = '[data-external-access=setup]';
  await page.click(`${access} [data-step=mode] input[name="external-access-mode"][value="local"]`);
  await page.click(foot); await page.waitForSelector(`${access} [data-step=security]`); await page.click(foot);
  await page.click(`${access} [data-step=review] button[aria-label="Préparer le résumé"]`);
  await page.click(`${access} [data-step=review] .ao-external__confirm input[type="checkbox"]`);
  await page.click(`${access} [data-step=review] button[aria-label="Préparer pour la publication finale"]`);
  await page.click(`${access} [data-step=verify] button[aria-label="Continuer"]`);
  await page.waitForFunction(() => new URLSearchParams(location.search).get('etape') === '9'); await shot('review');
  await next(10); await shot('done');
  assert.equal(await step(), '10');

  await signIn(page, () => page.click('.ao-setup__footer a'), () => shot('login'));
  assert.match(new URL(page.url()).pathname, /\/bureau$/, 'the sign-in returns to the Office');
  await page.waitForFunction(() => /Synthetic Owner/.test(document.body.innerText), null, { timeout: WAIT });
  // The Office has rendered its floors (the roster), not just the shell.
  await page.waitForFunction(() => /Étage 1|Floor 1/.test(document.querySelector('main')?.innerText || ''), null, { timeout: WAIT }); await painted(page); await shot('bureau');

  await page.goto(url + '/parametres'); await page.getByRole('tab', { name: 'Instance' }).click();
  const name = page.locator('main input:not([type]), main input[type=text]').first();
  await name.fill('Renamed Synthetic Office');
  const saved = page.waitForResponse((r) => r.request().method() !== 'GET' && /\/settings\//.test(r.url()), { timeout: WAIT });
  await page.locator('button:has-text("Enregistrer")').first().click();
  assert.equal((await saved).status(), 200, 'Settings save succeeds');
  await shot('settings-saved');
  await page.goto(url + '/discuter'); await page.waitForSelector('main', { timeout: WAIT });
  if (sessions) await page.waitForFunction(() => /Synthetic Agent|project/i.test(document.querySelector('main')?.innerText || ''), null, { timeout: WAIT });
  await shot('chat');
  await page.goto(url + '/boutique'); await page.waitForFunction(() => /Mobilier|Furniture/.test(document.querySelector('main')?.innerText || ''), null, { timeout: WAIT }); await painted(page); await shot('store');

  assert.deepEqual(problems, [], 'no 4xx/5xx (beyond the sign-in probe) and no page error');
  assert.ok(!/refused writes|Error:|ERR_/.test(out.log), 'no server error:\n' + out.log.slice(-2000));
}

test('fresh install: agent-office setup → wizard → Office, Settings, Chat, Store', { skip: skipReason(), timeout: 300000 }, (t) => walk({ proxied: false }, t));
test('fresh install behind an untrusted HTTPS reverse proxy on another hostname, AO_PUBLIC_URL set as install.md says', { skip: skipReason(), timeout: 300000 }, (t) => walk({ proxied: true }, t));
test('fresh install with Claude Code before its first session: no agent yet, setup still finishes', { skip: skipReason(), timeout: 300000 }, (t) => walk({ sessions: false }, t));

// Onboarding B-lite. The systemd-style env-login install (server.js, PORTAL_* in the environment, no config.json) skips
// the wizard by design; Settings offers its steps instead. The name step goes through the existing Instance save.
async function walkEnvLogin(t) {
  const { chromium } = require('playwright-core');
  const home = scratchHome();
  const hash = await require('../../src/security/password').hashPassword(PASSWORD);
  let browser = null;
  t.after(async () => { await browser?.close().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); });
  const { port, out } = await startServer(t, () => [path.join(ROOT, 'server.js')],
    (p) => ({ PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TZ: 'UTC', XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      AO_PROJECTS_DISCOVERY: '0', OC_BIN: path.join(home, 'no-openclaw'), HOST: '127.0.0.1', PORT: String(p), AO_RUNTIME: 'claude-code',
      PORTAL_EMAIL: EMAIL, PORTAL_PASSWORD_HASH: hash, PORTAL_SECRET: 's'.repeat(48) }), /AO_READY/, { cwd: ROOT });
  assert.ok(!/setup code/.test(out.log), 'an env-login install never opens the wizard');
  browser = await chromium.launch({ executablePath: findChrome() });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.setDefaultTimeout(WAIT);
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400 && !(r.status() === 401 && /\/api\/v2\/me$/.test(new URL(r.url()).pathname))) problems.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  const url = `http://127.0.0.1:${port}/v2`;
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true });
    for (const [width, height, kind] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) { await page.setViewportSize({ width, height }); await painted(page); await page.screenshot({ path: path.join(SHOTS, `env-login-${name}-${kind}.png`), fullPage: true }); }
    await page.setViewportSize({ width: 1280, height: 900 }); };
  await signIn(page, () => page.goto(url + '/connexion'));
  await page.goto(url + '/parametres');
  const card = page.getByTestId('settings-finish-setup');
  await card.waitFor({ timeout: WAIT });
  assert.match(await card.innerText(), /Terminer l’installation du bureau/);
  await shot('finish-card');
  await page.getByTestId('finish-instance').getByRole('button').click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('onglet') === 'instance');
  await page.locator('main input:not([type]), main input[type=text]').first().fill('Synthetic Office');
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/settings\/instance$/.test(r.url()), { timeout: WAIT });
  await page.locator('button:has-text("Enregistrer")').first().click();
  const response = await saved; assert.equal(response.status(), 200, await response.text());
  await page.getByRole('tab', { name: 'Diagnostic' }).click();
  await page.getByTestId('finish-instance').locator('[aria-label="Fait"]').waitFor({ timeout: WAIT });
  assert.match(await page.getByTestId('finish-instance').innerText(), /Synthetic|Nommer le bureau/);
  assert.equal(await page.getByTestId('finish-instance').locator('[aria-label="Fait"]').count(), 1, 'the name step is done after the Instance save');
  await shot('finish-step-done');
  await card.getByRole('button', { name: 'Masquer' }).click();
  await card.waitFor({ state: 'detached', timeout: WAIT });
  // After the reload, wait for the Settings data itself (its diagnostic rows), not a fixed delay, before checking.
  await page.reload(); await page.waitForSelector('[data-testid^="diagnostic-"]', { timeout: WAIT });
  assert.equal(await page.getByTestId('settings-finish-setup').count(), 0, 'hidden for good');
  assert.deepEqual(problems, [], 'no 4xx/5xx (beyond the sign-in probe) and no page error');
}
test('env-login install (no wizard by design): Settings offers the setup steps, tracks them, and hides on request', { skip: skipReason(), timeout: 300000 }, (t) => walkEnvLogin(t));
