import assert from 'node:assert/strict';
import scratchHome from '../../helpers/scratch-home.cjs';
scratchHome.refuseEntry(import.meta.url);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
export const agentRows=p=>p.locator('[data-testid^="settings-agent-row-"]');
export async function agentConnector(p,id='openclaw') {
 const select=p.locator('#settings-agent-runtime');
 const options=await select.locator('option').evaluateAll(rows=>rows.map(row=>row.value));
 const target=options.includes(id)?id:await p.evaluate(async()=>{
  const {readSettings}=await import('/settings-api.js');
  const vm=await readSettings();return vm.agents.find(agent=>agent.configured)?.runtime||vm.runtimes.find(runtime=>runtime.supported)?.id;
 });
 if(await select.inputValue()!==target)await select.selectOption(target);
 try { await p.waitForFunction(id=>new URL(location.href).searchParams.get('connecteur')===id,target); }
 catch { throw new Error(`connector query mismatch: wanted ${target}, got ${new URL(p.url()).searchParams.get('connecteur')}, selector ${await select.inputValue()}`); }
 return target;
}
export async function agentRow(p,id){const index=await agentRows(p).evaluateAll((rows,id)=>rows.findIndex(r=>r.querySelector('dd')?.textContent===id),id);assert.ok(index>=0,id+' roster row');return agentRows(p).nth(index);}
export async function agentAction(p,row,action){
 if(action==='primary' && await row.locator('.ao-settings__role').count())return;
 await row.getByRole('button',{name:/^Actions/}).click();
 await p.getByRole('menuitem',{name:{rename:/^(Renommer|Rename)$/,primary:/^(Définir comme principal|Set as primary)$/,hide:/^(Masquer dans le bureau|Hide in the office)$/,show:/^(Afficher dans le bureau|Show in the office)$/,remove:/^(Retirer|Remove)$/}[action]}).click();
}
export async function agentEditor(p,row){if(!await row.locator('input[id^=settings-agent-name-]').count())await agentAction(p,row,'rename');return row;}
