// Lazy screen-space animation geometry; no VM state or membership decisions.
// Reserve the complete head-anchored trajectory before labels are positioned.
// This is screen-space animation geometry, independent of occupant membership.
export function sleepBox(head,width,height,mobile,obstacles) {
  const w=mobile?42:62,h=mobile?65:82,preferred=head.y-h;
  const columns=[head.x,head.x-w,...obstacles.flatMap(p=>[p.right+6,p.left-w-6])];
  let best;
  for(const column of columns){
    const left=Math.round(Math.max(4,Math.min(width-w-4,column)));
    const intervals=obstacles.filter(p=>left<p.right+4&&left+w>p.left-4)
      .map(p=>({lo:p.top-h-4,hi:p.bottom+4})).sort((a,b)=>a.lo-b.lo);
    let low=4;const max=height-h-4;
    const gap=high=>{if(low>high)return;const top=Math.round(Math.max(low,Math.min(high,preferred))),score=Math.min(Math.abs(left-head.x),Math.abs(left+w-head.x))+Math.abs(top-preferred);
      if(!best||score<best.score)best={left,top,right:left+w,bottom:top+h,score};};
    for(const p of intervals){if(p.hi<=low)continue;if(p.lo>max)break;gap(Math.min(max,p.lo));low=Math.max(low,p.hi);if(low>max)break;}
    gap(max);
  }
  const box=best??{left:4,top:4,right:4+w,bottom:4+h};
  return {...box,side:head.x-box.left>(box.right-box.left)/2?'left':'right'};
}

export function positionSleep(scene,placed) {
  const people=[...scene.chars.values()].filter(c=>c.sleepLetters&&c.head&&!c.leaving);
  const width=scene.viewport.clientWidth,height=scene.viewport.clientHeight,mobile=scene.stage.hasAttribute('data-plates-primary');
  const blocked=placed.map(p=>({left:p.left??p.vx-p.w/2,right:p.right??p.vx+p.w/2,top:p.top-(p.bh??0),bottom:p.bottom??p.top+p.h}));
  const key=JSON.stringify([scene.cam,width,height,mobile,blocked,people.map(c=>[c.id,c.head,c.sleepVersion])]);
  if(scene._sleepGeometryKey===key)return scene._sleepBoxes??[];scene._sleepGeometryKey=key;scene._sleepBoxes=[];
  for(const c of people){
    const head={x:(c.head.sx+scene.origin.x)*scene.cam.zoom+scene.cam.x,y:(c.head.sy+scene.origin.y)*scene.cam.zoom+scene.cam.y};
    const box=sleepBox(head,width,height,mobile,blocked);blocked.push(box);
    c.sleepLetters.toggleAttribute('data-mobile',mobile);
    c.sleepLetters.dataset.side=box.side;
    c.sleepLetters.style.transform=`translate(${box.left}px, ${box.top}px)`;
    c.sleepLetters.hidden=false;
    scene._sleepBoxes.push(box);
  }
  return scene._sleepBoxes;
}

