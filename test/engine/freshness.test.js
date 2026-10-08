'use strict';
// R1-03 / R1-05: per-channel freshness, gateway down state, and the CLI process outcome.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');

const NOW = Date.UTC(2026, 9, 5);
const env = (source, channel, body, extra) => Object.assign({ source, channel, receivedAt: NOW, body }, extra);
const tick = () => env('gateway', 'gw.event.tick', { kind: 'json', value: { ts: NOW } });
const gw = (e) => e.sources().find((s) => s.id === 'gateway');

describe('source freshness', () => {
  it('a failing channel stays stale while unrelated channels succeed around it', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(tick());
    e.ingest(env('gateway', 'gw.rpc.cron.list', { kind: 'error', message: 'timeout' }));
    for (let i = 0; i < 5; i++) { e.ingest(tick()); e.ingest(env('gateway', 'gw.rpc.sessions.list', { kind: 'json', value: { sessions: [] } })); }
    assert.equal(gw(e).state, 'stale');
    assert.equal(gw(e).lastError, 'timeout');
    assert.equal(gw(e).channels.find((c) => c.channel === 'gw.rpc.cron.list').state, 'stale');
    assert.equal(gw(e).channels.find((c) => c.channel === 'gw.event.tick').state, 'fresh');
    e.ingest(env('gateway', 'gw.rpc.cron.list', { kind: 'json', value: { jobs: [] } }));
    assert.equal(gw(e).state, 'fresh'); assert.equal(gw(e).lastError, null);
  });

  it('a closed gateway is down whatever arrived before, and recovers on reconnect', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(tick());
    e.setSourceDown('gateway', true);
    assert.equal(gw(e).state, 'down'); assert.equal(gw(e).lastError, 'not-connected');
    e.setSourceDown('gateway', false);
    assert.equal(gw(e).state, 'fresh');
  });

  it('CLI: stdout + stderr + nonzero exit is cli.failed and keeps the last good list', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(env('cli', 'cli.skills.list', { kind: 'text', value: '{"skills":[{"name":"weather"}]}' }, { outcome: { ok: true, exitCode: 0, stderr: false } }));
    const r = e.ingest(env('cli', 'cli.skills.list', { kind: 'text', value: '{"skills":[]}' }, { outcome: { ok: false, exitCode: 1, stderr: true } }));
    assert.equal(r.ok, false);
    assert.equal(e.latest('cli.skills.list').value.skills.length, 1);
    const i = e.quarantine.list().find((x) => x.code === 'cli.failed');
    assert.equal(i.severity, 'error'); assert.equal(i.path, null);   // S4.1: no sample; the category is on the source
    const cli = e.sources().find((s) => s.id === 'cli');
    assert.equal(cli.state, 'stale'); assert.equal(cli.lastError, 'exit-1');
    e.ingest(env('cli', 'cli.skills.list', { kind: 'text', value: '{"skills":[]}' }, { outcome: { ok: false, exitCode: null, stderr: false } }));
    assert.equal(e.sources().find((s) => s.id === 'cli').lastError, 'killed-or-timeout');
  });
});
