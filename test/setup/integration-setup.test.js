'use strict';
// architect-56 · first-run setup installs the project tag into the primary agent's workspace (opt-out), through the
// real server and the fake openclaw CLI (agents list → a temp workspace). Setup never fails because of it.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { loadScenario } = require('../helpers/scenario');
const { startServer, TEST_EMAIL, TEST_PASSWORD } = require('../helpers/harness');

const TOKEN = 'runtime-token-only-the-gateway-knows';
const req = (h, method, p, body) => fetch(h.base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

for (const [title, integrations, locale, expectInstalled] of [
  ['opt-in (the default): the skill and the block are installed for the primary agent, in the instance locale', undefined, 'en', true],
  ['opt-out: nothing is written, and the config says so', { projet: false }, 'fr', false],
]) {
  describe('G4 setup · the project tag · ' + title, () => {
    let h, ws, code;
    before(async () => {
      ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-setup-ws-'));
      fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# AGENTS\n\nRègles maison.\n');
      h = await startServer(loadScenario('foreign-instance'), { setupMode: true, gatewayToken: TOKEN,
        env: { AO_ENV: 'dev', FAKE_OC_AGENTS: JSON.stringify([{ id: 'atlas', workspace: ws, isDefault: true }, { id: 'scribe', workspace: path.join(ws, 'scribe'), isDefault: false }]) } });
      code = h.setupCode();
    });
    after(async () => { if (h) await h.stop(); fs.rmSync(ws, { recursive: true, force: true }); });

    it('setup advertises it; discover shows each agent\'s status; the save installs (or not) and says what happened', async () => {
      assert.deepEqual((await req(h, 'GET', '/api/v2/setup')).json.data.integrations, [{ id: 'projet', adapters: ['openclaw'], default: true }]);
      assert.equal((await req(h, 'POST', '/api/v2/setup/check', { setupCode: code, runtime: { adapter: 'openclaw', gatewayUrl: h.gw.url, token: TOKEN } })).status, 200);
      const disc = (await req(h, 'POST', '/api/v2/setup/discover', { setupCode: code, runtime: { adapter: 'openclaw', gatewayUrl: h.gw.url } })).json.data.result.agents;
      assert.equal(disc.find((a) => a.id === 'atlas').projectTag, 'absent');
      const body = { setupCode: code, instance: { name: 'Bureau', locale, timeZone: 'UTC' }, owner: { displayName: 'O', email: TEST_EMAIL, password: TEST_PASSWORD },
        runtime: { adapter: 'openclaw', gatewayUrl: h.gw.url }, agents: { primary: 'atlas', looks: {} } };
      if (integrations) body.integrations = integrations;
      const r = await req(h, 'PUT', '/api/v2/setup', body);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const agentsMd = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
      const config = JSON.parse(fs.readFileSync(path.join(h.tmp, '.config', 'agent-office', 'config.json'), 'utf8'));
      if (expectInstalled) {
        assert.deepEqual(r.json.data.result.integrations, { projet: { status: 'installed' } });
        assert.match(agentsMd, /^# AGENTS\n\n<!-- agent-office:projet:debut -->\n<!-- agent-office:projet v2 -->\n## Project tag \(Agent Office\)/);
        assert.ok(fs.existsSync(path.join(ws, 'skills', 'projet', 'projet.js')));
        assert.ok(!fs.existsSync(path.join(ws, 'scribe', 'skills')), 'only the primary agent');
        const bdir = path.join(h.tmp, 'data', 'integrations', 'backups');
        assert.ok(fs.readdirSync(bdir).some((f) => f.startsWith('atlas-AGENTS.md-')), 'a backup first, in Agent Office\'s data dir');
        assert.ok(!fs.readdirSync(ws).some((f) => /backup/.test(f)), 'none in the workspace');
        assert.deepEqual(config.integrations, { projet: true });
      } else {
        assert.deepEqual(r.json.data.result.integrations, { projet: { status: 'skipped', reason: 'opted-out' } });
        assert.equal(agentsMd, '# AGENTS\n\nRègles maison.\n');
        assert.ok(!fs.existsSync(path.join(ws, 'skills')));
        assert.deepEqual(config.integrations, { projet: false });
      }
    });
  });
}
