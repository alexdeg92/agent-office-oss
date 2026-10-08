// One SSE stream for the whole app (api.md 2.0 §4). Pages subscribe to topic ids; the stream changes its
// subscription with POST /api/v2/stream/:streamId/topics instead of reconnecting.
// Each topic keeps { rev, data }. A GET result counts as rev `meta.topic.rev`; deltas apply only on baseRev === rev;
// a gap or a malformed frame asks the server for a snapshot (POST …/resync) and ignores deltas until it arrives.
// Subscriptions are reconciled: the set the server confirmed is tracked, and failed changes are retried (R4-09).
// A connection failure re-checks the session, so an expired cookie leads to the login page, not a retry loop (R4-10).
import { reduceFrame } from './delta.js';
import { createStore } from './store.js';

const FRAME_TYPES = ['hello', 'snapshot', 'delta', 'cue', 'toast', 'system', 'heartbeat'];
export const WATCHDOG_MS = 60_000;          // heartbeats come every 25 s; two missed → reconnect
/** R27-02: what's on screen is not confirmed live (reconnecting, or offline): pages show it as stale/frozen. */
export const streamUnconfirmed = (status) => !!status && (status.conn === 'retrying' || status.conn === 'offline');
export const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
export const BACKOFF_JITTER = 0.2;          // F10: ±20 %, so tabs and devices don't all retry at the same instant
export const TOPIC_RETRY_MS = [1000, 3000, 10_000, 30_000];
const AUTH_CHECK_EVERY_MS = 5000;

/**
 * createStream(options)
 *   openSource(url) → EventSource-like (addEventListener, close, readyState)
 *   fetchVM(url) → Promise<{ data, topic: {id, rev} | null, meta? }>  GET; `topic` is the envelope's meta.topic,
 *     `meta` its { generatedAt, stale } (office-dev request): exposed per topic as `meta`, tagged with the revision it
 *     describes (`meta.rev`). SSE frames carry no meta in 2.4, so it is the last GET's (a frame `meta`, if one ever
 *     comes, replaces it). Pages compare meta.rev with rev to know whether it still describes what they show.
 *   postTopics(streamId, {add, remove}) → Promise<string[] | null>  the server's topic list after the change, if returned
 *   postResync(streamId, topic) → Promise                           the server answers with a snapshot frame
 *   checkAuth() → Promise<'ok' | 'unauthorized' | 'unknown'>         after a connection failure
 *   onUnauthorized(), onToast(frame), onCue(frame), onReload(reason)
 *   check(topic, data, where): dev/test VM validation of the topic state after a GET or an applied frame (vmcheck.js)
 *   modelVersion, contractVersion: what the page loaded with; timers: injectable for tests
 *   network: an EventTarget with 'online'/'offline' events and `navigator.onLine` semantics ({ onLine }), default window
 *   random: () => [0, 1) for the backoff jitter (tests pass a constant)
 * status.conn adds 'offline' (F10): the browser says there is no network; retries wait for 'online', then reconnect at
 * once. status.nextRetryAt is when the next attempt starts (null when none is scheduled), for the reconnection banner.
 */
export function createStream({ openSource, fetchVM, postTopics, postResync, checkAuth = async () => 'unknown', onUnauthorized = () => {}, check = () => {},
  onToast = () => {}, onCue = () => {}, onBuild = () => {}, onReload = () => location.reload(), modelVersion = null, contractVersion = null, timers = globalThis,
  now = () => Date.now(), network = globalThis.window || null, random = Math.random }) {
  // conn: 'idle' | 'connecting' | 'open' | 'retrying'; topicsOk: false while a subscription change is failing
  const status = createStore({ conn: 'idle', gateway: null, capabilities: null, lastFrameAt: null, topicsOk: true, nextRetryAt: null });
  const isOffline = () => !!(network && network.navigator ? network.navigator.onLine === false : network && network.onLine === false);
  const topics = new Map(); // topic → { state: {rev, data}, url, listeners:Set, loading, error, resyncing }
  let source = null, streamId = null, attempt = 0, watchdog = null, retryTimer = null, closed = true, epoch = null;
  let serverTopics = new Set();   // what the server has confirmed for the current stream
  // Topic reconciliation is scoped to a connection generation (review-07 R7-06): a POST still in flight for an older
  // stream never blocks the current one, and its completion never changes the current state.
  let generation = 0, syncingGen = -1, syncAttempt = 0, syncTimer = null;
  let lastAuthCheck = -Infinity, authChecking = false;

  const notify = (entry) => { for (const fn of entry.listeners) fn(view(entry)); };
  const view = (e) => ({ data: e.state.data, rev: e.state.rev, meta: e.meta, loading: e.loading, error: e.error, resyncing: e.resyncing });

  async function load(topic, { resync = false } = {}) {
    const entry = topics.get(topic);
    if (!entry) return;
    entry.loading = entry.state.data === undefined;
    entry.resyncing = resync;
    entry.error = null;
    notify(entry);
    try {
      const { data, topic: meta, meta: envelope } = await fetchVM(entry.url);
      if (topics.get(topic) !== entry) return;
      // A GET backing this topic counts as its revision (§4.3); a snapshot that arrived meanwhile wins.
      if (entry.state.rev == null) {
        entry.state = { rev: meta && meta.id === topic ? meta.rev : null, data };
        entry.meta = envelope ? { generatedAt: envelope.generatedAt ?? null, stale: Array.isArray(envelope.stale) ? envelope.stale : [], rev: entry.state.rev } : null;
        check(topic, data, 'GET ' + topic);
      }
      entry.error = null;
    } catch (err) {
      entry.error = err;
    } finally {
      entry.loading = false;
      entry.resyncing = false;
      notify(entry);
    }
  }

  /** Gap recovery (§4.3): ask the stream for a snapshot; without a stream (or if that fails), GET. */
  function resync(topic) {
    const entry = topics.get(topic);
    if (!entry) return;
    entry.state = { ...entry.state, rev: null };
    if (streamId && postResync && serverTopics.has(topic)) {
      entry.resyncing = true;
      notify(entry);
      postResync(streamId, topic).catch(() => load(topic, { resync: true }));
    } else {
      load(topic, { resync: true });
    }
  }

  // ---- subscription reconciliation (R4-09) ----
  function syncTopics() {
    if (closed || !streamId || syncingGen === generation) return;
    const want = [...topics.keys()];
    const add = want.filter((t) => !serverTopics.has(t));
    const remove = [...serverTopics].filter((t) => !topics.has(t) && t !== 'system');
    if (!add.length && !remove.length) { if (!status.get().topicsOk) status.set({ topicsOk: true }); return; }
    const gen = generation;
    syncingGen = gen;
    postTopics(streamId, { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) }).then((list) => {
      if (gen !== generation) return; // stale: belongs to a stream that was replaced
      syncingGen = -1;
      serverTopics = Array.isArray(list) ? new Set(list) : new Set([...[...serverTopics].filter((t) => !remove.includes(t)), ...add]);
      syncAttempt = 0;
      status.set({ topicsOk: true });
      syncTopics(); // the page may have changed meanwhile
    }, () => {
      if (gen !== generation) return;
      syncingGen = -1;
      status.set({ topicsOk: false });
      const delay = TOPIC_RETRY_MS[Math.min(syncAttempt, TOPIC_RETRY_MS.length - 1)];
      syncAttempt++;
      timers.clearTimeout(syncTimer);
      syncTimer = timers.setTimeout(syncTopics, delay);
    });
  }

  function handleFrame(type, raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return; // malformed frame: ignored (R4-17)
    frame.type = frame.type || type;
    status.set({ lastFrameAt: now() });
    armWatchdog();
    if ((frame.type === 'hello' || frame.type === 'heartbeat') && frame.buildId) onBuild(frame.buildId);
    switch (frame.type) {
      case 'hello': {
        attempt = 0;
        timers.clearTimeout(retryTimer);   // R27-01: recovered; no older retry may replace this stream
        status.set({ conn: 'open', nextRetryAt: null });
        if ((modelVersion != null && frame.modelVersion !== modelVersion) || (contractVersion != null && frame.contractVersion !== contractVersion)) {
          onReload(frame.modelVersion !== modelVersion ? 'model-version' : 'contract-version');
          return;
        }
        streamId = frame.streamId;
        if (epoch != null && frame.serverEpoch !== epoch) for (const e of topics.values()) e.state = { ...e.state, rev: null };
        epoch = frame.serverEpoch;
        // The server's list is authoritative (a resumed stream keeps its own topics, §4.6).
        serverTopics = new Set(Array.isArray(frame.topics) ? frame.topics : []);
        if (!frame.resumed) {
          // A new stream: snapshots follow for its topics; drop revisions so no delta lands on stale data.
          for (const e of topics.values()) { e.state = { ...e.state, rev: null }; if (e.state.data !== undefined) { e.resyncing = true; notify(e); } }
        }
        syncAttempt = 0;
        syncTopics();
        break;
      }
      case 'snapshot':
      case 'delta': {
        const entry = typeof frame.topic === 'string' ? topics.get(frame.topic) : null;
        if (!entry) return;
        const { state, needResync } = reduceFrame(entry.state, frame);
        entry.state = state;
        if (!needResync) check(frame.topic, state.data, frame.type + ' ' + frame.topic + ' rev ' + state.rev);
        if (frame.meta) entry.meta = { generatedAt: frame.meta.generatedAt ?? null, stale: Array.isArray(frame.meta.stale) ? frame.meta.stale : [], rev: state.rev };
        entry.error = null;
        if (frame.type === 'snapshot' && !needResync) entry.resyncing = false;
        notify(entry);
        if (needResync) resync(frame.topic);
        break;
      }
      case 'system':
        status.set({ gateway: frame.gateway, capabilities: frame.capabilities || null });
        if (frame.reload) onReload(frame.reload);
        break;
      case 'toast': onToast(frame); break;
      case 'cue': onCue(frame); break;
      default: break; // heartbeat and unknown frame types
    }
  }

  function armWatchdog() {
    timers.clearTimeout(watchdog);
    watchdog = timers.setTimeout(() => { reopen(); }, WATCHDOG_MS);
  }

  // ---- connection failures: auth first (R4-10), then backoff ----
  async function onError() {
    if (closed) return;
    // R32-02: this error belongs to one connection generation. If a reopen (Reconnecter, watchdog, online) replaced it
    // while the auth check was in flight, the answer is about a stream that no longer exists: drop it unread.
    const gen = generation;
    status.set({ conn: 'retrying' });
    const wasClosed = source && source.readyState === 2;
    if (!authChecking && now() - lastAuthCheck >= AUTH_CHECK_EVERY_MS) {
      authChecking = true;
      lastAuthCheck = now();
      let result = 'unknown';
      try { result = await checkAuth(); } catch { result = 'unknown'; }
      authChecking = false;
      if (closed || gen !== generation) return;
      if (result === 'unauthorized') { stop(); onUnauthorized(); return; }
    }
    if (isOffline()) { goOffline(); return; }
    // CONNECTING: the browser retries by itself (with Last-Event-ID). CLOSED: we reopen with backoff.
    if (wasClosed || (source && source.readyState === 2)) scheduleReopen();
  }

  function open() {
    closed = false;
    const list = [...topics.keys()];
    const url = '/api/v2/stream' + (list.length ? '?topics=' + list.map(encodeURIComponent).join(',') : '');
    status.set({ conn: attempt ? 'retrying' : 'connecting', topicsOk: true });
    generation++;
    syncingGen = -1;
    syncAttempt = 0;
    timers.clearTimeout(syncTimer);
    streamId = null;
    serverTopics = new Set();
    source = openSource(url);
    for (const type of FRAME_TYPES) source.addEventListener(type, (ev) => handleFrame(type, ev.data));
    source.addEventListener('error', onError);
    armWatchdog();
  }
  function scheduleReopen() {
    timers.clearTimeout(retryTimer);
    const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    const delay = Math.round(base * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * random()));
    attempt++;
    status.set({ nextRetryAt: now() + delay });
    retryTimer = timers.setTimeout(reopen, delay);
  }
  // F10: no network → stop trying (the source is closed so the browser doesn't spin); 'online' → reconnect now.
  function goOffline() {
    if (closed) return;
    timers.clearTimeout(retryTimer); timers.clearTimeout(watchdog); timers.clearTimeout(syncTimer);
    if (source) source.close();
    // R27-04: subscription work stops too. A new generation makes in-flight POST completions stale; `online` opens a
    // new stream, and its hello reconciles the topics against it.
    source = null; streamId = null; serverTopics = new Set(); generation++; syncingGen = -1; syncAttempt = 0;
    status.set({ conn: 'offline', nextRetryAt: null, topicsOk: true });
  }
  function onOnline() { if (!closed && status.get().conn !== 'open') { attempt = 0; reopen(); } }
  function onOffline() { goOffline(); }
  function reopen() {
    if (closed) return;
    timers.clearTimeout(retryTimer);   // R27-01: a manual or watchdog reopen replaces any scheduled one
    status.set({ nextRetryAt: null });
    if (source) source.close();
    source = null;
    open();
  }
  function stop() {
    closed = true;
    if (network && network.removeEventListener) { network.removeEventListener('online', onOnline); network.removeEventListener('offline', onOffline); }
    timers.clearTimeout(watchdog); timers.clearTimeout(retryTimer); timers.clearTimeout(syncTimer);
    if (source) source.close();
    source = null; streamId = null; serverTopics = new Set(); generation++; syncingGen = -1;
    status.set({ conn: 'idle', topicsOk: true, nextRetryAt: null });
  }

  return {
    status,
    start() {
      if (!closed) return;
      attempt = 0;
      if (network && network.addEventListener) { network.addEventListener('online', onOnline); network.addEventListener('offline', onOffline); }
      if (isOffline()) { closed = false; status.set({ conn: 'offline' }); return; }
      open();
    },
    stop,
    /** Forces a reconnect now (the « Reconnecter » action). */
    reconnect() { attempt = 0; reopen(); },
    /**
     * subscribe(topic, url, listener) → unsubscribe. The listener receives {data, rev, loading, error, resyncing}.
     * The first subscriber triggers GET url and adds the topic to the stream (reconciled, retried on failure).
     */
    subscribe(topic, url, listener) {
      let entry = topics.get(topic);
      const isNew = !entry;
      if (isNew) {
        entry = { state: { rev: null, data: undefined }, meta: null, url, listeners: new Set(), loading: true, error: null, resyncing: false };
        topics.set(topic, entry);
      }
      entry.listeners.add(listener);
      listener(view(entry));
      if (isNew) { load(topic); syncTopics(); }
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size || topics.get(topic) !== entry) return;
        topics.delete(topic);
        syncTopics();
      };
    },
    /** Retries the GET of a topic (the « Réessayer » button of an error state). */
    retry(topic) { const e = topics.get(topic); if (e) { e.state = { rev: null, data: e.state.data }; load(topic); } },
    /** Asks the server for a fresh snapshot of a topic (e.g. after a 409 without `current`). */
    resync,
    /**
     * Shows an authoritative VM the server returned outside the stream (a command's `vm`, a 409's `current.vm`).
     * The topic revision is unchanged: the matching delta, if any, re-applies the same values.
     */
    applyVM(topic, data) { const e = topics.get(topic); if (e && data) { e.state = { ...e.state, data }; notify(e); } },
    // exposed for tests
    _handleFrame: handleFrame,
    _topics: topics,
    _serverTopics: () => new Set(serverTopics),
  };
}
