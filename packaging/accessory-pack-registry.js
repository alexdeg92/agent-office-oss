'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readPackFile } = require('./character-pack-read');
const { webpSize } = require('./validate-character-pack');
const { ACCESSORY_BUDGETS: B, checkAccessoryPack, accessoryDescriptors } = require('../public/v2/office/accessory-packs');
function validateAccessoryPack(pack, root, metadataBytes = Buffer.byteLength(JSON.stringify(pack))) {
  const shape = checkAccessoryPack(pack,{metadataBytes});
  if (!shape.ok) return {...shape,bytes:metadataBytes};
  const rootReal=fs.realpathSync(root), files=new Map(), errors=[];
  const asset=(file,size,limit)=>{
    try {
      const absolute=fs.realpathSync(path.resolve(rootReal,file));
      if (!absolute.startsWith(rootReal+path.sep)) throw Error('path escapes accessory pack');
      const buffer=readPackFile(absolute,limit,'accessory raster exceeds budget'), dims=webpSize(buffer);
      if (!dims || dims.some((n,i)=>n!==size[i])) throw Error('invalid WebP/dimensions');
      files.set(absolute,buffer.length);
    } catch(e) {errors.push(file+': '+e.message);}
  };
  for(const a of pack.items) {
    asset(a.thumbnail,a.thumbnailSize,B.thumbnail);
    for(const v of Object.values(a.views)) for(const mode of ['day','night']) asset(v[mode],v.size,B.sprite);
  }
  const bytes=metadataBytes+[...files.values()].reduce((a,b)=>a+b,0);
  if(bytes>B.pack)errors.push('accessory pack exceeds total budget');
  return {ok:!errors.length,errors,bytes,files:files.size};
}
function requireAccessoryRegistry(root,enabled,reserved=[]) {
  if(!Array.isArray(enabled) || enabled.some(id=>typeof id!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(id)) || new Set(enabled).size!==enabled.length)throw Error('invalid accessory enabled list');
  const items=[],seen=new Set(reserved);
  for(const id of enabled) {
    const dir=path.join(root,id),buffer=readPackFile(path.join(dir,'manifest.json'),B.metadata,'accessory metadata exceeds budget'),pack=JSON.parse(buffer.toString('utf8'));
    if(pack.id!==id)throw Error('accessory pack directory/id mismatch');
    const valid=validateAccessoryPack(pack,dir,buffer.length);
    if(!valid.ok)throw Error('accessory pack '+id+': '+valid.errors.join('; '));
    for(const a of accessoryDescriptors(pack,'assets/Accessories/'+id+'/')) {
      if(seen.has(a.id))throw Error('duplicate/reserved accessory: '+a.id);
      seen.add(a.id);items.push(a);
    }
  }
  return items;
}
module.exports={validateAccessoryPack,requireAccessoryRegistry};
