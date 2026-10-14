// Presentation checkpoint based on the committed T-0136 contract; mounted producer integration follows its backend checkpoint.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),s=require('../../src/schema');
const {VM_SCHEMAS}=require('../../src/api/v2/vm/schemas');
const {LABELS}=require('../../src/i18n/fr');
const example=JSON.parse(readFileSync(new URL('../../docs/architecture/examples/v3/chat-vm.json',import.meta.url))).data;
const resultTemplate=example.messages.find(m=>m.kind==='subagent-result');
const messageTemplate=example.messages.find(m=>m.kind==='message');
import {openLayoutBrowser,browserSkipReason,visit} from './helpers/layout-browser.js';
const now=Date.UTC(2026,9,13,16,0);
const sender=(id,name)=>({id,name,kind:'agent',runtime:'demo',channel:null,avatarHint:null});
const text='**Vérifications terminées**\n\n| Contrôle | Résultat détaillé |\n| --- | --- |\n| Accueil | Parcours accessible sur téléphone et ordinateur |\n| Formulaire | Confirmation vérifiée après envoi |';
const messages=[
 {...messageTemplate,id:'lead',kind:'message',role:'assistant',at:now-120000,text:'Deux sous-agents ont vérifié le parcours. Voici leurs résultats.',body:{text:'Deux sous-agents ont vérifié le parcours. Voici leurs résultats.'},meta:null,senderInfo:sender('lead','Atlas'),avatar:{character:'subagent',variant:'sage',accessories:[]}},
 {...resultTemplate,id:'child-a',kind:'subagent-result',role:'assistant',at:now-60000,title:'Vérifier le parcours d’accueil',status:'completed',statusLabel:{key:'chat.result.status.completed'},collapsedByDefault:true,text,body:{text},meta:null,senderInfo:sender('child-a','Mira'),avatar:{character:'fen',variant:'clay',accessories:[]}},
 {...resultTemplate,id:'child-b',kind:'subagent-result',role:'assistant',at:now,title:'Tester la confirmation mobile',status:'failed',statusLabel:{key:'chat.result.status.failed'},collapsedByDefault:true,text:'Le service de démonstration n’a pas répondu. **Aucune publication.**',body:{text:'Le service de démonstration n’a pas répondu. **Aucune publication.**'},meta:null,senderInfo:sender('child-b','Noor'),avatar:{character:'bastion',variant:'slate',accessories:[]}}
];
for(const width of [1440,390])for(const theme of ['light','dark'])test(`supplied child cards and Office portraits ${width} ${theme}`,{skip:browserSkipReason(),timeout:60000},async()=>{
 let b;
 assert.deepEqual(s.validate(VM_SCHEMAS.chat,{...example,messages}).issues,[]);
 try{
  b=await openLayoutBrowser({theme,touch:width===390,apiVersion:3});const {page,origin}=b,errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width,height:width===390?844:900});await visit(page,origin,'/discuter','.ao-chat__messages');
  await page.evaluate(async ({messages,now,labels})=>{
   const {buildQuery}=await import('/config.js');const {h,render}=await import('/lib.js'+buildQuery);const {ChatMessage}=await import('/components/chat-message.js'+buildQuery);const {setMeta}=await import('/i18n.js'+buildQuery);
   setMeta({apiVersion:3,locale:'fr',labels,primaryAgent:{name:'Atlas'}});
   const root=document.createElement('ol');root.className='ao-chat__messages';document.querySelector('.ao-chat__messages').replaceWith(root);
   render(messages.map(m=>h('li',{class:'ao-chat__msg ao-chat__msg--'+m.role,key:m.id},h(ChatMessage,{m,now}))),root);
  },{messages,now,labels:LABELS});
  await page.waitForFunction(()=>document.querySelectorAll('.ao-chat__messages [data-avatar-ready="true"]').length===3);
  assert.equal(await page.locator('.ao-chat__messages .bu-msg--user').count(),0,'child output is never a human bubble');
  const cards=page.locator('.ao-chat__result-card');assert.equal(await cards.count(),2);assert.equal(await cards.evaluateAll(els=>els.every(el=>!el.open)),true);
  assert.deepEqual(await page.locator('.ao-chat__messages .bu-msg__who').allTextContents(),['Atlas','Mira','Noor']);
  assert.ok((await cards.nth(0).locator('summary').innerText()).includes('Terminé'));assert.ok((await cards.nth(1).locator('summary').innerText()).includes('Échec'));
  const images=await page.locator('.ao-chat__messages [data-avatar-ready="true"] img').evaluateAll(els=>els.map(el=>({src:el.src,visible:getComputedStyle(el).visibility,width:el.naturalWidth})));
  assert.equal(new Set(images.map(i=>i.src)).size,3);assert.ok(images.every(i=>i.visible==='visible'&&i.width>0));
  await mkdir('design/reports/chat-results',{recursive:true});
  assert.equal(await page.evaluate(()=>document.scrollingElement.scrollHeight),await page.evaluate(()=>innerHeight));
  await page.screenshot({path:`design/reports/chat-results/${width}-${theme}-collapsed.png`,animations:'disabled'});
  await cards.nth(0).locator('summary').click();assert.equal(await cards.nth(0).evaluate(el=>el.open),true);assert.equal(await cards.nth(1).evaluate(el=>el.open),false);
  const table=cards.nth(0).locator('.ao-md__table-scroll');await table.scrollIntoViewIfNeeded();assert.equal(await table.locator('th').count(),2);assert.equal(await table.locator('tbody tr').count(),2);assert.equal(await cards.nth(0).locator('strong').innerText(),'Vérifications terminées');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(await page.evaluate(()=>document.scrollingElement.scrollHeight),await page.evaluate(()=>innerHeight));
  await page.screenshot({path:`design/reports/chat-results/${width}-${theme}-expanded.png`,animations:'disabled'});
  assert.deepEqual(errors,[]);
 }finally{await b?.close();}
});
