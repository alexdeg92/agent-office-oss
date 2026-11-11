'use strict';
// A fresh checkout started before `node scripts/build-frontend.js` served an unstyled page with no server-side hint.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { warnIfUnbuilt } = require('../../src/api/ui-build');

test('an unbuilt interface is named at boot with the build command; a built one is quiet', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ui-build-'));
  try {
    const said = [];
    assert.equal(warnIfUnbuilt(root, (m) => said.push(m)), true);
    assert.match(said[0], /not built/); assert.match(said[0], /node scripts\/build-frontend\.js/);
    fs.mkdirSync(path.join(root, 'bureau')); fs.writeFileSync(path.join(root, 'bureau', 'bundle.css'), '');
    assert.equal(warnIfUnbuilt(root, (m) => said.push(m)), false);
    assert.equal(said.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
