import {html,useLayoutEffect,useRef,useState} from '../../lib.js';
import {useControlId} from './control-id.js';

// Non-interactive hover/focus preview; the primary action opens the full dialog.
// Native top-layer positioning escapes pane clipping. Imported only where used.
export function PreviewButton({label,mobileLabel,icon,count,onPress,children,class:cls=''}) {
 const id=useControlId(null,'bu-preview'),root=useRef(null),trigger=useRef(null),panel=useRef(null);
 const [open,setOpen]=useState(false);
 function show(){if(matchMedia('(hover:hover) and (min-width:821px)').matches)setOpen(true);}
 useLayoutEffect(()=>{
  if(!open)return;
  const element=panel.current;element.showPopover?.();
  function position(){
   if(!trigger.current?.getClientRects().length||!matchMedia('(hover:hover) and (min-width:821px)').matches){setOpen(false);return;}
   const anchor=trigger.current.getBoundingClientRect(),style=getComputedStyle(element);
   const gutter=parseFloat(style.getPropertyValue('--bu-space-4')),gap=parseFloat(style.getPropertyValue('--bu-space-1'));
   const width=window.visualViewport?.width||innerWidth,height=window.visualViewport?.height||innerHeight;
   element.style.maxHeight=`${Math.max(0,height-2*gutter)}px`;
   const box=element.getBoundingClientRect();
   element.style.left=`${Math.max(gutter,Math.min(anchor.right-box.width,width-gutter-box.width))}px`;
   const above=anchor.top-gap-box.height,top=anchor.bottom+gap+box.height>height-gutter&&above>=gutter?above:anchor.bottom+gap;
   element.style.top=`${Math.max(gutter,Math.min(top,height-gutter-box.height))}px`;
  }
  const dismiss=event=>{if(!root.current?.contains(event.target))setOpen(false);};
  const escape=event=>{if(event.key==='Escape'){event.stopPropagation();setOpen(false);}};
  position();document.addEventListener('pointerdown',dismiss,true);document.addEventListener('keydown',escape,true);
  window.addEventListener('resize',position);document.addEventListener('scroll',position,true);
  window.visualViewport?.addEventListener('resize',position);
  const observer=new ResizeObserver(position);observer.observe(element);
  return()=>{
   document.removeEventListener('pointerdown',dismiss,true);document.removeEventListener('keydown',escape,true);
   window.removeEventListener('resize',position);document.removeEventListener('scroll',position,true);
   window.visualViewport?.removeEventListener('resize',position);observer.disconnect();
   if(element.matches(':popover-open'))element.hidePopover();
  };
 },[open]);
 return html`<span ref=${root} class=${'bu-control-preview '+(mobileLabel?'bu-control-preview--responsive ':'')+cls} onPointerEnter=${show} onPointerLeave=${event=>{if(!root.current?.contains(event.relatedTarget))setOpen(false);}}>
  <button ref=${trigger} type="button" class="bu-control-popover__trigger" aria-haspopup="dialog" aria-describedby=${open?id:undefined}
   onFocus=${show} onBlur=${()=>setOpen(false)} onClick=${()=>{setOpen(false);onPress();}}>${icon}<span class="bu-preview-label--desktop">${label}</span>${mobileLabel?html`<span class="bu-preview-label--mobile">${mobileLabel}</span>`:null}${count==null?null:html`<span class="bu-count bu-preview-label--desktop">${count}</span>`}</button>
  ${open?html`<div ref=${panel} id=${id} role="tooltip" popover="manual" class="bu-control-menu__panel bu-control-popover__panel">${children}</div>`:null}
 </span>`;
}
