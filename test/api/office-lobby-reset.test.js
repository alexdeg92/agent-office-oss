'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadScenario}=require('../helpers/scenario');
const {startServer}=require('../helpers/harness');
const {officeDefaults}=require('../../src/api/v2/vm/office');
const {floorLayout,validateFloors}=require('../../src/engine/office/floors');
const {elevatorAccess,homeStations}=require('../../src/engine/office/layout-rules');
const {planOfficePlacement}=require('../../src/engine/office/placement');

test('scoped legacy-lobby reset installs approved geometry and retains theme, owner looks and other floors',async()=>{
  const h=await startServer(loadScenario('synthetic-basic'));
  try{
    const path='/api/v3/office/layout?floorId=rdc';
    const read=async target=>{const r=await h.get(target);assert.equal(r.status,200,r.text);return r.json.data;};
    const initial=await read('/api/v3/office/layout/revisions/1');
    const legacy={...initial.data,room:'bureau',theme:{mode:'fixed',fixed:'day',day:'day',night:'night',nightFrom:'19:00',nightTo:'07:00',season:'hiver'},items:[
      {uid:'floor-elevator',asset:'elevator-door',wall:'right',offset:0},
      {uid:'floor-reception',asset:'reception-counter',x:0,y:7,orientation:'sw'},
      {uid:'floor-pause-shelter',asset:'pause-shelter',x:8,y:7,orientation:'sw'},
      {uid:'floor-ash-receptacle',asset:'ash-receptacle',x:6,y:7,orientation:'sw'},
    ]};
    // Historical browser geometry blocks the now-reserved elevator path, so it
    // cannot be created through today's validator. Seed only the throwaway test
    // store, reproducing an already persisted pre-upgrade layout.
    h.withStore(db=>{
      const row=db.prepare('SELECT id,data_json FROM office_layouts WHERE active=1').get();
      const data=JSON.parse(row.data_json);
      const {index}=officeDefaults(),floor=floorLayout(data,index,'2');
      const cell=elevatorAccess(floor,index).cell;
      const desk=floor.items.find(i=>i.asset==='desk');desk.x=cell.x;desk.y=cell.y;
      floor.items.push({...desk,uid:'floor-2-desk-legacy',x:0,y:7});
      assert.equal(homeStations(floor,index).filter(uid=>floor.items.find(i=>i.uid===uid).asset==='desk').length,11);
      data.floors=[...(data.floors??[]).filter(f=>!['rdc','2'].includes(f.id)),
        {id:'rdc',kind:'lobby',layout:{room:legacy.room,theme:legacy.theme,items:legacy.items}},
        {id:'2',kind:'office',layout:{room:floor.room,theme:floor.theme,items:floor.items}}];
      assert.ok(validateFloors(data,index).some(e=>e.floorId==='2'&&e.code==='elevator-access'));
      const occupants=Array.from({length:11},(_,n)=>({id:'agent:historical-'+n,role:'agent',state:'working',parentId:n?'agent:historical-0':null,teamId:'historical-team'}));
      const {match,...look}=data.agents.find(a=>a.agentId==='*subagent');
      data.agents.push({...look,agentId:occupants[0].id,homeFloor:'2',station:'auto'});
      const planned=planOfficePlacement({index,layout:data,occupants});
      assert.ok(planned.placements.every(p=>p.floorId==='2'&&p.stationUid&&p.homeTarget.floorId==='2'),'saved legacy desks remain assigned as an atomic team');
      db.prepare('UPDATE office_layouts SET data_json=? WHERE id=?').run(JSON.stringify(data),row.id);
    });
    const root=await read('/api/v3/office/layout'),gym=await read('/api/v3/office/layout?floorId=gym');
    const vm=await read(path);assert.deepEqual(vm.layout.data.items,legacy.items);
    assert.equal(vm.default.data.room,'lobby');assert.equal(vm.default.data.items.length,15);
    const data={...vm.layout.data,room:vm.default.data.room,items:vm.default.data.items};
    const reset=await h.request('PUT',path,{expectedRevision:vm.layout.revision,data});
    assert.equal(reset.status,200,reset.text);
    const saved=await read(path);
    assert.equal(saved.layout.revision,vm.layout.revision+1);
    assert.equal(saved.layout.data.room,'lobby');
    assert.deepEqual(saved.layout.data.items,vm.default.data.items);
    assert.deepEqual(saved.layout.data.theme,legacy.theme);
    assert.deepEqual(saved.layout.data.agents,vm.layout.data.agents);
    assert.deepEqual((await read('/api/v3/office/layout?floorId=gym')).layout.data,gym.layout.data);
    const after=await read('/api/v3/office/layout');
    for(const key of Object.keys(root.layout.data))if(key!=='floors')assert.deepEqual(after.layout.data[key],root.layout.data[key],key);
    for(const floor of root.layout.data.floors??[])if(floor.id!=='rdc')assert.deepEqual(after.layout.data.floors.find(f=>f.id===floor.id),floor);
    const stale=await h.request('PUT',path,{expectedRevision:vm.layout.revision,data});
    assert.equal(stale.status,409,'a stale reset never silently overwrites a newer save');
    const office=await read('/api/v3/office/layout?floorId=2');
    const theme=await h.request('PUT','/api/v3/office/layout/theme?floorId=2',{expectedRevision:office.layout.revision,theme:{mode:'fixed',fixed:'night'}});
    assert.equal(theme.status,200,theme.text);
    const latest=await read('/api/v3/office/layout?floorId=2');
    const bad={...latest.layout.data,items:[...latest.layout.data.items,{uid:'new-invalid',asset:'plant-small',...elevatorAccess(latest.layout.data,officeDefaults().index).cell}]};
    const rejected=await h.request('PUT','/api/v3/office/layout?floorId=2',{expectedRevision:latest.layout.revision,data:bad});
    assert.equal(rejected.status,400,'new invalid geometry never inherits the baseline exemption');
    assert.ok(rejected.json.error.details.some(e=>e.issue==='elevator-access'));
    const badLook={...latest.layout.data,agents:latest.layout.data.agents.map((a,n)=>n? a:{...a,character:'unknown'})};
    assert.equal((await h.request('PUT','/api/v3/office/layout?floorId=2',{expectedRevision:latest.layout.revision,data:badLook})).status,400,'appearance validation remains strict');
  }finally{await h.stop();}
});
