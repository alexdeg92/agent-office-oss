'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '../../integrations/openclaw-skill/projets/scripts/projets.js');
const TOKEN = 'draft-token-value';
const ID = 'prj_k3v9q2m8x1c4d7fz';

function listen(handler) {
  const requests = [];
  const sockets = new Set();
  let pending = 0;
  const waiters = [];
  const release = () => {
    if (pending !== 0) return;
    for (const resolve of waiters.splice(0)) resolve();
  };
  const server = http.createServer((req, res) => {
    pending += 1;
    const record = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || '',
      body: '',
    };
    requests.push(record);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      record.body = Buffer.concat(chunks).toString('utf8');
      handler(req, res, record);
    });
    let done = false;
    const settled = () => {
      if (done) return;
      done = true;
      pending -= 1;
      release();
    };
    res.on('finish', settled);
    res.on('close', settled);
  });
  server.requests = requests;
  server.whenIdle = () => new Promise((resolve) => {
    waiters.push(resolve);
    release();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.stop = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function cliCalls(server) {
  return server.requests.filter((call) => call.authorization === `Bearer ${TOKEN}`);
}

function run(server, args, env = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH,
        AGENT_OFFICE_URL: `http://127.0.0.1:${port}`,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      server.whenIdle().then(() => resolve({ code, stdout, stderr, calls: cliCalls(server).length }));
    });
  });
}

describe('Timmy projets CLI', () => {
  it('sends only the five scoped writes with the bearer token', async () => {
    const server = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ data: { ok: true, result: null, revision: 2, vm: null } }));
    });
    try {
      const status = await run(server, ['status', ID, '1', 'todo'], { AGENT_OFFICE_TOKEN: TOKEN });
      const reorder = await run(server, ['reorder', ID, '2', 'in-progress'], { AGENT_OFFICE_TOKEN: TOKEN });
      const label = await run(server, ['label', ID, '3', 'interne'], { AGENT_OFFICE_TOKEN: TOKEN });
      const summary = await run(server, ['summary', ID, '4', 'Résumé court'], { AGENT_OFFICE_TOKEN: TOKEN });
      const history = await run(server, [
        'history', ID, '4', 'agent-action', 'action=commented', 'note=Terminé',
      ], { AGENT_OFFICE_TOKEN: TOKEN });
      assert.equal(status.code, 0);
      assert.equal(reorder.code, 0);
      assert.equal(label.code, 0);
      assert.equal(summary.code, 0);
      assert.equal(history.code, 0);
      const seen = cliCalls(server);
      assert.equal(seen.length, 5);
      assert.deepEqual(seen.map((call) => [call.method, call.url]), [
        ['PUT', `/api/v2/projects/${ID}/status`],
        ['PUT', `/api/v2/projects/${ID}/status`],
        ['POST', `/api/v2/projects/${ID}/flags`],
        ['PATCH', `/api/v2/projects/${ID}`],
        ['POST', `/api/v2/projects/${ID}/history`],
      ]);
      for (const call of seen) assert.equal(JSON.parse(call.body).actor, undefined);
      assert.deepEqual(JSON.parse(seen[0].body), { expectedRevision: 1, status: 'todo' });
      assert.deepEqual(JSON.parse(seen[2].body), { expectedRevision: 3, kind: 'label', label: 'interne' });
      assert.deepEqual(JSON.parse(seen[3].body), { expectedRevision: 4, summary: 'Résumé court' });
      assert.equal(JSON.parse(seen[4].body).kind, 'agent-action');
      assert.equal(JSON.parse(seen[4].body).note, 'Terminé');
      const printed = [status, reorder, label, summary, history].map((r) => r.stdout + r.stderr).join('\n');
      assert.equal(printed.includes(TOKEN), false);
    } finally {
      await server.stop();
    }
  });

  it('does not call the server for a forbidden command, a column index, or a missing token', async () => {
    const server = await listen((req, res) => {
      res.writeHead(500, { connection: 'close' });
      res.end();
    });
    try {
      const archive = await run(server, ['archive', ID, '1'], { AGENT_OFFICE_TOKEN: TOKEN });
      const index = await run(server, ['reorder', ID, '1', 'todo', 'index=0'], { AGENT_OFFICE_TOKEN: TOKEN });
      const logs = await run(server, ['logs'], { AGENT_OFFICE_TOKEN: TOKEN });
      const missing = await run(server, ['status', ID, '1', 'todo'], {});
      assert.equal(archive.code, 2);
      assert.equal(index.code, 2);
      assert.equal(logs.code, 2);
      assert.equal(missing.code, 2);
      assert.match(archive.stderr, /hors du jeton/);
      assert.match(index.stderr, /position/);
      assert.match(missing.stderr, /AGENT_OFFICE_TOKEN manquant/);
      assert.equal(archive.calls, 0);
      assert.equal(index.calls, 0);
      assert.equal(logs.calls, 0);
      assert.equal(missing.calls, 0);
      assert.equal(cliCalls(server).length, 0);
      assert.equal((archive.stderr + index.stderr + missing.stderr).includes(TOKEN), false);
    } finally {
      await server.stop();
    }
  });

  it('prints a 409 without following a redirect or repeating the token', async () => {
    const server = await listen((req, res, record) => {
      if (record.url.endsWith('/status')) {
        res.writeHead(409, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: { code: 'conflict', message: 'Le projet a changé entre-temps.' } }));
        return;
      }
      res.writeHead(302, { location: 'http://127.0.0.1/secret', connection: 'close' });
      res.end();
    });
    try {
      const conflict = await run(server, ['status', ID, '1', 'todo'], { AGENT_OFFICE_TOKEN: TOKEN });
      const redirected = await run(server, ['summary', ID, '1', 'Autre'], { AGENT_OFFICE_TOKEN: TOKEN });
      assert.equal(conflict.code, 1);
      assert.match(conflict.stdout, /conflict/);
      assert.equal(conflict.stdout.includes(TOKEN), false);
      assert.equal(redirected.code, 1);
      assert.match(redirected.stderr, /Redirection refusée/);
      assert.equal(conflict.calls, 1);
      assert.equal(redirected.calls, 2);
      assert.deepEqual(cliCalls(server).map((call) => call.url), [
        `/api/v2/projects/${ID}/status`,
        `/api/v2/projects/${ID}`,
      ]);
    } finally {
      await server.stop();
    }
  });

  it('refuses to send the token inside the note', async () => {
    const server = await listen((req, res) => {
      res.writeHead(204, { connection: 'close' });
      res.end();
    });
    try {
      const leaked = await run(server, [
        'history', ID, '1', 'agent-action', 'action=commented', `note=${TOKEN}`,
      ], { AGENT_OFFICE_TOKEN: TOKEN });
      assert.equal(leaked.code, 2);
      assert.equal(leaked.calls, 0);
      assert.equal(cliCalls(server).length, 0);
      assert.equal(leaked.stderr.includes(TOKEN), false);
    } finally {
      await server.stop();
    }
  });
});
