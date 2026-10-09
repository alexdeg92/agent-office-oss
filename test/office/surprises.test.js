const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
test('26b: neutral idle eligibility, weighted registries, persistent cooldown and a shared lease',async()=>{
 const m=await import('../../public/v2/office/surprises.js');
 const o={state:'idle',stateSince:0};
 assert.equal(m.eggEligible(o,899999),false);assert.equal(m.eggEligible(o,900000),true);
 for(const patch of [{state:'working'},{presence:'seen'},{destination:{stationUid:'desk'}},{stateSince:undefined}])assert.equal(m.eggEligible({...o,...patch},900000),false);
 assert.equal(m.eggEligible(o,900000,0),false);assert.equal(m.eggEligible(o,1200000,0),true);
 assert.equal(m.pickEgg('gym',()=>true,()=>0),'hide');assert.equal(m.pickEgg('hide',()=>true,()=>0),'gym');assert.equal(m.pickEgg(null,()=>false),null);
 const a={},b={};assert.equal(m.acquireSurprise(a),true);assert.equal(m.acquireSurprise(b),false);m.releaseSurprise(b);assert.equal(m.acquireSurprise(b),false);m.releaseSurprise(a);assert.equal(m.acquireSurprise(b),true);m.releaseSurprise(b);
 m.rememberSurprise('agent',100,'gym');assert.deepEqual(m.surpriseHistory('agent'),{at:100,kind:'gym'});
 for(let i=0;i<1025;i++)m.rememberSurprise('agent-'+i,i,'hide');assert.equal(m.surpriseHistory('agent'),undefined);
 for(const file of ['egg-controller.js','break-room.js','surprises.js'])assert.doesNotMatch(fs.readFileSync('public/v2/office/'+file,'utf8'),/setTimeout|setInterval/,'shared-clock deadlines: '+file);
});
test('26b: all eight looks have all ten registered egg frames, real held art, bench contact, and five accessory pairs',()=>{
 const manifest=JSON.parse(fs.readFileSync('design/office/manifest.example.json')),anchors=JSON.parse(fs.readFileSync('design/assets/anchors.json')).assets;
 const poses=['curl-low','curl-high','bench-low','bench-high','wipe','light','smoke','crush','hide','shake'];let count=0;
 for(const ch of manifest.characters)for(const v of ch.variants?.length?ch.variants:[ch])for(const p of poses){
  const name='egg-'+p+'-sw',body=v.poses[name];assert.ok(body,name);assert.ok(body.image.endsWith('.webp'));
  const meta=anchors[body.image.replace(/^assets\//,'')];assert.ok(meta.source.includes('office26b-sources'));assert.equal(meta.registration.mirrored,false);assert.ok(meta.handAnchor.every(Number.isFinite));
  if(p.startsWith('bench'))assert.ok(body.seatAnchor&&Number.isFinite(body.seatAnchor.x));
  if(['light','smoke','crush'].includes(p))assert.ok(body.fxAnchor&&Number.isFinite(body.fxAnchor.x));
  for(const gear of manifest.accessories)assert.ok(gear.layers[(v===ch?ch.id:ch.id+'/'+v.id)][name]);count++;
 }
 assert.equal(count,80);
 for(const room of ['gym','outdoor'])assert.ok(fs.statSync('public/v2/bureau/assets/Office/breaks/'+room+'.webp').size<200000,'lazy room bundle ships');
});
