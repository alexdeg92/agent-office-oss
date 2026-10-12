'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {launch,findChrome}=require('./helpers/browser');
let browser;
before(async()=>{if(findChrome())browser=await launch();});
after(async()=>{await browser?.close();});
test('shared accessories fit every installed model, four views and day/night; final native sheet', {skip:!findChrome(),timeout:180000},async()=>{
  const p=await browser.page('/public/v2/office/demo.html');
  await p.waitFor('document.readyState==="complete"');
  const result=await p.eval(`
    const A=await import('/public/v2/office/assets.js'),L=await import('/public/v2/office/accessory-pack-loader.js'),C=await import('/public/v2/office/character-pack-loader.js');
    const manifest=await (await fetch('/design/office/manifest.example.json')).json(),index=A.indexManifest(manifest),base='/design/';
    await C.ensureCharacterPacks(index,[...index.characters.keys()],base);
    const pack=await (await fetch('/design/assets/Accessories/accessories-1/manifest.json')).json();
    window.__acc={A,L,index,base,pack};
    const issues=[],samples=[],counts={looks:0,registrations:0,visible:0};
    const image=async src=>{const im=new Image();im.src=A.resolveUrl(src,base);await im.decode();return im;};
    const canvas=document.createElement('canvas');canvas.width=192;canvas.height=288;const ctx=canvas.getContext('2d');
    for(const ch of index.characters.values()) for(const variant of ch.variants?.length?ch.variants:[{id:null}]) {
      counts.looks++;
      for(const pose of ['idle','walking-se','walking-ne','walking-nw','working-ne','thinking','life-phone-sw','egg-wipe-sw']) {
        const body=A.poseImage(ch,variant.id,pose),key=ch.id+(variant.id?'/'+variant.id:''),records=pack.fits[key]?.[body.pose];
        if(!records){issues.push('missing '+key+'/'+body.pose);continue;}
        for(const item of pack.items) for(const mode of ['day','night']) {
          const look={character:ch.id,variant:variant.id,accessories:[item.id]};
          await L.prepareAccessoryLayers(index,look,body.pose,base,{mode});
          const layers=A.accessoryLayers(index,ch.id,[item.id],body.pose,variant.id,{legacy:false,mode});
          const paths=[...layers.back,...layers.front];counts.registrations+=records.length;
          if(item.fit.hideRear&&records[0][0]>1){if(paths.length)issues.push('rear ornament '+item.id);continue;}
          let pixels=0;
          for(const layer of paths) {
            const img=await image(layer.path);if(img.width!==192||img.height!==288)issues.push('canvas '+key+'/'+item.id);
            ctx.clearRect(0,0,192,288);ctx.drawImage(img,0,0);const data=ctx.getImageData(0,0,192,288).data;
            for(let i=3;i<data.length;i+=4)if(data[i]>20)pixels++;
            if(body.frames&&layer.frames?.length!==body.frames.length)issues.push('typing alignment '+key+'/'+item.id);
          }
          if(pixels<3)issues.push('blank '+key+'/'+body.pose+'/'+item.id+'/'+mode);else counts.visible++;
        }
      }
    }
    document.body.replaceChildren();document.body.style.cssText='margin:0;background:#ece8dd;font:12px sans-serif;color:#27303a';
    const title=document.createElement('h1');title.textContent='Accessoires — jour / nuit · échelle bureau 1×';title.style.margin='20px';document.body.append(title);
    const models=[...index.characters.values()];
    for(const mode of ['day','night']) {
      const section=document.createElement('section');section.style.cssText='display:grid;width:max-content;grid-template-columns:repeat(14,96px);gap:4px;padding:12px;background:'+ (mode==='day'?'#ece8dd':'#202938')+';color:'+ (mode==='day'?'#27303a':'#edf0f5');
      for(const ch of models){const h=document.createElement('div');h.textContent=ch.names?.fr??ch.label;h.style.textAlign='center';section.append(h);}
      for(const item of pack.items) for(const ch of models) {
        const variant=ch.variants?.[0]?.id??null,look={character:ch.id,variant,accessories:[item.id]},body=A.poseImage(ch,variant,'idle');
        await L.prepareAccessoryLayers(index,look,body.pose,base,{mode});const layers=A.accessoryLayers(index,ch.id,[item.id],body.pose,variant,{legacy:false,mode});
        const cell=document.createElement('div'),c=document.createElement('canvas');c.width=192;c.height=288;c.style.cssText='width:96px;height:144px';const cx=c.getContext('2d');
        for(const src of [...layers.back.map(a=>a.path),body.path,...layers.front.map(a=>a.path)])cx.drawImage(await image(src),0,0);
        const label=document.createElement('div');label.textContent=item.names.fr;label.style.cssText='text-align:center;font-size:10px';cell.append(c,label);section.append(cell);
      }
      document.body.append(section);
    }
    return {issues,counts,height:document.documentElement.scrollHeight,width:document.documentElement.scrollWidth};
  `);
  const dir=path.join(__dirname,'../../design/reports/accessories-02');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'fitting-matrix.json'),JSON.stringify(result,null,2)+'\n');
  fs.writeFileSync(path.join(dir,'style-day-night-native.png'),await p.screenshot({x:0,y:0,width:result.width,height:result.height}));
  assert.equal(result.counts.looks,41);assert.deepEqual(result.issues,[]);
  await p.close();
});
test('scene keeps the current look across delayed gear, night changes and cache eviction; debug landmarks stay lazy', {skip:!findChrome(),timeout:120000},async()=>{
  const p=await browser.page('/test/office/harness.html');await p.waitFor('window.H?.ready');
  const result=await p.eval(`
    const A=await import('/public/v2/office/assets.js'),L=await import('/public/v2/office/accessory-pack-loader.js');
    const realFetch=window.fetch;let held=false;const releases=[];
    window.fetch=(url,...args)=>/beanie-(sw|se|ne|nw)-day.webp/.test(String(url))?new Promise(resolve=>{held=true;releases.push(()=>resolve(realFetch(url,...args)));}):realFetch(url,...args);
    const sc=new H.OfficeScene(stage,{manifest:H.manifest,layout:H.layout,assetBase:H.assetBase,theme:'day',life:{intervalMs:600000}});sc.setReducedMotion(true);
    let look={character:'bastion',variant:'slate',accessories:['beanie']};
    const push=()=>sc.setOccupants([{id:'main',role:'main',sourceName:'Agent',state:'idle',stateSince:Date.now(),stationUid:'st-timmy',look}]);push();
    await H.until(()=>held);const c=sc.chars.get('main');await H.until(()=>c.displayed===c.poseEl);
    const loadingBody=!!c.displayed.querySelector('[data-layer=body]')?.naturalWidth;
    look={...look,accessories:['wizard-hat']};push();
    const visible=mode=>{const acc=A.accessoryLayers(sc.index,look.character,look.accessories,c.renderedPose,look.variant,{mode});return acc.front.length>0 && c.displayed===c.poseEl && [...acc.back,...acc.front].every(a=>[...c.displayed.querySelectorAll('img')].some(i=>i.src===a.path));};
    await H.until(()=>visible('day'));const current=c.displayed;for(const release of releases)release();window.fetch=realFetch;
    await H.sleep(100);const staleHeld=current===c.displayed && c.occ.look.accessories[0]==='wizard-hat';
    sc.setTheme('night');await H.until(()=>visible('night'));
    for(const ch of sc.index.characters.values())for(const v of ch.variants?.length?ch.variants:[{id:null}])for(const item of sc.index.accessories.values())if(item.packManifest)
      await L.prepareAccessoryLayers(sc.index,{character:ch.id,variant:v.id,accessories:[item.id]},'idle',H.assetBase);
    const cacheEvicted=!sc.index.accessories.get('wizard-hat').layers['bastion/slate']?.[c.renderedPose]?.modes?.night;
    sc._renderPose(c);await H.until(()=>visible('night'));
    sc.setDebugLandmarks(true);await H.until(()=>c.displayed.querySelector('svg.ao-landmarks'));
    const debug=true;sc.destroy();return {loadingBody,staleHeld,cacheEvicted,debug};
  `);
  assert.deepEqual(result,{loadingBody:true,staleHeld:true,cacheEvicted:true,debug:true});await p.close();
});
test('break-room gestures keep aligned accessory layers and switch to night while paused', {skip:!findChrome(),timeout:120000},async()=>{
  const p=await browser.page('/test/office/harness.html');await p.waitFor('window.H?.ready');
  const result=await p.eval(`
    const A=await import('/public/v2/office/assets.js'),B=await import('/public/v2/office/break-room.js');
    const sc=new H.OfficeScene(stage,{manifest:H.manifest,layout:H.layout,assetBase:H.assetBase,theme:'day',life:{intervalMs:600000}});sc.setReducedMotion(true);
    const look={character:'bastion',variant:'slate',accessories:['beanie','bandana','monocle']};
    sc.setOccupants([{id:'main',role:'main',sourceName:'Agent',state:'idle',stateSince:Date.now(),stationUid:'st-timmy',look}]);await H.until(()=>sc.chars.get('main')?.ch.packLoaded);
    const c=sc.chars.get('main'),actor=await B.createBreakRoom(sc,c,'gym');
    await actor.setPose('egg-wipe-sw');const ready=mode=>{
      const layers=A.accessoryLayers(sc.index,look.character,look.accessories,actor.pose.pose,look.variant,{mode});
      return layers.front.length>0 && [...layers.back,...layers.front].every(a=>[...actor.body.querySelectorAll('img')].some(i=>i.src===a.path&&i.naturalWidth===192));
    };
    const day=ready('day');sc.setTheme('night');actor.tick(performance.now());await H.until(()=>ready('night'));
    const night=actor.root.dataset.theme==='night';actor.destroy();sc.destroy();return {day,night};
  `);
  assert.deepEqual(result,{day:true,night:true});await p.close();
});
