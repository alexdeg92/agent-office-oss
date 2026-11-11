import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { browserSkipReason, openLayoutBrowser } from './helpers/layout-browser.js';

const require=createRequire(import.meta.url);
const {settingsFixture}=require('../helpers/settings-fixture');
const sharp=require('sharp');

test('T-0244 non-centred photo framing uploads the selected square', { skip: browserSkipReason(), timeout: 45000 }, async () => {
  let fixture;
  let browser;
  try {
    browser=await openLayoutBrowser({testTimeoutMs:45000,apiVersion:3,apiProxy:async publicUrl=>{
      fixture=await settingsFixture({publicUrl,effectiveV3:true});return fixture.base;
    }});
    const split=fixture.cookie.indexOf('=');
    await browser.page.context().addCookies([{name:fixture.cookie.slice(0,split),value:fixture.cookie.slice(split+1),url:browser.origin,httpOnly:true,sameSite:'Lax'}]);
    await browser.page.goto(browser.origin+'/parametres?onglet=compte',{waitUntil:'domcontentloaded'});
    await browser.page.locator('#settings-owner-displayName').waitFor();
    const result=await browser.page.evaluate(async()=>{
      const build=document.querySelector('meta[name="ao-build"]')?.content;
      const {avatarCropRect}=await import('/pages/settings-avatar.js?v='+encodeURIComponent(build||''));
      const image=document.createElement('canvas');image.width=100;image.height=50;
      const source=image.getContext('2d');source.fillStyle='#f00';source.fillRect(0,0,50,50);source.fillStyle='#00f';source.fillRect(50,0,50,50);
      const rect=avatarCropRect(image.width,image.height,1,{x:1,y:0});
      const output=document.createElement('canvas');output.width=32;output.height=32;
      output.getContext('2d').drawImage(image,rect.x,rect.y,rect.width,rect.height,0,0,32,32);
      return {rect,pixel:[...output.getContext('2d').getImageData(16,16,1,1).data]};
    });
    assert.deepEqual(result.rect,{x:50,y:0,width:50,height:50},'dragging to the right selects the right-hand square, not the image centre');
    assert.deepEqual(result.pixel,[0,0,255,255],'the uploaded crop contains the selected blue region');

    const page=browser.page;
    await page.getByRole('button',{name:'Importer une photo',exact:true}).click();
    await page.getByRole('dialog').getByRole('heading',{name:'Importer une photo'}).waitFor();
    const pixels=Buffer.alloc(100*50*3);
    for(let y=0;y<50;y++)for(let x=0;x<100;x++){
      const offset=(y*100+x)*3; pixels[offset]=x<50?255:0; pixels[offset+1]=0; pixels[offset+2]=x<50?0:255;
    }
    const photo=await sharp(pixels,{raw:{width:100,height:50,channels:3}}).png().toBuffer();
    await page.locator('.ao-account-avatar input[type=file]').setInputFiles({name:'synthetic-profile.png',mimeType:'image/png',buffer:photo});
    const crop=page.locator('.ao-avatar-crop__frame');
    await crop.waitFor();
    await page.waitForFunction(()=>{const image=document.querySelector('.ao-avatar-crop__frame img');return image?.complete&&image.naturalWidth===100;});
    const box=await crop.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.down();
    await page.mouse.move(box.x+box.width*.9,box.y+box.height/2,{steps:5});
    await page.mouse.up();
    await page.getByRole('button',{name:'Utiliser cette photo',exact:true}).click();
    await page.locator('.ao-avatar-crop__frame').waitFor({state:'detached'});
    const stagedPhoto=page.locator('.ao-account-avatar__row .ao-profile-avatar img');
    await stagedPhoto.waitFor();
    await page.waitForFunction(()=>{const image=document.querySelector('.ao-account-avatar__row .ao-profile-avatar img');return image?.complete&&image.naturalWidth>0;});
    const stagedPixel=await stagedPhoto.evaluate(image=>{
      const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;
      const context=canvas.getContext('2d');context.drawImage(image,0,0,16,16);
      return [...context.getImageData(8,8,1,1).data];
    });
    assert.ok(stagedPixel[2]>stagedPixel[0]*3,'the staged preview shows the right-hand crop selected in the editor');
    await page.getByRole('button',{name:'Enregistrer',exact:true}).click();
    await page.locator('#settings-current-password').fill(fixture.password);
    await page.locator('button[form="settings-reauth-form"]').click();
    await page.locator('#settings-current-password').waitFor({state:'hidden'});
    const meUrl=await page.evaluate(async()=>{
      const build=document.querySelector('meta[name="ao-build"]')?.content;
      const config=await import('/config.js?v='+encodeURIComponent(build||''));
      return config.apiUrl('/api/v3/me',3);
    });
    await page.waitForFunction(async url=>{
      const response=await fetch(url);
      const body=await response.json();
      return response.ok&&body.data?.avatar?.kind==='photo'&&!body.data.avatar.imageUrl.includes('/staged/');
    },meUrl);
  } finally { await browser?.close(); await fixture?.close(); }
});
