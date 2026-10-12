'use strict';
/*
 * R1-01: data quality (the v2/v3 health view since S16; /api/data-quality before) is default-deny. Seeded with credentials, names, money, emails, snowflakes,
 * composite session keys and free text through EVERY engine input path, the ENTIRE serialised
 * response must contain none of them. Assertions are on fixed needles, independent of the redactor.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { loadScenario } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');

const SF = '123456789012345678';
const SECRET_TEXT = `PORTAL_PASSWORD=rosebud; customer Alice owes $90.35 (alice.martin@example.invalid, ${SF})`;
const NEEDLES = ['rosebud', 'PORTAL_PASSWORD', 'Alice', 'alice', 'owes', '90.35', 'client.ca', 'martin', SF, 'confidential', 'Merger', 'hunter2', 'Bob Tremblay', '2027.1.0-private'];
const leaks = (text) => NEEDLES.filter((n) => text.includes(n));
const NOW = Date.UTC(2026, 9, 5);
const env = (source, channel, body, extra) => Object.assign({ source, channel, receivedAt: NOW, body }, extra);

describe('data-quality privacy · engine (every input path)', () => {
  it('nothing seeded reaches dataQuality()', () => {
    const e = createEngine({ now: () => NOW });
    e.setOpenclawVersion('2027.1.0-private');
    // transport/process failures with secret-bearing messages
    e.ingest(env('gateway', 'gw.rpc.cron.list', { kind: 'error', message: SECRET_TEXT }));
    e.ingest(env('cli', 'cli.skills.list', { kind: 'text', value: SECRET_TEXT }));                                   // parse.failed
    e.ingest(env('cli', 'cli.skills.list', { kind: 'text', value: SECRET_TEXT + ' {broken' }));                      // invalid JSON
    e.ingest(env('cli', 'cli.skills.list', { kind: 'text', value: JSON.stringify({ ok: false, error: SECRET_TEXT }) })); // cli.not-ok
    e.ingest(env('cli', 'cli.skills.info', { kind: 'text', value: '{"name":"x"}' }, { outcome: { ok: false, exitCode: 1, stderr: true } }));
    // shapes: wrong types, extra fields named like values, composite map keys, free-text values
    e.ingest(env('gateway', 'gw.rpc.agents.list', { kind: 'json', value: { agents: [{ id: 'main', [`agent:main:discord:direct:${SF}`]: SECRET_TEXT, 'Alice confidential note': 'Merger', 'hunter2 pwd': { 'Bob Tremblay': 1 }, notes: 'rosebud' }] } }));
    e.ingest(env('gateway', 'gw.rpc.sessions.list', { kind: 'json', value: { sessions: [
      { key: `alice:private:${SF}`, updatedAt: 'Alice owes 90.35' },
      { key: `agent:main:discord:direct:${SF}`, status: 'rosebud' },
      { key: 'agent:Alice:confidential' },              // T-0058: an operator-named session now (explicit), still a leak seed
      { key: 'agent:Alice:confidential:rosebud' },      // no rule matches: session.unclassified, and its key must not leak
    ] } }));
    e.ingest(env('gateway', 'gw.event.health', { kind: 'json', value: { ok: SECRET_TEXT, [`${SF}`]: 'x' } }));
    // unknown events: payload with secret-shaped keys and values; event names themselves seeded
    e.ingest(env('gateway', 'gw.event.session.tool', { kind: 'json', value: { [`agent:main:discord:direct:${SF}`]: SECRET_TEXT, text: SECRET_TEXT, 'Alice M.': 1 } }));
    e.ingest(env('gateway', `gw.event.Alice owes ${SF}`, { kind: 'json', value: {} }));
    e.ingest(env('gateway', 'gw.event.Rosebud.hunter2 90', { kind: 'json', value: {} }));

    const text = JSON.stringify(e.dataQuality());
    assert.deepEqual(leaks(text), [], text.slice(0, 2000));
    // S4.1 (PM, on review-06): issue records carry only these fields
    for (const i of e.dataQuality().issues) assert.deepEqual(Object.keys(i).sort(), ['channel', 'code', 'count', 'fingerprint', 'firstSeenAt', 'lastSeenAt', 'path', 'severity', 'state']);
    const codes = new Set(e.dataQuality().issues.map((i) => i.code));
    for (const c of ['rpc.failed', 'parse.failed', 'cli.not-ok', 'cli.failed', 'shape.invalid', 'shape.extra-field', 'session.unclassified', 'enum.unmapped', 'event.unknown', 'version.untested']) assert.ok(codes.has(c), c);
  });

  // PM decision on review-06 (S4.1): "no values, ever; paths come from schemas". Pinned exactly.
  it('rule, pinned: payload keys never appear (even identifier-shaped ones); only advertised event names; paths are schema paths', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(env('gateway', 'gw.hello', { kind: 'json', value: { protocol: 4, server: { version: '2026.9.8' }, features: { methods: [], events: ['session.tool'] } } }));
    e.ingest(env('gateway', 'gw.rpc.agents.list', { kind: 'json', value: { agents: [{ id: 'main', brandnewfield: 'rosebud', 'Hunter2': 'Alice', 'two words': 1 }] } }));
    e.ingest(env('gateway', 'gw.event.rosebud-hunter2', { kind: 'json', value: { a: 'Alice' } }));
    e.ingest(env('gateway', 'gw.event.session.tool', { kind: 'json', value: { sessionKey: 'k' } }));
    const text = JSON.stringify(e.dataQuality());
    for (const n of ['brandnewfield', 'Hunter2', 'two words', 'rosebud', 'Alice']) assert.ok(!text.includes(n), n);
    assert.ok(text.includes('$.agents[].<undeclared>'));
    assert.ok(text.includes('gw.event.session.tool'), 'advertised event name shown');
    assert.ok(text.includes('gw.event.<unadvertised>'));
  });

  // R6-01: a record key that happens to spell a declared field name ('name') must not surface.
  it('R6-01: record keys never appear, even when they collide with declared names', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(env('gateway', 'gw.rpc.channels.status', { kind: 'json', value: { channels: { name: 'bad-record-value', 'Private workspace': { configured: 'x' } } } }));
    const issues = e.dataQuality().issues;
    assert.ok(issues.length > 0);
    for (const i of issues) assert.ok(i.path === null || !/\.name\b|Private|bad-record/.test(i.path), i.path);
    assert.ok(issues.some((i) => /\{\}/.test(i.path || '')), 'record entries are {}');
    assert.ok(!JSON.stringify(issues).includes('bad-record-value'));
  });
});

const dq = async (h) => (await h.get('/api/v2/views/health')).json.data.dataQuality;

describe('data-quality privacy · server (entire v2 and v3 health responses)', () => {
  let h;
  before(async () => {
    h = await startServer(loadScenario('synthetic-basic'), { handlers: {
      'channels.status': () => { throw new Error(SECRET_TEXT); },
    } });
  });
  after(async () => { if (h) await h.stop(); });

  it('seeded gateway errors and events never appear in the response', async () => {
    h.gw.emit('session.message', { [`agent:main:discord:direct:${SF}`]: SECRET_TEXT, sessionKey: `agent:main:discord:direct:${SF}`, text: SECRET_TEXT });
    h.gw.emit(`Alice ${SF}`, { note: SECRET_TEXT });
    await waitFor(async () => (await dq(h)).issues.some((i) => i.code === 'rpc.failed'), { what: 'rpc.failed recorded' });
    await waitFor(async () => (await dq(h)).issues.some((i) => i.code === 'event.unknown'), { what: 'events recorded' });
    for (const v of ['v2', 'v3']) { const x = await h.get(`/api/${v}/views/health`); assert.deepEqual(leaks(x.text), [], v + ' ' + x.text.slice(0, 2000)); }
    const r = await h.get('/api/v3/views/health');
    const gwSrc = r.json.data.sources.find((s) => s.id === 'gateway');
    assert.equal(gwSrc.state, 'stale'); assert.equal(gwSrc.lastError, 'error');
    assert.deepEqual(gwSrc.channels.find((c) => c.channel === 'gw.rpc.channels.status').state, 'stale');
  });
});

describe('data-quality privacy · R5 reviewer seeds (PM rule)', () => {
  it('gw.event.privateclient with {privateclient:42}, a privateclient map key and private enum values never surface', () => {
    const e = createEngine({ now: () => NOW });
    e.ingest(env('gateway', 'gw.event.privateclient', { kind: 'json', value: { privateclient: 42 } }));
    e.ingest(env('gateway', 'gw.rpc.channels.status', { kind: 'json', value: { channels: { privateclient: { configured: 'yes' } } } }));
    e.ingest(env('gateway', 'gw.rpc.sessions.list', { kind: 'json', value: { sessions: [{ key: 'agent:main:main', status: 'private-client', model: 42 }] } }));
    e.ingest(env('gateway', 'gw.rpc.cron.list', { kind: 'json', value: { jobs: [{ id: 'j', name: 'n', enabled: true, schedule: { kind: 'alice-private-model' } }] } }));
    const text = JSON.stringify(e.dataQuality());
    for (const needle of ['privateclient', 'private-client', 'alice-private-model']) assert.ok(!text.includes(needle), needle + ' in ' + text.slice(0, 600));
  });
});

describe('data-quality privacy · central enforcement (R2-01)', () => {
  it('quarantine.record() sanitises whatever a caller passes, including classification issues', () => {
    const { createQuarantine } = require('../../src/engine/quarantine');
    const q = createQuarantine({ now: () => NOW });
    q.record({ source: 'gateway', channel: 'gw.rpc.sessions.list', code: 'session.unclassified', severity: 'warn',
      path: `alice:private:${SF}`, detail: SECRET_TEXT, sample: { status: 'rosebud', [`agent:main:discord:direct:${SF}`]: SECRET_TEXT, n: 'Alice' }, openclawVersion: '2027.1.0-private', schema: { id: 'x', version: 1 } });
    q.record({ source: SECRET_TEXT, channel: SECRET_TEXT, code: SECRET_TEXT, severity: SECRET_TEXT, path: '$.Alice owes.' + SF, detail: 'x', sample: SECRET_TEXT });
    const text = JSON.stringify(q.list());
    assert.deepEqual(leaks(text), [], text);
    assert.equal(q.list().find((i) => i.code === 'session.unclassified').path, null, 'not a schema path → dropped');
  });

  it('R6-04, the exact R5 direct-gate case: detail and scalar sample values are dropped', () => {
    const { createQuarantine } = require('../../src/engine/quarantine');
    const q = createQuarantine({ now: () => NOW, vocab: { channels: new Set(['gw.rpc.cron.list']) } });
    q.record({ source: 'gateway', channel: 'gw.rpc.cron.list', code: 'shape.invalid', severity: 'error', path: '$', detail: 'rosebud', sample: { accountNumber: 12345678, enabled: true } });
    const text = JSON.stringify(q.list());
    for (const n of ['rosebud', '12345678', 'accountNumber', 'true', 'gateway']) assert.ok(!text.includes(n), n);
  });
});

describe('data-quality privacy · R5 reviewer seeds, server (entire serialised responses)', () => {
  let h;
  before(async () => {
    h = await startServer(loadScenario('synthetic-basic'), { handlers: {
      'sessions.list': () => ({ sessions: [{ key: 'agent:main:main', status: 'private-client', model: 42 }] }),
      'cron.list': () => ({ jobs: [{ id: 'j', name: 'n', enabled: true, schedule: { kind: 'alice-private-model' } }] }),
      'channels.status': () => ({ channels: { privateclient: { configured: 'yes' }, name: 'bad-record-value' } }),   // + R6-01: a record key spelling a declared name
    } });
  });
  after(async () => { if (h) await h.stop(); });

  it('none of the seeds appear in the v2 or v3 health view', async () => {
    h.gw.emit('privateclient', { privateclient: 42 });
    await waitFor(async () => (await dq(h)).issues.some((i) => i.code === 'event.unknown'), { what: 'event recorded' });
    await waitFor(async () => (await dq(h)).issues.some((i) => i.code === 'enum.unmapped' || i.code === 'shape.invalid'), { what: 'shape issues recorded' });
    for (const route of ['/api/v2/views/health', '/api/v3/views/health']) {
      const r = await h.get(route); assert.equal(r.status, 200, route); const text = r.text;
      for (const needle of ['privateclient', 'private-client', 'alice-private-model', 'bad-record-value', '"name"']) assert.ok(!text.includes(needle), `${needle} in ${route}: ${text.slice(0, 600)}`);
    }
  });
});

// R8-02 (PM decision on review-08): an event name the gateway ADVERTISES in hello is protocol vocabulary and may
// appear in a diagnostics channel, only if it matches ^[a-z][a-z0-9._-]{0,63}$. Anything else, and every
// non-advertised name, stays <unadvertised>. Pinned on the full HTTP response.
describe('data-quality privacy · R8-02 advertised event names (PM rule)', () => {
  let h;
  const long = 'a' + 'b'.repeat(64);
  before(async () => {
    const sc = loadScenario('synthetic-basic');
    h = await startServer(sc, { hello: { features: { methods: [], events: ['privateclient', 'Private.Client', long, 'tick'] } } });
  });
  after(async () => { if (h) await h.stop(); });

  it('advertised + well-formed → shown; advertised but malformed, or not advertised → <unadvertised>', async () => {
    for (const ev of ['privateclient', 'Private.Client', long, 'neveradvertised']) h.gw.emit(ev, { a: 'Alice' });
    await waitFor(async () => (await dq(h)).issues.filter((i) => i.code === 'event.unknown').length >= 2, { what: 'events recorded' });
    const r = await h.get('/api/v2/views/health');
    const channels = r.json.data.dataQuality.issues.filter((i) => i.code === 'event.unknown').map((i) => i.channel).sort();
    assert.deepEqual(channels, ['gw.event.<unadvertised>', 'gw.event.privateclient']);
    for (const n of ['Private.Client', long, 'neveradvertised', 'Alice']) assert.ok(!r.text.includes(n), n);
  });
});
