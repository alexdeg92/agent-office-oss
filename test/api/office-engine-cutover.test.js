'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const officeModule = require('../../src/api/v2/vm/office');
const legacyBaseBuilder = officeModule.buildOfficeVM;
// Install before routes.js/views.js imports the builder. The legacy builder
// is used only by the independent parity shadow; the engine builder serves
// the response. Track both calls so the test proves the paths stay separate.
let legacyBaseBuilds = 0;
officeModule.buildOfficeVM = (...args) => { legacyBaseBuilds++; return legacyBaseBuilder(...args); };
const { settingsFixture } = require('../helpers/settings-fixture');
const { createConfiguredOrchestrators } = require('../../src/sources/configured-orchestrators');

test('Office consumes canonical engine source rows and dual-run parity is clean for a prod-shaped team', async t => {
  let source;
  let hostStatus = 'working';
  let canReadSessions = true;
  let now = Date.parse('2026-10-16T15:00:00Z');
  let servedCanonicalSnapshot = null;
  const principal = { id: 'office-engine-owner', role: 'admin', permissionRevision: 1 };
  let fixture;
  t.after(async () => {
    source?.close();
    await fixture?.close();
    officeModule.buildOfficeVM = legacyBaseBuilder;
  });
  fixture = await settingsFixture({ officeEngineOrchestration: true, sourcePrincipalFor: () => principal,
    sessionsReadable: () => canReadSessions, now: () => now,
    viewEngine: raw => new Proxy(raw, { get(target, key) {
      if (key === 'orchestrationProjectionSnapshot') return () => servedCanonicalSnapshot || target.orchestrationProjectionSnapshot();
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }),
    orchestratorTeams: ({ tmp, engine }) => {
      const root = path.join(tmp, 'team-store');
      for (const directory of ['members', 'tasks', 'inbox']) fs.mkdirSync(path.join(root, directory), { recursive: true });
      const leadId = 'member:11111111-1111-4111-8111-111111111111';
      const otherLeadId = 'member:22222222-2222-4222-8222-222222222222';
      const workerPath = path.join(root, 'members', 'worker.json');
      fs.writeFileSync(path.join(root, 'members', 'lead.json'), JSON.stringify({
        id: leadId, name: 'Release lead', role: 'lead', runtime: 'codex',
        herdrPane: 'pane-lead', session: { source: 'herdr:codex', kind: 'agent_session', value: 'session-lead' }, spawnedBy: null,
      }));
      fs.writeFileSync(path.join(root, 'members', 'other-lead.json'), JSON.stringify({
        id: otherLeadId, name: 'Other lead', role: 'lead', runtime: 'codex',
        herdrPane: 'pane-other-lead', session: { source: 'herdr:codex', kind: 'agent_session', value: 'session-other-lead' }, spawnedBy: null,
      }));
      fs.writeFileSync(workerPath, JSON.stringify({
        id: 'member:33333333-3333-4333-8333-333333333333', name: 'Release worker', role: 'member', runtime: 'codex',
        herdrPane: 'pane-worker', session: { source: 'herdr:codex', kind: 'agent_session', value: 'session-worker' }, spawnedBy: leadId,
      }));
      source = createConfiguredOrchestrators({ engine, env: { HOME: tmp, PATH: '' }, binaryPath: '/fixture/bin/herdr', enabled: true,
        hostId: 'host_engine_fixture', teamRoot: root, now: () => now,
        run: async () => ({ stdout: Buffer.from(JSON.stringify({ id: 'fixture', result: { type: 'ok', agents: [
          { pane_id: 'pane-lead', agent: 'codex', name: 'Release lead', agent_status: hostStatus, agent_session: { value: 'session-lead' } },
          { pane_id: 'pane-other-lead', agent: 'codex', name: 'Other lead', agent_status: hostStatus, agent_session: { value: 'session-other-lead' } },
          { pane_id: 'pane-worker', agent: 'codex', name: 'Release worker', agent_status: hostStatus, agent_session: { value: 'session-worker' } },
        ] } })) }),
      });
      return source;
    } });
  const sourceGenerationsAligned = () => {
    const compatibility = source.getSnapshot();
    const canonical = fixture.engine.orchestrationProjectionSnapshot();
    const revisions = canonical?.sourceRevisions || {};
    const identities = canonical?.identityRevisions || {};
    return compatibility?.sourcesReady === true
      && revisions.herdr === compatibility.hostRevision
      && revisions['agent-team-pm'] === compatibility.teamRevision
      && Number.isSafeInteger(compatibility.runtimeIdentityRevision)
      && identities.herdr === compatibility.runtimeIdentityRevision
      && identities['agent-team-pm'] === compatibility.runtimeIdentityRevision;
  };
  const waitForSourceAlignment = () => {
    if (sourceGenerationsAligned()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      let timer;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (sourceGenerationsAligned()) finish();
      };
      unsubscribe = source.onChange(check);
      timer = setTimeout(() => finish(new Error('Office source generations did not align before the test deadline')), 5_000);
      check();
    });
  };
  await fixture.orchestratorTeams.refresh();
  await waitForSourceAlignment();
  servedCanonicalSnapshot = fixture.engine.orchestrationProjectionSnapshot();

  const response = await fixture.get('/api/v3/views/office');
  assert.equal(response.status, 200, response.text);
  assert.ok(legacyBaseBuilds > 0, 'the independent legacy builder runs only for shadow parity');
  const member = response.json.data.occupants.find(row => row.name === 'Release lead');
  assert.ok(member, 'the engine-admitted member appears in Office');
  assert.equal(member.hostStatus, 'working');
  const otherLead = response.json.data.occupants.find(row => row.name === 'Other lead');
  const worker = response.json.data.occupants.find(row => row.name === 'Release worker');
  assert.ok(otherLead && worker);
  assert.equal(worker.parentId, member.id, 'the registered worker is initially grouped under its exact lead');
  const counters = fixture.engine.orchestrationParityCounters();
  const skippedBeforeSourceSkew = counters.office?.skippedUnsynced || 0;
  assert.deepEqual(counters.office && { comparisons: counters.office.comparisons, mismatches: counters.office.mismatches,
    changedRows: counters.office.changedRows, overflowKeys: counters.office.overflowKeys },
  { comparisons: 1, mismatches: 0, changedRows: 0, overflowKeys: 0 });

  // Simulate the bounded poll window: compatibility has ingested a newer
  // Herdr observation while the engine response still exposes its prior
  // admitted source generation. The served Office remains a coherent prior
  // identity/parent (never a cross-generation join), parity is skipped rather
  // than marked equal, then the next engine poll converges.
  const workerFile = path.join(fixture.tmp, 'team-store', 'members', 'worker.json');
  const changedWorker = JSON.parse(fs.readFileSync(workerFile, 'utf8'));
  changedWorker.name = 'Renamed worker';
  changedWorker.spawnedBy = 'member:22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(workerFile, JSON.stringify(changedWorker));
  await fixture.orchestratorTeams.refresh();
  await waitForSourceAlignment();
  fixture.api.topics.invalidate('office'); fixture.api.topics.invalidate('office-scope');
  const duringSourceSkew = await fixture.get('/api/v3/views/office');
  assert.equal(duringSourceSkew.status, 200, duringSourceSkew.text);
  const staleMember = duringSourceSkew.json.data.occupants.find(row => row.id === member.id);
  assert.equal(staleMember.name, 'Release lead', 'source skew retains the prior registered identity, not another agent name');
  assert.equal(staleMember.parentId, null, 'source skew retains the prior canonical parent instead of borrowing runtime lineage');
  assert.equal(staleMember.hostStatus, 'working', 'the permitted one-poll stale Office remains internally consistent');
  const staleWorker = duringSourceSkew.json.data.occupants.find(row => row.id === worker.id);
  assert.equal(staleWorker.name, 'Release worker', 'a different source generation cannot substitute another registered member name');
  assert.equal(staleWorker.name === otherLead.name, false);
  assert.equal(staleWorker.parentId, member.id, 'source skew keeps the old exact parent instead of a different team lead');
  const parityAfterSourceSkew = fixture.engine.orchestrationParityCounters().office;
  assert.ok(parityAfterSourceSkew?.comparisons === 1
    && parityAfterSourceSkew.skippedUnsynced > skippedBeforeSourceSkew,
  'the deliberately unaligned generation increments the inconclusive counter without assuming a single topic rebuild');
  assert.deepEqual(fixture.engine.orchestrationParityCounters().office && {
    comparisons: fixture.engine.orchestrationParityCounters().office.comparisons,
    mismatches: fixture.engine.orchestrationParityCounters().office.mismatches,
  }, { comparisons: 1, mismatches: 0 }, 'an unaligned generation is skipped, never counted as a match or mismatch');
  servedCanonicalSnapshot = fixture.engine.orchestrationProjectionSnapshot();
  fixture.api.topics.invalidate('office'); fixture.api.topics.invalidate('office-scope');
  const afterSourceConvergence = await fixture.get('/api/v3/views/office');
  assert.equal(afterSourceConvergence.status, 200, afterSourceConvergence.text);
  const convergedMember = afterSourceConvergence.json.data.occupants.find(row => row.id === member.id);
  assert.equal(convergedMember.name, 'Release lead');
  assert.equal(convergedMember.parentId, null);
  assert.equal(convergedMember.hostStatus, 'working', 'the engine Office converges as soon as its matching source generation is served');
  const convergedWorker = afterSourceConvergence.json.data.occupants.find(row => row.id === worker.id);
  assert.equal(convergedWorker.name, 'Renamed worker');
  assert.equal(convergedWorker.parentId, otherLead.id, 'the next matching generation converges to the new registered parent');
  assert.equal(fixture.engine.orchestrationParityCounters().office?.mismatches, 0);
  now += 1_000;
  hostStatus = 'idle';
  await fixture.orchestratorTeams.refresh();
  await waitForSourceAlignment();
  servedCanonicalSnapshot = fixture.engine.orchestrationProjectionSnapshot();
  assert.equal(fixture.orchestratorTeams.getSnapshot().agents[0].status, 'idle', 'the fixture source refreshed to the raw idle observation');
  const duringDebounce = await fixture.get('/api/v3/views/office');
  assert.equal(duringDebounce.status, 200, duringDebounce.text);
  assert.equal(duringDebounce.json.data.occupants.find(row => row.name === 'Release lead').state, 'working',
    'the engine-projected Herdr member uses the Office desk-idle debounce');
  assert.equal(fixture.engine.orchestrationParityCounters().office?.mismatches, 0,
    'the engine and compatibility projection remain in parity during the shared debounce window');
  now += 3_000;
  fixture.api.topics.invalidate('office');
  fixture.api.topics.invalidate('office-scope');
  const afterDebounce = await fixture.get('/api/v3/views/office');
  assert.equal(afterDebounce.json.data.occupants.find(row => row.name === 'Release lead').state, 'idle',
    'the engine-projected member becomes idle when the configured debounce expires: ' + JSON.stringify({
      now, row: afterDebounce.json.data.occupants.find(row => row.name === 'Release lead'),
    }));
  assert.equal(fixture.engine.orchestrationParityCounters().office?.mismatches, 0,
    'the engine and compatibility projection remain in parity after the debounce expires');
  const finalParity = fixture.engine.orchestrationParityCounters();
  assert.ok(finalParity.office?.comparisons >= 4, 'aligned Office projections continue to be compared');
  assert.equal(finalParity.office?.mismatches, 0, 'aligned Office projections compare cleanly');
  assert.ok(finalParity.office?.skippedUnsynced >= skippedBeforeSourceSkew + 1,
    'source skew remains separately counted as skipped');
  assert.equal(finalParity.office?.shadowErrors, 0);
  assert.equal(finalParity.office?.changedRows, 0);
  assert.equal(finalParity.office?.overflowKeys, 0);
  assert.equal(finalParity.office?.overflowSurfaces, 0);
  canReadSessions = false;
  const limited = await fixture.get('/api/v3/views/office');
  assert.equal(limited.status, 200, limited.text);
  assert.equal(JSON.stringify(limited.json.data).includes('session-lead'), false,
    'limited Office response omits private session identity');
  const limitedParity = fixture.engine.orchestrationParityCounters()['office.limited'];
  assert.ok(limitedParity, JSON.stringify({ sourceStatus: fixture.engine.orchestrationProjectionSnapshot()?.sourceStatus?.map(row => ({ enabled: row.enabled, status: row.status })),
    engineReady: fixture.engine.orchestrationProjectionSnapshot()?.sourcesReady,
    legacyReady: fixture.orchestratorTeams.getSnapshot()?.sourcesReady }));
  assert.deepEqual(limitedParity && { comparisons: limitedParity.comparisons, mismatches: limitedParity.mismatches,
    skippedUnsynced: limitedParity.skippedUnsynced, changedRows: limitedParity.changedRows, overflowKeys: limitedParity.overflowKeys },
  { comparisons: 1, mismatches: 0, skippedUnsynced: 0, changedRows: 0, overflowKeys: 0 },
  'limited Office placement is built by the engine and remains in source-projection parity');
  assert.equal(JSON.stringify(fixture.engine.orchestrationProjectionSnapshot()).includes('session-lead'), false,
    'engine public snapshot omits native session references');
});

test('Office keeps the legacy response during a no-identity boot if its shadow builder is unavailable', async t => {
  let source;
  let shadowAttempts = 0, failShadow = false;
  const principal = { id: 'no-identity-office-owner', role: 'admin', permissionRevision: 1 };
  const fixture = await settingsFixture({ officeEngineOrchestration: false, sourcePrincipalFor: () => principal,
    sessionsReadable: () => true,
    viewEngine: raw => new Proxy(raw, { get(target, key) {
      if (key === 'orchestrationProjectionSnapshot') return () => ({
        hosts: [], orchestrators: [], hostAgents: [], identityLinks: [], teams: [], members: [], tasks: [], reviews: [],
        privateSources: {}, sourceStatus: [{ enabled: true, status: 'ready', capabilities: { orchestration: { teams: true } } }],
        sourceRevisions: { 'agent-team-pm': 1 }, identityRevisions: { 'agent-team-pm': 1 }, sourcesReady: true,
      });
      const value = Reflect.get(target, key, target);
      if (key === 'buildOfficeView') return options => {
        if (options?.office) {
          shadowAttempts++;
          if (failShadow) throw new Error('identity snapshot unavailable');
        }
        return value.call(target, options);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } }),
    orchestratorTeams: ({ tmp, engine }) => {
      const root = path.join(tmp, 'team-store');
      fs.mkdirSync(path.join(root, 'members'), { recursive: true });
      fs.writeFileSync(path.join(root, 'members', 'lead.json'), JSON.stringify({
        id: 'member:44444444-4444-4444-8444-444444444444', name: 'Release lead', role: 'lead', runtime: 'codex',
        herdrPane: null, session: { source: 'codex', kind: 'agent_session', value: 'session-no-gateway' }, spawnedBy: null,
      }));
      source = createConfiguredOrchestrators({ engine, env: { HOME: tmp, PATH: '' }, binaryPath: false,
        teamRoot: root, runtimeIdentitySessions: () => [] });
      return source;
    } });
  t.after(async () => { source?.close(); await fixture.close(); });
  await source.refresh();
  fixture.engine.setRuntimeNotConfigured('no-identity');

  // Keep the team-store source active while the runtime has no identity. The
  // canonical registry has already admitted its source generation, so the
  // scoped compatibility response will attempt a shadow comparison just as
  // it can during a production boot with a missing gateway identity.
  assert.equal(source.hasTeamStore, true, 'the read-only team store activates the caller-scoped Office topic');
  assert.equal(source.getSnapshot()?.sourcesReady, true, 'the compatibility source has a ready team-store snapshot');

  // With the cutover switch off, this builder is shadow-only. The view-engine
  // proxy supplies an admitted team generation (as it can be during boot)
  // while the runtime itself has no identity. Exercise the real helper first:
  // before the fix its missing homeAssignmentsOverride binding throws here.
  for (const version of [2, 3]) {
    const response = await fixture.get(`/api/v${version}/views/office`);
    assert.equal(response.status, 200, response.text);
    assert.ok(response.json?.data?.occupants, `the switch-off compatibility Office remains available in v${version}`);
  }
  assert.equal(shadowAttempts, 2, 'both versioned requests exercise the real shadow-only canonical comparison path');
  assert.equal(fixture.engine.orchestrationParityCounters().office?.shadowErrors || 0, 0,
    'the corrected shadow builder succeeds for a no-identity boot');

  // A different shadow-only exception must remain non-fatal and increment its
  // own metric rather than masquerading as a source-generation skip.
  const priorCounters = fixture.engine.orchestrationParityCounters().office;
  const skippedBeforeInjectedErrors = priorCounters?.skippedUnsynced || 0;
  const errorsBeforeInjectedFailures = priorCounters?.shadowErrors || 0;
  failShadow = true;
  fixture.api.topics.invalidate('office-scope');
  for (const version of [2, 3]) {
    const response = await fixture.get(`/api/v${version}/views/office`);
    assert.equal(response.status, 200, response.text);
  }
  assert.equal(shadowAttempts, 4);
  const shadowCounters = fixture.engine.orchestrationParityCounters().office;
  assert.equal(shadowCounters?.skippedUnsynced, skippedBeforeInjectedErrors, 'builder errors are not misreported as source-generation skips');
  assert.equal(shadowCounters?.shadowErrors, errorsBeforeInjectedFailures + 2, 'both failures increment the bounded shadow-error counter');
});

test('engine-owned Office remains schema-valid when boot has no gateway identity', async t => {
  let source;
  const engineBuilderErrors = [];
  const principal = { id: 'no-identity-engine-owner', role: 'admin', permissionRevision: 1 };
  const fixture = await settingsFixture({ officeEngineOrchestration: true, sourcePrincipalFor: () => principal,
    sessionsReadable: () => true,
    orchestratorTeams: ({ tmp, engine }) => {
      const root = path.join(tmp, 'team-store');
      fs.mkdirSync(path.join(root, 'members'), { recursive: true });
      fs.writeFileSync(path.join(root, 'members', 'lead.json'), JSON.stringify({
        id: 'member:55555555-5555-4555-8555-555555555555', name: 'Boot lead', role: 'lead', runtime: 'codex',
        herdrPane: null, session: { source: 'codex', kind: 'agent_session', value: 'session-boot' }, spawnedBy: null,
      }));
      source = createConfiguredOrchestrators({ engine, env: { HOME: tmp, PATH: '' }, binaryPath: false, teamRoot: root,
        runtimeIdentitySessions: () => [] });
      return source;
    }, viewEngine: raw => new Proxy(raw, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'buildOfficeView') return options => {
        try { return value.call(target, options); }
        catch (error) { engineBuilderErrors.push({ name: error?.name, message: error?.message }); throw error; }
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } }) });
  t.after(async () => { source?.close(); await fixture.close(); });
  await source.refresh();
  fixture.engine.setRuntimeNotConfigured('no-identity');
  assert.equal(source.getSnapshot()?.sourcesReady, true);
  assert.equal(source.hasTeamStore, true, 'the real team-store adapter activates the engine Office path');
  const canonical = fixture.engine.orchestrationProjectionSnapshot();
  assert.ok(canonical?.sourcesReady && canonical.sourceStatus?.some(row => row.enabled && row.capabilities?.orchestration?.teams),
    'the canonical Office builder has an admitted team-store generation despite the missing gateway identity');

  for (const version of [2, 3]) {
    const response = await fixture.get(`/api/v${version}/views/office`);
    assert.equal(response.status, 200, response.text);
    assert.ok(Array.isArray(response.json?.data?.occupants));
    assert.ok(response.json.data.occupants.length > 0, 'runtime fallback occupants remain available without gateway identity');
  }
  assert.deepEqual(engineBuilderErrors, [], 'the engine Office builder itself does not throw without gateway identity');
});

