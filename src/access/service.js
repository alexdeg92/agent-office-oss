'use strict';

const crypto = require('node:crypto');
const { ApiError, invalid } = require('../api/v2/errors');
const { validateAccessDraft, MODES, PROXIES } = require('./draft');
const { createDnsInspector } = require('./dns-inspection');
const { createAccessProbes } = require('./probes');

const PLAN_TTL_MS = 15 * 60 * 1000;
const JOB_TTL_MS = 60 * 1000;
const MAX_PLANS_PER_ACTOR = 4;
const MAX_JOBS_PER_ACTOR = 2;
const MAX_PLANS_TOTAL = 32;
const MAX_JOBS_TOTAL = 16;
const defaults = Object.freeze({ accessTokenMinutes: 10, refreshIdleHours: 12, refreshAbsoluteDays: 7, partitionedCookie: false });
const localDraft = () => ({ mode: 'local', apiPublicUrl: null, uiOrigins: [], domain: null, proxy: 'manual', security: { ...defaults } });
const clone = value => structuredClone(value);

function createBootAccessRuntime({ access = null, accessRevision = 0, splitAuthEnabled = false, apiPublicUrl = null, allowedOrigins = [] } = {}) {
  const tokenSecurity = require('../security/human-token-policy').HUMAN_TOKEN_SECURITY;
  const effectiveLocal = { ...localDraft(), security: { ...tokenSecurity, partitionedCookie: false } };
  const fallback = { revision: 0, draft: effectiveLocal };
  if (!access) return fallback;
  let draft;
  try { draft = validateAccessDraft(access); } catch { return fallback; }
  const revision = Number.isSafeInteger(accessRevision) && accessRevision > 0 ? accessRevision : 0;
  if (draft.mode === 'local') return { revision, draft: { ...clone(draft), security: { ...tokenSecurity, partitionedCookie: false } } };
  if (draft.mode !== 'public-split-origin' || !splitAuthEnabled || apiPublicUrl !== draft.apiPublicUrl
    || JSON.stringify(allowedOrigins) !== JSON.stringify(draft.uiOrigins)) return fallback;
  return { revision, draft: { ...clone(draft), security: { ...tokenSecurity, partitionedCookie: true } } };
}
function corsPolicyMatches(active, candidate) {
  return active?.draft?.mode === 'public-split-origin' && candidate?.mode === 'public-split-origin'
    && active.draft.apiPublicUrl === candidate.apiPublicUrl
    && active.draft.uiOrigins.length === 1 && candidate.uiOrigins.length === 1
    && active.draft.uiOrigins[0] === candidate.uiOrigins[0];
}

function configDigest(baseRevision, draft) {
  const value = { version: 1, baseRevision, access: draft };
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
function ownerKey(actor) {
  if (!actor || typeof actor.id !== 'string' || !['setup', 'user'].includes(actor.kind)) throw new ApiError('unauthorized');
  return actor.kind + ':' + actor.id;
}
function apiDraftError(error) {
  if (error?.code === 'EACCESSDRAFT' || error?.code === 'EDOMAIN') return invalid(error.field || 'draft.domain', error.issue || 'invalid');
  throw error;
}
function fields(draft, editable = true, reason = null, source = 'config') {
  return Object.fromEntries(['mode', 'apiPublicUrl', 'uiOrigins', 'domain', 'proxy', 'security'].map(key => [key, { source, editable, reason }]));
}
function securityHeaders(draft) {
  return { locked: ['content-security-policy', 'x-frame-options', 'strict-transport-security'],
    connectSrc: draft.mode === 'public-split-origin' ? [...draft.uiOrigins] : [], editable: false };
}
function resolverView(result) {
  return result.resolvers.map(row => ({ id: row.id, state: row.state, records: row.records }));
}
function safeRecords(result) {
  return ['A', 'AAAA', 'CNAME', 'NS'].flatMap(type => result.records[type].slice(0, 16));
}
function reduceDnsObservation(result) {
  const rows = Array.isArray(result?.resolvers) ? result.resolvers : [];
  if (rows.length !== 2) return { state: 'unknown', reason: 'dns.invalid-response' };
  if (rows.some(row => row.state === 'timeout')) return { state: 'unknown', reason: 'dns.timeout' };
  if (rows.some(row => row.state !== 'answered')) return { state: 'unknown', reason: 'dns.invalid-response' };
  const validRecordGroups = row => row.records && ['A', 'AAAA', 'CNAME', 'NS'].every(type => Array.isArray(row.records[type]))
    && ['A', 'AAAA', 'CNAME', 'NS'].every(type => row.records[type].every(record => record && typeof record.name === 'string'
      && typeof record.value === 'string' && Number.isInteger(record.ttl) && record.ttl >= 0 && record.ttl <= 86400));
  if (rows.some(row => !validRecordGroups(row))) return { state: 'unknown', reason: 'dns.invalid-response' };
  const normalize = row => ['A', 'AAAA', 'CNAME', 'NS'].flatMap(type => (row.records?.[type] || [])
    .filter(record => record && typeof record.name === 'string' && typeof record.value === 'string')
    .map(record => `${record.name.toLowerCase()}|${type}|${record.value.toLowerCase()}`)).sort();
  const observations = rows.map(normalize);
  const addresses = rows.some(row => ['A', 'AAAA', 'CNAME'].some(type => (row.records?.[type] || []).length));
  if (!observations[0].length && !observations[1].length) return { state: 'unknown', reason: result.zone ? 'dns.no-records' : 'dns.no-delegation' };
  if (JSON.stringify(observations[0]) !== JSON.stringify(observations[1])) return { state: 'waiting', reason: 'dns.resolver-disagreement' };
  if (!result.zone || !rows.every(row => (row.records?.NS || []).length)) return { state: 'unknown', reason: 'dns.no-delegation' };
  if (!addresses) return { state: 'unknown', reason: 'dns.no-records' };
  return { state: 'passed', reason: null };
}
function makeCheck({ kind, target, perspective = 'server', state = 'idle', observedAt = null, elapsedMs = 0,
  expiresAt = null, reason = null, fix = null, evidence = null, retryAfterMs = null }) {
  return { kind, target, perspective, state, observedAt, elapsedMs, expiresAt, reason, fix, evidence, retryAfterMs };
}

function createExternalAccessService({ settings, cfg = {}, files = {}, store = null, installationId = null, setupEpochCurrent = null,
  bootId = require('../ops/boot-identity').BOOT_ID, env = process.env, inspector = null, requester = null, now = Date.now, randomBytes = crypto.randomBytes } = {}) {
  const dns = inspector || createDnsInspector();
  const probes = createAccessProbes({ inspector: dns, requester, now, env });
  const plans = new Map(), jobs = new Map(), stages = new Map(), pendingPlanCounts = new Map(), diagnosticChallenges = new Map(), invalidSetupEpochs = new Set();
  const installedId = () => installationId || store?.rbac?.state?.().installation_id || null;
  const runtimeAccess = () => typeof cfg.accessRuntime === 'function' ? cfg.accessRuntime() : cfg.accessRuntime || null;
  const activeRevision = () => Number.isSafeInteger(runtimeAccess()?.revision) ? runtimeAccess().revision : 0;
  const activeDraft = () => {
    const active = runtimeAccess();
    if (!active?.draft) return localDraft();
    try { return validateAccessDraft(active.draft); } catch { return localDraft(); }
  };
  const currentRevision = () => settings?.revision?.() ?? 0;
  const currentAccess = () => settings?.accessConfig?.() || files.getConfig?.()?.access || files.config?.access || null;
  const savedAccessRevision = () => settings?.accessRevision?.() ?? files.config?.accessRevision ?? (currentAccess() ? 1 : 0);
  const configuredDraft = () => {
    const access = currentAccess();
    if (!access) return localDraft();
    try { return validateAccessDraft(access); } catch { return localDraft(); }
  };
  function id(prefix) { return prefix + '_' + randomBytes(16).toString('hex'); }
  function authority(req, owner, setup = false) {
    const userId = setup ? null : req.user?.id || req.session?.userId || null;
    const user = userId && store?.users?.byId?.(userId);
    const sessionId = setup ? null : req.session?.sid || req.session?.legacyId || owner;
    const authGeneration = setup ? null : req.session?.authGeneration ?? req.user?.auth_generation ?? user?.auth_generation ?? null;
    const policyFingerprint = userId ? store?.rbac?.fingerprint?.(userId) || [userId, authGeneration, user?.role_id, user?.permission_revision].join(':') : null;
    return { owner, userId, sessionId, sessionExpiresAt: setup ? null : req.session?.exp ?? null, authGeneration, policyFingerprint,
      origin: req.headers?.origin || null,
      setupEpoch: setup ? req.setupCodeEpoch : null, bootId };
  }
  function authorityDigest(value) {
    const { sessionExpiresAt, ...stable } = value;
    return crypto.createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex');
  }
  function contextFor(req, owner, setup = false) { const value = authority(req, owner, setup); return { ...value, digest: authorityDigest(value) }; }
  function contextCurrent(context, req = null) {
    if (!context || context.bootId !== bootId) return false;
    if (context.sessionExpiresAt != null && context.sessionExpiresAt <= now()) return false;
    if (context.setupEpoch) return !invalidSetupEpochs.has(context.setupEpoch)
      && (typeof setupEpochCurrent !== 'function' || setupEpochCurrent(context.setupEpoch));
    if (context.userId) {
      const user = store?.users?.byId?.(context.userId);
      if (user && (user.status !== 'active' || user.auth_generation !== context.authGeneration)) return false;
      if (store?.sessions?.isRevoked?.(context.sessionId)) return false;
      if (store?.rbac?.fingerprint && store.rbac.fingerprint(context.userId) !== context.policyFingerprint) return false;
    }
    if (req) {
      const current = authority(req, context.owner, false);
      if (authorityDigest(current) !== context.digest) return false;
      try { req.authorize?.(); } catch { return false; }
    }
    return true;
  }
  function assertContext(row, req, setup = false) {
    const who = ownerKey(actor(req, setup)), current = contextFor(req, who, setup);
    if (row.context.digest !== current.digest || !contextCurrent(row.context, req)) throw new ApiError('not_found');
    return current;
  }
  function sweep() {
    const time = now();
    for (const [key, row] of plans) if (time >= row.expiresAt) { row.secret = null; plans.delete(key); }
    for (const [key, row] of jobs) if (time >= row.expiresAt) { row.controller.abort(); jobs.delete(key); }
    for (const [key, row] of diagnosticChallenges) if (time >= row.expiresAt) diagnosticChallenges.delete(key);
  }
  function countFor(map, owner) { let n = 0; for (const row of map.values()) if (row.owner === owner) n++; return n; }
  function assertOwned(map, key, owner) {
    const row = map.get(key);
    if (!row || row.owner !== owner || now() >= row.expiresAt) throw new ApiError('not_found');
    return row;
  }
  function stateVm({ setup = false, staged = null } = {}) {
    const stored = setup ? null : configuredDraft();
    const savedRevision = setup ? null : savedAccessRevision();
    const effectiveRevision = setup ? null : activeRevision();
    const effectiveDraft = setup ? localDraft() : activeDraft();
    const saved = setup ? null : { revision: savedRevision, draft: clone(stored) };
    const active = setup ? null : { revision: effectiveRevision, draft: clone(effectiveDraft) };
    const draft = setup ? clone(staged || localDraft()) : clone(stored);
    const pendingActivation = !setup && (savedRevision !== effectiveRevision || JSON.stringify(stored) !== JSON.stringify(effectiveDraft));
    const lockedOrigins = env.AO_ALLOWED_ORIGINS !== undefined;
    const isReadonly = !setup && !!(cfg.readonly || cfg.readonlyStore);
    const fieldMap = fields(draft, !isReadonly, isReadonly ? 'config.readonly' : null, setup ? 'default' : stored ? 'config' : 'default');
    if (lockedOrigins) fieldMap.uiOrigins = { source: 'environment', editable: false, reason: 'config.environment-override' };
    return {
      state: setup ? 'open' : isReadonly ? 'readonly' : 'configured', settingsRevision: setup ? null : currentRevision(), savedRevision, activeRevision: effectiveRevision,
      saved, active, draft, fields: fieldMap,
      choices: { modes: MODES.map(id => ({ id, labelKey: 'access.mode.' + id, descriptionKey: 'access.mode.' + id + '.help' })),
        proxies: PROXIES, dnsProviders: require('./dns-inspection').providers },
      securityDefaults: { accessTokenMinutes: { value: defaults.accessTokenMinutes, min: 5, max: 15 },
        refreshIdleHours: { value: defaults.refreshIdleHours, min: 1, max: 24 },
        refreshAbsoluteDays: { value: defaults.refreshAbsoluteDays, min: 1, max: 30 }, partitionedCookie: defaults.partitionedCookie },
      securityHeaders: securityHeaders(draft), lastVerification: null, pendingActivation, restartRequired: pendingActivation,
    };
  }

  function actor(req, setup = false) {
    if (setup) {
      const code = req.setupCodeEpoch;
      if (typeof code !== 'string' || !code) throw new ApiError('forbidden');
      return { kind: 'setup', id: code };
    }
    const id = req.user?.id || req.session?.userId;
    if (typeof id !== 'string' || !id) throw new ApiError('unauthorized');
    return { kind: 'user', id };
  }

  async function createPlan({ req, draft: input, expectedRevision, setup = false }) {
    sweep();
    const who = ownerKey(actor(req, setup)), captured = contextFor(req, who, setup);
    if (!contextCurrent(captured, req)) throw new ApiError('not_found');
    if (setup) {
      if (expectedRevision !== null) throw invalid('expectedRevision', 'stale');
    } else if (!Number.isInteger(expectedRevision) || expectedRevision !== currentRevision()) throw new ApiError('conflict', { details: [{ issue: 'settings-revision' }] });
    let draft;
    try { draft = validateAccessDraft(input); } catch (error) { throw apiDraftError(error); }
    let imposedOrigins = null;
    if (env.AO_ALLOWED_ORIGINS !== undefined) {
      try { imposedOrigins = require('../security/access-boundary').allowedOrigins(env.AO_ALLOWED_ORIGINS); }
      catch { throw new ApiError('forbidden', { details: [{ issue: 'env-override', field: 'access.uiOrigins' }] }); }
      if (JSON.stringify(imposedOrigins) !== JSON.stringify(draft.uiOrigins)) throw new ApiError('forbidden', { details: [{ issue: 'env-override', field: 'access.uiOrigins' }] });
    }
    const pending = pendingPlanCounts.get(who) || 0;
    const pendingTotal = [...pendingPlanCounts.values()].reduce((sum, value) => sum + value, 0);
    if (countFor(plans, who) + pending >= MAX_PLANS_PER_ACTOR || plans.size + pendingTotal >= MAX_PLANS_TOTAL) throw new ApiError('rate_limited');
    pendingPlanCounts.set(who, pending + 1);
    try {
      const createdAt = now(), planId = id('acp'), expiresAt = createdAt + PLAN_TTL_MS;
      const digest = configDigest(expectedRevision, draft);
      let domains = [];
      if (!['local', 'lan', 'private'].includes(draft.mode)) {
        const observed = await dns.inspect(draft.domain);
        if (currentRevision() !== expectedRevision && !setup || !contextCurrent(captured, req)) throw new ApiError('not_found');
        domains = [{ hostname: observed.hostname, observedAt: observed.observedAt,
          provider: observed.provider, resolvers: resolverView(observed), records: safeRecords(observed),
          proposals: observed.records.A.slice(0, 16).map(record => ({ name: observed.zone && draft.domain !== observed.zone
            ? draft.domain.slice(0, -(observed.zone.length + 1)) || '@' : '@', type: 'A', value: record.value,
            ttl: record.ttl, proxied: draft.proxy === 'cloudflare', source: 'detected-record' })) }];
      }
      const before = configuredDraft();
      const writes = Object.keys(draft).filter(key => !(key === 'uiOrigins' && imposedOrigins) && JSON.stringify(before[key]) !== JSON.stringify(draft[key])).map(key => ({
        target: 'config', field: `access.${key}`, current: clone(before[key]), proposed: clone(draft[key]), source: 'config', editable: true, requiresRestart: true,
      }));
      const checks = [];
      if (domains.length) {
        const target = draft.domain;
        for (const kind of ['dns', 'tls', ...(draft.mode === 'public-split-origin' ? ['cors'] : []), 'public']) checks.push(makeCheck({ kind, target, reason: { key: 'check.not-run' } }));
      }
      const plan = { planId, baseRevision: expectedRevision, configDigest: digest, expiresAt, draft,
        domains, checks, proxy: { detected: null, state: 'unknown' }, artifacts: [],
        securitySummary: { ...draft.security },
        writes,
        externalActions: domains.length ? [{ kind: 'dns', labelKey: 'access.action.reviewDns', required: true, state: 'pending', details: { provider: domains[0].provider.id, domain: draft.domain } }] : [],
        environmentImposed: imposedOrigins ? [{ field: 'access.uiOrigins', source: 'environment', reasonKey: 'config.environment-override' }] : [], restartRequired: true };
      plans.set(planId, { owner: who, context: captured, setup, baseRevision: expectedRevision, draft, digest, expiresAt, plan: clone(plan) });
      return clone(plan);
    } finally {
      const count = pendingPlanCounts.get(who) || 1;
      if (count <= 1) pendingPlanCounts.delete(who); else pendingPlanCounts.set(who, count - 1);
    }
  }

  function startChecks({ req, planId, checks: requested, setup = false }) {
    sweep();
    const who = ownerKey(actor(req, setup)), planRow = assertOwned(plans, planId, who);
    assertContext(planRow, req, setup);
    if (setup !== planRow.setup) throw new ApiError('not_found');
    if (!Array.isArray(requested) || !requested.length || requested.length > 4 || new Set(requested).size !== requested.length
      || requested.some(kind => !['dns', 'tls', 'cors', 'public'].includes(kind) || !planRow.plan.checks.some(check => check.kind === kind))) throw invalid('checks', 'invalid');
    if (countFor(jobs, who) >= MAX_JOBS_PER_ACTOR || jobs.size >= MAX_JOBS_TOTAL) throw new ApiError('rate_limited');
    const jobId = id('acj'), controller = new AbortController();
    const job = { jobId, planId, owner: who, context: planRow.context, setup, request: req, state: 'running', startedAt: now(), expiresAt: now() + JOB_TTL_MS,
      pollAfterMs: 1000, checks: requested.map(kind => makeCheck({ kind, target: planRow.draft.domain || 'local', state: 'running' })), controller };
    jobs.set(jobId, job);
    void runChecks(job, planRow).catch(() => {});
    return { jobId, planId, state: job.state, pollAfterMs: job.pollAfterMs };
  }

  async function runChecks(job, planRow) {
    try {
      const current = () => contextCurrent(job.context, job.request) && (job.setup || currentRevision() === planRow.baseRevision)
        && jobs.get(job.jobId) === job && plans.get(job.planId) === planRow;
      if (job.checks.some(check => check.kind === 'dns') && planRow.draft.domain) {
        if (!current()) { jobs.delete(job.jobId); plans.delete(job.planId); return; }
        const result = await dns.inspect(planRow.draft.domain);
        if (job.controller.signal.aborted || now() >= job.expiresAt || !current()) { jobs.delete(job.jobId); plans.delete(job.planId); return; }
        const check = job.checks.find(row => row.kind === 'dns');
        const reduced = reduceDnsObservation(result);
        Object.assign(check, { state: reduced.state,
          observedAt: result.observedAt, elapsedMs: result.elapsedMs, expiresAt: result.observedAt + 5 * 60 * 1000,
          reason: reduced.reason ? { key: reduced.reason } : null,
          fix: reduced.state === 'passed' ? null : { key: 'access.fix.verifyDelegation' }, evidence: { provider: result.provider, resolvers: resolverView(result) }, retryAfterMs: reduced.state === 'waiting' ? 5000 : null });
      }
      for (const check of job.checks) {
        if (['tls', 'cors'].includes(check.kind)) {
          if (!current()) { jobs.delete(job.jobId); plans.delete(job.planId); return; }
          let diagnostic = null;
          if (check.kind === 'cors') {
            const identity = installedId(), revision = activeRevision(), active = runtimeAccess();
            if (!corsPolicyMatches(active, planRow.draft) || typeof identity !== 'string' || !identity || !Number.isSafeInteger(revision)) {
              Object.assign(check, { state: 'unknown', observedAt: now(), reason: { key: 'access.diagnostic-unavailable' },
                fix: null, evidence: null, retryAfterMs: null });
              continue;
            }
            const nonce = randomBytes(32).toString('hex');
            diagnostic = { nonce, planId: job.planId, installationId: identity, accessRevision: revision };
            diagnosticChallenges.set(nonce, { owner: job.owner, authorityDigest: job.context.digest, planId: job.planId, jobId: job.jobId,
              installationId: identity, accessRevision: revision, contextDigest: job.context.digest, expiresAt: job.expiresAt });
          }
          const result = await probes.run({ draft: planRow.draft, kind: check.kind, signal: job.controller.signal, diagnostic });
          if (job.controller.signal.aborted || now() >= job.expiresAt || !current()) { jobs.delete(job.jobId); plans.delete(job.planId); removeChallenges(job.jobId); return; }
          Object.assign(check, { state: result.state, observedAt: now(), elapsedMs: Math.max(0, now() - job.startedAt),
            expiresAt: now() + 5 * 60 * 1000, reason: result.reason ? { key: result.reason } : null,
            fix: ['failed', 'blocked'].includes(result.state) ? { key: 'access.fix.verifyEndpoint' } : null,
            evidence: result.evidence, retryAfterMs: null });
        } else if (check.kind === 'public') Object.assign(check, { state: 'unknown', reason: { key: 'check.not-run' } });
      }
      if (!job.controller.signal.aborted) job.state = job.checks.some(c => c.state === 'failed' || c.state === 'blocked') ? 'failed'
        : job.checks.some(c => c.state === 'waiting') ? 'waiting' : job.checks.some(c => c.state === 'unknown') ? 'unknown' : 'passed';
    } catch (error) {
      if (!contextCurrent(job.context, job.request)) { jobs.delete(job.jobId); plans.delete(job.planId); removeChallenges(job.jobId); return; }
      const check = job.checks.find(row => row.kind === 'dns');
      if (check && !job.controller.signal.aborted) Object.assign(check, { state: 'unknown', observedAt: now(), reason: { key: error?.code === 'ETIMEDOUT' ? 'dns.timeout' : 'check.capacity-limited' }, fix: { key: 'access.fix.retryDns' } });
      if (!job.controller.signal.aborted) job.state = 'unknown';
    }
  }

  function removeChallenges(jobId) { for (const [nonce, row] of diagnosticChallenges) if (row.jobId === jobId) diagnosticChallenges.delete(nonce); }

  function consumeDiagnosticChallenge({ nonce, planId }) {
    sweep();
    const row = diagnosticChallenges.get(nonce);
    if (!row || row.planId !== planId) throw new ApiError('not_found');
    const job = jobs.get(row.jobId), plan = plans.get(row.planId);
    if (!job || !plan || job.owner !== row.owner || job.planId !== row.planId || job.context.digest !== row.authorityDigest || job.state !== 'running'
      || plan.owner !== row.owner || plan.context.digest !== row.authorityDigest || plan.baseRevision !== currentRevision() || !contextCurrent(job.context, job.request)
      || !corsPolicyMatches(runtimeAccess(), plan.draft) || installedId() !== row.installationId || activeRevision() !== row.accessRevision || now() >= row.expiresAt) {
      diagnosticChallenges.delete(nonce); throw new ApiError('not_found');
    }
    diagnosticChallenges.delete(nonce);
    return { installationId: row.installationId, accessRevision: row.accessRevision, nonce };
  }

  function status({ req, jobId, setup = false }) {
    sweep();
    const who = ownerKey(actor(req, setup)), job = assertOwned(jobs, jobId, who);
    assertContext(job, req, setup);
    if (setup !== job.setup) throw new ApiError('not_found');
    return { jobId: job.jobId, planId: job.planId, state: job.state, elapsedMs: Math.max(0, now() - job.startedAt),
      pollAfterMs: job.state === 'running' || job.state === 'waiting' ? job.pollAfterMs : null,
      checks: clone(job.checks) };
  }
  function cancel({ req, jobId, setup = false }) {
    sweep();
    const who = ownerKey(actor(req, setup)), job = assertOwned(jobs, jobId, who);
    assertContext(job, req, setup);
    if (setup !== job.setup) throw new ApiError('not_found');
    job.controller.abort(); job.state = 'failed';
    for (const check of job.checks) if (['idle', 'running', 'waiting'].includes(check.state)) Object.assign(check, { state: 'unknown', reason: { key: 'check.cancelled' }, fix: null, retryAfterMs: null });
    return { cancelled: true, jobId };
  }

  function stageSetup({ req, planId, expectedRevision, digest }) {
    sweep();
    const who = ownerKey(actor(req, true)), row = assertOwned(plans, planId, who);
    assertContext(row, req, true);
    if (!row.setup || expectedRevision !== null || expectedRevision !== row.baseRevision || digest !== row.digest) throw new ApiError('conflict', { details: [{ issue: 'stale-plan' }] });
    stages.set(who, { draft: clone(row.draft), digest: row.digest, planId, expiresAt: Math.min(row.expiresAt, now() + PLAN_TTL_MS) });
    plans.delete(planId);
    return { staged: true, planId, configDigest: row.digest, restartRequired: true };
  }
  async function applySettings({ req, planId, expectedRevision, digest, publish }) {
    sweep();
    const who = ownerKey(actor(req)), row = assertOwned(plans, planId, who);
    assertContext(row, req, false);
    if (row.setup || row.applying || expectedRevision !== row.baseRevision || expectedRevision !== currentRevision()
      || typeof digest !== 'string' || digest !== row.digest || digest !== configDigest(expectedRevision, row.draft)) {
      throw new ApiError('conflict', { details: [{ issue: 'stale-plan' }] });
    }
    if (typeof publish !== 'function') throw new TypeError('access publisher required');
    row.applying = true;
    try {
      const result = await publish({ draft: clone(row.draft), expectedRevision, configDigest: row.digest });
      plans.delete(planId);
      return result;
    } catch (error) { row.applying = false; throw error; }
  }
  function stagedSetup(actorValue) {
    sweep(); const who = ownerKey(actorValue); const row = stages.get(who);
    return row && now() < row.expiresAt ? clone(row.draft) : null;
  }
  function clearSetup(actorValue) {
    const who = ownerKey(actorValue); stages.delete(who);
    if (actorValue.kind === 'setup') { invalidSetupEpochs.add(actorValue.id); if (invalidSetupEpochs.size > 128) invalidSetupEpochs.delete(invalidSetupEpochs.values().next().value); }
    for (const [key, row] of plans) if (row.owner === who) plans.delete(key);
    for (const [key, row] of jobs) if (row.owner === who) { row.controller.abort(); jobs.delete(key); removeChallenges(key); }
  }
  function close() { for (const row of jobs.values()) row.controller.abort(); jobs.clear(); plans.clear(); stages.clear(); pendingPlanCounts.clear(); diagnosticChallenges.clear(); }

  return Object.freeze({ stateVm, createPlan, startChecks, status, cancel, stageSetup, stagedSetup, clearSetup, consumeDiagnosticChallenge,
    applySettings, close,
  configDigest, limits: Object.freeze({ PLAN_TTL_MS, JOB_TTL_MS, MAX_PLANS_PER_ACTOR, MAX_JOBS_PER_ACTOR, MAX_PLANS_TOTAL, MAX_JOBS_TOTAL }) });
}

module.exports = { createExternalAccessService, createBootAccessRuntime, configDigest, reduceDnsObservation, PLAN_TTL_MS, JOB_TTL_MS, MAX_PLANS_PER_ACTOR, MAX_JOBS_PER_ACTOR, MAX_PLANS_TOTAL, MAX_JOBS_TOTAL };
