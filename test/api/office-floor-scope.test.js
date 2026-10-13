'use strict';
const {describe,it,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {loadScenario}=require('../helpers/scenario');
const {startServer}=require('../helpers/harness');
const R=require('../../src/engine/office/layout-rules');
const {floorLayout}=require('../../src/engine/office/floors');

const indexOf=m=>({manifest:m,rooms:new Map(m.rooms.map(x=>[x.id,x])),furniture:new Map(m.furniture.map(x=>[x.id,x])),
  characters:new Map(m.characters.map(x=>[x.id,x])),accessories:new Map(m.accessories.map(x=>[x.id,x])),themes:new Map(m.themes.map(x=>[x.id,x]))});
function addPlant(vm,uid){
  const data=structuredClone(vm.layout.data),index=indexOf(vm.manifest),room=index.rooms.get(data.room);
  for(let y=0;y<room.rows;y++)for(let x=0;x<room.cols;x++){
    const item={uid,asset:'plant-small',x,y,orientation:'sw'};
    if(R.checkPlacement(data,index,item).ok){data.items.push(item);return data;}
  }
  throw new Error('fixture has no legal plant location');
}

describe('backend floor-scoped layout API',()=>{
  let h;
  before(async()=>{h=await startServer(loadScenario('synthetic-basic'));});
  after(async()=>{await h?.stop();});
  const get=async(id,version=3)=>{const r=await h.get('/api/v'+version+'/office/layout'+(id?'?floorId='+id:''));assert.equal(r.status,200,r.text);return r.json.data;};

  it('serves generated floor/default data and a scoped topic directly in v2 and v3 without client projection',async()=>{
    const root=await get();
    for(const version of [2,3])for(const id of ['1','2','gym','rdc']){
      const response=await h.get('/api/v'+version+'/office/layout?floorId='+id);assert.equal(response.status,200,response.text);
      const vm=response.json.data;
      assert.equal(response.json.meta.topic.id,'layout?floorId='+id);
      assert.equal(vm.layout.revision,root.layout.revision);
      assert.equal(vm.layout.data.room,id==='gym'?'gym':id==='rdc'?'lobby':'bureau');
      assert.equal(vm.allowNoDesk,id==='rdc'||id==='gym');
      assert.equal(Object.hasOwn(vm.layout.data,'floors'),false);
      if(id==='2')assert.ok(vm.layout.data.items.filter(i=>i.asset==='desk').every(i=>i.uid.startsWith('floor-2-desk-')));
      if(id==='gym'||id==='rdc')assert.equal(vm.layout.data.items.some(i=>i.asset==='desk'),false);
      assert.deepEqual(vm.default.data.items,vm.layout.data.items);
    }
  });

  it('merges each projected floor save on the backend, retaining all other furniture and owner appearances',async()=>{
    const initial=await get();
    for(const id of ['gym','rdc','2']){
      const before=await get(),local=await get(id),data=addPlant(local,'scope-'+id+'-plant');
      const result=await h.request('PUT','/api/v3/office/layout',{floorId:id,expectedRevision:local.layout.revision,data});
      assert.equal(result.status,200,result.text);
      assert.ok(result.json.data.vm.layout.data.items.some(i=>i.uid==='scope-'+id+'-plant'));
      const after=await get();assert.deepEqual(after.layout.data.items,initial.layout.data.items);
      assert.deepEqual(after.layout.data.agents,initial.layout.data.agents);
      for(const f of before.layout.data.floors??[])if(f.id!==id)assert.deepEqual(after.layout.data.floors.find(next=>next.id===f.id),f);
    }
  });

  it('destination validation policy never permits an office floor without a work desk',async()=>{
    const root=await get();
    for(const id of ['1','2']){
      const vm=await get(id);assert.equal(vm.allowNoDesk,false);
      const data={...vm.layout.data,items:[],agents:vm.layout.data.agents.map(a=>({...a,station:'auto'}))};
      const result=await h.request('PUT','/api/v3/office/layout?floorId='+id,{expectedRevision:vm.layout.revision,data});
      assert.equal(result.status,400);assert.ok(result.json.error.details.some(e=>e.issue==='no-desk'));
    }
    assert.equal((await get()).layout.revision,root.layout.revision);
  });

  it('projects version history and conflict VMs for the selected floor, then restores without erasing another floor',async()=>{
    const initial=await get(),local=await get('2');
    const saved=await h.request('PUT','/api/v3/office/layout',{floorId:'2',expectedRevision:local.layout.revision,data:addPlant(local,'history-plant')});assert.equal(saved.status,200,saved.text);
    const other=await get('gym');
    const changed=await h.request('PUT','/api/v3/office/layout/theme',{floorId:'gym',expectedRevision:other.layout.revision,theme:{mode:'fixed',fixed:'night'}});assert.equal(changed.status,200,changed.text);
    const stale=await h.request('PUT','/api/v3/office/layout',{floorId:'2',expectedRevision:local.layout.revision,data:local.layout.data});
    assert.equal(stale.status,409,stale.text);assert.ok(stale.json.error.current.vm.layout.data.items.some(i=>i.uid==='history-plant'));
    assert.ok(stale.json.error.current.vm.layout.data.items.filter(i=>i.asset==='desk').every(i=>i.uid.startsWith('floor-2-desk-')));
    const revision=await h.get('/api/v3/office/layout/revisions/'+initial.layout.revision+'?floorId=2');assert.equal(revision.status,200,revision.text);
    assert.equal(revision.json.data.data.items.some(i=>i.uid==='history-plant'),false);
    const latest=await get();
    const restored=await h.request('PUT','/api/v3/office/layout',{floorId:'2',expectedRevision:latest.layout.revision,data:revision.json.data.data});assert.equal(restored.status,200,restored.text);
    assert.deepEqual((await get('gym')).layout.data.theme,{mode:'fixed',fixed:'night'});
  });

  it('scope-aware theme writes and v2 saves preserve the canonical registry',async()=>{
    const before=await get('rdc',2);
    const themed=await h.request('PUT','/api/v2/office/layout/theme?floorId=rdc',{expectedRevision:before.layout.revision,theme:{mode:'fixed',fixed:'day'}});assert.equal(themed.status,200,themed.text);
    assert.equal(themed.json.data.vm.theme.resolved,'day');
    const local=await get('rdc',2);
    const saved=await h.request('PUT','/api/v2/office/layout?floorId=rdc',{expectedRevision:local.layout.revision,data:local.layout.data});assert.equal(saved.status,200,saved.text);
    const root=await get();assert.ok(root.layout.data.floors.some(f=>f.id==='2'));assert.equal(root.layout.data.floors.find(f=>f.id==='rdc').layout.theme.fixed,'day');
  });

  it('rejects malformed/conflicting selectors, cross-floor payloads and reserved-elevator placement without a revision change',async()=>{
    const root=await get(),local=await get('gym');
    for(const query of ['floorId=../2','floorId=0','floorId=10001','floorId=2&floorId=3'])assert.equal((await h.get('/api/v3/office/layout?'+query)).status,400,query);
    const bodies=[{floorId:{id:'gym'},data:local.layout.data},{floorId:'gym',data:{...local.layout.data,floors:root.layout.data.floors??[]}},
      {floorId:'gym',data:{...local.layout.data,items:[...local.layout.data.items,{uid:'blocked-elevator',asset:'plant-small',...R.elevatorAccess(local.layout.data,indexOf(local.manifest)).cell}]}}];
    for(const body of bodies)assert.equal((await h.request('PUT','/api/v3/office/layout',{expectedRevision:root.layout.revision,...body})).status,400,JSON.stringify(body.floorId));
    assert.equal((await h.request('PUT','/api/v3/office/layout?floorId=2',{floorId:'gym',expectedRevision:root.layout.revision,data:local.layout.data})).status,400);
    assert.equal((await get()).layout.revision,root.layout.revision);
  });
});

it('scoped writes retain the existing store read-only guard',async()=>{
  const h=await startServer(loadScenario('synthetic-basic'),{env:{PORTAL_READONLY_STORE:'1'}});
  try{
    const read=await h.get('/api/v3/office/layout?floorId=gym');assert.equal(read.status,200,read.text);
    const write=await h.request('PUT','/api/v3/office/layout',{floorId:'gym',expectedRevision:read.json.data.layout.revision,data:read.json.data.layout.data});assert.equal(write.status,403,String(write.json?.error?.code??write.status));
  }finally{await h.stop();}
});
