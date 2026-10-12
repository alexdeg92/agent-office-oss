import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { browserSkipReason, openLayoutBrowser, visit } from './helpers/layout-browser.js';
const skip=browserSkipReason();

async function fillColumns(page, crowdedOnly=false) {
  await page.evaluate(async(crowdedOnly)=>{
    const build=document.querySelector('meta[name=ao-build]').content;
    const {services}=await import(new URL('services.js?v='+build,document.baseURI).href);
    const stream=services.stream,entry=stream._topics.get('projects');
    stream.stop();stream.status.set({conn:'open'});
    const data=structuredClone(entry.state.data),base=data.columns.flatMap(c=>c.cards)[0];
    data.columns=data.columns.map(col=>{
      const count=crowdedOnly ? (col.id==='in-review' ? 12 : 1) : 24;
      return {...col,count,cards:Array.from({length:count},(_,i)=>({...base,
        id:`prj_scroll_${col.id}_${i}`,name:`Projet de vérification ${i+1}`,status:col.id,
        lastActivityAt:Date.now(),commentCount:0}))};
    });
    entry.state={...entry.state,rev:(entry.state.rev||0)+100};
    stream.applyVM('projects',data);
  },crowdedOnly);
  await page.waitForFunction(crowdedOnly=>document.querySelectorAll('[data-card]').length===
    (crowdedOnly ? (document.querySelector('.ao-projects--mobile') ? 12 : 16) : 120),crowdedOnly);
}

async function frameState(page) {
  return page.evaluate(()=>({
    document:[scrollX,scrollY,document.scrollingElement.scrollWidth,document.scrollingElement.scrollHeight],
    body:[...document.querySelectorAll('.ao-projects > .ao-frame__body')].map(e=>[e.scrollLeft,e.scrollTop,e.clientHeight,e.scrollHeight]),
    fixed:[...document.querySelectorAll('.bu-topbar,.bu-mtopbar,.bu-bottombar,.ao-projects > .ao-frame__head,.ao-projects > .ao-frame__bar,.bu-column__head,.ao-projects-mobile__fab')]
      .map(e=>e.getBoundingClientRect().toJSON()).filter(r=>r.height),
  }));
}

for(const theme of ['light','dark']) for(const [width,height] of [[1440,900],[1280,800],[390,844],[360,640]]) {
  test(`Projects: 12 review cards scroll inside their column, never the page ${theme} ${width}`,{skip,timeout:30000},async()=>{
    const mobile=width<600,h=await openLayoutBrowser({root:process.env.PROJECTS_TEST_ROOT,theme,touch:mobile}),p=h.page,errors=[];
    p.on('pageerror',e=>errors.push(e.message));
    try {
      await p.setViewportSize({width,height});await visit(p,h.origin,'/projets?etape=in-review','[data-card]');
      await fillColumns(p,true);
      const list=p.locator(mobile ? '.ao-projects-mobile__list' : '[data-column="in-review"] .bu-column__list');
      if(!mobile) {
        await list.evaluate(e=>e.parentElement.scrollIntoView({block:'nearest',inline:'start',behavior:'instant'}));
        await p.waitForFunction(()=>{
          const board=document.querySelector('.ao-board').getBoundingClientRect(),col=document.querySelector('[data-column="in-review"]').getBoundingClientRect();
          return col.left>=board.left && col.right<=board.right;
        });
      } else {
        assert.equal(await p.locator('[data-project-choice="in-review"]').getAttribute('aria-pressed'),'true');
      }
      assert.equal(await list.locator('[data-card]').count(),12);
      assert.ok(await list.evaluate(e=>getComputedStyle(e).overflowY==='auto' && e.clientHeight>0 && e.scrollHeight>e.clientHeight),'the 12-card list owns bounded vertical scrolling');
      if(!mobile) assert.ok(await p.locator('.ao-board').evaluate(e=>e.scrollWidth>e.clientWidth),'overflowing columns scroll horizontally');
      const before=await frameState(p);
      assert.deepEqual(before.document,[0,0,width,height]);
      const pageBody=await p.locator('.ao-projects > .ao-frame__body').evaluate(e=>({top:e.scrollTop,height:e.clientHeight,scrollHeight:e.scrollHeight}));
      assert.equal(pageBody.top,0);assert.equal(pageBody.height,pageBody.scrollHeight,'page body has no vertical overflow');
      const rect=await list.boundingBox();
      if(mobile) {
        const cdp=await p.context().newCDPSession(p),x=rect.x+rect.width/2,y=rect.y+rect.height-25;
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
        for(let i=1;i<=10;i++) {
          await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-i*18}]});
          await p.waitForTimeout(25);
        }
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
      } else {
        await p.mouse.move(rect.x+rect.width/2,rect.y+80);await p.mouse.wheel(0,400);
      }
      await p.waitForFunction(selector=>document.querySelector(selector).scrollTop>40,mobile ? '.ao-projects-mobile__list' : '[data-column="in-review"] .bu-column__list');
      assert.deepEqual(await frameState(p),before,'only cards move: page, headings, + buttons and navigation stay fixed');
      assert.equal(await p.locator('[role=dialog]').count(),0,'touch scrolling never opens a move sheet');
      if(!mobile) assert.ok(await p.locator('[data-column]:not([data-column="in-review"]) .bu-column__list').evaluateAll(es=>es.every(e=>e.scrollTop===0)));
      await list.focus();await p.keyboard.press('End');
      await p.waitForFunction(selector=>{const e=document.querySelector(selector);return e.scrollTop+e.clientHeight>=e.scrollHeight-1;},mobile ? '.ao-projects-mobile__list' : '[data-column="in-review"] .bu-column__list');
      const last=await list.locator(':scope > li').last().boundingBox(),endRect=await list.boundingBox();
      assert.ok(last.y+last.height<=endRect.y+endRect.height+1,'the complete final card is reachable');
      if(mobile) assert.ok(last.y+last.height<=(await p.locator('.ao-projects-mobile__fab').boundingBox()).y,'last card clears +');
      await p.mouse.move(endRect.x+endRect.width/2,endRect.y+80);await p.mouse.wheel(0,400);await p.waitForTimeout(200);
      assert.deepEqual(await frameState(p),before,'reaching the end never scrolls the page');
      if(process.env.PROJECTS_SCREENSHOTS) {
        await mkdir('design/reports/projects-column-scroll-t0066',{recursive:true});
        await p.screenshot({path:`design/reports/projects-column-scroll-t0066/review-12-${theme}-${width}.png`});
      }
      assert.deepEqual(errors,[]);
    } finally {await h.close();}
  });
}

for(const theme of ['light','dark']) for(const [width,height] of [[1440,900],[768,700]]) {
  test(`Projects columns scroll independently inside a fixed page ${theme} ${width}`,{skip,timeout:45000},async()=>{
    const h=await openLayoutBrowser({root:process.env.PROJECTS_TEST_ROOT,theme,touch:width<820}),p=h.page,errors=[];
    p.on('pageerror',e=>errors.push(e.message));
    try {
      await p.setViewportSize({width,height});await visit(p,h.origin,'/projets','[data-card]');
      await fillColumns(p);
      const lists=p.locator('.ao-board .bu-column__list'),first=lists.nth(0),second=lists.nth(1);
      assert.equal(await lists.count(),5);
      assert.ok(await lists.evaluateAll(es=>es.every(e=>e.clientHeight>0&&e.scrollHeight>e.clientHeight&&e.tabIndex===0)));
      const before=await frameState(p);
      assert.deepEqual(before.document,[0,0,width,height]);
      assert.equal(before.body[0][1],0);
      assert.equal(before.body[0][2],before.body[0][3],'page body has no vertical overflow');
      const box=await first.boundingBox();await p.mouse.move(box.x+box.width/2,box.y+80);await p.mouse.wheel(0,550);
      await p.waitForFunction(()=>document.querySelector('.bu-column__list').scrollTop>100);
      assert.ok(await lists.evaluateAll(es=>es.slice(1).every(e=>e.scrollTop===0)),'peer columns do not move');
      assert.deepEqual(await frameState(p),before,'controls, column headings and document stay fixed');
      await first.evaluate(e=>{e.scrollTop=e.scrollHeight;});
      await p.mouse.wheel(0,500);await p.waitForTimeout(200);
      assert.deepEqual(await frameState(p),before,'wheel at the column boundary never scrolls the page');
      await first.focus();await p.keyboard.press('Home');
      await p.waitForFunction(()=>document.querySelector('.bu-column__list').scrollTop===0);
      await p.keyboard.press('End');
      await p.waitForFunction(()=>{const e=document.querySelector('.bu-column__list');return e.scrollTop+e.clientHeight>=e.scrollHeight-1;});
      const end=await first.locator(':scope > li').last().boundingBox(),listBox=await first.boundingBox();
      assert.ok(end.y+end.height<=listBox.y+listBox.height+1,'the entire final card and move control are reachable');
      const firstTop=await first.evaluate(e=>e.scrollTop);
      if(width<820) {
        const status=await second.evaluate(e=>e.parentElement.dataset.column);
        await p.locator('.ao-projects__goto select').selectOption(status);
        await p.waitForFunction(()=>{
          const board=document.querySelector('.ao-board'),column=document.querySelectorAll('[data-column]')[1];
          return Math.abs(column.getBoundingClientRect().left-board.getBoundingClientRect().left-parseFloat(getComputedStyle(board).scrollPaddingLeft))<1;
        });
      }
      const peer=await second.boundingBox(),peerFrame=await frameState(p);
      await p.mouse.move(peer.x+peer.width/2,peer.y+80);await p.mouse.wheel(0,300);
      await p.waitForFunction(()=>document.querySelectorAll('.bu-column__list')[1].scrollTop>50);
      assert.equal(await first.evaluate(e=>e.scrollTop),firstTop,'scrolling another column preserves this column');
      assert.deepEqual(await frameState(p),peerFrame);
      const board=p.locator('.ao-board');assert.ok(await board.evaluate(e=>e.scrollWidth>e.clientWidth));
      const horizontalStart=await board.evaluate(e=>e.scrollLeft);
      await p.mouse.wheel(600,0);await p.waitForFunction(start=>document.querySelector('.ao-board').scrollLeft>start+50,horizontalStart);
      assert.equal(await board.evaluate(e=>e.scrollTop),0);
      assert.deepEqual((await frameState(p)).document,before.document,'horizontal board navigation stays inside the board');
      if(width<820) await p.locator('.ao-projects__goto select').selectOption(await first.evaluate(e=>e.parentElement.dataset.column));
      else await board.evaluate(e=>{e.scrollLeft=0;});
      await p.waitForFunction(()=>document.querySelector('.ao-board').scrollLeft===0);
      if(process.env.PROJECTS_SCREENSHOTS) {
        await mkdir('design/reports/projects-column-scroll-t0066',{recursive:true});
        await p.screenshot({path:`design/reports/projects-column-scroll-t0066/columns-${theme}-${width}.png`});
      }
      await p.setViewportSize({width,height:height-200});
      assert.ok(await lists.evaluateAll(es=>es.every(e=>e.clientHeight>0&&e.scrollHeight>e.clientHeight)));
      const resized=await frameState(p);assert.deepEqual(resized.document,[0,0,width,height-200]);
      assert.equal(resized.body[0][1],0);assert.equal(resized.body[0][2],resized.body[0][3]);
      assert.deepEqual(errors,[]);
    } finally {await h.close();}
  });
}
