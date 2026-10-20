import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,readdir} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {openLayoutBrowser,browserSkipReason,visit} from './helpers/layout-browser.js';
import {assertOverlayLayout,overlayRegistry,overlaySourceRegistry,overlayComponentRegistry} from './helpers/overlay-layout.js';
import {cleanupAfterTest} from './helpers/test-cleanup.js';

const require=createRequire(import.meta.url),{chatV3UiFixture}=require('../helpers/chat-v3-ui-fixture.cjs'),{projectTeamFixture}=require('../helpers/project-team-fixture.cjs');
const appRouteRegistry=[
  ['Bureau','/bureau','.ao-bureau'],['Discuter','/discuter?chat-plein=1','.ao-messenger__workspace'],
  ['Flux de travail','/flux','.ao-flows'],['Projets','/projets','[data-card]'],['Habilitations','/habilitations','.ao-access'],
  ['Journaux','/journaux','.ao-logs'],['Compétences','/competences','.ao-skills'],['Santé','/sante','.ao-health__cards'],
  ['Boutique','/boutique?onglet=personnages','.ao-shop__savebar'],['Paramètres','/parametres','#settings-section-form'],['Plus','/plus','.bu-morelist'],
];
const triggerRegistry=Object.freeze({
  menu:{selector:'[aria-haspopup="menu"]',overlay:'[role="menu"]',kind:'menu'},
  listbox:{selector:'[aria-haspopup="listbox"]',overlay:'[role="listbox"]',kind:'listbox'},
  floorSheet:{selector:'.ao-floor-mobile-trigger[aria-haspopup="dialog"]',overlay:'[role="dialog"]',kind:'dialog'},
  preview:{selector:'.bu-control-popover__trigger[aria-haspopup="dialog"]',overlay:'[role="tooltip"][popover]',kind:'popover',activation:'hover'},
});

async function visitAppRoute(page,origin,[name,path,ready]){
  await visit(page,origin,path,ready);
  assert.equal(new URL(page.url()).pathname,new URL(path,origin).pathname,`${name} route must load before overlay discovery`);
}

async function openAndAudit(page,trigger,descriptor,context){
  assert.ok(await trigger.isVisible(),`${context}: registered trigger must be visible`);
  if(descriptor.activation==='hover')await trigger.hover();
  else await trigger.click();
  const expected=page.locator(descriptor.overlay);
  await expected.waitFor({state:'visible'});
  await assertOverlayLayout(page,context,[descriptor.kind]);
  await page.keyboard.press('Escape');
  await expected.waitFor({state:'hidden'});
}

async function discoverRouteOverlays(page,origin,width){
  for(const route of appRouteRegistry){
    await visitAppRoute(page,origin,route);
    const live=await page.evaluate(()=>[...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open],[role="menu"],[role="listbox"],[role="tooltip"][popover],[popover]:popover-open')].some(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0;}));
    if(live)await assertOverlayLayout(page,`${route[0]} initial overlay`);
    for(const [key,descriptor] of Object.entries(triggerRegistry)){
      if(key==='floorSheet'&&width!==390)continue;
      if(key==='preview'&&width===390)continue;
      const triggers=page.locator(descriptor.selector),count=await triggers.count();
      for(let i=0;i<count;i++){
        const trigger=triggers.nth(i);if(!await trigger.isVisible())continue;
        await openAndAudit(page,trigger,descriptor,`${route[0]} ${key} trigger ${i}`);
      }
    }
    const unknown=page.locator('[aria-haspopup="dialog"]:not(.bu-control-popover__trigger):not(.ao-floor-mobile-trigger)');
    assert.equal(await unknown.count(),0,`${route[0]} has an unregistered dialog trigger`);
  }
}

async function sourceFiles(root){
  const out=[];
  async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()&&entry.name.endsWith('.js'))out.push(file);}}
  await walk(root);return out;
}

for(const width of [390,1440])for(const theme of ['light','dark'])test(`registered overlay layouts stay inside every ${width}px ${theme} app route`,{skip:browserSkipReason(),timeout:300000},async t=>{
  let browser,chatBrowser,fixture;
  let activeTestError;
  try{
    browser=await openLayoutBrowser({theme,touch:width===390});
    const height=width===390?844:900,page=browser.page;await page.setViewportSize({width,height});
    await discoverRouteOverlays(page,browser.origin,width);

    // Project mentions are the app's listbox popover. Opening it through the
    // real composer proves the registered listbox kind is measurable.
    await visit(page,browser.origin,'/projets/prj_portail','.ao-project');
    const mention=page.locator('#project-comment');await mention.waitFor({state:'visible'});await mention.fill('@');
    const mentions=page.locator('[role="listbox"]');await mentions.waitFor({state:'visible'});
    await assertOverlayLayout(page,`project mention listbox ${width}px ${theme}`,['listbox']);
    await mention.press('Escape');await mentions.waitFor({state:'hidden'});

    // Existing gallery controls provide deterministic examples without
    // changing the approved Design System page or its pixel baseline.
    await visit(page,browser.origin,'/design-system?mock=1','[data-design-system-gallery]');
    await page.getByRole('tab',{name:'Actions',exact:true}).click();
    const menuTrigger=page.getByRole('button',{name:'Autres actions',exact:true});
    await openAndAudit(page,menuTrigger,triggerRegistry.menu,`design-system menu ${width}px ${theme}`);
    await page.getByRole('button',{name:'Ouvrir la confirmation',exact:true}).click();
    await assertOverlayLayout(page,`design-system confirmation ${width}px ${theme}`,['dialog']);
    await page.keyboard.press('Escape');await page.locator('[role="dialog"]').waitFor({state:'hidden'});
    await browser.close();browser=null;

    // PreviewButton belongs to the team project detail, not the Design System
    // gallery. Mount its real route with a synthetic backend VM and open each
    // provider/people preview that is visible at this viewport.
    let teamFixture,teamBrowser,teamTestError;
    try{
      teamBrowser=await openLayoutBrowser({theme,touch:width===390,apiVersion:3,apiProxy:async publicUrl=>{teamFixture=await projectTeamFixture({publicUrl});return teamFixture.base;}});
      try{
        const teamPage=teamBrowser.page;await teamPage.setViewportSize({width,height});
        const split=teamFixture.cookie.indexOf('=');await teamPage.context().addCookies([{name:teamFixture.cookie.slice(0,split),value:teamFixture.cookie.slice(split+1),url:teamBrowser.origin,httpOnly:true,sameSite:'Lax'}]);
        await teamPage.goto(`${teamBrowser.origin}/projets/${encodeURIComponent(teamFixture.projectId)}`,{waitUntil:'domcontentloaded'});
        await teamPage.locator('.ao-team-project').waitFor({state:'visible'});
        const previews=teamPage.locator(triggerRegistry.preview.selector),count=await previews.count();
        assert.ok(count>0,'team project must expose a registered PreviewButton');
        for(let i=0;i<count;i++){
          if(width===390){
            await previews.nth(i).click();const dialog=teamPage.locator('[role="dialog"]');await dialog.waitFor({state:'visible'});
            await assertOverlayLayout(teamPage,`team project mobile detail sheet ${i} ${theme}`,['dialog']);
            await teamPage.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
          }else await openAndAudit(teamPage,previews.nth(i),triggerRegistry.preview,`team project preview ${i} ${width}px ${theme}`);
        }
      }catch(error){teamTestError={error};throw error;}
      finally{await cleanupAfterTest(teamTestError,[()=>teamBrowser?.close()],'overlay team browser');}
    }catch(error){teamTestError={error};throw error;}
    finally{await cleanupAfterTest(teamTestError,[()=>teamFixture?.close()],'overlay team fixture');}

    // T-0238's queued send-now dialog is exercised against the mounted v3
    // producer at the same viewport/theme as the route sweep.
    chatBrowser=await openLayoutBrowser({theme,touch:width===390,apiVersion:3,apiProxy:async publicUrl=>{fixture=await chatV3UiFixture({publicUrl,historyCount:0,paneQueueCapture:true});return fixture.base;}});
    const chatPage=chatBrowser.page;await chatPage.setViewportSize({width,height});
    const split=fixture.cookie.indexOf('=');await chatPage.context().addCookies([{name:fixture.cookie.slice(0,split),value:fixture.cookie.slice(split+1),url:chatBrowser.origin,httpOnly:true,sameSite:'Lax'}]);
    await chatPage.goto(chatBrowser.origin+'/discuter',{waitUntil:'domcontentloaded'});
    const target=chatPage.locator(`[data-chat-agent="${fixture.targetId}"]`);await target.waitFor({state:'visible'});await target.click();
    const fresh=chatPage.getByRole('button',{name:'Nouvelle discussion'});await fresh.waitFor({state:'visible'});await fresh.click();
    await chatPage.locator('#chat-texte').fill('Peux-tu vérifier la dernière version ?');await chatPage.locator('.ao-chat__send').click();
    const queued=chatPage.locator('[data-queue-state="queued"]');await queued.waitFor({state:'visible'});
    await openAndAudit(chatPage,queued.locator('[data-queue-send-now]'),{overlay:'.ao-chat__send-now-modal',kind:'dialog'},`T-0238 send-now ${width}px ${theme}`);
    assert.deepEqual(await chatPage.evaluate(()=>window.__AO_VM_ISSUES||[]),[]);
  }catch(error){activeTestError={error};throw error;}
  finally{await cleanupAfterTest(activeTestError,[()=>browser?.close(),()=>chatBrowser?.close(),()=>fixture?.close()],`overlay layout ${width}px ${theme}`);}
});

test('overlay source meta-registry covers every app file that defines or composes an overlay',async()=>{
  assert.deepEqual(appRouteRegistry.map(([name])=>name),['Bureau','Discuter','Flux de travail','Projets','Habilitations','Journaux','Compétences','Santé','Boutique','Paramètres','Plus']);
  assert.deepEqual(overlayRegistry.map(item=>item.id),['dialog','menu','listbox','popover']);
  assert.deepEqual(Object.keys(triggerRegistry).sort(),['floorSheet','listbox','menu','preview']);
  const root='public/v2',registered=new Set(overlaySourceRegistry),found=[];
  for(const file of await sourceFiles(root)){
    const source=await readFile(file,'utf8');
    if(/\brole\s*=\s*["'](?:dialog|alertdialog|menu|listbox)["']|\bpopover\s*=|<\s*dialog\b|<\$\{(?:Modal|ConfirmDialog|BottomSheet)\b|export\s+function\s+(?:Modal|ConfirmDialog|BottomSheet|Menu|PreviewButton)\b/.test(source))found.push(relative(root,file).replaceAll('\\','/'));
  }
  assert.ok(found.length>0,'source discovery must find app overlay code');
  assert.deepEqual(found.filter(file=>!registered.has(file)),[],`overlay source files need registry entries: ${found.filter(file=>!registered.has(file)).join(', ')}`);
  assert.ok(overlaySourceRegistry.includes('components/modal.js'),'Modal component is registered');
  assert.ok(overlaySourceRegistry.includes('components/bureau/confirm-dialog.js'),'ConfirmDialog component is registered');
  assert.ok(overlaySourceRegistry.includes('components/bureau/menu.js'),'Menu component is registered');
  assert.ok(overlaySourceRegistry.includes('components/bureau/popover.js'),'popover component is registered');
  assert.deepEqual(overlayComponentRegistry.map(item=>item.component),['Modal','ConfirmDialog','BottomSheet','Menu','PreviewButton']);
  for(const item of overlayComponentRegistry)assert.ok(overlaySourceRegistry.includes(item.source),`${item.component} source must be covered`);
  assert.equal(overlayComponentRegistry.find(item=>item.component==='BottomSheet').rendering,'responsive Modal sheet');
});
