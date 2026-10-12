'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const { createCli } = require('../../src/adapters/openclaw/cli');
const { createRuntime } = require('../../src/adapters/openclaw');

function heldCli(t, limits = {}) {
  const children = [];
  let throwNext = false;
  t.mock.method(childProcess, 'execFile', (_bin, args, options, callback) => {
    if (throwNext) { throwNext = false; throw Error('synthetic spawn refusal'); }
    const child = new EventEmitter();
    let replied = false;
    const reply = (err = null) => { if (!replied) { replied = true; callback(err, err ? '' : '{"ok":true}', ''); } };
    const record = { args, options, child, finish(error) { reply(error); child.emit('close', error ? 1 : 0); } };
    options.signal?.addEventListener('abort', () => reply(Object.assign(Error('synthetic abort'), { code: 'ABORT_ERR' })), { once: true });
    children.push(record);
    return child;
  });
  const cli = createCli({ bin: '/synthetic/openclaw', home: '/synthetic/home', readonly: false, ...limits });
  return { cli, children, refuseSpawn: () => { throwNext = true; } };
}

test('shared CLI ceiling refuses before spawn, reserves read capacity and cannot be bypassed by a write flag', async t => {
  const f = heldCli(t, { maxActive: 3, reservedFreshness: 1 });
  const first = f.cli.run(['cron', 'run', '--', 'a']);
  const second = f.cli.run(['config', 'set', 'skills.entries.test.enabled', 'true']);
  assert.equal((await f.cli.run(['cron', 'run', '--', 'b'], 1000, { freshness: true })).refused, 'busy');
  assert.equal((await f.cli.run(['skills', 'info', 'test', '--agent', 'main'])).refused, 'busy');
  assert.equal(f.children.length, 2);
  const freshness = f.cli.run(['skills', 'list', '--agent', 'main'], 1000, { freshness: true });
  assert.equal(f.children.length, 3);
  assert.equal((await f.cli.run(['--version'], 1000, { freshness: true })).refused, 'busy');
  f.children[0].finish(); await first;
  const next = f.cli.run(['cron', 'run', '--', 'b']);
  assert.equal(f.children.length, 4);
  f.children[1].finish(); f.children[2].finish(); f.children[3].finish();
  await Promise.all([second, freshness, next]);
});

test('child errors and synchronous spawn rejection release slots', async t => {
  const f = heldCli(t, { maxActive: 2 });
  const first = f.cli.run(['cron', 'run', '--', 'a']);
  f.children[0].finish(Object.assign(Error('synthetic failure'), { code: 7 }));
  assert.equal((await first).code, 7);
  f.refuseSpawn(); await assert.rejects(f.cli.run(['cron', 'run', '--', 'b']), /synthetic spawn refusal/);
  const next = f.cli.run(['cron', 'run', '--', 'c']);
  assert.equal(f.children.length, 2); f.children[1].finish(); assert.equal((await next).ok, true);
});

test('abort retains admission until the child actually closes; pre-aborted calls never spawn', async t => {
  const f = heldCli(t, { maxActive: 2 }), controller = new AbortController();
  const first = f.cli.run(['cron', 'run', '--', 'a'], 1000, { signal: controller.signal });
  controller.abort(); assert.equal((await first).ok, false);
  assert.equal((await f.cli.run(['cron', 'run', '--', 'b'])).refused, 'busy');
  assert.equal(f.children.length, 1);
  f.children[0].finish();
  const next = f.cli.run(['cron', 'run', '--', 'b']); f.children[1].finish(); assert.equal((await next).ok, true);
  const cancelled = await f.cli.run(['cron', 'run', '--', 'c'], 1000, { signal: controller.signal });
  assert.equal(cancelled.ok, false); assert.equal(cancelled.code, null); assert.equal(f.children.length, 2);
});

test('read-only and missing-agent refusals precede admission without creating children', async t => {
  const f = heldCli(t, { maxActive: 2, readonly: true });
  const read = f.cli.run(['--version']);
  assert.equal((await f.cli.run(['cron', 'run', '--', 'a'])).refused, 'readonly');
  assert.equal((await f.cli.run(['skills', 'list'])).refused, 'missing-agent');
  assert.equal(f.children.length, 1); f.children[0].finish(); await read;
});

test('runtime skill freshness uses its reserved slot and remains ingested; busy on-demand reads retain the busy category', async t => {
  const f = heldCli(t), ingested = [];
  const runtime = createRuntime({ openclawBin: '/synthetic/openclaw', openclawHome: '/synthetic/home', gatewayUrl: 'ws://127.0.0.1:1',
    identityPath: '/synthetic/missing-identity', stateDbPath: '/synthetic/missing-state', readonly: false });
  t.after(() => runtime.close());
  runtime.attach({ primaryAgent: () => ({ id: 'main' }), setReads() {}, ingest(envelope) { ingested.push(envelope); } });
  const commands = ['a', 'b', 'c'].map(id => runtime.commands.flowRun(id));
  assert.equal(f.children.length, 3);
  assert.deepEqual(await runtime.reads.skillInfo('test', { agentId: 'main' }), { ok: false, category: 'busy' });
  const freshness = runtime.refreshSkills();
  assert.equal(f.children.length, 4);
  assert.deepEqual(f.children[3].args, ['skills', 'list', '--agent', 'main', '--json']);
  f.children.forEach(child => child.finish()); await Promise.all([...commands, freshness]);
  assert.deepEqual(ingested.map(envelope => envelope.channel), ['cli.skills.list']);
});
