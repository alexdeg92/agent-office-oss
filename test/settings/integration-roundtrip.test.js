'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {realisticSettings}=require('../helpers/settings-roundtrip-fixture');
const I=require('../../src/adapters/openclaw/integration');
const BASE='/api/v3/settings';
test('real installer and Settings status agree before detect, after install/re-GET, and after uninstall/re-GET',async t=>{
 const h=await realisticSettings();t.after(()=>h.close());await h.reauth();
 const workspaces=[path.join(h.tmp,'.openclaw/workspace'),path.join(h.tmp,'.openclaw/workspace/claude-code')];
 const rows=vm=>vm.agents.filter(a=>['atlas','scribe'].includes(a.agentId));
 assert.ok(rows((await h.get(BASE)).json.data).every(a=>a.integrations[0].status==='missing'));
 const apply=async action=>{const p=await h.post(BASE+'/integrations/plan',{runtime:'openclaw',locale:'fr'});assert.equal(p.status,200,p.text);const r=await h.post(BASE+'/integrations/apply',{planId:p.json.data.result.planId,agentIds:['atlas','scribe'],action,confirmed:true});assert.equal(r.status,200,r.text);return r.json.data.vm;};
 let vm=await apply('install');assert.deepEqual(h.events.at(-1).changed,['integrations']);assert.equal(h.events.at(-1).revision,vm.revision);for(const workspace of workspaces)assert.equal(I.inspect({id:'synthetic',workspace},{locale:'fr'}).status,'installed');
 assert.ok(rows(vm).every(a=>a.integrations[0].status==='installed'));assert.ok(rows((await h.get(BASE)).json.data).every(a=>a.integrations[0].status==='installed'));
 vm=await apply('uninstall');assert.ok(rows(vm).every(a=>a.integrations[0].status==='missing'));assert.ok(rows((await h.get(BASE)).json.data).every(a=>a.integrations[0].status==='missing'));
 for(const workspace of workspaces){assert.equal(fs.existsSync(path.join(workspace,'skills/projet/projet.js')),false);assert.equal(fs.readFileSync(path.join(workspace,'AGENTS.md'),'utf8'),'# Synthetic instructions\n\nKeep owner text.\n');assert.equal(fs.statSync(path.join(workspace,'AGENTS.md')).mode&0o777,0o640);}
});
test('real owned integration repair and locale update agree with fresh GET then uninstall',async t=>{
 const h=await realisticSettings();t.after(()=>h.close());await h.reauth();const workspace=path.join(h.tmp,'.openclaw/workspace'),target={id:'atlas',workspace};
 I.install(target,{locale:'fr',backupDir:path.join(h.tmp,'data/integrations/backups')});const expected=I.expected(workspace,'fr'),script=path.join(expected.dir,'projet.js');fs.appendFileSync(script,'\n// Older owned scratch revision\n');
 const row=vm=>vm.agents.find(a=>a.agentId==='atlas');assert.equal(row((await h.get(BASE)).json.data).integrations[0].status,'outdated');
 const apply=async action=>{const p=await h.post(BASE+'/integrations/plan',{runtime:'openclaw'});assert.equal(p.status,200,p.text);const r=await h.post(BASE+'/integrations/apply',{planId:p.json.data.result.planId,agentIds:['atlas'],action,confirmed:true});assert.equal(r.status,200,r.text);return r.json.data.vm;};
 assert.equal(row(await apply('install')).integrations[0].status,'installed');assert.equal(fs.readFileSync(script,'utf8'),expected.files['projet.js']);assert.equal(row((await h.get(BASE)).json.data).integrations[0].status,'installed');
 let vm=(await h.get(BASE)).json.data;const language=await h.put(BASE+'/instance',{expectedRevision:vm.revision,locale:'en'});assert.equal(language.status,200,language.text);assert.equal(row((await h.get(BASE)).json.data).integrations[0].status,'outdated');
 assert.equal(row(await apply('install')).integrations[0].status,'installed');assert.equal(I.inspect(target,{locale:'en'}).status,'installed');assert.equal(row((await h.get(BASE)).json.data).integrations[0].status,'installed');
 assert.equal(row(await apply('uninstall')).integrations[0].status,'missing');assert.equal(row((await h.get(BASE)).json.data).integrations[0].status,'missing');assert.equal(fs.readFileSync(path.join(workspace,'AGENTS.md'),'utf8'),'# Synthetic instructions\n\nKeep owner text.\n');
});
