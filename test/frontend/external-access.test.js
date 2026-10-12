import test from 'node:test';
import assert from 'node:assert/strict';
import { createExternalAccessMock } from '../../public/v2/mock/external-access.js';
const DEFAULT_SECURITY={accessTokenMinutes:10,refreshIdleHours:12,refreshAbsoluteDays:7,partitionedCookie:false};

const response = async (db, method, path, body) => {
  const result=await db(method,path,body);
  return {status:result.status,data:result.body.data,error:result.body.error};
};

test('external-access mock follows the T-0076 setup/settings contract without retaining secrets', async()=>{
  const setup=createExternalAccessMock();
  const denied=await response(setup,'POST','/api/v3/setup/access/state',{setupCode:'wrong'});
  assert.equal(denied.status,403);
  const state=await response(setup,'POST','/api/v3/setup/access/state',{setupCode:'AO-7Q2K-91MX'});
  assert.equal(state.data.state,'open');assert.equal(state.data.draft.mode,'local');
  const draft={mode:'public-split-origin',apiPublicUrl:'https://api.example.org/backend',uiOrigins:['https://office.example.org'],domain:'api.example.org',proxy:'caddy',security:{accessTokenMinutes:10,refreshIdleHours:12,refreshAbsoluteDays:7,partitionedCookie:false}};
  const planned=await response(setup,'POST','/api/v3/setup/access/plan',{setupCode:'AO-7Q2K-91MX',settingsRevision:null,draft});
  const plan=planned.data.result;assert.equal(plan.draft.mode,draft.mode);assert.match(plan.configDigest,/^[a-f0-9]{64}$/);assert.equal(plan.checks.length,3);
  const started=await response(setup,'POST','/api/v3/setup/access/checks',{setupCode:'AO-7Q2K-91MX',planId:plan.planId,checks:['dns','tls','cors']});
  assert.equal(started.data.result.state,'running');
  const status=await response(setup,'POST','/api/v3/setup/access/checks/status',{setupCode:'AO-7Q2K-91MX',jobId:started.data.result.jobId});
  assert.equal(status.data.result.state,'unknown');assert.ok(status.data.result.checks.every(check=>check.state==='unknown'));
  const staged=await response(setup,'POST','/api/v3/setup/access/apply',{setupCode:'AO-7Q2K-91MX',planId:plan.planId,settingsRevision:null,confirmation:{configDigest:plan.configDigest}});
  assert.equal(staged.data.result.staged,true);
  const finalState=await response(setup,'POST','/api/v3/setup/access/state',{setupCode:'AO-7Q2K-91MX'});
  assert.equal(finalState.data.staged,true);assert.deepEqual(finalState.data.draft,draft);
  const settings=createExternalAccessMock();
  const read=await response(settings,'GET','/api/v3/settings/access');assert.equal(read.data.state,'open');assert.equal(read.data.settingsRevision,0);assert.equal(read.data.savedRevision,null);
  const readOnly=createExternalAccessMock({readonly:true});
  assert.equal((await response(readOnly,'POST','/api/v3/settings/access/plan',{draft,settingsRevision:0})).status,403);
});

test('external-access unavailable mock models a missing route for both contexts',async()=>{
 const unavailable=createExternalAccessMock({unavailable:true});
 assert.equal((await response(unavailable,'GET','/api/v3/settings/access')).status,404);
 assert.equal((await response(unavailable,'POST','/api/v3/setup/access/state',{setupCode:'AO-7Q2K-91MX'})).status,404);
});

test('external-access plan rejects stale public fields and incomplete tunnel drafts',async()=>{
 const settings=createExternalAccessMock();
 const stale={mode:'local',apiPublicUrl:'https://api.example.org/backend',uiOrigins:['https://office.example.org'],domain:'api.example.org',proxy:'caddy',security:DEFAULT_SECURITY};
 const incompleteTunnel={...stale,mode:'tunnel',uiOrigins:[]};delete incompleteTunnel.apiPublicUrl;
 assert.equal((await response(settings,'POST','/api/v3/settings/access/plan',{draft:stale,settingsRevision:0})).status,400);
 assert.equal((await response(settings,'POST','/api/v3/settings/access/plan',{draft:incompleteTunnel,settingsRevision:0})).status,400);
});
