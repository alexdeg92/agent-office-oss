import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {openLive,skip,save,cannotSave,tab,idle,reloadSettings} from './helpers/settings-live-browser.js';
const require=createRequire(import.meta.url);
const {startServer,TEST_EMAIL,TEST_PASSWORD}=require('../helpers/harness');
const {loadScenario}=require('../helpers/scenario');
const {openStore}=require('../../src/store');
const {hashPassword}=require('../../src/security/password');
const IC=require('../../src/instance-config');
// Fresh worktrees lack gitignored Bureau assets. Render the exact source build, independent of cwd.
before(()=>{if(!skip)require('../../scripts/build-frontend').buildFrontend(fileURLToPath(new URL('../../',import.meta.url)));});
const confirmed=(action,target,name,body)=>({...body,confirmation:{action,target,name,revision:body.expectedRevision,changes:Object.fromEntries(Object.entries(body).filter(([key])=>key!=='expectedRevision'))}});
async function fixture({publicUrl}) {
  const h=await startServer(loadScenario('foreign-instance'),{loginEnv:false,demo:true,env:{AO_API_ONLY:'1',AO_PUBLIC_URL:publicUrl},prepare:async home=>{
    const store=openStore({dir:path.join(home,'data'),instance:'test',ownerName:'Synthetic admin',log:()=>{}});
    try {store.users.createOwner({email:TEST_EMAIL,personId:store.owner.id,passwordHash:await hashPassword(TEST_PASSWORD)});}finally{store.close();}
    IC.writeInstanceConfig(IC.configPaths({HOME:home}),{version:2,auth:{rbacEnabled:true},instance:{name:'Synthetic office',locale:'fr',timeZone:'UTC'},owner:{displayName:'Synthetic admin',email:TEST_EMAIL,authSource:'database'},runtime:{adapter:'demo',demo:{seed:7}},agents:{primary:null,looks:{}}},{version:2,sessionSecret:'synthetic-rbac-browser-cookie-secret',runtimeToken:null});
  }});
  h.close=()=>h.stop();h.password=TEST_PASSWORD;h.email=TEST_EMAIL;
  h.put=(route,body)=>h.request('PUT',route,body);
  try {
    for(let n=0;n<3;n++) {
      const vm=(await h.get('/api/v3/settings')).json.data;
      const changed=await h.put('/api/v3/settings/instance',{expectedRevision:vm.revision,name:'Synthetic office '+n});assert.equal(changed.status,200,changed.text);
    }
    return h;
  }catch(error){await h.stop();throw error;}
}
const read=async b=>(await b.h.get('/api/v3/settings')).json.data;
const response=(p,suffix,method)=>p.waitForResponse(r=>new URL(r.url()).pathname.endsWith(suffix)&&r.request().method()===method);
async function authorize(p,password) {
  await p.locator('#settings-current-password').fill(password);
  const checked=response(p,'/settings/reauth','POST');
  await p.locator('button[form=settings-reauth-form]').click();assert.equal((await checked).status(),200);
}

test('operator-enabled real server: account/profile password saves use user revision while config revision stays independent',{skip,timeout:45000},async()=>{
  const b=await openLive({fixtureFactory:fixture}),p=b.page;const requests=[];
  p.on('request',r=>{if(/\/settings\/(owner|password)$/.test(new URL(r.url()).pathname))requests.push({path:new URL(r.url()).pathname,body:r.postDataJSON()});});
  try {
    const before=await read(b);assert.notEqual(before.revision,before.owner.revision);
    const config=fs.readFileSync(IC.configPaths({HOME:b.h.tmp}).file,'utf8');
    await tab(p,'compte');await p.locator('#settings-owner-displayName').fill('Synthetic renamed admin');
    const password='synthetic-replaced-password';await p.locator('#settings-password').fill(password);await p.locator('#settings-confirmation').fill(password);
    const profile=response(p,'/settings/owner','PUT'),passwordDenied=response(p,'/settings/password','POST');
    await save(p).click();await authorize(p,TEST_PASSWORD);assert.equal((await profile).status(),200);
    assert.equal((await passwordDenied).status(),403,'profile revision invalidates prior recent confirmation');
    const passwordSaved=response(p,'/settings/password','POST');await authorize(p,TEST_PASSWORD);assert.equal((await passwordSaved).status(),200);
    await idle(p);assert.equal(await p.locator('#settings-password').inputValue(),'');assert.equal((await save(p).count()>0&&await save(p).isEnabled()),false);
    const after=await reloadSettings(b,'compte');assert.equal(after.owner.displayName.value,'Synthetic renamed admin');
    assert.equal(after.revision,before.revision);assert.equal(after.owner.revision,before.owner.revision+2);
    assert.equal(fs.readFileSync(IC.configPaths({HOME:b.h.tmp}).file,'utf8'),config,'account changes never publish instance config');
    assert.equal(requests.filter(r=>r.path.endsWith('/owner')).length,1,'accepted profile is not replayed after reauthentication');
    assert.equal(requests[0].body.expectedRevision,before.owner.revision);
    assert.deepEqual(requests.filter(r=>r.path.endsWith('/password')).map(r=>r.body.expectedRevision),[before.owner.revision+1,before.owner.revision+1]);
    const login=await b.h.post('/api/login',{email:TEST_EMAIL,password});assert.equal(login.status,200);
    assert.ok(!(await p.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).includes(password));
    // A peer's account mutation must produce a visible conflict, preserve the local draft,
    // and offer an explicit reload without overwriting the accepted remote change.
    await p.locator('#settings-owner-displayName').fill('Synthetic local draft');
    assert.equal((await b.h.post('/api/v3/settings/reauth',{password})).status,200);
    const peer=await b.h.put('/api/v3/settings/owner',{expectedRevision:after.owner.revision,displayName:'Synthetic peer change'});assert.equal(peer.status,200,peer.text);
    const refused=response(p,'/settings/owner','PUT');await save(p).click();await authorize(p,password);assert.equal((await refused).status(),409);await idle(p);
    assert.equal(await p.locator('#settings-owner-displayName').inputValue(),'Synthetic local draft');
    await p.locator('.ao-settings [role=alert]').getByRole('button',{name:'Actualiser les paramètres',exact:true}).click();
    await p.locator('[role=dialog]').getByRole('button',{name:'Actualiser les paramètres',exact:true}).click();await idle(p);
    assert.equal(await p.locator('#settings-owner-displayName').inputValue(),'Synthetic peer change');assert.equal((await save(p).count()>0&&await save(p).isEnabled()),false);

  }finally{await b.close();}
});

test('operator-enabled admin invite: reader Settings withholds configuration, denies writes, and permits their own account',{skip,timeout:45000},async()=>{
  const b=await openLive({fixtureFactory:fixture}),p=b.page,adminCookie=b.h.cookie;
  try {
    assert.equal((await b.h.post('/api/v3/settings/reauth',{password:TEST_PASSWORD})).status,200);
    const body={expectedRevision:0,email:'synthetic-reader@example.invalid',name:'Synthetic reader',roleId:'rol_reader'};
    const issued=await b.h.post('/api/v3/users/invitations',confirmed('users.invite',body.email,body.name,body));assert.equal(issued.status,200,issued.text);
    b.h.cookie='';const password='synthetic-reader-password';
    assert.equal((await b.h.post('/api/auth/invitations/accept',{token:issued.json.data.result.token,password})).status,200);
    const login=await b.h.post('/api/login',{email:body.email,password});assert.equal(login.status,200);b.h.cookie=login.headers.get('set-cookie').split(';')[0];
    const split=b.h.cookie.indexOf('=');await p.context().clearCookies();await p.context().addCookies([{name:b.h.cookie.slice(0,split),value:b.h.cookie.slice(split+1),url:b.origin,httpOnly:true,sameSite:'Lax'}]);
    const reader=await reloadSettings(b,'instance');assert.equal(reader.instance,null);assert.equal(reader.network,null);assert.equal(reader.restart,null);
    assert.equal(await p.locator('#settings-instance-name').count(),0);assert.equal(await p.locator('#settings-network-port').count(),0);assert.equal((await save(p).count()>0&&await save(p).isEnabled()),false);
    assert.ok((await p.locator('.ao-settings').innerText()).includes('Votre rôle'));
    for(const id of ['agents','connexion','integrations']){await tab(p,id);assert.ok((await p.locator('.ao-settings').innerText()).includes('Votre rôle'));assert.equal((await save(p).count()>0&&await save(p).isEnabled()),false);}
    assert.equal((await b.h.put('/api/v3/settings/instance',{expectedRevision:reader.revision,name:'Forbidden'})).status,403);
    assert.equal((await b.h.post('/api/v3/gateway/restart')).status,403);assert.equal((await b.h.get('/api/v3/users')).status,403);
    const me=(await b.h.get('/api/v2/me')).json.data;assert.equal(me.user.roleId,'rol_reader');assert.equal(me.permissions.users,'none');
    await tab(p,'compte');assert.equal(await p.locator('#settings-owner-displayName').inputValue(),body.name);
    await p.locator('#settings-owner-displayName').fill('Synthetic reader renamed');const saved=response(p,'/settings/owner','PUT');
    await save(p).click();await authorize(p,password);assert.equal((await saved).status(),200);await idle(p);
    const after=await reloadSettings(b,'compte');assert.equal(after.owner.displayName.value,'Synthetic reader renamed');assert.equal(after.revision,reader.revision);
    const readerCookie=b.h.cookie;
    for(const resource of ['settings.instance','settings.network']) {
      b.h.cookie=adminCookie;
      const user=(await b.h.get('/api/v3/users/'+issued.json.data.result.user.id)).json.data;
      const changes={expectedRevision:user.revision,permissions:[{resource,level:'read'}]};
      const grant=await b.h.put('/api/v3/users/'+user.id+'/overrides',confirmed('users.overrides',user.id,user.name,changes));assert.equal(grant.status,200,grant.text);
      b.h.cookie=readerCookie;
      const partial=await reloadSettings(b,'instance');
      assert.equal(!!partial.instance,resource==='settings.instance');assert.equal(!!partial.network,resource==='settings.network');
      const visible=resource==='settings.instance'?'#settings-instance-name':'#settings-network-port';
      const hidden=resource==='settings.instance'?'#settings-network-port':'#settings-instance-name';
      assert.equal(await p.locator(hidden).count(),0);assert.equal(await p.locator(visible).isDisabled(),true);assert.equal((await save(p).count()>0&&await save(p).isEnabled()),false);
      assert.ok((await p.locator('.ao-settings').innerText()).includes('mais pas de les modifier'));
      for(const [width,height] of [[1440,900],[375,667]]) {
        await p.setViewportSize({width,height});
        const geometry=await p.evaluate(async()=>{
          await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          const frame=document.querySelector('.ao-settings'),footer=frame.querySelector('.ao-frame__foot'),notice=frame.querySelector('.ao-settings__banner');
          return {width:document.scrollingElement.scrollWidth,height:document.scrollingElement.scrollHeight,vw:innerWidth,vh:innerHeight,
            frameTop:frame.getBoundingClientRect().top,frameBottom:frame.getBoundingClientRect().bottom,footerBottom:(getComputedStyle(footer).display==='none'?frame.querySelector('.ao-frame__body'):footer).getBoundingClientRect().bottom,
            noticeInsideHead:!!notice&&notice.parentElement.classList.contains('ao-frame__head')};
        });
        assert.ok(geometry.width<=geometry.vw&&geometry.height<=geometry.vh,JSON.stringify(geometry));
        assert.ok(geometry.frameTop>=0&&geometry.frameBottom<=geometry.vh,JSON.stringify(geometry));
        // the save footer only exists while a tab has changes: an idle reader frame ends with its body, a dirty one with its footer
        assert.ok(Math.abs(geometry.frameBottom-geometry.footerBottom)<1,JSON.stringify(geometry));
        assert.equal(geometry.noticeInsideHead,true,'read-only notice occupies the bounded frame header');
        if(process.env.RBAC_SCREENSHOTS==='1') {
          fs.mkdirSync('design/reports/rbac-activation',{recursive:true});await p.screenshot({path:'design/reports/rbac-activation/'+resource+'-'+width+'.png',animations:'disabled'});
        }
      }
    }

  }finally{await b.close();}
});
