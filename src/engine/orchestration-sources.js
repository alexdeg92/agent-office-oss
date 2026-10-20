'use strict';

// Engine-owned admission boundary for orchestration source adapters. Source
// adapters return canonical rows; this registry validates and atomically
// replaces one source generation without knowing any provider vocabulary.
const M = require('../model');
const C = require('./model/canonical');

const TABLES = Object.freeze({
  hosts: ['Host', C.Host],
  orchestrators: ['Orchestrator', C.Orchestrator],
  hostAgents: ['HostAgent', C.HostAgent],
  identityLinks: ['IdentityLink', C.IdentityLink],
  teams: ['Team', C.Team],
  members: ['TeamMember', C.TeamMember],
  tasks: ['Task', C.Task],
  reviews: ['Review', C.Review],
  teamMessages: ['TeamMessage', C.TeamMessage],
});
const MAX_SOURCES = 32;
const MAX_ROWS_PER_TABLE = 5000;
const MAX_ROWS_PER_SNAPSHOT = 10000;
const MAX_BYTES_PER_SOURCE = 2 * 1024 * 1024;
const MAX_BYTES_ALL_SOURCES = 8 * 1024 * 1024;
const MAX_PRIVATE_REFS = 512;
const MAX_PRIVATE_REF_VALUE_LENGTH = 512;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_HOST_LEASE_MS = 120_000;
const MAX_SNAPSHOT_NODES = 500_000;
const MAX_CAPABILITY_KEYS = 128;
const MAX_PARITY_ROWS = 10_000;
const MAX_PARITY_KEYS = 1024;
const MAX_PARITY_SURFACES = 16;
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;

function jsonStringChar(text, index) {
  const code = text.codePointAt(index);
  if (code >= 0xD800 && code <= 0xDFFF) return { code, bytes: 6, advance: 1 }; // JSON escapes unpaired surrogates as \uXXXX.
  return { code, bytes: code <= 0x7F ? 1 : code <= 0x7FF ? 2 : code <= 0xFFFF ? 3 : 4, advance: code > 0xFFFF ? 2 : 1 };
}

function copyCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let keys = 0; const invalid = Symbol('invalid-capability');
  function copy(node, depth) {
    if (depth > 6) return invalid;
    if (node === null || typeof node === 'boolean') return node;
    if (typeof node === 'string') return node.length <= 160 ? node : invalid;
    if (typeof node === 'number') return Number.isFinite(node) ? node : invalid;
    if (typeof node !== 'object') return invalid;
    if (Array.isArray(node)) {
      if (node.length > 32) return invalid;
      const result = node.map(item => copy(item, depth + 1));
      return result.includes(invalid) ? invalid : Object.freeze(result);
    }
    const out = Object.create(null);
    for (const [key, item] of Object.entries(node)) {
      if (++keys > MAX_CAPABILITY_KEYS || key.length > 80) return invalid;
      const copied = copy(item, depth + 1);
      if (copied === invalid) return invalid;
      out[key] = copied;
    }
    return Object.freeze(out);
  }
  const result = copy(value, 0);
  return result === invalid ? null : result;
}

// Compute a conservative JSON byte size without constructing a serialized
// copy. Every recursive step stops once the configured budget is exceeded.
// Source adapters are in-process, but their snapshots may contain unexpectedly
// large strings/collections; admission must not duplicate an oversized payload.
function boundedJsonBytes(root, budget) {
  let bytes = 0, nodes = 0;
  const ancestors = new Set();
  const add = amount => {
    bytes += amount;
    return bytes <= budget;
  };
  function visit(value, depth) {
    if (++nodes > MAX_SNAPSHOT_NODES || depth > 24) return false;
    if (value === null) return add(4);
    if (typeof value === 'boolean') return add(value ? 4 : 5);
    if (typeof value === 'number') return Number.isFinite(value) && add(String(value).length);
    if (typeof value === 'string') {
      if (!add(2)) return false;
      // Count UTF-8 and JSON escapes one code point at a time, stopping as soon
      // as the remaining budget is consumed rather than scanning a huge string.
      for (let i = 0; i < value.length;) {
        const { code, bytes: charBytes, advance } = jsonStringChar(value, i);
        i += advance;
        if (!add(charBytes)) return false;
        if (code === 34 || code === 92) { if (!add(1)) return false; }
        else if (code < 32) { if (!add(5)) return false; }
      }
      return true;
    }
    if (typeof value !== 'object' || value === undefined) return false;
    if (ancestors.has(value)) return false;
    let prototype;
    try { prototype = Object.getPrototypeOf(value); } catch { return false; }
    let canonicalEntity = false;
    try { canonicalEntity = value.constructor?.isEntity === true; } catch { return false; }
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value) && !canonicalEntity) return false;
    ancestors.add(value);
    try {
    if (Array.isArray(value)) {
      if (!add(2)) return false;
      for (let i = 0; i < value.length; i++) {
        if (i && !add(1)) return false;
        let item;
        try { item = value[i]; } catch { return false; }
        if (item === undefined) item = null; // JSON arrays serialize holes as null.
        if (!visit(item, depth + 1)) return false;
      }
      return true;
    }
    if (!add(2)) return false;
    let count = 0;
    try {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        let item;
        try { item = value[key]; } catch { return false; }
        if (item === undefined) continue; // JSON omits undefined object values.
        if (++count > MAX_SNAPSHOT_NODES || (count > 1 && !add(1))) return false;
        if (!add(2)) return false; // quoted key
        for (let i = 0; i < key.length;) {
          const { code, bytes: charBytes, advance } = jsonStringChar(key, i);
          i += advance;
          if (!add(charBytes)) return false;
          if (code === 34 || code === 92) { if (!add(1)) return false; }
          else if (code < 32) { if (!add(5)) return false; }
        }
        if (!add(1)) return false; // colon
        if (!visit(item, depth + 1)) return false;
      }
    } catch { return false; }
    return true;
    } finally { ancestors.delete(value); }
  }
  return visit(root, 0) ? bytes : null;
}

function createOrchestrationSources({ onIssue = () => {}, onChange = () => {}, now = () => Date.now() } = {}) {
  const sources = new Map();
  let closed = false;
  function issue(sourceId, code = 'shape.invalid') {
    try { onIssue({ sourceId, code }); } catch { /* diagnostics cannot stop other sources */ }
  }

  function register(id, adapter, { enabled = true } = {}) {
    const capabilities = copyCapabilities(adapter?.capabilities);
    if (closed || typeof id !== 'string' || !SOURCE_ID.test(id) || !adapter ||
        typeof adapter.readSnapshot !== 'function' || !capabilities) return false;
    if (!sources.has(id) && sources.size >= MAX_SOURCES) return false;
    const prior = sources.get(id);
    if (prior?.adapter && prior.adapter !== adapter) {
      try { prior.adapter.stop?.(); prior.adapter.close?.(); } catch { issue(id, 'source.close-failed'); }
    }
    sources.set(id, { id, adapter, capabilities, enabled: enabled === true, status: enabled ? 'unavailable' : 'disabled',
      observedAt: null, rows: emptyRows(), privateRefs: Object.freeze({}), quality: { invalidRows: 0, invalidRowsByTable: Object.create(null) }, lastError: null });
    sources.get(id).bytes = 0;
    sources.get(id).issuedGeneration = 0;
    sources.get(id).generation = 0;
    return true;
  }

  function emptyRows() { return Object.fromEntries(Object.keys(TABLES).map(key => [key, []])); }

  function reserveGeneration(source) {
    if (source.issuedGeneration >= Number.MAX_SAFE_INTEGER) return null;
    source.issuedGeneration++;
    return source.issuedGeneration;
  }

  function reject(source, id, code) {
    issue(id, code);
    source.status = source.observedAt === null ? 'unavailable' : 'stale';
    source.lastError = code;
    return { ok: false, issue: code };
  }

  function ingestGeneration(id, snapshot, { observedAt = now(), generation, sourceRef } = {}) {
    const source = sources.get(id);
    if (!source || !source.enabled || closed) return { ok: false, issue: 'source-unavailable' };
    if (sourceRef && source !== sourceRef) return { ok: false, issue: 'stale-generation' };
    if (generation !== source.issuedGeneration) return { ok: false, issue: 'stale-generation' };
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return reject(source, id, 'invalid-snapshot');
    }
    if (!Number.isSafeInteger(observedAt) || observedAt > now() + MAX_CLOCK_SKEW_MS) return reject(source, id, 'invalid-observation-time');
    const inputTables = Object.create(null);
    let totalRows = 0;
    for (const table of Object.keys(TABLES)) {
      let input;
      try { input = snapshot[table] === undefined ? [] : snapshot[table]; }
      catch { return reject(source, id, 'invalid-table'); }
      if (!Array.isArray(input) || input.length > MAX_ROWS_PER_TABLE) return reject(source, id, 'invalid-table');
      totalRows += input.length;
      if (totalRows > MAX_ROWS_PER_SNAPSHOT) return reject(source, id, 'row-limit');
      inputTables[table] = input;
    }
    // Count only the envelope fields and row arrays that can be admitted. This
    // bounded walk runs before row conversion and stops without serializing a
    // JSON copy when the byte budget is exceeded.
    const budgetEnvelope = { ...inputTables };
    for (const field of ['status', 'observedAt']) {
      if (Object.hasOwn(snapshot, field)) {
        try { budgetEnvelope[field] = snapshot[field]; } catch { return reject(source, id, 'invalid-snapshot'); }
      }
    }
    const publicBytes = boundedJsonBytes(budgetEnvelope, MAX_BYTES_PER_SOURCE);
    if (publicBytes === null) return reject(source, id, 'source-byte-limit');
    const rows = emptyRows(), invalidRowsByTable = Object.create(null); let invalidRows = 0;
    for (const [table, [entityName, schema]] of Object.entries(TABLES)) {
      const input = inputTables[table];
      const Entity = M[entityName];
      const admitted = [];
      for (const item of input) {
        let row = null;
        try { row = Entity?.from(item); } catch { row = null; }
        if (row && table === 'hostAgents' && (!Number.isSafeInteger(row.observedAt) || !Number.isSafeInteger(row.staleAfter)
            || row.observedAt > now() + MAX_CLOCK_SKEW_MS || row.observedAt > observedAt + MAX_CLOCK_SKEW_MS
            || row.staleAfter < row.observedAt || row.staleAfter - row.observedAt > MAX_HOST_LEASE_MS)) row = null;
        if (!row) { invalidRows++; invalidRowsByTable[table] = (invalidRowsByTable[table] || 0) + 1; issue(id); continue; }
        admitted.push(row);
      }
      rows[table] = Object.freeze(admitted);
    }
    const privateDescriptor = Object.getOwnPropertyDescriptor(snapshot, 'privateRefs');
    // Native session/pane references must not be enumerable on an adapter's
    // ordinary snapshot object, where diagnostic or logging code could copy them.
    if (privateDescriptor?.enumerable) return reject(source, id, 'invalid-private-index');
    const privateRefs = privateDescriptor && !privateDescriptor.enumerable ? privateDescriptor.value : undefined;
    if (privateRefs != null && (typeof privateRefs !== 'object' || Array.isArray(privateRefs))) {
      return reject(source, id, 'invalid-private-index');
    }
    // The private index is accessible only through the trusted engine method;
    // it is excluded from every enumerable/public snapshot and diagnostic.
    const privateCopy = Object.create(null);
    let privateRefCount = 0;
    for (const key in privateRefs || {}) {
      if (!Object.hasOwn(privateRefs, key)) continue;
      if (++privateRefCount > MAX_PRIVATE_REFS) return reject(source, id, 'invalid-private-index');
      let value;
      try { value = privateRefs[key]; } catch { return reject(source, id, 'invalid-private-index'); }
      if (key.length > 256 || !value || typeof value !== 'object' || Array.isArray(value)) return reject(source, id, 'invalid-private-index');
      const safe = {};
      for (const field of ['hostId', 'runtimeKind', 'sessionRef', 'sessionKey', 'paneRef', 'memberId']) {
        const item = value[field];
        if (item !== undefined && (typeof item !== 'string' || item.length === 0 || item.length > MAX_PRIVATE_REF_VALUE_LENGTH || item.includes('\0'))) {
          return reject(source, id, 'invalid-private-index');
        }
        if (typeof item === 'string') safe[field] = item;
      }
      privateCopy[key] = Object.freeze(safe);
    }
    const privateBytes = Object.entries(privateCopy).reduce((total, [key, value]) => total + Buffer.byteLength(key, 'utf8')
      + Object.entries(value).reduce((sum, [field, item]) => sum + Buffer.byteLength(field, 'utf8') + Buffer.byteLength(item, 'utf8'), 0), 0);
    const candidateBytes = publicBytes + privateBytes;
    if (candidateBytes > MAX_BYTES_PER_SOURCE) return reject(source, id, 'source-byte-limit');
    let registryBytes = 0;
    for (const other of sources.values()) registryBytes += other.bytes || 0;
    if (registryBytes - source.bytes + candidateBytes > MAX_BYTES_ALL_SOURCES) return reject(source, id, 'registry-byte-limit');
    source.rows = Object.freeze(rows);
    source.privateRefs = Object.freeze(privateCopy);
    source.observedAt = observedAt;
    source.bytes = candidateBytes;
    source.generation = generation;
    source.status = snapshot.status === 'stale' ? 'stale' : 'available';
    source.lastError = null;
    source.quality = { invalidRows: Math.min(MAX_ROWS_PER_TABLE, invalidRows), invalidRowsByTable: Object.freeze(invalidRowsByTable) };
    try { onChange({ sourceId: id, observedAt: source.observedAt }); } catch { /* isolate observers */ }
    return { ok: true, invalidRows: source.quality.invalidRows };
  }

  function ingest(id, snapshot, options = {}) {
    const source = sources.get(id);
    if (!source || !source.enabled || closed) return { ok: false, issue: 'source-unavailable' };
    const generation = reserveGeneration(source);
    if (generation === null) return reject(source, id, 'source-generation-limit');
    return ingestGeneration(id, snapshot, { ...options, generation });
  }

  async function refresh(id) {
    const source = sources.get(id);
    if (!source || !source.enabled || closed) return { ok: false, issue: 'source-unavailable' };
    const generation = reserveGeneration(source);
    if (generation === null) return reject(source, id, 'source-generation-limit');
    try {
      const snapshot = await source.adapter.readSnapshot();
      if (sources.get(id) !== source || source.issuedGeneration !== generation) return { ok: false, issue: 'stale-generation' };
      return ingestGeneration(id, snapshot, { observedAt: snapshot?.observedAt ?? now(), generation, sourceRef: source });
    } catch {
      if (sources.get(id) !== source || source.issuedGeneration !== generation) return { ok: false, issue: 'stale-generation' };
      source.status = source.observedAt === null ? 'unavailable' : 'stale';
      source.lastError = 'read-failed'; issue(id, 'source.read-failed');
      return { ok: false, issue: 'read-failed' };
    }
  }

  function canonicalSnapshot() {
    const result = emptyRows();
    for (const source of sources.values()) if (source.enabled && ['available', 'stale'].includes(source.status) && source.observedAt !== null) {
      for (const table of Object.keys(TABLES)) result[table].push(...source.rows[table]);
    }
    for (const table of Object.keys(TABLES)) result[table] = Object.freeze(result[table]);
    return Object.freeze(result);
  }

  function projectionSnapshot() {
    const rows = canonicalSnapshot();
    const states = status();
    const privateSources = Object.create(null);
    for (const source of sources.values()) {
      if (source.enabled && ['available', 'stale'].includes(source.status) && source.observedAt !== null) {
        privateSources[source.id] = source.privateRefs;
      }
    }
    const snapshot = { ...rows, sourceStatus: states,
      sourcesReady: states.every(row => row.status !== 'unavailable') };
    Object.defineProperty(snapshot, 'privateSources', { enumerable: false, value: Object.freeze(privateSources) });
    return Object.freeze(snapshot);
  }

  function privateSourceRefs(id) {
    const source = sources.get(id);
    return source?.enabled && ['available', 'stale'].includes(source.status) && source.observedAt !== null ? source.privateRefs : Object.freeze({});
  }

  function capabilities(id) {
    return sources.get(id)?.capabilities || null;
  }

  function status() {
    return [...sources.values()].map(source => ({ id: source.id, enabled: source.enabled, status: source.status,
      capabilities: source.capabilities,
      observedAt: source.observedAt, counts: Object.fromEntries(Object.keys(TABLES).map(table => [table, source.rows[table].length])),
      invalidRows: source.quality.invalidRows, invalidRowsByTable: { ...source.quality.invalidRowsByTable }, lastError: source.lastError }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  function setEnabled(id, enabled) {
    const source = sources.get(id); if (!source || typeof enabled !== 'boolean') return false;
    source.enabled = enabled;
    if (!enabled) source.status = 'disabled';
    else if (source.status === 'disabled') source.status = source.observedAt === null ? 'unavailable' : 'stale';
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const source of sources.values()) try { source.adapter.stop?.(); source.adapter.close?.(); } catch { issue(source.id, 'source.close-failed'); }
    sources.clear();
  }

  return Object.freeze({ register, ingest, refresh, canonicalSnapshot, projectionSnapshot, privateSourceRefs, capabilities, status, setEnabled, close });
}

// Compare only approved, value-free semantic fields. Return aggregate counts;
// neither identifiers nor source values are retained or logged.
const PARITY_FIELDS = new Set(['id', 'parentId', 'parentKey', 'teamId', 'teamIds', 'groupId', 'order', 'floorId', 'stationUid',
  'state', 'stateLabel', 'status', 'evidenceLevel', 'observedAt', 'staleAfter', 'roleKind', 'hostRole', 'hostStatus']);
function compareProjection(oldValue, newValue, fields = ['id', 'parentId', 'state', 'status']) {
  if (!Array.isArray(fields) || fields.length > PARITY_FIELDS.size || fields.some(field => !PARITY_FIELDS.has(field))) {
    throw new TypeError('unsupported parity field');
  }
  const rows = value => Array.isArray(value) ? value : Array.isArray(value?.occupants) ? value.occupants : [];
  const leftRows = rows(oldValue), rightRows = rows(newValue);
  if (leftRows.length > MAX_PARITY_ROWS || rightRows.length > MAX_PARITY_ROWS) throw new TypeError('parity row limit');
  const summarize = value => rows(value).map((row, position) => ({
    id: typeof row?.id === 'string' ? row.id : '', position,
    values: fields.map(field => row?.[field] ?? null),
  })).sort((a, b) => a.id.localeCompare(b.id) || a.position - b.position);
  const left = summarize(oldValue), right = summarize(newValue);
  const limit = Math.min(MAX_PARITY_KEYS, Math.max(left.length, right.length));
  let changedRows = 0, overflowKeys = 0;
  const comparePair = (a, b) => a.id !== b.id || a.position !== b.position || JSON.stringify(a.values) !== JSON.stringify(b.values);
  let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    let changed = false;
    if (i >= left.length) { j++; changed = true; }
    else if (j >= right.length) { i++; changed = true; }
    else if (left[i].id < right[j].id) { i++; changed = true; }
    else if (left[i].id > right[j].id) { j++; changed = true; }
    else { changed = comparePair(left[i], right[j]); i++; j++; }
    if (changed) {
      if (changedRows < limit) changedRows++;
      else overflowKeys++;
    }
  }
  return Object.freeze({ compared: Math.max(left.length, right.length), oldCount: left.length, newCount: right.length,
    changedRows, overflowKeys, equal: changedRows === 0 && overflowKeys === 0 });
}

module.exports = { createOrchestrationSources, compareProjection, MAX_SOURCES, MAX_ROWS_PER_TABLE, MAX_ROWS_PER_SNAPSHOT,
  MAX_BYTES_PER_SOURCE, MAX_BYTES_ALL_SOURCES, MAX_PRIVATE_REFS, MAX_PARITY_ROWS, MAX_PARITY_KEYS, MAX_PARITY_SURFACES,
  boundedJsonBytes, TABLES };
