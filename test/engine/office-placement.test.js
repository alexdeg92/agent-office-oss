'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {planOfficePlacement}=require('../../src/engine/office/placement.js');
const {floorId,floorLayout,saveFloor,validateFloors,placementToken}=require('../../src/engine/office/floors.js');
const R=require('../../src/engine/office/layout-rules.js');
const {buildGrid,isWalkable}=require('../../src/engine/office/pathfind.js');
// The production caller supplies an art index; the planner does not import any browser module.
const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../../design/office/manifest.example.json')));
const index={manifest,rooms:new Map(manifest.rooms.map(x=>[x.id,x])),furniture:new Map(manifest.furniture.map(x=>[x.id,x])),
  characters:new Map(manifest.characters.map(x=>[x.id,x])),accessories:new Map(manifest.accessories.map(x=>[x.id,x])),themes:new Map(manifest.themes.map(x=>[x.id,x]))};
const base=JSON.parse(fs.readFileSync(path.join(__dirname,'../../design/office/layout.example.json')));
const member=(n,parentId=null)=>({id:'agent:foreign-'+n,role:'agent',parentId,teamId:parentId?'canonical-team':null,groupId:'roster-group',rosterOrder:100-n,state:'working',name:'Same name',context:'Retained',provider:'foreign-provider'});
const team=n=>Array.from({length:n},(_,i)=>member(i,i?'agent:foreign-0':null));
function deskPressureLayout(source,count){
  const isStation=item=>!!index.furniture.get(item.asset)?.station;
  const desks=source.items.filter(item=>index.furniture.get(item.asset)?.station?.kind==='desk').slice(0,count);
  const result=structuredClone(source);result.items=source.items.filter(item=>!isStation(item)).concat(desks);
  for(let i=desks.length;i<count;i++)result.items.push({uid:`pressure-desk-${i+1}`,asset:'desk',x:9,y:1,orientation:'sw'});
  let filler=0;while(result.items.length<R.MAX_ITEMS)result.items.push({uid:`pressure-rug-${filler++}`,asset:'rug',x:0,y:0});
  return result;
}
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
  assert.equal(seated.length,floor.capacity);assert.equal(standing.length,14-floor.capacity);
  assert.equal(new Set(seated.map(p=>p.stationUid)).size,seated.length);
  const grid=buildGrid(12,10,floor.layout.items,index.furniture),reserved=new Set(R.elevatorAccess(floor.layout,index).tiles.map(p=>p.x+','+p.y));
  const seats=seated.map(p=>{const i=floor.layout.items.find(i=>i.uid===p.stationUid);return R.seatTile(i,index.furniture.get(i.asset));});
  for(const {standingPoint:p} of standing){assert.ok(p);assert.ok(isWalkable(grid,p.x,p.y));assert.ok(!reserved.has(p.x+','+p.y));assert.ok(seats.some(s=>Math.abs(p.x-s.x)+Math.abs(p.y-s.y)<=2));}
  assert.equal(new Set(standing.map(p=>JSON.stringify(p.standingPoint))).size,standing.length);
  assert.equal(result.unseatedTeams[0].count,standing.length);
});

test('an active visitor follows its linked host floor to a reachable adjacent spot without taking a desk',()=>{
  const layout=structuredClone(base);
  layout.agents.push({agentId:'agent:worker',character:'subagent',station:'auto',homeFloor:'2'});
  const occupants=[
    {id:'primary',role:'primary',state:'working',stateSince:1},
    {id:'agent:worker',role:'agent',parentId:null,teamId:null,state:'working',stateSince:2},
    {id:'conversation:contact',role:'direct',parentId:'agent:worker',state:'working',stateSince:3,visitPhase:'agent'},
  ];
  const result=planOfficePlacement({index,layout,occupants});
  const host=result.placements.find(row=>row.id==='agent:worker');
  const visitor=result.placements.find(row=>row.id==='conversation:contact');
  assert.equal(host.floorId,'2');
  assert.equal(visitor.floorId,host.floorId,'canonical host placement owns the visitor floor');
  assert.equal(visitor.stationUid,null,'the contact does not consume a work desk');
  assert.equal(visitor.sceneTarget.kind,'visit');
  assert.equal(visitor.sceneTarget.floorId,host.floorId);
  assert.notDeepEqual(visitor.standingPoint,null);
  const floor=result.floors.find(row=>row.id===host.floorId);
  const grid=buildGrid(12,10,floor.layout.items,index.furniture);
  assert.ok(isWalkable(grid,visitor.standingPoint.x,visitor.standingPoint.y),'the visitor target is traversable');
  const station=floor.layout.items.find(row=>row.uid===host.stationUid);
  const hostSeat=R.seatTile(station,index.furniture.get(station.asset));
  assert.ok(Math.max(Math.abs(visitor.standingPoint.x-hostSeat.x),Math.abs(visitor.standingPoint.y-hostSeat.y))<=2,
    'the visitor stands within two tiles of the host desk');
});

test('a sparse lead pin128 is bounded and a conflicting member pin cannot split the team',()=>{
  const layout=structuredClone(base),occupants=team(10);
  layout.agents.push({agentId:occupants[0].id,character:'subagent',station:'auto',homeFloor:'128'});
  layout.agents.push({agentId:occupants[1].id,character:'subagent',station:'auto',homeFloor:'3'});
  const result=planOfficePlacement({index,layout,occupants});
  assert.deepEqual(result.floors.map(f=>f.id),['rdc','1','128','gym']);assert.ok(result.placements.every(p=>p.floorId==='128'));
  for(const value of ['0','129000','../2','9007199254740991'])assert.equal(floorId(value),null);
});

test('automatic team floors and stations are stable across poll order and a fresh planner',()=>{
  const teams = ['alpha', 'zeta'].flatMap((teamId, t) => Array.from({length: 7}, (_, i) => ({
    id: `agent:${teamId}-${i}`, role: 'agent', teamId, parentId: i ? `agent:${teamId}-0` : null,
    rosterOrder: t * 20 + 7 - i, state: 'working', name: `${teamId} ${i}`,
  })));
  const first = planOfficePlacement({index,layout:base,occupants:teams});
  const pins = first.homeAssignments;
  assert.ok(Object.keys(pins).length === 2);
  const signature = rows => Object.fromEntries(rows.map(row => [row.id, `${row.floorId}:${row.stationUid}`]));
  const expected = signature(first.placements);
  for (const occupants of [teams.toReversed(), [...teams.slice(7), ...teams.slice(0, 7)].reverse()]) {
    const projected = planOfficePlacement({index,layout:base,occupants,homeAssignments:pins});
    assert.deepEqual(signature(projected.placements), expected, 'the persisted team and per-member station assignment survives poll reorder');
  }
  // Simulate a process restart by constructing a new planner with only the persisted contract.
  const restarted = planOfficePlacement({index,layout:base,occupants:[...teams].sort((a,b)=>b.id.localeCompare(a.id)),homeAssignments:structuredClone(pins)});
  assert.deepEqual(signature(restarted.placements), expected);
});

test('an idle pinned home desk is preserved with slack and lent only under full-floor pressure',()=>{
  const layout=floorLayout(base,index,'1');
  const occupants=Array.from({length:8},(_,i)=>({id:i?'agent:borrower-'+i:'main',role:i?'agent':'primary',
    parentId:null,teamId:null,state:i?'working':'idle',stateSince:1000+i}));
  // Five workers plus two idle occupants leave one spare desk. The primary's
  // authored station stays reserved while active workers use the other desks.
  const slack=R.resolveOccupants(layout,index,occupants.slice(0,7).map((row,i)=>({...row,state:i===0||i===6?'idle':'working'})));
  const idlePrimary=slack.find(row=>row.id==='main');
  assert.equal(idlePrimary.stationUid,'st-timmy');
  assert.equal(slack.some(row=>row.id!=='main'&&row.stationUid==='st-timmy'),false);

  // Seven active workers fill all seven desks, so one may borrow the idle
  // primary's home. The home target itself remains pinned and is persisted so
  // the primary reclaims it as soon as it becomes active.
  const pressured=R.resolveOccupants(layout,index,occupants);
  const primary=pressured.find(row=>row.id==='main');
  assert.notEqual(primary.stationUid,'st-timmy');
  assert.equal(primary._homeWant,'st-timmy');
  const borrower=pressured.find(row=>row.stationUid==='st-timmy');
  assert.ok(borrower&&borrower.id!=='main');
  const saved=Object.fromEntries(pressured.map(row=>[row.id,Object.hasOwn(row,'_homeWant')?row._homeWant:row.stationUid]).filter(([,station])=>station));
  const returned=R.resolveOccupants(layout,index,occupants.map(row=>({...row,state:'working'})),{stationAssignments:saved});
  assert.equal(returned.find(row=>row.id==='main').stationUid,'st-timmy');
  assert.notEqual(returned.find(row=>row.id===borrower.id).stationUid,'st-timmy');
});

test('a non-primary returning home owner beats an earlier-sorting borrower with a stale duplicate saved pin',()=>{
  const layout=floorLayout(base,index,'1');
  const owner='agent:z-home-owner', borrower='agent:a-borrower';
  const occupants=[
    {id:owner,role:'agent',state:'idle',stateSince:1},
    {id:borrower,role:'agent',state:'working',stateSince:2},
    ...Array.from({length:6},(_,i)=>({id:`agent:worker-${i}`,role:'agent',state:'working',stateSince:3+i})),
  ];
  // Reproduce the stale collision security found: an older build saved the
  // temporarily borrowed station under both the owner and earlier-sorting
  // borrower. The inactive owner's home wins while the duplicate is repaired.
  const duplicatePins=Object.fromEntries(occupants.map(row=>[row.id,'st-3']));
  const pressured=R.resolveOccupants(layout,index,occupants,{stationAssignments:duplicatePins});
  const ownerWhileAway=pressured.find(row=>row.id===owner);
  assert.equal(ownerWhileAway._homeWant,'st-3');
  const borrowerWhileAway=pressured.find(row=>row.id===borrower);
  assert.notEqual(borrowerWhileAway.stationUid,'st-3','borrower duplicate pin cannot steal an inactive owner home');
  const saved=Object.fromEntries(pressured.map(row=>[row.id,Object.hasOwn(row,'_homeWant')?row._homeWant:row.stationUid]).filter(([,station])=>station));
  assert.equal(saved[owner],'st-3');
  assert.notEqual(saved[borrower],'st-3');

  const returned=R.resolveOccupants(layout,index,occupants.map(row=>({...row,state:'working',stateSince:100})),{stationAssignments:saved});
  assert.equal(returned.find(row=>row.id===owner).stationUid,'st-3','returning non-primary owner reclaims its saved home');
  assert.notEqual(returned.find(row=>row.id===borrower).stationUid,'st-3');
});

test('full placement lends a non-primary home under pressure, persists ownership, and reclaims it',()=>{
  const owner='agent:z-home-owner', borrower='agent:a-borrower';
  const occupants=Array.from({length:8},(_,i)=>({id:!i?owner:i===1?borrower:`agent:worker-${i}`,role:'agent',teamId:'team:z-home-owner',
    parentId:i?owner:null,state:i?'working':'idle',stateSince:i+1}));
  // Keep the atomic team on one seven-desk floor. The eight-member unit uses
  // the floor's overflow placement while the constrained generated template
  // prevents a spare overflow floor from hiding the pressure case.
  const pressureLayout=deskPressureLayout(base,7),key=placementToken('team:z-home-owner');
  const homeAssignments={[key]:{floorId:'1',stations:{[placementToken(owner)]:'st-3',[placementToken(borrower)]:'st-3'}}};
  const away=planOfficePlacement({index,layout:pressureLayout,occupants,homeAssignments});
  const awayOwner=away.placements.find(row=>row.id===owner);
  assert.equal(awayOwner.stationUid,null,'the idle owner has no desk while seven active teammates need all seven');
  assert.equal(awayOwner.homeTarget.stationUid,'st-3');
  assert.ok(away.placements.some(row=>row.id!==owner&&row.stationUid==='st-3'),'an active teammate temporarily borrows the home desk');
  const persistedStations=Object.fromEntries(Object.values(away.homeAssignments).flatMap(unit=>Object.entries(unit.stations)));
  assert.equal(persistedStations[placementToken(owner)],'st-3');
  assert.notEqual(persistedStations[placementToken(borrower)],'st-3','borrowed station is never persisted as the borrower home');

  const returned=planOfficePlacement({index,layout:pressureLayout,occupants:occupants.map(row=>({...row,state:'working',stateSince:100})),homeAssignments:away.homeAssignments});
  assert.equal(returned.placements.find(row=>row.id===owner).stationUid,'st-3');
  assert.equal(returned.placements.filter(row=>row.stationUid==='st-3').length,1);
  assert.equal(new Set(returned.placements.map(row=>row.sceneTarget.stationUid).filter(Boolean)).size,7);
});

test('active duplicate saved homes use their allocated stations as unique scene targets',()=>{
  const occupants=[{id:'agent:z-owner',role:'agent',state:'working',stateSince:20},
    {id:'agent:a-worker',role:'agent',state:'working',stateSince:10}];
  const homeAssignments=Object.fromEntries(occupants.map(row=>[placementToken(row.id),
    {floorId:'1',stations:{[placementToken(row.id)]:'st-3'}}]));
  const result=planOfficePlacement({index,layout:base,occupants,homeAssignments});
  for(const row of result.placements)assert.equal(row.sceneTarget.stationUid,row.stationUid,
    'an active occupant cannot target a duplicate saved desk it did not acquire');
  assert.equal(new Set(result.placements.map(row=>row.sceneTarget.stationUid)).size,2);
});

test('an authored station claim displaces an idle stale pin for idle and working owners',()=>{
  for(const state of ['idle','working']){
    const occupants=[{id:'main',role:'primary',state,stateSince:20},
      {id:'agent:a-borrower',role:'agent',state:'idle',stateSince:30}];
    const homeAssignments=Object.fromEntries([occupants[1]].map(row=>[placementToken(row.id),
      {floorId:'1',stations:{[placementToken(row.id)]:'st-timmy'}}]));
    const result=planOfficePlacement({index,layout:base,occupants,homeAssignments,now:5000});
    const owner=result.placements.find(row=>row.id==='main'), borrower=result.placements.find(row=>row.id==='agent:a-borrower');
    assert.equal(owner.stationUid,'st-timmy');
    assert.notEqual(borrower.stationUid,'st-timmy');
    assert.equal(owner.sceneTarget.stationUid,owner.stationUid);
    assert.equal(borrower.sceneTarget.stationUid,borrower.stationUid);
    assert.equal(new Set([owner.sceneTarget.stationUid,borrower.sceneTarget.stationUid]).size,2);
    assert.notEqual(borrower.homeTarget.stationUid,'st-timmy','a stale displaced home pin is not retained as the borrower home');
  }
});

test('a lounge station is never an agent home; an active agent with a legacy sofa pin returns to a free desk',()=>{
  const now=Date.UTC(2026,9,14,12);
  const target='agent:resume-from-sofa';
  const occupants=[{id:target,role:'agent',state:'idle',stateSince:now},
    ...Array.from({length:5},(_,i)=>({id:`agent:worker-${i}`,role:'agent',state:'working',stateSince:now+i+1}))];
  const saved={ [placementToken(target)]: { floorId:'1', stations:{[placementToken(target)]:'sofa'} } };
  const away=planOfficePlacement({index,layout:base,occupants,homeAssignments:saved,now});
  assert.ok(R.homeStations(base,index).includes(away.placements.find(row=>row.id===target).stationUid),
    'a legacy sofa pin is migrated instead of establishing a lounge as the agent home');

  const resumed=planOfficePlacement({index,layout:base,occupants:occupants.map(row=>({...row,state:'working',stateSince:now+1})),
    homeAssignments:away.homeAssignments,now:now+1});
  const returning=resumed.placements.find(row=>row.id===target);
  assert.notEqual(returning.stationUid,'sofa');
  assert.ok(R.homeStations(base,index).includes(returning.stationUid),'the agent takes a work desk instead of staying on the sofa');
  assert.equal(returning.homeTarget.stationUid,returning.stationUid);
  assert.equal(returning.sceneTarget.stationUid,returning.stationUid);
  assert.equal(returning.sceneTarget.mode,'desk');
  assert.equal(returning.activity,null);

  const explicit=structuredClone(base);
  explicit.agents.push({agentId:target,character:'subagent',station:'sofa'});
  const startsActive=planOfficePlacement({index,layout:explicit,occupants:occupants.map(row=>({...row,state:'working',stateSince:now+2})),now:now+2});
  const activeRow=startsActive.placements.find(row=>row.id===target);
  assert.ok(R.homeStations(explicit,index).includes(activeRow.stationUid),'an active-from-start legacy explicit sofa rule resolves to a work desk');
  assert.equal(activeRow.sceneTarget.mode,'desk');
});

test('implicit desk homes stay stable across unscoped projections when an idle owner returns active',()=>{
  const tracker={relocations:new Map()};
  const now=Date.UTC(2026,9,14,12), occupants=[
    {id:'main',role:'primary',state:'idle',stateSince:now},
    {id:'agent:idle-peer',role:'agent',state:'idle',stateSince:now},
    ...Array.from({length:5},(_,i)=>({id:`agent:worker-${i}`,role:'agent',state:'working',stateSince:now+i+1})),
  ];
  const initial=planOfficePlacement({index,layout:base,occupants,tracker,now});
  const originalHome=initial.placements.find(row=>row.id==='main').stationUid;
  assert.ok(R.homeStations(base,index).includes(originalHome));

  const away=planOfficePlacement({index,layout:base,occupants,tracker,now:now+16*60_000});
  const awayOwner=away.placements.find(row=>row.id==='main');
  assert.ok(awayOwner.activity);
  assert.equal(awayOwner.homeTarget.stationUid,originalHome);

  const returned=planOfficePlacement({index,layout:base,occupants:occupants.map(row=>row.id==='main'
    ? {...row,state:'working',stateSince:now+16*60_000} : row),tracker,now:now+16*60_000});
  const activeOwner=returned.placements.find(row=>row.id==='main');
  assert.equal(activeOwner.stationUid,originalHome,'the implicit home survives the state/relocation transition');
  assert.equal(activeOwner.sceneTarget.stationUid,originalHome);
  assert.equal(activeOwner.activity,null);
});

test('fixed-seed active and idle pin mixes keep allocations and seated targets unique',()=>{
  const desks=R.homeStations(base,index);
  for(let seed=1;seed<=24;seed++){
    let state=seed;
    const next=()=>{state=(state*48271)%2147483647;return state;};
    const occupants=Array.from({length:6},(_,i)=>({id:`agent:property-${i}`,role:i===0?'primary':'agent',
      state:next()%3===0?'idle':'working',stateSince:100+i}));
    const homeAssignments=Object.fromEntries(occupants.map(row=>[placementToken(row.id),
      {floorId:'1',stations:{[placementToken(row.id)]:desks[next()%desks.length]}}]));
    const result=planOfficePlacement({index,layout:base,occupants,homeAssignments});
    const seated=result.placements.filter(row=>row.stationUid);
    assert.equal(new Set(seated.map(row=>`${row.floorId}:${row.stationUid}`)).size,seated.length,`seed ${seed}: allocation uniqueness`);
    assert.equal(new Set(seated.map(row=>`${row.sceneTarget.floorId}:${row.sceneTarget.stationUid}`)).size,seated.length,`seed ${seed}: seated scene target uniqueness`);
    for(const row of seated)assert.equal(row.sceneTarget.stationUid,row.stationUid,`seed ${seed}: target follows allocation`);
  }
});

test('newer inactive owner wins duplicate saved-home claims over an older idle row',()=>{
  const rows=[{id:'agent:a-older',role:'agent',state:'idle',stateSince:10},
    {id:'agent:z-owner',role:'agent',state:'idle',stateSince:20}];
  const resolved=R.resolveOccupants(floorLayout(base,index,'1'),index,rows,
    {stationAssignments:{'agent:a-older':'st-3','agent:z-owner':'st-3'}});
  const byId=new Map(resolved.map(row=>[row.id,row]));
  assert.equal(byId.get('agent:z-owner').stationUid,'st-3');
  assert.equal(byId.get('agent:z-owner')._homeWant,'st-3');
  assert.notEqual(byId.get('agent:a-older').stationUid,'st-3');
  assert.notEqual(byId.get('agent:a-older')._homeWant,'st-3');
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
  assert.equal(result.placements.length,12);assert.equal(result.floors.find(f=>f.id==='2').capacity,10);
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
  assert.ok(result.placements.every(p=>p.stationUid));
  assert.ok(result.floors.length<205,'desk-only work capacity keeps large rosters bounded after lounge seats are removed from home allocation');
});
