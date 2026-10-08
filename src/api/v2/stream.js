'use strict';
/*
 * The typed SSE stream (api.md §4).
 *   GET  /api/v2/stream?topics=a,b                → hello, then one snapshot per topic
 *   POST /api/v2/stream/:streamId/topics {add?, remove?} → Ok<{topics}>; a snapshot per added topic
 *   POST /api/v2/stream/:streamId/resync {topic}  → Ok<{queued:true}>; a snapshot of that topic
 * Frames: `id: <streamId>:<seq>` (seq from 1, +1 per frame), `event: <type>`, `data: <JSON>`.
 * Resume (§4.6): a reconnect with Last-Event-ID `<streamId>:<seq>` for a stream of the same session that
 * disconnected < RESUME_MS ago, whose buffer (≤ BUFFER frames) still holds seq + 1 → hello{resumed:true}
 * (no id) and the missed frames replayed with their original ids. Otherwise a new stream.
 * R1-09: a stream closes at its session's expiry, or at once when that session logs out, with a final
 * `system` frame. Transport control is never guarded and never audited (§4.2, R3-10).
 */
const crypto = require('crypto');
const { ApiError, invalid } = require('./errors');
const { okBody } = require('./envelope');

const RESUME_MS = 2 * 60 * 1000;
const BUFFER = 500;
const HEARTBEAT_MS = 25 * 1000;
const MAX_TOPICS = 32;

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const mintStreamId = () => 'str_' + [...crypto.randomBytes(22)].map((b) => B62[b % 62]).join('');

function createStreamHub({ topics, engine, systemState, contractVersion, modelVersion, buildId = () => null, now = () => Date.now(), heartbeatMs = HEARTBEAT_MS, resumeMs = RESUME_MS }) {
  const serverEpoch = 'ep_' + crypto.randomBytes(6).toString('hex');
  const streams = new Map();     // streamId → Stream

  function write(st, type, data, { buffered = true } = {}) {
    let line;
    if (buffered) {
      const seq = ++st.seq;
      line = `id: ${st.id}:${seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      st.buffer.push({ seq, line }); if (st.buffer.length > BUFFER) st.buffer.shift();
    } else line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    if (st.res) { try { st.res.write(line); } catch (_) { /* the close handler cleans up */ } }
  }

  function snapshot(st, topicId) {
    try {
      const cur = topics.current(topicId);
      write(st, 'snapshot', { type: 'snapshot', topic: cur.id, rev: cur.rev, data: cur.vm });
    } catch (e) {
      // a detail topic whose entity vanished: tell the client through an empty snapshot is wrong; drop the topic
      st.topics.delete(topicId);
      write(st, 'toast', { type: 'toast', level: 'error', message: { key: 'toast.topicGone' } });
    }
  }

  function hello(st, resumed) {
    const data = { type: 'hello', streamId: st.id, serverEpoch, modelVersion, contractVersion, serverTime: now(), resumed, topics: [...st.topics], buildId: buildId() };
    if (!resumed && st.rejected && st.rejected.length) data.rejected = st.rejected;   // 2.4: unknown topics asked at open
    if (resumed) write(st, 'hello', data, { buffered: false });
    else write(st, 'hello', data);
  }

  function closeStream(st, reason) {
    if (st.closed) return;
    st.closed = true;
    if (st.res) {
      write(st, 'system', Object.assign({ type: 'system' }, systemState(), { closing: reason }));
      try { st.res.end(); } catch (_) {}
    }
    clearTimers(st);
    streams.delete(st.id);
  }
  function clearTimers(st) { for (const k of ['expiry', 'heartbeat', 'gc']) if (st[k]) { clearTimeout(st[k]); clearInterval(st[k]); st[k] = null; } }

  function attach(st, req, res) {
    st.res = res; st.disconnectedAt = null;
    if (st.gc) { clearTimeout(st.gc); st.gc = null; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    st.heartbeat = setInterval(() => write(st, 'heartbeat', { type: 'heartbeat', at: now(), buildId: buildId() }), heartbeatMs);
    if (st.heartbeat.unref) st.heartbeat.unref();
    req.on('close', () => {
      if (st.res !== res) return;
      st.res = null; st.disconnectedAt = now();
      if (st.heartbeat) { clearInterval(st.heartbeat); st.heartbeat = null; }
      if (st.closed) return;
      st.gc = setTimeout(() => { streams.delete(st.id); clearTimers(st); }, resumeMs);
      if (st.gc.unref) st.gc.unref();
    });
  }

  function armExpiry(st) {
    const ms = Math.max(0, st.exp - now());
    st.expiry = setTimeout(() => closeStream(st, 'session-expired'), Math.min(ms, 2 ** 31 - 1));
    if (st.expiry.unref) st.expiry.unref();
  }

  // GET /api/v2/stream (req.session set by auth)
  function open(req, res) {
    const session = req.session;
    const last = String(req.headers['last-event-id'] || '');
    const m = last.match(/^(str_[0-9A-Za-z]{22}):(\d+)$/);
    if (m) {
      const st = streams.get(m[1]);
      const seq = Number(m[2]);
      const first = st && st.buffer.length ? st.buffer[0].seq : st ? st.seq + 1 : 0;
      if (st && !st.closed && st.sessionKey === sessionKeyOf(session) && !st.res && st.disconnectedAt != null
          && now() - st.disconnectedAt < resumeMs && seq <= st.seq && first <= seq + 1) {
        attach(st, req, res);
        hello(st, true);
        for (const f of st.buffer) if (f.seq > seq) res.write(f.line);
        return;
      }
    }
    const requested = String(req.query.topics || '').split(',').map((x) => x.trim()).filter(Boolean);
    // 2.4 (office-dev-09): an unknown topic doesn't reject the others; it's reported in hello.rejected
    const ids = [], rejected = [];
    for (const r of requested) {
      let raw; try { raw = decodeURIComponent(r); } catch (_) { raw = null; }
      const t = raw === null ? null : topics.parse(raw);
      if (!t) { rejected.push({ topic: String(raw === null ? r : raw).slice(0, 300), issue: 'unknown-topic' }); continue; }
      if (!ids.includes(t.id)) ids.push(t.id);
    }
    if (ids.length > MAX_TOPICS) throw invalid('topics', 'too-many');
    const st = { id: mintStreamId(), sessionKey: sessionKeyOf(session), sid: session.sid || null, exp: session.exp, topics: new Set(ids),
      seq: 0, buffer: [], res: null, disconnectedAt: null, closed: false, expiry: null, heartbeat: null, gc: null, rejected };
    streams.set(st.id, st);
    attach(st, req, res);
    armExpiry(st);
    hello(st, false);
    for (const id of ids) snapshot(st, id);
  }

  const owned = (req) => {
    const st = streams.get(req.params.streamId);
    if (!st || st.closed || st.sessionKey !== sessionKeyOf(req.session)) throw new ApiError('not_found');
    return st;
  };

  // POST /api/v2/stream/:streamId/topics
  function changeTopics(req, res) {
    const st = owned(req);
    const body = req.body || {};
    for (const k of Object.keys(body)) if (k !== 'add' && k !== 'remove') throw invalid(k, 'unexpected-field');
    const list = (v, f) => { if (v === undefined) return []; if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw invalid(f, 'invalid'); return v; };
    // 2.4 (office-dev-09): the known topics are added; the unknown ones are reported, never rejecting the batch
    const rejected = [];
    const add = list(body.add, 'add').map((r) => { const t = topics.parse(r); if (!t) { rejected.push({ topic: r.slice(0, 300), issue: 'unknown-topic' }); return null; } return t.id; }).filter(Boolean);
    const remove = list(body.remove, 'remove').map((r) => { const t = topics.parse(r); return t ? t.id : r; });
    for (const id of remove) st.topics.delete(id);
    const fresh = add.filter((id) => !st.topics.has(id));
    if (st.topics.size + fresh.length > MAX_TOPICS) throw invalid('add', 'too-many');
    for (const id of fresh) st.topics.add(id);
    res.json(okBody(rejected.length ? { topics: [...st.topics], rejected } : { topics: [...st.topics] }, { engine, now: now() }));
    for (const id of fresh) snapshot(st, id);
  }

  // POST /api/v2/stream/:streamId/resync
  function resync(req, res) {
    const st = owned(req);
    const body = req.body || {};
    for (const k of Object.keys(body)) if (k !== 'topic') throw invalid(k, 'unexpected-field');
    const t = typeof body.topic === 'string' ? topics.parse(body.topic) : null;
    if (!t) throw invalid('topic', 'unknown-topic');
    if (!st.topics.has(t.id)) throw invalid('topic', 'not-subscribed');
    res.json(okBody({ queued: true }, { engine, now: now() }));
    snapshot(st, t.id);
  }

  // topic changes → every subscribed stream, connected or buffering for a resume
  topics.on('change', (c) => {
    const frame = c.ops ? { type: 'delta', topic: c.id, rev: c.rev, baseRev: c.baseRev, ops: c.ops } : { type: 'snapshot', topic: c.id, rev: c.rev, data: c.snapshot };
    for (const st of streams.values()) if (!st.closed && st.topics.has(c.id)) write(st, frame.type, frame);
  });

  function broadcastSystem(extra = {}) { for (const st of streams.values()) if (!st.closed) write(st, 'system', Object.assign({ type: 'system' }, systemState(), extra)); }
  function toast(level, message) { for (const st of streams.values()) if (!st.closed) write(st, 'toast', { type: 'toast', level, message }); }

  // R1-09: a revoked session's streams close at once
  function revokeSession(session) { const key = sessionKeyOf(session); for (const st of [...streams.values()]) if (st.sessionKey === key) closeStream(st, 'logged-out'); }

  // R14-08: is any live (or resumable) stream subscribed to this topic id?
  function isSubscribed(id) { for (const st of streams.values()) if (!st.closed && st.topics.has(id)) return true; return false; }

  function closeAll() { for (const st of [...streams.values()]) closeStream(st, 'shutdown'); }

  return { open, changeTopics, resync, broadcastSystem, toast, revokeSession, closeAll, isSubscribed, serverEpoch, _streams: streams };
}

// A session's identity: its sid (S6 cookies) or, for an older cookie, email + expiry.
const sessionKeyOf = (s) => (s && s.sid ? 'sid:' + s.sid : 'legacy:' + (s && s.email) + ':' + (s && s.exp));

module.exports = { createStreamHub, sessionKeyOf, RESUME_MS, BUFFER, HEARTBEAT_MS };
