import test from 'node:test';
import assert from 'node:assert/strict';
import {openLive,skip,tab,save,confirm,idle} from './helpers/settings-live-browser.js';
import {realisticOptions} from './helpers/settings-real-home.js';

async function deferredRestart(boundary,completion='success') {
 const b=await openLive({...realisticOptions,supervisor:{supported:true,command:null,reason:null,restart(){throw Error('deferred fixture never reaches the supervisor');}}});
 const p=b.page;
 try {
  await tab(p,'instance');await p.locator('#settings-network-port').fill('18801');await save(p).click();await confirm(p,b.h.password);await idle(p);
  // Expire the confirmation only for the reauth-boundary case, before reloading the VM.
  if(boundary==='reauth'){b.h.clock.elapsed+=300000;await p.reload();await p.locator('#settings-section-form').waitFor();await tab(p,'instance');}
  const meta=(await b.h.get('/api/v2/meta')).json.data;
  await p.evaluate(async({boundary,completion,meta})=>{
   const build=document.querySelector('meta[name=ao-build]').content;
   const {Component,options}=await import('preact');
   const dead=new WeakSet(),priorUnmount=options.unmount,priorState=Component.prototype.setState;
   const s=window.restartBoundary={metadata:0,posts:0,reauth:0,lateTimers:0,stateUpdates:0,unmounted:false,settle:null,signal:null};
   options.unmount=v=>{if(v.__c && ['SettingsPage','ReauthDialog'].includes(v.type?.name))dead.add(v.__c);priorUnmount?.(v);};
   Component.prototype.setState=function(...args){if(dead.has(this))s.stateUpdates++;return priorState.apply(this,args);};
   const originalFetch=window.fetch.bind(window),originalTimer=window.setTimeout.bind(window);
   window.setTimeout=(fn,ms,...args)=>{if(s.unmounted && ms===1000)s.lateTimers++;return originalTimer(fn,ms,...args);};
   const response=data=>new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json'}});
   const defer=(value,signal)=>new Promise((resolve,reject)=>{
    s.signal=signal;s.settle=()=>completion==='network' ? reject(new TypeError('simulated lost response')) : resolve(response(value));
   });
   // Deliberately allow deferred fetches to resolve after abort, so continuation guards are exercised too.
   window.fetch=(input,opts={})=>{
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    if(url.pathname.endsWith('/api/v2/meta') && opts.cache==='no-store'){
     s.metadata++;
     if(boundary==='metadata' && s.metadata===1 || boundary==='poll' && s.metadata===2)return defer({...meta,bootId:'before'},opts.signal);
     return Promise.resolve(response({...meta,bootId:s.metadata===1?'before':'after'}));
    }
    if(url.pathname.endsWith('/settings/restart') && opts.method==='POST'){
     s.posts++;const data={ok:true,revision:1,result:{accepted:true,bootId:'before'},vm:null};
     return boundary==='post' ? defer(data,opts.signal) : Promise.resolve(response(data));
    }
    if(url.pathname.endsWith('/settings/reauth') && opts.method==='POST' && boundary==='reauth'){
     s.reauth++;return defer({ok:true,result:{expiresAt:new Date(Date.now()+300000).toISOString()},vm:null},opts.signal);
    }
    return originalFetch(input,opts);
   };
   s.unmount=async()=>{const {render}=await import('/lib.js?v='+build);render(null,document.getElementById('app'));};
  },{boundary,completion,meta});
  await p.getByRole('button',{name:'Redémarrer Agent Office',exact:true}).first().click();
  await p.locator('[role=dialog]').getByRole('button',{name:'Redémarrer',exact:true}).click();
  if(boundary==='reauth'){await p.locator('#settings-current-password').fill(b.h.password);await p.locator('button[form=settings-reauth-form]').click();}
  await p.waitForFunction(()=>typeof window.restartBoundary.settle==='function');
  const before=await p.evaluate(()=>({metadata:restartBoundary.metadata,posts:restartBoundary.posts}));
  let navigations=0;p.on('framenavigated',()=>navigations++);
  await p.evaluate(()=>restartBoundary.unmount());
  await p.locator('#app:empty').waitFor();
  // Preact may defer passive-effect cleanup to its next paint.
  await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,50)))));
  const result=await p.evaluate(async()=>{
   const s=restartBoundary;s.unmounted=true;const aborted=s.signal?.aborted ?? null;s.settle();
   await new Promise(r=>setTimeout(r,100));
   return {metadata:s.metadata,posts:s.posts,lateTimers:s.lateTimers,stateUpdates:s.stateUpdates,aborted};
  });
  assert.equal(result.posts,before.posts,'teardown must prevent any new restart POST');
  assert.equal(result.metadata,before.metadata,'late completion must not create new polling');
  assert.equal(result.lateTimers,0,'teardown must prevent new polling timers');
  assert.equal(result.stateUpdates,0,'dead Settings/dialog components must not update state');
  assert.equal(navigations,0,'late completion must not reload the page');
  if(boundary==='metadata' || boundary==='poll')assert.equal(result.aborted,true,'operation signal is retained before the deferred request and aborted on teardown');
 }finally{await b.close();}
}

test('mounted restart teardown during initial metadata prevents a late POST',{skip,timeout:30000},()=>deferredRestart('metadata'));
test('mounted restart teardown during POST success cannot start a new poll',{skip,timeout:30000},()=>deferredRestart('post'));
test('mounted restart teardown during lost POST response cannot start a new poll',{skip,timeout:30000},()=>deferredRestart('post','network'));
test('mounted restart teardown aborts an active poll before late metadata completion',{skip,timeout:30000},()=>deferredRestart('poll'));
test('mounted restart teardown during reauthentication prevents work and dead dialog updates',{skip,timeout:30000},()=>deferredRestart('reauth'));
