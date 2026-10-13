import { chunkError } from '../build-update.js';
// Lazy authenticated animation sandbox. Reads one LayoutVM; never subscribes to office/cues or writes an API.
import { html, useState, useEffect, useRef, useMemo } from '../lib.js';
import { services } from '../services.js';
import { config, buildQuery } from '../config.js';
import { msg, onLang, getLang } from '../i18n.js';
import { registerMessages, MESSAGES } from '../messages.js';
import * as messages from './animations-messages.js';
import { applyTheme, theme } from '../theme.js';
import { timeZone } from '../fmt.js';
import { officeApi, shippedLayoutVM } from './layout-source.js';
import { indexManifest } from './assets.js';
import { OfficeScene } from './scene.js';
import { planAnnexes } from './annex.js';
import { labelOf, s as tr } from './strings.js';
import { STATES, animationEntries, changeTestState, createAnimationPlayer } from './animation-tools.js';
import { watchLife } from './life.js';
import { lookChoices, headChoices, readAnimationQuery, animationQuery, testOccupants, agentLetters } from './animations-model.js';
registerMessages(messages);
const assetBase=()=>services.officeAssetBase??config.assetBase;
const queryKey=q=>JSON.stringify(Object.entries(q).filter(([,v])=>v!=null).map(([k,v])=>[k,String(v)]).sort(([a],[b])=>a.localeCompare(b)));
const name=n=>msg('animations.agent',{name:n});
const entryName=e=>{if(Object.hasOwn(MESSAGES[getLang()],'animations.'+e.kind+'.'+e.id))return msg('animations.'+e.kind+'.'+e.id);const key=e.kind==='activity'?'life.'+e.id:e.kind==='egg'?'egg.'+e.id:e.kind==='reaction'?'reaction.'+e.id:'cue.'+e.id;const label=tr(key);return label===key?e.id:label;};
const styles=['./office.css','./animations.css'].map(p=>new URL(p+buildQuery,import.meta.url).href);
async function readLayout() {
  try {return await officeApi().get();}catch(err){
    if(err?.status!==404 && err?.code!=='not_found')throw err;
    const read=n=>fetch(assetBase()+'office/'+n+'.example.json'+buildQuery).then(r=>{if(!r.ok)throw Error(String(r.status));return r.json();});
    const [m,d]=await Promise.all([read('manifest'),read('layout')]);return shippedLayoutVM(m,d,Date.now(),timeZone());
  }
}
export function AnimationsPage({match}) {
  const [loaded,setLoaded]=useState({}),[attempt,retry]=useState(0),[lang,setLang]=useState(getLang());
  useEffect(()=>onLang(setLang),[]);
  useEffect(()=>{for(const href of styles){if(document.querySelector(`link[data-animations="${href}"]`))continue;const l=document.createElement('link');l.rel='stylesheet';l.href=href;l.dataset.animations=href;l.onerror=()=>chunkError(Error('Animation stylesheet unavailable'));document.head.append(l);}},[]);
  useEffect(()=>{let alive=true;setLoaded({});readLayout().then(lay=>alive&&setLoaded({lay}),error=>alive&&setLoaded({error}));return()=>{alive=false;};},[attempt]);
  if(!loaded.lay)return html`<div class="bu-page"><p role="status">${msg(loaded.error?'animations.failed':'animations.loading')}</p>${loaded.error?html`<button class="bu-btn" onClick=${()=>retry(n=>n+1)}>${msg('animations.retry')}</button>`:null}</div>`;
  return html`<${Sandbox} lay=${loaded.lay} match=${match} lang=${lang}/>`;
}
function Sandbox({lay,match,lang}) {
  const index=useMemo(()=>indexManifest(lay.manifest),[lay.manifest]);
  const [cfg,setCfg]=useState(()=>readAnimationQuery(match.query,index,lay)),[reset,setReset]=useState(0),[ready,setReady]=useState(0),[playToken,setPlayToken]=useState(0);
  const [status,setStatus]=useState({phase:'ready'}),scenes=useRef(new Map()),lastPlay=useRef('');
  const ownQueries=useRef(new Set()),lastQuery=useRef(queryKey(match.query));
  const choices=lookChoices(index),row=cfg.agents[cfg.selected],entries=animationEntries();
  const occupants=testOccupants(cfg,index,lay.layout.data,Date.now(),name);
  const plan=planAnnexes(index,lay.layout.data,occupants);
  const update=patch=>setCfg(old=>({...old,...patch}));
  const patchAgent=(i,patch)=>setCfg(old=>({...old,agents:old.agents.map((a,j)=>j===i?{...a,...patch}:a)}));
  useEffect(()=>{
    const key=queryKey(match.query);if(key===lastQuery.current)return;lastQuery.current=key;
    if(ownQueries.current.delete(key))return;
    setCfg(readAnimationQuery(match.query,index,lay));
  },[JSON.stringify(match.query)]);
  useEffect(()=>{
    const q=animationQuery(cfg),patch={...q};
    for(const k of Object.keys(match.query))if(/^(look|etat|accessoire)\d+$/.test(k)&&!(k in q))patch[k]=null;
    const same=Object.entries(patch).every(([k,v])=>v==null?!match.query[k]:String(v)===String(match.query[k]));
    if(!same){
      const next={...match.query,...patch};for(const k of Object.keys(next))if(next[k]==null)delete next[k];
      ownQueries.current.add(queryKey(next));if(ownQueries.current.size>32)ownQueries.current.delete(ownQueries.current.values().next().value);
      services.router.setQuery(patch);
    }
  },[JSON.stringify(cfg)]);
  useEffect(()=>{applyTheme(cfg.uiTheme??theme.get().pref);return()=>applyTheme(theme.get().pref);},[cfg.uiTheme]);
  const attach=(key,scene,player)=>{if(scene){scenes.current.set(key,{scene,player});setReady(n=>n+1);}else scenes.current.delete(key);};
  const selectedId='animation-agent-'+(cfg.selected+1),partnerId='animation-agent-'+(cfg.partner+1);
  const selectedScene=()=>[...scenes.current.values()].find(x=>x.scene.chars.has(selectedId));
  const play=all=>{
    for(const x of scenes.current.values())x.player.stop();
    const target=selectedScene();if(!target)return;
    const entry=entries.find(e=>e.key===cfg.anim||e.id===cfg.anim);
    target.player.play(selectedId,all?animationEntries():entry?[entry]:[],{partnerId,weather:cfg.rain?'rain':'clear'});
  };
  useEffect(()=>{
    const key=selectedId+'|'+cfg.anim+'|'+playToken+'|'+reset;
    if(!cfg.anim||key===lastPlay.current||!selectedScene())return;
    lastPlay.current=key;play(cfg.anim==='tout');
  },[ready,cfg.anim,cfg.selected,playToken,reset]);
  const prepare=(scene,id,entry,options)=>{
    const ids=[id,...(entry.partner?[options.partnerId]:[])];
    changeTestState(scene,ids,'idle');
    setCfg(old=>({...old,agents:old.agents.map((a,i)=>ids.includes('animation-agent-'+(i+1))?{...a,state:'idle'}:a)}));
  };
  const register=(key,scene)=>{
    const player=createAnimationPlayer(scene,{onStatus:setStatus,prepare:(...args)=>prepare(scene,...args)});
    attach(key,scene,player);return()=>{player.destroy();attach(key,null);};
  };
  const countChanged=value=>{const n=Math.max(1,Math.min(100,Math.floor(Number(value)||1)));setCfg(old=>({...old,selected:Math.min(old.selected,n-1),partner:Math.min(old.partner,n-1),agents:Array.from({length:n},(_,i)=>old.agents[i]??{look:choices[i%choices.length].key,accessory:'',state:'idle'})}));};
  const resetAll=()=>{for(const x of scenes.current.values())x.player.stop();lastPlay.current='';setCfg(old=>({...old,anim:'',agents:old.agents.map(a=>({...a,state:'idle'}))}));setStatus({phase:'ready'});setReset(n=>n+1);};
  const statusText=msg('animations.'+status.phase,{name:status.entry?entryName(status.entry):''});
  const heads=headChoices(index,(choices.find(c=>c.key===row.look)??choices[0]).look);
  return html`<div class="bu-page ao-animations" lang=${lang}>

    <div class="ao-animations-grid">
      <div class="ao-animations-scenes">
        <${SandboxStage} key=${'office:'+reset} layout=${lay.layout.data} manifest=${lay.manifest} occupants=${plan.office} cfg=${cfg} selectedId=${selectedId} register=${scene=>register('office',scene)} onSelect=${id=>update({selected:Number(id.split('-').pop())-1})}/>
        ${plan.annexes.map(a=>html`<section key=${a.id+':'+reset}><h2 class="bu-card__title">${msg('animations.annex',{n:a.n})}</h2><${SandboxStage} layout=${a.layout} manifest=${lay.manifest} occupants=${a.occupants} cfg=${cfg} selectedId=${selectedId} register=${scene=>register(a.id,scene)} onSelect=${id=>update({selected:Number(id.split('-').pop())-1})}/></section>`)}
        <p class="ao-animations-status bu-text-secondary" role="status" aria-live="polite">${statusText}</p>
      </div>
      <aside class="bu-card ao-animations-panel" aria-label=${msg('animations.title')}>
        <fieldset><legend>${msg('animations.agents')}</legend>
          <label>${msg('animations.count')}<input data-test-count type="number" class="bu-input" min="1" max="100" value=${cfg.agents.length} onChange=${e=>countChanged(e.target.value)}/></label>
          <label>${msg('animations.selected')}<select class="bu-input" data-test-agent value=${cfg.selected} onChange=${e=>update({selected:Number(e.target.value)})}>${cfg.agents.map((a,i)=>html`<option value=${i}>${name(agentLetters(i))}</option>`)}</select></label>
          <label>${msg('animations.look')}<select class="bu-input" data-test-look value=${row.look} onChange=${e=>patchAgent(cfg.selected,{look:e.target.value})}>${choices.map(c=>html`<option value=${c.key}>${labelOf(c.c,'character')}${c.v?' · '+labelOf(c.v,'variant'):''}</option>`)}</select></label>
          <label>${msg('animations.accessory')}<select class="bu-input" data-test-accessory value=${row.accessory} onChange=${e=>patchAgent(cfg.selected,{accessory:e.target.value})}><option value="">${msg('animations.none')}</option>${heads.map(a=>html`<option value=${a.id}>${labelOf(a.a,'accessory')}</option>`)}</select></label>
        </fieldset>
        <fieldset><legend>${msg('animations.state')}</legend><select class="bu-input" data-test-state aria-label=${msg('animations.state')} value=${row.state} onChange=${e=>patchAgent(cfg.selected,{state:e.target.value})}>${STATES.map(s=>html`<option value=${s}>${tr('state.'+s)}</option>`)}</select></fieldset>
        <fieldset><legend>${msg('animations.animations')}</legend>
          <label>${msg('animations.partner')}<select class="bu-input" data-test-partner value=${cfg.partner} onChange=${e=>update({partner:Number(e.target.value)})}>${cfg.agents.map((a,i)=>html`<option value=${i} disabled=${i===cfg.selected}>${name(agentLetters(i))}</option>`)}</select></label>
          ${['activity','reaction','egg','cue'].map(kind=>html`<div class="ao-animations-group"><h3>${msg('animations.'+kind)}</h3><div class="ao-animations-buttons">${entries.filter(e=>e.kind===kind).map(e=>html`<button type="button" class="bu-btn bu-btn--sm" data-animation=${e.key} disabled=${e.partner&&(cfg.agents.length<2||cfg.partner===cfg.selected)} onClick=${()=>{update({anim:e.key});setPlayToken(n=>n+1);}}>${entryName(e)}</button>`)}</div></div>`)}
        </fieldset>
        <fieldset><legend>${msg('animations.ambience')}</legend>
          <label>${msg('animations.moment')}<select class="bu-input" data-test-moment value=${cfg.moment} onChange=${e=>update({moment:e.target.value})}>${['auto','day','night'].map((v,i)=>html`<option value=${['auto','jour','nuit'][i]}>${msg('animations.'+v)}</option>`)}</select></label>
          <label class="ao-animations-check"><input data-test-rain type="checkbox" checked=${cfg.rain} onChange=${e=>update({rain:e.target.checked})}/>${msg('animations.rain')}</label>
          <label>${msg('animations.uiTheme')}<select class="bu-input" value=${cfg.uiTheme??theme.get().pref} onChange=${e=>update({uiTheme:e.target.value})}><option value="system">${msg('animations.auto')}</option>${['light','dark'].map(v=>html`<option value=${v}>${msg('animations.'+v)}</option>`)}</select></label>
          <label class="ao-animations-check"><input data-test-reduced type="checkbox" checked=${cfg.reduced} onChange=${e=>update({reduced:e.target.checked})}/>${msg('animations.reduced')}</label>
        </fieldset>
        <fieldset><legend>${msg('animations.playback')}</legend><div class="ao-animations-buttons"><button type="button" class="bu-btn bu-btn--primary" data-test-all onClick=${()=>{update({anim:'tout'});setPlayToken(n=>n+1);}}>${msg('animations.all')}</button><button type="button" class="bu-btn" data-test-reset onClick=${resetAll}>${msg('animations.reset')}</button></div></fieldset>
        <fieldset><legend>${msg('animations.camera')}</legend><label class="ao-animations-check"><input data-test-follow type="checkbox" checked=${cfg.follow} onChange=${e=>update({follow:e.target.checked})}/>${msg('animations.follow')}</label></fieldset>
      </aside>
    </div>
  </div>`;
}
function SandboxStage({layout,manifest,occupants,cfg,selectedId,register,onSelect}) {
  const host=useRef(null),sc=useRef(null),latest=useRef({cfg,selectedId});latest.current={cfg,selectedId};
  const signature=JSON.stringify(occupants.map(o=>({...o,stateSince:0})));
  useEffect(()=>{
    const scene=new OfficeScene(host.current,{manifest,layout,assetBase:assetBase(),theme:'auto',timeZone,
      onSelect,life:{idleAfterMs:Infinity,intervalMs:Infinity,longRunMs:Infinity},surprises:{chance:0},surprisesEnabled:()=>true});
    sc.current=scene;host.current.aoScene=scene;scene.setReducedMotion(true);scene.setOccupants(occupants);scene.setReducedMotion(cfg.reduced);
    const detach=register(scene);
    const unwatch=watchLife(()=>{
      const {cfg,selectedId}=latest.current;
      for(const c of scene.chars.values()){
        const room=c.egg?.controller?.room;if(room)room.root.dataset.weather=cfg.rain?'rain':'clear';
      }
      if(!cfg.follow)return;
      const c=scene.chars.get(selectedId);if(!c)return;
      const room=c.egg?.controller?.room;
      if(room){room.camera({zoom:1.5,x:room.point.x,y:room.point.y-100});return;}
      if(!c.head)return;
      scene.cam.user=true;scene.cam.zoom=Math.max(scene.cam.zoom,1.1);
      scene.cam.x=scene.viewport.clientWidth/2-(c.head.sx+scene.origin.x)*scene.cam.zoom;
      scene.cam.y=scene.viewport.clientHeight/2-(c.head.sy+scene.origin.y)*scene.cam.zoom;
      scene._applyCamera();
    });
    return()=>{unwatch();detach();scene.destroy();sc.current=null;};
  },[]);
  useEffect(()=>{sc.current?.setOccupants(occupants);sc.current?.select(selectedId);},[signature,selectedId]);
  useEffect(()=>{sc.current?.setTheme({jour:'day',nuit:'night',auto:'auto'}[cfg.moment]);sc.current?.setReducedMotion(cfg.reduced);},[cfg.moment,cfg.reduced]);
  useEffect(()=>{if(!cfg.follow){sc.current?.fit();for(const c of sc.current?.chars.values()??[])c.egg?.controller?.room?.camera();}},[cfg.follow]);
  return html`<div class="bu-stage ao-animations-stage" ref=${host} role="region" aria-label=${msg('animations.stage')}></div>`;
}
