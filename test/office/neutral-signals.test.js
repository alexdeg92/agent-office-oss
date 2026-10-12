const {test}=require('node:test');const assert=require('node:assert/strict');
const {buildOfficeVM,createStateTracker}=require('../../src/api/v2/vm/office');
const {project3x}=require('../../src/api/v2/project3x');
test('neutral engine LiveEvents retain occupant identity/activity in v3; v2 keeps its existing journal shape',()=>{
 const events=[{id:'le_1',at:10,count:1,kind:'run.succeeded',occupantId:'primary',actor:{kind:'system',component:'engine'}},{id:'le_2',at:11,count:1,kind:'activity',activity:'researching',occupantId:'primary',actor:{kind:'system',component:'engine'}}];
 const engine={gateway:()=>({connected:true,since:0}),sessions:()=>[],agents:()=>[],cronJobs:()=>[],host:()=>null,session:()=>null,liveEvents:()=>events};
 const input={engine,now:20,canReadSessions:true,tracker:createStateTracker(),actorOf:()=>({kind:'system',name:'Système'})};
 const v3=buildOfficeVM({...input,P:project3x});assert.equal(v3.journal[0].occupantId,'primary');assert.equal(v3.journal[1].activity,'researching');
 const v2=buildOfficeVM(input);assert.ok(v2.journal.every(e=>!('occupantId' in e)&&!('activity' in e)));
});
const {officeSignalFrame}=require('../../src/api/v2/office-signals');
const {project2x}=require('../../src/api/v2/project2x');
const {createStreamHub}=require('../../src/api/v2/stream');
const {EventEmitter}=require('node:events');
test('neutral office events reach v2 and v3 office subscribers without changing the v2 VM',()=>{
 const e={id:'le_3',kind:'run.succeeded',occupantId:'primary',at:30,count:1};
 const f2=officeSignalFrame(e,project2x),f3=officeSignalFrame(e,project3x);assert.equal(f2.occupantId,'main');assert.equal(f3.occupantId,'primary');assert.equal(f2.signal.kind,'run.succeeded');assert.equal(f2.cue,'celebrating');
 assert.equal(officeSignalFrame({...e,kind:'gateway.connected'},project3x),null);
 // createStreamHub receives the versioned topics facade in production. This
 // minimal double implements its parser so broadcast authorization follows
 // the same path without constructing an HTTP router.
 const topics=new EventEmitter();topics.parse=id=>['office','health'].includes(id)?{id,name:id}:null;const hub=createStreamHub({topics,engine:{},systemState:()=>({})});const lines=[];
 const st={seq:0,buffer:[],closed:false,topics:new Set(['office']),res:{write:s=>lines.push(s)}};hub._streams.set('office',st);
 hub._streams.set('elsewhere',{...st,buffer:[],topics:new Set(['health']),res:{write:()=>{throw Error('unsubscribed signal')}}});
 hub.broadcastOffice(f2);assert.equal(lines.length,1);assert.match(lines[0],/"signal"/);hub._streams.clear();hub.closeAll();
});
