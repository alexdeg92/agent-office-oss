'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { publish, acquirePublishLock, digest } = require('../../src/ops/config-publisher');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-publish-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return { dir, file: path.join(dir, 'config.json'), secrets: path.join(dir, 'secrets.json') }; }
test('setup and settings share private exclusive publication and replacements', t => {
 const p=fixture(t);publish(p,{version:2},{version:2,token:'first'});
 assert.throws(()=>publish(p,{version:2},{version:2}),{code:'EEXIST'});
 publish(p,{version:2,name:'new'},{version:2,token:'new'},{replace:true,expectedDigest:digest({version:2})});
 for(const f of [p.file,p.secrets]) assert.equal(fs.statSync(f).mode&0o777,0o600);
 assert.equal(JSON.parse(fs.readFileSync(p.file)).name,'new');
 assert.throws(()=>publish(p,{},{},{replace:true,expectedDigest:'stale'}),{code:'ECONFLICT'});
});
test('failure after either write restores BOTH preimages including file modes',t=>{
 const p=fixture(t);publish(p,{version:2,name:'old'},{version:2,token:'old'});
 const old=[fs.readFileSync(p.file,'utf8'),fs.readFileSync(p.secrets,'utf8')];
 for(const phase of ['secrets','config']) {
  assert.throws(()=>publish(p,{name:'new'},{token:'new'},{replace:true,hook:at=>{if(at===phase) throw new Error('fixture');}}),/fixture/);
  assert.deepEqual([fs.readFileSync(p.file,'utf8'),fs.readFileSync(p.secrets,'utf8')],old);
 }
});
test('OS publication lock refuses a competing writer and release permits it',t=>{
 const p=fixture(t);const release=acquirePublishLock(p.dir);
 try{assert.throws(()=>publish(p,{},{},{replace:true}),{code:'EBUSY'});}finally{release();}
 publish(p,{},{});
});
test('publisher refuses symlink leaves/parents and never touches their target',t=>{
 const p=fixture(t),victim=path.join(p.dir,'victim');fs.writeFileSync(victim,'untouched');fs.symlinkSync(victim,p.secrets);
 assert.throws(()=>publish(p,{},{}),{code:'EUNSAFEPATH'});assert.equal(fs.readFileSync(victim,'utf8'),'untouched');
 fs.unlinkSync(p.secrets);fs.symlinkSync(victim,path.join(p.dir,'.publish-lock.sqlite.tmp'));
 const other=path.join(p.dir,'linked');fs.symlinkSync(p.dir,other);
 assert.throws(()=>publish({file:path.join(other,'config.json'),secrets:path.join(other,'secrets.json')},{},{}),{code:'EUNSAFEPATH'});
});
