'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { buildOfficeVM, createStateTracker } = require('../../src/api/v2/vm/office');
const { project2x } = require('../../src/api/v2/project2x');
const { project3x } = require('../../src/api/v2/project3x');
const { createVmCheck } = require('../../src/api/v2/vm/check');
const { officeSceneFixture } = require('../helpers/office-scene-fixture.cjs');

const NOW = 1791600000000;
const adapter = { id: 'synthetic', name: 'Synthetic', schemas: {}, routes: {},
  normalise: { session: row => ({ session: row }), runtimeHealth: () => ({ version: null, pluginsLoaded: null, eventLoop: null }) },
  classifySession: () => ({ kind: 'unrecognized' }), capabilities: () => ({ sessions: true }) };
const run = { status: 'running', endReason: null, evidence: 'status-field', evidenceLevel: 'verified', observedAt: NOW,
  expiresAt: NOW + 60_000, startedAt: NOW - 1_000, endedAt: null, hasActiveSubagentRun: false,
  runtimeMs: null, lastRunId: null, lastError: null };
function makeEngine({ unresolvedOwner = false } = {}) {
  const engine = createEngine({ adapter, now: () => NOW, primary: 'main' });
  assert.equal(engine.ingestCanonical('agents', [{ id: 'main', name: 'Main', workspace: null, model: null,
    fallbackModels: [], isPrimary: true, mainSessionKey: 'main-session' }]).ok, true);
  const sessions = [{ key: 'main-session', sessionId: null,
    class: { kind: 'primary', ruleId: 'synthetic', agentId: 'main', channel: null, heartbeatOf: null, background: false, rawClassification: null },
    displayName: null, model: null, provider: null, usage: { total: 0, input: null, output: null }, updatedAt: NOW, run,
    costUsd: null, parentKey: null, childKeys: [], goal: null, cwd: null, messageCount: null, interactive: false, group: null }];
  if (unresolvedOwner) sessions.push({ ...sessions[0], key: 'orphan-contact', class: { ...sessions[0].class,
    kind: 'conversation-direct', agentId: 'missing-owner', channel: 'chat' }, interactive: true });
  assert.equal(engine.ingestCanonical('sessions.snapshot', sessions).ok, true);
  engine.setGatewayConnected(true);
  return engine;
}

for (const P of [project2x, project3x]) {
  for (const unresolvedOwner of [false, true]) {
    test(`T-0140 v${P.version}: ${unresolvedOwner ? 'unresolved owner' : 'no contact'} omits optional visitIntent and validates`, () => {
      const vm = buildOfficeVM({ engine: makeEngine({ unresolvedOwner }), now: NOW, tracker: createStateTracker(),
        canReadSessions: true, actorOf: () => ({ kind: 'system', name: 'System' }), P });
      assert.equal(Object.hasOwn(vm, 'visitIntent'), false);
      assert.doesNotThrow(() => createVmCheck({ mode: 'throw', version: P.version }).check('office', vm));
      if (unresolvedOwner) assert.ok(vm.occupants.some(row => ['direct', 'dm', 'conversation', 'channel'].includes(row.role) && !row.parentId));
    });
  }
  test(`T-0140 v${P.version}: mounted no-contact Office GET returns 200`, async t => {
    const fixture = await officeSceneFixture({ occupantCount: 2 });
    t.after(() => fixture.close());
    const response = await fixture.get(`/api/v${P.version}/views/office`);
    assert.equal(response.status, 200, response.text);
  });
}
