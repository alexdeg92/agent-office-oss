'use strict';

const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { orchestratorSourceAdapter, orchestratorSourceCapabilities, detectOrchestratorSource } = require('../adapters');
const { createOrchestratorTeamSnapshots } = require('./orchestrator-team-snapshots');
const { createMultiTeamStoreReader } = require('./multi-team-store-reader');
const { createSourceActivation } = require('./source-activation');

function createConfiguredOrchestrators({ env = process.env, enabled, binaryPath = null, hostId = null, platform = process.platform,
  label = null, run, teamRoot = null, readInbox, log, engine = null, projectDirectoryHints = () => [], runtimeIdentityAgents = () => [], runtimeIdentitySessions = () => [], now = Date.now, setIntervalFn, clearIntervalFn } = {}) {
  const detectedPath = detectOrchestratorSource('herdr',{env,binaryPath});
  const resolvedHostId = hostId || 'host_' + createHash('sha256').update(os.hostname() + '\0' + platform).digest('hex').slice(0, 24);
  const platformName = ({ linux: 'linux', darwin: 'macos', win32: 'windows' })[platform] || 'unknown';
  const makeReader = () => detectedPath ? orchestratorSourceAdapter('herdr', { binaryPath: detectedPath, hostId: resolvedHostId,
    orchestratorId: 'herdr_' + resolvedHostId.slice(5), platform: platformName, label, env, run, now, supportsStableSessionRef: true,
    ...(setIntervalFn ? { setIntervalFn } : {}), ...(clearIntervalFn ? { clearIntervalFn } : {}) }) : null;
  const activation=createSourceActivation({configured:enabled,detected:!!detectedPath,capabilities:orchestratorSourceCapabilities('herdr')});
  let active = activation.shouldProbe ? makeReader() : null;
  const explicitTeamRoots = [teamRoot, env.AO_TEAM_STORE_ROOT].filter((value, index, rows) => typeof value === 'string' &&
    value.length <= 4096 && !value.includes('\0') && path.isAbsolute(value) && rows.indexOf(value) === index);
  const inboxEnabled = readInbox === true || (readInbox !== false && env.AO_TEAM_STORE_READ_INBOX === '1');
  const teamStore = createMultiTeamStoreReader({ env, explicitRoots: explicitTeamRoots,
    getProjectDirectories: async () => {
      const dirs = [];
      try {
        const provided = await projectDirectoryHints();
        if (Array.isArray(provided)) for (const hint of provided.slice(0, 128)) {
          const cwd = typeof hint === 'string' ? hint : hint?.cwd;
          if (typeof cwd === 'string') dirs.push(cwd);
        }
      } catch { /* one adapter's private hint failure cannot block other stores */ }
      if (active) {
        const latest = active.currentSnapshot || await active.refresh();
        if (latest?.orchestrator?.sourceStatus === 'available') dirs.push(...(latest.privatePaneCwds?.values?.() || []));
      }
      return dirs.slice(0, 128);
    },
    createReader: options => orchestratorSourceAdapter('agent-team-pm', { ...options, now, includeInbox: inboxEnabled, log }),
    now, log, ...(setIntervalFn ? { setIntervalFn } : {}), ...(clearIntervalFn ? { clearIntervalFn } : {}) });
  const snapshots = createOrchestratorTeamSnapshots({ herdr: active,
    runtimeIdentityAgents: () => runtimeIdentityAgents(resolvedHostId),
    runtimeIdentitySessions: () => runtimeIdentitySessions(resolvedHostId), teamStore, now });
  // The readers validate provider data; this bridge admits their canonical
  // rows into the engine and keeps native identity references private there.
  let engineHostRows = null, engineTeamRows = null;
  const hostAdapter = { capabilities: { ...orchestratorSourceCapabilities('herdr'), discovery: { detected: !!detectedPath } }, readSnapshot: async () => engineHostRows || {} };
  const teamAdapter = { capabilities: orchestratorSourceCapabilities('agent-team-pm'), readSnapshot: async () => engineTeamRows || {} };
  const registerSources = () => ({ herdr: engine.registerOrchestrationSource('herdr', hostAdapter, { enabled: !!active }),
    team: engine.registerOrchestrationSource('agent-team-pm', teamAdapter, { enabled: teamStore.hasStores }) });
  let engineRegistered = engine && typeof engine.registerOrchestrationSource === 'function' ? registerSources() : null;
  function withPrivateRefs(rows, refs) {
    Object.defineProperty(rows, 'privateRefs', { enumerable: false, value: Object.freeze(refs) });
    return rows;
  }
  function syncEngine() {
    if (!engineRegistered) return;
    // The runtime controller replaces its engine (and source registry) when the runtime set
    // changes, e.g. the first connector saved on an env-only install. Register again there.
    const listed = new Set((engine.orchestrationSourceStatus?.() || []).map(row => row.id));
    if (!listed.has('herdr') || !listed.has('agent-team-pm')) engineRegistered = registerSources();
    const snapshot = snapshots.getSnapshot();
    engine.setOrchestrationSourceEnabled?.('herdr', !!active);
    engine.setOrchestrationSourceEnabled?.('agent-team-pm', teamStore.hasStores);
    if (engineRegistered.herdr && active && snapshot.hostSourceReady) {
      const refs = Object.create(null);
      for (const [id, value] of Object.entries(snapshot.privateHostRefs || {})) refs[id] = value;
      engineHostRows = withPrivateRefs({ hosts: snapshot.hosts || [], orchestrators: snapshot.orchestrators || [],
        hostAgents: snapshot.agents || [], identityLinks: snapshot.identityLinks || [] }, refs);
      engine.ingestOrchestrationSource('herdr', engineHostRows, { observedAt: snapshot.observedAt,
        sourceRevision: snapshot.hostRevision, identityRevision: snapshot.runtimeIdentityRevision });
    }
    if (engineRegistered.team && teamStore && snapshot.teamSourceReady) {
      const refs = Object.create(null);
      for (const [id, value] of Object.entries(snapshot.privateMemberSessionRefs || {})) refs[id] = value;
      engineTeamRows = withPrivateRefs({ teams: snapshot.teams || (snapshot.team ? [snapshot.team] : []), members: snapshot.members || [],
        tasks: snapshot.tasks || [], reviews: snapshot.reviews || [] }, refs);
      engine.ingestOrchestrationSource('agent-team-pm', engineTeamRows, { observedAt: snapshot.observedAt,
        sourceRevision: snapshot.teamRevision, identityRevision: snapshot.runtimeIdentityRevision });
    }
  }
  const offEngineSync = engineRegistered ? snapshots.onChange(syncEngine) : null;
  let herdrCheck = null;
  const checkState=()=>{
    const observed=active && snapshots.getSnapshot().orchestrators.find(row=>row.kind==='herdr');
    const result=observed?{status:observed.sourceStatus,checkedAt:observed.observedAt??null}
      :herdrCheck || {status:detectedPath?'not-checked':'not-detected',checkedAt:null};
    activation.observe(result.status==='available');
    return result;
  };
  return Object.freeze({
    getSnapshot: snapshots.getSnapshot,
    async refresh() { await snapshots.refresh(); return snapshots.getSnapshot(); },
    start: snapshots.start,
    close() { offEngineSync?.(); snapshots.close(); teamStore.close(); },
    onChange: snapshots.onChange,
    async configureHerdr(value) {
      if (typeof value !== 'boolean') throw new TypeError('Herdr activation must be boolean');
      if (value && !detectedPath) return { enabled: false, reason: 'not-detected' };
      activation.configure(value);
      active = value ? makeReader() : null; snapshots.setHerdr(active);
      if (engineRegistered) engine.registerOrchestrationSource('herdr', hostAdapter, { enabled: !!active });
      return { enabled: !!active, reason: active ? null : 'disabled' };
    },
    async checkHerdr() {
      if (!detectedPath) {
        herdrCheck = { status: 'not-detected', checkedAt: now() };
        return { found: false, status: 'not-detected', agentCount: 0 };
      }
      const reader = makeReader();
      if (!reader) {
        herdrCheck = { status: 'not-detected', checkedAt: now() };
        return { found: false, status: 'not-detected', agentCount: 0 };
      }
      try {
        const result = await reader.refresh();
        herdrCheck = { status: result.orchestrator.sourceStatus, checkedAt: now() };
        return { found: true, status: result.orchestrator.sourceStatus, agentCount: result.agents.length };
      } catch (error) {
        herdrCheck = { status: 'unavailable', checkedAt: now() };
        throw error;
      } finally { reader.stop(); }
    },
    get active() { checkState();return !!active && activation.enabled; },
    get sourceEnabled() { checkState();return activation.enabled; },
    get detected() { return !!detectedPath; },
    get herdrCheck() { return checkState(); },
    get enabled() { checkState();return activation.enabled&&snapshots.hasHerdr || snapshots.hasTeamStore; },
    get hasHerdr() { checkState();return activation.enabled&&snapshots.hasHerdr; },
    get hasTeamStore() { return snapshots.hasTeamStore; },
    get teamCapabilities() { return orchestratorSourceCapabilities('agent-team-pm'); },
    get chatPaneMessaging() { return orchestratorSourceCapabilities('herdr').chatPaneMessaging || null; },
    async sendPaneText(args) {
      const capability = orchestratorSourceCapabilities('herdr').chatPaneMessaging;
      if (!active || capability?.sendText !== true || capability?.exactPaneIdentity !== true) throw new Error('pane messaging is unavailable');
      await snapshots.refresh();
      return snapshots.sendPaneText(args);
    },
  });
}

module.exports = { createConfiguredOrchestrators };
