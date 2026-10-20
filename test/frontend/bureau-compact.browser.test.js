import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { browserSkipReason, openLayoutBrowser } from './helpers/layout-browser.js';

const skip=browserSkipReason();
async function fixture(page,origin){
  const body=await readFile(new URL('./fixtures/bureau-compact.html',import.meta.url),'utf8');
  await page.route('**/__bureau-compact.html',route=>route.fulfill({contentType:'text/html',body}));
  await page.goto(`${origin}/__bureau-compact.html`,{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'Configurer : Claude Code',exact:true}).waitFor();
  await page.evaluate(()=>document.fonts.ready);
}
const active=locator=>locator.evaluate(e=>document.activeElement===e);

test('compact Diagnostics: severity shapes and localized names, independent text action, native link', {skip,timeout:15000},async()=>{
  const b=await openLayoutBrowser({testTimeoutMs:15000});const p=b.page;
  try{
    await fixture(p,b.origin);
    for(const name of ['Erreur','À vérifier','Information','Non vérifié'])assert.equal(await p.getByRole('img',{name,exact:true}).count(),1);
    const glyphs=await p.locator('.bu-list-row__icon svg use').evaluateAll(es=>es.map(e=>e.getAttribute('href')));
    assert.deepEqual(glyphs.slice(0,4),['#i-error','#i-warning','#i-info','#i-search']);
    assert.equal(new Set(glyphs.slice(0,4)).size,4,'unknown/info do not look healthy');
    const row=p.locator('.bu-list-row').first();await row.locator('.bu-list-row__title').click();
    assert.deepEqual(await p.evaluate(()=>window.bureauCompact.state.calls),[],'title does not activate a fix');
    const action=p.getByRole('button',{name:'Configurer : Claude Code',exact:true});
    assert.equal(await action.innerText(),'Configurer');assert.equal(await action.locator('use').getAttribute('href'),'#i-chevron-right');
    await action.focus();await p.keyboard.press('Enter');
    assert.deepEqual(await p.evaluate(()=>window.bureauCompact.state.calls),['configure']);
    const link=p.getByRole('link',{name:'Installer : OpenClaw',exact:true});
    assert.equal(await link.evaluate(e=>e.tagName),'A');assert.equal(await link.getAttribute('href'),'#install');
    assert.equal(await p.locator('.bu-list-row').nth(2).locator('button,a').count(),0,'informational evidence has no action');
    await p.evaluate(()=>{window.bureauCompact.state.english=true;window.bureauCompact.setLang('en');window.bureauCompact.draw();});
    for(const name of ['Error','Needs attention','Information','Not checked'])assert.equal(await p.getByRole('img',{name,exact:true}).count(),1);
    assert.equal(await p.getByRole('button',{name:'Configure: Claude Code',exact:true}).count(),1);
  }finally{await b.close();}
});

test('TextAction: stable name and focus during pending, repeat suppression, linked error and disabled state', {skip,timeout:15000},async()=>{
  const b=await openLayoutBrowser({testTimeoutMs:15000});const p=b.page;
  try{
    await fixture(p,b.origin);const action=p.getByRole('button',{name:'Configurer : Claude Code',exact:true});
    await action.focus();await p.evaluate(()=>{window.bureauCompact.state.busy=true;window.bureauCompact.draw();});
    assert.equal(await active(action),true);assert.equal(await action.getAttribute('aria-busy'),'true');
    assert.equal(await action.innerText(),'Configurer','visible action and accessible name remain stable');
    assert.equal(await action.locator('.bu-compact-progress').count(),1);
    await p.keyboard.press('Space');await action.evaluate(e=>{e.click();e.click();});
    assert.deepEqual(await p.evaluate(()=>window.bureauCompact.state.calls),[]);
    await p.evaluate(()=>{Object.assign(window.bureauCompact.state,{busy:false,error:'Échec. Réessayez.'});window.bureauCompact.draw();});
    assert.equal(await action.getAttribute('aria-describedby'),'configure-error');
    assert.equal(await p.getByRole('alert').innerText(),'Échec. Réessayez.');
    await p.keyboard.press('Space');assert.deepEqual(await p.evaluate(()=>window.bureauCompact.state.calls),['configure']);
    await p.evaluate(()=>{Object.assign(window.bureauCompact.state,{error:null,disabled:true});window.bureauCompact.draw();});
    assert.equal(await action.isDisabled(),true);assert.equal(await p.getByRole('alert').count(),0);
    assert.equal(await action.getAttribute('aria-describedby'),null);
  }finally{await b.close();}
});

test('CollapsedGroup: closed evidence, native keyboard/touch disclosure, focus and count updates', {skip,timeout:15000},async()=>{
  const b=await openLayoutBrowser({touch:true,testTimeoutMs:15000});const p=b.page;
  try{
    await fixture(p,b.origin);const summary=p.locator('#healthy-group>summary');
    assert.equal(await p.locator('#empty-group').count(),0);
    assert.equal(await p.locator('#healthy-group').getAttribute('open'),null);
    assert.equal(await p.getByRole('img',{name:'En ordre',exact:true}).count(),0);
    assert.equal(await summary.locator('button,a,input').count(),0);
    await summary.focus();await p.keyboard.press('Space');
    await p.waitForFunction(()=>document.querySelector('#healthy-group').open);
    assert.equal(await active(summary),true);assert.equal(await p.getByRole('img',{name:'En ordre',exact:true}).count(),3);
    await p.evaluate(()=>{window.bureauCompact.state.groupLabel='4 éléments en ordre';window.bureauCompact.draw();});
    assert.equal(await active(summary),true);assert.equal(await summary.innerText(),'4 éléments en ordre');
    assert.equal(await p.locator('#healthy-group').evaluate(e=>e.open),true,'label/count updates preserve expansion');
    await p.keyboard.press('Enter');await p.waitForFunction(()=>!document.querySelector('#healthy-group').open);
    assert.equal(await active(summary),true);
    await p.setViewportSize({width:375,height:667});await summary.tap();
    await p.waitForFunction(()=>document.querySelector('#healthy-group').open);
    assert.equal(await summary.evaluate(e=>e.getBoundingClientRect().height>=44),true);
  }finally{await b.close();}
});

test('compact shared rows: native light/dark viewport matrix, focus and pending/error/long-label evidence', {skip,timeout:45000},async()=>{
  const b=await openLayoutBrowser({testTimeoutMs:45000});const p=b.page,records=[];
  const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  try{
    await fixture(p,b.origin);await p.emulateMedia({reducedMotion:'reduce'});
    for(const [width,height]of[[1440,900],[390,844],[375,667]])for(const theme of ['light','dark'])for(const scenario of ['closed','open','focus','busy','error','long-en']){
      await p.setViewportSize({width,height});
      await p.evaluate(({theme,scenario})=>{
        document.documentElement.dataset.theme=theme;
        const state=window.bureauCompact.state;
        Object.assign(state,{busy:scenario==='busy',error:scenario==='error'?'Échec. Réessayez.':null,disabled:false,long:scenario==='long-en',english:scenario==='long-en',groupLabel:null});
        window.bureauCompact.setLang(state.english?'en':'fr');window.bureauCompact.draw();
      },{theme,scenario});
      await p.locator('[data-scroll-body]').evaluate(e=>e.scrollTop=0);
      const group=p.locator('#healthy-group'), summary=p.locator('#healthy-group>summary');
      if(await group.evaluate(e=>e.open))await summary.click();
      if(scenario==='open')await summary.click();
      if(scenario==='focus'){
        await p.locator('#configure').focus();await p.keyboard.press('Tab');await p.keyboard.press('Shift+Tab');
      }else await p.evaluate(()=>document.activeElement.blur());
      await p.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=='running'||a.effect.getComputedTiming().iterations===Infinity));
      const geometry=await p.evaluate(()=>({
        root:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},
        controls:[...document.querySelectorAll('button,a[href],summary')].filter(e=>e.getClientRects().length).map(e=>({label:e.getAttribute('aria-label')||e.textContent.trim(),...e.getBoundingClientRect().toJSON()})),
        rows:[...document.querySelectorAll('.bu-list-row')].filter(e=>e.getClientRects().length).map(e=>({radius:getComputedStyle(e).borderRadius,shadow:getComputedStyle(e).boxShadow,...e.getBoundingClientRect().toJSON()})),
        focus:getComputedStyle(document.querySelector('#configure')).outlineStyle,
        open:document.querySelector('#healthy-group').open,
      }));
      assert.ok(geometry.root.width<=width&&geometry.root.height<=height);
      assert.ok(geometry.controls.every(r=>r.height>=(width<=820?44:40)&&r.left>=0&&r.right<=width),'compact native targets fit');
      assert.ok(geometry.rows.every(r=>r.radius==='0px'&&r.shadow==='none'&&r.left>=0&&r.right<=width),'one flat list');
      assert.equal(geometry.open,scenario==='open');
      if(scenario==='focus')assert.equal(geometry.focus,'solid');
      if(process.env.BUREAU_SCREENSHOTS==='1'){
        const dir='design/reports/bureau-components-checkpoint-3',filename=`compact-${width}-${theme}-${scenario}.png`;
        await mkdir(dir,{recursive:true});await p.screenshot({path:`${dir}/${filename}`});records.push({filename,revision,width,height,theme,scenario,geometry});
      }
    }
    if(records.length)await writeFile('design/reports/bureau-components-checkpoint-3/captures.json',JSON.stringify(records,null,2)+'\n');
  }finally{await b.close();}
});
