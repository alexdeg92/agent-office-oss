'use strict';
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
function networkFixtures(env) {
  const calls = [];
  const record = (kind, value) => {
    const event = { kind, value }; calls.push(event);
    if (env.AO_DATA_DIR) {
      const dir = path.resolve(env.AO_DATA_DIR);
      assert.ok(dir.startsWith(path.resolve(os.tmpdir()) + path.sep), 'probe evidence stays in the temp fixture');
      fs.appendFileSync(path.join(dir, 'network-probes.jsonl'), JSON.stringify(event) + '\n');
    }
  };
  return {
    calls,
    interfaces: () => { record('interfaces', 'synthetic'); return { lan: [{ address: '192.0.2.20' }] }; },
    findBinary: name => { assert.equal(name, 'tailscale'); record('findBinary', name); return '/synthetic/tailscale'; },
    run: async (file, argv) => {
      assert.equal(file, '/synthetic/tailscale'); assert.deepEqual(argv, ['status', '--json']); record('run', file);
      return { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'office.tail.example.invalid.' } }) };
    },
    lookup: async domain => { assert.equal(domain, 'office.example.invalid'); record('lookup', domain); return [{ address: '203.0.113.42' }]; },
    fetcher: async url => {
      const u = new URL(url);
      assert.ok(url === 'https://api.ipify.org?format=json' || (u.pathname === '/build.json' && ['127.0.0.1', 'office.example.invalid'].includes(u.hostname)), 'unexpected fixture request');
      record('fetcher', url);
      return new Response(JSON.stringify(u.hostname === 'api.ipify.org' ? { ip: '203.0.113.42' } : { buildId: 'synthetic-onboarding' }), { headers: { 'content-type': 'application/json' } });
    },
  };
}
module.exports = { networkFixtures };
