'use strict';
// S16: v1 is removed. Every topology is engine-only: no v1 routes, legacy runtime, v1 SSE or old UI, and the former
// rollback flag AO_LEGACY_V1 means nothing. The engine is fed by the source loop; v2/v3 are unchanged (byte-identity:
// architect-50).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');
const { loadConfig } = require('../../src/config');

const sc = loadScenario('synthetic-basic');
const base = { PORTAL_EMAIL: 'a@example.invalid', PORTAL_SECRET: 's'.repeat(40), PORTAL_PASSWORD: 'x', AO_ENV: 'test', HOME: '/tmp', AO_DATA_DIR: '/tmp/ao-eo-unused' };
const V1 = ['/api/summary', '/api/health', '/api/logs', '/api/cron', '/api/access', '/api/skills', '/api/channels', '/api/session', '/api/interlocutor', '/api/data-quality', '/api/stream'];

describe('S16 · v1 is gone', () => {
  it('the config has no v1 flag, whatever the environment says', () => {
    for (const env of [{}, { AO_API_ONLY: '1' }, { AO_LEGACY_V1: '1' }, { AO_API_ONLY: '1', AO_LEGACY_V1: '1' }]) {
      assert.equal('legacyV1' in loadConfig(Object.assign({}, base, env)), false, JSON.stringify(env));
    }
  });

  for (const [name, env] of [['API only (production)', { AO_API_ONLY: '1' }], ['one port, with the former rollback flag set', { AO_LEGACY_V1: '1' }]]) {
    describe(name, () => {
      let h;
      before(async () => { h = await startServer(sc, { env }); });
      after(async () => { if (h) await h.stop(); });
      it('no v1 route; login, /api/me, v2 and v3 work and the engine is fed (gateway up, sessions, skills polled for the primary)', async () => {
        for (const p of V1) assert.equal((await h.get(p)).status, 404, p);
        for (const [m, p] of [['POST', '/api/cron'], ['POST', '/api/chat'], ['POST', '/api/gateway/restart'], ['POST', '/api/skills/weather/toggle']]) assert.equal((await h.request(m, p, {})).status, 404, m + ' ' + p);
        assert.equal((await h.get('/api/me')).status, 200);
        for (const v of ['v2', 'v3']) {
          assert.equal((await h.get(`/api/${v}/me`)).json.data.gateway, 'up', v);
          assert.ok((await h.get(`/api/${v}/views/logs`)).json.data.items.length > 0, v);
        }
        assert.ok(h.cliCalls().some((a) => a[0] === 'skills' && a[1] === 'list' && a.includes('main')));
        assert.doesNotMatch(h.output, /v1 on|engine-only/);
      });
      if (!env.AO_API_ONLY) {
        it('the old UI\'s entry points go to the /v2 UI', async () => {
          for (const p of ['/', '/index.html', '/logs']) {
            const r = await fetch(h.base + p, { redirect: 'manual' });
            assert.deepEqual([r.status, r.headers.get('location')], [302, '/v2/'], p);
          }
        });
      }
    });
  }
});
