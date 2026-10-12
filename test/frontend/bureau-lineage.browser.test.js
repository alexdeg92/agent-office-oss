import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {openLayoutBrowser,visit,browserSkipReason} from './helpers/layout-browser.js';
// T-0062: canonical lineage on the Bureau (?mock=lignee: two spawned sub-agents and a DM of the main agent, all with
// parentId). Mobile stacks the spawned agents under their spawner (T-0061 roster); the DM stays a conversation.
// Captures for review: design/reports/agent-lineage-2/<view>-<width>-<theme>.png (desktop 1440, mobile 390 and 375; light, dark).
const skip=browserSkipReason();
const OUT='design/reports/agent-lineage-2';
test('lineage: spawned agents stack under their spawner on mobile; desktop and mobile captures, light and dark',{skip,timeout:120000},async()=>{
  await mkdir(OUT,{recursive:true});
  for(const theme of ['light','dark'])for(const [view,width,height,touch] of [['mobile',390,844,true],['mobile',375,667,true],['desktop',1440,900,false]]){
    const h=await openLayoutBrowser({theme,touch}),p=h.page,errors=[];p.on('pageerror',e=>errors.push(e.message));
    try{
      await p.setViewportSize({width,height});await visit(p,h.origin,'/bureau?mock=lignee','.ao-bureau__stage');
      if(view==='mobile'){
        await p.locator('.ao-mobile-group').first().waitFor();
        const group=await p.locator('.ao-mobile-group .ao-mobile-parent').first().textContent();
        assert.match(group,/2/,'the main agent heads a team of two spawned sub-agents: '+group);
        assert.equal(await p.locator('.ao-mobile-group').count(),1,'one team: the DM is not a spawned member');
      } else {
        await p.locator('.ao-roster__child').first().waitFor();
        const rows=await p.evaluate(()=>[...document.querySelectorAll('.ao-bureau__roster > li')].map(li=>({name:li.querySelector('.ao-roster__name')?.textContent,
          child:li.classList.contains('ao-roster__child'),by:getComputedStyle(li.querySelector('.bu-cell-main'),'::after').content})));
        assert.deepEqual(rows.map(r=>r.child),[false,true,true,false],'spawned agents follow their spawner, indented; the DM is not: '+JSON.stringify(rows));
        for(const r of rows.filter(r=>r.child)) assert.equal(r.by,`"Lancé par ${rows[0].name}"`);
        assert.equal(rows[3].by,'none','no spawn caption for a conversation');
      }
      await p.evaluate(async()=>{await document.fonts.ready;});
      await p.screenshot({path:`${OUT}/${view}-${width}-${theme}.png`});
      assert.deepEqual(errors,[]);
    } finally { await h.close(); }
  }
});
