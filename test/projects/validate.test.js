'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { check, slugify, flagSchema, historySchema, projectSchema } = require('../../src/projects/validate');
const { HISTORY_KINDS, STORAGE_HISTORY_KINDS, PROJECT_STATUSES } = require('../../src/projects/constants');
const { mint } = require('../../src/projects/ids');

describe('project types', () => {
  it('accepts the five English status keys and rejects a blocked column', () => {
    assert.deepEqual(PROJECT_STATUSES, ['idea', 'todo', 'in-progress', 'in-review', 'shipped']);
    const statusSchema = require('../../src/schema').enumOf(PROJECT_STATUSES);
    for (const status of PROJECT_STATUSES) assert.equal(check(statusSchema, status).ok, true);
    assert.equal(check(statusSchema, 'blocked').ok, false);
    assert.equal(check(statusSchema, 'Bloqué').ok, false);
  });

  it('mints prefixed 16-character ids', () => {
    const id = mint('prj');
    assert.match(id, /^prj_[a-z2-7]{16}$/);
    assert.match(mint('evt'), /^evt_[a-z2-7]{16}$/);
    assert.match(mint('src'), /^src_[a-z2-7]{16}$/);
    assert.match(mint('per'), /^per_[a-z2-7]{16}$/);
  });

  it('slugifies labels', () => {
    assert.deepEqual(slugify('Site Web'), { key: 'site-web', label: 'Site Web' });
    assert.equal(slugify('Été').key, 'ete');
    assert.throws(() => slugify('   '), (e) => e.code === 'validation_failed');
  });

  it('rejects a risk flag that borrows another kind’s fields', () => {
    const bad = check(flagSchema, { kind: 'priority', key: 'P0', label: 'nope' });
    assert.equal(bad.ok, false);
    const stale = check(flagSchema, {
      kind: 'risk', key: 'stale', severity: 'low', origin: 'auto', evidence: null,
      raisedAt: Date.UTC(2026, 0, 1), clearedAt: null, ack: null,
    });
    assert.equal(stale.ok, false);
  });

  it('writes the history kinds the architect is adding to the CHECK', () => {
    for (const kind of ['renamed', 'risk-unacked', 'archived', 'restored', 'people-override', 'flags-updated']) {
      assert.ok(HISTORY_KINDS.includes(kind));
      assert.ok(!STORAGE_HISTORY_KINDS.includes(kind));
    }
    assert.equal(check(historySchema, { kind: 'renamed-nope' }).ok, false);
    assert.equal(check(projectSchema, { status: 'idea' }).ok, false);
  });

  it('keeps the index rule and the history kinds aligned with the architecture note', () => {
    const docs = fs.readFileSync(path.join(__dirname, '../../docs/architecture/projects.md'), 'utf8');
    assert.equal(/index is accepted and ignored/i.test(docs), false);
    assert.match(docs, /Passing one is `validation_failed`/);
    const validate = require('../../src/projects/validate');
    assert.equal(Object.prototype.hasOwnProperty.call(validate, 'CONTRACT_HISTORY_GAPS'), false);
    for (const kind of ['renamed', 'risk-unacked', 'archived', 'restored', 'people-override', 'flags-updated']) {
      assert.ok(HISTORY_KINDS.includes(kind));
      assert.equal(check(historySchema, { kind }).ok, false);
    }
  });
});
