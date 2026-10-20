'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openDatabase,MIGRATIONS_DIR}=require('../../src/store/db');

test('migration 034 marks only legacy member-target sessions as pane provenance',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-m034-pane-'));
  const data=path.join(root,'data'),prior=path.join(root,'prior-migrations');fs.mkdirSync(prior);
  let db;
  t.after(()=>{db?.close();fs.rmSync(root,{recursive:true,force:true});});
  for(const file of fs.readdirSync(MIGRATIONS_DIR))if(Number(file.slice(0,3))<=33)fs.copyFileSync(path.join(MIGRATIONS_DIR,file),path.join(prior,file));
  db=openDatabase({dir:data,instance:'test',migrationsDir:prior,log:()=>{}}).db;
  const scope='a'.repeat(64),targets=[
    ['ca_'+'1'.repeat(32),'member:member:pm'],
    ['ca_'+'2'.repeat(32),'agent:rt:openclaw:agent:main'],
    ['ca_'+'3'.repeat(32),'agent:rt:codex:agent:worker']
  ];
  for(const [id,source] of targets)db.prepare('INSERT INTO chat_v3_targets(target_id,principal_scope,target_kind,source_ref,runtime_id,native_agent_id,created_at) VALUES(?,?,?,?,?,?,1)').run(id,scope,'agent',source,'openclaw','main');
  const rows=[
    ['cs_'+'1'.repeat(32),targets[0][0],'claude-code','pm','native-pane-ref'],
    ['cs_'+'2'.repeat(32),targets[1][0],'openclaw','main','native-adapter-ref'],
    ['cs_'+'3'.repeat(32),targets[2][0],'codex','worker','codex-rollout-ref'],
    ['cs_'+'4'.repeat(32),targets[1][0],'openclaw','main','portal-chat:user:'+scope+':session:cs_'+'4'.repeat(32)]
  ];
  for(const [id,target,runtime,agent,ref] of rows)db.prepare('INSERT INTO chat_v3_sessions(session_id,principal_scope,agent_id,runtime_id,native_agent_id,native_session_ref,title,created_at,updated_at) VALUES(?,?,?,?,?,?,\'\',1,1)').run(id,scope,target,runtime,agent,ref);
  db.close();db=null;

  db=openDatabase({dir:data,instance:'test',log:()=>{}}).db;
  const counts=db.prepare(`SELECT
    sum(CASE WHEN pane_member_id='legacy:unresolved' THEN 1 ELSE 0 END) AS unresolved_pane,
    sum(CASE WHEN pane_member_id IS NULL THEN 1 ELSE 0 END) AS ordinary
    FROM chat_v3_sessions`).get();
  assert.deepEqual({...counts},{unresolved_pane:1,ordinary:3},'only the stored member-target row receives unresolved pane provenance');
});
