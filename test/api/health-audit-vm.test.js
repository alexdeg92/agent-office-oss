'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { defaultAdapter } = require('../../src/adapters');
const { createMultiEngine } = require('../../src/engine/multi');
const { buildHealthVM } = require('../../src/api/v2/vm/health');
const { createVmCheck } = require('../../src/api/v2/vm/check');

const NOW = Date.UTC(2026, 9, 11, 12);

function adapter(id, target = null) {
  const base = defaultAdapter().definition;
  return { ...base, id, health: {
    checks: [{ id: 'probe', severity: 'warn', causeCode: 'timeout', textKey: 'healthCheck.sessionSync.timeout',
      impactKey: 'healthImpact.sessions', remedy: 'one-click', actionId: 'retry', target }],
    remedies: { retry: async () => ({ ok: true }) },
  } };
}

test('combined runtime HealthVM accepts multiple remedy audit events after boot', async (t) => {
  const a = createEngine({ adapter: adapter('openclaw'), now: () => NOW });
  const b = createEngine({ adapter: adapter('claude-code'), now: () => NOW + 1 });
  const engine = createMultiEngine({ instances: [
    { id: 'legacy', adapter: 'openclaw', enabled: true, engine: a },
    { id: 'claude', adapter: 'claude-code', enabled: true, engine: b },
  ] });
  t.after(() => { engine.close(); a.close(); b.close(); });

  for (const runtime of [a, b]) {
    const check = runtime.healthChecks()[0];
    assert.equal((await runtime.runHealthRemedy(check.id)).ok, true);
  }

  const vm = buildHealthVM({ engine });
  assert.equal(vm.healthAudit.length, 2);
  const checkVm = createVmCheck({ mode: 'throw' });
  assert.doesNotThrow(() => checkVm.check('health', vm));
});

test('HealthVM never serializes adapter supplied private paths or transcript identifiers', async (t) => {
  const a = createEngine({ adapter: adapter('claude-code', '/home/user/private-customer/session-SYNTHETIC-ID.jsonl'), now: () => NOW });
  const engine = createMultiEngine({ instances: [{ id: 'claude', adapter: 'claude-code', enabled: true, engine: a }] });
  t.after(() => { engine.close(); a.close(); });

  const vm = buildHealthVM({ engine });
  const checkVm = createVmCheck({ mode: 'throw' });
  assert.doesNotThrow(() => checkVm.check('health', vm));
  const serialized = JSON.stringify(vm);
  assert.equal(serialized.includes('/home/user/private-customer'), false);
  assert.equal(serialized.includes('SYNTHETIC-ID'), false);
  assert.equal(vm.healthChecks[0].target, null);
});
