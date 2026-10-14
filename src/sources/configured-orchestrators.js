'use strict';

const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { orchestratorSourceAdapter, orchestratorSourceCapabilities, detectOrchestratorSource } = require('../adapters');
const { createOrchestratorTeamSnapshots } = require('./orchestrator-team-snapshots');
const { createSourceActivation } = require('./source-activation');

function createConfiguredOrchestrators({ env = process.env, enabled, binaryPath = null, hostId = null, platform = process.platform,
  label = null, run, teamRoot = null, readInbox, log, runtimeIdentityAgents = () => [], runtimeIdentitySessions = () => [], now = Date.now, setIntervalFn, clearIntervalFn } = {}) {
  const detectedPath = detectOrchestratorSource('herdr',{env,binaryPath});
  const resolvedHostId = hostId || 'host_' + createHash('sha256').update(os.hostname() + '\0' + platform).digest('hex').slice(0, 24);
  const platformName = ({ linux: 'linux', darwin: 'macos', win32: 'windows' })[platform] || 'unknown';
  const makeReader = () => detectedPath ? orchestratorSourceAdapter('herdr', { binaryPath: detectedPath, hostId: resolvedHostId,
    orchestratorId: 'herdr_' + resolvedHostId.slice(5), platform: platformName, label, env, run, now, supportsStableSessionRef: true,
    ...(setIntervalFn ? { setIntervalFn } : {}), ...(clearIntervalFn ? { clearIntervalFn } : {}) }) : null;
  const activation=createSourceActivation({configured:enabled,detected:!!detectedPath,capabilities:orchestratorSourceCapabilities('herdr')});
  let active = activation.shouldProbe ? makeReader() : null;
  const validTeamRoot = typeof teamRoot === 'string' && teamRoot.length <= 4096 && !teamRoot.includes('\0') && path.isAbsolute(teamRoot) ? teamRoot : null;
  const inboxEnabled = readInbox === true || (readInbox !== false && env.AO_TEAM_STORE_READ_INBOX === '1');
  const teamStore = validTeamRoot ? orchestratorSourceAdapter('agent-team-pm', { root: validTeamRoot, now, includeInbox: inboxEnabled, log }) : null;
  const snapshots = createOrchestratorTeamSnapshots({ herdr: active,
    runtimeIdentityAgents: () => runtimeIdentityAgents(resolvedHostId),
    runtimeIdentitySessions: () => runtimeIdentitySessions(resolvedHostId), teamStore, now });
  let herdrCheck = null;
  const checkState=()=>{
    const observed=active && snapshots.getSnapshot().orchestrators.find(row=>row.kind==='herdr');
    const result=observed?{status:observed.sourceStatus,checkedAt:observed.observedAt??null}
      :herdrCheck || {status:detectedPath?'not-checked':'not-detected',checkedAt:null};
    activation.observe(result.status==='available');
    return result;
  };
  return Object.freeze({
    getSnapshot: snapshots.getSnapshot, refresh: snapshots.refresh, start: snapshots.start, close: snapshots.close,
    onChange: snapshots.onChange,
    async configureHerdr(value) {
      if (typeof value !== 'boolean') throw new TypeError('Herdr activation must be boolean');
      if (value && !detectedPath) return { enabled: false, reason: 'not-detected' };
      activation.configure(value);
      active = value ? makeReader() : null; snapshots.setHerdr(active);
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
  });
}

module.exports = { createConfiguredOrchestrators };
