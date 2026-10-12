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
const LIMITS = Object.freeze({ perSession: 8, global: 64, frameBytes: 1024 * 1024,
  pendingBytes: 1024 * 1024, replayBytes: 2 * 1024 * 1024, replayFrames: BUFFER, drainMs: 5000 });

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const mintStreamId = () => 'str_' + [...crypto.randomBytes(22)].map((b) => B62[b % 62]).join('');

function createStreamHub({ topics, engine, systemState, contractVersion, modelVersion, buildId = () => null, authorizeTopic = () => true, now = () => Date.now(), heartbeatMs = HEARTBEAT_MS, resumeMs = RESUME_MS, limits: overrides = {}, admission = new Map(), warnings = new Set(), log = () => {}, resolveTopic = (id) => id, security=null, authorizationEvents=null }) {
  if(security&&!authorizationEvents)throw new TypeError('stream authorization events required');
  const limits = { ...LIMITS, ...overrides };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('invalid stream limit');
  const serverEpoch = 'ep_' + crypto.randomBytes(6).toString('hex');
  const streams = new Map();     // streamId → Stream
  const authContext = session => ({ session, apiVersion: topics.P?.version || 2 });
  function current(st) {
    if(!security || security.valid(st.binding))return !st.closed;
    closeStream(st,'permissions-changed',false);return false;
  }
  const canTopic=(st,id)=>!security || security.can(st.binding,id);
  function authorizeQueuedTopic(st, topicId) {
    const topic = topics.parse(topicId);
    let permitted = false;
    try { permitted = !!topic && current(st) && canTopic(st, topicId) && !!authorizeTopic(topic, authContext(st.session)); } catch (_) {}
    if (!permitted && !st.closed) closeStream(st, 'permission-changed');
    return permitted;
  }

  function armDrain(st) {
    // writableLength can fall without a drain event while a large snapshot
    // trickles out. bytesWritten also catches progress while Node's queue stays
    // at the same size. A deadline measures a stalled interval, not total time.
    let queued = st.res?.writableLength || 0, written = st.res?.socket?.bytesWritten || 0;
    const check = () => {
      if (st.closed || !st.blocked || !st.res) return;
      const nextQueued = st.res.writableLength || 0, nextWritten = st.res.socket?.bytesWritten || 0;
      if (nextQueued < queued || nextWritten > written) {
        queued = nextQueued; written = nextWritten;
        st.drain = setTimeout(check, limits.drainMs); st.drain.unref?.();
      } else closeStream(st, 'slow-consumer', false);
    };
    st.drain = setTimeout(check, limits.drainMs); st.drain.unref?.();
  }
  function flushSnapshot(st) {
    const frame = st.inFlight;
    if (frame?.protectedTopicId && !authorizeQueuedTopic(st, frame.protectedTopicId)) return;
    while (frame && !st.closed && !st.blocked && frame.offset < frame.bytes.length) {
      const end = Math.min(frame.offset + 64 * 1024, frame.bytes.length);
      const slice = frame.bytes.subarray(frame.offset, end); frame.offset = end;
      sendLine(st, slice, { requiredSnapshot: true, slice: true, protectedTopicId: frame.protectedTopicId });
    }
    if (frame && frame.offset === frame.bytes.length) { st.inFlight = null; if (!st.blocked) st.snapshotSending = false; }
  }
  function sendLine(st, line, { requiredSnapshot = false, snapshotFrame = false, slice = false, protectedTopicId = null } = {}) {
    if (st.closed || !st.res || !current(st)) return;
    if (protectedTopicId && !authorizeQueuedTopic(st, protectedTopicId)) return;
    const bytes = Buffer.byteLength(line);
    if (!snapshotFrame && !requiredSnapshot && (bytes > limits.frameBytes || bytes + st.pendingBytes + (st.largeInFlight ? 0 : Math.max(st.blockedBytes || 0, st.res.writableLength || 0)) > limits.pendingBytes)) {
      closeStream(st, 'slow-consumer', false); return;
    }
    if (st.blocked || st.inFlight && !slice) {
      if (bytes + st.pendingBytes > limits.pendingBytes) { closeStream(st, 'slow-consumer', false); return; }
      st.pending.push({ line, bytes, snapshotFrame, protectedTopicId }); st.pendingBytes += bytes; return;
    }
    if (snapshotFrame && !slice) {
      st.snapshotSending = true;
      st.inFlight = { bytes: Buffer.from(line, 'utf8'), offset: 0, protectedTopicId };
      flushSnapshot(st); return;
    }
    try {
      const ready = st.res.write(line);
      if (!requiredSnapshot && !st.largeInFlight && (st.res.writableLength || 0) > limits.pendingBytes) { closeStream(st, 'slow-consumer', false); return; }
      if (ready === false) {
        st.blocked = true; st.blockedBytes = Math.max(bytes, st.res.writableLength || 0);
        st.largeInFlight = requiredSnapshot;
        if (!st.largeInFlight && st.blockedBytes > limits.pendingBytes) { closeStream(st, 'slow-consumer', false); return; }
        armDrain(st);
      }
    } catch { closeStream(st, 'write-failed', false); }
  }
  function write(st, type, data, { buffered = true } = {}) {
    if (st.closed || !current(st)) return;
    if(security) {data=security.frame(st.binding,type,data);if(data===null)return;}
    // Coalesce blocked topic data as bounded topic IDs, not serialized snapshots.
    // Drain fetches the latest full VM; a drop with deferred topics forces resync.
    if (st.blocked && (type === 'snapshot' || type === 'delta') && st.topics.has(data.topic)) {
      st.snapshotWaiting.add(data.topic); return;
    }
    const seq = st.seq + 1;
    const line = `${buffered ? `id: ${st.id}:${seq}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const bytes = Buffer.byteLength(line);
    const backlog = Math.max(st.blockedBytes || 0, st.res?.writableLength || 0);
    const requiredSnapshot = type === 'snapshot' && (bytes > limits.frameBytes || bytes + st.pendingBytes + backlog > limits.pendingBytes);
    if (bytes > limits.frameBytes && !requiredSnapshot) {
      if (type === 'delta') { snapshot(st, data.topic); return; }
      closeStream(st, 'frame-too-large', false); return;
    }
    if (requiredSnapshot && !warnings.has('oversized-snapshot')) {
      warnings.add('oversized-snapshot'); try { log('sse: oversized snapshot delivered; excluded from replay'); } catch {}
    }
    const protectedTopicId = ['snapshot', 'delta'].includes(type) && typeof data.topic === 'string' && st.topics.has(data.topic) ? data.topic : null;
    if (buffered) {
      st.seq = seq;
      if (requiredSnapshot) { st.buffer = []; st.bufferBytes = 0; }
      else { st.buffer.push({ seq, line, bytes, snapshotFrame: type === 'snapshot', protectedTopicId }); st.bufferBytes += bytes; }
      while (st.buffer.length > limits.replayFrames || st.bufferBytes > limits.replayBytes) st.bufferBytes -= st.buffer.shift().bytes;
    }
    sendLine(st, line, { requiredSnapshot, snapshotFrame: type === 'snapshot', protectedTopicId });
  }

  // agent-identity-1: a stream reads each subscribed topic id through its own session's projection (`resolveTopic`):
  // frames carry the subscribed (wire) id, data and revisions come from the projected topic.
  const projected = (st, id) => st.view?.get(id) || id;
  function snapshot(st, topicId) {
    if(!current(st)||!canTopic(st,topicId))return;
    if (st.topics.has(topicId) && !authorizeQueuedTopic(st, topicId)) return;
    try {
      const cur = topics.current(projected(st, topicId));
      // The wire topic owns the authorization/schema policy; `cur.id` may be a private scoped cache key.
      const data = security ? security.project(st.binding,topicId,cur.vm) : cur.vm;
      write(st, 'snapshot', { type: 'snapshot', topic: topicId, rev: cur.rev, data });
    } catch (e) {
      // a detail topic whose entity vanished: tell the client through an empty snapshot is wrong; drop the topic
      st.topics.delete(topicId); st.view?.delete(topicId);
      write(st, 'toast', { type: 'toast', level: 'error', message: { key: 'toast.topicGone' } });
    }
  }

  function hello(st, resumed) {
    const data = { type: 'hello', streamId: st.id, serverEpoch, modelVersion, contractVersion, serverTime: now(), resumed, topics: [...st.topics], buildId: buildId() };
    if (!resumed && st.rejected && st.rejected.length) data.rejected = st.rejected;   // 2.4: unknown topics asked at open
    if (resumed) write(st, 'hello', data, { buffered: false });
    else write(st, 'hello', data);
  }

  function detach(st, terminate = false) {
    const res = st.res; st.res = null;
    if (res && st.onDrain) res.removeListener?.('drain', st.onDrain);
    st.onDrain = null;
    for (const k of ['heartbeat', 'drain']) { clearTimeout(st[k]); clearInterval(st[k]); st[k] = null; }
    if (!st.closed && (st.snapshotSending || st.snapshotWaiting.size)) { st.seq++; st.buffer = []; st.bufferBytes = 0; }
    st.snapshotWaiting.clear();
    st.inFlight = null; st.snapshotSending = false; st.pending = []; st.pendingBytes = 0; st.blocked = false; st.blockedBytes = 0; st.largeInFlight = false;
    if (terminate && res) { try { if (res.destroy) res.destroy(); else res.end(); } catch {} }
  }
  function closeStream(st, reason, notify = true) {
    if (st.closed) return;
    const res = st.res, blocked = st.blocked;
    // Never append even a closing notification to a blocked socket.
    if (notify && res && !blocked) write(st, 'system', Object.assign({ type: 'system' }, systemState(), { closing: reason }));
    if (st.closed) return;
    st.closed = true; detach(st);
    if (res) { try { if ((!notify || blocked) && res.destroy) res.destroy(); else res.end(); } catch {} }
    clearTimers(st); st.buffer = []; st.bufferBytes = 0;
    streams.delete(st.id); admission.delete(st.id);
  }
  function clearTimers(st) { for (const k of ['expiry', 'heartbeat', 'gc', 'drain']) { clearTimeout(st[k]); clearInterval(st[k]); st[k] = null; } }

  function attach(st, req, res) {
    if (st.res) detach(st, true);
    st.res = res; st.disconnectedAt = null;
    if (st.gc) { clearTimeout(st.gc); st.gc = null; }
    st.onDrain = () => {
      if (st.res !== res || st.closed || !current(st)) return;
      clearTimeout(st.drain); st.drain = null; st.blocked = false; st.blockedBytes = 0; st.largeInFlight = false;
      if (st.inFlight) flushSnapshot(st); else st.snapshotSending = false;
      while (st.pending.length && !st.blocked && !st.closed) {
        const entry = st.pending.shift(); st.pendingBytes -= entry.bytes; sendLine(st, entry.line, { snapshotFrame: entry.snapshotFrame, protectedTopicId: entry.protectedTopicId });
      }
      for (const topic of st.snapshotWaiting) {
        if (st.blocked || st.closed) break;
        st.snapshotWaiting.delete(topic);
        if (st.topics.has(topic)) snapshot(st, topic);
      }
    };
    res.on?.('drain', st.onDrain);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    sendLine(st, 'retry: 3000\n\n');
    if (st.closed) return;
    st.heartbeat = setInterval(() => write(st, 'heartbeat', { type: 'heartbeat', at: now(), buildId: buildId() }), heartbeatMs);
    st.heartbeat.unref?.();
    req.on('close', () => {
      if (st.res !== res) return;
      detach(st); st.disconnectedAt = now();
      if (st.closed) return;
      st.gc = setTimeout(() => closeStream(st, 'resume-expired', false), resumeMs);
      st.gc.unref?.();
    });
  }

  function armExpiry(st) {
    const ms = Math.max(0, st.exp - now());
    st.expiry = setTimeout(() => closeStream(st, 'session-expired'), Math.min(ms, 2 ** 31 - 1));
    if (st.expiry.unref) st.expiry.unref();
  }

  // GET /api/v2/stream (req.session set by auth)
  function open(req, res) {
    const ticket=req.humanStreamTicket;
    const binding=security?.capture(req);
    const session = binding?.session || req.session;
    const last = ticket?'':String(req.headers['last-event-id'] || '');
    const m = last.match(/^(str_[0-9A-Za-z]{22}):(\d+)$/);
    if (m) {
      const st = streams.get(m[1]);
      const seq = Number(m[2]);
      const first = st && st.buffer.length ? st.buffer[0].seq : st ? st.seq + 1 : 0;
      if (st && !st.closed && current(st) && st.sessionKey === sessionKeyOf(session) && (!security || binding.fingerprint===st.binding.fingerprint && binding.userId===st.binding.userId && binding.sessionId===st.binding.sessionId) && st.exp > now() && !st.snapshotWaiting.size && !st.snapshotSending && (st.res || st.disconnectedAt != null && now() - st.disconnectedAt < resumeMs)
          && Number.isSafeInteger(seq) && seq <= st.seq && first <= seq + 1) {
        for (const id of st.topics) if (!authorizeQueuedTopic(st, id)) throw new ApiError('forbidden');
        st.session = req.session || session;
        attach(st, req, res);
        hello(st, true);
        for (const f of st.buffer) if (f.seq > seq) sendLine(st, f.line, { snapshotFrame: f.snapshotFrame, protectedTopicId: f.protectedTopicId });
        return;
      }
    }
    const requested = ticket?[...ticket.topics]:String(req.query.topics || '').split(',').map((x) => x.trim()).filter(Boolean);
    // 2.4 (office-dev-09): an unknown topic doesn't reject the others; it's reported in hello.rejected
    const ids = [], rejected = [];
    for (const r of requested) {
      let raw; try { raw = decodeURIComponent(r); } catch (_) { raw = null; }
      const t = raw === null ? null : topics.parse(raw);
      if (!t) { rejected.push({ topic: String(raw === null ? r : raw).slice(0, 300), issue: 'unknown-topic' }); continue; }
      if ((security && !security.can(binding,t.id)) || !authorizeTopic(t, req)) {
        if (['orchestrators', 'teams', 'office-scope'].includes(t.name)) throw new ApiError('forbidden');
        rejected.push({topic:t.id,issue:'permission-denied'});continue;
      }
      if (!ids.includes(t.id)) ids.push(t.id);
    }
    if (ids.length > MAX_TOPICS) throw invalid('topics', 'too-many');
    // One admission registry is shared by API v2/v3; tabs share a session cookie.
    // New tabs evict the oldest session slot, including a half-open response.
    for (const old of [...admission.values()]) if (old.exp <= now() || old.disconnectedAt != null && now() - old.disconnectedAt >= resumeMs) old.close('expired', false);
    const mine = [...admission.values()].filter(st => st.sessionKey === sessionKeyOf(session));
    if (mine.length >= limits.perSession) mine[0].close('replaced', false);
    if (admission.size >= limits.global) throw new ApiError('rate_limited');
    const st = { id: mintStreamId(), sessionKey: sessionKeyOf(session), userId:binding?.userId || session.userId || null, binding, session: req.session || session, sid: session.sid || null, exp: session.exp, topics: new Set(ids),
      seq: 0, buffer: [], bufferBytes: 0, pending: [], pendingBytes: 0, blocked: false, blockedBytes: 0, largeInFlight: false, snapshotWaiting: new Set(), view: new Map(ids.map((id) => [id, resolveTopic(id, session)])), inFlight: null, snapshotSending: false, drain: null, onDrain: null, res: null, disconnectedAt: null, closed: false, expiry: null, heartbeat: null, gc: null, rejected };
    st.close = (reason, notify) => closeStream(st, reason, notify);
    streams.set(st.id, st); admission.set(st.id, st);
    attach(st, req, res);
    if (st.closed) return;
    armExpiry(st);
    hello(st, false);
    for (const id of ids) snapshot(st, id);
  }

  const owned = (req) => {
    const st = streams.get(req.params.streamId);
    const session=security ? security.capture(req).session : req.session;
    if (!st || st.closed || !current(st) || st.sessionKey !== sessionKeyOf(session)) throw new ApiError('not_found');
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
    const add = list(body.add, 'add').map((r) => { const t = topics.parse(r); if (!t) { rejected.push({ topic: r.slice(0, 300), issue: 'unknown-topic' }); return null; } if(!canTopic(st,t.id) || !authorizeTopic(t, { ...authContext(st.session), session: st.session })){rejected.push({topic:t.id,issue:'permission-denied'});return null;}return t.id; }).filter(Boolean);
    const remove = list(body.remove, 'remove').map((r) => { const t = topics.parse(r); return t ? t.id : r; });
    for (const id of remove) { st.topics.delete(id); st.view?.delete(id); st.snapshotWaiting.delete(id); }
    const fresh = add.filter((id) => !st.topics.has(id));
    if (st.topics.size + fresh.length > MAX_TOPICS) throw invalid('add', 'too-many');
    for (const id of fresh) { st.topics.add(id); st.view.set(id, resolveTopic(id, req.session)); }
    res.json(okBody(rejected.length ? { topics: [...st.topics], rejected } : { topics: [...st.topics] }, { engine:!security||security.mayExposeSources(st.binding)?engine:null, now: now() }));
    for (const id of fresh) snapshot(st, id);
  }

  // POST /api/v2/stream/:streamId/resync
  function resync(req, res) {
    const st = owned(req);
    const body = req.body || {};
    for (const k of Object.keys(body)) if (k !== 'topic') throw invalid(k, 'unexpected-field');
    const t = typeof body.topic === 'string' ? topics.parse(body.topic) : null;
    if (!t) throw invalid('topic', 'unknown-topic');
    if(!canTopic(st,t.id))throw new ApiError('forbidden',{details:[{issue:'permission-denied'}]});
    if(!authorizeQueuedTopic(st,t.id))throw new ApiError('forbidden',{details:[{issue:'permission-denied'}]});
    if (!st.topics.has(t.id)) throw invalid('topic', 'not-subscribed');
    res.json(okBody({ queued: true }, { engine:!security||security.mayExposeSources(st.binding)?engine:null, now: now() }));
    snapshot(st, t.id);
  }

  // topic changes → every subscribed stream, connected or buffering for a resume
  const onTopicChange = (c) => {
    for (const st of streams.values()) {
      if (st.closed || !current(st)) continue;
      for (const wire of st.topics) if (projected(st, wire) === c.id) {
        if (!canTopic(st,wire)) continue;
        if (security) snapshot(st,wire);
        else {
          const frame = c.ops ? { type: 'delta', topic: wire, rev: c.rev, baseRev: c.baseRev, ops: c.ops } : { type: 'snapshot', topic: wire, rev: c.rev, data: c.snapshot };
          write(st, frame.type, frame);
        }
      }
    }
  };
  topics.on('change',onTopicChange);

  function broadcastSystem(extra = {}) { for (const st of streams.values()) if (!st.closed) write(st, 'system', Object.assign({ type: 'system' }, systemState(), extra)); }
  function broadcastSettings(frame) { for (const st of streams.values()) if (!st.closed) write(st, 'settings', frame); }
  // Cues are session events. Deliver them only to a currently authorized full
  // Office projection; a limited Office projection must never infer sessions.
  function broadcastOffice(frame) {
    for (const st of streams.values()) {
      if (st.closed) continue;
      const logicalOffice = st.topics.has('office') ? projected(st, 'office') : null;
      const fullLogicalOffice = logicalOffice === 'office'
        ? authorizeQueuedTopic(st, 'office')
        : typeof logicalOffice === 'string' && logicalOffice.startsWith('office-scope:') && authorizeQueuedTopic(st, logicalOffice);
      const scopedOffice = [...st.topics].some(id => id.startsWith('office-scope:') && authorizeQueuedTopic(st, id));
      if (fullLogicalOffice || scopedOffice) write(st, 'cue', frame);
    }
  }
  function toast(level, message) { for (const st of streams.values()) if (!st.closed) write(st, 'toast', { type: 'toast', level, message }); }

  // R1-09: a revoked session's streams close at once
  function revokeSession(session) {
    if (session.allExcept) {
      const userId=session.userId ?? [...streams.values()].find(st=>st.sid===session.allExcept)?.userId ?? null;
      for (const st of [...streams.values()]) if (st.userId===userId && st.sid!==session.allExcept) closeStream(st, 'credentials-changed');return;
    }
    const key = sessionKeyOf(session); for (const st of [...streams.values()]) if (st.sessionKey === key) closeStream(st, 'logged-out'); }

  // R14-08: is any live (or resumable) stream subscribed to this topic id?
  function isSubscribed(id) { for (const st of streams.values()) if (!st.closed && [...st.topics].some((wire) => wire === id || projected(st, wire) === id)) return true; return false; }

  function closeAll() {
    for (const st of [...streams.values()]) closeStream(st, 'shutdown');
    topics.off('change',onTopicChange);
    authorizationEvents?.removeListener('change',invalidateAuthorization);
  }
  function invalidateAuthorization(event) {
    for(const st of [...streams.values()])if(event.registry || event.userId&&event.userId===st.userId || event.roleId&&event.roleId===st.binding?.roleId || event.sessionId&&event.sessionId===st.binding?.sessionId)closeStream(st,'permissions-changed',false);
  }
  authorizationEvents?.on('change',invalidateAuthorization);

  return { open, changeTopics, resync, broadcastSystem, broadcastOffice, broadcastSettings, toast, revokeSession, invalidateAuthorization, closeAll, isSubscribed, serverEpoch, _streams: streams };
}

// A session's identity: its sid (S6 cookies) or, for an older cookie, email + expiry.
const sessionKeyOf = (s) => (s?.userId ? 'user:'+s.userId+':' : '')+(s && s.sid ? 'sid:' + s.sid : s?.legacyId ? s.legacyId : 'legacy:' + (s && s.email) + ':' + (s && s.exp));

module.exports = { createStreamHub, sessionKeyOf, RESUME_MS, BUFFER, HEARTBEAT_MS, LIMITS };
