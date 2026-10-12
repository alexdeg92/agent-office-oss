import { readFile } from 'node:fs/promises';
import scratchHome from '../../helpers/scratch-home.cjs';
scratchHome.refuseEntry(import.meta.url);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
// Registry-shaped synthetic data; no machine discovery, paths or credentials.
export async function connectorFixture({extraProviders=false,herdrDetected=false,herdr}={}) {
  const example=JSON.parse(await readFile(new URL('../../../public/v2/mock/examples/settings/settings-fixall-vm.json',import.meta.url),'utf8'));
  const vm=example.data;
  if(herdrDetected){
    vm.herdr={found:true,enabled:false,active:false,status:'not-checked',checkedAt:null};
    vm.diagnostics.push({id:'orchestrator:detected',level:'info',label:{key:'settings.diagnostic.orchestratorDetected',params:{source:'herdr'}},detail:null,section:'connection',fix:null});
  }
  if(herdr)vm.herdr=structuredClone(herdr);
  const openclaw=vm.runtimes.find(r=>r.id==='openclaw');
  openclaw.autoAdd={enabled:true,defaultEnabled:true,managed:false};
  const claude=vm.runtimes.find(r=>r.id==='claude-local');
  claude.enabled=true;claude.selected=true;claude.connection.status='connected';
  claude.autoAdd={enabled:true,defaultEnabled:true,managed:false};
  claude.fields=[{id:'home',label:{key:'settings.claude.home'},type:'text',required:true,writeOnly:false,options:[]},
    ...['include','exclude'].map(id=>({id,label:{key:'settings.claude.'+id},type:'textarea',control:'chips',required:false,writeOnly:false,options:[]}))];
  claude.values=Object.fromEntries(claude.fields.map(f=>[f.id,{value:f.id==='home'?'/fixture/claude':f.id==='include'?'demo-project':'',source:'file',editable:true,reason:null}]));
  const template=vm.runtimes.find(r=>r.id==='codex');
  template.connection.status='not-configured';
  for(const [id,name,logo,dark,found] of [['cursor-cli','Cursor','cursor-light.svg','cursor-dark.svg',true],['opencode','OpenCode','opencode-light.svg','opencode-dark.svg',false]]) {
    const r=structuredClone(template);
    vm.runtimes.push({...r,id,adapter:id,name,found,supported:false,enabled:false,brand:{mark:'?',color:'#596579',foreground:'#ffffff',providerName:name,logo:'assets/connectors/'+logo,logoDark:'assets/connectors/'+dark},detection:{...r.detection,status:found?'detected':'not-detected'}});
  }
  if(extraProviders)for(const [id,name] of [['hermes','Hermes'],['herdr','herdr']])vm.runtimes.push({...structuredClone(template),id,adapter:id,name,brand:null,found:false,supported:false});
  vm.runtimes.find(r=>r.id==='cursor-cli').brand=null;
  vm.runtimes.find(r=>r.id==='opencode').brand=null;
  return example;
}
export async function installConnectorFixture(page,options) {
  const example=await connectorFixture(options);
  await page.route('**/mock/examples/settings/settings-fixall-vm.json',route=>route.fulfill({json:example}));
  return example.data;
}
