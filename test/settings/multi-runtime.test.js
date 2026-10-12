'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { settingsFixture } = require('../helpers/settings-fixture'), { waitFor } = require('../helpers/harness');
const { scopedId } = require('../../src/runtime-ids');
const BASE = '/api/v3/settings';
test('Settings enables simultaneous sources, selects a project primary, routes reads/writes and disables only the chosen source', async t => {
  const h = await settingsFixture(); t.after(() => h.close());
  const home = path.join(h.tmp, '.claude'), project = path.join(home, 'projects', 'synthetic-project'); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'synthetic-session.jsonl'), JSON.stringify({ type: 'user', uuid: 'synthetic-event', sessionId: 'synthetic-session',
    timestamp: new Date().toISOString(), message: { role: 'user', content: 'PRIVATE_SYNTHETIC_TRANSCRIPT' } }) + '\n');
  const rows = [{ id: 'legacy', adapter: 'openclaw', enabled: true, gatewayUrl: h.gw.url }, { id: 'claude', adapter: 'claude-code', enabled: true, home, include: '', exclude: '', agentGrouping: 'project' }, { id: 'demo-team', adapter: 'demo', enabled: true }];
  assert.equal((await h.put(BASE + '/runtimes', { expectedRevision: 1, runtimes: rows })).status, 403, 'reauth protects a new local transcript root');
  await h.reauth(); let r = await h.put(BASE + '/runtimes', { expectedRevision: 1, runtimes: rows }); assert.equal(r.status, 200, r.text);
  await waitFor(() => h.engine.agents().some(a => a.id.startsWith('rt:claude:')));
  const claude = h.engine.agents().find(a => a.id.startsWith('rt:claude:')), nativeAgent = require('../../src/runtime-ids').parseId(claude.id).local;
  assert.equal(h.engine.runtimes().filter(r => r.enabled).length, 3);
  assert.equal((await h.put(BASE + '/runtime', { expectedRevision: 2, runtime: { adapter: 'demo' } })).status, 409, 'legacy single-runtime command cannot erase the collection');
  r = await h.put(BASE + '/agents', { expectedRevision: 2, runtime: 'claude', primary: nativeAgent, agents: [{ id: nativeAgent, name: 'Synthetic project agent', hidden: false }] }); assert.equal(r.status, 200, r.text);
  assert.equal(h.engine.primaryAgent().id, claude.id);
  const session = h.engine.sessions().find(s => s.class.agentId === claude.id);
  assert.equal((await h.get('/api/v3/views/sessions/' + encodeURIComponent(session.key))).status, 200);
  assert.equal((await h.post('/api/v3/chat/messages', { text: 'Must never execute' })).status, 404, 'a gateway elsewhere cannot grant Claude chat');
  const demo = h.engine.instances.find(i => i.id === 'demo-team').runtime;
  const claudeRuntime = h.engine.instances.find(i => i.id === 'claude').runtime;
  fs.renameSync(home,home+'-temporarily-unavailable');
  rows[0].enabled = false;
  r = await h.put(BASE + '/runtimes', { expectedRevision: 3, runtimes: rows }); assert.equal(r.status, 200, r.text);
  fs.renameSync(home+'-temporarily-unavailable',home);
  assert.equal(h.engine.instances.find(i => i.id === 'claude').runtime,claudeRuntime,'unchanged Claude options are normalized; disabling another source needs no Claude probe');
  assert.equal(h.engine.instances.find(i => i.id === 'demo-team').runtime, demo, 'unchanged sources are retained');
  assert.ok(!h.engine.agents().some(a => a.id.startsWith('rt:legacy:')));
  assert.equal(h.engine.primaryAgent().id, claude.id);
  assert.equal((await h.get('/api/v3/views/health')).status, 200);
  assert.equal((await h.get('/api/v3/views/office')).status, 200);
  const config = JSON.parse(fs.readFileSync(h.paths.file)), secrets = JSON.parse(fs.readFileSync(h.paths.secrets));
  assert.equal(config.version, 3); assert.equal(secrets.runtimes.legacy.runtimeToken, h.fake.token);
  assert.ok(!JSON.stringify(h.store.audit.recent()).includes('PRIVATE_SYNTHETIC_TRANSCRIPT'));
  assert.ok(!JSON.stringify(r.json.data.vm).includes(h.fake.token));
  assert.equal((await h.put(BASE + '/runtimes', { expectedRevision: 4, runtimes: [{ id: 'claude', adapter: 'demo', enabled: true }] })).status, 400, 'a stable ID cannot be reused for another adapter');
});
test('failed local source does not prevent disabling it, and an empty collection retains core/store views', async t => {
  const h = await settingsFixture(); t.after(() => h.close()); await h.reauth();
  let r = await h.put(BASE + '/runtimes', { expectedRevision: 1, runtimes: [] }); assert.equal(r.status, 200, r.text);
  assert.deepEqual(h.engine.agents(), []); assert.deepEqual(h.engine.sessions(), []);
  assert.equal((await h.get('/api/v3/views/health')).status, 200);
  assert.equal((await h.get(BASE)).status, 200);
  assert.equal((await h.put(BASE + '/runtimes', { expectedRevision: 1, runtimes: [] })).status, 409);
});

test('full-set publication is protected by CSRF, rolls back files/identity bindings/revision and keeps the live generation',async t=>{
  const h=await settingsFixture({publicUrl:'http://127.0.0.1:19090'});t.after(()=>h.close());await h.reauth();
  const body={expectedRevision:1,runtimes:[{id:'demo-team',adapter:'demo',enabled:true}]};
  const files=[h.paths.file,h.paths.secrets].map(f=>fs.readFileSync(f,'utf8')), original=h.runtime.gw;
  assert.equal((await h.request('PUT',BASE+'/runtimes',body,{origin:'https://foreign.example.test'})).status,403);
  h.store.db.exec("CREATE TRIGGER fail_runtime_publish BEFORE UPDATE ON settings_state BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  const failed=await h.put(BASE+'/runtimes',body);assert.equal(failed.status,503,failed.text);
  assert.deepEqual([h.paths.file,h.paths.secrets].map(f=>fs.readFileSync(f,'utf8')),files);assert.equal(h.settings.revision(),1);assert.equal(h.runtime.gw,original);assert.equal(original.connected,true);assert.equal(h.store.runtimeReferences.adapterFor('demo-team'),null);
  h.store.db.exec('DROP TRIGGER fail_runtime_publish'); assert.equal((await h.put(BASE+'/runtimes',body)).status,200);
  assert.equal((await h.put(BASE+'/runtimes',{expectedRevision:2,runtimes:[]})).status,200);
  assert.equal((await h.put(BASE+'/runtimes',{expectedRevision:3,runtimes:[{id:'demo-team',adapter:'claude-code',enabled:false,home:h.tmp,include:'',exclude:'',agentGrouping:'project'}]})).status,400,'retired instance IDs keep their adapter binding');
  assert.ok(!JSON.stringify(h.store.audit.recent()).includes(h.tmp));
});

test('effective v3 boot of v2 files leaves GET/read publication unchanged and first save publishes both v3 files',async t=>{
  const h=await settingsFixture({effectiveV3:true});t.after(()=>h.close());
  const before=[h.paths.file,h.paths.secrets].map(f=>fs.readFileSync(f,'utf8'));
  assert.ok(h.engine.primaryAgent().id.startsWith('rt:legacy:agent:'));
  const vm=(await h.get(BASE)).json.data;
  assert.ok(vm.runtimes.some(r=>r.id==='legacy' && r.enabled));
  assert.deepEqual([h.paths.file,h.paths.secrets].map(f=>fs.readFileSync(f,'utf8')),before);
  const detected=(await h.post(BASE+'/detect')).json.data.vm.agents.find(a=>a.agentId==='atlas');
  assert.equal(detected.detectedName,'Orion');assert.equal(detected.nameSource,'IDENTITY.md');
  const saved=await h.put(BASE+'/instance',{expectedRevision:vm.revision,name:'Synthetic upgraded instance'});
  assert.equal(saved.status,200,saved.text);
  assert.equal(JSON.parse(fs.readFileSync(h.paths.file)).version,3);
  const secrets=JSON.parse(fs.readFileSync(h.paths.secrets));assert.equal(secrets.version,3);assert.equal(secrets.runtimes.legacy.runtimeToken,h.fake.token);
  assert.equal(JSON.parse(before[1]).sessionSecret,secrets.sessionSecret);
});

test('Codex include and exclude arrays serialize safely in the Settings API and remain canonical in config',async t=>{
  const h=await settingsFixture({effectiveV3:true});t.after(()=>h.close());
  const home=path.join(h.tmp,'.codex'),rollout=path.join(home,'sessions','2026','10','10','rollout-synthetic-settings.jsonl');
  fs.mkdirSync(path.dirname(rollout),{recursive:true});
  const timestamp='2026-10-11T04:00:00.000Z',cwd='/synthetic/private/agent-office';
  const rowsOnDisk=[
    {type:'session_meta',payload:{id:'synthetic-codex-settings',timestamp,cwd,originator:'codex-cli',cli_version:'0.synthetic',source:'cli',model_provider:'openai'}},
    {type:'turn_context',payload:{model:'gpt-synthetic-codex',cwd,current_date:'2026-10-11',timezone:'UTC',approval_policy:'never',sandbox_policy:'synthetic'}},
    {type:'response_item',timestamp,payload:{type:'message',id:'u1',role:'user',content:[{type:'input_text',text:'Synthetic Settings probe'}],status:'completed'}},
  ];
  fs.writeFileSync(rollout,rowsOnDisk.map(row=>JSON.stringify(row)).join('\n')+'\n');
  await h.reauth();
  const runtimes=[
    {id:'legacy',adapter:'openclaw',enabled:true,gatewayUrl:h.gw.url,token:h.fake.token},
    {id:'codex-team',adapter:'codex',enabled:true,home,include:['agent-office'],exclude:['excluded-project'],agentGrouping:'project'},
  ];
  const saved=await h.put(BASE+'/runtimes',{expectedRevision:1,runtimes});
  assert.equal(saved.status,200,saved.text);
  const codex=saved.json.data.vm.runtimes.find(row=>row.id==='codex-team');
  assert.equal(codex.values.include.value,'agent-office');assert.equal(codex.values.exclude.value,'excluded-project');
  const loaded=await h.get(BASE);assert.equal(loaded.status,200,loaded.text);
  const loadedCodex=loaded.json.data.runtimes.find(row=>row.id==='codex-team');
  assert.equal(loadedCodex.values.include.value,'agent-office');assert.equal(loadedCodex.values.exclude.value,'excluded-project');
  const config=JSON.parse(fs.readFileSync(h.paths.file,'utf8'));
  const stored=config.runtimes.find(row=>row.id==='codex-team').codex;
  assert.deepEqual(stored.include,['agent-office']);assert.deepEqual(stored.exclude,['excluded-project']);
});

test('instance labels persist independently of adapter options without probing or replacing the source',async t=>{
  const h=await settingsFixture({effectiveV3:true});t.after(()=>h.close());await h.reauth();
  const home=path.join(h.tmp,'.claude'),project=path.join(home,'projects','synthetic-project');fs.mkdirSync(project,{recursive:true});
  fs.writeFileSync(path.join(project,'session.jsonl'),JSON.stringify({type:'user',uuid:'event',sessionId:'session',timestamp:new Date().toISOString(),message:{role:'user',content:'Synthetic'}})+'\n');
  const rows=[{id:'legacy',adapter:'openclaw',enabled:true,gatewayUrl:h.gw.url},{id:'claude',adapter:'claude-code',enabled:true,home,include:'',exclude:'',agentGrouping:'project'}];
  assert.equal((await h.put(BASE+'/runtimes',{expectedRevision:1,runtimes:rows})).status,200);
  await waitFor(()=>h.engine.agents().some(a=>a.id.startsWith('rt:claude:')));
  const original=h.engine.instances.find(i=>i.id==='claude').runtime;
  fs.renameSync(home,home+'-unavailable');
  rows[1].name='  Claude Code · Work projects  ';
  const saved=await h.put(BASE+'/runtimes',{expectedRevision:2,runtimes:rows});assert.equal(saved.status,200,saved.text);
  assert.equal(h.engine.instances.find(i=>i.id==='claude').runtime,original);
  assert.equal(h.engine.runtimes().find(r=>r.id==='claude').name,'Claude Code · Work projects');
  assert.equal(saved.json.data.vm.runtimes.find(r=>r.id==='claude').name,'Claude Code · Work projects');
  assert.equal(JSON.parse(fs.readFileSync(h.paths.file)).runtimes.find(r=>r.id==='claude').name,'Claude Code · Work projects');
  for(const name of ['', '  ', 'x'.repeat(81), 'bad\nname',42]) {
    rows[1].name=name;assert.equal((await h.put(BASE+'/runtimes',{expectedRevision:3,runtimes:rows})).status,400);
  }
  delete rows[1].name;assert.equal((await h.put(BASE+'/runtimes',{expectedRevision:3,runtimes:rows})).status,200);
  assert.equal(h.engine.runtimes().find(r=>r.id==='claude').name,'Claude Code · Work projects','omission preserves an existing label');
});
