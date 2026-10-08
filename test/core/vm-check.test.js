'use strict';
// PM audit (B), part 2: one schema per VM (api.md §3) and runtime validation of every VM before it is sent.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../../src/schema');
const { VM_SCHEMAS } = require('../../src/api/v2/vm/schemas');
const { createVmCheck, VmError } = require('../../src/api/v2/vm/check');
const { createTopics } = require('../../src/api/v2/topics');
const { loadExample } = require('../helpers/contract-shape');

const EXAMPLE_OF = { 'office-vm': 'office', 'flow-list-vm': 'flows', 'flow-detail-vm': 'flow', 'logs-page': 'logs', 'session-vm': 'session', 'access-vm': 'access',
  'interlocutor-vm': 'interlocutor', 'skill-list-vm': 'skills', 'skill-detail-vm': 'skill', 'health-vm': 'health', 'board-vm': 'projects', 'project-vm': 'project',
  'history-page': 'history', 'candidates-vm': 'candidates', 'layout-vm': 'layout' };

describe('VM schemas · the authoritative examples', () => {
  for (const [example, name] of Object.entries(EXAMPLE_OF)) {
    it(`${example} validates against the ${name} schema`, () => {
      const r = s.validate(VM_SCHEMAS[name], loadExample(example).data);
      assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), []);
    });
  }
  it('every topic and route VM has a schema', () => {
    for (const n of ['meta', 'me', 'office', 'chat', 'flows', 'flow', 'access', 'interlocutor', 'logs', 'session', 'skills', 'skill', 'health', 'projects', 'project', 'history', 'candidates', 'layout', 'prefs']) assert.ok(VM_SCHEMAS[n], n);
  });
});

describe('VM check · runtime', () => {
  const good = { uiTheme: 'dark', locale: null };
  it('strict mode: undefined anywhere, a wrong enum, a missing field → throws; a valid VM passes through', () => {
    const c = createVmCheck({ mode: 'throw' });
    const typed = c.check('prefs', good);
    assert.ok(typed instanceof require('../../src/api/v2/vm/classes').UiPrefs, 'an instance of the section class'); assert.ok(Object.isFrozen(typed));
    assert.deepEqual(typed.toJSON(), good);
    assert.throws(() => c.check('prefs', { uiTheme: undefined, locale: null }), (e) => e instanceof VmError && e.issues[0].path === '$.uiTheme');
    assert.throws(() => c.check('prefs', { uiTheme: 'sombre', locale: null }), VmError);
    assert.throws(() => c.check('prefs', {}), VmError);
    const office = loadExample('office-vm').data;
    const broken = JSON.parse(JSON.stringify(office)); broken.occupants[0].look.variant = undefined;
    assert.throws(() => c.check('office', Object.assign({}, office, { occupants: [Object.assign({}, office.occupants[0], { tokens: undefined })] })), VmError);
  });

  it('fallback mode: the last good VM is sent and a value-free quarantine issue is raised; no last good → error', () => {
    const issues = [];
    const c = createVmCheck({ mode: 'fallback', report: (i) => issues.push(i) });
    assert.throws(() => c.check('prefs', { uiTheme: 'x', locale: null }, 'prefs'), VmError, 'nothing good to fall back on');
    c.check('prefs', good, 'prefs');
    assert.deepEqual(c.check('prefs', { uiTheme: 'secret-value', locale: null }, 'prefs').toJSON(), good);
    assert.deepEqual(issues.at(-1), { code: 'vm.invalid', severity: 'error', channel: 'vm.prefs', path: '$.uiTheme' });
    assert.ok(!JSON.stringify(issues).includes('secret-value'));
  });

  it('topics check every rebuild: a builder that turns bad keeps the last good VM (fallback)', () => {
    let theme = 'dark';
    const c = createVmCheck({ mode: 'fallback', report: () => {} });
    const topics = createTopics({ prefs: { build: () => ({ uiTheme: theme, locale: null }) } }, { coalesceMs: 0, check: c.check });
    assert.equal(topics.current('prefs').vm.uiTheme, 'dark');
    theme = undefined; topics.invalidate('prefs');
    assert.equal(topics.current('prefs').vm.uiTheme, 'dark');
  });
});

describe('VM check · through the real engine quarantine', () => {
  it('a vm.invalid issue keeps its code and channel (not relabelled schema.missing)', () => {
    const { createEngine } = require('../../src/engine');
    const engine = createEngine({ now: () => Date.UTC(2026, 9, 6) });
    engine.declareFields(require('../../src/schema').declaredNames(Object.values(VM_SCHEMAS)));   // as mountV2 does
    const c = createVmCheck({ mode: 'fallback', report: (i) => engine.quarantine.record(i) });
    c.check('prefs', { uiTheme: 'dark', locale: null }, 'prefs');
    c.check('prefs', { uiTheme: 'x', locale: null }, 'prefs');
    const issue = engine.dataQuality().issues.find((i) => i.channel === 'vm.prefs');
    assert.ok(issue); assert.equal(issue.code, 'vm.invalid'); assert.equal(issue.path, '$.uiTheme');
  });
});
