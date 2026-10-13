import { loadModule, chunkError } from '../build-update.js';
// Lazy room hosts share the artwork, camera and weather; actors own only pose/deadline data.
import { buildQuery } from '../config.js';
import { poseImage, accessoryLayers, resolveUrl, renderScale } from './assets.js';
import { ROOMS } from './rooms.js';
import { s as tr, locale } from './strings.js';
const pools=new WeakMap();let styleReady;
const node=(tag,cls)=>{const n=document.createElement(tag);n.className=cls;return n;};
function styles() {
  if(!styleReady) styleReady=new Promise((resolve,reject)=>{
    const link=node('link','');link.rel='stylesheet';link.href=new URL('./break-room.css' + buildQuery,import.meta.url).href;
    link.dataset.breakRoomStyle='';link.onload=resolve;link.onerror=()=>{link.remove();styleReady=null;reject(chunkError(Error('room style')));};document.head.append(link);
  });return styleReady;
}
export async function createBreakRoom(scene,c,id,cfg={}) {
  await styles();let pool=pools.get(scene);if(!pool)pools.set(scene,pool=new Map());
  let host=pool.get(id);
  if(!host) {host=new RoomHost(scene,id,cfg,()=>pool.delete(id));pool.set(id,host);}
  const actor=new RoomActor(host,c,cfg);host.actors.add(actor);
  try {await host.art.decode();await actor.setPose('walking');return actor;} catch(e) {actor.destroy();throw e;}
}
class RoomHost {
  constructor(scene,id,cfg,onEmpty) {
    this.scene=scene;this.id=id;this.def=ROOMS[id];this.onEmpty=onEmpty;this.actors=new Set();const d=this.def;
    this.root=node('section','ao-break');this.root.setAttribute('aria-label',tr('egg.'+d.scene));this.root.dataset.kind=d.scene;
    this.root.dataset.weather=cfg.weather??((scene.opts.random??Math.random)()<(d.rainChance??.25)?'rain':'clear');
    this.world=node('div','ao-break-world');this.root.append(this.world);
    this.sky=node('div','ao-break-sky');this.root.prepend(this.sky);
    this.art=node('img','ao-break-art');this.art.alt='';this.art.draggable=false;this.art.src=resolveUrl(d.assets.image,scene.assetBase);this.world.append(this.art);
    for(const polygon of d.windows??[]) {
      const x=Math.min(...polygon.map(p=>p[0])),y=Math.min(...polygon.map(p=>p[1])),w=Math.max(...polygon.map(p=>p[0]))-x,h=Math.max(...polygon.map(p=>p[1]))-y;
      const glass=node('div','ao-break-window');Object.assign(glass.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px',clipPath:'polygon('+polygon.map(p=>(p[0]-x)+'px '+(p[1]-y)+'px').join(',')+')'});glass.innerHTML='<i></i><i></i><i></i>';this.world.append(glass);
    }
    if(d.lamp) {const lamp=node('div','ao-break-lamp');lamp.style.left=d.lamp.x+'px';lamp.style.top=d.lamp.y+'px';this.world.append(lamp);}
    if(d.puddle) {const puddle=node('div','ao-break-puddle');puddle.style.left=d.puddle.x+'px';puddle.style.top=d.puddle.y+'px';this.world.append(puddle);}
    const rain=node('div','ao-break-rain');rain.setAttribute('aria-hidden','true');
    for(let i=0;i<32;i++){const r=node('i','');r.style.left=(i*47%100)+'%';r.style.top=(i*31%100)+'%';r.style.animationDelay=-(i*.13)+'s';rain.append(r);}
    if(d.shelter)rain.style.clipPath='polygon(evenodd,0px 0px,1536px 0px,1536px 1024px,0px 1024px,0px 0px,'+d.shelter.map(p=>p[0]+'px '+p[1]+'px').join(',')+','+d.shelter[0][0]+'px '+d.shelter[0][1]+'px)';
    this.world.append(rain);
    this.caption=node('div','ao-break-caption');this.caption.setAttribute('role','status');this.root.append(this.caption);
    const back=node('button','ao-break-back');back.type='button';back.textContent=tr('egg.return');back.onclick=()=>{for(const a of [...this.actors])a.c.egg?.controller?.returnHome();};this.root.append(back);
    scene.viewport.append(this.root);this.ro=new ResizeObserver(()=>this.fit());this.ro.observe(this.root);this.fit();this.sync();
  }
  sync() {this.root.dataset.theme=this.scene.stage.dataset.officeTheme==='night'?'night':'day';this.root.dataset.reduced=String(this.scene.reducedMotion);}
  fit() {const r=this.root.getBoundingClientRect();this.scale=Math.min(r.width/1536,r.height/1060);this.camera(this.cameraView);}
  camera(view={}) {
    this.cameraView=view;const {zoom=1,x=768,y=512}=view,r=this.root.getBoundingClientRect(),k=this.scale*zoom;
    this.world.style.transform=`translate(${r.width/2-x*k}px,${r.height/2-y*k}px) scale(${k})`;
  }
  show(reduced,ms) {this.root.style.setProperty('--transition',(reduced?140:ms)+'ms');this.root.dataset.open='true';this.scene.world.style.transition=`transform ${reduced?0:ms}ms ease, opacity ${reduced?140:ms}ms ease`;this.scene.world.style.opacity='0';this.scene.labelsLayer.style.visibility='hidden';if(!reduced)this.scene.world.style.translate=this.def.edge==='left'?'35% 0':'-35% 0';}
  hide(reduced,ms) {if(this.actors.size>1)return;this.root.style.setProperty('--transition',(reduced?140:ms)+'ms');this.root.dataset.open='false';this.scene.world.style.opacity='1';this.scene.world.style.translate='';this.scene.labelsLayer.style.visibility='';}
  release(actor) {
    this.actors.delete(actor);if(this.actors.size)return;
    this.ro.disconnect();this.root.remove();this.scene.world.style.opacity='';this.scene.world.style.translate='';this.scene.world.style.transition='';this.scene.labelsLayer.style.visibility='';this.onEmpty();
  }
}
class RoomActor {
  constructor(host,c,cfg) {
    this.host=host;this.root=host.root;this.world=host.world;this.c=c;this.scene=host.scene;this.cfg=cfg;
    this.actor=node('div','ao-break-actor');this.actor.dataset.occupant=c.id;this.body=node('div','ao-break-body');this.actor.append(this.body);
    this.fx=node('div','ao-break-fx');this.fx.innerHTML='<i class="egg-ember"></i><i class="egg-puff"></i><i class="egg-puff"></i><i class="egg-puff"></i><i class="egg-sweat"></i><i class="egg-sweat"></i><i class="egg-butt"></i>';this.actor.append(this.fx);this.world.append(this.actor);
    this.point={...host.def.points.entry};this.k=renderScale(c.ch);this.actor.style.setProperty('--actor-scale',this.k);this.anchor={x:96,y:276};this.position(this.point);
  }
  get weather(){return this.root.dataset.weather;}
  camera(view){this.host.camera(view);}
  position(p) {this.point=p;this.actor.style.left=(p.x-this.anchor.x*this.k)+'px';this.actor.style.top=(p.y-this.anchor.y*this.k)+'px';}
  async setPose(pose) {
    const version=this.version=(this.version??0)+1,look=this.c.occ.look,ch=this.scene.index.characters.get(look.character)??this.c.ch;
    const body=poseImage(ch,look.variant,pose),mode=this.scene.stage.dataset.officeTheme==='night'?'night':'day';
    this.accessoryMode=mode;
    if(look.accessories?.some(id=>this.scene.index.accessories.get(id)?.packManifest)) {
      const m=await loadModule(() => import('./accessory-pack-loader.js'+buildQuery));
      await m.prepareAccessoryLayers(this.scene.index,look,body.pose,this.scene.assetBase,{mode}).catch(()=>{});
      if(this.disposed || version!==this.version)return;
    }
    const acc=accessoryLayers(this.scene.index,ch.id,look.accessories,body.pose,look.variant,{legacy:this.scene.legacyAccessories,mode});
    const group=node('div','ao-break-pose');group.dataset.pose=body.pose;const imgs=[];
    for(const [role,paths] of [['back',acc.back.map(a=>a.path)],['body',[body.path??body.frames?.[0]]],['front',acc.front.map(a=>a.path)]]) for(const path of paths.filter(Boolean)) {
      const img=node('img','');img.dataset.layer=role;img.alt='';img.draggable=false;img.src=resolveUrl(path,this.scene.assetBase);group.append(img);imgs.push(img);
    }
    await Promise.all(imgs.map(i=>i.decode()));if(this.disposed || version!==this.version)return;
    this.body.replaceChildren(group);this.pose=body;this.anchor=this.step?.anchor==='seat'?(body.seatAnchor??body.anchor):body.anchor;this.position(this.point);
    const h=body.fxAnchor??body.handAnchor??body.anchor;this.fx.style.setProperty('--fx-x',h.x+'px');this.fx.style.setProperty('--fx-y',h.y+'px');
    const floor=body.anchor;this.fx.style.setProperty('--floor-x',floor.x+'px');this.fx.style.setProperty('--floor-y',floor.y+'px');
    group.style.width=body.canvas.w+'px';group.style.height=body.canvas.h+'px';
  }
  tick(now) {
    this.host.sync();
    if(this.pose && this.accessoryMode!==this.root.dataset.theme)void this.setPose(this.pose.pose).catch(()=>{});
    if(this.pendingStep && now>=this.pendingStep.at){const pending=this.pendingStep;this.pendingStep=null;this.point=pending.point;this.applyStep(pending.step,now);}
    if(this.step?.loopMs && !this.scene.reducedMotion) {
      const i=Math.floor((now-this.since)/this.step.loopMs)%this.step.poses.length;
      if(i!==this.frame) {this.frame=i;this.setPose(this.step.poses[i]);}
    }
  }
  show(reduced,ms){this.host.show(reduced,ms);}
  hide(reduced,ms){this.host.hide(reduced,ms);}
  applyStep(step,now) {
    this.step=step;this.since=now;this.frame=0;this.actor.dataset.step=step.id;this.actor.dataset.fx=step.fx??'';
    this.actor.style.transition='none';
    // Drop the standing raster before changing its floor contact to a bench hip.
    if(this.pose && !!this.pose.seatAnchor !== (step.anchor==='seat'))this.body.replaceChildren();
    return this.setPose(step.poses[0]);
  }
  move(step,ms) {
    if(this.disposed)return;this.pendingStep=null;this.root.dataset.step=step.id;
    this.host.caption.textContent=step.label?.[locale()]??tr('egg.step.'+step.id);this.host.sync();
    const p=this.host.def.points[step.point]??this.point,now=this.scene.now();
    if(this.step?.anchor==='seat' && step.anchor!=='seat')this.point=this.host.def.points[this.step.approach]??this.point;
    const floor=step.anchor==='seat'?(this.host.def.points[step.approach]??p):p;
    const moving=Math.hypot(p.x-this.point.x,p.y-this.point.y)>1;
    if(moving && !this.scene.reducedMotion) {
      const walkMs=Math.min(ms*.30,1400),walkPose=step.id==='leave'?step.poses[0]:p.x>this.point.x?'walking-se':'walking';
      const walking=this.applyStep({id:'enter',poses:[walkPose]},now);
      this.pendingStep={at:now+walkMs,step,point:p};
      walking.then(()=>{
        if(this.disposed || this.pendingStep?.step!==step)return;
        this.actor.style.transition='left '+walkMs+'ms linear,top '+walkMs+'ms linear';this.position(floor);
      });
    } else {this.point=p;this.applyStep(step,now);}
  }
  destroy(){if(this.disposed)return;this.disposed=true;this.version++;this.actor.remove();this.host.release(this);}
}
