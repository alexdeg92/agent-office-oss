'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {planOfficePlacement}=require('../../src/engine/office/placement.js');
const {floorId,floorLayout,saveFloor,validateFloors}=require('../../src/engine/office/floors.js');
const R=require('../../src/engine/office/layout-rules.js');
const {buildGrid,isWalkable}=require('../../src/engine/office/pathfind.js');
// The production caller supplies an art index; the planner does not import any browser module.
const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../../design/office/manifest.example.json')));
const index={manifest,rooms:new Map(manifest.rooms.map(x=>[x.id,x])),furniture:new Map(manifest.furniture.map(x=>[x.id,x])),
  characters:new Map(manifest.characters.map(x=>[x.id,x])),accessories:new Map(manifest.accessories.map(x=>[x.id,x])),themes:new Map(manifest.themes.map(x=>[x.id,x]))};
const base=JSON.parse(fs.readFileSync(path.join(__dirname,'../../design/office/layout.example.json')));
const member=(n,parentId=null)=>({id:'agent:foreign-'+n,role:'agent',parentId,teamId:parentId?'canonical-team':null,groupId:'roster-group',rosterOrder:100-n,state:'working',name:'Same name',context:'Retained',provider:'foreign-provider'});
const team=n=>Array.from({length:n},(_,i)=>member(i,i?'agent:foreign-0':null));
const freeze=v=>{if(v&&typeof v==='object'){Object.freeze(v);for(const x of Object.values(v))freeze(x);}return v;};

test('backend placements preserve input identity/order/parent/team/status and seat PM plus nine atomically',()=>{
  const occupants=team(10).reverse(),snapshot=structuredClone(occupants),layout=freeze(structuredClone(base));
  freeze(occupants);
  const result=planOfficePlacement({index,layout,occupants});
  assert.deepEqual(occupants,snapshot);
  assert.deepEqual(result.placements.map(p=>p.id),occupants.map(o=>o.id),'no roster sorting at the placement boundary');
  assert.deepEqual([...new Set(result.placements.map(p=>p.floorId))],['2']);
  assert.equal(new Set(result.placements.map(p=>p.stationUid)).size,10);
  const floor=result.floors.find(f=>f.id==='2');
  assert.ok(result.placements.every(p=>p.stationUid&&floor.layout.items.some(i=>i.uid===p.stationUid)&&p.standingPoint===null));
  assert.deepEqual(R.validateLayout(floorLayout(layout,index,floor.id),index),[]);
  assert.ok(result.floors.every(f=>!Object.hasOwn(f.layout,'agents')),'room definitions do not disclose global private appearance/name rules');
  assert.ok(result.placements.every(p=>Object.keys(p).sort().join(',')==='activity,floorId,homeTarget,id,sceneTarget,sceneTravel,standingPoint,stationUid'),
    'placements contain only spatial assignments and the backend scene targets');
});

test('oversized teams stay on one backend floor with real seats and reachable standing targets near their island',()=>{
  const result=planOfficePlacement({index,layout:base,occupants:team(14)});
  assert.equal(new Set(result.placements.map(p=>p.floorId)).size,1);
  const floor=result.floors.find(f=>f.id===result.placements[0].floorId);
  const seated=result.placements.filter(p=>p.stationUid),standing=result.placements.filter(p=>!p.stationUid);
  assert.equal(seated.length,floor.capacity);assert.equal(standing.length,3);
  assert.equal(new Set(seated.map(p=>p.stationUid)).size,seated.length);
  const grid=buildGrid(12,10,floor.layout.items,index.furniture),reserved=new Set(R.elevatorAccess(floor.layout,index).tiles.map(p=>p.x+','+p.y));
  const seats=seated.map(p=>{const i=floor.layout.items.find(i=>i.uid===p.stationUid);return R.seatTile(i,index.furniture.get(i.asset));});
  for(const {standingPoint:p} of standing){assert.ok(p);assert.ok(isWalkable(grid,p.x,p.y));assert.ok(!reserved.has(p.x+','+p.y));assert.ok(seats.some(s=>Math.abs(p.x-s.x)+Math.abs(p.y-s.y)<=2));}
  assert.equal(new Set(standing.map(p=>JSON.stringify(p.standingPoint))).size,3);
  assert.equal(result.unseatedTeams[0].count,3);
});

test('a sparse lead pin128 is bounded and a conflicting member pin cannot split the team',()=>{
  const layout=structuredClone(base),occupants=team(10);
  layout.agents.push({agentId:occupants[0].id,character:'subagent',station:'auto',homeFloor:'128'});
  layout.agents.push({agentId:occupants[1].id,character:'subagent',station:'auto',homeFloor:'3'});
  const result=planOfficePlacement({index,layout,occupants});
  assert.deepEqual(result.floors.map(f=>f.id),['rdc','1','128','gym']);assert.ok(result.placements.every(p=>p.floorId==='128'));
  for(const value of ['0','129000','../2','9007199254740991'])assert.equal(floorId(value),null);
});

test('deskless conversations follow canonical parent chains onto the host floor, including bridge/nested rows',()=>{
  const workers=team(10),conversation={id:'opaque:conversation',role:'conversation',parentId:workers[0].id,rosterOrder:90},nested={...conversation,id:'opaque:nested-conversation',parentId:conversation.id};
  const result=planOfficePlacement({index,layout:base,occupants:[conversation,...workers,nested]});
  for(const id of [conversation.id,nested.id]){
    const placement=result.placements.find(p=>p.id===id);
    assert.equal(placement.floorId,'2');assert.equal(placement.stationUid,null);assert.equal(placement.standingPoint,null);
    assert.equal(placement.homeTarget.floorId,'2');assert.equal(placement.sceneTarget.floorId,'2');
    assert.equal(placement.homeTarget.kind,'standing');assert.equal(placement.sceneTarget.kind,'standing');
  }
  assert.equal(result.placements.length,12);assert.equal(result.floors.find(f=>f.id==='2').capacity,11);
});

test('missing/self/cyclic parent links terminate and retain every canonical row without inferring names or providers',()=>{
  const occupants=[member(1,'absent'),member(2,'agent:foreign-2'),member(3,'agent:foreign-4'),member(4,'agent:foreign-3')];
  const result=planOfficePlacement({index,layout:base,occupants});
  assert.deepEqual(result.placements.map(p=>p.id),occupants.map(o=>o.id));assert.ok(result.placements.every(p=>p.stationUid));
  assert.deepEqual(planOfficePlacement({index,layout:base,occupants:occupants.map(o=>({...o,name:'Other',provider:'another-runtime'}))}).placements,result.placements);
});

test('backend floor validation reserves each elevator and preserves independent floor layouts',()=>{
  let data=structuredClone(base);
  for(const id of ['2','gym','rdc']){
    const local=floorLayout(data,index,id),cell=R.elevatorAccess(local,index).cell;
    const blocked={...local,items:[...local.items,{uid:'blocked',asset:'plant-small',...cell}]};
    assert.ok(validateFloors(saveFloor(data,index,id,blocked),index).some(e=>e.code==='elevator-access'));
    data=saveFloor(data,index,id,{...local,theme:{mode:'fixed',fixed:'day'}});
    assert.deepEqual(validateFloors(data,index),[]);
  }
  assert.deepEqual(data.items,base.items);assert.equal(data.floors.length,3);
});

test('two thousand independent workers get bounded generated floors and real distinct station assignments',()=>{
  const occupants=Array.from({length:2000},(_,i)=>member(i));
  const result=planOfficePlacement({index,layout:base,occupants});
  assert.equal(result.placements.length,2000);assert.equal(new Set(result.placements.map(p=>p.id)).size,2000);
  assert.ok(result.placements.every(p=>p.stationUid));assert.ok(result.floors.length<200);
});
