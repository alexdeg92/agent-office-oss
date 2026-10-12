'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
const {fork}=require('node:child_process');
const {createServer}=require('node:net');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {loadScenario,makeFakeGateway}=require('./scenario');
const {TOKEN}=require('./onboarding-fixture');
const {PASSWORD,EMAIL}=require('./settings-fixture');
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function settingsProcessFixture(options={}){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'settings-process-'));
 const fake=makeFakeGateway(loadScenario('foreign-instance'));fake.token=TOKEN;const running=await fake.start();const gateway={url:running.url};
 const port=await freePort();let child,closing=false,boots=0,base,cookie,paths,bootId;const errors=[],restartExits=[];
 const h={tmp,fake,password:PASSWORD,email:EMAIL,get base(){return base;},get cookie(){return cookie;},set cookie(value){cookie=value;},get paths(){return paths;},get boots(){return boots;},get bootId(){return bootId;},get restartExits(){return [...restartExits];},onBoot:null};
 const request=async(method,route,value)=>{const r=await fetch(base+route,{method,headers:{'content-type':'application/json','x-ao-request':'1',cookie},body:value===undefined?undefined:JSON.stringify(value)});const text=await r.text();let json;try{json=JSON.parse(text);}catch{}return{status:r.status,json,text,headers:r.headers};};
 Object.assign(h,{get:route=>request('GET',route),post:(route,value={})=>request('POST',route,value),put:(route,value)=>request('PUT',route,value)});
 function launch(reuse=false){return new Promise((resolve,reject)=>{
  // T-0073 P0: the worker runs with a scratch HOME the fixture owns, never the invoking user's
  const home=path.join(tmp,'home');fs.mkdirSync(home,{recursive:true});
  child=fork(path.join(__dirname,'settings-process-worker.js'),[],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,HOME:home,AO_TEST_SCRATCH_HOME:home}});
  const current=child;let ready=false;
  current.stderr.on('data',chunk=>errors.push(chunk.toString()));
  current.stdout.on('data',()=>{});
  const timeout=setTimeout(()=>reject(Error('scratch child boot timeout: '+errors.join(''))),20000);
  current.on('message',message=>{
   if(message.type==='error'){clearTimeout(timeout);reject(Error(message.error));}
   if(message.type==='ready'){clearTimeout(timeout);ready=true;base=message.base;cookie ||= message.cookie;paths=message.paths;bootId=message.bootId;boots++;h.onBoot?.(base);resolve();}
  });
  current.once('exit',(code)=>{
   clearTimeout(timeout);
   if(!ready)reject(Error('scratch child exited before boot: '+code+' '+errors.join('')));
   else if(!closing && code===75){restartExits.push(code);void launch(true).catch(error=>errors.push(error.stack));}
   else if(!closing)errors.push('unexpected child exit '+code);
  });
  current.send({tmp,reuse,gateway,port,publicUrl:options.publicUrl});
 });}
 h.close=async()=>{closing=true;if(child && child.exitCode==null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited;}await fake.stop();fs.rmSync(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:100});if(errors.length)throw Error(errors.join('\n'));};
 try{await launch();return h;}catch(error){await h.close();throw error;}
}
module.exports={settingsProcessFixture,freePort};
