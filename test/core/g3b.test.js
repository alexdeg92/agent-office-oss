'use strict';
// G3b (ADR-001 §12.3, §4.3): no personal defaults in the canonical model.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { buildFlowDetailVM } = require('../../src/api/v2/vm/flows');

const NOW = Date.UTC(2026, 9, 6, 12);
const job = (o) => Object.assign({ id: 'j1', name: 'Veille', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * 1' },
  payload: { kind: 'agentTurn', message: 'x' } }, o);

describe('G3b · a flow without an agent runs on the runtime default, never a guessed "main"', () => {
  it('canonical agentId is null (the primary); FlowDetailVM names the resolver primary', () => {
    const engine = createEngine({ now: () => NOW });
    engine.ingest({ source: 'gateway', channel: 'gw.rpc.agents.list', receivedAt: NOW, body: { kind: 'json', value: { defaultId: 'atlas', agents: [{ id: 'atlas', name: 'Atlas' }] } } });
    engine.ingest({ source: 'gateway', channel: 'gw.rpc.cron.list', receivedAt: NOW, body: { kind: 'json', value: { jobs: [job({}), job({ id: 'j2', agentId: 'scribe' })] } } });
    const [a, b] = engine.cronJobs();
    assert.equal(a.agentId, null, 'no agent in the job → null, not "main"');
    assert.equal(b.agentId, 'scribe');
    assert.equal(buildFlowDetailVM(a, null, 'atlas').job.agentId, 'atlas');
    assert.equal(buildFlowDetailVM(b, null, 'atlas').job.agentId, 'scribe');
  });
});

describe('G3b · the UI locale falls back to the instance locale, not to French', () => {
  const { resolveLocale } = require('../../src/i18n');
  it('pref → Accept-Language → the instance locale (AO_LOCALE) → fr', () => {
    assert.equal(resolveLocale({ pref: null, acceptLanguage: '*', instance: 'en-GB' }), 'en');
    assert.equal(resolveLocale({ pref: null, acceptLanguage: null, instance: 'en' }), 'en');
    assert.equal(resolveLocale({ pref: null, acceptLanguage: 'fr-CA,fr;q=0.9', instance: 'en' }), 'fr', 'the browser outranks the instance default');
    assert.equal(resolveLocale({ pref: 'fr', acceptLanguage: 'en', instance: 'en' }), 'fr', 'the saved preference outranks both');
    assert.equal(resolveLocale({ pref: null, acceptLanguage: null, instance: 'de-DE' }), 'fr', 'an unsupported instance locale → fr');
  });
});

describe('G3b · conversations on any channel get a usable title (never an empty id)', () => {
  const { sessionTitle } = require('../../src/api/v2/vm/logs');
  const s = (kind, interlocutorId) => ({ key: 'k', displayName: null, class: { kind, heartbeatOf: null, interlocutorId } });
  it('Discord keeps its 6-digit tail; other families show their opaque id (at most 24 chars)', () => {
    assert.deepEqual(sessionTitle(s('conversation-direct', 'discord-user:100000000000000001')), { key: 'sessionTitle.user', params: { id: '000001' } });
    assert.deepEqual(sessionTitle(s('conversation-direct', 'telegram-user:foreign-user')), { key: 'sessionTitle.user', params: { id: 'foreign-user' } });
    assert.deepEqual(sessionTitle(s('conversation-group', 'slack-room:C0ACME')), { key: 'sessionTitle.channel', params: { id: 'C0ACME' } });
    assert.equal(sessionTitle(s('conversation-group', 'matrix-room:!' + 'x'.repeat(40) + ':example.org')).params.id.length, 24);
  });
});
