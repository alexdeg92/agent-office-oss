'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {launch,findChrome}=require('./helpers/browser');
const {channelOffice}=require('../helpers/channel-dm-office.cjs');
const {labelsFor}=require('../../src/i18n');

test('Office agent card names its human counterpart and channel without a separate person on desktop and phone', {skip:!findChrome(),timeout:120000},async()=>{
  const browser=await launch();
  const out=process.env.AO_TEST_SHOTS_DIR||path.join(os.tmpdir(),'wechat-interlocutor-shots');fs.mkdirSync(out,{recursive:true});
  try{
    for(const [lang,width,height] of [['en',1440,900],['en',390,844],['fr',1440,900],['fr',390,844]]){
      const p=await browser.page(`/public/v2/office/bureau-dev.html?tick=600000&api=3&lang=${lang}`);
      try{
        await p.viewport(width,height);await p.waitFor('window.officeBench');
        const {vm}=channelOffice();
        await p.eval(`const i18n=await import('/public/v2/i18n.js');i18n.setMeta(${JSON.stringify({locale:lang,apiVersion:3,labels:labelsFor(lang,3)})});
          const vm=${JSON.stringify(vm)};officeBench.om.officeVM=async()=>vm;await officeBench.publish('office');`);
        if(width<600){await p.waitFor(`document.querySelector('.ao-mobile-team-preview')`);await p.eval(`document.querySelector('.ao-mobile-team-preview').click()`);}
        await p.waitFor(`document.querySelectorAll('.ao-plate').length===1`);
        const expected=(lang==='fr'?'En conversation avec':'In conversation with')+' Synthetic person · WeChat';
        await p.waitFor(`document.body.innerText.includes(${JSON.stringify(expected)})`);
        assert.equal(await p.eval("return document.body.innerText.includes('Synthetic agent · 2')"),false);
        assert.equal(await p.eval(`return [...document.querySelectorAll('.ao-roster')].filter(n=>n.getBoundingClientRect().width>0).every(n=>!n.querySelector('.ao-roster__summary')?.textContent.includes(${JSON.stringify(lang==='fr'?'En conversation avec ':'In conversation with ')}+n.querySelector('.ao-roster__name')?.textContent))`),true,'no visible agent card names itself as its conversation counterpart');
        assert.equal(await p.eval("return document.querySelectorAll('.ao-roster [data-state-kind=visitor]').length"),0);
        assert.equal(await p.eval(`return [...document.querySelectorAll('.ao-roster__summary[data-conversation]')].filter(n=>n.getBoundingClientRect().width>0).every(n=>n.scrollWidth<=n.clientWidth+1 && getComputedStyle(n).whiteSpace==='normal')`),true,'counterpart and channel remain readable without truncation');
        fs.writeFileSync(path.join(out,`office-wechat-${lang}-${width}.png`),await p.screenshot());
      }finally{await p.close();}
    }
  }finally{await browser.close();}
});
