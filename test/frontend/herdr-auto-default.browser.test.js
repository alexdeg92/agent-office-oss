import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {openLive,skip,tab,idle,save,confirm} from './helpers/settings-live-browser.js';
const require=createRequire(import.meta.url);
const {settingsFixture}=require('../helpers/settings-fixture');
const {createConfiguredOrchestrators}=require('../../src/sources/configured-orchestrators');

test('source auto activation refreshes an untouched toggle during another runtime draft without saving an implicit OFF',{skip,timeout:45000},async()=>{
 let responding=false,at=Date.parse('2026-10-12T00:00:00Z'),source;
 const fixtureFactory=options=>settingsFixture({...options,effectiveV3:true,orchestratorTeams:({tmp})=>{
  source=createConfiguredOrchestrators({env:{HOME:tmp,PATH:''},binaryPath:'/fixture/bin/herdr',now:()=>at,
    run:async()=>{if(!responding)throw Error('synthetic unavailable');return {stdout:Buffer.from('{"id":"fixture","result":{"type":"ok","agents":[]}}')};}});
  return source;
 }});
 const b=await openLive({fixtureFactory}),p=b.page;
 try{
  await tab(p,'connexion');await p.locator('[data-provider="openclaw"]').click();
  await p.locator('[data-runtime-connection] input[id^="settings-label-"]').fill('Synthetic runtime name');
  await p.locator('[data-connector-back]').click();await p.locator('[data-provider="herdr"]').click();
  assert.equal(await p.locator('#settings-enabled-herdr').isChecked(),false,'presence without a response stays off');
  responding=true;at+=2000;await source.refresh();
  await p.getByTestId('settings-herdr-test').click();await idle(p);
  assert.equal(await p.locator('#settings-enabled-herdr').isChecked(),true,'fresh source state updates only the untouched toggle');
  const response=p.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname.endsWith('/settings/runtimes'));
  await save(p).click();await p.locator('#settings-current-password').waitFor();await confirm(p,b.h.password);
  const saved=await response;assert.equal(saved.status(),200,JSON.stringify(await saved.json()));
  assert.equal(Object.hasOwn(saved.request().postDataJSON(),'herdrEnabled'),false,'the unrelated runtime save preserves automatic source preference');
  const config=JSON.parse(readFileSync(b.h.paths.file,'utf8'));assert.equal(config.sources?.herdr,undefined);
  assert.equal(source.sourceEnabled,true);
  await p.locator('[data-connector-back]').click();await p.locator('[data-provider="openclaw"]').click();
  assert.equal(await p.locator('[data-runtime-connection] input[id^="settings-label-"]').inputValue(),'Synthetic runtime name');
 }finally{await b.close();}
});
