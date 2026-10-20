'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { officeSceneFixture } = require('../helpers/office-scene-fixture.cjs');
const { emptyTeamOptions } = require('../helpers/office-empty-team-source.cjs');

const working = count => Array(count).fill('working');
const idle = count => Array(count).fill('idle');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const office = async h => {
  const response = await h.get('/api/v3/views/office');
  assert.equal(response.status, 200, response.text);
  return response.json.data;
};
const primaryIn = (vm, version = 3) => vm.occupants.find(row => row.role === (version === 2 ? 'main' : 'primary') || row.id === (version === 2 ? 'main' : 'primary'));

test('a seated agent keeps its active placement through a short idle gap and resumes without a state transition', async t => {
  const h = await officeSceneFixture({ occupantCount: 4, namedAgents: true, ...emptyTeamOptions });
  t.after(() => h.close());
  h.publish(working(4));
  const before = primaryIn(await office(h));
  assert.equal(before.state, 'working');
  assert.equal(before.sceneTarget.mode, 'desk');

  h.advance(900, idle(4));
  const paused = primaryIn(await office(h));
  assert.equal(paused.state, 'working');
  assert.equal(paused.stateSince, before.stateSince);
  assert.equal(paused.sceneTarget.mode, 'desk');
  const legacy = await h.get('/api/v2/views/office');
  assert.equal(legacy.status, 200, legacy.text);
  assert.equal(primaryIn(legacy.json.data, 2).state, 'working');

  h.advance(1700, working(4));
  const resumed = primaryIn(await office(h));
  assert.equal(resumed.state, 'working');
  assert.equal(resumed.stateSince, before.stateSince);
  assert.equal(resumed.sceneTarget.mode, 'desk');
});

test('idle is emitted after the grace period, other states apply immediately, and removed occupants lose pending state', async t => {
  const h = await officeSceneFixture({ occupantCount: 4, namedAgents: true, ...emptyTeamOptions });
  t.after(() => h.close());
  h.publish(working(4));
  await office(h);

  h.advance(100, idle(4));
  await office(h);
  h.advance(3100, idle(4));
  let vm = await office(h);
  assert.equal(primaryIn(vm).state, 'idle');

  h.publish(working(4));
  await office(h);
  h.advance(500, idle(4));
  await office(h);
  h.advance(100, ['error', 'idle', 'idle', 'idle']);
  vm = await office(h);
  assert.equal(primaryIn(vm).state, 'error');

  h.publish(working(4));
  await office(h);
  h.advance(500, ['working', 'working', 'working', 'idle']);
  await office(h);
  const catalog = h.viewEngine.agents().filter(agent => agent.id !== 'worker-3');
  assert.equal(h.viewEngine.ingestCanonical('agents', catalog).ok, true);
  h.publish(working(3));
  vm = await office(h);
  assert.equal(vm.occupants.some(row => row.id === 'agent:worker-3'), false);

  assert.equal(h.viewEngine.ingestCanonical('agents', [...catalog, {
    id: 'worker-3', name: 'Collègue 3', workspace: null, model: null, fallbackModels: [], isPrimary: false,
    mainSessionKey: 'worker-3', spawnedBy: { agentId: 'atlas', sessionKey: null, via: 'orchestrator', label: null },
  }]).ok, true);
  h.publish(working(4));
  vm = await office(h);
  const restored = vm.occupants.find(row => row.id === 'agent:worker-3');
  assert.equal(restored?.state, 'working');
});

test('the office publishes idle after the grace period without another runtime event', async t => {
  const h = await officeSceneFixture({ occupantCount: 4, namedAgents: true, ...emptyTeamOptions });
  t.after(() => h.close());
  h.publish(working(4));
  const initial = await office(h);
  h.advance(100, idle(4));
  const pending = await office(h);
  assert.equal(primaryIn(pending).state, 'working');

  h.clock.value += 3_000;
  await wait(3_100);
  const published = h.api.topics.current('office', 3).vm;
  assert.equal(primaryIn(published).state, 'idle');
  assert.ok(primaryIn(published).stateSince > primaryIn(initial).stateSince);
});

test('a scoped office projection preserves a full OfficeVM pending idle deadline', async t => {
  const h = await officeSceneFixture({ occupantCount: 4, namedAgents: true, ...emptyTeamOptions });
  t.after(() => h.close());
  h.publish(working(4));
  h.api.topics.current('office', 3); // Full OfficeVM is built before the caller-scoped projection.

  h.advance(100, idle(4));
  const fullPending = h.api.topics.current('office', 3).vm;
  assert.equal(primaryIn(fullPending).state, 'working');
  const scopedResponse = await h.get('/api/v3/views/office');
  assert.equal(scopedResponse.status, 200, scopedResponse.text);
  assert.equal(primaryIn(scopedResponse.json.data).state, 'working');

  h.clock.value += 3_000;
  await wait(3_100);
  const scopedAfterDeadline = await h.get('/api/v3/views/office');
  assert.equal(scopedAfterDeadline.status, 200, scopedAfterDeadline.text);
  assert.equal(primaryIn(scopedAfterDeadline.json.data).state, 'idle');
});
