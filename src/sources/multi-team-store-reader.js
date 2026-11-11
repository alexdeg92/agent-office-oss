'use strict';

const { discoverTeamStoreRoots, MAX_EXPLICIT_STORES } = require('./team-store-discovery');

const MAX_STORES = 16;

function createMultiTeamStoreReader({ env = process.env, explicitRoot = null, explicitRoots = null, getProjectDirectories = () => [], createReader,
  now = Date.now, log, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  if (typeof createReader !== 'function') throw new TypeError('createReader is required');
  const readers = new Map();
  let current = null;
  let inFlight = null;
  let timer = null;
  let closed = false;
  let activeStores = [];
  let lastReadErrorCount = 0;
  const extraRoots = (Array.isArray(explicitRoots) ? explicitRoots : explicitRoot == null ? [] : [explicitRoot])
    .filter(root => typeof root === 'string').slice(0, MAX_EXPLICIT_STORES);

  function rootsFor(projectDirectories) {
    return discoverTeamStoreRoots({ projectDirectories, env, explicitRoots: extraRoots }).stores;
  }

  function removeReader(entry) {
    try { entry.reader.stop?.(); entry.reader.disable?.(); entry.reader.close?.(); } catch { /* isolated store cleanup */ }
  }

  for (const candidate of rootsFor([])) {
    try {
      const reader = createReader({ root: candidate.root, label: candidate.label, now, log });
      if (reader) {
        const entry = { root: candidate.root, label: candidate.label, reader, snapshot: null };
        readers.set(candidate.root, entry); activeStores.push(entry);
      }
    } catch (_) { /* explicit source failures do not abort application startup */ }
  }

  function aggregate() {
    const stores = activeStores.filter(entry => entry.snapshot?.team).sort((a, b) => a.root.localeCompare(b.root));
    const acceptedStores = [];
    const members = [], tasks = [], reviews = [], messages = [];
    const privateMemberRefs = Object.create(null), seenMembers = new Set();
    let skippedTaskCount = 0, skippedMemberCount = 0, unknownFields = 0, storeErrorCount = lastReadErrorCount;
    for (const entry of stores) {
      const snapshot = entry.snapshot;
      if (snapshot.team.status === 'stale') storeErrorCount++;
      const duplicateMember = snapshot.members.some(member => seenMembers.has(member.id));
      if (duplicateMember) { storeErrorCount++; continue; }
      acceptedStores.push(entry);
      for (const member of snapshot.members) {
        seenMembers.add(member.id); members.push(member);
        const ref = snapshot.privateMemberRefs?.[member.id];
        if (ref) privateMemberRefs[member.id] = ref;
      }
      tasks.push(...snapshot.tasks); reviews.push(...snapshot.reviews); messages.push(...(snapshot.messages || []));
      skippedTaskCount += snapshot.diagnostics?.skippedTaskCount || 0;
      skippedMemberCount += snapshot.diagnostics?.skippedMemberCount || 0;
      unknownFields += snapshot.diagnostics?.unknownFields || 0;
    }
    const teams = acceptedStores.map(entry => entry.snapshot.team);
    const result = { team: teams[0] || null, teams: Object.freeze(teams), members: Object.freeze(members), tasks: Object.freeze(tasks),
      reviews: Object.freeze(reviews), messages: Object.freeze(messages), diagnostics: Object.freeze({ skippedTaskCount: Math.min(5000, skippedTaskCount),
        skippedMemberCount: Math.min(5000, skippedMemberCount), storeErrorCount: Math.min(5000, storeErrorCount), unknownFields: Math.min(50_000, unknownFields) }),
      observedAt: now() };
    Object.defineProperty(result, 'privateMemberRefs', { enumerable: false, value: Object.freeze(privateMemberRefs) });
    current = Object.freeze(result);
    return current;
  }

  async function refresh() {
    if (closed) return current || aggregate();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let projectDirectories = [];
      try { projectDirectories = await getProjectDirectories(); } catch { projectDirectories = []; }
      const roots = rootsFor(projectDirectories);
      const wanted = new Set(roots.map(row => row.root));
      for (const [root, entry] of readers) if (!wanted.has(root)) { removeReader(entry); readers.delete(root); }
      activeStores = roots.map(candidate => {
        let entry = readers.get(candidate.root);
        if (!entry) {
          try {
            const reader = createReader({ root: candidate.root, label: candidate.label, now, log });
            if (reader) { entry = { root: candidate.root, label: candidate.label, reader, snapshot: null }; readers.set(candidate.root, entry); }
          } catch (_) { /* a single unsafe/unreadable store cannot block other roots */ }
        }
        return entry;
      }).filter(Boolean);
      let errors = 0;
      await Promise.all(activeStores.map(async entry => {
        try {
          const value = await entry.reader.refresh();
          if (value?.team) entry.snapshot = value;
          else errors++;
        } catch { errors++; }
      }));
      lastReadErrorCount = errors;
      return aggregate();
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function tick(onSnapshot) {
    try { const snapshot = await refresh(); if (!closed) onSnapshot(snapshot); } catch { /* a store refresh is isolated */ }
  }
  function start({ onSnapshot = () => {}, intervalMs = 10_000 } = {}) {
    if (closed || typeof onSnapshot !== 'function') return false;
    if (timer) clearIntervalFn(timer);
    tick(onSnapshot);
    timer = setIntervalFn(() => tick(onSnapshot), Math.max(5_000, Math.min(60_000, Number.isFinite(intervalMs) ? intervalMs : 10_000)));
    timer?.unref?.();
    return true;
  }
  function stop() { if (timer) clearIntervalFn(timer); timer = null; for (const entry of readers.values()) entry.reader.stop?.(); }
  function close() { if (closed) return; closed = true; stop(); for (const entry of readers.values()) removeReader(entry); readers.clear(); activeStores = []; }
  return Object.freeze({ refresh, start, stop, close, get current() { return current; }, get hasStores() { return activeStores.length > 0; },
    get storeCount() { return activeStores.length; }, get errorCount() { return lastReadErrorCount; } });
}

module.exports = { createMultiTeamStoreReader, MAX_STORES };
