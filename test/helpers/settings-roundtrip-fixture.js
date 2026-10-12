'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
// Real local detectors, configuration readers and integration file operations;
// only gateway/CLI transport is synthetic. No caller reads an operator home.
const fs=require('node:fs'),path=require('node:path');
const {settingsFixture}=require('./settings-fixture'),{TOKEN}=require('./onboarding-fixture');
const {detectRuntimes}=require('../../src/adapters/detection');
function seed(tmp,{gateway}) {
 const state=path.join(tmp,'.openclaw'),workspace=path.join(state,'workspace');
 const agents=[{id:'atlas',name:'Atlas',workspace,default:true},{id:'scribe',name:'Scribe',workspace:path.join(workspace,'claude-code')}];
 for(const a of agents){fs.mkdirSync(a.workspace,{recursive:true});fs.writeFileSync(path.join(a.workspace,'AGENTS.md'),'# Synthetic instructions\n\nKeep owner text.\n',{mode:0o640});fs.writeFileSync(path.join(a.workspace,'IDENTITY.md'),'- **Name:** '+a.name+'\n');}
 fs.writeFileSync(path.join(state,'openclaw.json'),JSON.stringify({gateway:{port:Number(new URL(gateway.url).port),auth:{token:TOKEN}},agents:{defaults:{workspace},list:agents}}),{mode:0o600});
 fs.mkdirSync(path.join(tmp,'.claude'));fs.mkdirSync(path.join(tmp,'.codex'));return agents;
}
async function realisticSettings(options={}) {
 return settingsFixture({...options,seed,detect:options.detect||(({env})=>detectRuntimes({env:{...env,PATH:''}})),config:(config,ctx)=>{
  config.agents.names={openclaw:{atlas:'Atlas',scribe:'Scribe'}};
  options.config?.(config,ctx);
 }});
}
module.exports={realisticSettings,seed};
