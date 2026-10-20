'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openDatabase}=require('../../src/store/db');
const {createProjectsRepository}=require('../../src/store/repos/projects');
const {createEngine}=require('../../src/engine');
const {createMultiEngine}=require('../../src/engine/multi');
const {Owner,AT}=require('../projects/helpers');
const {settingsFixture}=require('./settings-fixture');
async function projectSourceProvenanceFixture(publicUrl){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ao-project-provenance-'));
 let old,h,engine;
 try{
  const migrationsDir=path.join(tmp,'migrations18');fs.mkdirSync(migrationsDir);
  for(const file of fs.readdirSync('src/store/migrations'))if(Number(file.slice(0,3))<=18)fs.copyFileSync('src/store/migrations/'+file,path.join(migrationsDir,file));
  old=openDatabase({dir:path.join(tmp,'data'),instance:'test',migrationsDir,now:()=>AT-500});
  const repo=createProjectsRepository(old.db,{persons:[Owner()],ownerPersonId:Owner().id,now:()=>AT});
  const projectIds=[];
  const create=(repository,n)=>repository.createProject({name:'Projet hérité '+(n+1),status:'todo',actor:'owner',sources:[{kind:'sessionGroup',ref:{by:'group',groupId:'projet:heritage-'+n,name:'heritage-'+n}}]}).id;
  for(let n=0;n<4;n++)projectIds.push(create(repo,n));
  old.close();
  const migrations29=path.join(tmp,'migrations29');fs.mkdirSync(migrations29);
  for(const file of fs.readdirSync('src/store/migrations'))if(Number(file.slice(0,3))<=29)fs.copyFileSync('src/store/migrations/'+file,path.join(migrations29,file));
  old=openDatabase({dir:path.join(tmp,'data'),instance:'test',migrationsDir:migrations29,now:()=>AT+1000});
  const later=createProjectsRepository(old.db,{persons:[],ownerPersonId:Owner().id,now:()=>AT+2000});
  for(let n=4;n<7;n++)projectIds.push(create(later,n));
  old.close();old=null;
  const instances=[['legacy','openclaw','OpenClaw'],['other','demo','Secondary source']].map(([id,adapter,name])=>({id,adapter,name,enabled:true,engine:createEngine({adapter:require('../../src/adapters').adapterById(adapter).definition})}));
  engine=createMultiEngine({instances});h=await settingsFixture({tmp,publicUrl,viewEngine:engine});
  const unknown=await h.post('/api/v3/projects',{name:'Provenance encore inconnue',sources:[{kind:'sessionGroup',ref:{by:'group',groupId:'missing-new-group',name:'Unknown'}}]});
  if(unknown.status!==200)throw Error(unknown.text);
  h.api.topics.invalidate();
  return {...h,projectIds,viewEngine:engine,unknownId:unknown.json.data.vm.id,async close(){await h.close();engine.close();fs.rmSync(tmp,{recursive:true,force:true});}};
 }catch(error){old?.close();await h?.close();engine?.close();fs.rmSync(tmp,{recursive:true,force:true});throw error;}
}
module.exports={projectSourceProvenanceFixture};
