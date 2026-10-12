'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { defaultAdapter } = require('../../src/adapters');
const { createHealthChecks } = require('../../src/engine/health-checks');

function fixture(id, calls, failOnce = false) {
  const base = defaultAdapter().definition;
  const checks = ['observe', 'automatic', 'click', 'guided'].map(kind => ({ id: kind, severity: 'warn', causeCode: 'synthetic',
    textKey: 'healthCheck.synthetic.problem', impactKey: 'healthImpact.sessions',
    remedy: ({ observe: 'none', automatic: 'auto', click: 'one-click', guided: 'guided' })[kind],
    ...(kind === 'automatic' || kind === 'click' ? { actionId: kind } : {}),
    ...(kind === 'guided' ? { guidedPath: '/parametres?onglet=connexion' } : {}), active: true }));
  return { ...base, id, health: { checks, remedies: {
    automatic: async () => { calls[id + ':automatic'] = (calls[id + ':automatic'] || 0) + 1; return { ok: !failOnce || calls[id + ':automatic'] > 1, category: 'timeout' }; },
    click: async () => { calls[id + ':click'] = (calls[id + ':click'] || 0) + 1; return { ok: true }; },
  } } };
}

describe('canonical, adapter-declared health checks', () => {
  it('runs all remedy paths through two synthetic providers and bounds automatic retries with audit', async () => {
    const calls = {}, a = createEngine({ adapter: fixture('synthetic-a', calls, true) }), b = createEngine({ adapter: fixture('synthetic-b', calls) });
    try {
      for (const [engine, provider] of [[a, 'synthetic-a'], [b, 'synthetic-b']]) {
        const rows = engine.healthChecks();
        assert.deepEqual(rows.map(row => row.remedy).sort(), ['auto', 'guided', 'none', 'one-click']);
        assert.equal(rows.every(row => row.adapter === provider && typeof row.impactKey === 'string'), true);
        assert.equal((await engine.runHealthRemedy(provider + ':observe')).category, 'remedy-unavailable');
        assert.equal((await engine.runHealthRemedy(provider + ':guided')).category, 'remedy-unavailable');
        const automatic = await engine.runHealthRemedy(provider + ':automatic', { automatic: true });
        assert.equal(automatic.ok, true);
        assert.ok(calls[provider + ':automatic'] <= 3);
        assert.equal((await engine.runHealthRemedy(provider + ':click')).ok, true);
        assert.equal(engine.healthAudit().length, 2);
      }
      assert.equal(calls['synthetic-a:automatic'], 2, 'retry stops as soon as the adapter remedy succeeds');
      assert.equal(calls['synthetic-b:automatic'], 1);
    } finally { a.close(); b.close(); }
  });

  it('puts a deadline on adapter remedies and coalesces concurrent requests for one check', async () => {
    const context = {}, signals = [];
    const checks = createHealthChecks({ adapterId: 'synthetic', adapter: { health: {
      checks: [{ id: 'probe', severity: 'warn', causeCode: 'timeout', textKey: 'healthCheck.synthetic.problem', impactKey: 'healthImpact.sessions', remedy: 'auto', actionId: 'probe', active: true }],
      remedies: { probe: (_ctx, { signal }) => { signals.push(signal); return new Promise(() => {}); } },
    } }, context: () => context, now: Date.now, remedyTimeoutMs: 5 });
    const a = checks.run('synthetic:probe', { automatic: true });
    const b = checks.run('synthetic:probe', { automatic: true });
    assert.equal(a, b);
    const result = await a;
    assert.equal(result.ok, false);
    assert.equal(result.category, 'timeout');
    assert.equal(result.audit.attempts, 3);
    assert.equal(signals.length, 3);
    assert.ok(signals.every(signal => signal.aborted));
  });

  it('does not reschedule a permanently failing automatic remedy until its cause changes', async () => {
    let runs = 0, cause = 'unsupported';
    const checks = createHealthChecks({ adapterId: 'synthetic', adapter: { health: {
      checks: () => [{ id: 'scan', severity: 'warn', causeCode: cause, textKey: 'healthCheck.synthetic.problem', impactKey: 'healthImpact.sessions', remedy: 'auto', actionId: 'scan', active: true }],
      remedies: { scan: async () => { runs++; return { ok: false, category: 'unsupported-format' }; } },
    } }, context: () => ({}), now: Date.now });
    try {
      await checks.runSafe();
      const failedCount = runs;
      assert.equal(failedCount, 3, 'one bounded execution may retry transiently');
      assert.equal(checks.list()[0].remedy, 'none', 'unchanged permanent failures become non-actionable');
      await checks.runSafe(); await checks.runSafe();
      assert.equal(runs, failedCount, 'scheduled scans never retry the same failure indefinitely');
      cause = 'readable-again';
      assert.equal(checks.list()[0].remedy, 'auto', 'a changed cause permits a fresh automatic attempt');
      await checks.runSafe();
      assert.equal(runs, failedCount + 3);
    } finally { checks.close(); }
  });

  it('forgets terminal suppression when a dynamic check disappears, so recurrence can retry', async () => {
    let present = true, runs = 0;
    const checks = createHealthChecks({ adapterId: 'synthetic', adapter: { health: {
      checks: () => present ? [{ id: 'scan', severity: 'warn', causeCode: 'unsupported', textKey: 'healthCheck.synthetic.problem', impactKey: 'healthImpact.sessions', remedy: 'auto', actionId: 'scan' }] : [],
      remedies: { scan: async () => { runs++; return { ok: false, category: 'unsupported-format' }; } },
    } }, context: () => ({}), now: Date.now });
    try {
      await checks.runSafe();
      assert.equal(runs, 3);
      assert.equal(checks.list()[0].remedy, 'none');
      present = false;
      assert.equal(checks.list()[0].active, false, 'absence resolves the dynamic check');
      present = true;
      assert.equal(checks.list()[0].remedy, 'auto', 'recurrence starts a new remediation lifecycle');
      await checks.runSafe();
      assert.equal(runs, 6);
    } finally { checks.close(); }
  });
});
