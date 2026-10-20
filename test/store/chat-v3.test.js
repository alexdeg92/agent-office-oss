'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../../src/store');
const NOW = 1791223200000;
const opaque = (prefix, ch) => prefix + '_' + ch.repeat(32);

test('v3 chat repository scopes targets, sessions, unread acknowledgements and idempotency to one principal', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-chat-v3-'));
  const store=openStore({dir,instance:'test',ownerName:'Synthetic owner',now:()=>NOW,log:()=>{}});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const repo=store.chatV3, scopeA='a'.repeat(64),scopeB='b'.repeat(64);
  const target=repo.createTarget({id:opaque('ca','a'),principalScope:scopeA,kind:'agent',sourceRef:'rt:codex:agent:bm92YQ',runtimeId:'codex',nativeAgentId:'nova'});
  assert.equal(target.target_id,opaque('ca','a'));
  assert.equal(repo.targetForRef(scopeA,'agent','rt:codex:agent:bm92YQ').target_id,target.target_id);
  assert.equal(repo.targetForRef(scopeB,'agent','rt:codex:agent:bm92YQ'),null);
  const session=repo.createSession({sessionId:opaque('cs','c'),principalScope:scopeA,agentId:target.target_id,runtimeId:'codex',nativeAgentId:'nova',nativeSessionRef:'private-ref-a',title:'Synthetic'});
  assert.equal(repo.get(scopeB,session.session_id),null);
  repo.addMessage(session.session_id,{id:opaque('msg','d'),role:'assistant',at:NOW,body:{text:'hello',blocks:[{type:'text',text:'hello'}]},attachments:[]},{unread:true});
  assert.equal(repo.list(scopeA,target.target_id)[0].unread_count,1);
  assert.deepEqual(repo.acknowledge(scopeB,session.session_id,opaque('msg','d')),null);
  assert.equal(repo.acknowledge(scopeA,session.session_id,opaque('msg','d')).unreadCount,0);
  const reservation={scope:scopeA,method:'POST',route:'/chat/sessions',key:'idempotency-key-123',requestHash:'c'.repeat(64)};
  assert.equal(repo.reserveIdempotency(reservation).kind,'reserved');
  assert.equal(repo.reserveIdempotency(reservation).kind,'in-flight');
  assert.equal(repo.reserveIdempotency({...reservation,requestHash:'d'.repeat(64)}).kind,'conflict');
  repo.completeIdempotency({...reservation,status:201,result:{sessionId:session.session_id}});
  assert.deepEqual(repo.reserveIdempotency(reservation),{kind:'complete',result:{sessionId:session.session_id},status:201});
  const uploadId='e'.repeat(64);assert.equal(repo.reserveUpload(scopeA,uploadId,1024,{sessionId:session.session_id}),true);
  assert.equal(repo.reserveUpload(scopeA,'f'.repeat(64),1024,{sessionId:session.session_id,maxBytes:2048}),true);
  assert.equal(repo.reserveUpload(scopeA,'1'.repeat(64),1,{sessionId:session.session_id,maxBytes:2048}),false);
  assert.equal(repo.releaseUpload(uploadId),true);assert.equal(repo.releaseUpload(uploadId),false);
  const constrained=opaque('cs','f');repo.createSession({sessionId:constrained,principalScope:scopeA,agentId:target.target_id,runtimeId:'codex',nativeAgentId:'nova',nativeSessionRef:'private-ref-b',title:'Constrained'});
  assert.equal(repo.reserveUpload(scopeA,'2'.repeat(64),1024,{sessionId:constrained,maxCountPerSession:1}),true);
  assert.equal(repo.reserveUpload(scopeA,'3'.repeat(64),1024,{sessionId:constrained,maxCountPerSession:1}),false,'a live reservation consumes one per-session slot');
  assert.equal(repo.releaseUpload('2'.repeat(64)),true);
  assert.throws(()=>repo.createSession({sessionId:opaque('cs','e'),principalScope:scopeA,agentId:target.target_id,runtimeId:'codex',nativeAgentId:'nova',nativeSessionRef:'x'.repeat(4097),title:'bad'}));
});

test('pane message queue is durable, principal-scoped, cancellable and promotes FIFO into the existing turn dispatcher',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-chat-pane-queue-')),scope='e'.repeat(64),foreign='f'.repeat(64),paneMemberId='member:synthetic-pane';
  let store=openStore({dir,instance:'test',ownerName:'Synthetic owner',now:()=>NOW,log:()=>{}});t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
  const repo=store.chatV3,target=repo.createTarget({id:opaque('ca','a'),principalScope:scope,kind:'agent',sourceRef:'member:synthetic-pane',runtimeId:'synthetic',nativeAgentId:'pane'});
  const session=repo.createSession({sessionId:opaque('cs','b'),principalScope:scope,agentId:target.target_id,runtimeId:'synthetic',nativeAgentId:'pane',nativeSessionRef:'private-pane-ref',paneMemberId,title:'Queued'});
  const message={id:opaque('msg','c'),role:'user',at:NOW,body:{text:'Waiting'},attachments:[]},turnId=opaque('turn','d');
  const acceptance={scope,method:'POST',route:'/chat/sessions/:sessionId/messages',key:'queue-idempotency-0001',requestHash:'1'.repeat(64),sessionId:session.session_id,turnId,paneMemberId,at:NOW,message,principalId:'owner-id',statusLabel:{key:'chat.pane.messageQueued'}};
  assert.deepEqual(repo.enqueuePaneMessage(acceptance),{kind:'accepted',result:{turnId},status:202});assert.equal(repo.messages(session.session_id)[0].status,'queued');
  store.close();store=openStore({dir,instance:'test',ownerName:'Synthetic owner',now:()=>NOW,log:()=>{}});
  const reopened=store.chatV3;assert.deepEqual(reopened.queuedPaneMembers().members,[paneMemberId]);assert.equal(reopened.messages(session.session_id)[0].status,'queued');
  assert.equal(reopened.cancelPaneMessage(foreign,session.session_id,turnId,{key:'chat.pane.messageCancelled'}),null,'another principal cannot cancel the private queued item');
  const promoted=reopened.promotePaneQueue(paneMemberId,NOW+1);assert.equal(promoted.turn_id,turnId);assert.equal(promoted.principal_id,'owner-id');
  assert.equal(reopened.get(scope,session.session_id).pending_turn_id,turnId);assert.equal(reopened.messages(session.session_id)[0].status,'queued','the queued state remains visible while dispatch begins');
  assert.equal(reopened.requeuePaneMessage(session.session_id,turnId,{key:'chat.pane.messageQueued'},NOW+2),true,'a pane that became busy again returns the in-flight item to the durable queue');
  assert.deepEqual(reopened.queuedPaneMembers().members,[paneMemberId]);assert.equal(reopened.messages(session.session_id)[0].status,'queued');
  const resumed=reopened.promotePaneQueue(paneMemberId,NOW+3);assert.equal(resumed.turn_id,turnId);
  assert.ok(reopened.claimTurnDispatch(session.session_id,turnId));
  assert.equal(reopened.completeTurnDispatch(session.session_id,turnId,{id:opaque('msg','e'),role:'assistant',at:NOW+2,body:{text:'Delivered'},attachments:[]}),true);
  assert.deepEqual(reopened.queuedPaneMembers().members,[]);assert.equal(reopened.hasPaneQueue(paneMemberId),false,'completed dispatches release the pane FIFO lock');assert.equal(reopened.messages(session.session_id).at(-1).body.text,'Delivered');
});

test('queued pane member listing keyset-pages past the first 256 members',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-chat-pane-pages-'));
  const store=openStore({dir,instance:'test',ownerName:'Synthetic owner',now:()=>NOW,log:()=>{}});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const repo=store.chatV3,total=260;
  for(let n=0;n<total;n++){
    const hex=n.toString(16).padStart(32,'0'),scope=n.toString(16).padStart(64,'0'),paneMemberId=`member:${String(n).padStart(4,'0')}`;
    const target=repo.createTarget({id:`ca_${hex}`,principalScope:scope,kind:'agent',sourceRef:`synthetic:agent:${n}`,runtimeId:'synthetic',nativeAgentId:'pane'});
    const session=repo.createSession({sessionId:`cs_${hex}`,principalScope:scope,agentId:target.target_id,runtimeId:'synthetic',nativeAgentId:'pane',nativeSessionRef:`private-pane-ref-${n}`,paneMemberId,title:'Queued'});
    const turnId=`turn_${hex}`,message={id:`msg_${hex}`,role:'user',at:NOW+n,body:{text:'Waiting'},attachments:[]};
    const result=repo.enqueuePaneMessage({scope,method:'POST',route:'/chat/sessions/:sessionId/messages',key:`queue-pane-${String(n).padStart(12,'0')}`,requestHash:n.toString(16).padStart(64,'0'),sessionId:session.session_id,turnId,paneMemberId,at:NOW+n,message,principalId:`principal-${n}`,statusLabel:{key:'chat.pane.messageQueued'}});
    assert.equal(result.kind,'accepted',`queue row ${n} was persisted`);
  }
  const first=repo.queuedPaneMembers(256),second=repo.queuedPaneMembers(256,first.nextCursor,first.throughQueueId);
  assert.equal(first.members.length,256);assert.equal(first.done,false);
  assert.equal(second.members.length,4);assert.equal(second.done,true);
  assert.equal(new Set([...first.members,...second.members]).size,total,'member keyset has no gaps or duplicates');
  assert.equal(first.members[0],'member:0000');assert.equal(second.members.at(-1),'member:0259');
});

test('one principal cannot consume the shared pane queue capacity reserved for other principals',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-chat-pane-fair-')),scopeA='a'.repeat(64),scopeB='b'.repeat(64),paneMemberId='member:shared-pane';
  const store=openStore({dir,instance:'test',ownerName:'Synthetic owner',now:()=>NOW,log:()=>{}});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const repo=store.chatV3,id=(prefix,n)=>prefix+'_'+n.toString(16).padStart(32,'0');
  const sessionFor=(scope,n)=>{const target=repo.createTarget({id:id('ca',n),principalScope:scope,kind:'agent',sourceRef:`synthetic:agent:${n}`,runtimeId:'synthetic',nativeAgentId:'pane'});
    return repo.createSession({sessionId:id('cs',n),principalScope:scope,agentId:target.target_id,runtimeId:'synthetic',nativeAgentId:'pane',nativeSessionRef:`private-pane-ref-${n}`,paneMemberId,title:'Queued'});};
  const sessionsA=[sessionFor(scopeA,1),sessionFor(scopeA,2),sessionFor(scopeA,3)],sessionB=sessionFor(scopeB,4);
  let index=1;
  const enqueue=(scope,session)=>{const n=index++,turnId=id('turn',n),message={id:id('msg',n),role:'user',at:NOW+n,body:{text:'Waiting'},attachments:[]};
    return repo.enqueuePaneMessage({scope,method:'POST',route:'/chat/sessions/:sessionId/messages',key:`queue-fair-${String(n).padStart(12,'0')}`,requestHash:n.toString(16).padStart(64,'0'),sessionId:session.session_id,turnId,paneMemberId,at:NOW+n,message,principalId:scope===scopeA?'principal-a':'principal-b',statusLabel:{key:'chat.pane.messageQueued'}});};
  for(let n=0;n<250;n++)assert.equal(enqueue(scopeA,sessionsA[Math.floor(n/100)]).kind,'accepted',`principal A queue row ${n+1}`);
  assert.equal(enqueue(scopeA,sessionsA[2]).kind,'queue-full','the per-principal cap applies across A’s sessions');
  assert.equal(enqueue(scopeB,sessionB).kind,'accepted','principal B can still enqueue while shared pane backstop has room');
});

test('a queued pane turn can be explicitly promoted for immediate delivery and receives a stored sent label',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-chat-pane-now-')),scope='a'.repeat(64),paneMemberId='member:synthetic-pane';
  const store=openStore({dir,instance:'test',ownerName:'Synthetic owner',now:()=>NOW,log:()=>{}});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const repo=store.chatV3,target=repo.createTarget({id:opaque('ca','a'),principalScope:scope,kind:'agent',sourceRef:'member:synthetic-pane',runtimeId:'synthetic',nativeAgentId:'pane'});
  const session=repo.createSession({sessionId:opaque('cs','b'),principalScope:scope,agentId:target.target_id,runtimeId:'synthetic',nativeAgentId:'pane',nativeSessionRef:'private-pane-ref',paneMemberId,title:'Queued'});
  const turnId=opaque('turn','d'),message={id:opaque('msg','c'),role:'user',at:NOW,body:{text:'Send this now'},attachments:[]};
  repo.enqueuePaneMessage({scope,method:'POST',route:'/messages',key:'pane-queue-now-0001',requestHash:'1'.repeat(64),sessionId:session.session_id,turnId,paneMemberId,at:NOW,message,principalId:'owner-id',statusLabel:{key:'chat.pane.messageQueued'}});
  const job=repo.sendQueuedPaneNow(scope,session.session_id,turnId,NOW+1);assert.equal(job.turn_id,turnId);assert.equal(job.send_now,1);
  assert.equal(repo.sendQueuedPaneNow('b'.repeat(64),session.session_id,turnId,NOW+2),null,'another owner cannot promote the queued turn');
  assert.equal(repo.messages(session.session_id)[0].status,'queued');
  assert.equal(repo.setPaneMessageStatus(scope,session.session_id,turnId,'sent',{key:'chat.pane.messageSent',params:{name:'Atlas'}},NOW+3),true);
  const sent=repo.messages(session.session_id)[0];assert.equal(sent.status,'sent');assert.deepEqual(sent.statusLabel,{key:'chat.pane.messageSent',params:{name:'Atlas'}});
});

test('attachment inbox cleanup target cursor reaches targets after the first 256',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-chat-inbox-pages-'));
  const store=openStore({dir,instance:'test',ownerName:'Synthetic owner',now:()=>NOW,log:()=>{}});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const repo=store.chatV3,total=257;
  for(let i=0;i<total;i++){
    const suffix=i.toString(16).padStart(32,'0'),scope=i.toString(16).padStart(64,'0'),targetId='ca_'+suffix,sessionId='cs_'+suffix,attachmentId='att_'+suffix;
    const target=repo.createTarget({id:targetId,principalScope:scope,kind:'agent',sourceRef:`synthetic:agent:${i}`,runtimeId:'synthetic',nativeAgentId:'agent'});
    assert.ok(target,`target insert failed for ${i}: ${targetId}, ${scope}`);
    repo.createSession({sessionId,principalScope:scope,agentId:target.target_id,runtimeId:'synthetic',nativeAgentId:'agent',nativeSessionRef:`synthetic-session-${i}`,title:'Inbox cleanup'});
    repo.attachment({attachmentId,principalScope:scope,sessionId,name:'old.txt',mimeType:'text/plain',size:1,sha256:'a'.repeat(64),storageName:i.toString(16).padStart(64,'0')});
    repo.bindAttachments(scope,sessionId,[attachmentId]);repo.finishAttachments([attachmentId]);
  }
  const first=repo.attachmentInboxTargets(256);assert.equal(first.targets.length,256);assert.equal(first.done,false);
  const second=repo.attachmentInboxTargets(256,first.nextCursor);assert.equal(second.targets.length,1);assert.equal(second.done,true);
  assert.notDeepEqual(first.targets.at(-1),second.targets[0]);
});

test('turn acceptance is atomic and durable across restart/replay', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-chat-accept-'));
  const scope='c'.repeat(64),sessionId=opaque('cs','a'),targetId=opaque('ca','a'),assistantId=opaque('msg','d');
  const attachmentId=opaque('att','b'),turnId=opaque('turn','c'),failedKey='acceptance-failure-key',goodKey='acceptance-success-key';
  const base={scope,method:'POST',route:'/chat/sessions/:sessionId/messages',requestHash:'d'.repeat(64),sessionId,turnId,at:NOW};
  let store=openStore({dir,instance:'test',ownerName:'Synthetic owner',now:()=>NOW,log:()=>{}});
  t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
  const repo=store.chatV3;
  const target=repo.createTarget({id:targetId,principalScope:scope,kind:'agent',sourceRef:'rt:codex:agent:bm92YQ',runtimeId:'codex',nativeAgentId:'nova'});
  repo.createSession({sessionId,principalScope:scope,agentId:target.target_id,runtimeId:'codex',nativeAgentId:'nova',nativeSessionRef:'private-session-ref',title:'Synthetic'});
  repo.addMessage(sessionId,{id:assistantId,role:'assistant',at:NOW,body:{text:'Existing'},attachments:[]});
  repo.attachment({attachmentId,principalScope:scope,sessionId,name:'proof.txt',mimeType:'text/plain',size:5,sha256:'e'.repeat(64),storageName:'f'.repeat(64)});
  const failed={...base,key:failedKey,defaultTitle:'Synthetic',firstMessageTitle:'must roll back',message:{id:assistantId,turnId,role:'user',at:NOW,body:{text:'must rollback'},attachments:[{id:attachmentId} ]},attachmentIds:[attachmentId]};
  assert.throws(()=>repo.acceptTurn(failed),'duplicate message ID simulates a database failure after attachment binding');
  assert.equal(repo.get(scope,sessionId).pending_turn_id,null);
  assert.equal(repo.get(scope,sessionId).title,'Synthetic','a rejected acceptance rolls back its title update');
  assert.equal(repo.messages(sessionId).length,1);
  assert.equal(repo.ownedAttachment(scope,sessionId,attachmentId).state,'staged');
  assert.equal(store.db.prepare('SELECT 1 FROM chat_v3_idempotency WHERE idem_key=?').get(failedKey),undefined);

  const accepted={...base,key:goodKey,defaultTitle:'Synthetic',firstMessageTitle:'durable accepted turn',message:{id:opaque('msg','e'),turnId,role:'user',at:NOW,body:{text:'durable accepted turn'},attachments:[{id:attachmentId,name:'proof.txt'}]},attachmentIds:[attachmentId]};
  assert.deepEqual(repo.acceptTurn(accepted),{kind:'accepted',result:{turnId},status:202});
  assert.equal(repo.get(scope,sessionId).pending_turn_id,turnId);
  assert.equal(repo.get(scope,sessionId).title,'durable accepted turn');
  assert.equal(repo.ownedAttachment(scope,sessionId,attachmentId).state,'bound');
  store.close();

  store=openStore({dir,instance:'test',ownerName:'Synthetic owner',now:()=>NOW,log:()=>{}});
  const afterRestart=store.chatV3;
  assert.equal(afterRestart.get(scope,sessionId).pending_turn_id,turnId);
  assert.equal(afterRestart.messages(sessionId).filter(row=>row.role==='user').length,1);
  assert.deepEqual(afterRestart.acceptTurn(accepted),{kind:'uncertain',result:{turnId},status:202},'replay after restart returns the durable receipt without inserting another turn');
  assert.equal(afterRestart.messages(sessionId).length,2);
});

test('turn acceptance preserves a project-provided private session title', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-chat-title-'));
  const store=openStore({dir,instance:'test',ownerName:'Synthetic owner',now:()=>NOW,log:()=>{}});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const repo=store.chatV3,scope='e'.repeat(64),sessionId=opaque('cs','d'),targetId=opaque('ca','d'),turnId=opaque('turn','e');
  const target=repo.createTarget({id:targetId,principalScope:scope,kind:'agent',sourceRef:'rt:codex:agent:bm92YQ',runtimeId:'codex',nativeAgentId:'nova'});
  repo.createSession({sessionId,principalScope:scope,agentId:target.target_id,runtimeId:'codex',nativeAgentId:'nova',nativeSessionRef:'private-kickoff-ref',title:'Project Orion kickoff'});
  const accepted=repo.acceptTurn({scope,method:'POST',route:'/chat/sessions/:sessionId/messages',key:'project-kickoff-title-key',requestHash:'9'.repeat(64),sessionId,turnId,at:NOW,
    defaultTitle:'New conversation',firstMessageTitle:'Replace this only when title is default',message:{id:opaque('msg','f'),turnId,role:'user',at:NOW,body:{text:'kickoff prompt'},attachments:[]}});
  assert.equal(accepted.kind,'accepted');
  assert.equal(repo.get(scope,sessionId).title,'Project Orion kickoff');
});

test('retry acceptance persists its dispatch before returning 202',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ao-chat-retry-')),scope='d'.repeat(64),sessionId=opaque('cs','b'),targetId=opaque('ca','b'),turnId=opaque('turn','d');
  const store=openStore({dir,instance:'test',ownerName:'Synthetic owner',now:()=>NOW,log:()=>{}});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const repo=store.chatV3,target=repo.createTarget({id:targetId,principalScope:scope,kind:'agent',sourceRef:'rt:codex:agent:bm92YQ',runtimeId:'codex',nativeAgentId:'nova'});
  repo.createSession({sessionId,principalScope:scope,agentId:target.target_id,runtimeId:'codex',nativeAgentId:'nova',nativeSessionRef:'private-session-ref',title:'Synthetic'});
  repo.addMessage(sessionId,{id:opaque('msg','e'),turnId,role:'user',at:NOW,body:{text:'retry this'},attachments:[]});
  store.db.prepare('UPDATE chat_v3_sessions SET retry_eligible_turn_id=? WHERE session_id=?').run(turnId,sessionId);
  const accepted=repo.acceptRetry({scope,method:'POST',route:'/chat/sessions/:sessionId/retry',key:'retry-idempotency-key',requestHash:'f'.repeat(64),sessionId,turnId,at:NOW,principalId:'synthetic-user'});
  assert.deepEqual(accepted,{kind:'accepted',result:{turnId},status:202});
  assert.equal(repo.get(scope,sessionId).pending_turn_id,turnId);
  assert.equal(repo.queuedTurnDispatches().length,1,'restart can resume the accepted retry');
});
