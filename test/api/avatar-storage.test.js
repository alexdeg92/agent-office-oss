'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAvatarStorage } = require('../../src/api/v3/avatar-storage');

test('startup reconciliation removes crash-left avatar staging files and unreferenced blobs', t => {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-avatar-reconcile-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  const storage=createAvatarStorage({dataDir});
  const root=path.join(dataDir,'user','avatar');
  const temp=path.join(root,'.'+'a'.repeat(32)+'.tmp');
  fs.writeFileSync(temp,'partial',{mode:0o600});
  assert.equal(storage.reconcile([]),1);
  assert.equal(fs.existsSync(temp),false);
});
