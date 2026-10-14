'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scan } = require('../../packaging/check-public');
const sync = require('../../scripts/sync-design');
const root = path.resolve(__dirname, '../..');
const canonical = path.join(root, 'docs/architecture/examples');
const mocks = path.join(root, 'public/v2/mock/examples');

test('canonical and shipped examples pass privacy checks, including repository identities and object keys', () => {
  const env = {
    PORTAL_EMAIL: ['private-fixture-owner', 'example.invalid'].join('@'),
    PUBLIC_PRIVATE_NAMES: ['al' + 'exdeg92', 'agent-office-' + 'oss'].join('|'),
  };
  for (const dir of [canonical, mocks]) assert.deepEqual(scan(dir, env).findings, [], path.relative(root, dir));
  const visit = (file, value) => {
    if (Array.isArray(value)) return value.forEach(v => visit(file, v));
    if (!value || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value)) {
      if (/avatar/i.test(key) && typeof v === 'string' && /^https?:/i.test(v)) {
        const host = new URL(v).hostname;
        assert.match(host, /(?:^|\.)(?:example\.(?:com|org|net)|[^.]+\.(?:test|invalid|example))$/, `${file}: external avatar host`);
      }
      visit(file, v);
    }
  };
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.json')) visit(path.relative(root, file), JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  };
  walk(canonical); walk(mocks);
});

test('shipped contract mock examples equal their canonical source bytes', () => {
  const pairs = sync.plan().filter(([src, dest]) => src.startsWith(canonical + path.sep) && dest.startsWith(mocks + path.sep));
  assert.ok(pairs.length >= 11);
  for (const [src, dest] of pairs) assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(src), path.relative(root, dest));
});
