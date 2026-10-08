// stream.js against a fake EventSource and node:test's mocked timers (R4-18): scheduled reconnects really run.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createStream, BACKOFF_MS, TOPIC_RETRY_MS } from '../../public/v2/stream.js';

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_791_223_200_000 }));
afterEach(() => mock.timers.reset());

function harness(opts = {}) {
  const sources = [];
  const posts = [];
  const resyncs = [];
  const fetches = [];
  const reloads = [];
  let unauthorized = 0;
  class FakeSource {
    constructor(url) { this.url = url; this.readyState = 0; this.l = {}; sources.push(this); }
    addEventListener(t, fn) { (this.l[t] ||= []).push(fn); }
    close() { this.readyState = 2; }
    emit(type, frame) { for (const fn of this.l[type] || []) fn({ data: JSON.stringify({ type, ...frame }) }); }
    raw(type, data) { for (const fn of this.l[type] || []) fn({ data }); }
    fail(readyState) { this.readyState = readyState; for (const fn of this.l.error || []) fn({}); }
  }
  const state = { postFails: opts.postFails || 0, auth: opts.auth || 'ok', getRev: opts.getRev ?? null };
  const stream = createStream({
    openSource: (url) => new FakeSource(url),
    fetchVM: async (url) => { fetches.push(url); return { data: { from: 'get', url }, topic: state.getRev == null ? null : { id: opts.topicOf ? opts.topicOf(url) : 'health', rev: state.getRev }, meta: opts.meta }; },
    postTopics: async (id, body) => {
      posts.push({ id, body });
      if (state.postFails > 0) { state.postFails--; throw new Error('503'); }
      return null;
    },
    postResync: async (id, topic) => { resyncs.push({ id, topic }); },
    checkAuth: opts.checkAuth || (async () => state.auth),
    onUnauthorized: () => { unauthorized++; },
    onReload: (why) => reloads.push(why),
    onBuild: opts.onBuild,
    modelVersion: 1,
    contractVersion: '2.0',
    timers: globalThis,
    random: opts.random ?? (() => 0.5),   // no jitter unless a test asks for it
    network: opts.network ?? null,
  });
  const hello = (src, extra = {}) => src.emit('hello', { streamId: 'str_1', serverEpoch: 'ep1', modelVersion: 1, contractVersion: '2.0', resumed: false, topics: [], ...extra });
  return { stream, sources, posts, resyncs, fetches, reloads, state, hello, unauthorized: () => unauthorized };
}

test('a GET result counts as meta.topic.rev; a matching delta then applies', async () => {
  const h = harness({ getRev: 41 });
  let last;
  h.stream.subscribe('health', '/api/v2/views/health', (v) => (last = v));
  h.stream.start();
  await flush();
  assert.equal(last.rev, 41);
  h.hello(h.sources[0], { topics: ['health'], resumed: true });
  h.sources[0].emit('delta', { topic: 'health', rev: 42, baseRev: 41, ops: [{ op: 'set', path: ['level'], value: 'warn' }] });
  assert.equal(last.rev, 42);
  assert.equal(last.data.level, 'warn');
});

test('a GET for another topic id does not count (topic identity, §4.1)', async () => {
  const h = harness({ getRev: 9, topicOf: () => 'projects' });
  let last;
  h.stream.subscribe('projects?filter=at-risk', '/api/v2/views/projects?filter=at-risk', (v) => (last = v));
  await flush();
  assert.equal(last.rev, null);
});

test('snapshot then deltas; a gap asks the stream for a snapshot (POST resync), not a GET', async () => {
  const h = harness();
  let last;
  h.stream.subscribe('health', '/h', (v) => (last = v));
  h.stream.start();
  await flush();
  const s = h.sources[0];
  assert.equal(s.url, '/api/v2/stream?topics=health');
  h.hello(s, { topics: ['health'] });
  s.emit('snapshot', { topic: 'health', rev: 31, data: { level: 'ok' } });
  s.emit('delta', { topic: 'health', rev: 33, baseRev: 32, ops: [] });
  await flush();
  assert.deepEqual(h.resyncs, [{ id: 'str_1', topic: 'health' }]);
  assert.equal(h.fetches.length, 1, 'only the initial GET');
  assert.equal(last.rev, null);
  assert.equal(last.resyncing, true);
  s.emit('snapshot', { topic: 'health', rev: 33, data: { level: 'alert' } });
  assert.equal(last.rev, 33);
  assert.equal(last.resyncing, false);
});

test('R4-17: malformed frames never throw; a malformed delta resyncs', async () => {
  const h = harness();
  h.stream.subscribe('health', '/h', () => {});
  h.stream.start();
  const s = h.sources[0];
  h.hello(s, { topics: ['health'] });
  s.emit('snapshot', { topic: 'health', rev: 1, data: {} });
  assert.doesNotThrow(() => s.raw('delta', 'null'));
  assert.doesNotThrow(() => s.raw('delta', '[1,2]'));
  assert.doesNotThrow(() => s.raw('delta', '{not json'));
  s.emit('delta', { topic: 'health', rev: 9, baseRev: 1, ops: [] });
  await flush();
  assert.deepEqual(h.resyncs.map((r) => r.topic), ['health']);
});

test('R4-09: a failed topic change is surfaced and retried until the server confirms it', async () => {
  const h = harness({ postFails: 2 });
  h.stream.start();
  h.hello(h.sources[0], { topics: [] });
  h.stream.subscribe('logs', '/l', () => {});
  await flush();
  assert.deepEqual(h.posts.map((p) => p.body), [{ add: ['logs'] }]);
  assert.equal(h.stream.status.get().topicsOk, false, 'the failure is visible (live pill)');
  mock.timers.tick(TOPIC_RETRY_MS[0]);
  await flush();
  assert.equal(h.posts.length, 2);
  assert.equal(h.stream.status.get().topicsOk, false);
  mock.timers.tick(TOPIC_RETRY_MS[1]);
  await flush();
  assert.equal(h.posts.length, 3);
  assert.equal(h.stream.status.get().topicsOk, true);
  assert.ok(h.stream._serverTopics().has('logs'));
});

test('R4-09: removals are reconciled too, and a topic dropped while a POST is in flight is removed after it', async () => {
  const h = harness();
  const off = h.stream.subscribe('health', '/h', () => {});
  h.stream.start();
  h.hello(h.sources[0], { topics: ['health'] });
  await flush();
  assert.equal(h.posts.length, 0, 'already on the server');
  const offLogs = h.stream.subscribe('logs', '/l', () => {});
  offLogs();
  off();
  await flush();
  await flush();
  assert.deepEqual(h.posts.map((p) => p.body), [{ add: ['logs'] }, { remove: ['health', 'logs'] }]);
  assert.equal(h.stream._serverTopics().size, 0);
});

test('hello: the server topic list is authoritative (resume restores its own topics)', async () => {
  const h = harness();
  h.stream.subscribe('projects', '/p', () => {});
  h.stream.start();
  h.hello(h.sources[0], { resumed: true, topics: ['health'] });
  await flush();
  assert.deepEqual(h.posts.map((p) => p.body), [{ add: ['projects'], remove: ['health'] }]);
});

test('a CLOSED stream with a valid session reopens after the backoff (timers really run)', async () => {
  const h = harness({ auth: 'ok' });
  h.stream.subscribe('health', '/h', () => {});
  h.stream.start();
  h.hello(h.sources[0], { topics: ['health'] });
  h.sources[0].fail(2);
  await flush();
  assert.equal(h.stream.status.get().conn, 'retrying');
  assert.equal(h.sources.length, 1);
  mock.timers.tick(BACKOFF_MS[0] - 1);
  assert.equal(h.sources.length, 1);
  mock.timers.tick(1);
  assert.equal(h.sources.length, 2, 'reopened after 1 s');
  assert.equal(h.sources[1].url, '/api/v2/stream?topics=health');
  h.sources[1].fail(2);
  await flush();
  mock.timers.tick(BACKOFF_MS[1]);
  assert.equal(h.sources.length, 3, 'second attempt after 2 s');
});

test('R4-10: an SSE failure with an expired session goes to login and stops retrying', async () => {
  const h = harness({ auth: 'unauthorized' });
  h.stream.start();
  h.hello(h.sources[0], { topics: [] });
  h.sources[0].fail(2);
  await flush();
  assert.equal(h.unauthorized(), 1);
  assert.equal(h.stream.status.get().conn, 'idle');
  mock.timers.tick(120_000);
  assert.equal(h.sources.length, 1, 'no reconnect loop');
});

test('R4-10: the browser’s own retries (CONNECTING) also recheck the session, at most every 5 s', async () => {
  const h = harness({ auth: 'ok' });
  h.stream.start();
  const src = h.sources[0];
  src.fail(0);
  await flush();
  src.fail(0);
  await flush();
  assert.equal(h.sources.length, 1, 'CONNECTING: the browser retries by itself');
  assert.equal(h.unauthorized(), 0);
  h.state.auth = 'unauthorized';
  src.fail(0);
  await flush();
  assert.equal(h.unauthorized(), 0, 'checked at most every 5 s');
  mock.timers.tick(5000);
  src.fail(0);
  await flush();
  assert.equal(h.unauthorized(), 1);
});

test('the watchdog reopens a silent stream; a new serverEpoch drops revisions', async () => {
  const h = harness();
  let last;
  h.stream.subscribe('health', '/h', (v) => (last = v));
  h.stream.start();
  h.hello(h.sources[0], { topics: ['health'] });
  h.sources[0].emit('snapshot', { topic: 'health', rev: 5, data: { a: 1 } });
  mock.timers.tick(60_000);
  assert.equal(h.sources.length, 2, 'two missed heartbeats → reconnect');
  h.hello(h.sources[1], { streamId: 'str_2', serverEpoch: 'ep2', topics: ['health'] });
  assert.equal(last.rev, null);
  assert.deepEqual(last.data, { a: 1 }, 'keeps showing data until the snapshot');
});

test('a different model or contract version reloads the page', () => {
  const h = harness();
  h.stream.start();
  h.hello(h.sources[0], { contractVersion: '3.0' });
  assert.deepEqual(h.reloads, ['contract-version']);
  h.sources[0].emit('system', { gateway: 'down', capabilities: { openclawWrites: false, storeWrites: true }, reload: 'model-version' });
  assert.deepEqual(h.reloads, ['contract-version', 'model-version']);
  assert.equal(h.stream.status.get().gateway, 'down');
  assert.deepEqual(h.stream.status.get().capabilities, { openclawWrites: false, storeWrites: true });
});

test('applyVM shows an authoritative VM without touching the revision', async () => {
  const h = harness();
  let last;
  h.stream.subscribe('project:prj_a', '/p', (v) => (last = v));
  h.stream.start();
  h.hello(h.sources[0], { topics: ['project:prj_a'] });
  h.sources[0].emit('snapshot', { topic: 'project:prj_a', rev: 7, data: { revision: 3 } });
  h.stream.applyVM('project:prj_a', { revision: 4 });
  assert.equal(last.rev, 7);
  assert.equal(last.data.revision, 4);
});

// R7-06 (review-07): a POST still outstanding from an older stream must not block reconciling the new one.
function heldHarness() {
  const sources = [];
  const posts = [];
  class FakeSource {
    constructor(url) { this.url = url; this.readyState = 0; this.l = {}; sources.push(this); }
    addEventListener(t, fn) { (this.l[t] ||= []).push(fn); }
    close() { this.readyState = 2; }
    emit(type, frame) { for (const fn of this.l[type] || []) fn({ data: JSON.stringify({ type, ...frame }) }); }
  }
  const stream = createStream({
    openSource: (url) => new FakeSource(url),
    fetchVM: async () => ({ data: {}, topic: null }),
    // Each POST is held until the test settles it.
    postTopics: (id, body) => new Promise((resolve, reject) => posts.push({ id, body, resolve, reject })),
    postResync: async () => {},
    checkAuth: async () => 'ok',
    modelVersion: 1, contractVersion: '2.0', timers: globalThis,
  });
  const hello = (src, id, topics) => src.emit('hello', { streamId: id, serverEpoch: 'ep1', modelVersion: 1, contractVersion: '2.0', resumed: false, topics });
  return { stream, sources, posts, hello };
}

for (const outcome of ['succeeds', 'fails']) {
  test(`R7-06: an old stream's held POST ${outcome} after a reconnect; the new stream still gets the page's topics`, async () => {
    const h = heldHarness();
    h.stream.subscribe('health', '/h', () => {});
    h.stream.start();
    h.hello(h.sources[0], 'str_1', ['health']);
    h.stream.subscribe('logs', '/l', () => {});
    await flush();
    assert.deepEqual(h.posts.map((p) => [p.id, p.body]), [['str_1', { add: ['logs'] }]], 'stream 1: add logs (held)');
    h.stream.reconnect();                                   // new stream; its URL carries health and logs
    assert.equal(h.sources[1].url, '/api/v2/stream?topics=health,logs');
    h.stream.subscribe('projects', '/p', () => {});         // the page changes before the new hello
    h.hello(h.sources[1], 'str_2', ['health', 'logs']);
    await flush();
    const forNew = h.posts.filter((p) => p.id === 'str_2');
    assert.deepEqual(forNew.map((p) => p.body), [{ add: ['projects'] }], 'the new stream reconciles at once, not after the old POST');
    if (outcome === 'succeeds') h.posts[0].resolve(['health', 'logs']); else h.posts[0].reject(new Error('503'));
    await flush();
    forNew[0].resolve(['health', 'logs', 'projects']);
    await flush();
    assert.deepEqual([...h.stream._serverTopics()].sort(), ['health', 'logs', 'projects']);
    assert.equal(h.stream.status.get().topicsOk, true, 'the stale completion does not change the current status');
    mock.timers.tick(60_000);
    assert.equal(h.posts.filter((p) => p.id === 'str_1').length, 1, 'no retry is scheduled for the old stream');
  });
}

test('the envelope meta (generatedAt, stale) reaches the topic view, tagged with the revision it describes', async () => {
  const h = harness({ getRev: 41, meta: { modelVersion: 1, generatedAt: 1_791_223_100_000, stale: ['gateway'], topic: { id: 'health', rev: 41 } } });
  let last;
  h.stream.subscribe('health', '/api/v2/views/health', (v) => (last = v));
  h.stream.start();
  await flush();
  assert.deepEqual(last.meta, { generatedAt: 1_791_223_100_000, stale: ['gateway'], rev: 41 });
  h.hello(h.sources[0], { topics: ['health'], resumed: true });
  h.sources[0].emit('delta', { topic: 'health', rev: 42, baseRev: 41, ops: [{ op: 'set', path: ['level'], value: 'warn' }] });
  assert.equal(last.rev, 42);
  assert.equal(last.meta.rev, 41, 'frames carry no meta in 2.4: the GET meta stays, and says which revision it describes');
  h.sources[0].emit('snapshot', { topic: 'health', rev: 43, data: { level: 'ok' }, meta: { generatedAt: 1_791_223_300_000, stale: [] } });
  assert.deepEqual(last.meta, { generatedAt: 1_791_223_300_000, stale: [], rev: 43 }, 'a frame meta, when present, replaces it');
});

test('no envelope meta: meta is null, never invented', async () => {
  const h = harness({ getRev: 3 });
  let last;
  h.stream.subscribe('health', '/h', (v) => (last = v));
  await flush();
  assert.equal(last.meta, null);
});

test('F10: the backoff ladder (1, 2, 5, 10, 30 s, then 30 s) with ±20 % jitter, reset by a hello; nextRetryAt is exposed', async () => {
  let r = 0;
  const h = harness({ random: () => r });
  h.stream.subscribe('health', '/h', () => {});
  h.stream.start();
  const delays = [];
  for (let i = 0; i < 7; i++) {
    r = i % 2 ? 0.999 : 0;             // alternate the extremes of the jitter
    h.sources.at(-1).fail(2);
    await flush();
    const at = h.stream.status.get().nextRetryAt;
    assert.ok(at, 'nextRetryAt set while waiting');
    delays.push(at - Date.now());
    mock.timers.tick(at - Date.now());
  }
  assert.deepEqual(delays.map((d, i) => Math.round(d / [1000, 2000, 5000, 10_000, 30_000, 30_000, 30_000][i] * 10) / 10), [0.8, 1.2, 0.8, 1.2, 0.8, 1.2, 0.8]);
  h.hello(h.sources.at(-1));
  assert.deepEqual([h.stream.status.get().conn, h.stream.status.get().nextRetryAt], ['open', null]);
  r = 0.5; h.sources.at(-1).fail(2); await flush();
  assert.equal(h.stream.status.get().nextRetryAt - Date.now(), 1000, 'a successful hello starts the ladder again');
});

test('F10: offline stops the retries and closes the source; online reconnects at once', async () => {
  const net = new EventTarget(); net.onLine = true;
  const h = harness({ network: net });
  h.stream.subscribe('health', '/h', () => {});
  h.stream.start();
  h.hello(h.sources[0], { topics: ['health'] });
  net.onLine = false; net.dispatchEvent(new Event('offline'));
  assert.deepEqual([h.stream.status.get().conn, h.sources[0].readyState], ['offline', 2]);
  mock.timers.tick(120_000);
  assert.equal(h.sources.length, 1, 'no attempt while offline (the watchdog is off too)');
  net.onLine = true; net.dispatchEvent(new Event('online'));
  assert.equal(h.sources.length, 2, 'reconnected at once');
  assert.equal(h.stream.status.get().conn, 'connecting', 'a fresh start of the ladder');
  h.hello(h.sources[1], { topics: ['health'] });
  assert.equal(h.stream.status.get().conn, 'open');
  h.stream.stop();
  net.onLine = false; net.dispatchEvent(new Event('offline'));
  assert.equal(h.stream.status.get().conn, 'idle', 'a stopped stream ignores the network events');
});

test('F10: a stream started offline waits for the network', async () => {
  const net = new EventTarget(); net.onLine = false;
  const h = harness({ network: net });
  h.stream.start();
  assert.deepEqual([h.stream.status.get().conn, h.sources.length], ['offline', 0]);
  net.onLine = true; net.dispatchEvent(new Event('online'));
  assert.equal(h.sources.length, 1);
});

test('F10: a resumed stream (hello.resumed, Last-Event-ID) keeps the revisions, so replayed deltas apply on their baseRev', async () => {
  let view = null;
  const h = harness();
  h.stream.subscribe('health', '/h', (v) => { view = v; });
  await flush();
  h.stream.start();
  h.hello(h.sources[0], { topics: ['health'] });
  h.sources[0].emit('snapshot', { topic: 'health', rev: 5, data: { n: 1 } });
  h.sources[0].fail(0);                      // the browser's own reconnect (CONNECTING), with Last-Event-ID
  await flush();
  h.hello(h.sources[0], { topics: ['health'], resumed: true });
  assert.equal(view.rev, 5, 'the revision survives a resume');
  h.sources[0].emit('delta', { topic: 'health', rev: 6, baseRev: 5, ops: [{ op: 'set', path: ['n'], value: 2 }] });
  assert.deepEqual([view.rev, view.data.n, h.resyncs.length], [6, 2, 0], 'the replayed delta applies, no resync');
  h.hello(h.sources[0], { topics: ['health'], resumed: false, streamId: 'str_2' });
  assert.equal(view.rev, null, 'a new stream drops revisions until its snapshot');
  h.sources[0].emit('delta', { topic: 'health', rev: 7, baseRev: 6, ops: [{ op: 'set', path: ['n'], value: 3 }] });
  assert.equal(view.data.n, 2, 'no delta lands on data whose revision is unknown');
});

test('R27-01: Reconnecter cancels the pending backoff retry; the healthy replacement survives the old deadline (1 s and 30 s)', async () => {
  for (const failures of [1, 5]) {                    // 1 → a 1 s retry pending; 5 → the 30 s top of the ladder
    const h = harness();
    h.stream.subscribe('health', '/h', () => {});
    h.stream.start();
    for (let i = 0; i < failures; i++) {
      h.sources.at(-1).fail(2); await flush();
      if (i < failures - 1) mock.timers.tick(h.stream.status.get().nextRetryAt - Date.now());
    }
    const pending = h.stream.status.get().nextRetryAt - Date.now();
    mock.timers.tick(200);
    h.stream.reconnect();                              // the user presses « Reconnecter » before the retry
    const healthy = h.sources.at(-1);
    h.hello(healthy, { topics: ['health'] });
    mock.timers.tick(pending);                         // the old deadline passes
    assert.equal(h.sources.at(-1), healthy, `no new source after the old ${pending} ms retry`);
    assert.deepEqual([healthy.readyState !== 2, h.stream.status.get().conn, h.stream.status.get().nextRetryAt], [true, 'open', null]);
    h.stream.stop();
  }
});

test('R27-04: offline suspends topic-subscription retries too; online reconciles on the new stream', async () => {
  const net = new EventTarget(); net.onLine = true;
  const h = harness({ network: net, postFails: 1 });
  h.stream.subscribe('health', '/h', () => {});
  h.stream.start();
  h.hello(h.sources[0], { topics: [] });              // the add POST is sent … and fails
  await flush();
  assert.equal(h.posts.length, 1);
  net.onLine = false; net.dispatchEvent(new Event('offline'));
  mock.timers.tick(60_000); await flush();
  assert.equal(h.posts.length, 1, 'no subscription POST while offline');
  assert.equal(h.sources.length, 1, 'and no new source');
  net.onLine = true; net.dispatchEvent(new Event('online'));
  h.hello(h.sources[1], { topics: [], streamId: 'str_2' });
  await flush();
  assert.deepEqual(h.posts.slice(1).map((p) => [p.id, p.body.add]), [['str_2', ['health']]], 'reconciled against the new stream only');
});

test('R32-02: an old connection\'s auth check that answers after a healthy reconnect changes nothing (generation-scoped)', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const h = harness({ checkAuth: () => held });
  h.stream.subscribe('health', '/h', () => {});
  h.stream.start();
  h.sources[0].fail(2);                                // CLOSED: the auth check starts and is held
  await flush();
  h.stream.reconnect();                                // « Reconnecter » meanwhile
  const healthy = h.sources.at(-1);
  h.hello(healthy, { topics: ['health'] });
  assert.equal(h.stream.status.get().conn, 'open');
  release('ok');                                       // the old check answers now
  await flush(); await flush();
  assert.deepEqual([h.stream.status.get().conn, h.stream.status.get().nextRetryAt], ['open', null], 'no retry scheduled by the old completion');
  mock.timers.tick(40_000);   // past any backoff (30 s + 20 %), before the 60 s watchdog (no heartbeat in this test)
  assert.equal(h.sources.at(-1), healthy, 'the healthy replacement is never closed or replaced');
  assert.notEqual(healthy.readyState, 2);
  // and an old 'unauthorized' answer does not log the user out of the new, healthy stream either
  let release2;
  const h2 = harness({ checkAuth: () => new Promise((r) => { release2 = r; }) });
  h2.stream.subscribe('health', '/h', () => {});
  h2.stream.start();
  h2.sources[0].fail(2); await flush();
  h2.stream.reconnect(); h2.hello(h2.sources.at(-1), { topics: ['health'] });
  release2('unauthorized'); await flush(); await flush();
  assert.deepEqual([h2.stream.status.get().conn, h2.unauthorized()], ['open', 0]);
});


test('frontend-28: hello and heartbeat notify UI build checks without interrupting a matching API contract', () => {
  const builds = [], h = harness({onBuild: (id) => builds.push(id)});
  h.stream.start(); h.hello(h.sources[0], {buildId:'A'});
  h.sources[0].emit('heartbeat', {buildId:'B'});
  h.sources[0].emit('heartbeat', {});
  assert.deepEqual(builds,['A','B']); assert.deepEqual(h.reloads,[]);
});
