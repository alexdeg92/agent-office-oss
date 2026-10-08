// S16 follow-up (PM): the v1 UI files under public/ are gone, and nothing serves them. The backend-served UI mode still
// serves /v2; /sw.js is a worker that unregisters itself, so browsers that installed v1's worker drop it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { loadScenario } = require('../helpers/scenario');
const { startServer } = require('../helpers/harness');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const V1 = ['index.html', 'app.js', 'app.css', 'office.js', 'sw.js', 'icon.svg', 'manifest.webmanifest', '_ds'];

describe('v1 UI removal', () => {
  it('no v1 file is left in public/ outside public/v2', () => {
    const left = fs.readdirSync(path.join(ROOT, 'public')).filter((n) => n !== 'v2');
    assert.deepEqual(left, []);
  });

  let h;
  before(async () => { h = await startServer(loadScenario('synthetic-basic')); });
  after(async () => { if (h) await h.stop(); });

  it('the backend-served mode serves no v1 path, still serves /v2, and retires the v1 service worker', async () => {
    for (const p of ['/app.js', '/office.js', '/app.css', '/icon.svg', '/manifest.webmanifest', '/_ds/styles.css', '/_ds/tokens/colors.css']) {
      const r = await fetch(h.base + p, { redirect: 'manual' });
      assert.notEqual(r.status, 200, p + ' is not served');
      if (r.status === 302) assert.equal(r.headers.get('location'), '/v2/', p);
    }
    const ui = await fetch(h.base + '/v2/app.js');
    assert.equal(ui.status, 200);
    const sw = await fetch(h.base + '/sw.js', { redirect: 'manual' });
    assert.equal(sw.status, 200, 'a worker script must not redirect, or the browser keeps the old one');
    assert.match(sw.headers.get('content-type'), /javascript/);
    assert.match(await sw.text(), /registration\.unregister\(\)/);
  });

  it('the package ships public/v2 only', () => {
    const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files;
    assert.deepEqual(files.filter((f) => /^!?public\//.test(f) && !/^!?public\/v2\//.test(f)), []);
    for (const f of V1) assert.ok(!files.includes('public/' + f), f);
  });
});
