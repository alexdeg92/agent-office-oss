'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { RESOLVE_AFTER_CLEAN } = require('../../src/engine/quarantine');
const s = require('../../src/schema');

const NOW = Date.UTC(2026, 9, 5);
const mk = (opts) => createEngine(Object.assign({ now: () => NOW }, opts));
const env = (channel, body, extra) => Object.assign({ source: channel.startsWith('cli') ? 'cli' : 'gateway', channel, receivedAt: NOW, body }, extra);
const json = (value) => ({ kind: 'json', value });
const row = (o) => Object.assign({ key: 'agent:main:main', updatedAt: NOW, totalTokens: 10 }, o);
const summary = (e) => e.quarantine.list().map((i) => `${i.severity} ${i.code} ${i.channel} ${i.path || '-'} x${i.count}`);

describe('engine: ingest + quarantine', () => {
  it('accepts a valid payload and stores it', () => {
    const e = mk();
    const r = e.ingest(env('gw.rpc.sessions.list', json({ sessions: [row()] })));
    assert.ok(r.ok); assert.deepEqual(summary(e), []);
    assert.equal(e.latest('gw.rpc.sessions.list').value.sessions.length, 1);
  });

  it('wrong type in one row: row quarantined, others admitted', () => {
    const e = mk();
    const r = e.ingest(env('gw.rpc.sessions.list', json({ sessions: [row(), row({ key: 'b', updatedAt: 'yesterday' })] })));
    assert.ok(r.ok); assert.equal(r.value.sessions.length, 1);
    assert.deepEqual(summary(e), ['error shape.invalid gw.rpc.sessions.list $.sessions[].updatedAt x1', 'warn shape.item-dropped gw.rpc.sessions.list $.sessions[] x1']);
  });

  it('missing required root field: payload rejected, last good kept, source stale', () => {
    const e = mk();
    e.ingest(env('gw.rpc.sessions.list', json({ sessions: [row()] })));
    const r = e.ingest(env('gw.rpc.sessions.list', json({ rows: [] })));
    assert.ok(!r.ok);
    assert.equal(e.latest('gw.rpc.sessions.list').value.sessions.length, 1);
    assert.equal(e.sources().find((x) => x.id === 'gateway').state, 'stale');
    assert.equal(e.sources().find((x) => x.id === 'gateway').lastError, 'payload-rejected');
    assert.ok(summary(e).includes('error shape.invalid gw.rpc.sessions.list $.sessions x1'));
  });

  it('extra field: admitted and counted as info; repeated occurrences increment count', () => {
    const e = mk();
    for (let i = 0; i < 3; i++) e.ingest(env('gw.rpc.sessions.list', json({ sessions: [row({ brandNewField: 1 })] })));
    assert.deepEqual(summary(e), ['info shape.extra-field gw.rpc.sessions.list $.sessions[].<undeclared> x3']);   // S4.1: payload keys never appear
  });

  it('CLI: text prefix ok; no JSON → parse.failed; {ok:false} → cli.not-ok; error body → cli.failed', () => {
    const e = mk();
    assert.ok(e.ingest(env('cli.skills.list', { kind: 'text', value: '🦞 banner\n{"skills":[{"name":"weather"}]}' })).ok);
    e.ingest(env('cli.skills.list', { kind: 'text', value: 'command not found' }));
    e.ingest(env('cli.skills.list', { kind: 'text', value: '{"ok":false,"error":"pass --agent"}' }));
    e.ingest(env('cli.skills.list', { kind: 'text', value: 'x {broken' }));
    e.ingest(env('cli.skills.info', { kind: 'error', message: 'timeout' }));
    assert.deepEqual(summary(e).sort(), [
      'error cli.failed cli.skills.info - x1',
      'error cli.not-ok cli.skills.list - x1',
      'error parse.failed cli.skills.list - x2',
    ]);
    assert.equal(e.quarantine.list().find((i) => i.code === 'parse.failed').count, 2);
  });

  it('RPC failure → rpc.failed, source stale', () => {
    const e = mk();
    e.ingest(env('gw.rpc.cron.list', { kind: 'error', message: 'socket closed' }));
    assert.deepEqual(summary(e), ['error rpc.failed gw.rpc.cron.list - x1']);
    assert.equal(e.sources()[0].lastError, 'connection-closed');   // a category, never the message (R1-01)
  });

  it('unobserved activity events are quarantined as event.unknown (info), value-free (S4.1: no sample at all)', () => {
    const e = mk();
    e.ingest(env('gw.event.session.tool', json({ sessionKey: 'agent:main:discord:direct:123456789012345678', tool: 'web_search', token: 'abc' })));
    const [i] = e.quarantine.list();
    assert.deepEqual(Object.keys(i).sort(), ['channel', 'code', 'count', 'fingerprint', 'firstSeenAt', 'lastSeenAt', 'path', 'severity', 'state']);
    assert.equal(i.code, 'event.unknown'); assert.equal(i.severity, 'info'); assert.equal(i.channel, 'gw.event.<unadvertised>'); assert.equal(i.path, null);
  });

  it('version.untested stays open while the version is unsupported (R1-04), beyond the clean threshold and across reconnects', () => {
    const e = mk(); e.setOpenclawVersion('2027.1.0');
    for (let i = 0; i < RESOLVE_AFTER_CLEAN + 5; i++) e.ingest(env('gw.event.tick', json({ ts: NOW })));
    assert.deepEqual(summary(e), [`warn version.untested gw.event.tick - x${RESOLVE_AFTER_CLEAN + 5}`]);
    assert.equal(e.quarantine.list()[0].state, 'open');
    e.setSourceDown('gateway', true); e.setSourceDown('gateway', false);
    for (let i = 0; i < RESOLVE_AFTER_CLEAN; i++) e.ingest(env('gw.event.tick', json({ ts: NOW })));
    assert.equal(e.quarantine.list()[0].state, 'open');
    assert.equal(e.dataQuality().open.warn, 1);
    // support arrives (version now tested): the next clean envelopes resolve it
    e.setOpenclawVersion('2026.9.8');
    for (let i = 0; i < RESOLVE_AFTER_CLEAN; i++) e.ingest(env('gw.event.tick', json({ ts: NOW })));
    assert.equal(e.quarantine.list()[0].state, 'resolved');
  });

  it(`auto-resolves a channel's issues after ${RESOLVE_AFTER_CLEAN} clean envelopes, reopens on recurrence`, () => {
    const e = mk();
    e.ingest(env('gw.event.tick', json({ ts: 'x' })));
    for (let i = 0; i < RESOLVE_AFTER_CLEAN; i++) e.ingest(env('gw.event.tick', json({ ts: NOW })));
    assert.equal(e.quarantine.list()[0].state, 'resolved');
    assert.deepEqual(e.quarantine.counts().open, { error: 0, warn: 0, info: 0 });
    e.ingest(env('gw.event.tick', json({ ts: 'x' })));
    assert.equal(e.quarantine.list()[0].state, 'open'); assert.equal(e.quarantine.list()[0].count, 2);
  });

  it('caps distinct fingerprints (overflow row instead of unbounded growth)', () => {
    const { createQuarantine } = require('../../src/engine/quarantine');
    const names = Array.from({ length: 520 }, (_, i) => 'f' + i);
    const q = createQuarantine({ now: () => NOW, vocab: { declared: new Set(names), channels: new Set(['c']) } });
    for (const n of names) q.record({ channel: 'c', code: 'shape.invalid', severity: 'error', path: '$.' + n });
    const e = { quarantine: q };
    assert.equal(e.quarantine.counts().total, 501);
    assert.ok(e.quarantine.list().some((i) => i.code === 'quarantine.overflow' && i.count === 20));
  });

  it('samples and details are redacted', () => {
    const e = mk();
    e.ingest(env('cli.skills.list', { kind: 'text', value: 'Error for owner@example.invalid at /home/example/x, id 123456789012345678, Bot MTAxMjM0NTY3ODkw.abc' }));
    const t = JSON.stringify(e.quarantine.list());
    for (const leak of ['owner@example.invalid', '/home/example/', '123456789012345678', 'MTAxMjM0']) assert.ok(!t.includes(leak), leak);
  });
});
