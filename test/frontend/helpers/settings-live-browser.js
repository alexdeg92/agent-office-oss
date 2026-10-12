import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { browserPath } from './layout-browser.js';
import scratchHome from '../../helpers/scratch-home.cjs';
scratchHome.refuseEntry(import.meta.url);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
const require=createRequire(import.meta.url);
const {settingsFixture}=require('../../helpers/settings-fixture');
const {createFrontendServer}=require('../../../scripts/serve-frontend');
export const skip=!browserPath();
export const save=p=>p.locator('.ao-settings__footer button[type=submit], [data-testid=settings-integration-apply]');
export const tab=async(p,id)=>{if(id==='integrations'){await p.evaluate(async()=>{const {services}=await import('/services.js?v='+document.querySelector('meta[name=ao-build]').content);services.router.setQuery({onglet:'integrations',connecteur:null,runtime:null,section:null});});await p.waitForFunction(()=>new URL(location.href).searchParams.get('onglet')==='connexion'&&new URL(location.href).searchParams.get('section')==='integrations');await p.locator('#settings-tab-connexion[aria-selected=true]').waitFor();return;}await p.locator('#settings-tab-'+id).click();await p.locator('#settings-tab-'+id+'[aria-selected=true]').waitFor();};
// No enabled save: the footer may be absent while the tab has nothing pending.
export const cannotSave=async page=>(await save(page).count())===0||!(await save(page).isEnabled());
// Since T-0074 (7ff11dc2) the Connexion tab is a gallery of provider cards; a connector's form lives on its focused
// page. Open it from the card (no-op when that page is already open).
export const openConnector=async(p,provider)=>{
  if(await p.locator('[data-connector-back]').count()&&await p.locator(`[data-provider="${provider}"]`).count()===0)return;
  await p.locator(`[data-provider="${provider}"]`).click();await p.locator('[data-connector-back]').waitFor();
};
export const idle=p=>p.waitForFunction(()=>document.querySelector('#settings-section-form')?.getAttribute('aria-busy')==='false');
export async function openLive(options={}) {
  let frontend,h,browser;
  const server=createServer((req,res)=>{
    if (!frontend) { res.writeHead(503);res.end();return; }
    frontend.emit('request',req,res);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  const close=async()=>{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await h?.close();};
  try {
    h=await (options.fixtureFactory || settingsFixture)({...options,publicUrl:origin});
    const connect=base=>{frontend=createFrontendServer({root:fileURLToPath(new URL('../../../public/v2',import.meta.url)),apiBase:'/backend',apiVersion:2,apiProxy:base});};
    connect(h.base); h.onBoot=connect;
    browser=await chromium.launch({executablePath:browserPath(),headless:true,args:['--no-sandbox','--disable-background-networking']});
    const context=await browser.newContext();
    const split=h.cookie.indexOf('=');
    await context.addCookies([{name:h.cookie.slice(0,split),value:h.cookie.slice(split+1),url:origin,httpOnly:true,sameSite:'Lax'}]);
    await context.addInitScript(()=>{localStorage.setItem('ao.locale','fr');localStorage.setItem('ao.uiTheme','light');});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    const page=await context.newPage();page.setDefaultTimeout(10000);
    const errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',e=>{if(e.type()==='error'&&e.text().startsWith('[vm]'))errors.push(e.text());});
    page.on('request',r=>{if(new URL(r.url()).pathname.includes('/settings'))requests.push({path:new URL(r.url()).pathname,method:r.method()});});
    await page.goto(origin+'/parametres',{waitUntil:'domcontentloaded'});
    await page.locator('#settings-section-form').waitFor();
    return {page,h,origin,requests,close:async()=>{await close();assert.deepEqual(errors,[],'live responses and browser execution are valid');}};
  } catch(e){await close();throw e;}
}
export const confirm=async(p,password)=>{
  await p.locator('#settings-current-password').fill(password);
  await p.locator('button[form=settings-reauth-form]').click();
  await p.locator('#settings-current-password').waitFor({state:'hidden'});await idle(p);
};

export async function reloadSettings(b, id) {
  const response=b.page.waitForResponse(r=>r.request().method()==='GET' && new URL(r.url()).pathname.endsWith('/api/v3/settings'));
  await b.page.reload({waitUntil:'domcontentloaded'}); await response;
  await b.page.locator('#settings-section-form').waitFor(); if(id) await tab(b.page,id);
  const session=(await b.page.context().cookies(b.origin)).find(c=>c.name===b.h.cookie.split('=')[0]);
  if(session)b.h.cookie=session.name+'='+session.value;
  const result=await b.h.get('/api/v3/settings'); assert.equal(result.status,200); return result.json.data;
}
export async function applyPlan(b,action='install') {
  const p=b.page; await tab(p,'integrations'); await p.locator('#settings-integration-action').selectOption(action);
  await p.locator('#settings-plan').click(); await p.locator('#settings-plan-confirm').waitFor();
  await p.locator('#settings-plan-confirm').check(); await save(p).click();
  await p.waitForFunction(()=>document.querySelector('#settings-current-password') || document.querySelector('#settings-section-form')?.getAttribute('aria-busy')==='false');
  if(await p.locator('#settings-current-password').count()) await confirm(p,b.h.password);
  await idle(p);
}
