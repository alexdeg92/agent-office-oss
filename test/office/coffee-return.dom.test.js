'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launch, findChrome } = require('./helpers/browser');
test('26c Round 2: coffee returns beside the chair, drops the walking body before hip placement, and leaves a desktop mug for every look', { skip: !findChrome(), timeout: 120000 }, async () => {
  const b = await launch();
  try {
    const p = await b.page('/test/office/harness.html'); await p.waitFor('window.H?.ready');
    const result = await p.eval(`
      const sc = new H.OfficeScene(stage, { manifest:H.manifest, layout:H.layout, assetBase:H.assetBase, life:{intervalMs:600000}, walkTilesPerS:.01 });
      sc._lifeTimer(); sc._lifeTimer=()=>{};
      const errors=[]; let checks=0;
      for (const ch of H.manifest.characters) for (const v of ch.variants?.length ? ch.variants : [{id:null}]) {
        sc.setReducedMotion(true);
        sc.setOccupants([{id:'main',role:'main',sourceName:'Agent',state:'idle',stateSince:Date.now(),stationUid:'st-timmy',look:{character:ch.id,variant:v.id,accessories:['cap','glasses','scarf','badge']}}]);
        const c=sc.chars.get('main'); c.reaction=null;
        sc.interact(c.id,'coffee',{durationMs:600000});
        sc.setReducedMotion(false); sc._cancelActivity(c);
        const end=c.path.at(-1), seat=c.target;
        if (!end || Math.hypot(end.x-seat.x,end.y-seat.y)<1.4) errors.push(ch.id+': walk ends in chair');
        if(c.path.some(p=>Math.floor(p.x)===Math.floor(seat.x)&&Math.floor(p.y)===Math.floor(seat.y))) errors.push(ch.id+': walk crosses chair');
        await H.until(()=>c.displayed===c.poseEl);
        if(!c.displayed.dataset.pose.startsWith('life-cupwalk-')) errors.push(ch.id+': cup not carried');
        H.holdDecodes();
        c.pos={...end}; c.path=[{...end}]; sc._frame(performance.now()+100);
        if(c.el.querySelector('.ao-pose') || c.displayed) errors.push(ch.id+': old standing frame at seated hip while decoding');
        H.releaseAll(); H.restoreDecodes(); await H.until(()=>c.displayed===c.poseEl);
        const n=sc.itemNodes.get(c.seatUid), mug=n.parts['seated:mug'];
        if(c.walking || c.carryProp || c.seatMode!=='desk' || !c.poseSeat || c.displayed.dataset.pose.startsWith('life-cupwalk-')) errors.push(ch.id+': not seated');
        if(!mug || mug.hidden || !mug.src.endsWith('/mug.webp') || !n.stack.includes('mug')) errors.push(ch.id+': mug missing from desktop');
        sc.setOccupants([{...c.occ,state:'calling'}]); c.reaction=null; sc._renderPose(c); await H.until(()=>c.displayed===c.poseEl);
        if(c.markerKind!==null || !c.marker.hidden) errors.push(ch.id+': overhead calling marker shown at desk');
        if(c.renderedPose!=='life-phone-ne') errors.push(ch.id+': phone not seated');
        checks++;
      }
      sc.destroy(); return {errors,checks};
    `);
    assert.deepEqual(result.errors, []); assert.equal(result.checks, 8); assert.deepEqual(p.logs, []);
  } finally { await b.close(); }
});
