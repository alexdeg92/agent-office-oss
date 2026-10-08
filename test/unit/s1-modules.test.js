'use strict';
// S1 module tests for behaviour the characterisation goldens can't reach.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const { createCli } = require('../../src/adapters/openclaw/cli');
const { createDiscord, mapChan } = require('../../src/enrichers/discord');

const BIN = path.resolve(__dirname, '..', 'bin', 'openclaw');

describe('cli wrapper', () => {
  let tmp, log;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cli-')); log = path.join(tmp, 'cli.jsonl'); process.env.FAKE_OC_LOG = log; process.env.FAKE_OC_SCENARIO = 'synthetic-basic'; });
  after(() => { delete process.env.FAKE_OC_LOG; delete process.env.FAKE_OC_SCENARIO; fs.rmSync(tmp, { recursive: true, force: true }); });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv) : []);

  it('read-only: refuses every mutating command without running the CLI, allows reads', async () => {
    const cli = createCli({ bin: BIN, home: tmp, readonly: true });
    for (const args of [['cron', 'run', 'x'], ['cron', 'add'], ['config', 'set', 'a', 'b'], ['agent', '-m', 'hi'], ['gateway', 'restart']]) {
      const r = await cli.run(args);
      assert.equal(r.ok, false); assert.equal(r.refused, 'readonly'); assert.equal(r.err, 'Instance de test : actions désactivées.');
    }
    assert.deepEqual(calls(), []);
    const list = await cli.run(['skills', 'list', '--agent', 'main', '--json']);
    assert.equal(list.ok, true); assert.ok(cli.parseJson(list.out).skills.length > 0);
  });

  it('refuses per-agent commands without --agent (the empty-Compétences gotcha)', async () => {
    const cli = createCli({ bin: BIN, home: tmp, readonly: false });
    const r = await cli.run(['skills', 'list', '--json']);
    assert.equal(r.refused, 'missing-agent');
  });

  it('parseJson reads from the first {', () => {
    const cli = createCli({ bin: BIN, home: tmp, readonly: false });
    assert.deepEqual(cli.parseJson('🦞 banner\n{"a":1}'), { a: 1 });
    assert.equal(cli.parseJson('no json'), null);
    assert.equal(cli.parseJson('{broken'), null);
  });
});

describe('discord source (fetch mocked)', () => {
  const realFetch = global.fetch;
  let urls;
  before(() => {
    urls = [];
    global.fetch = async (url, opts) => {
      urls.push(url); assert.match(opts.headers.Authorization, /^Bot test-token$/);
      const id = url.split('/').pop();
      if (url.includes('/users/')) return { ok: true, json: async () => ({ id, username: 'guest', global_name: 'Guest', avatar: 'abc' }) };
      if (url.includes('/channels/')) return { ok: true, json: async () => ({ id, name: 'general', type: 0, guild_id: '100000000000000009' }) };
      if (url.includes('/guilds/')) return { ok: true, json: async () => ({ name: 'Serveur' }) };
      return { ok: false };
    };
  });
  after(() => { global.fetch = realFetch; });

  it('resolves users and channels once, caches them, and exposes display names', async () => {
    const d = createDiscord({ getToken: () => 'test-token' });
    assert.equal(await d.resolveAll(new Set(['100000000000000001']), new Set(['100000000000000002'])), true);
    assert.equal(d.userName('100000000000000001'), 'Guest');
    assert.equal(d.channelName('100000000000000002'), '#general');
    assert.equal(d.guildName('100000000000000009'), 'Serveur');
    const n = urls.length;
    await d.resolveAll(new Set(['100000000000000001']), new Set(['100000000000000002']));
    assert.equal(urls.length, n, 'cached');
    assert.equal((await d.userProfile('100000000000000001')).display, 'Guest');
  });

  it('does nothing without a token', async () => {
    const d = createDiscord({ getToken: () => null });
    assert.equal(await d.resolveAll(new Set(['1']), new Set()), false);
    assert.deepEqual(await d.userProfile('100000000000000003'), { id: '100000000000000003' });
  });

  it('maps channel types to French labels', () => { assert.equal(mapChan({ id: '1', type: 15 }).typeLabel, 'Forum'); });
});
