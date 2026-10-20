'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Worker}=require('node:worker_threads');

test('startup recovery attempts a failed legacy pending batch once and terminates',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-chat-recovery-fault-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const script=String.raw`
    const {parentPort,workerData}=require('node:worker_threads');
    const path=require('node:path'),crypto=require('node:crypto');
    const {openStore}=require(path.resolve('src/store'));
    const {mountChat}=require(path.resolve('src/api/v3/chat'));
    const store=openStore({dir:workerData.dir,instance:'test',ownerName:'Synthetic',log:()=>{}}),repo=store.chatV3;
    const scope='d'.repeat(64),id=p=>p+'_'+crypto.randomBytes(24).toString('base64url');
    const target=id('ca');repo.createTarget({id:target,principalScope:scope,kind:'agent',sourceRef:'agent:atlas',runtimeId:'synthetic',nativeAgentId:'atlas'});
    for(let n=0;n<256;n++){const sessionId=id('cs');repo.createSession({sessionId,principalScope:scope,agentId:target,runtimeId:'synthetic',nativeAgentId:'atlas',nativeSessionRef:'synthetic-'+n,title:'Recovery fault'});repo.setPending(sessionId,id('turn'),Date.now()-86400000);}
    store.db.exec("CREATE TRIGGER recovery_write_failure BEFORE INSERT ON chat_v3_messages BEGIN SELECT RAISE(ABORT,'synthetic unavailable write'); END;");
    const logs=[];
    try{
      const chat=mountChat({r:{get(){},post(){},patch(){},delete(){}},engine:{},topics:{define(){},parse(){return {id:'synthetic'};},invalidate(){},invalidateIds(){}},store,runtime:{},dataDir:workerData.dir,authed(){},guard:()=>()=>{},ok(){},log:event=>logs.push(event)});
      chat.close();
      parentPort.postMessage({kind:'finished',failures:logs.filter(row=>row?.event==='chat.turn.recovery_failed').map(row=>row.count)});
    }catch(error){parentPort.postMessage({kind:'failed',message:error.message});}
    finally{store.close();}
  `;
  const worker=new Worker(script,{eval:true,workerData:{dir}});
  let timer;
  const outcome=await new Promise((resolve,reject)=>{
    worker.once('error',reject);
    worker.on('message',message=>{clearTimeout(timer);resolve(message);});
    timer=setTimeout(()=>resolve({kind:'timeout'}),1500);
  });
  clearTimeout(timer);await worker.terminate();
  assert.equal(outcome.kind,'finished',`startup must not retry an unchanged failed batch or block the process; worker outcome: ${JSON.stringify(outcome)}`);
  assert.deepEqual(outcome.failures,[256],'failed rows are reported once as a count without row identifiers');
});
