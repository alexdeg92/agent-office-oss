// Lazy sequence executor. Its deadlines and room frame loops use the shared life clock.
import { SURPRISES, EGGS, releaseSurprise } from './surprises.js';
import { releaseWander } from './life.js';
import { ROOMS } from './rooms.js';
import { landmarksFor } from './assets.js';
import { s as tr } from './strings.js';
export class EggController {
  constructor(scene,c,kind,config) {
    this.scene=scene;this.c=c;this.kind=kind;
    const def=EGGS[kind],sub=c.ch.substitutes??{};
    this.def={...def,enter:def.enter?{...def.enter,...sub[kind+'.enter']}:undefined,
      steps:def.steps?.map(step=>({...step,...sub[kind+'.'+step.id]}))};
    this.cfg={...SURPRISES,...config};
  }
  later(fn,ms) {this.next={at:this.scene.now()+ms,fn};}
  tick(now) {
    if(this.done)return;
    this.room?.tick(now);
    if(this.hideMask) {
      const peek=Math.floor((now-this.hideSince)/this.def.peekMs)%2===1;
      this.c.el.style.translate=(this.hideX-(peek?7:0))+'px '+this.hideDrop+'px';this.c.el.dataset.peek=String(peek);
    }
    if(this.next && now>=this.next.at) {const fn=this.next.fn;this.next=null;fn();}
  }
  phase(name) {
    if(this.done || !this.c.egg)return;
    this.c.egg.phase=name;this.scene.stage.dataset.surprisePhase=name;this.scene._renderPlate(this.c);
    const detail={id:this.c.id,kind:this.kind,phase:name};
    this.scene.stage.dispatchEvent(new CustomEvent('office-surprise',{bubbles:true,detail}));this.scene.opts.onSurprise?.(detail);
  }
  walk(target,done) {
    const {scene:s,c}=this;c.egg.target=target;c.target=target;c.targetGen=s.layoutGen;
    if(s.reducedMotion) {const uid=c.seatUid;c.pos={x:target.x,y:target.y};c.walking=false;c.seatUid=null;c.seatMode=null;if(uid)s._updateStation(uid);done();}
    else s._walkTo(c,target,done);
  }
  start() {
    const {scene:s,c}=this;c.wave=false;c.idleTurn=false;s._clear(c,c.idleTimer);this.phase('leave');
    if(this.def.landmark)return this.hide();
    const e=s.room.entrance??{x:0,y:s.room.rows-1};
    this.walk({x:e.x+.5,y:e.y+.5,uid:'egg:exit',mode:'stand'},()=>{
      if(this.returning || this.done)return;
      c.el.hidden=true;c.marker.hidden=true;c.ring.hidden=true;c.plate.hidden=true;this.phase('arrow');
      const r=ROOMS[this.def.room];this.arrow=document.createElement('button');this.arrow.type='button';this.arrow.className='ao-egg-arrow';
      this.arrow.dataset.side=r.arrow;this.arrow.textContent=r.arrow==='left'?'‹':'›';this.arrow.setAttribute('aria-label',tr('egg.arrow.'+this.kind));
      this.arrow.onclick=()=>this.openRoom();s.viewport.append(this.arrow);this.later(()=>this.openRoom(),this.cfg.arrowMs);
    });
  }
  hide() {
    const {scene:s,c}=this;
    const n=[...s.itemNodes.values()].find(n=>this.def.landmark.split('|').includes(n.f.id));
    const target=s._activityTarget(c,'water');if(!n || !target)return this.returnHome(true);
    c.el.dataset.egg='tiptoe';
    this.walk(target,()=>{
      if(this.returning || this.done)return;
      this.phase('activity');c.egg.pose=this.def.poses[0];c.pos={x:n.it.x+.5,y:n.it.y+.5};s._renderPose(c);
      const sprite=Object.values(n.parts).find(p=>p.tagName==='IMG');
      this.hideMask=sprite.cloneNode(true);this.hideMask.removeAttribute('data-item');this.hideMask.classList.add('ao-egg-foliage');
      this.hideMask.style.zIndex='10000';s.layers.scene.append(this.hideMask);
      // The crouch hides behind the world-space foliage; only its upper head/antenna may peek.
      const lm=landmarksFor(c.ch,c.occ.look.variant,c.egg.pose),box=lm?.headBox;
      this.hideDrop=(box?.h??80)*.70*c.poseScale/s.proj.artScale;this.hideX=(box?.w??80)*.15*c.poseScale/s.proj.artScale;c.el.style.translate=this.hideX+'px '+this.hideDrop+'px';c.plate.style.visibility='hidden';
      const w=c.poseCanvas.w,h=c.poseCanvas.h,eye=lm?.eyeLine?.a;
      c.el.style.clipPath=eye&&box?'ellipse('+box.w*.13/w*100+'% '+box.h*.13/h*100+'% at '+eye.x/w*100+'% '+eye.y/h*100+'%)':'inset(0 0 80% 0)';c.el.dataset.egg='hide';c.marker.hidden=true;c.ring.hidden=true;
      this.hideSince=s.now();s._positionChar(c);s._sortDirty=true;s._kick();this.later(()=>this.returnHome(),this.cfg.activityMs??this.def.ms);
    });
  }
  async openRoom() {
    if(this.loading || this.returning || this.done)return;this.loading=true;this.next=null;
    try {
      const def=ROOMS[this.def.room],m=await def.load();
      if(this.returning || this.done || this.scene.destroyed)return;
      const room=await m.createBreakRoom(this.scene,this.c,this.def.room,this.cfg);
      if(this.returning || this.done || this.scene.destroyed) {room.destroy();return;}
      this.room=room;this.phase('transition');room.show(this.scene.reducedMotion,this.cfg.transitionMs);
      this.later(()=>this.enter(),this.scene.reducedMotion?140:this.cfg.transitionMs);
    } catch {this.returnHome(true);}
  }
  enter() {
    if(this.returning || this.done)return;this.arrow?.remove();this.phase('enter');this.room.move(this.def.enter,this.cfg.stepMs??1600);
    this.later(()=>this.activity(),this.cfg.stepMs??1600);
  }
  activity() {
    this.phase('activity');
    const steps=this.def.steps.filter(d=>!d.weather || d.weather===this.room.weather);
    const next=i=>{
      if(this.returning || this.done)return;if(i>=steps.length)return this.returnHome();
      const step=steps[i],ms=this.cfg.stepMs??step.ms;this.c.egg.step=step.id;this.room.move(step,ms);this.later(()=>next(i+1),ms);
    };next(0);
  }
  clearHide() {
    this.hideMask?.remove();this.hideMask=null;this.c.el.style.clipPath='';this.c.el.style.translate='';delete this.c.el.dataset.egg;delete this.c.el.dataset.peek;
  }
  returnHome(immediate=false) {
    if(this.done)return;
    if(this.returning && !immediate)return;
    this.returning=true;this.c.egg.returning=true;this.next=null;this.arrow?.remove();this.clearHide();
    this.c.onArrive=null;this.c.path=[];this.c.walking=false;this.phase('transition-back');
    if(this.room && !immediate && !this.scene.destroyed) {
      this.room.hide(this.scene.reducedMotion,this.cfg.transitionMs);this.later(()=>this.walkHome(false),this.scene.reducedMotion?140:this.cfg.transitionMs);
    } else this.walkHome(immediate);
  }
  walkHome(immediate) {
    if(this.done)return;const {scene:s,c}=this;this.room?.destroy();this.room=null;c.el.hidden=false;c.plate.hidden=false;c.plate.style.visibility='';c.ring.hidden=false;
    this.phase('return');c.egg.pose=null;c.target=null;c.onArrive=null;c.walking=false;c.path=[];c.lifeFinished=s.now();
    s._retarget(c,immediate);s._renderPose(c);if(!c.walking)this.finish();
  }
  finish() {
    if(this.done)return;this.done=true;this.next=null;this.room?.destroy();this.arrow?.remove();this.clearHide();
    delete this.scene.stage.dataset.surprisePhase;this.c.el.hidden=false;this.c.plate.hidden=false;this.c.plate.style.visibility='';this.c.ring.hidden=false;
    this.c.egg=null;releaseSurprise(this.c);releaseWander(this.c);this.scene._renderPlate(this.c);
    const detail={id:this.c.id,kind:null,phase:null};this.scene.stage.dispatchEvent(new CustomEvent('office-surprise',{bubbles:true,detail}));this.scene.opts.onSurprise?.(detail);
  }
  cancel({immediate=false,dispose=false}={}) {if(dispose)this.finish();else this.returnHome(immediate);}
}
