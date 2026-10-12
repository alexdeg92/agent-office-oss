import test from 'node:test';
import assert from 'node:assert/strict';
import { openLayoutBrowser, visit, browserSkipReason } from './helpers/layout-browser.js';

const skip = browserSkipReason();
const intersects = (a,b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

test('sidebar release badge stays on the About icon corner and clear of account text at every shell width', {skip,timeout:60000}, async () => {
  for (const theme of ['light','dark']) for (const locale of ['fr','en']) for (const role of locale==='fr'?['Membre','Administrateur']:['Member','Administrator']) {
    const h = await openLayoutBrowser({theme}), p = h.page;
    const errors=[];p.on('pageerror',e=>errors.push(e.message));
    try {
      await p.addInitScript(locale=>localStorage.setItem('ao.locale',locale),locale);
      // Supply a synthetic MeVM through the actual mock auth entry point.
      await p.route('**/mock/server.js*',async route=>{
        const response=await route.fetch();
        const source=await response.text();
        const fixture="email: 'member@example.invalid', displayName: 'Synthetic member with a long name', roleName: "+JSON.stringify(role);
        const body=source.replace("email: 'Owner@example.invalid', displayName: 'Owner'",fixture);
        assert.notEqual(body,source,'fixture replaces the mock account');
        await route.fulfill({response,body});
      });
      await visit(p,h.origin,'/parametres?onglet=connexion','[data-provider]');
      await p.locator('.ao-new-release').waitFor({state:'attached'});
      assert.equal(await p.locator('.bu-usercard__role').innerText(),role);
      assert.equal(await p.locator('.bu-usercard__role').getAttribute('title'),role);
      for (const fontSize of ['16px','20px']) {
        await p.evaluate(value=>document.documentElement.style.fontSize=value,fontSize);
        for (const width of [1920,1440,1024,900,821,820,390,375,320]) {
          await p.setViewportSize({width,height:900});
          const g=await p.evaluate(async()=>{
            await document.fonts.ready;await new Promise(r=>requestAnimationFrame(r));
            const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();
            return {sidebar:rect('.bu-sidebar'),badge:rect('.ao-new-release'),anchor:rect('.ao-about-entry'),
              text:rect('.bu-usercard__text'),name:rect('.bu-usercard__name'),role:rect('.bu-usercard__role'),
              prefs:rect('.ao-prefs'),logout:rect('.bu-usercard button'),
              clip:getComputedStyle(document.querySelector('.bu-usercard__role')).overflow,
              ellipsis:getComputedStyle(document.querySelector('.bu-usercard__role')).textOverflow,
              roleWidth:document.querySelector('.bu-usercard__role').clientWidth,roleContent:document.querySelector('.bu-usercard__role').scrollWidth,
              docWidth:document.scrollingElement.scrollWidth};
          });
          const label=`${theme} ${locale} ${role} ${width}px root ${fontSize}`;
          assert.ok(g.docWidth<=width,label+' no page overflow');
          if(width<=820){assert.equal(g.sidebar.width,0,label+' uses the mobile shell');continue;}
          for(const key of ['text','name','role','prefs','logout'])assert.equal(intersects(g.badge,g[key]),false,label+' clear of '+key);
          assert.ok(g.badge.bottom<=g.anchor.top,label+' badge above icon button');
          assert.ok(g.badge.right>g.anchor.left&&g.badge.left<g.anchor.right,label+' badge attached to corner');
          assert.ok(g.badge.left>=g.sidebar.left&&g.badge.right<=g.sidebar.right,label+' badge contained horizontally');
          assert.ok(g.badge.top>=0&&g.badge.bottom<=900,label+' badge inside viewport');
          assert.equal(g.clip,'hidden',label+' long role contained');
          assert.equal(g.ellipsis,'ellipsis',label+' long role remains readable via title');
          assert.ok(g.roleContent<=g.roleWidth,label+' standard role is fully visible');
        }
      }
      await p.evaluate(()=>document.documentElement.style.fontSize='16px');await p.setViewportSize({width:1440,height:900});
      assert.match(await p.locator('.ao-about-entry').getAttribute('aria-label'),new RegExp(locale==='fr'?'Nouveau':'New'));
      await p.locator('.ao-about-entry').click();await p.locator('.ao-release-notes').waitFor();
      await p.locator('.ao-new-release').waitFor({state:'detached'});
      assert.equal(await p.locator('.bu-usercard__role').innerText(),role,'opening About keeps the account role');
      assert.deepEqual(errors,[]);
    }finally{await h.close();}
  }
});
