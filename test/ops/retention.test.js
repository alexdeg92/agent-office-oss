'use strict';
// G8 · the retention policy (operations.md §3): configurable within bounds, applied by the daily maintenance.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { openStore } = require('../../src/store');
const { createEngine } = require('../../src/engine');
const { loadConfig } = require('../../src/config');

const DAY = 86400000, NOW = Date.UTC(2026, 9, 6, 4);
const base = { PORTAL_EMAIL: 'a@example.invalid', PORTAL_SECRET: 's'.repeat(40), PORTAL_PASSWORD: 'x', AO_ENV: 'test', HOME: '/tmp', AO_DATA_DIR: '/tmp/ao-ret-unused' };

describe('G8 · retention', () => {
  it('settings: defaults 365 / 30 days; env within bounds; out of bounds refuses to start', () => {
    assert.deepEqual(loadConfig(base).retention, { auditDays: 365, issueDays: 30, senderDays: 30 });
    assert.deepEqual(loadConfig(Object.assign({ AO_AUDIT_RETENTION_DAYS: '90', AO_ISSUE_RETENTION_DAYS: '14', AO_SENDER_RETENTION_DAYS: '7' }, base)).retention, { auditDays: 90, issueDays: 14, senderDays: 7 });
    assert.equal(loadConfig(base).senderCapture, true);
    assert.equal(loadConfig({ ...base, AO_SENDER_CAPTURE: '0' }).senderCapture, false);
    const { spawnSync } = require('child_process');
    for (const [k, v] of [['AO_AUDIT_RETENTION_DAYS', '7'], ['AO_ISSUE_RETENTION_DAYS', '400'], ['AO_AUDIT_RETENTION_DAYS', 'x'], ['AO_SENDER_RETENTION_DAYS', '0'], ['AO_SENDER_RETENTION_DAYS', '366']]) {
      const r = spawnSync(process.execPath, ['-e', "require('./src/config').loadConfig(" + JSON.stringify(Object.assign({ [k]: v }, base)) + ')'], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
      assert.equal(r.status, 1, k + '=' + v); assert.match(r.stderr, new RegExp(k));
    }
  });
  it('maintenance applies it: old audit rows, old resolved issues and old muted issues go; recent and open ones stay; counts only in the log', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ret-'));
    const logs = [];
    try {
      const st = openStore({ dir: path.join(d, 'data'), instance: 'test', ownerName: 'Owner', now: () => NOW, log: (m) => logs.push(m), retention: { auditDays: 90, issueDays: 14 } });
      const engine = createEngine({ now: () => NOW });
      st.bindEngine(engine);
      const audit = (at, c) => st.audit.append({ at, requestId: 'req_x', actor: { kind: 'anonymous' }, command: c, target: null, outcome: 'ok', detail: null });
      audit(NOW - 100 * DAY, 'test.old'); audit(NOW - 10 * DAY, 'test.recent');
      st.db.prepare("INSERT INTO quarantine VALUES ('aaaa', 'shape.invalid', 'warn', 'store.quarantine', '$.a', 1, ?, ?, 'resolved')").run(NOW - 20 * DAY, NOW - 20 * DAY);
      st.db.prepare("INSERT INTO quarantine VALUES ('bbbb', 'shape.invalid', 'warn', 'store.quarantine', '$.b', 1, ?, ?, 'resolved')").run(NOW - 5 * DAY, NOW - 5 * DAY);
      st.db.prepare("INSERT INTO quarantine VALUES ('cccc', 'shape.invalid', 'warn', 'store.quarantine', '$.c', 1, ?, ?, 'muted')").run(NOW - 100 * DAY, NOW - 100 * DAY);
      st.db.prepare("INSERT INTO quarantine VALUES ('dddd', 'shape.invalid', 'warn', 'store.quarantine', '$.d', 1, ?, ?, 'open')").run(NOW - 400 * DAY, NOW - 400 * DAY);
      const out = st.maintenance();
      assert.deepEqual(st.db.prepare('SELECT command FROM audit_log ORDER BY id').all().map((r) => r.command), ['test.recent']);
      assert.deepEqual(st.db.prepare('SELECT fingerprint FROM quarantine ORDER BY fingerprint').all().map((r) => r.fingerprint), ['bbbb', 'dddd']);
      assert.equal(out.pruned.audit, 1); assert.equal(out.pruned.issues, 2);
      assert.ok(logs.some((m) => /maintenance pruned audit=1, issues=2/.test(m)), logs.join('\n'));
      st.close();
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});
