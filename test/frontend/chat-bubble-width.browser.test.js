import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openLayoutBrowser,browserSkipReason,visit} from './helpers/layout-browser.js';
// T-0230: bubbles size to their text up to the sender cap (85% phone, 70% desktop); inner caps must not compound.
const long='Boil them, mash them, stick them in a stew, then tell me again how little I am because this sentence is long enough to wrap.';
for(const [width,cap] of [[390,0.85],[1440,0.70]])test(`chat bubbles use the full sender cap ${width}`,{skip:browserSkipReason(),timeout:60000},async()=>{
 let b;
 try{
  b=await openLayoutBrowser({touch:width===390,apiVersion:3});const {page,origin}=b;
  await page.setViewportSize({width,height:width===390?844:900});await visit(page,origin,'/discuter','.ao-chat__messages');
  const m=await page.evaluate(({long})=>{
   const set=(side,text)=>{const group=[...document.querySelectorAll('.ao-chat__message-group--'+side)].find(g=>g.querySelector('.bu-msg__bubble'));if(!group)throw new Error('no '+side+' text bubble in the mock thread');group.querySelector('.ao-chat-attachment-strip')?.remove();const bubble=group.querySelector('.bu-msg__bubble');bubble.textContent=text;return group;};
   const measure=(group)=>{const bubble=group.querySelector('.bu-msg__bubble'),style=getComputedStyle(bubble),list=group.closest('.ao-chat__messages');
    const g=group.getBoundingClientRect(),r=bubble.getBoundingClientRect();const range=document.createRange();range.selectNodeContents(bubble);const hug=range.getBoundingClientRect().width+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+parseFloat(style.borderLeftWidth)+parseFloat(style.borderRightWidth);return {group:g.width,bubble:r.width,hug,indent:parseFloat(style.marginLeft),column:list.getBoundingClientRect().width,
     lines:Math.round((bubble.getBoundingClientRect().height-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)-parseFloat(style.borderTopWidth)-parseFloat(style.borderBottomWidth))/parseFloat(style.lineHeight))};};
   const user=set('user','Little Atlas'),shortUser=measure(user);
   user.querySelector('.bu-msg__bubble').textContent=long;const longUser=measure(user);
   const agent=set('agent',long),longAgent=measure(agent);
   agent.querySelector('.bu-msg__bubble').textContent='😎';const meta=agent.querySelector('.bu-msg__meta');if(meta)meta.textContent='14:21 · gpt-6-astra · 2.3 s · 19,009 tokens';const shortAgent=measure(agent);
   return {shortUser,longUser,longAgent,shortAgent};
  },{long});
  assert.equal(m.shortUser.lines,1,'short user message stays on one line: '+JSON.stringify(m.shortUser));
  assert.equal(m.shortAgent.lines,1,'short agent message stays on one line: '+JSON.stringify(m.shortAgent));
  for(const k of ['shortAgent','shortUser'])assert.ok(m[k].bubble<=m[k].hug+2,`${k} bubble hugs its text instead of stretching to the head width: `+JSON.stringify(m[k]));
  for(const k of ['longUser','longAgent']){const r=m[k];
   assert.ok(Math.abs(r.group-r.column*cap)<=2,`${k} group reaches the ${cap*100}% cap: `+JSON.stringify(r));
   assert.ok(r.bubble+r.indent>=r.group-2,`${k} bubble fills its sender group (minus the desktop avatar indent): `+JSON.stringify(r));}
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal page scroll');
 }finally{await b?.close?.();}
});
