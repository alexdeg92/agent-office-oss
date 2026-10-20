import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { browserSkipReason, openLayoutBrowser } from './helpers/layout-browser.js';

const skip=browserSkipReason();
async function fixture(page,origin) {
  const body=await readFile(new URL('./fixtures/bureau-rows.html',import.meta.url),'utf8');
  await page.route('**/__bureau-rows.html',route=>route.fulfill({contentType:'text/html',body}));
  await page.goto(`${origin}/__bureau-rows.html`,{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'Actions pour Atlas',exact:true}).waitFor();
  await page.evaluate(()=>document.fonts.ready);
}
const active=locator=>locator.evaluate(e=>e===document.activeElement);

test('SettingRow and ListRow: label association, readable environment, zero/false values, independent actions', {skip,timeout:15000}, async()=>{
  const b=await openLayoutBrowser({testTimeoutMs:15000});
  try{
    await fixture(b.page,b.origin);
    const input=b.page.getByLabel('Port',{exact:true});assert.equal(await input.inputValue(),'18789');
    assert.equal(await input.getAttribute('aria-describedby'),'port-row-description');
    assert.equal(await b.page.getByText("Défini par l'environnement : OC_GATEWAY_URL",{exact:false}).count(),1);
    assert.equal(await b.page.locator('.bu-list-row').count(),2);
    assert.equal(await b.page.locator('.bu-list-row').first().evaluate(e=>e.tagName),'LI');
    assert.equal(await b.page.locator('.bu-list-row button').first().evaluate(e=>!!e.closest('[role=button]')),false);
    assert.equal(await b.page.getByRole('button',{name:'Copier Tentatives',exact:true}).count(),1,'zero is data');
    assert.equal(await b.page.locator('dl').filter({hasText:'Désactivé'}).locator('dd').innerText(),'false');
    assert.equal(await b.page.locator('dl').filter({hasText:'Adresse publique'}).locator('dd').innerText(),'Non renseigné');
    assert.equal(await b.page.locator('.bu-list-row--muted').evaluate(e=>getComputedStyle(e).opacity),'1');
    await b.page.evaluate(()=>{window.bureauRows.setLang('en');window.bureauRows.draw();});
    assert.equal(await b.page.getByRole('button',{name:'Copy Tentatives',exact:true}).count(),1);
    assert.ok((await b.page.locator('.bu-setting-row').nth(1).innerText()).includes('Set by the environment: OC_GATEWAY_URL'));
  }finally{await b.close();}
});

test('Menu: arrows, disabled reason, typeahead, Escape/outside dismissal and focus after row removal', {skip,timeout:20000},async()=>{
  const b=await openLayoutBrowser({testTimeoutMs:20000});const p=b.page;
  try{
    await fixture(p,b.origin);const trigger=p.getByRole('button',{name:'Actions pour Atlas',exact:true});
    await trigger.focus();await p.keyboard.press('ArrowDown');
    assert.equal(await active(p.getByRole('menuitem',{name:'Modifier le nom',exact:true})),true);
    await p.keyboard.press('ArrowDown');assert.equal(await active(p.getByRole('menuitem',{name:'Masquer',exact:true})),true);
    await p.keyboard.press('ArrowDown');
    const disabled=p.getByRole('menuitem',{name:'Définir comme principal Choisissez un autre agent visible.',exact:true});
    assert.equal(await active(disabled),true);assert.equal(await disabled.getAttribute('aria-disabled'),'true');
    await p.keyboard.press('Enter');assert.deepEqual(await p.evaluate(()=>window.bureauRows.state.calls),[]);
    await p.keyboard.press('End');assert.equal(await active(p.getByRole('menuitem',{name:'Retirer du bureau',exact:true})),true);
    await p.keyboard.press('m');assert.equal(await active(p.getByRole('menuitem',{name:'Modifier le nom',exact:true})),true);
    await p.keyboard.press('m');assert.equal(await active(p.getByRole('menuitem',{name:'Masquer',exact:true})),true);
    await p.keyboard.press('Home');await p.keyboard.press('Enter');
    assert.deepEqual(await p.evaluate(()=>window.bureauRows.state.calls),['rename']);assert.equal(await active(trigger),true);
    await p.keyboard.press('ArrowUp');assert.equal(await active(p.getByRole('menuitem',{name:'Retirer du bureau',exact:true})),true);
    await p.keyboard.press('Escape');assert.equal(await p.getByRole('menu').count(),0);assert.equal(await active(trigger),true);
    await p.keyboard.press('ArrowDown');await p.keyboard.press('Space');
    assert.deepEqual(await p.evaluate(()=>window.bureauRows.state.calls),['rename','rename']);
    await trigger.click();await p.keyboard.press('Tab');
    await p.waitForFunction(()=>!document.querySelector('[role=menu]'));
    assert.equal(await active(p.getByRole('button',{name:'Actions pour Scout',exact:true})),true,'Tab exits to next control');
    await trigger.click();await p.getByRole('heading',{name:'Runtimes et agents'}).click();assert.equal(await p.getByRole('menu').count(),0);
    await trigger.click();const link=p.getByRole('menuitem',{name:'Changer l’apparence',exact:true});
    assert.equal(await link.evaluate(e=>e.tagName),'A');assert.equal(await link.getAttribute('href'),'#appearance');
    await p.getByRole('menuitem',{name:'Retirer du bureau',exact:true}).click();
    await p.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Actions pour Scout');
    assert.equal(await trigger.count(),0);assert.deepEqual(await p.evaluate(()=>window.bureauRows.state.calls),['rename','rename','remove']);
  }finally{await b.close();}
});

test('KeyValue: real clipboard success, truthful failure, changed-value and unmount completion guards', {skip,timeout:20000},async()=>{
  const b=await openLayoutBrowser({testTimeoutMs:20000});const p=b.page;
  try{
    await p.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:b.origin});await fixture(p,b.origin);
    const copy=p.getByRole('button',{name:'Copier Adresse',exact:true});await copy.click();
    await p.getByRole('status').filter({hasText:'Copié'}).waitFor();
    assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),await p.evaluate(()=>window.bureauRows.state.value));
    await p.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied');}}}));
    await copy.click();await p.getByRole('alert').waitFor();
    assert.equal(await p.getByRole('status').count(),0);assert.ok((await p.getByRole('alert').innerText()).includes('Sélectionnez'));
    assert.equal(await p.locator('#gateway-key .bu-key-value__value').evaluate(e=>getComputedStyle(e).userSelect),'text');
    await p.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>{window.copyCalls=(window.copyCalls||0)+1;return new Promise(resolve=>window.finishCopy=resolve);}}}));
    await copy.evaluate(e=>{e.click();e.click();});assert.equal(await copy.getAttribute('aria-busy'),'true');
    assert.equal(await p.evaluate(()=>window.copyCalls),1,'synchronous repeated activation starts only one copy');
    await p.evaluate(()=>{window.bureauRows.state.value='https://changed.example.test';window.bureauRows.draw();window.finishCopy();});
    assert.equal(await p.getByRole('status').count(),0,'old result cannot label a new value copied');
    await copy.click();await p.evaluate(()=>{window.bureauRows.state.hideValue=true;window.bureauRows.draw();window.finishCopy();});
    assert.equal(await p.locator('#gateway-key').count(),0);assert.equal(await p.getByRole('alert').count(),0);
  }finally{await b.close();}
});

test('Menu: touch activation escapes paint containment at both mobile sizes', {skip,timeout:15000},async()=>{
  const b=await openLayoutBrowser({touch:true,testTimeoutMs:15000}); const p=b.page;
  try{
    await fixture(p,b.origin);
    for(const [width,height]of[[390,844],[375,667]]){
      await p.setViewportSize({width,height});
      const trigger=p.getByRole('button',{name:'Actions pour Atlas',exact:true});
      await trigger.locator('..').evaluate(e=>e.style.contain='paint');
      await trigger.tap();
      assert.equal(await p.getByRole('menu').evaluate(e=>e.matches(':popover-open')),true);
      const action=p.getByRole('menuitem',{name:'Masquer',exact:true});
      assert.equal(await action.evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'panel remains hit-testable beyond contained trigger');
      await action.tap();
      assert.equal(await p.getByRole('menu').count(),0);
    }
    assert.deepEqual(await p.evaluate(()=>window.bureauRows.state.calls),['hide','hide']);
  }finally{await b.close();}
});

test('rows/Menu: current Bureau responsive surface and constrained popover evidence', {skip,timeout:30000},async()=>{
  const b=await openLayoutBrowser({touch:true,testTimeoutMs:30000});const p=b.page,records=[];
  const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  try{
    await fixture(p,b.origin);await p.emulateMedia({reducedMotion:'reduce'});
    for(const [width,height]of[[1440,900],[390,844],[375,667]])for(const theme of ['light','dark']){
      await p.setViewportSize({width,height});await p.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      for(const scenario of ['rows','menu','copying','copied','error']){
        await p.evaluate(()=>{window.bureauRows.state.value='https://api.example.test/office/installation/instance-a-very-long-path-with-no-breaks';window.bureauRows.draw();});
        await p.locator('#fixture').evaluate(e=>e.scrollTop=0);
        if(scenario==='menu')await p.getByRole('button',{name:'Actions pour Atlas',exact:true}).click();
        if(['copying','copied','error'].includes(scenario)){
          await p.evaluate(scenario=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>scenario==='copying'?new Promise(()=>{}):scenario==='error'?Promise.reject(Error('denied')):Promise.resolve()}}),scenario);
          await p.getByRole('button',{name:'Copier Adresse',exact:true}).click();
          if(scenario==='copied')await p.getByRole('status').waitFor();
          if(scenario==='error')await p.getByRole('alert').waitFor();
          await p.locator('#gateway-key').scrollIntoViewIfNeeded();
        }
        await p.evaluate(()=>Promise.all([...document.images].map(image=>image.decode())));
        const geometry=await p.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,menu:document.querySelector('[role=menu]')?.getBoundingClientRect().toJSON(),separator:document.querySelector('[role=separator]')?.getBoundingClientRect().toJSON(),controls:[...document.querySelectorAll('button,input,a[role=menuitem]')].filter(e=>e.getClientRects().length).map(e=>e.getBoundingClientRect().toJSON()),port:document.querySelector('#port-row-control').getBoundingClientRect().toJSON()}));
        assert.ok(geometry.width<=width&&geometry.height<=height);
        assert.ok(geometry.controls.every(e=>e.height>=(width<821?44:40)));
        assert.equal(geometry.port.width,96);
        if(scenario==='copying')assert.equal(await p.getByRole('button',{name:'Copier Adresse',exact:true}).getAttribute('aria-busy'),'true');
        if(geometry.menu){assert.ok(geometry.menu.left>=15&&geometry.menu.right<=width-15&&geometry.menu.top>=15&&geometry.menu.bottom<=height-15);assert.ok(geometry.separator.width>geometry.menu.width-12);}
        if(process.env.BUREAU_SCREENSHOTS==='1'){
          const filename=`${scenario}-${width}-${theme}.png`;await mkdir('design/reports/bureau-components-checkpoint-2',{recursive:true});
          await p.screenshot({path:`design/reports/bureau-components-checkpoint-2/${filename}`});records.push({filename,revision,width,height,theme,scenario,geometry});
        }
        if(scenario==='menu')await p.keyboard.press('Escape');
        // A new value invalidates any pending clipboard result before the next synthetic case.
        await p.evaluate(()=>{window.bureauRows.state.value='https://next.example.test';window.bureauRows.draw();});
      }
    }
    if(records.length)await writeFile('design/reports/bureau-components-checkpoint-2/captures.json',JSON.stringify(records,null,2)+'\n');
  }finally{await b.close();}
});
