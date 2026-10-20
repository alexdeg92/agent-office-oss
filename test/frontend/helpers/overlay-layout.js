import scratchHome from '../../helpers/scratch-home.cjs';
scratchHome.refuseEntry(import.meta.url);

import assert from 'node:assert/strict';

// Overlay roots are discovered by their public accessibility semantics. New
// dialogs, menus, tooltips and native popovers join the audit automatically.
export const overlayRegistry = Object.freeze([
  {id:'dialog',selector:'[role="dialog"], [role="alertdialog"], dialog[open]',sheetSelector:'.bu-modal,[data-overlay-type="sheet"]',actionsSelector:'.bu-modal__footer,footer,[data-overlay-actions]'},
  {id:'menu',selector:'[role="menu"]'},
  {id:'listbox',selector:'[role="listbox"]'},
  {id:'popover',selector:'[role="tooltip"][popover], [popover]:popover-open'},
]);

// Every source file that creates or composes an overlay is listed here. The
// browser suite's source meta-test discovers semantic overlay markup in the
// app and fails when a new source file is not registered.
export const overlaySourceRegistry=Object.freeze([
  'components/modal.js','components/bureau/confirm-dialog.js','components/bureau/primitives.js',
  'components/bureau/menu.js','components/bureau/popover.js','components/shortcuts.js','components/restart.js',
  'pages/project-comments.js','pages/settings-access.js','pages/projects.js','pages/project.js','pages/ds.js',
  'pages/settings.js','pages/journaux.js','pages/project-team.js','pages/chat.js','pages/settings-fix-all.js',
  'pages/chat-content.js','pages/chat-conversation.js','pages/flows.js','office/placement.js','office/boutique.js',
  'office/page.js','office/editor.js','office/team-office.js',
]);
export const overlayComponentRegistry=Object.freeze([
  {component:'Modal',source:'components/modal.js'},
  {component:'ConfirmDialog',source:'components/bureau/confirm-dialog.js'},
  {component:'BottomSheet',source:'components/modal.js',rendering:'responsive Modal sheet'},
  {component:'Menu',source:'components/bureau/menu.js'},
  {component:'PreviewButton',source:'components/bureau/popover.js'},
]);

export async function waitForOverlayStable(page,selector){
  const locator=page.locator(selector).filter({visible:true});
  await locator.first().waitFor({state:'visible'});
  await page.waitForFunction(sel=>{
    const roots=[...document.querySelectorAll(sel)].filter(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0;});
    if(!roots.length)return false;
    const relevant=new Set(roots);
    for(const root of roots){for(const child of root.querySelectorAll('*'))relevant.add(child);const scrim=root.parentElement?.querySelector('.bu-scrim,[data-overlay-scrim]');if(scrim)relevant.add(scrim);}
    const active=document.getAnimations().some(animation=>relevant.has(animation.effect?.target)&&animation.playState==='running'&&animation.effect?.getComputedTiming().iterations!==Infinity);
    if(active){window.__overlayStableRect=null;return false;}
    const signature=roots.map(el=>{const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height,getComputedStyle(el).opacity].join(':');}).join('|');
    if(window.__overlayStableRect?.signature===signature)window.__overlayStableRect.frames++;
    else window.__overlayStableRect={signature,frames:1};
    return window.__overlayStableRect.frames>=3;
  },selector,{timeout:5000});
}

export async function assertOverlayLayout(page, context='overlay', expectedKinds=[]) {
  const selectors=overlayRegistry.map(item=>item.selector).join(',');
  await waitForOverlayStable(page,selectors);
  const result=await page.evaluate(registry=>{
    const width=innerWidth,height=innerHeight,issues=[],seen=new Set(),opened=[];
    const rectOf=el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const visible=el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0;};
    const add=(code,el,extra={})=>{
      const mark=el?.matches?.('.ao-brand-mark')?el:el?.closest?.('.ao-brand-mark');
      const fallback=mark?.querySelector('.ao-brand-mark__fallback');
      const markDebug=mark?{markReady:mark.classList.contains('ao-brand-mark--ready'),fallbackDisplay:getComputedStyle(fallback).display,
        fallbackFont:getComputedStyle(fallback).font,fallbackRect:rectOf(fallback),markChildren:[...mark.children].map(child=>({className:child.className,
          display:getComputedStyle(child).display,rect:rectOf(child),scrollHeight:child.scrollHeight,clientHeight:child.clientHeight}))}:{};
      issues.push({code,selector:el?.getAttribute('data-testid')||el?.className?.baseVal||el?.className||el?.tagName||'document',rect:el?rectOf(el):null,...extra,...markDebug});
    };
    for(const item of registry)for(const el of document.querySelectorAll(item.selector)){
      if(!visible(el)||seen.has(el))continue;seen.add(el);opened.push(item.id);
      const r=rectOf(el),tag=el.tagName.toLowerCase();
      if(r.left < -1 || r.top < -1 || r.right > width+1 || r.bottom > height+1)add('overlay-outside-viewport',el,{kind:item.id,viewport:{width,height}});
      if((item.id==='dialog'||tag==='dialog')&&item.sheetSelector&&el.matches(item.sheetSelector)&&width<=820){
        if(Math.abs(r.left)>1||Math.abs(r.right-width)>1||Math.abs(r.bottom-height)>1)add('bottom-sheet-edge-gap',el,{viewport:{width,height}});
      }
      if(item.id==='menu'||item.id==='popover'){
        if(r.left < -1 || r.top < -1 || r.right > width+1 || r.bottom > height+1)add('anchored-overlay-outside-viewport',el,{viewport:{width,height}});
      }
      for(const button of el.querySelectorAll('button,[role="button"]'))if(visible(button)){
        const b=rectOf(button);if(b.left<r.left-1||b.right>r.right+1||b.top<r.top-1||b.bottom>r.bottom+1||b.left< -1||b.right>width+1||b.top< -1||b.bottom>height+1)add('button-clipped',button,{overlay:el.className||item.id});
        if(button.scrollWidth>button.clientWidth+1||button.scrollHeight>button.clientHeight+1)add('button-text-clipping',button,{scrollWidth:button.scrollWidth,clientWidth:button.clientWidth,scrollHeight:button.scrollHeight,clientHeight:button.clientHeight,text:button.innerText?.slice(0,100)});
      }
      const textElements=[...el.querySelectorAll('h1,h2,h3,h4,p,span,label,a,small,strong,em,[role="status"],[role="alert"]')].filter(visible);
      for(const text of textElements)if(text.textContent?.trim()&&(text.scrollWidth>text.clientWidth+1||text.scrollHeight>text.clientHeight+1))add('text-clipping',text,{scrollWidth:text.scrollWidth,clientWidth:text.clientWidth,scrollHeight:text.scrollHeight,clientHeight:text.clientHeight,text:text.textContent.trim().slice(0,100)});
      for(const child of el.querySelectorAll('*'))if(visible(child)){
        const style=getComputedStyle(child);
        const avatar=child.matches('.bu-avatar,.ao-character-avatar,.ao-project-member__portrait');
        // Vertical scrolling is the intended containment for long phone sheets.
        // Horizontal scrollers and clipped non-avatar content remain failures.
        if(!avatar&&((child.scrollWidth>child.clientWidth+1&&['auto','scroll','hidden','clip'].includes(style.overflowX))||
          (child.scrollHeight>child.clientHeight+1&&['hidden','clip'].includes(style.overflowY))))add('overlay-content-overflow',child,{scrollWidth:child.scrollWidth,clientWidth:child.clientWidth,overflowX:style.overflowX,scrollHeight:child.scrollHeight,clientHeight:child.clientHeight,overflowY:style.overflowY});
      }
      const footer=item.actionsSelector?el.querySelector(item.actionsSelector):null;
      if(footer){
        const buttons=[...footer.querySelectorAll('button,[role="button"]')].filter(visible).map(rectOf);
        for(let i=0;i<buttons.length;i++)for(let j=i+1;j<buttons.length;j++)if(Math.abs(buttons[i].top-buttons[j].top)>2&&Math.abs(buttons[i].width-buttons[j].width)>1)add('stacked-actions-unequal-width',footer,{first:buttons[i],second:buttons[j]});
      }
    }
    for(const scrim of document.querySelectorAll('.bu-scrim,[data-overlay-scrim],.ao-bureau__veil,.ao-drawer-scrim'))if(visible(scrim)){
      const r=rectOf(scrim);if(Math.abs(r.left)>1||Math.abs(r.top)>1||Math.abs(r.right-width)>1||Math.abs(r.bottom-height)>1)add('scrim-does-not-cover-viewport',scrim,{viewport:{width,height}});
    }
    const root=document.scrollingElement;
    if(root&&root.scrollWidth>width+1)add('page-horizontal-overflow',null,{scrollWidth:root.scrollWidth,viewport:width});
    return {issues,opened};
  },overlayRegistry);
  assert.ok(result.opened.length>0,`${context}: no visible registered overlay was measured`);
  for(const kind of expectedKinds)assert.ok(result.opened.includes(kind),`${context}: expected ${kind} to open; measured ${result.opened.join(', ')||'none'}`);
  assertNoLayoutIssues(result,context);
  return result.opened;
}

export function assertNoLayoutIssues(result,context='overlay') {
  if(result.issues.length)throw new Error(`${context} layout violations: ${JSON.stringify(result.issues)}`);
  return result.opened;
}
