'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const officeModule = require('../../src/api/v2/vm/office');
const legacyBaseBuilder = officeModule.buildOfficeVM;
// Install before routes.js/views.js imports the builder. This makes the test
// fail on the old API-owned base projection, even if the view module caches
// the function reference during setup.
officeModule.buildOfficeVM = () => { throw new Error('legacy API base builder must not run during the engine cutover'); };
const { settingsFixture } = require('../helpers/settings-fixture');
const { createConfiguredOrchestrators } = require('../../src/sources/configured-orchestrators');

test('Office consumes canonical engine source rows and dual-run parity is clean for a prod-shaped team', async t => {
  let source;
  let hostStatus = 'working';
  let canReadSessions = true;
  let now = Date.parse('2026-10-16T15:00:00Z');
  const principal = { id: 'office-engine-owner', role: 'admin', permissionRevision: 1 };
  let fixture;
  t.after(async () => {
    source?.close();
    await fixture?.close();
    officeModule.buildOfficeVM = legacyBaseBuilder;
  });
  fixture = await settingsFixture({ officeEngineOrchestration: true, sourcePrincipalFor: () => principal,
    sessionsReadable: () => canReadSessions, now: () => now,
    orchestratorTeams: ({ tmp, engine }) => {
      const root = path.join(tmp, 'team-store');
      for (const directory of ['members', 'tasks', 'inbox']) fs.mkdirSync(path.join(root, directory), { recursive: true });
      fs.writeFileSync(path.join(root, 'members', 'lead.json'), JSON.stringify({
        id: 'member:11111111-1111-4111-8111-111111111111', name: 'Release lead', role: 'lead', runtime: 'codex',
        herdrPane: 'pane-lead', session: { source: 'herdr:codex', kind: 'agent_session', value: 'session-lead' }, spawnedBy: null,
      }));
      source = createConfiguredOrchestrators({ engine, env: { HOME: tmp, PATH: '' }, binaryPath: '/fixture/bin/herdr', enabled: true,
        hostId: 'host_engine_fixture', teamRoot: root, now: () => now,
        run: async () => ({ stdout: Buffer.from(JSON.stringify({ id: 'fixture', result: { type: 'ok', agents: [{
          pane_id: 'pane-lead', agent: 'codex', name: 'Release lead', agent_status: hostStatus,
          agent_session: { value: 'session-lead' },
        }] } })) }),
      });
      return source;
    } });
  await fixture.orchestratorTeams.refresh();

  const response = await fixture.get('/api/v3/views/office');
  assert.equal(response.status, 200, response.text);
  const member = response.json.data.occupants.find(row => row.name === 'Release lead');
  assert.ok(member, 'the engine-admitted member appears in Office');
  assert.equal(member.hostStatus, 'working');
  const counters = fixture.engine.orchestrationParityCounters();
  assert.deepEqual(counters.office && { comparisons: counters.office.comparisons, mismatches: counters.office.mismatches,
    changedRows: counters.office.changedRows, overflowKeys: counters.office.overflowKeys },
  { comparisons: 1, mismatches: 0, changedRows: 0, overflowKeys: 0 });
  now += 1_000;
  hostStatus = 'idle';
  await fixture.orchestratorTeams.refresh();
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
  assert.deepEqual(finalParity, { office: { comparisons: 3, mismatches: 0, changedRows: 0, overflowKeys: 0, overflowSurfaces: 0 } },
    'three prod-shaped Office projections (working, debouncing, idle) have clean, value-free dual-run counters');
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
    changedRows: limitedParity.changedRows, overflowKeys: limitedParity.overflowKeys },
  { comparisons: 1, mismatches: 0, changedRows: 0, overflowKeys: 0 },
  'limited Office placement is built by the engine and remains in source-projection parity');
  assert.equal(JSON.stringify(fixture.engine.orchestrationProjectionSnapshot()).includes('session-lead'), false,
    'engine public snapshot omits native session references');
});

