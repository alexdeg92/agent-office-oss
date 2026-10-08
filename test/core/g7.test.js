'use strict';
// G7 (ADR-001 §14): channel grammars (static) and enrichers (selected), Discord the first of each; no behaviour change.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { interlocutorIdOf, CHANNEL_GRAMMARS } = require('../../src/channels');
const { createEnrichment, ENRICHER_IDS, DEFAULT_ENRICHERS } = require('../../src/enrichers');
const { classifySession } = require('../../src/adapters/openclaw/classify/session-kind');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');

const SF = '100000000000000001';

describe('G7 · channel grammars', () => {
  it('Discord keeps its exact 2.x ids; another family gets the generic grammar; the classifier asks the registry', () => {
    assert.deepEqual(CHANNEL_GRAMMARS, ['discord']);
    assert.equal(interlocutorIdOf('discord', { kind: 'conversation-direct', scope: 'direct', peer: SF }), 'discord-user:' + SF);
    assert.equal(interlocutorIdOf('discord', { kind: 'conversation-group', scope: 'channel', peer: SF }), 'discord-channel:' + SF);
    for (const [scope, peer] of [['thread', SF], ['slash', SF], ['channel', 'not-a-snowflake']]) assert.equal(interlocutorIdOf('discord', { kind: 'conversation-group', scope, peer }), null);
    assert.equal(interlocutorIdOf('telegram', { kind: 'conversation-direct', scope: 'dm', peer: 'ana' }), 'telegram-user:ana');
    assert.equal(interlocutorIdOf('matrix', { kind: 'conversation-group', scope: 'room', peer: '!r:x' }), 'matrix-room:!r:x');
    assert.equal(interlocutorIdOf('matrix', { kind: 'conversation', scope: 'space', peer: 'x' }), null);
    assert.equal(classifySession(`agent:main:discord:channel:${SF}`).interlocutorId, 'discord-channel:' + SF);
  });
});

describe('G7 · enrichers', () => {
  const realFetch = global.fetch;
  let calls = [];
  before(() => {
    global.fetch = async (url) => {
      calls.push(String(url));
      if (/\/users\//.test(url)) return { ok: true, json: async () => ({ id: SF, username: 'guest', global_name: 'Guest', bot: false, avatar: 'abc' }) };
      if (/\/channels\//.test(url)) return { ok: true, json: async () => ({ id: SF, name: 'annonces', type: 5, topic: 'News', guild_id: '100000000000000009' }) };
      if (/\/guilds\//.test(url)) return { ok: true, json: async () => ({ name: 'Acme' }) };
      return { ok: false };
    };
  });
  after(() => { global.fetch = realFetch; });

  it('registry: Discord is registered and selected by default', () => {
    assert.deepEqual(ENRICHER_IDS, ['discord']); assert.deepEqual(DEFAULT_ENRICHERS, ['discord']);
  });

  it('Discord maps its raw profiles to InterlocutorProfile (the VM shape); no raw field leaves the enricher', async () => {
    calls = [];
    const e = createEnrichment({ ids: ['discord'], deps: { secret: (n) => (n === 'discord.token' ? 'bot-token' : null) } });
    assert.equal(e.peek('discord-user:' + SF).resolution, 'pending');
    await e.resolve('discord-user:' + SF); await e.resolve('discord-channel:' + SF);
    assert.deepEqual(e.peek('discord-user:' + SF).profile, { displayName: 'Guest', username: 'guest', avatarUrl: `https://cdn.discordapp.com/avatars/${SF}/abc.png?size=128`, isBot: false, createdAt: e.peek('discord-user:' + SF).profile.createdAt });
    assert.deepEqual(e.peek('discord-channel:' + SF).profile, { name: '#annonces', type: 'announcement', topic: 'News', guildName: 'Acme', createdAt: e.peek('discord-channel:' + SF).profile.createdAt });
    assert.equal(e.nameOf('discord-user:' + SF), 'Guest');
    assert.deepEqual(e.peek('telegram-user:ana'), { resolution: 'unresolvable', profile: null }, 'no enricher for the family');
    assert.ok(calls.length >= 3);
  });

  it('none selected: every interlocutor is unresolvable and no lookup is ever made', async () => {
    calls = [];
    const e = createEnrichment({ ids: [], deps: { secret: () => 'bot-token' } });
    assert.deepEqual(e.peek('discord-user:' + SF), { resolution: 'unresolvable', profile: null });
    assert.equal(await e.resolveAll(['discord-user:' + SF, 'discord-channel:' + SF]), false);
    await e.resolve('discord-user:' + SF);
    assert.deepEqual(calls, []);
  });

  it('selection: AO_ENRICHERS (comma list, empty = none) and the instance config; an unknown id refuses to start', () => {
    const { loadConfig } = require('../../src/config');
    const base = { PORTAL_EMAIL: 'a@example.invalid', PORTAL_SECRET: 's'.repeat(40), PORTAL_PASSWORD: 'x', AO_ENV: 'test', HOME: '/tmp', AO_DATA_DIR: '/tmp/ao-g7-unused' };
    assert.deepEqual(loadConfig(base).enrichers, ['discord']);
    assert.deepEqual(loadConfig(Object.assign({ AO_ENRICHERS: '' }, base)).enrichers, []);
    const IC = require('../../src/instance-config');
    assert.equal(IC.fileEnv({ version: 1, instance: { name: 'x', locale: 'en', timeZone: 'UTC' }, owner: { displayName: 'x', email: 'x@example.invalid' },
      runtime: { adapter: 'demo' }, enrichers: [], agents: { primary: null, looks: {} } }, null).AO_ENRICHERS, '', 'an empty list means none');
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, ['-e', "require('./src/config').loadConfig(Object.assign(" + JSON.stringify(base) + ", { AO_ENRICHERS: 'nope' }))"], { cwd: require('path').join(__dirname, '..', '..'), encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /unknown enricher "nope"/);
  });
});

describe('G7 · the server with no enricher selected', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('synthetic-basic'), { env: { AO_ENRICHERS: '' } }); });
  after(async () => { if (h) await h.stop(); });
  it('Discord interlocutors are unresolvable on v3 and pending on v2 (its 2.x meaning)', async () => {
    const v3 = (await h.get('/api/v3/views/access')).json.data.interlocutors, v2 = (await h.get('/api/v2/views/access')).json.data.interlocutors;
    assert.ok(v3.filter((i) => i.channel === 'discord').every((i) => i.resolution === 'unresolvable'));
    assert.ok(v2.length && v2.every((i) => i.resolution === 'pending'));
    assert.equal((await h.get('/api/v3/views/interlocutors/' + encodeURIComponent('discord-user:' + SF))).json.data.resolution, 'unresolvable');
  });
});
