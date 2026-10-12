// Real detector/adapter/installer, synthetic files only. No host runtime home is copied.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import scratchHome from '../../helpers/scratch-home.cjs';
scratchHome.refuseEntry(import.meta.url);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
const require=createRequire(import.meta.url);
const {detectRuntimes}=require('../../../src/adapters/detection');
const {TOKEN}=require('../../helpers/onboarding-fixture');
export const realisticOptions={
  effectiveV3:true,
  detect:ctx=>detectRuntimes({...ctx,env:{...ctx.env,PATH:''}}),
  config(config) { config.agents.configured={openclaw:['atlas','scribe']}; config.agents.names.openclaw.scribe='Scribe'; },
  seed(tmp,{gateway}) {
    const state=path.join(tmp,'.openclaw');
    const agents=[{id:'atlas',workspace:path.join(state,'workspace'),default:true},{id:'scribe',workspace:path.join(state,'workspace','claude-code')}];
    for(const a of agents){fs.mkdirSync(a.workspace,{recursive:true});fs.writeFileSync(path.join(a.workspace,'AGENTS.md'),'# Synthetic workspace\n\nPreserve these owner instructions.\n');}
    fs.writeFileSync(path.join(agents[0].workspace,'IDENTITY.md'),'- **Name:** Orion\n');
    fs.writeFileSync(path.join(state,'openclaw.json'),JSON.stringify({gateway:{port:Number(new URL(gateway.url).port),auth:{token:TOKEN}},agents:{list:agents}}));
    for(const dir of ['.claude','.codex'])fs.mkdirSync(path.join(tmp,dir));
    return agents;
  }
};
