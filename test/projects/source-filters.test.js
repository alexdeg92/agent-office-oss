'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildBoardVM,buildProjectVM}=require('../../src/projects/vm');
const {labelsFor}=require('../../src/i18n');
const source=(id,kind,ref=null)=>({id,kind,ref,addedAt:1000});
const project=(id,sources)=>({id,name:id,status:'todo',priority:'P2',revision:1,archivedAt:null,summary:'',summaryMeta:null,
 flags:[],people:[],sources,repo:null,repoStatus:null,lastActivityAt:1000,createdAt:1000});
const connector={id:'gateway-a',adapter:'fixture-runtime',name:'Fixture Gateway',mark:null};
const sourceConnectors=s=>s.kind==='sessionGroup'?[connector]:[];

test('canonical source identities aggregate projects once and select the whole source',()=>{
 const projects=[project('prj_a',[source('manual-a','manual'),source('sg-a','sessionGroup',{by:'keys',sessionKeys:['a']})]),
  project('prj_b',[source('manual-b','manual'),source('sg-b','sessionGroup',{by:'keys',sessionKeys:['b']})]),
  project('prj_c',[source('manual-c','manual'),source('sg-c1','sessionGroup',{by:'keys',sessionKeys:['c']}),source('sg-c2','sessionGroup',{by:'keys',sessionKeys:['d']})]),
  project('prj_d',[source('manual-d','manual')])];
 const board=buildBoardVM(projects,{sourceConnectors,apiVersion:3});
 assert.equal(board.sourceFilters.length,2,'separate linked-source instances do not create duplicate chips');
 const grouped=board.sourceFilters.find(row=>row.source.kind==='sessionGroup');
 assert.equal(grouped.source.runtime,connector.adapter);assert.deepEqual(grouped.label,{key:'project.source.label',params:{label:connector.name}});
 assert.equal(grouped.count,3,'two links to one source on a project still count once');
 assert.equal(board.sourceFilters.find(row=>row.source.kind==='manual').count,4);
 const selected=buildBoardVM(projects,{sourceConnectors,sourceFilterId:grouped.id,apiVersion:3});
 assert.deepEqual(selected.columns.flatMap(column=>column.cards).map(row=>row.id),['prj_a','prj_b','prj_c']);
 assert.equal(selected.sourceFilters.find(row=>row.id===grouped.id).selected,true);
 assert.deepEqual(buildProjectVM(projects[2],[],{sourceConnectors}).sourceDescriptors,board.columns.flatMap(row=>row.cards).find(row=>row.id==='prj_c').sourceDescriptors);
});

test('declared connector instances remain distinct and generic kinds have FR/EN labels',()=>{
 const projects=[project('prj_a',[source('sg-a','sessionGroup',{by:'keys',sessionKeys:['a']})]),project('prj_b',[source('sg-b','sessionGroup',{by:'keys',sessionKeys:['b']})]),
  project('prj_c',[source('gh-c','github',{owner:'one-owner',repo:'repo-a'})]),project('prj_d',[source('gh-d','github',{owner:'one-owner',repo:'repo-b'})]),
  project('prj_e',[source('gh-e','github',{owner:'another-owner',repo:'repo-c'})]),project('prj_f',[source('ws-f','workspace',{path:'folder/a'})]),
  project('prj_g',[source('sg-g','sessionGroup',{by:'group',groupId:'unavailable',name:'Offline group'})])];
 const board=buildBoardVM(projects,{sourceConnectors:s=>s.ref?.sessionKeys?[{...connector,id:s.ref.sessionKeys[0]}]:[],apiVersion:3});
 assert.equal(board.sourceFilters.filter(row=>row.source.runtime===connector.adapter).length,2,'same adapter with different canonical instance IDs stays separate');
 assert.deepEqual(board.sourceFilters.filter(row=>row.source.kind==='github').map(row=>row.count).sort(),[1,2]);
 for(const locale of ['fr','en']){
  const labels=labelsFor(locale,3);
  for(const row of board.sourceFilters)assert.equal(typeof labels[row.label.key],'string',row.label.key+' must resolve in '+locale);
 }
});
