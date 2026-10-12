import { buildQuery } from '../config.js';
import { resolveUrl } from './assets.js';
import { ACCESSORY_BUDGETS as B, checkAccessoryPack, accessoryDescriptors, accessoryPlacement } from './accessory-packs.js';
const requests = new Map(), compositions = new WeakMap();
const abortError = () => new DOMException('Accessory load cancelled','AbortError');
async function bytes(response,limit,signal) {
  if(!response.ok)throw Error('accessory asset '+response.status);
  if(Number(response.headers.get('content-length'))>limit) {await response.body?.cancel();throw Error('accessory asset exceeds budget');}
  if(!response.body)throw Error('accessory asset body missing');
  const reader=response.body.getReader(), buffer=new Uint8Array(limit);let count=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try {
    for(;;) {
      if(signal.aborted)throw abortError();
      const {done,value}=await reader.read();if(signal.aborted)throw abortError();if(done)break;
      if(value.byteLength>limit-count)throw Error('accessory asset exceeds budget');
      buffer.set(value,count);count+=value.byteLength;
    }
    return buffer.slice(0,count);
  } catch(e) {await reader.cancel().catch(()=>{});throw e;}
  finally {signal.removeEventListener('abort',cancel);reader.releaseLock();}
}
function prune() {
  for(const [url,e] of requests) {
    if(requests.size<=64)break;
    if(e.done && !e.users)requests.delete(url);
  }
}
async function shared(url,limit,decode,signal) {
  if(signal?.aborted)throw abortError();
  let e=requests.get(url);
  if(e?.controller.signal.aborted) {requests.delete(url);e=null;}
  if(!e) {
    e={controller:new AbortController(),users:0,done:false};requests.set(url,e);
    e.promise=Promise.resolve().then(()=>fetch(url,{signal:e.controller.signal}))
      .then(r=>bytes(r,limit,e.controller.signal)).then(decode)
      .then(value=>{e.done=true;return value;})
      .catch(error=>{if(requests.get(url)===e)requests.delete(url);throw error;});
  }
  e.users++;let cancel;
  try {
    const cancelled=new Promise((_,reject)=>{cancel=()=>reject(abortError());signal?.addEventListener('abort',cancel,{once:true});});
    const value=await Promise.race([e.promise,cancelled]);if(signal?.aborted)throw abortError();
    if(requests.get(url)===e) {requests.delete(url);requests.set(url,e);}return value;
  } finally {
    signal?.removeEventListener('abort',cancel);
    if(--e.users===0 && !e.done) {e.controller.abort();if(requests.get(url)===e)requests.delete(url);}
    prune();
  }
}
const sourceImage=async data=>{
  const url=URL.createObjectURL(new Blob([data],{type:'image/webp'})), image=new Image();
  try {image.src=url;await image.decode();return image;} finally {URL.revokeObjectURL(url);}
};
async function metadata(index,accessory,assetBase,signal) {
  const pack=await shared(resolveUrl(accessory.packManifest,assetBase)+buildQuery,B.metadata,data=>{
    const p=JSON.parse(new TextDecoder().decode(data)),shape=checkAccessoryPack(p,{id:accessory.packId,metadataBytes:data.length});
    if(!shape.ok)throw Error('accessory pack invalid: '+shape.errors.join('; '));return p;
  },signal);
  const base=accessory.packManifest.replace(/manifest\.json$/,'');
  const descriptors=accessoryDescriptors(pack,base),known=[...index.accessories.values()].filter(a=>a.packId===pack.id);
  if(known.length!==descriptors.length || descriptors.some(a=>{
    const k=index.accessories.get(a.id);return !k || ['packId','packManifest','names','slot','thumbnail','supportedModels'].some(f=>JSON.stringify(k[f])!==JSON.stringify(a[f]));
  }))throw Error('accessory enabled registry mismatch');
  return {pack,base};
}
function compose(item,record,image,pose) {
  const placement=accessoryPlacement(item,record), canvases={};
  const context=layer=>{
    if(!canvases[layer]) {const c=document.createElement('canvas');c.width=192;c.height=288;canvases[layer]=c;}
    return canvases[layer].getContext('2d');
  };
  for(const p of placement.pieces) {
    const draw=(layer,from,to)=>{
      const ctx=context(layer),[sx,sy,w,h]=p.rect??[0,0,...placement.view.size];
      ctx.save();ctx.translate(...p.dest);ctx.scale(p.scale,p.scale);
      if(from!==null) {ctx.beginPath();ctx.rect(-p.origin[0],from-p.origin[1],w,to-from);ctx.clip();}
      ctx.drawImage(image,sx,sy,w,h,-p.origin[0],-p.origin[1],w,h);ctx.restore();
    };
    if(p.split!==null) {
      const line=placement.view.size[1]*p.split;
      draw('back',0,line);draw('front',line,placement.view.size[1]);
    } else draw(p.layer,null,null);
  }
  if(canvases.front) {
    const ctx=canvases.front.getContext('2d');ctx.globalCompositeOperation='destination-out';
    // Interaction hands sit in front of worn gear, using the same canonical mask
    // size as the existing character export pipeline.
    for(let i=17;i<=19;i+=2) {
      if(record[i]<=0 || record[i+1]<=0 || !/phone|drink|wipe|smoke|thinking|celebrating|wave|highfive|stretch|curl|bench|light|crush|shake/.test(pose))continue;
      ctx.beginPath();ctx.ellipse(record[i],record[i+1],17,20,0,0,Math.PI*2);ctx.fill();
    }
  }
  return Object.fromEntries(Object.entries(canvases).map(([layer,c])=>[layer,c.toDataURL('image/png')]));
}
function cacheFor(index) {
  let cache=compositions.get(index);if(!cache) {cache=new Map();compositions.set(index,cache);}return cache;
}
export async function prepareAccessoryLayers(index,look,pose,assetBase,{signal,mode='day'}={}) {
  if(signal?.aborted)throw abortError();mode=mode==='night'?'night':'day';
  const cache=cacheFor(index), model=look.character+(look.variant?'/'+look.variant:'');
  await Promise.all((look.accessories??[]).map(async id=>{
    const accessory=index.accessories.get(id);if(!accessory?.packManifest)return;
    const key=JSON.stringify([id,model,pose,mode]);
    if(cache.has(key)) {const e=cache.get(key);cache.delete(key);cache.set(key,e);return;}
    const {pack,base}=await metadata(index,accessory,assetBase,signal),item=pack.items.find(a=>a.id===id);
    const fallbackVariant=index.characters.get(look.character)?.variants?.[0]?.id;
    const records=pack.fits[model]?.[pose]??(look.variant ? null : pack.fits[look.character+'/'+fallbackVariant]?.[pose])??pack.fits[look.character]?.[pose];
    if(!records) return;
    const frames=await Promise.all(records.map(async record=>{
      const {view,pieces}=accessoryPlacement(item,record);if(!pieces.length)return {};
      const image=await shared(resolveUrl(base+view[mode],assetBase)+buildQuery,B.sprite,sourceImage,signal);
      if(image.naturalWidth!==view.size[0] || image.naturalHeight!==view.size[1])throw Error('accessory source dimensions mismatch');
      return compose(item,record,image,pose);
    }));
    if(signal?.aborted)throw abortError();
    const poses=(accessory.layers??={})[model]??= {}, pair=poses[pose]??={modes:{}};
    const layer={...frames[0],...(frames.length>1 && {frames})};pair.modes[mode]=layer;
    cache.delete(key);cache.set(key,{accessory,model,pose,mode,pair});
    while(cache.size>256) {
      const [old,e]=cache.entries().next().value;cache.delete(old);
      delete e.pair.modes[e.mode];if(!Object.keys(e.pair.modes).length)delete e.accessory.layers[e.model][e.pose];
    }
  }));
}
export async function prepareSceneAccessories(scene,c,pose,mode) {
  if(!scene._alive(c) || c.renderedPose!==pose)return;
  const look=c.occ.look,key=JSON.stringify([look,pose,mode]);
  const model=look.character+(look.variant?'/'+look.variant:'');
  const ready=look.accessories.every(id=>{const a=scene.index.accessories.get(id);return !a?.packManifest || a.layers?.[model]?.[pose]?.modes?.[mode];});
  if(c.accessoryKey===key && (ready || c.accessoryPending))return;
  c.accessoryKey=key;
  c.accessoryPending=true;
  try {
    await prepareAccessoryLayers(scene.index,look,pose,scene.assetBase,{mode});
    if(scene._alive(c) && c.accessoryKey===key && JSON.stringify(c.occ.look)===JSON.stringify(look) && c.renderedPose===pose)scene._renderPose(c);
  } catch(e) {if(c.accessoryKey===key)c.accessoryKey=null;}
  finally {if(c.accessoryKey===key)c.accessoryPending=false;}
}
