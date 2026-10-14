'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);
const assert = require('node:assert/strict');
const { createEngine } = require('../../src/engine');
const { settingsFixture } = require('./settings-fixture');

// Canonical synthetic adapter data, rendered through the real mounted API/SSE.
// Both the engine and the VM clock are controlled; auth keeps its real clock.
async function officeSceneFixture({ publicUrl, theme = 'day', occupantCount = 7, namedAgents = false, primaryName = 'Chef synthétique', orchestratorTeams, sourcePrincipalFor, sessionsReadable, enforceAuthorization = false } = {}) {
  assert.ok(Number.isInteger(occupantCount) && occupantCount >= 2 && occupantCount <= 64);
  const clock = { value: Date.now() };
  const adapter = { id:'synthetic-office',name:'Synthetic Office',schemas:{},routes:{},
    normalise:{session:row=>({session:row}),runtimeHealth:()=>({version:null,pluginsLoaded:null,eventLoop:null})},
    classifySession:()=>({kind:'unrecognized'}) };
  const engine = createEngine({adapter,primary:'atlas',now:()=>clock.value});
  const catalog=[{id:'atlas',name:primaryName,workspace:null,model:null,fallbackModels:[],isPrimary:true,mainSessionKey:'main'}];
  if(namedAgents)for(let i=1;i<occupantCount;i++)catalog.push({id:`worker-${i}`,name:`Collègue ${i}`,workspace:null,model:null,fallbackModels:[],isPrimary:false,mainSessionKey:`worker-${i}`,spawnedBy:{agentId:'atlas',sessionKey:null,via:'orchestrator',label:null}});
  assert.equal(engine.ingestCanonical('agents',catalog).ok,true);
  engine.setGatewayConnected(true);
  let h;
  const publish = states => {
    const rows = states.map((state,i)=>({
      key:i ? `worker-${i}` : 'main',sessionId:null,
      class:{kind:i?(namedAgents?'acp':'subagent'):'primary',ruleId:'fixture',agentId:i?(namedAgents?`worker-${i}`:'delegated-worker'):'atlas',subagentId:i&&!namedAgents?`worker-${i}`:null,channel:null,heartbeatOf:null,background:false,rawClassification:null},
      displayName:i?`Collègue ${i}`:primaryName,summary:null,model:null,provider:null,
      usage:{total:1,input:null,output:null},updatedAt:clock.value,
      run:{status:state==='working'?'running':'idle',endReason:null,evidence:'status-field',evidenceLevel:'verified',observedAt:clock.value,
        expiresAt:state==='working'?clock.value+30000:null,startedAt:state==='working'?clock.value-1000:null,endedAt:null,
        hasActiveSubagentRun:false,runtimeMs:null,lastRunId:null,lastError:null},
      costUsd:null,parentKey:i?'main':null,childKeys:[],goal:null,cwd:null,messageCount:null,interactive:true,group:null,
    }));
    const result=engine.ingestCanonical('sessions.snapshot',rows);
    assert.equal(result.ok,true,JSON.stringify(result.issues));
    h?.api.topics.invalidate();
  };
  publish(Array.from({length:occupantCount},(_,i)=>i<2?'idle':'working'));
  try {
    h=await settingsFixture({publicUrl,viewEngine:engine,now:()=>clock.value,enforceAuthorization,
      orchestratorTeams:typeof orchestratorTeams==='function'?orchestratorTeams({engine,clock}):orchestratorTeams,sourcePrincipalFor,sessionsReadable});
    assert.equal((await h.reauth()).status,200);
    for (const floor of ['1','rdc','gym']) {
      const current=await h.get(`/api/v3/office/layout?floorId=${floor}`);
      assert.equal(current.status,200,current.text);
      const r=await h.put(`/api/v3/office/layout/theme?floorId=${floor}`,{expectedRevision:current.json.data.layout.revision,
        theme:{...current.json.data.layout.data.theme,mode:'fixed',fixed:theme}});
      assert.equal(r.status,200,r.text);
    }
    return {...h,clock,viewEngine:engine,publish,advance(ms,states){clock.value+=ms;publish(states);}};
  }catch(error){await h?.close();throw error;}
}
module.exports={officeSceneFixture};
