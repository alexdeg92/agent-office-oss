'use strict';
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path');
const { createHash } = require('node:crypto');
const { mapRecord, mergeRecord, transcript } = require('./profile');
const budget = require('../../engine/transcript-budget');
const unsupported = () => Object.assign(new Error('unsupported transcript format'), { code: 'EFORMAT', reasonCode: 'no-recognizable-session-lines' });
const BOUNDS = Object.freeze({ sessions: 2000, tails: 32, cacheSessions: 16, cacheBytes: 8 * 1024 * 1024,
  globalCacheBytes: 32 * 1024 * 1024, readBytes: 256 * 1024, lineBytes: 1024 * 1024, probeBytes: 2 * 1024 * 1024,
  scanYield: 100, reads: 2, globalReads: 8, subagentsPerSession: 64, subagentEntriesPerDir: 256, subagentEntriesPerScan: 4096 });
const globalCache = new Map(); let cacheSequence = 0, globalReads = 0, globalQueued = 0;
const waiters = []; let lastGranted = null;
function pump() {
  for (let n=waiters.length-1;n>=0;n--) if (waiters[n].closed()) waiters.splice(n,1)[0].resolve(false);
  while (globalReads < BOUNDS.globalReads) {
    let n=waiters.findIndex(w=>w.available() && w.source!==lastGranted);
    if (n<0) n=waiters.findIndex(w=>w.available()); if (n<0) break;
    const w=waiters.splice(n,1)[0];lastGranted=w.source;globalReads++;w.enter();w.resolve(true);
  }
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const unsafe = () => Object.assign(new Error('transcript path refused'), { code: 'EUNSAFEPATH' });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function parents(dir) {
  const paths = []; for (let p = path.resolve(dir);; p = path.dirname(p)) { paths.unshift(p); if (p === path.dirname(p)) break; }
  const snapshots = [];
  for (const p of paths) { const s = await fsp.lstat(p); if (!s.isDirectory() || s.isSymbolicLink()) throw unsafe(); snapshots.push({ path: p, dev: s.dev, ino: s.ino }); }
  return snapshots;
}
async function verify(chain) { for (const p of chain) { const s = await fsp.lstat(p.path); if (!s.isDirectory() || s.isSymbolicLink() || !same(p, s)) throw unsafe(); } }
async function pin(chain) {
  // Linux is the supported host. Each next directory is opened through its
  // parent's descriptor, so swapping an ancestor cannot redirect a file read.
  let fd;
  try {
    for (const p of chain) {
      const next = await fsp.open(fd ? `/proc/self/fd/${fd.fd}/${path.basename(p.path)}` : p.path,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const st = await next.stat();
      if (!st.isDirectory() || !same(p,st)) { await next.close(); throw unsafe(); }
      await fd?.close(); fd=next;
    }
    return fd;
  } catch (error) { await fd?.close(); throw error; }
}
function createFiles({ home, include = [], exclude = [], agentGrouping = 'project', now = Date.now }) {
  const root = path.resolve(home, 'projects'), index = new Map(), cache = new Map(), prefix = ++cacheSequence;
  let closed = false, scanning = null, reads = 0, generation = 0, queued = 0;
  const inFlight = new Map();
  const stats = { entries: 0, reads: 0, bytes: 0, yields: 0, peakReads: 0, rejected: 0, recognizedLines: 0,
    ignoredLines: 0, unknownLineTypes: 0, metadataLines: 0, unknownKeys: 0, unknownContentBlocks: 0, malformedLines: 0 };
  const agentId = project => agentGrouping === 'runtime' ? 'runtime' : 'project:' + createHash('sha256').update(project).digest('hex');
  const projectRef = project => 'project:' + createHash('sha256').update(project).digest('hex');
  const removeCache = (key, evicted = false) => { cache.delete(key); globalCache.delete(prefix + ':' + key); budget.release('file:' + prefix + ':' + key); if (evicted) { const row=index.get(key); if (row) { delete row.ancestry; delete row.tip; } } };
  function keep(key, value) {
    removeCache(key); const size = Buffer.byteLength(JSON.stringify(value));
    cache.set(key, value); globalCache.set(prefix + ':' + key, { size, drop: () => removeCache(key,true) });
    budget.reserve('file:' + prefix + ':' + key, size, () => removeCache(key,true));
    const bytes = () => [...cache.keys()].reduce((n, k) => n + (globalCache.get(prefix + ':' + k)?.size || 0), 0);
    while (cache.size > BOUNDS.cacheSessions || bytes() > BOUNDS.cacheBytes) removeCache(cache.keys().next().value,true);
    while ([...globalCache.values()].reduce((n, r) => n + r.size, 0) > BOUNDS.globalCacheBytes) { const k = globalCache.keys().next().value; globalCache.get(k).drop(); globalCache.delete(k); }
  }
  async function admission(fn) {
    if (globalQueued >= 256) { stats.queueOverflow = (stats.queueOverflow || 0) + 1; throw Object.assign(new Error('transcript read queue bound'), { code: 'EBUSY' }); }
    queued++; globalQueued++;
    try {
      const admitted=await new Promise(resolve=>{waiters.push({source:prefix,available:()=>reads<BOUNDS.reads,closed:()=>closed,enter:()=>{reads++;stats.peakReads=Math.max(stats.peakReads,reads);stats.peakGlobalReads=Math.max(stats.peakGlobalReads || 0,globalReads);},resolve});pump();});
      if (!admitted) return null;
      try { return await fn(); } finally { reads--; globalReads--; pump(); }
    } finally { queued--; globalQueued--; }
  }
  async function scan() {
    if (scanning) return scanning;
    scanning = (async () => {
      const gen = ++generation, found = new Map(), chain = await parents(root);
      // security-187: every entry of a nested subagents directory counts (valid or not), per directory and per scan
      let nestedBudget = BOUNDS.subagentEntriesPerScan, nestedTruncated = false;
      const projects = await fsp.opendir(root); let steps = 0, candidates = 0;
      // A bounded max heap selects a deterministic prefix without retaining the
      // rest of a large directory or sorting its entire enumeration in memory.
      const heap = [];
      const push = key => { heap.push(key); let n=heap.length-1; while (n && heap[(n-1)>>1] < heap[n]) { const p=(n-1)>>1; [heap[p],heap[n]]=[heap[n],heap[p]]; n=p; } };
      const replace = key => { const old=heap[0]; heap[0]=key; let n=0; for (;;) { let k=n*2+1; if (k>=heap.length) break; if (k+1<heap.length && heap[k+1]>heap[k]) k++; if (heap[n]>=heap[k]) break; [heap[n],heap[k]]=[heap[k],heap[n]]; n=k; } return old; };
      try {
        for await (const project of projects) {
          if (closed) return [];
          if (++steps % BOUNDS.scanYield === 0) { stats.yields++; await turn(); }
          if (!project.isDirectory() || project.isSymbolicLink() || exclude.includes(project.name) || include.length && !include.includes(project.name)) continue;
          const dir = path.join(root, project.name), localChain = await parents(dir), entries = await fsp.opendir(dir);
          try {
            for await (const file of entries) {
              if (closed) return [];
              stats.entries++;
              if (++steps % BOUNDS.scanYield === 0) { stats.yields++; await turn(); }
              // T-0062: the one recognized nested location, <session>/subagents/agent-<id>.jsonl (a sub-agent's transcript)
              if (file.isDirectory() && !file.isSymbolicLink() && /^[a-zA-Z0-9-]{1,128}$/.test(file.name)) {
                const sub = path.join(dir, file.name, 'subagents');
                let sst; try { sst = await fsp.lstat(sub); } catch { continue; }
                if (!sst.isDirectory() || sst.isSymbolicLink()) continue;
                if (nestedBudget <= 0) { nestedTruncated = true; continue; }
                const subChain = await parents(sub), subEntries = await fsp.opendir(sub), names = []; let inspected = 0;
                try {
                  for await (const child of subEntries) {
                    if (closed) return [];
                    stats.entries++;
                    if (++steps % BOUNDS.scanYield === 0) { stats.yields++; await turn(); }
                    if (nestedBudget-- <= 0 || inspected++ >= BOUNDS.subagentEntriesPerDir) { nestedTruncated = true; break; }   // critic-250: every entry counts locally too
                    if (child.isFile() && !child.isSymbolicLink() && /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/.test(child.name)) names.push(child.name);
                  }
                  // deterministic choice within the budget: sorted names, at most subagentsPerSession children
                  names.sort();
                  if (names.length > BOUNDS.subagentsPerSession) { stats.subagentsCapped = (stats.subagentsCapped || 0) + 1; nestedTruncated = true; }
                  for (const name of names.slice(0, BOUNDS.subagentsPerSession)) {
                    candidates++;
                    const parentLocal = createHash('sha256').update(project.name).digest('hex') + '/' + file.name;
                    const local = parentLocal + '/' + name.slice(0, -6);
                    if (found.size >= BOUNDS.sessions && local >= heap[0]) continue;
                    const filename = path.join(sub, name), st = await fsp.lstat(filename);
                    if (!st.isFile() || st.isSymbolicLink()) continue;
                    if (found.size >= BOUNDS.sessions) found.delete(replace(local)); else push(local);
                    found.set(local, { ...index.get(local), key: local, sessionId: file.name, subagent: name.slice(6, -6), parentKey: parentLocal, project: project.name, file: filename,
                      agentId: agentId(project.name), size: st.size, mtime: st.mtimeMs, dev: st.dev, ino: st.ino, chain: subChain, scan: gen });
                  }
                } finally { await verify(subChain); }
                continue;
              }
              if (!file.isFile() || file.isSymbolicLink() || !/^[a-zA-Z0-9-]{1,128}\.jsonl$/.test(file.name)) continue;
              candidates++;
              const local = createHash('sha256').update(project.name).digest('hex') + '/' + file.name.slice(0,-6);
              if (found.size >= BOUNDS.sessions && local >= heap[0]) continue;
              const key = file.name.slice(0, -6), filename = path.join(dir, file.name), st = await fsp.lstat(filename);
              if (!st.isFile() || st.isSymbolicLink()) continue;
              // UUIDs reused by two projects are not one session.
              if (found.size >= BOUNDS.sessions) found.delete(replace(local)); else push(local);
              found.set(local, { ...index.get(local), key: local, sessionId: key, project: project.name, file: filename, agentId: agentId(project.name),
                size: st.size, mtime: st.mtimeMs, dev: st.dev, ino: st.ino, chain: localChain, scan: gen });
            }
          } finally { await verify(localChain); }
        }
        await verify(chain);
      } catch (e) { throw e; }
      if (!closed) {
        for (const key of index.keys()) if (!found.has(key)) { index.delete(key); removeCache(key); }
        for (const [key, row] of found) if (index.has(key) || index.size < BOUNDS.sessions) index.set(key, row);
        stats.excluded = Math.max(0,candidates-found.size); stats.truncated = stats.excluded > 0 || nestedTruncated; stats.nestedTruncated = nestedTruncated;
      }
      return [...index.values()];
    })().finally(() => { scanning = null; });
    return scanning;
  }
  async function read(key, { refresh = false } = {}) {
    const row = index.get(key); if (!row || closed) return null;
    if (!refresh && cache.has(key)) { const value = cache.get(key); keep(key, value); return value; }
    if (inFlight.has(key)) return inFlight.get(key);
    const operation = admission(async () => {
      const before = await fsp.lstat(row.file); if (!before.isFile() || before.isSymbolicLink()) throw unsafe();
      await verify(row.chain);
      const parent = await pin(row.chain); let fd;
      try {
        fd = await fsp.open(`/proc/self/fd/${parent.fd}/${path.basename(row.file)}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const st = await fd.stat(); if (!st.isFile() || !same(before, st)) throw unsafe();
        await verify(row.chain); const latest = await fsp.lstat(row.file); if (!same(st, latest) || latest.isSymbolicLink()) throw unsafe();
        const reset = row.readDev !== st.dev || row.readIno !== st.ino || st.size < (row.offset || 0)
          || st.size <= (row.offset || 0) && row.readMtime !== st.mtimeMs
          || row.coverageComplete && !row.recognizable && row.readMtime !== st.mtimeMs || !cache.has(key);
        let offset = reset ? 0 : row.offset || 0;
        if (reset) { row.summary = null; row.summarySource = null; row.displayName = null; row.spawns = []; row.execution = null; row.activity = null; row.backgroundPending = false; row.backgroundPendingIds = []; row.pendingBackgroundOverflow = false; row.awaitingReply = false; row.awaitingReplyAt = null; }
        const startedAtZero = reset ? offset === 0 : !!row.startedAtZero;
        let skip = reset ? offset > 0 : row.skip || false, pending = Buffer.alloc(0), events = reset ? [] : structuredClone(cache.get(key).events);
        let committed = offset, at = null, model = null, readTotal = 0, accepted = false, activityAt = null, activity = reset ? null : row.activity || null,
          backgroundPending = reset ? false : row.backgroundPending === true,
          backgroundPendingIds = reset ? [] : [...(row.backgroundPendingIds || [])],
          pendingBackgroundOverflow = reset ? false : row.pendingBackgroundOverflow === true,
          awaitingReply = reset ? false : row.awaitingReply === true,
          awaitingReplyAt = reset ? null : row.awaitingReplyAt ?? null;
        let recognizable = reset ? false : !!row.recognizable,
          coverageComplete = reset ? st.size === 0 && offset === 0 : !!row.coverageComplete && st.size <= (row.offset || 0);
        let projectName = reset ? null : row.projectName || null;
        const ancestry = reset ? new Map() : new Map(row.ancestry || []);
        let tip = reset ? null : row.tip, partial = reset ? offset > 0 : row.partial || false;
        // At most one bootstrap/read window per request. Continuation is picked up
        // by the next cycle; incomplete lines are reread from their start.
        while (offset < st.size && readTotal < BOUNDS.lineBytes + BOUNDS.readBytes) {
          if (closed) return null;
          const buffer = Buffer.alloc(Math.min(BOUNDS.readBytes, st.size - offset));
          const { bytesRead } = await fd.read(buffer, 0, buffer.length, offset); if (!bytesRead) break;
          offset += bytesRead; readTotal += bytesRead; stats.reads++; stats.bytes += bytesRead;
          pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
          let cut;
          while ((cut = pending.indexOf(10)) >= 0) {
            const lineStart = offset - pending.length, line = pending.subarray(0, cut); committed = lineStart + cut + 1; pending = pending.subarray(cut + 1);
            if (skip) { skip = false; continue; }
            if (!line.length) continue;
            if (line.length > BOUNDS.lineBytes) { partial=true; stats.oversizeLines=(stats.oversizeLines || 0)+1; continue; }
            let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
            catch { stats.malformedLines++; stats.ignoredLines++; continue; }
            const rowUuid = typeof value.uuid === 'string' && value.uuid.length > 0 && value.uuid.length <= 256 ? value.uuid : null;
            const parentUuid = typeof value.parentUuid === 'string' && value.parentUuid.length <= 256 ? value.parentUuid : null;
            const fallbackId = `${st.dev}:${st.ino}:${reset ? st.mtimeMs : row.fileGeneration}:${lineStart}`;
            const record = mapRecord(value, { sessionKey: row.sessionId, agentId: row.agentId, fallbackId, counters: stats,
              sidechainAgent: row.subagent || null, pendingBackground: backgroundPending, pendingBackgroundIds: backgroundPendingIds,
              pendingBackgroundOverflow, awaitingReply, awaitingReplyAt, now: now() });
            if (typeof record.backgroundPending === 'boolean') backgroundPending = record.backgroundPending;
            if (Array.isArray(record.backgroundPendingIds)) backgroundPendingIds = record.backgroundPendingIds;
            if (typeof record.pendingBackgroundOverflow === 'boolean') pendingBackgroundOverflow = record.pendingBackgroundOverflow;
            if (typeof record.awaitingReply === 'boolean') awaitingReply = record.awaitingReply;
            if (Number.isSafeInteger(record.awaitingReplyAt) || record.awaitingReplyAt === null) awaitingReplyAt = record.awaitingReplyAt;
            if (record.summary) {
              if (value.type === 'ai-title' || !row.summary) {
                row.summary = record.summary;
                row.summarySource = value.type === 'ai-title' ? 'title' : 'prompt';
                if (value.type === 'ai-title') row.displayName = record.summary;
              }
            }
            // sub-agent tool calls (description) and their results (the spawned agent's id), joined by call id
            for (const spawn of record.spawns || []) { const old = (row.spawns || []).find(x => x.callId === spawn.callId);
              row.spawns = [...(row.spawns || []).filter(x => x !== old), { ...old, ...spawn }].slice(-BOUNDS.subagentsPerSession); }
            // UUID ancestry includes every source row, not only rows understood
            // by this adapter. Unrecognized tool/attachment rows often sit
            // between a message and its next message in Claude's parent chain.
            // Keep their nearest known event ancestor so they do not look like
            // a branch/rewind and erase otherwise valid history.
            const previousTip = tip;
            if (rowUuid && (!record.recognized || record.at === null)) {
              const parentId = parentUuid && ancestry.has(parentUuid)
                ? ancestry.get(parentUuid) : (events.at(-1)?.id || null);
              ancestry.set(rowUuid, parentId);
              tip = rowUuid;
              if (ancestry.size > 256) ancestry.delete(ancestry.keys().next().value);
            }
            if (!record.recognized) continue;
            recognizable = true;
            if (record.execution) row.execution = record.execution;
            if (record.activity) activity = record.activity;
            else if (record.backgroundCompleted) activity = null;
            else if (record.execution?.status === 'idle') activity = null;
            projectName ||= record.projectName;
            if (rowUuid && ancestry.has(rowUuid) && record.events.every(e => !e.id || events.some(old => old.id === e.id))) continue;
            if (record.at !== null && rowUuid !== previousTip && parentUuid && parentUuid !== previousTip) {
              const parent = ancestry.get(parentUuid);
              if (ancestry.has(parentUuid)) {
                if (parent) { const stop = events.findIndex(e => e.id === parent); if (stop >= 0) events.splice(stop + 1); else { events = []; partial = true; } }
              } else { events = []; partial = true; }
            }
            if (value.type === 'system' && value.subtype === 'compact_boundary') { events = []; ancestry.clear(); partial = true; }
            const fresh = record.events.some(e => e.id && !events.some(old => old.id === e.id));
            mergeRecord(events, record); accepted = accepted || record.at !== null;
            if (rowUuid) tip = rowUuid;
            else if (record.at !== null) tip = fallbackId;
            if (record.at !== null) { if (tip) ancestry.set(tip, events.at(-1)?.id || null); if (ancestry.size > 256) ancestry.delete(ancestry.keys().next().value); }
            if (row.initialized && row.readDev===st.dev && row.readIno===st.ino && lineStart >= (row.offset || 0) && fresh && record.at != null) {
              activityAt = Math.max(activityAt || 0, record.at);
            }
            at = Math.max(at || 0, record.at || 0) || null; model = record.model || model;
          }
          if (pending.length > BOUNDS.lineBytes) { pending = Buffer.alloc(0); skip = true; committed = offset; partial = true; stats.oversizeLines = (stats.oversizeLines || 0) + 1; }
          stats.yields++; await turn();
          if (!pending.length && readTotal >= BOUNDS.readBytes) break;
        }
        if (startedAtZero && committed >= st.size && !pending.length) coverageComplete = true;
        await verify(row.chain); const after = await fsp.lstat(row.file); if (!same(st, after) || after.isSymbolicLink() || after.size < committed) throw unsafe();
        if (closed || index.get(key) !== row) return null;
        Object.assign(row, { offset: committed, skip, readDev: st.dev, readIno: st.ino, readMtime: st.mtimeMs, fileGeneration: reset ? st.mtimeMs : row.fileGeneration, initialized: true, activityAt, activity, backgroundPending, backgroundPendingIds, pendingBackgroundOverflow, awaitingReply, awaitingReplyAt, ancestry: [...ancestry], tip, partial, recognizable, startedAtZero, coverageComplete,
          at: at || (reset ? null : row.at) || null, model: model || (reset ? null : row.model) || null, projectName, accepted: accepted || (!reset && row.accepted) });
        let value = transcript(key, events, now());
        while (events.length > 1 && Buffer.byteLength(JSON.stringify(value)) > BOUNDS.cacheBytes / BOUNDS.cacheSessions) { events.shift(); value = transcript(key, events, now()); }
        keep(key, value); if (coverageComplete && !recognizable) throw unsupported(); return value;
      } finally { await fd?.close(); await parent.close(); }
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, operation); return operation;
  }
  return { scan, read, rows: () => [...index.values()], cached: () => [...cache.keys()], agentId, projectRef, stats, bounds: BOUNDS,
    close() { closed = true; for (const key of cache.keys()) removeCache(key); pump(); },
    cacheBytes: () => [...cache.keys()].reduce((n, k) => n + (globalCache.get(prefix + ':' + k)?.size || 0), 0) };
}
module.exports = { createFiles, BOUNDS };
