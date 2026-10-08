'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const script = path.join(root, 'scripts', 'golive-smoke.sh');
const SECRET = 'sess-smoke-secret-value';
const EMAIL = 'smoke@example.com';
const PASSWORD = 'smoke-password-value';

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function shimDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-curl-shim-'));
  const curl = fs.realpathSync(require('node:child_process').execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim());
  const log = path.join(dir, 'argv.log');
  const modes = path.join(dir, 'modes.log');
  fs.writeFileSync(path.join(dir, 'curl'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
prev=
for arg in "$@"; do
  if [ "$prev" = "-b" ] || [ "$prev" = "-c" ]; then
    if [ -f "$arg" ]; then stat -c %a "$arg" >> ${JSON.stringify(modes)}; fi
  fi
  prev=$arg
done
exec ${JSON.stringify(curl)} "$@"
`);
  fs.chmodSync(path.join(dir, 'curl'), 0o755);
  return { dir, log, modes };
}

function runSmoke(url, args, extraEnv = {}) {
  const shim = shimDir();
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(script, args, {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${shim.dir}:${process.env.PATH}`,
        PORTAL_EMAIL: EMAIL,
        PORTAL_PASSWORD: PASSWORD,
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf) => { stdout += buf; });
    child.stderr.on('data', (buf) => { stderr += buf; });
    child.on('close', (status) => {
      resolve({
        status,
        stdout,
        stderr,
        ms: Date.now() - started,
        argv: fs.existsSync(shim.log) ? fs.readFileSync(shim.log, 'utf8') : '',
        modes: fs.existsSync(shim.modes) ? fs.readFileSync(shim.modes, 'utf8').trim().split('\n').filter(Boolean) : [],
      });
    });
  });
}

function assertSecretFree(result) {
  const blob = `${result.stdout}\n${result.stderr}\n${result.argv}`;
  assert.equal(blob.includes(SECRET), false);
  assert.equal(blob.includes(PASSWORD), false);
  assert.equal(blob.includes(EMAIL), false);
  assert.equal(result.argv.includes('taco_sess'), false);
  assert.ok(result.modes.length > 0);
  assert.ok(result.modes.every((mode) => mode === '600'));
}

function app(options = {}) {
  const state = { muted: options.initiallyMuted === true, puts: [], logout: 0, paths: [] };
  let unmuteRefusals = options.unmuteRefusals ?? 0;
  let remuteRefusals = options.remuteRefusals ?? 0;
  const serverPromise = listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.paths.push(url.pathname);
    const send = (code, body, headers = {}) => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(code, { 'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', ...headers });
      res.end(payload);
    };
    if (url.pathname === '/hang-stream' || url.pathname.endsWith('/api/v2/stream')) {
      if (options.withholdHeaders) return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: hello\ndata: {}\n\n');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      send(200, '<!doctype html><html><title>ok</title></html>');
      return;
    }
    const api = url.pathname.startsWith('/backend') ? url.pathname.slice('/backend'.length) || '/' : null;
    if (api == null) { send(404, { error: { code: 'not_found' } }); return; }
    if (req.method === 'GET' && api === '/') { send(404, { error: { code: 'not_found' } }); return; }
    if (req.method === 'POST' && api === '/api/login') {
      send(200, { data: { ok: true } }, { 'set-cookie': `taco_sess=${SECRET}; Path=/; HttpOnly` });
      return;
    }
    const cookie = req.headers.cookie || '';
    const authed = cookie.includes(`taco_sess=${SECRET}`);
    if (req.method === 'GET' && api === '/api/v2/meta') {
      send(200, { data: { env: 'dev', capabilities: { storeWrites: true, openclawWrites: true } } });
      return;
    }
    if (!authed && api !== '/api/v2/meta') { send(401, { error: { code: 'unauthorized' } }); return; }
    if (req.method === 'GET' && api === '/api/v2/views/health') {
      send(200, {
        data: {
          level: 'ok',
          dataQuality: {
            issues: options.noIssue ? [] : [{ id: options.issueId || 'warn-1', severity: 'warning', state: state.muted ? 'muted' : 'open' }],
          },
        },
      });
      return;
    }
    if (req.method === 'PUT' && api.startsWith('/api/v2/health/issues/') && api.endsWith('/muted')) {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const muted = JSON.parse(raw).muted === true;
        state.puts.push(muted);
        if (muted === false && unmuteRefusals > 0) {
          unmuteRefusals -= 1;
          send(503, { error: { code: 'unavailable' } });
          return;
        }
        if (options.refuseUnmute && muted === false) { send(503, { error: { code: 'unavailable' } }); return; }
        if (muted === true && state.puts.filter(Boolean).length > 1 && remuteRefusals > 0) {
          remuteRefusals -= 1;
          send(503, { error: { code: 'unavailable' } });
          return;
        }
        state.muted = muted;
        send(200, { data: { muted } });
      });
      return;
    }
    if (req.method === 'POST' && api === '/api/logout') {
      state.logout += 1;
      send(200, { data: { ok: true } }, { 'set-cookie': 'taco_sess=; Path=/; Max-Age=0; HttpOnly' });
      return;
    }
    if (req.method === 'GET' && api === '/api/v2/me') {
      send(state.logout ? 401 : 200, state.logout ? { error: { code: 'unauthorized' } } : { data: { ok: true } });
      return;
    }
    send(404, { error: { code: 'not_found' } });
  });
  return { state, serverPromise };
}

describe('golive-smoke', () => {
  it('keeps the session cookie out of curl argv and defaults the API prefix to /backend', async () => {
    const { state, serverPromise } = app({ unmuteRefusals: 1, issueId: 'warn-1' });
    const { server, url } = await serverPromise;
    try {
      const result = await runSmoke(url, [url]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ok: golive-smoke/);
      assertSecretFree(result);
      assert.ok(state.paths.includes('/backend/api/v2/meta'));
      assert.deepEqual(state.puts, [true, false, false]);
      assert.equal(state.muted, false);
      assert.equal(state.logout, 1);
      assert.doesNotMatch(result.stderr, /left muted/);
    } finally {
      server.close();
    }
  });

  it('names the issue and exits non-zero when unmute keeps failing', async () => {
    const { state, serverPromise } = app({ refuseUnmute: true, issueId: 'warn-1' });
    const { server, url } = await serverPromise;
    try {
      const result = await runSmoke(url, [url, '/backend']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /fail: issue warn-1 left muted/);
      assertSecretFree(result);
      assert.equal(state.muted, true);
      assert.equal(state.logout, 1);
    } finally {
      server.close();
    }
  });

  it('puts an issue that was already muted back after a transient remute failure', async () => {
    const { state, serverPromise } = app({ initiallyMuted: true, issueId: 'warn-muted', remuteRefusals: 1 });
    const { server, url } = await serverPromise;
    try {
      const result = await runSmoke(url, [url]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(state.puts, [true, false, true, true]);
      assert.equal(state.muted, true);
      assertSecretFree(result);
    } finally {
      server.close();
    }
  });

  it('bounds an SSE request that never sends headers', async () => {
    const { state, serverPromise } = app({ withholdHeaders: true, noIssue: true });
    const { server, url } = await serverPromise;
    try {
      const result = await runSmoke(url, [url]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /SSE first event/);
      assert.ok(result.ms < 14000, `waited ${result.ms}ms`);
      assertSecretFree(result);
      assert.equal(state.logout, 1);
    } finally {
      server.close();
    }
  });
});
