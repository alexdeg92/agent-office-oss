'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../helpers/harness');
const { loadScenario } = require('../helpers/scenario');

// An env-only install with an orchestration source active routes Office through office-scope.
// The env owner has no users row; Office and the Store catalog must still load for it.
function teamStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-team-'));
  for (const dir of ['members', 'tasks', 'inbox']) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, 'members', 'lead.json'), JSON.stringify({ id: 'mem_lead', name: 'Lead', role: 'lead' }));
  return root;
}

test('env owner reads Office and the Store catalog while a team store routes Office through office-scope', async t => {
  const root = teamStore(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = await startServer(loadScenario('synthetic-basic'), { env: { AO_TEAM_STORE_ROOT: root } }); t.after(() => h.stop());
  for (const v of [2, 3]) {
    const office = await h.get(`/api/v${v}/views/office`);
    assert.equal(office.status, 200, `v${v} office: ${office.text}`);
    const store = await h.get(`/api/v${v}/views/office/store?floorId=1&section=mobilier`);
    assert.equal(store.status, 200, `v${v} store: ${store.text}`);
  }
});

test('env owner sees the team registered by the team skill as one Office team group', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-team-skill-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['members', 'tasks', 'inbox']) fs.mkdirSync(path.join(root, dir));
  const id = n => 'member:' + n.repeat(32);
  // Shapes the skill writes: a bare lead record, workers with herdr pane/session metadata (absent herdr here).
  for (const member of [{ id: id('a'), name: 'pm' },
    { id: id('b'), name: 'backend', role: 'backend', runtime: 'claude', herdrPane: 'w9:p3', session: { source: 'herdr:claude', kind: 'id', value: 'session-backend' }, spawnedBy: id('a') },
    { id: id('c'), name: 'ui', role: 'frontend', runtime: 'cursor', herdrPane: 'w9:p4', spawnedBy: id('a') },
    { id: id('d'), name: 'investigator', role: 'investigator', runtime: 'codex', herdrPane: 'w9:p5', spawnedBy: id('a') }])
    fs.writeFileSync(path.join(root, 'members', member.name + '.json'), JSON.stringify({ registered: '2026-11-10T15:45:30', ...member }));
  const h = await startServer(loadScenario('synthetic-basic'), { env: { AO_TEAM_STORE_ROOT: root } }); t.after(() => h.stop());
  for (const v of [2, 3]) {
    let office;
    for (let attempt = 0; attempt < 50; attempt++) {
      office = await h.get(`/api/v${v}/views/office`);
      if (office.status === 200 && (office.json.data.teamGroups || []).length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(office.status, 200, `v${v} office: ${office.text}`);
    const members = office.json.data.occupants.filter(row => row.memberId).map(row => row.name).sort();
    assert.deepEqual(members, ['backend', 'investigator', 'pm', 'ui'], `v${v} every registered member is an Office occupant`);
    assert.equal(office.json.data.teamGroups.length, 1, `v${v} one team group`);
  }
});
