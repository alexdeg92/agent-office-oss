'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { Host, Orchestrator, HostAgent } = require('../../model');

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_AGENTS = 2000;
const PROCESS_TIMEOUT_MS = 10_000;
const STALE_RETENTION_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 30_000;
const ALLOWED_ENV = new Set(['HOME', 'XDG_RUNTIME_DIR', 'PATH', 'TMPDIR']);
const STATUSES = new Set(['working', 'blocked', 'done', 'idle']);

class HerdrReadError extends Error {
  constructor(code) { super(code); this.name = 'HerdrReadError'; this.code = code; }
}

function safeEnv(env) {
  const out = {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) return out;
  for (const [key, value] of Object.entries(env)) {
    if (ALLOWED_ENV.has(key) && typeof value === 'string' && value.length <= 4096 && !value.includes('\0')) out[key] = value;
  }
  return out;
}

function safeText(value, max) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

// Herdr's native `claude` label names the adapter's canonical runtime ID.
function canonicalRuntimeKind(value) {
  const runtime = safeText(value, 80);
  return runtime === 'claude' ? 'claude-code' : runtime;
}

function stableId(hostId, orchestratorId, paneId) {
  const digest = createHash('sha256').update(JSON.stringify([hostId, orchestratorId, paneId])).digest('hex').slice(0, 32);
  return `ha_${digest}`;
}

function parseSnapshot(stdout, { hostId, orchestratorId, platform = 'unknown', label = null, observedAt, staleAfterMs = STALE_RETENTION_MS,
  supportsStableSessionRef = false } = {}) {
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''));
  if (bytes.byteLength > MAX_OUTPUT_BYTES) throw new HerdrReadError('output_limit');
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch (_) { throw new HerdrReadError('invalid_json'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !(typeof payload.id === 'string' && payload.id.length > 0 && payload.id.length <= 128 || Number.isSafeInteger(payload.id)) ||
      !payload.result || typeof payload.result !== 'object' || Array.isArray(payload.result) ||
      typeof payload.result.type !== 'string' || !payload.result.type || payload.result.type.length > 80 || !Array.isArray(payload.result.agents)) {
    throw new HerdrReadError('unsupported_response');
  }
  if (payload.result.agents.length > MAX_AGENTS) throw new HerdrReadError('row_limit');
  const at = Number.isSafeInteger(observedAt) ? observedAt : Date.now();
  const staleAfter = at + Math.max(0, Math.min(STALE_RETENTION_MS, staleAfterMs));
  const privateIdentityRefs = new Map();
  const privatePaneRefs = new Map();
  const agents = [];
  const seenPanes = new Set();
  for (const source of payload.result.agents) {
    if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.pane_id !== 'string' ||
        !source.pane_id || source.pane_id.length > 256 || typeof source.agent_status !== 'string') {
      throw new HerdrReadError('invalid_snapshot');
    }
    if (seenPanes.has(source.pane_id)) throw new HerdrReadError('invalid_snapshot');
    seenPanes.add(source.pane_id);
    const id = stableId(hostId, orchestratorId, source.pane_id);
    const name = safeText(source.name, 120);
    const runtimeKind = canonicalRuntimeKind(source.agent);
    const row = HostAgent.from({ id, hostId, orchestratorId, name, runtimeKind,
      role: 'unknown', status: STATUSES.has(source.agent_status) ? source.agent_status : 'unknown', observedAt: at, staleAfter });
    if (!row) throw new HerdrReadError('invalid_snapshot');
    agents.push(row);
    privatePaneRefs.set(id, source.pane_id);
    const session = source.agent_session;
    if (supportsStableSessionRef && session && typeof session === 'object' && typeof session.value === 'string' &&
        session.value.length > 0 && session.value.length <= 1024 && !session.value.includes('\0')) {
      privateIdentityRefs.set(id, session.value);
    }
  }
  const host = Host.from({ id: hostId, label: safeText(label, 160), platform, sourceStatus: 'available', observedAt: at });
  const orchestrator = Orchestrator.from({ id: orchestratorId, hostId, kind: 'herdr', label: null, sourceStatus: 'available', observedAt: at });
  if (!host || !orchestrator) throw new HerdrReadError('invalid_configuration');
  return Object.freeze({ host, orchestrator, agents: Object.freeze(agents), privateIdentityRefs, privatePaneRefs });
}

function normaliseBinaryPath(binaryPath) {
  if (typeof binaryPath !== 'string' || !binaryPath || binaryPath.includes('\0') || !path.isAbsolute(binaryPath)) {
    throw new HerdrReadError('binary_not_configured');
  }
  return binaryPath;
}

function createHerdrReader({ binaryPath, hostId, orchestratorId, platform = 'unknown', label = null, env = {}, now = () => Date.now(),
  run = execFileAsync, supportsStableSessionRef = false, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  const binary = normaliseBinaryPath(binaryPath);
  let current = null;
  let inFlight = null;
  let failures = 0;
  let disabled = false;
  let controller = null;
  let generation = 0;
  let nextRetryAt = 0;
  let pollTimer = null;

  const statusSnapshot = (sourceStatus, at) => {
    const host = Host.from({ id: hostId, label: safeText(label, 160), platform, sourceStatus, observedAt: current?.host.observedAt ?? null });
    const orchestrator = Orchestrator.from({ id: orchestratorId, hostId, kind: 'herdr', label: null, sourceStatus,
      observedAt: current?.orchestrator.observedAt ?? null });
    const age = current ? Math.max(0, at - current.host.observedAt) : Infinity;
    const retain = current && age <= STALE_RETENTION_MS;
    return Object.freeze({ host, orchestrator, agents: retain ? current.agents : Object.freeze([]),
      privateIdentityRefs: retain ? current.privateIdentityRefs : new Map(), privatePaneRefs: retain ? current.privatePaneRefs : new Map() });
  };

  async function refresh() {
    if (disabled) return statusSnapshot('unavailable', now());
    if (inFlight) return inFlight;
    const startedAt = now();
    if (startedAt < nextRetryAt) return statusSnapshot(current ? 'stale' : 'unavailable', startedAt);
    const runGeneration = generation;
    controller = new AbortController();
    inFlight = (async () => {
      try {
        const result = await run(binary, ['agent', 'list'], {
          shell: false, windowsHide: true, encoding: 'buffer', timeout: PROCESS_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES, signal: controller.signal, env: safeEnv(env),
        });
        if (disabled || runGeneration !== generation) return statusSnapshot('unavailable', now());
        const snapshot = parseSnapshot(result?.stdout, { hostId, orchestratorId, platform, label, observedAt: now(),
          supportsStableSessionRef });
        current = snapshot; failures = 0; nextRetryAt = 0;
        return snapshot;
      } catch (error) {
        if (disabled || runGeneration !== generation) return statusSnapshot('unavailable', now());
        failures++;
        nextRetryAt = now() + Math.min(60_000, 1000 * (2 ** Math.min(failures - 1, 6)));
        if (error?.code === 'ENOENT') return statusSnapshot('unavailable', now());
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return statusSnapshot('unavailable', now());
        const code = error instanceof HerdrReadError ? error.code : error?.code === 'ETIMEDOUT' ? 'timeout' : error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output_limit' : 'read_failed';
        if (code === 'unsupported_response') return statusSnapshot('unsupported', now());
        const stale = current && now() - current.host.observedAt <= STALE_RETENTION_MS;
        return statusSnapshot(stale ? 'stale' : 'unavailable', now());
      } finally {
        inFlight = null; controller = null;
      }
    })();
    return inFlight;
  }

  function disable() {
    disabled = true;
    generation++;
    if (pollTimer) clearIntervalFn(pollTimer);
    pollTimer = null;
    if (controller) controller.abort();
    current = null;
    nextRetryAt = 0;
  }

  function enable() { disabled = false; nextRetryAt = 0; }

  function start({ onSnapshot = () => {}, intervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
    if (disabled) return false;
    if (typeof onSnapshot !== 'function') throw new TypeError('onSnapshot must be a function');
    const interval = Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS,
      Number.isFinite(intervalMs) ? Math.trunc(intervalMs) : DEFAULT_POLL_INTERVAL_MS));
    if (pollTimer) clearIntervalFn(pollTimer);
    const tick = () => { refresh().then(snapshot => { if (!disabled) onSnapshot(snapshot); }).catch(() => {}); };
    tick();
    pollTimer = setIntervalFn(tick, interval);
    pollTimer?.unref?.();
    return interval;
  }

  function stop() {
    if (pollTimer) clearIntervalFn(pollTimer);
    pollTimer = null;
  }

  return Object.freeze({ refresh, start, stop, disable, enable, get failureCount() { return failures; }, get enabled() { return !disabled; } });
}

module.exports = { createHerdrReader, parseSnapshot, HerdrReadError, MAX_OUTPUT_BYTES, MAX_AGENTS, PROCESS_TIMEOUT_MS,
  STALE_RETENTION_MS, DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS };
