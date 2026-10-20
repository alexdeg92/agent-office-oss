'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {bind:bindCommands}=require('../../src/adapters/openclaw/commands');
const {bind:bindReads}=require('../../src/adapters/openclaw/reads');
const {createRuntime}=require('../../src/adapters/openclaw');
const {normaliseTranscript}=require('../../src/adapters/openclaw/normalise/transcript');

test('attachment handoff transcript projections show filename labels without locators',()=>{
  const privatePath='/var/lib/agent-office/private/chat-files/secret-digest';
  const text=`Review this image\n\n<agent-office-attachments version="1">\n${JSON.stringify({files:[{displayName:'capture.png',mimeType:'image/png',size:32,path:privatePath}]})}\n</agent-office-attachments>\nOuvre les fichiers joints avec tes outils.`;
  const transcript=normaliseTranscript('agent:main:explicit:synthetic-chat',{messages:[{role:'user',timestamp:10,content:text}]},10,Infinity);
  const projected=JSON.stringify(transcript);
  assert.match(projected,/📎 capture\.png/);
  assert.doesNotMatch(projected,/agent-office-attachments|secret-digest|private\/chat-files|capture\.png.*path/);
});

test('runtime-backed Discuter history also redacts attachment locators',async()=>{
  const secret='/scratch/private/opaque-attachment';
  const gatewayText=`Please inspect it\n<agent-office-attachments version="1">\n${JSON.stringify({files:[{displayName:'capture.png',mimeType:'image/png',size:32,path:secret}]})}\n</agent-office-attachments>`;
  const reads=bindReads({gw:{async call(){return {messages:[{id:'u1',role:'user',timestamp:1,text:gatewayText}],deltaCursor:'c1'};},on(){},off(){}},cli:{}});
  const page=await reads.conversationHistory({sessionKey:'synthetic-session',agentId:'main'});
  assert.equal(page.messages[0].text,'Please inspect it\n📎 capture.png');
  assert.equal(JSON.stringify(page).includes(secret),false);
});

test('workspace attachment inbox is per-principal, opaque, private, oldest-first, and safely removable',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'ao-workspace-inbox-')),workspace=path.join(home,'workspace');fs.mkdirSync(workspace,{mode:0o700});
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));let clock=1000;
  const files=require('../../src/adapters/openclaw/attachment-files').createAttachmentFiles({workspaceForAgent:()=>workspace,now:()=>clock});
  const content=Buffer.from('synthetic private fixture'),sha256=require('node:crypto').createHash('sha256').update(content).digest('hex');
  const scope='a'.repeat(64),otherScope='b'.repeat(64);
  const staged=await files.stage({agentId:'main',principalScope:scope,files:[{fileName:'att_abcdefghijklmnopqrstuvwxyz0123456789',name:'../hostile.txt',mimeType:'text/plain',size:content.length,sha256,content}]});
  const ref=staged[0];assert.equal(path.dirname(ref.reference),path.join(workspace,'agent-office-inbox',scope));assert.equal(path.basename(ref.reference),'att_abcdefghijklmnopqrstuvwxyz0123456789');
  assert.equal(ref.displayName,'..hostile.txt','display metadata is not used as the filesystem name');
  assert.equal(fs.statSync(path.dirname(path.dirname(ref.reference))).mode&0o077,0);assert.equal(fs.statSync(path.dirname(ref.reference)).mode&0o077,0);assert.equal(fs.statSync(ref.reference).mode&0o077,0);assert.deepEqual(fs.readFileSync(ref.reference),content);
  const other=await files.stage({agentId:'main',principalScope:otherScope,files:[{name:'other.txt',mimeType:'text/plain',size:content.length,sha256,content}]});
  assert.notEqual(path.dirname(other[0].reference),path.dirname(ref.reference),'principals receive separate inbox directories');
  const newer=await files.stage({agentId:'main',principalScope:scope,files:[{name:'newer.txt',mimeType:'text/plain',size:content.length,sha256,content}]});
  fs.utimesSync(ref.reference,new Date(clock-5000),new Date(clock-5000));fs.utimesSync(newer[0].reference,new Date(clock),new Date(clock));
  assert.equal(await files.prune({agentId:'main',principalScope:scope,olderThan:clock-1000,limit:1}),1);
  assert.equal(fs.existsSync(ref.reference),false,'oldest expired candidate is removed even when a newer unexpired candidate is listed first');assert.equal(fs.existsSync(newer[0].reference),true);
  const safe=await files.stage({agentId:'main',principalScope:scope,files:[{fileName:'att_abcdefghijklmnopqrstuvwxyz0123456789',name:'capture.png',mimeType:'image/png',size:content.length,sha256,content}]});
  assert.equal(await files.remove({agentId:'main',principalScope:scope,fileNames:[path.basename(safe[0].reference)]}),true);assert.equal(fs.existsSync(safe[0].reference),false);
  assert.equal(await files.remove({agentId:'main',principalScope:scope,fileNames:['../escape']}),false);
});

test('inbox pruning resumes bounded directory scans until entries beyond the first batch expire',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),home=fs.mkdtempSync(path.join(os.tmpdir(),'ao-inbox-scan-pages-'));
  const workspace=path.join(home,'workspace'),scope='b'.repeat(64);fs.mkdirSync(workspace,{mode:0o700});t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  let now=10_000;const files=require('../../src/adapters/openclaw/attachment-files').createAttachmentFiles({workspaceForAgent:()=>workspace,now:()=>now,maxScan:4});
  const content=Buffer.from('old attachment'),sha256=require('node:crypto').createHash('sha256').update(content).digest('hex'),rows=[];
  for(let i=0;i<9;i++)rows.push(...await files.stage({agentId:'main',principalScope:scope,files:[{name:`old-${i}.txt`,mimeType:'text/plain',size:content.length,sha256,content}]}));
  for(const row of rows)fs.utimesSync(row.reference,new Date(now-100_000),new Date(now-100_000));
  let removed=0;for(let i=0;i<8&&removed<rows.length;i++)removed+=await files.prune({agentId:'main',principalScope:scope,olderThan:now-86400,limit:2});
  assert.equal(removed,rows.length,'rotation eventually visits and removes expired files beyond each bounded scan window');
  assert.ok(rows.every(row=>!fs.existsSync(row.reference)));files.close();
});

test('workspace inbox directory swaps are refused and cannot redirect staging outside the pinned directory',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const home=fs.mkdtempSync(path.join(os.tmpdir(),'ao-inbox-swap-'));
  const workspace=path.join(home,'workspace'),outside=path.join(home,'outside'),scope='c'.repeat(64);fs.mkdirSync(workspace,{mode:0o700});fs.mkdirSync(outside,{mode:0o700});t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  let swapped=false;const files=require('../../src/adapters/openclaw/attachment-files').createAttachmentFiles({workspaceForAgent:()=>workspace,afterInboxOpen({path:scopePath}){
    if(swapped)return;swapped=true;fs.renameSync(scopePath,scopePath+'.saved');fs.symlinkSync(outside,scopePath);
  }});
  const content=Buffer.from('safe fd fixture'),sha256=require('node:crypto').createHash('sha256').update(content).digest('hex');
  await assert.rejects(files.stage({agentId:'main',principalScope:scope,files:[{name:'race.txt',mimeType:'text/plain',size:content.length,sha256,content}]}),/changed/);
  assert.deepEqual(fs.readdirSync(outside),[],'a swapped inbox symlink never receives staged files');
  const scopeForRemove='e'.repeat(64),normal=require('../../src/adapters/openclaw/attachment-files').createAttachmentFiles({workspaceForAgent:()=>workspace});
  const staged=await normal.stage({agentId:'main',principalScope:scopeForRemove,files:[{name:'kept.txt',mimeType:'text/plain',size:content.length,sha256,content}]});
  const fileName=path.basename(staged[0].reference);fs.writeFileSync(path.join(outside,fileName),'outside sentinel',{mode:0o600});
  let removeSwapped=false;const removeRace=require('../../src/adapters/openclaw/attachment-files').createAttachmentFiles({workspaceForAgent:()=>workspace,afterInboxOpen({path:scopePath}){
    if(removeSwapped)return;removeSwapped=true;fs.renameSync(scopePath,scopePath+'.saved');fs.symlinkSync(outside,scopePath);
  }});
  await assert.rejects(removeRace.remove({agentId:'main',principalScope:scopeForRemove,fileNames:[fileName]}),/changed/);
  assert.equal(fs.readFileSync(path.join(outside,fileName),'utf8'),'outside sentinel','a swapped symlink cannot redirect removal');
});

test('file-reference staging is not advertised when descriptor-relative paths are unavailable',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),home=fs.mkdtempSync(path.join(os.tmpdir(),'ao-no-proc-fd-'));
  const workspace=path.join(home,'workspace');fs.mkdirSync(workspace,{mode:0o700});t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const files=require('../../src/adapters/openclaw/attachment-files').createAttachmentFiles({workspaceForAgent:()=>workspace,procFdRoot:path.join(home,'missing-proc-fd')});
  assert.equal(files.canStage({agentId:'main',principalScope:'a'.repeat(64)}),false);
  const content=Buffer.from('safe fixture'),sha256=require('node:crypto').createHash('sha256').update(content).digest('hex');
  await assert.rejects(files.stage({agentId:'main',principalScope:'a'.repeat(64),files:[{name:'fixture.txt',mimeType:'text/plain',content,size:content.length,sha256}]}),/unsupported on this platform/);
});

test('transcript-wide attachment path redaction covers tool inputs, tool outputs, assistant text, and user metadata',()=>{
  const scope='d'.repeat(64),path=`/private/workspace/agent-office-inbox/${scope}/att_abcdefghijklmnopqrstuvwxyz0123456789`,
    block=`<agent-office-attachments version="1">${JSON.stringify({files:[{displayName:'capture.png',path}]})}</agent-office-attachments>`;
  const transcript=normaliseTranscript('synthetic-session',{messages:[
    {role:'user',timestamp:1,content:block},
    {role:'assistant',timestamp:2,content:[{type:'toolCall',id:'read-1',name:'read_file',input:{path}}]},
    {role:'toolResult',timestamp:3,toolCallId:'read-1',content:`opened ${path}`},
    {role:'assistant',timestamp:4,content:[{type:'text',text:`I opened ${path}`} ]},
  ]},4,Infinity);
  const json=JSON.stringify(transcript);assert.equal(json.includes(path),false);assert.ok(json.includes('📎 capture.png'));
});

test('delegated result events redact attachment inbox locators before returning early',()=>{
  const child='agent:main:subagent:synthetic-child',scope='e'.repeat(64),locator=`/workspace/agent-office-inbox/${scope}/att_abcdefghijklmnopqrstuvwxyz0123456789`;
  const block=`<agent-office-attachments version="1">${JSON.stringify({files:[{displayName:'brief.pdf',path:locator}]})}</agent-office-attachments>`;
  const envelope=`[Subagent Context] results\nChild completion results:\nChild task 1:\n<prompt-data>Review the brief</prompt-data>\nstatus: ok\nChild result 1:\n<prompt-data>Read ${locator}</prompt-data>`;
  const messages=[
    {role:'assistant',content:[{type:'toolCall',id:'spawn-1',name:'sessions_spawn',input:{taskName:'Review the brief'}}]},
    {role:'toolResult',toolCallId:'spawn-1',content:JSON.stringify({status:'accepted',childSessionKey:child})},
    {role:'user',content:block},
    {role:'user',content:envelope,provenance:{kind:'internal_system',sourceSessionKey:child}},
  ];
  const transcript=normaliseTranscript('synthetic-session',{messages},10,Infinity,()=>{},{runtime:'openclaw',delegatedLabels:new Map([[child,'Review the brief']]),sessionOf:key=>key===child?{key,class:{kind:'subagent'}}:null});
  const result=transcript.events.find(event=>event.kind==='subagent-result');
  assert.ok(result);assert.match(result.body,/📎 brief\.pdf/);assert.equal(JSON.stringify(result).includes(locator),false);
});

test('delegated labels, event metadata, and participant sender fields redact inbox locators',()=>{
  const child='agent:main:subagent:synthetic-child',scope='a'.repeat(64),locator=`/workspace with spaces/agent-office-inbox/${scope}/att_abcdefghijklmnopqrstuvwxyz0123456789`;
  const block=`<agent-office-attachments version="1">${JSON.stringify({files:[{displayName:'brief.pdf',path:locator}]})}</agent-office-attachments>`;
  const envelope=`[Subagent Context] results\nChild completion results:\nChild task 1:\n<prompt-data>${locator}</prompt-data>\nstatus: ok\nChild result 1:\n<prompt-data>Reviewed safely.</prompt-data>`;
  const messages=[
    {role:'assistant',content:[{type:'toolCall',id:'spawn-1',name:'sessions_spawn',input:{taskName:locator}}]},
    {role:'toolResult',toolCallId:'spawn-1',content:JSON.stringify({status:'accepted',childSessionKey:child})},
    {role:'user',content:block},
    {role:'user',content:envelope,provenance:{kind:'internal_system',sourceSessionKey:child}},
  ];
  const transcript=normaliseTranscript('synthetic-session',{messages},10,Infinity,()=>{},{runtime:'openclaw',
    sessionOf:key=>key===child?{key,class:{kind:'subagent'},title:locator}:null});
  const result=transcript.events.find(event=>event.kind==='subagent-result'),projected=JSON.stringify({result,participants:transcript.participants});
  assert.ok(result);assert.equal(projected.includes(locator),false,'delegated label/title/sender metadata never exposes a workspace locator');
  assert.match(projected,/📎 brief\.pdf/);
});

test('inbox cleanup advances after one target fails and retries it on the next sweep',async()=>{
  const {pruneAttachmentInboxPage}=require('../../src/api/v3/attachment-inbox-cleanup');
  const calls=[],logs=[];let failed=true;
  const repo={attachmentInboxTargets(limit,cursor){assert.equal(limit,256);return cursor==='cursor-b'
    ?{targets:[{native_agent_id:'private-target-c'}],nextCursor:null,done:true}
    :{targets:[{native_agent_id:'private-target-a'},{native_agent_id:'private-target-b'}],nextCursor:'cursor-b',done:false};}};
  const attachmentFilePort=()=>({async prune({agentId}){calls.push(agentId);if(agentId==='private-target-a'&&failed){failed=false;throw new Error('private path hidden');}}});
  const deps={repo,cursor:null,runtimeOf:id=>id,attachmentFilePort,now:()=>0,log:event=>logs.push(event)};
  const first=await pruneAttachmentInboxPage(deps);assert.equal(first.cursor,'cursor-b');assert.deepEqual(calls,['private-target-a','private-target-b']);
  assert.deepEqual(logs,[{event:'chat.attachment.inbox_prune_failed',count:1}]);assert.equal(JSON.stringify(logs).includes('private-target'),false);
  const second=await pruneAttachmentInboxPage({...deps,cursor:first.cursor});assert.equal(second.cursor,null);assert.deepEqual(calls.slice(-1),['private-target-c']);
  const retry=await pruneAttachmentInboxPage({...deps,cursor:second.cursor});assert.equal(retry.cursor,'cursor-b');assert.deepEqual(calls.slice(-2),['private-target-a','private-target-b']);
});

test('attachment locator fallback redacts paths with spaces when history omits attachment metadata',()=>{
  const locator='/home/synthetic user/.openclaw/workspace/agent-office-inbox/'+'f'.repeat(64)+'/att_abcdefghijklmnopqrstuvwxyz0123456789';
  const transcript=normaliseTranscript('synthetic-session',{messages:[{role:'assistant',timestamp:1,content:`Read ${locator}`} ]},1,Infinity,()=>{},{attachmentInboxName:'agent-office-inbox'});
  const output=JSON.stringify(transcript);assert.equal(output.includes(locator),false);assert.match(output,/📎 fichier joint/);
});

test('OpenClaw chat send uses the Gateway chat.send contract with a stable session and idempotency key',async()=>{
  const calls=[],cli={async run(args,timeout){calls.push({args,timeout});const method=args.find(arg=>arg.startsWith('gateway')||arg==='chat.send');
    const paramsArg=args.find(arg=>arg.startsWith('--params=')),params=paramsArg?JSON.parse(paramsArg.slice('--params='.length)):null;
    if(args.includes('sessions.patch'))return {ok:true,out:JSON.stringify({ok:true,key:params.key,entry:{sendPolicy:'deny'}})};
    return {ok:true,out:JSON.stringify({runId:'run-1',status:'started'})};},parseJson:JSON.parse};
  const commands=bindCommands(cli,{gatewayUrl:'ws://127.0.0.1:18785'});
  const result=await commands.chatSend({sessionKey:'agent:main:explicit:portal-chat:user:abc:session:cs_123',agentId:'main',sessionId:'gw-session-1',
    message:'Please review this change.',idempotencyKey:'turn_123',expectedLeafEntryId:'message-8'});
  assert.deepEqual(result,{ok:true,receipt:{runId:'run-1',status:'started'}});
  assert.equal(calls.length,2,'the delivery-policy fence is confirmed before chat.send');
  assert.ok(calls[0].args.includes('sessions.patch'));assert.equal(JSON.parse(calls[0].args.find(arg=>arg.startsWith('--params=')).slice('--params='.length)).sendPolicy,'deny');
  const {args}=calls[1],methodAt=args.indexOf('chat.send'),params=JSON.parse(args.find(arg=>arg.startsWith('--params=')).slice('--params='.length));
  assert.ok(methodAt>0);assert.deepEqual(params,{sessionKey:'agent:main:explicit:portal-chat:user:abc:session:cs_123',agentId:'main',sessionId:'gw-session-1',
    message:'Please review this change.',idempotencyKey:'turn_123',expectedLeafEntryId:'message-8'});
  assert.equal(args.some(arg=>arg.startsWith('--expect-url=ws://127.0.0.1:18785')),true);
  assert.equal(calls[1].timeout>=15000,true,'the local CLI timeout is not the model execution budget');
});

test('OpenClaw conversation chat.send carries private-store attachment bytes as protocol content',async()=>{
  const calls=[],cli={async run(args){const paramsArg=args.find(arg=>arg.startsWith('--params='));const params=paramsArg?JSON.parse(paramsArg.slice('--params='.length)):null;
    if(args.includes('sessions.patch'))return {ok:true,out:JSON.stringify({ok:true,key:params.key,entry:{sendPolicy:'deny'}})};
    calls.push({args,params});return {ok:true,out:JSON.stringify({runId:'run-attachment',status:'started'})};},parseJson:JSON.parse};
  const bytes=Buffer.from('private fixture only');
  const result=await bindCommands(cli).chatSend({sessionKey:'agent:main:explicit:portal-chat:user:abc:session:cs_attach',agentId:'main',message:'Read this file',idempotencyKey:'turn-attachment',
    attachments:[{name:'notes.txt',mimeType:'text/plain',size:bytes.length,sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),content:bytes}]});
  assert.equal(result.ok,true);
  assert.equal(calls.length,1);const params=calls[0].params;
  assert.equal(params.attachments[0].fileName,'notes.txt');assert.equal(params.attachments[0].mimeType,'text/plain');
  assert.equal(params.attachments[0].content,bytes.toString('base64'));assert.equal(params.attachments[0].sizeBytes,bytes.length);
  assert.equal(JSON.stringify(params).includes('/home/'),false,'private host paths never cross the adapter boundary');
});

test('OpenClaw chat.send refuses delivery when the webchat-only policy receipt is not confirmed',async()=>{
  const calls=[],cli={async run(args){calls.push(args);return {ok:true,out:JSON.stringify({ok:true,key:'agent:main:explicit:chat',entry:{sendPolicy:'allow'}})};},parseJson:JSON.parse};
  const result=await bindCommands(cli).chatSend({sessionKey:'agent:main:explicit:chat',agentId:'main',message:'never route externally',idempotencyKey:'turn-1'});
  assert.deepEqual(result,{failed:'delivery-policy-unconfirmed'});assert.equal(calls.length,1);assert.ok(calls[0].includes('sessions.patch'));assert.equal(calls.some(args=>args.includes('chat.send')),false);
});

const policyCli=calls=>({async run(args){calls.push({cli:args[2]});const params=JSON.parse(args.find(arg=>arg.startsWith('--params=')).slice(9));
  if(args.includes('sessions.patch'))return {ok:true,out:JSON.stringify({ok:true,key:params.key,entry:{sendPolicy:'deny'}})};throw new Error('only the policy fence may use argv');},parseJson:JSON.parse});

test('OpenClaw conversation writer pins webchat policy through the CLI and sends attachment bytes over its scoped RPC seam',async()=>{
  const calls=[],bytes=Buffer.from('adapter attachment');
  const result=await bindCommands(policyCli(calls),{chatSendRpc:async(method,params)=>{calls.push({method,params});return {runId:'attachment-run',status:'started'};}}).chatSend({sessionKey:'agent:main:explicit:chat',agentId:'main',message:'Read this',idempotencyKey:'turn-attachment',
      attachments:[{name:'private.txt',mimeType:'text/plain',size:bytes.length,sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),content:bytes}]});
  assert.equal(result.ok,true);assert.deepEqual(calls.map(call=>call.cli||call.method),['sessions.patch','chat.send']);
  assert.deepEqual(calls[1].params.attachments,[{fileName:'private.txt',mimeType:'text/plain',content:bytes.toString('base64'),sizeBytes:bytes.length,origin:'file'}]);
});

test('the scoped write socket never carries sessions.patch, which needs operator.admin',async()=>{
  const calls=[];const rpcMethods=[];
  await bindCommands(policyCli(calls),{chatSendRpc:async(method)=>{rpcMethods.push(method);if(method!=='chat.send')throw Object.assign(new Error('missing scope: operator.admin'),{code:'FORBIDDEN'});return {runId:'r'};}})
    .chatSend({sessionKey:'agent:main:explicit:chat',agentId:'main',message:'hi',idempotencyKey:'k'});
  assert.deepEqual(rpcMethods,['chat.send']);
  await assert.rejects(require('../../src/adapters/openclaw').writeGatewayCall({},'sessions.patch',{key:'agent:main:x'}),/unsupported chat writer operation/);
});

test('OpenClaw rechecks accepted-turn authority after the policy fence and before chat.send',async()=>{
  const {runAuthorized}=require('../../src/security/dispatch-context');let allowed=true;const calls=[];
  const cli={async run(args){calls.push(args[2]);allowed=false;const params=JSON.parse(args.find(arg=>arg.startsWith('--params=')).slice(9));return {ok:true,out:JSON.stringify({ok:true,key:params.key,entry:{sendPolicy:'deny'}})};},parseJson:JSON.parse};
  const command=bindCommands(cli,{chatSendRpc:async(method)=>{calls.push(method);return {runId:'should-not-send'};}});
  const result=await runAuthorized(()=>{if(!allowed)throw new Error('permission revoked');},()=>command.chatSend({sessionKey:'agent:main:explicit:chat',agentId:'main',message:'private',idempotencyKey:'turn'}));
  assert.deepEqual(calls,['sessions.patch']);assert.deepEqual(result,{failed:'dispatch-failed'});
});

test('OpenClaw read-only mode refuses chat.send before starting the CLI',async()=>{
  let calls=0;const cli={async run(){calls++;return {ok:true,out:'{}'};},parseJson:JSON.parse};
  const result=await bindCommands(cli,{readonly:true}).chatSend({sessionKey:'agent:main:chat',agentId:'main',message:'hi',idempotencyKey:'turn'});
  assert.deepEqual(result,{failed:'readonly'});assert.equal(calls,0);
});

test('OpenClaw adapter declares conversation sending unavailable in readonly configuration',t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),home=fs.mkdtempSync(path.join(os.tmpdir(),'ao-openclaw-readonly-'));
  const adapter=createRuntime({gatewayUrl:'ws://127.0.0.1:9',gatewayToken:null,identityPath:path.join(home,'identity'),stateDbPath:path.join(home,'state.sqlite'),
    openclawBin:'openclaw',openclawHome:home,openclawConfigPath:path.join(home,'openclaw.json'),readonly:true,readonlyStore:true,senderCapture:false});
  t.after(()=>{adapter.close();fs.rmSync(home,{recursive:true,force:true});});
  const caps=adapter.definition.capabilities();assert.notEqual(caps.conversations?.send,true);assert.notEqual(caps.chatAttachments?.enabled,true);
});

test('OpenClaw attachment capability follows the advertised decoded and wire limits',()=>{
  const {chatAttachmentCapability}=require('../../src/adapters/openclaw');
  assert.deepEqual(chatAttachmentCapability(null),{enabled:true,maxBytes:20*1024*1024,maxImageBytes:6*1024*1024,maxCountPerMessage:1,maxCountPerSession:20,
    mimeTypes:['application/pdf','text/plain','image/png','image/jpeg','image/gif','image/webp']});
  const limited=chatAttachmentCapability({policy:{attachments:{maxBytes:12*1024*1024,maxImageBytes:3*1024*1024},maxPayload:8*1024*1024}});
  assert.equal(limited.maxBytes,Math.floor((8*1024*1024-128*1024)*3/4));assert.equal(limited.maxImageBytes,3*1024*1024);
  assert.equal(chatAttachmentCapability({policy:{attachments:{maxBytes:4*1024*1024,maxImageBytes:2*1024*1024}}},false).enabled,false);
});

test('OpenClaw write RPC uses a short-lived operator.write-only Gateway socket',async()=>{
  const {EventEmitter}=require('node:events'),{writeGatewayCall}=require('../../src/adapters/openclaw'),observed={};
  class FakeGateway extends EventEmitter{constructor(options){super();observed.options=options;} _connect(){queueMicrotask(()=>this.emit('open'));}async call(method,params){observed.call={method,params};return {accepted:true};}close(){observed.closed=true;}}
  const params={sessionKey:'agent:main:explicit:private-chat',agentId:'main'};
  assert.deepEqual(await writeGatewayCall({gatewayUrl:'ws://127.0.0.1:9',gatewayToken:'fixture-only',identityPath:'/fixture/id',stateDbPath:'/fixture/db'},'chat.send',params,5000,FakeGateway),{accepted:true});
  assert.deepEqual(observed.options.scopes,['operator.write']);assert.equal(observed.options.retry,false);assert.deepEqual(observed.call,{method:'chat.send',params});assert.equal(observed.closed,true);
  await assert.rejects(()=>writeGatewayCall({gatewayUrl:'ws://127.0.0.1:9',gatewayToken:'fixture-only'},'config.patch',{},5000,FakeGateway),/unsupported chat writer operation/);
});

test('OpenClaw chat history uses the exact chat.history cursor contract and session events are scoped',async()=>{
  const calls=[],listeners=new Set(),gw={
    async call(method,params){calls.push({method,params});if(method==='chat.history')return {messages:[],deltaCursor:'cursor-1'};return {ok:true};},
    on(name,fn){assert.equal(name,'gwevent');listeners.add(fn);},off(name,fn){assert.equal(name,'gwevent');listeners.delete(fn);},
  };
  const reads=bindReads({gw,cli:{}}),base={sessionKey:'agent:main:explicit:private-chat',agentId:'main'};
  await reads.chatHistory({...base,limit:40});await reads.chatHistory({...base,cursor:'cursor-1'});
  assert.deepEqual(calls.slice(0,2),[
    {method:'chat.history',params:{...base,limit:40}},
    {method:'chat.history',params:{...base,cursor:'cursor-1'}},
  ]);
  const received=[],stop=await reads.subscribeChat({...base,onEvent:event=>received.push(event)});
  assert.equal(calls[2].method,'sessions.messages.subscribe');assert.equal(calls[2].params.key,base.sessionKey);assert.equal(calls[2].params.agentId,'main');
  const subscription=calls[2].params.subscriptionId;assert.match(subscription,/^ao-chat-/);
  for(const listener of listeners){listener('session.message',{sessionKey:'agent:main:other',agentId:'main'});listener('session.message',{sessionKey:base.sessionKey,agentId:'main',message:{role:'assistant'}});}
  assert.equal(received.length,1);
  await stop();assert.equal(listeners.size,0);
  assert.deepEqual(calls.at(-1),{method:'sessions.messages.unsubscribe',params:{key:base.sessionKey,agentId:'main',subscriptionId:subscription}});
});

test('OpenClaw adapts Gateway history deltas into a canonical conversation snapshot',async()=>{
  const calls=[],gw={async call(method,params){calls.push({method,params});
    if(calls.length===1)return {messages:[{id:'user-1',role:'user',timestamp:100,text:'Question'}],deltaCursor:'gateway-cursor-1',nextOffset:20,hasMore:true,totalMessages:45,sessionInfo:{sessionId:'gw-session'}};
    return {kind:'delta',messages:[{id:'assistant-1',role:'assistant',timestamp:200,content:[{type:'text',text:'Answer'}],usage:{totalTokens:12}}],deltaCursor:'gateway-cursor-2'};},on(){},off(){}};
  const reads=bindReads({gw,cli:{}}),sessionRef='private-session-ref';
  const first=await reads.conversationHistory({sessionKey:sessionRef,agentId:'main'});
  const second=await reads.conversationHistory({sessionKey:sessionRef,agentId:'main'});
  assert.deepEqual(first,{messages:[{id:'user-1',role:'user',at:100,text:'Question',model:null,tokens:null}],cursor:'gateway-cursor-1',conversationId:'gw-session',olderCursor:'20',hasOlder:true});
  assert.deepEqual(second.messages,[first.messages[0],{id:'assistant-1',role:'assistant',at:200,text:'Answer',model:null,tokens:12}]);
  assert.equal(second.cursor,'gateway-cursor-2');
  assert.equal(second.olderCursor,'20');assert.equal(second.hasOlder,true,'delta catch-up preserves prior older-page metadata when its response omits it');
  assert.deepEqual(calls.map(call=>call.method),['chat.history','chat.history']);
  assert.equal(calls[1].params.cursor,'gateway-cursor-1');
  assert.equal(Object.keys(second.messages[1]).some(key=>['__openclaw','deltaCursor','kind'].includes(key)),false);
});

test('OpenClaw adapts older-page offsets separately from the delta cursor',async()=>{
  const calls=[],gw={async call(method,params){calls.push({method,params});return {messages:[{id:'older-1',role:'user',timestamp:50,text:'Earlier'}],
    nextOffset:80,hasMore:true,totalMessages:100,deltaCursor:'delta-stays-private',sessionInfo:{sessionId:'gateway-session'}};},on(){},off(){}};
  const reads=bindReads({gw,cli:{}});
  const result=await reads.conversationHistory({sessionKey:'private-session',agentId:'main',before:'40',limit:40});
  assert.deepEqual(calls,[{method:'chat.history',params:{sessionKey:'private-session',agentId:'main',offset:40,limit:40}}]);
  assert.deepEqual(result.messages.map(message=>message.id),['older-1']);assert.equal(result.olderCursor,'80');assert.equal(result.hasOlder,true);
  assert.equal(result.cursor,null,'older paging does not mutate or reuse the delta-sync cursor');
  assert.equal(result.olderCursor,String(80),'the Gateway top-level nextOffset is forwarded as the next canonical page token');
  await assert.rejects(()=>reads.conversationHistory({sessionKey:'private-session',before:'../private'}),/continuation is invalid/);
  reads.close();
});

test('OpenClaw private transcript cache is bounded by session LRU and TTL',async()=>{
  let now=100;const calls=[],aReads={count:0},gw={async call(method,params){calls.push({method,params});
    if(params.sessionKey==='session-a'){aReads.count++;if(params.cursor)return {kind:'delta',messages:[{id:'reply-a',role:'assistant',text:'reply A'}],deltaCursor:'cursor-a2'};
      return aReads.count===1?{messages:[{id:'private-a',role:'user',text:'private A'}],deltaCursor:'cursor-a'}:{messages:[{id:`fresh-a-${aReads.count}`,role:'user',text:'fresh after eviction'}],deltaCursor:`fresh-cursor-${aReads.count}`};}
    if(params.sessionKey==='session-b')return {messages:[{id:'private-b',role:'user',text:'private B'}],deltaCursor:'cursor-b'};
    return {messages:[],deltaCursor:null};
  },on(){},off(){}};
  const reads=bindReads({gw,cli:{},conversationCacheOptions:{maxEntries:1,maxBytes:4096,maxEntryBytes:4096,ttlMs:5,now:()=>now}});
  await reads.conversationHistory({sessionKey:'session-a',agentId:'main'});
  await reads.conversationHistory({sessionKey:'session-b',agentId:'main'});
  const afterLru=await reads.conversationHistory({sessionKey:'session-a',agentId:'main'});
  assert.deepEqual(calls[2].params,{sessionKey:'session-a',agentId:'main',limit:50},'eviction removes messages, cursor, and conversation id together');
  assert.deepEqual(afterLru.messages.map(message=>message.id),['fresh-a-2']);
  now+=6;
  const afterTtl=await reads.conversationHistory({sessionKey:'session-a',agentId:'main'});
  assert.deepEqual(calls[3].params,{sessionKey:'session-a',agentId:'main',limit:50},'expired cursors are not reused');
  assert.deepEqual(afterTtl.messages.map(message=>message.id),['fresh-a-3']);
  reads.close();
});

test('OpenClaw returns a valid oversized history page even when the private cache declines it',async()=>{
  const calls=[],page='x'.repeat(2048),gw={async call(_method,params){calls.push(params);return {messages:[{id:'large-message',role:'assistant',text:page}],deltaCursor:'large-cursor'};},on(){},off(){}};
  const reads=bindReads({gw,cli:{},conversationCacheOptions:{maxEntries:2,maxBytes:1024,maxEntryBytes:512,ttlMs:1000}});
  const result=await reads.conversationHistory({sessionKey:'oversized',agentId:'main'});
  assert.equal(result.messages[0].text,page,'oversize affects retention only, never the adapter response');
  await reads.conversationHistory({sessionKey:'oversized',agentId:'main'});
  assert.equal(calls[1].cursor,undefined,'an oversized snapshot that was not cached does not leave a cursor without its messages');
  reads.close();
});

test('OpenClaw evicts a transcript on conversation unsubscribe and clears active listeners on close',async()=>{
  const calls=[],listeners=new Set(),historyCalls=new Map(),gw={async call(method,params){calls.push({method,params});
    if(method==='chat.history'){const count=(historyCalls.get(params.sessionKey)||0)+1;historyCalls.set(params.sessionKey,count);
      return count===1?{messages:[{id:'old',role:'user',text:'old'}],deltaCursor:'first'}:{messages:[{id:'new',role:'assistant',text:'new'}],deltaCursor:'next'};}
    return {ok:true};},on(_name,fn){listeners.add(fn);},off(_name,fn){listeners.delete(fn);}};
  const reads=bindReads({gw,cli:{}}),stop=await reads.subscribeConversation({sessionKey:'private-session',agentId:'main',onChange(){}});
  await reads.conversationHistory({sessionKey:'private-session',agentId:'main'});await stop();
  const fresh=await reads.conversationHistory({sessionKey:'private-session',agentId:'main'});
  assert.deepEqual(calls.find(call=>call.method==='chat.history'&&call.params.cursor===undefined).params,{sessionKey:'private-session',agentId:'main',limit:50});
  assert.deepEqual(fresh.messages.map(message=>message.id),['new'],'unsubscribed transcript data is not retained');
  const stopAgain=await reads.subscribeChat({sessionKey:'other-session',agentId:'main',onEvent(){}});assert.equal(listeners.size,1);
  reads.close();await stopAgain();assert.equal(listeners.size,0,'close removes all event listeners');
});

test('OpenClaw runtime declares file-reference attachments while retaining the fenced agent-turn path',()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-oc-caps-'));
  const runtime=require('../../src/adapters/openclaw').createRuntime({gatewayUrl:'ws://127.0.0.1:1',gatewayToken:'synthetic',openclawHome:root,openclawBin:'/synthetic/openclaw',identityPath:path.join(root,'none'),stateDbPath:path.join(root,'none.db')});
  try{const caps=runtime.definition.capabilities();assert.equal(Object.prototype.hasOwnProperty.call(caps,'conversations'),false,'no undefined-valued key may reach the meta VM');
    const walk=v=>{if(v===undefined)throw new Error('undefined capability value');if(v&&typeof v==='object')Object.values(v).forEach(walk);};walk(caps);
    assert.equal(caps.chatAttachments?.enabled,true);assert.equal(caps.attachmentDelivery,'file-reference');}
  finally{runtime.close?.();fs.rmSync(root,{recursive:true,force:true});}
});

test('OpenClaw readonly runtime does not advertise file-reference attachments',t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-oc-readonly-files-'));
  const runtime=createRuntime({gatewayUrl:'ws://127.0.0.1:9',gatewayToken:null,identityPath:path.join(root,'id'),stateDbPath:path.join(root,'db'),openclawHome:root,
    openclawBin:'/synthetic/openclaw',openclawConfigPath:path.join(root,'openclaw.json'),readonly:true,readonlyStore:true,senderCapture:false});
  t.after(()=>{runtime.close?.();fs.rmSync(root,{recursive:true,force:true});});
  const caps=runtime.definition.capabilities();assert.equal(caps.attachmentDelivery,undefined);assert.equal(caps.chatAttachments.enabled,false);
});
