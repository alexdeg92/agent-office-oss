'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { adapterById } = require('../../src/adapters');
const { createSetupIntegrations } = require('../../src/ops/setup-integrations');

for (const action of ['install', 'uninstall']) test('critic-01: second-agent ' + action + ' failure restores reviewed bytes and modes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-plan-transaction-')), adapter = adapterById('openclaw'), original = adapter.projectTag;
  try {
    const agents = ['first', 'second'].map(id => ({ id, workspace: path.join(tmp, id) }));
    for (const a of agents) { fs.mkdirSync(a.workspace); fs.writeFileSync(path.join(a.workspace, 'AGENTS.md'), '# Synthetic private instructions\n', { mode: 0o640 }); }
    if (action === 'uninstall') for (const a of agents) original().install(a, { locale: 'fr', backupDir: path.join(tmp, 'backups') });
    const files = agents.flatMap(a => [path.join(a.workspace, 'AGENTS.md'), path.join(a.workspace, 'skills/projet/SKILL.md'), path.join(a.workspace, 'skills/projet/projet.js')]);
    const image = file => fs.existsSync(file) ? { bytes: fs.readFileSync(file).toString('base64'), mode: fs.statSync(file).mode & 0o777 } : null;
    const before = files.map(image);
    adapter.projectTag = () => { const implementation = original(); return { ...implementation, [action]: (a, options) => {
      if (a.id === 'second' && !options.dryRun) throw Object.assign(new Error('synthetic second-agent refusal'), { code: 'EIO' });
      return implementation[action](a, options);
    } }; };
    const service = createSetupIntegrations({ env: { HOME: tmp, AO_ENV: 'test', PATH: '' }, paths: {}, dataDir: path.join(tmp, 'data') });
    const plan = await service.plan({ runtime: 'openclaw', agents, locale: 'fr' });
    assert.throws(() => service.apply({ planId: plan.planId, agentIds: agents.map(a => a.id), confirmed: true, action }), { code: 'EIO' });
    assert.deepEqual(files.map(image), before, 'a later failure leaves no partial target content/mode changes');
    const retained = fs.readdirSync(plan.backupDir).filter(name => /^plan-.*\.json$/.test(name));
    assert.equal(retained.length, 1); assert.equal(fs.statSync(path.join(plan.backupDir, retained[0])).mode & 0o777, 0o600);
  } finally { adapter.projectTag = original; fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('critic-01/S01-01: rollback refuses a concurrent replacement and preserves outside bytes and private preimages', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-plan-rollback-race-')), adapter = adapterById('openclaw'), original = adapter.projectTag;
  try {
    const agents = ['first', 'second'].map(id => ({ id, workspace: path.join(tmp, id) }));
    for (const a of agents) { fs.mkdirSync(a.workspace); fs.writeFileSync(path.join(a.workspace, 'AGENTS.md'), 'Reviewed bytes'); }
    const sentinel = path.join(tmp, 'outside'); fs.writeFileSync(sentinel, 'Outside bytes');
    adapter.projectTag = () => { const implementation = original(); return { ...implementation, install: (a, options) => {
      if (a.id === 'second' && !options.dryRun) { const file = path.join(agents[0].workspace, 'AGENTS.md'); fs.unlinkSync(file); fs.symlinkSync(sentinel, file); throw Object.assign(new Error('synthetic refusal'), { code: 'EIO' }); }
      return implementation.install(a, options);
    } }; };
    const service = createSetupIntegrations({ env: { HOME: tmp, AO_ENV: 'test', PATH: '' }, paths: {}, dataDir: path.join(tmp, 'data') });
    const plan = await service.plan({ runtime: 'openclaw', agents });
    assert.throws(() => service.apply({ planId: plan.planId, agentIds: agents.map(a => a.id), confirmed: true }), { code: 'EROLLBACK' });
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Outside bytes'); assert.ok(fs.lstatSync(path.join(agents[0].workspace, 'AGENTS.md')).isSymbolicLink());
    assert.ok(fs.readdirSync(plan.backupDir).some(name => /^plan-.*\.json$/.test(name)));
  } finally { adapter.projectTag = original; fs.rmSync(tmp, { recursive: true, force: true }); }
});


test('critic-01: a returned second-agent conflict also restores the selected plan', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-plan-conflict-')), adapter = adapterById('openclaw'), original = adapter.projectTag;
  try {
    const agents = ['first', 'second'].map(id => ({ id, workspace: path.join(tmp, id) }));
    for (const a of agents) { fs.mkdirSync(a.workspace); fs.writeFileSync(path.join(a.workspace, 'AGENTS.md'), 'Original private instructions', { mode: 0o640 }); }
    adapter.projectTag = () => { const I = original(); return { ...I, install(a, options) {
      if (a.id === 'second' && !options.dryRun) return { status: 'conflict', done: [], refused: 'synthetic-refusal' };
      return I.install(a, options);
    } }; };
    const service = createSetupIntegrations({ env: { HOME: tmp, AO_ENV: 'test', PATH: '' }, paths: {}, dataDir: path.join(tmp, 'data') });
    const plan = await service.plan({ runtime: 'openclaw', agents });
    assert.throws(() => service.apply({ planId: plan.planId, agentIds: ['first', 'second'], confirmed: true }), { code: 'ECONFLICT' });
    for (const a of agents) {
      assert.equal(fs.readFileSync(path.join(a.workspace, 'AGENTS.md'), 'utf8'), 'Original private instructions');
      assert.equal(fs.statSync(path.join(a.workspace, 'AGENTS.md')).mode & 0o777, 0o640);
      assert.ok(!fs.existsSync(path.join(a.workspace, 'skills/projet')));
    }
  } finally { adapter.projectTag = original; fs.rmSync(tmp, { recursive: true, force: true }); }
});
