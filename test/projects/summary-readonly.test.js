'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openStore } = require('../../src/store');
const { createProjectsRepository } = require('../../src/store/repos/projects');
const { createProjectService } = require('../../src/projects');
const { startServer, waitFor } = require('../helpers/harness');
const { loadScenario } = require('../helpers/scenario');
test('S18-01: store readonly refuses summary before claim/dispatch across restart, then writable mode can regenerate', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-summary-ro-')), data = path.join(tmp, 'data');
  let h, store = openStore({ dir: data, instance: 'test', ownerName: 'Fixture Owner', log() {} });
  const repo = createProjectsRepository(store.db, { ownerPersonId: store.owner.id });
  const p = createProjectService({ repository: repo }).commands.create({ name: 'Fixture Project', summary: 'Original' }).vm;
  store.close();
  const state = () => {
    const db = new DatabaseSync(path.join(data, 'agent-office.sqlite'), { readOnly: true, timeout: 5000 });
    try { return { project: db.prepare('SELECT summary, summary_turn FROM projects WHERE id = ?').get(p.id), deliveries: db.prepare("SELECT count(*) n FROM project_comments WHERE kind = 'event'").get().n }; } finally { db.close(); }
  };
  const boot = readonly => startServer(loadScenario('synthetic-basic'), { env: { AO_DATA_DIR: data, PORTAL_READONLY_STORE: readonly ? '1' : '0' }, handlers: { 'sessions.get': () => ({ messages: [] }) } });
  try {
    for (let restart = 0; restart < 2; restart++) {
      h = await boot(true);
      assert.equal((await h.get('/api/v2/meta')).json.data.capabilities.openclawWrites, true);
      const revision = (await h.get('/api/v2/views/projects/' + p.id)).json.data.revision;
      for (const version of ['v2', 'v3']) {
        const r = await h.request('POST', `/api/${version}/projects/${p.id}/summary/regenerate`, { expectedRevision: revision });
        assert.equal(r.status, 403, r.text); assert.equal(r.json.error.code, 'readonly');
      }
      assert.equal(state().project.summary_turn, null); assert.equal(state().project.summary, 'Original'); assert.equal(state().deliveries, 0);
      assert.equal(h.cliCalls().filter(a => a[0] === 'agent').length, 0);
      await h.stop(); h = null;
    }
    h = await boot(false);
    const revision = (await h.get('/api/v2/views/projects/' + p.id)).json.data.revision;
    const r = await h.request('POST', `/api/v2/projects/${p.id}/summary/regenerate`, { expectedRevision: revision });
    assert.equal(r.status, 202, r.text);
    await waitFor(() => state().project.summary === 'Réponse factice.' && state().project.summary_turn === null);
    assert.equal(state().deliveries, 1);
  } finally { if (h) await h.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
