'use strict';
// S2 shadow goldens: every fixture of every scenario through the engine. The quarantine summary
// (without timestamps) and the registry keys are pinned per scenario. Real captures must produce
// no error-level issue: a schema that rejects real data is a bug in the schema.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { listScenarios } = require('../helpers/scenario');
const { feed } = require('../helpers/feed');
const { matchGolden } = require('../helpers/golden');

// Redaction ARTIFACTS in captured fixtures (not data problems). Each must say why; new ones need review.
const KNOWN_CAPTURE_ARTIFACTS = {
  'capture-20261005': {
    // the original first-pass redaction scrambled ISO dates (before ISO handling existed); unrecoverable
    'shape.invalid gw.rpc.cron.list $.jobs[].schedule.at': 'ISO date scrambled by the first redaction',
  },
  'capture-20261005-active': {
    // its original R1-02 pass scrambled camelCase vocabulary before the S4 fix (like agentTurn): a role and a part type
    'enum.unmapped gw.rpc.sessions.get $.messages[].role': 'role scrambled by the original redaction (camelCase artifact)',
    'enum.unmapped gw.rpc.sessions.get $.messages[].content[].type': 'part type scrambled by the original redaction (camelCase artifact)',
    // re-redacted with the lowercase-only token rule (fixed in S4: camelCase allowed); recoverable by
    // re-running scripts/re-redact-fixtures.js on the PM's pre-redaction tree
    'enum.unmapped gw.rpc.cron.list $.jobs[].payload.kind': 'agentTurn scrambled by the old token rule',
  },
};

for (const sc of listScenarios()) {
  describe(`engine shadow · ${sc.name}`, () => {
    const e = feed(createEngine({ now: () => sc.now }), sc);
    const issues = e.quarantine.list().map(({ firstSeenAt, lastSeenAt, ...rest }) => rest);

    it('quarantine summary matches golden', () => matchGolden('engine-shadow', sc.name, 'quarantine', issues));
    it('registry keys match golden', () => matchGolden('engine-shadow', sc.name, 'registry-keys', e.registryKeys()));
    if (sc.origin === 'capture') {
      it('real capture: no error or warn issues', () => {
        const allowed = KNOWN_CAPTURE_ARTIFACTS[sc.name] || {};
        assert.deepEqual(issues.filter((i) => i.severity !== 'info').map((i) => `${i.code} ${i.channel} ${i.path}`).filter((k) => !allowed[k]), []);
      });
    }
  });
}
