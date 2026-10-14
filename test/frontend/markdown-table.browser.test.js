import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,browserSkipReason,visit} from './helpers/layout-browser.js';
const source='**Résumé des vérifications**\n\n| Contrôle | Résultat détaillé | Référence |\n| :--- | :---: | ---: |\n| **Accueil** | Vérification complète sur téléphone et ordinateur | `validation-accueil-001` |\n| Navigation | <img src=x onerror=alert(1)> | [lien](javascript:bad) |\n| Export | Format conservé sans perte de données | `validation-export-002` |\n\n[réseau](//outside.example) [barre](/\\outside.example) [local](/projects) [web](https://outside.example) [courriel](mailto:operator@example.test)';
for(const width of [1440,390])for(const theme of ['light','dark'])test(`safe Markdown table stays inside Chat bubble ${width} ${theme}`,{skip:browserSkipReason(),timeout:60000},async()=>{
 let b;
 try{
  b=await openLayoutBrowser({theme,touch:width===390,apiVersion:3}); const {page,origin}=b,errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width,height:width===390?844:900});await visit(page,origin,'/discuter','.ao-chat__messages');
  await page.evaluate(async source=>{
   const {buildQuery}=await import('/config.js'); const {h,render}=await import('/lib.js'+buildQuery);const {Markdown}=await import('/components/markdown.js'+buildQuery);
   const bubbles=document.querySelectorAll('.bu-msg--agent .bu-msg__bubble');render(h(Markdown,{source}),bubbles[bubbles.length-1]);
  },source);
  const region=page.locator('.ao-md__table-scroll');await region.scrollIntoViewIfNeeded();
  assert.equal(await region.locator('th').count(),3);assert.equal(await region.locator('tbody tr').count(),3);assert.equal(await region.locator('strong').innerText(),'Accueil');
  assert.equal(await region.locator('img,script,a[href^="javascript:"]').count(),0);assert.ok((await region.innerText()).includes('<img src=x onerror=alert(1)>'));
  const prose=region.locator('xpath=..').locator('xpath=..');
  assert.equal(await prose.locator('a').evaluateAll(links=>links.some(link=>/^\/[\/\\]/.test(link.getAttribute('href')))),false);
  assert.equal(await prose.getByRole('link',{name:'local',exact:true}).getAttribute('href'),'/projects');
  for(const name of ['web','courriel']){const link=prose.getByRole('link',{name,exact:true});assert.equal(await link.getAttribute('target'),'_blank');assert.equal(await link.getAttribute('rel'),'noopener noreferrer');}
  assert.equal(await page.evaluate(()=>document.scrollingElement.scrollHeight),await page.evaluate(()=>innerHeight));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const bounds=await region.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth,overflow:getComputedStyle(el).overflowX}));assert.equal(bounds.overflow,'auto');
  if(width===390){assert.ok(bounds.scroll>bounds.client,'wide table scrolls within bubble');await region.focus();await page.keyboard.press('ArrowRight');await page.waitForTimeout(160);assert.ok(await region.evaluate(el=>el.scrollLeft>0),'keyboard scroll');await region.evaluate(el=>{el.scrollLeft=0;});}
  await mkdir('design/reports/chat-tables',{recursive:true});await page.screenshot({path:`design/reports/chat-tables/${width}-${theme}.png`,animations:'disabled'});assert.deepEqual(errors,[]);
 }finally{await b?.close();}
});
