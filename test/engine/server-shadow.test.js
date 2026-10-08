'use strict';
// The real server's engine sees every raw input and reports data quality: through the v2/v3 health view since S16
// (v1's /api/data-quality is gone).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadScenario } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');

describe('server: the engine\'s data quality', () => {
  let h;
  before(async () => { h = await startServer(loadScenario('synthetic-basic')); });
  after(async () => { if (h) await h.stop(); });

  it('the health view (auth required) counts unknown activity events', async () => {
    for (const v of ['v2', 'v3']) assert.equal((await fetch(`${h.base}/api/${v}/views/health`)).status, 401, v);
    const dq = async () => (await h.get('/api/v2/views/health')).json.data;
    const before = await dq();
    assert.deepEqual(before.dataQuality.open, { error: 0, warn: 0, info: 0 });
    assert.ok(before.sources.some((s) => s.id === 'gateway' && s.state === 'fresh'));
    h.gw.emit('session.message', { sessionKey: 'agent:main:main', type: 'text' });
    await waitFor(async () => (await dq()).dataQuality.open.info === 1, { what: 'event.unknown recorded' });
    assert.ok((await dq()).dataQuality.issues.some((i) => i.code === 'event.unknown'));
  });

  it('sessions.usage is never requested; host metrics, config, gateway and CLI reach the engine', async () => {
    assert.equal(h.gw.callsTo('sessions.usage').length, 0);
    assert.ok(h.gw.callsTo('agents.list').length >= 1);
    const { sources } = (await h.get('/api/v2/views/health')).json.data;
    for (const id of ['config', 'host', 'gateway', 'cli']) assert.ok(sources.some((s) => s.id === id && s.state === 'fresh'), id);
  });
});
