import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as R from '../../public/v2/pages/settings-rules.js';
import { createSettingsMock } from '../../public/v2/mock/settings.js';
import { validateVM } from '../../public/v2/generated/vm-schemas.js';
import { settingsLabel, diagnosticText, readOnlyBanner, detectionText } from '../../public/v2/pages/settings-labels.js';
import { setMeta, setLang } from '../../public/v2/i18n.js';
import { registerMessages } from '../../public/v2/messages.js';
import * as settingsMessages from '../../public/v2/messages/settings.js';
const example=name => JSON.parse(readFileSync(new URL('../../public/v2/mock/examples/settings/'+name+'.json',import.meta.url)));
const fixture=() => example('settings-vm').data;

test('integrations use provider routes and keep a distinct permission gate after removing the tab',()=>{
 const vm=fixture();
 assert.ok(!R.SETTINGS_TABS.includes('integrations'));assert.equal(R.settingsTab('integrations'),'connexion');
 assert.deepEqual(R.integrationRoute(vm,'openclaw'),{onglet:'connexion',connecteur:'openclaw',runtime:'openclaw',section:'integrations'});
 const grouped={...vm,runtimes:[{...vm.runtimes[0],id:'office-work',adapter:'future-provider'}]};
 assert.deepEqual(R.integrationRoute(grouped,'office-work'),{onglet:'connexion',connecteur:'future-provider',runtime:'office-work',section:'integrations'});
 assert.equal(R.fixTab({kind:'integration.review'}),'connexion');
 const runtimeOnly={permissions:{'settings.runtimes':'write'}};
 assert.equal(R.settingsAccess('connexion',vm,runtimeOnly,'write'),true);assert.equal(R.settingsAccess('integrations',vm,runtimeOnly,'write'),false);
 const integrationOnly={permissions:{'settings.integrations':'write'}};
 assert.equal(R.settingsAccess('connexion',vm,integrationOnly,'write'),false);assert.equal(R.settingsAccess('integrations',vm,integrationOnly,'write'),true);
});

test('read-only banners state the restriction once and preserve specific reasons in French and English',()=>{
  registerMessages(settingsMessages);
  for(const lang of ['fr','en']){
    setLang(lang);setMeta({locale:lang,labels:{'settings.readonly':lang==='fr'?'Cette instance est en lecture seule.':'This instance is read-only.','specific.reason':'Maintenance'},enums:{}});
    const expected=lang==='fr'?'Cette instance est en lecture seule. Les changements sont désactivés.':'This instance is read-only. Changes are disabled.';
    assert.equal(readOnlyBanner({key:'settings.readonly'}),expected);
    assert.equal(readOnlyBanner(null),expected);
    assert.equal(readOnlyBanner({key:'specific.reason'}),expected+' Maintenance');
  }
  setLang('fr');setMeta({locale:'fr',labels:{},enums:{}});
});

test('authoritative diagnostic labels retain runtime/agent parameters; examples still have a localized fallback', () => {
  registerMessages(settingsMessages);setLang('fr');
  setMeta({labels:{'settings.diagnostic.connected':'{runtime} · moteur connecté'},enums:{},locale:'fr'});
  assert.equal(settingsLabel({key:'settings.diagnostic.connected',params:{runtime:'Future engine'}}),'Future engine · moteur connecté');
  setMeta({labels:{},enums:{},locale:'fr'});
  assert.equal(settingsLabel({key:'settings.diagnostic.connected',params:{runtime:'Future engine'}}),'Future engine · moteur connecté');
});

test('diagnostic identity resolves legacy runtime rows and explains unavailable connections in both languages', () => {
  registerMessages(settingsMessages);
  const vm=fixture(), row=vm.diagnostics.find(d=>d.id==='runtime:codex');
  for(const lang of ['fr','en']){
    setLang(lang);setMeta({locale:lang,labels:{},enums:{}});
    const text=diagnosticText(row,vm);
    assert.ok(text.title.startsWith('Codex · '));
    assert.ok(text.title.endsWith(lang==='fr'?'détecté, pas encore connecté':'detected, not connected yet'));
    assert.ok(text.detail.includes(lang==='fr'?'Configurez ce moteur':'Set up this runtime'));
    assert.ok(!text.title.includes(lang==='fr'?'non prise en charge':'not supported'));
    assert.ok(!text.detail.includes(lang==='fr'?'ne peut pas encore se connecter':'cannot connect'));
    const connected=diagnosticText(vm.diagnostics[0],vm);
    assert.ok(connected.title.startsWith('OpenClaw · '));
    assert.equal(connected.title.match(/OpenClaw/g).length,1);
  }
  setLang('fr');setMeta({labels:{},enums:{},locale:'fr'});
});

test('mock diagnostics distinguish healthy configured agents from integration actions after refresh',async()=>{
  registerMessages(settingsMessages);
  for(const status of ['installed','missing','outdated','modified','unsupported']){
    const vm=fixture(),a=vm.agents.find(a=>a.agentId==='atlas');a.integrations[0].status=status;
    const mock=createSettingsMock({vm,examples:{}});await mock.handle('POST','/api/v3/settings/detect');
    const row=mock.vm().diagnostics.find(d=>d.id==='agent:'+a.id);
    assert.equal(row.level,status==='installed'?'ok':status==='unsupported'?'info':'warning');
    for(const lang of ['fr','en']){
      setLang(lang);setMeta({locale:lang,labels:{},enums:{}});
      const text=diagnosticText(row,mock.vm());assert.ok(text.title.includes('Atlas'));
      assert.ok(!text.title.includes('settings.'));
      if(status!=='installed'){assert.ok(text.detail.includes('projet'));assert.ok(!text.title.includes(lang==='fr'?'Agent configuré':'Agent configured'));}
    }
  }
  setLang('fr');setMeta({locale:'fr',labels:{},enums:{}});
});

test('frontend examples match the backend contract; checking a saved connection keeps the mock VM strict',async () => {
  for (const name of ['settings-vm','settings-readonly-vm','settings-env-vm','settings-integrations-vm','save-result','password-result','detect-result','integration-apply-result']) {
    const frontend=example(name);
    const canonical=JSON.parse(readFileSync(new URL('../../docs/architecture/examples/settings/'+name+'.json',import.meta.url)));
    assert.deepEqual(frontend,canonical,name+' example drift');
    const vm=frontend.data.vm || (frontend.data.revision != null && frontend.data.runtimes ? frontend.data : null);
    if(vm) assert.deepEqual(validateVM('settings',vm,3),{ok:true});
  }
  const db=createSettingsMock({vm:fixture(),examples:{'check-result':example('check-result')}});
  await db.handle('POST','/api/v3/settings/check',{runtime:R.runtimeBody(R.initialDrafts(db.vm()).connexion,db.vm())});
  assert.deepEqual(validateVM('settings',db.vm(),3),{ok:true});
});

test('Herdr Connexion check is read-only and the activation choice round-trips in the full runtimes command', async () => {
  const vm=fixture(); vm.herdr={found:true,enabled:false,active:false,status:'available',checkedAt:1};
  const draft=R.initialDrafts(vm).connexion;
  assert.equal(draft.herdrEnabled,false);
  draft.herdrEnabled=true;
  const body=R.runtimesBody(draft,vm);
  assert.equal(body.herdrEnabled,true);
  assert.ok(Array.isArray(body.runtimes));
  const db=createSettingsMock({vm,examples:{'reauth-request':example('reauth-request')}});
  const check=await db.handle('POST','/api/v3/settings/herdr/check');
  assert.deepEqual(check.body.data.result,{found:true,status:'available',agentCount:3});
  await db.handle('POST','/api/v3/settings/reauth',example('reauth-request'));
  const save=await db.handle('PUT','/api/v3/settings/runtimes',{expectedRevision:vm.revision,...body});
  assert.equal(save.status,200,JSON.stringify(save.body));
  assert.deepEqual([save.body.data.vm.herdr.enabled,save.body.data.vm.herdr.active],[true,true]);
});

test('runtime descriptor fields are generic and write-only credentials require replacement after URL/adapter changes', () => {
  const vm=fixture(); const runtime=vm.runtimes[0];
  runtime.id='future-instance'; runtime.adapter='future-adapter'; vm.agents=[];
  const draft=R.initialDrafts(vm).connexion;
  assert.equal(R.runtimeError(draft,vm),null);
  assert.equal(R.runtimeBody(draft,vm).adapter,'future-adapter');
  assert.equal(R.runtimeBody(draft,vm).id,'future-instance');
  assert.ok(!Object.hasOwn(R.runtimeBody(draft,vm),'token'));
  draft.values[runtime.id].gatewayUrl='wss://fixture.invalid/new';
  assert.equal(R.runtimeError(draft,vm).field,'token');
  draft.secrets[runtime.id]={token:'typed fixture token'};
  assert.equal(R.runtimeError(draft,vm),null);
  assert.equal(R.runtimeBody(draft,vm).token,'typed fixture token');
});

test('changing the viewed agent runtime is clean; edits require a unique visible primary and safe Store links', () => {
  const vm=fixture(); const drafts=R.initialDrafts(vm);
  assert.equal(R.agentRuntimeSelection(vm,'all'),'all');
  const aliased=structuredClone(vm);aliased.runtimes[0].id='openclaw-instance';aliased.runtimes[0].adapter='openclaw';
  for(const agent of aliased.agents) if(agent.runtime==='openclaw') agent.runtime='openclaw-instance';
  assert.equal(R.agentRuntimeSelection(aliased,'openclaw'),'openclaw-instance','adapter URL aliases resolve to the stable runtime instance ID');
  drafts.agents=R.agentDraft(vm,'future-adapter');
  assert.equal(R.dirty('agents',drafts,vm),false);
  drafts.agents.agents.push({id:'writer',name:'Writer',hidden:false});
  assert.equal(R.dirty('agents',drafts,vm),true);
  assert.equal(R.agentError(drafts.agents),null,'an existing primary in another instance is retained');
  drafts.agents.otherPrimary=false;
  assert.equal(R.agentError(drafts.agents),'settings.error.primary');
  drafts.agents.primary='writer'; assert.equal(R.agentError(drafts.agents),null);
  drafts.agents.agents[0].hidden=true; assert.equal(R.agentError(drafts.agents),'settings.error.primary');
  assert.equal(R.lookQuery('https://evil.test/boutique?agent=x'),null);
  assert.deepEqual(R.lookQuery('/boutique?onglet=personnages&agent=agent%3Ascribe'),{onglet:'personnages',agent:'agent:scribe'});
});

test('mock commands follow backend examples: reauth, revision conflicts, write-only saves and restart state', async () => {
  let now=1000; const events=[];
  const db=createSettingsMock({vm:fixture(),now:()=>now,onChange:e=>events.push(e),examples:Object.fromEntries(['reauth-request','check-result','integration-plan-result'].map(name=>[name,example(name)]))});
  const send=(name,body,method='POST')=>db.handle(method,'/api/v3/settings/'+name,body);
  const runtime={...R.runtimeBody(R.initialDrafts(db.vm()).connexion,db.vm()),token:'fixture new token'};
  assert.equal((await send('runtime',{expectedRevision:1,runtime},'PUT')).status,403);
  assert.equal((await send('reauth',{password:'wrong'})).status,401);
  assert.equal((await send('reauth',example('reauth-request'))).status,200);
  const saved=await send('runtime',{expectedRevision:1,runtime},'PUT');
  assert.equal(saved.status,200); assert.equal(saved.body.data.vm.runtimes[0].values.token.value,null);
  assert.equal(saved.body.data.vm.runtimes[0].values.token.tokenSet,true);
  assert.ok(!JSON.stringify(saved).includes('fixture new token'));
  assert.equal((await send('instance',{expectedRevision:1,name:'New name'},'PUT')).status,409);
  const network={expectedRevision:2,mode:'local',port:3031,publicUrl:null};
  assert.equal((await send('network',network,'PUT')).body.data.vm.network.restartRequired,true);
  assert.equal(db.vm().network.active.port,fixture().network.active.port);
  assert.deepEqual(Object.keys(events[0]).sort(),['changed','restartRequired','revision']);
  now+=300001; assert.equal((await send('network',{...network,expectedRevision:3},'PUT')).status,403);
});

test('agents without a chosen name remain editable and save null according to the contract', async () => {
  const vm=fixture(); vm.agents.find(a => a.configured).name=null;
  const draft=R.agentDraft(vm);
  draft.agents[0].hidden=true;
  draft.agents.push({id:'new-primary',name:'Primary',hidden:false});
  draft.primary='new-primary';
  assert.equal(R.agentError(draft),null);
  const body=R.agentBody(draft,vm.revision);
  assert.equal(body.agents[0].name,null);
  const db=createSettingsMock({vm});
  const response=await db.handle('PUT','/api/v3/settings/agents',body);
  assert.equal(response.status,200);
  assert.equal(response.body.data.vm.agents.find(a => a.agentId === draft.agents[0].id).name,null);
  assert.deepEqual(validateVM('settings',response.body.data.vm,3),{ok:true});
  draft.agents[0].name=' '.repeat(2);
  assert.equal(R.agentBody(draft,vm.revision).agents[0].name,null);
  draft.agents[0].name='A'.repeat(81);
  assert.equal(R.agentError(draft),'settings.error.name');
});

test('pending sections include every draft and the reviewed plan while per-section dirtiness stays local', () => {
  const vm=fixture(),drafts=R.initialDrafts(vm);
  drafts.agents.agents[0].name='Unsaved';
  assert.deepEqual(R.pendingSections(drafts,vm,null),['agents']);
  assert.equal(R.dirty('compte',drafts,vm),false);
  assert.deepEqual(R.pendingSections(drafts,vm,{result:{planId:'fixture'}}),['agents','connexion']);
  drafts.compte.owner.displayName='Account draft';
  assert.deepEqual(R.pendingSections(drafts,vm,null),['agents','compte']);
  drafts.compte=R.initialDrafts(vm).compte;
  assert.deepEqual(R.pendingSections(drafts,vm,null),['agents']);
});

test('review plans expire; read-only and environment-owned fields reject mutation', async () => {
  const examples=Object.fromEntries(['reauth-request','check-result','integration-plan-result'].map(name=>[name,example(name)]));
  let now=1000; const db=createSettingsMock({vm:fixture(),examples,now:()=>now});
  const plan=await db.handle('POST','/api/v3/settings/integrations/plan',{runtime:R.activeRuntime(db.vm())});
  assert.equal(db.vm().revision,1);
  now+=600001; await db.handle('POST','/api/v3/settings/reauth',examples['reauth-request']);
  const apply=await db.handle('POST','/api/v3/settings/integrations/apply',{planId:plan.body.data.result.planId,agentIds:['scribe'],confirmed:true,action:'install'});
  assert.equal(apply.status,400); assert.equal(db.vm().revision,1);
  const readonly=createSettingsMock({vm:example('settings-readonly-vm').data,examples});
  assert.equal((await readonly.handle('POST','/api/v3/settings/detect')).status,403);
  const env=createSettingsMock({vm:example('settings-env-vm').data,examples});
  await env.handle('POST','/api/v3/settings/reauth',examples['reauth-request']);
  assert.equal((await env.handle('PUT','/api/v3/settings/runtime',{expectedRevision:1,runtime:{adapter:R.activeRuntime(env.vm()),gatewayUrl:'wss://changed.example.test',token:'fixture token'}})).status,403);
});

test('same-kind instances have independent IDs, credentials and checks; disabling requires no healthy probe',()=>{
 const vm=fixture(), original=vm.runtimes.find(r=>r.adapter==='openclaw');let draft=R.initialDrafts(vm).connexion;
 draft=R.addRuntime(draft,vm,original);const added=draft.additions[0];assert.notEqual(added.id,original.id);assert.equal(added.adapter,original.adapter);
 assert.equal(added.values.token.tokenSet,false);assert.equal(R.runtimesError(draft,vm).field,'token');
 draft.secrets[added.id]={token:'synthetic-second-secret'};assert.equal(R.connectionsChecked(draft,vm,{}),false);
 assert.equal(R.connectionsChecked(draft,vm,{[added.id]:{ok:true}}),true);
 const bodies=R.runtimesBody(draft,vm).runtimes;assert.equal(bodies.length,2);assert.equal(bodies[0].token,undefined);assert.equal(bodies[1].token,'synthetic-second-secret');
 draft.enabled[added.id]=false;draft.enabled[original.id]=false;assert.equal(R.connectionsChecked(draft,vm,{}),true);
});

test('renaming an instance is a generic metadata-only draft and never requires another connection check',()=>{
  const vm=fixture(),draft=R.initialDrafts(vm).connexion,r=vm.runtimes.find(r=>r.selected);
  draft.names[r.id]='Synthetic project team';
  assert.equal(R.dirty('connexion',{connexion:draft},vm),true);
  assert.equal(R.connectionsChecked(draft,vm,{}),true);
  assert.equal(R.runtimesBody(draft,vm).runtimes.find(row=>row.id===r.id).name,'Synthetic project team');
  assert.ok(!Object.hasOwn(R.runtimeBody(draft,vm),'name'),'connection probes only receive adapter fields');
  for(const name of ['', ' ', 'x'.repeat(81),'bad\nname']) {
    draft.names[r.id]=name;assert.equal(R.runtimesError(draft,vm).key,'settings.connection.invalidName');
  }
});


test('detection badges honor the authoritative checked state in French and English', () => {
  registerMessages(settingsMessages);
  for (const lang of ['fr','en']) {
    setLang(lang); setMeta({locale:lang,labels:{},enums:{}});
    const unknown=detectionText({found:true,reason:{key:'settings.detection.none'},detection:{status:'not-checked',checkedAt:null}});
    assert.equal(unknown.badge,lang==='fr'?'Pas encore vérifié':'Not checked yet');
    assert.equal(unknown.reason,lang==='fr'?'Détection pas encore effectuée.':'Detection has not run yet.');
    assert.equal(unknown.checkedAt,null);
    const absent=detectionText({found:false,reason:{key:'settings.detection.none'},detection:{status:'not-detected',checkedAt:1000}});
    assert.equal(absent.badge,lang==='fr'?'Non détecté':'Not detected'); assert.equal(absent.checkedAt,1000);
    assert.ok(absent.reason.includes(lang==='fr'?'chemins vérifiés':'checked paths'));
    const enabled=detectionText({found:true,reason:{key:'settings.detection.enabled'},detection:{status:'enabled',checkedAt:null}});
    assert.equal(enabled.badge,lang==='fr'?'Activé':'Enabled');
  }
  setLang('fr'); setMeta({locale:'fr',labels:{},enums:{}});
});


test('guarded account revisions stay independent; legacy password wire format is unchanged',()=>{
  const vm=fixture();vm.revision=31;vm.owner.revision=4;
  assert.equal(R.accountRevision(vm),4);assert.deepEqual(R.passwordBody(vm,'synthetic-password'),{expectedRevision:4,password:'synthetic-password'});
  delete vm.owner.revision;assert.equal(R.accountRevision(vm),31);assert.deepEqual(R.passwordBody(vm,'synthetic-password'),{password:'synthetic-password'});
});

test('withheld Settings groups stay null and permission context never creates editable config defaults',()=>{
  const vm=fixture();vm.owner.revision=7;vm.instance=null;vm.network=null;vm.office=null;vm.restart=null;vm.runtimes=[];vm.agents=[];
  const drafts=R.initialDrafts(vm);assert.deepEqual(drafts.instance,{instance:null,office:null,network:null});
  assert.equal(R.hasDrafts(drafts,vm),false);assert.equal(R.instanceError(drafts.instance),null);assert.deepEqual(R.changedFields(null,null),{});
  for(const tab of ['agents','connexion','integrations','instance'])assert.equal(R.settingsAccess(tab,vm,{permissions:{}},'write'),false);
  assert.equal(R.settingsAccess('instance',vm,null),false);
  assert.equal(R.settingsAccess('compte',vm,{permissions:{}}),true);
  assert.equal(R.settingsAccess('instance',vm,{permissions:{'settings.network':'read'}}),true);
  assert.equal(R.settingsAccess('instance',vm,{permissions:{'settings.network':'read'}},'write'),false);
  const source=fixture();vm.instance=source.instance;
  assert.equal(R.instanceError(R.initialDrafts(vm).instance),null,'readable instance without network works independently');
  vm.instance=null;vm.network=source.network;
  assert.equal(R.instanceError(R.initialDrafts(vm).instance),null,'readable network without instance works independently');
});
