// Contract 3.0 (G5, api-v3.md D1–D8): with apiVersion 3 the mock answers /api/v3 through mock/v3.js, and every VM
// that changes in 3.0 matches its examples/v3/ file on the full envelope (compareExample with a 'v3/' name).
// The office (D3) and layout (D4) are office-dev's mock and are checked on their side. Nothing switches yet:
// the UI stays on v2 until architect's server serves /api/v3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { configure as configureUi, apiUrl } from '../../public/v2/config.js';

const { compareExample } = createRequire(import.meta.url)('../helpers/contract-shape.js');
configureUi({ basePath: '/', apiBase: '/backend', apiVersion: 3 });
const server = await import('../../public/v2/mock/server.js');
server.configure({ scenario: '1', standalone: true });
const call = (m, p, b) => server.handle(m, p, b);
const same = (name, r) => { assert.equal(r.status, 200, name); assert.deepEqual(compareExample('v3/' + name, r.body, { envelope: true }), [], name); };

test('one version for the whole client: apiUrl puts the configured version on every api.md path', () => {
  assert.equal(apiUrl('/api/v2/views/health'), '/backend/api/v3/views/health');
  assert.equal(apiUrl('/api/v3/stream?topics=health'), '/backend/api/v3/stream?topics=health');
  assert.equal(apiUrl('/api/login'), '/backend/api/login', 'v1 auth routes are not versioned');
  configureUi({ basePath: '/', apiBase: '/backend', apiVersion: 7 });
  assert.equal(apiUrl('/api/v3/meta'), '/backend/api/v2/meta', 'an unknown version falls back to 2');
  configureUi({ basePath: '/', apiBase: '/backend', apiVersion: 3 });
});

test('D1 meta, D6 health, D5 access and an interlocutor match examples/v3', async () => {
  const meta = await call('GET', '/api/v3/meta');
  same('meta-vm', meta);
  assert.equal(meta.body.data.enums.channel, undefined, 'no closed channel list in 3.0');
  assert.ok(!Object.keys(meta.body.data.labels).some((k) => /^sessionKind\.(main|cron|chat-)/.test(k)), 'no 2.x-only label');
  same('health-vm', await call('GET', '/api/v3/views/health'));
  const access = await call('GET', '/api/v3/views/access');
  same('access-vm', access);
  const one = access.body.data.interlocutors[0];
  same('interlocutor-vm', await call('GET', '/api/v3/views/interlocutors/' + encodeURIComponent(one.id)));
});

test('D2 logs and a session (3.0 kinds, runtimeKind, ChannelRef); 2.x kinds are 400 on v3', async () => {
  const logs = await call('GET', '/api/v3/views/logs');
  same('logs-page', logs);
  const kinds = new Set(logs.body.data.items.map((i) => i.kind));
  assert.ok(![...kinds].some((k) => ['main', 'cron', 'chat-direct', 'chat-group', 'dashboard', 'acp', 'explicit'].includes(k)), [...kinds].join());
  const internal = await call('GET', '/api/v3/views/logs?kind=internal');
  assert.ok(internal.body.data.items.length && internal.body.data.items.every((i) => i.kind === 'internal' && i.runtimeKind));
  assert.equal((await call('GET', '/api/v3/views/logs?kind=chat-direct')).status, 400);
  const key = logs.body.data.items.find((i) => i.kind === 'subagent').id;
  same('session-vm', await call('GET', '/api/v3/views/sessions/' + encodeURIComponent(key)));
});

test('D7 flow detail (agentId, ext.openclaw) and D8 board (with-agent + agent; with-timmy is 400)', async () => {
  const flows = (await call('GET', '/api/v3/views/flows')).body.data.flows;
  same('flow-detail-vm', await call('GET', '/api/v3/views/flows/' + encodeURIComponent(flows[0].id)));
  const board = await call('GET', '/api/v3/views/projects?filter=with-agent');
  same('board-vm', board);
  assert.deepEqual([board.body.data.filter, board.body.data.agent], ['with-agent', 'main']);
  assert.equal((await call('GET', '/api/v3/views/projects?filter=with-timmy')).status, 400);
});

test('a v2 client still gets 2.5 from the same mock (one version per client)', async () => {
  configureUi({ basePath: '/', apiBase: '/backend', apiVersion: 2 });
  try {
    const r = await call('GET', '/api/v2/views/logs');
    assert.ok(r.body.data.items.some((i) => i.kind === 'cron') && !('runtimeKind' in r.body.data.items[0]));
    assert.deepEqual(compareExample('logs-page', r.body, { envelope: true }), []);
  } finally { configureUi({ basePath: '/', apiBase: '/backend', apiVersion: 3 }); }
});

test('office-dev-14: the office mock speaks the configured contract; ?capacites= previews a smaller runtime', async () => {
  const { capabilitiesFrom } = await import('../../public/v2/mock/v3.js');
  assert.equal(capabilitiesFrom(''), null, 'no hook: the full set');
  const caps = capabilitiesFrom('?capacites=-chat,-flows.write,-restart');
  assert.deepEqual([caps.chat, caps.flows.write, caps.flows.read, caps.restart, caps.skills.toggle], [false, false, true, false, true]);
  const src = (await import('node:fs')).readFileSync(new URL('../../public/v2/mock/server.js', import.meta.url), 'utf8');
  assert.match(src, /createOfficeMock\(\{[^}]*version: config\.apiVersion/);
});

test('R27-03: ?capacites= never writes through the prototype chain; only known capability toggles are accepted', async () => {
  const { capabilitiesFrom } = await import('../../public/v2/mock/v3.js');
  const snapshot = () => Object.getOwnPropertyNames(Object.prototype).map((k) => [k, Object.getOwnPropertyDescriptor(Object.prototype, k).value]);
  const before = snapshot();
  for (const hostile of ['-__proto__.hasOwnProperty', '-constructor.prototype.toString', '-prototype.x', '+__proto__.polluted', '-flows.__proto__.isPrototypeOf', '-chat.__proto__']) {
    const caps = capabilitiesFrom('?capacites=' + encodeURIComponent(hostile));
    assert.ok(caps && Object.getPrototypeOf(caps) === null, 'a null-prototype result');
  }
  assert.deepEqual(snapshot(), before, 'Object.prototype unchanged');
  assert.equal({}.polluted, undefined);
  assert.equal(typeof {}.hasOwnProperty, 'function');
  const caps = capabilitiesFrom('?capacites=-chat,-nope,-flows.write,-flows.schedules,+made.up');
  assert.deepEqual([caps.chat, caps.flows.write, Array.isArray(caps.flows.schedules), 'nope' in caps, 'made' in caps], [false, false, true, false, false],
    'unknown paths and non-boolean capabilities are ignored');
});
