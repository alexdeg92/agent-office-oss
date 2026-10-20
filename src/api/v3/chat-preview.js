'use strict';
const fs=require('node:fs');
const path=require('node:path');

const MAX_PREVIEW_BYTES=4*1024*1024;
const MAX_PREVIEW_PIXELS=16*1024*1024;
const MAX_HEADER_BYTES=64*1024;
const MAX_AGE_MS=30*86400000;
const dimensionsCache=new Map();

function previewEligible(item,at=Date.now()){
  if(!item||item.state==='staged'||!/^image\/(?:png|jpeg|gif|webp)$/.test(String(item.mime_type||''))||
    !Number.isSafeInteger(item.byte_size)||item.byte_size<1||item.byte_size>MAX_PREVIEW_BYTES)return false;
  const relevantAt=item.state==='consumed'?item.consumed_at:item.created_at;
  return Number.isSafeInteger(relevantAt)&&relevantAt>at-MAX_AGE_MS;
}

function dimensionsFromHeader(data,mime){
  let width=0,height=0;
  if(mime==='image/png'&&data.length>=24&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&data.toString('ascii',12,16)==='IHDR'){
    width=data.readUInt32BE(16);height=data.readUInt32BE(20);
  }else if(mime==='image/gif'&&data.length>=10&&/^GIF8[79]a$/.test(data.toString('ascii',0,6))){
    width=data.readUInt16LE(6);height=data.readUInt16LE(8);
  }else if(mime==='image/webp'&&data.length>=30&&data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP'){
    const chunk=data.toString('ascii',12,16);
    if(chunk==='VP8X'){width=1+data.readUIntLE(24,3);height=1+data.readUIntLE(27,3);}
    else if(chunk==='VP8L'&&data[20]===0x2f){width=1+data[21]+((data[22]&0x3f)<<8);height=1+((data[22]>>6)&3)+(data[23]<<2)+((data[24]&0x0f)<<10);}
    else if(chunk==='VP8 '){for(let i=20;i+7<data.length;i++)if(data[i]===0x9d&&data[i+1]===0x01&&data[i+2]===0x2a){width=data.readUInt16LE(i+3)&0x3fff;height=data.readUInt16LE(i+5)&0x3fff;break;}}
  }else if(mime==='image/jpeg'&&data.length>=4&&data[0]===0xff&&data[1]===0xd8){
    let offset=2;
    while(offset+4<data.length){
      if(data[offset++]!==0xff)continue;
      while(offset<data.length&&data[offset]===0xff)offset++;
      if(offset>=data.length)break;
      const marker=data[offset++];if(marker===0xd9||marker===0xda)break;
      if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
      if(offset+2>data.length)break;const length=data.readUInt16BE(offset);if(length<2||offset+length>data.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
        if(length>=7){height=data.readUInt16BE(offset+3);width=data.readUInt16BE(offset+5);}break;
      }
      offset+=length;
    }
  }
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>MAX_PREVIEW_PIXELS||height>MAX_PREVIEW_PIXELS||width*height>MAX_PREVIEW_PIXELS)return null;
  return {width,height};
}

function imageDimensions(dataDir,item){
  const cacheKey=item?.storage_name;
  if(typeof cacheKey!=='string'||! /^[a-f0-9]{64}$/.test(cacheKey))return null;
  const cached=dimensionsCache.get(cacheKey);if(cached?.size===item.byte_size&&cached?.sha256===item.sha256)return cached.dimensions;
  let fd;
  try{
    const root=path.join(fs.realpathSync(dataDir),'chat-attachments');
    const rootStat=fs.lstatSync(root);if(rootStat.isSymbolicLink()||!rootStat.isDirectory()||(rootStat.mode&0o077)!==0||fs.realpathSync(root)!==root)return null;
    fd=fs.openSync(path.join(root,cacheKey),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|(fs.constants.O_NONBLOCK||0));
    const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size!==item.byte_size||(stat.mode&0o077)!==0)return null;
    const bytes=Buffer.alloc(Math.min(stat.size,MAX_HEADER_BYTES));const read=fs.readSync(fd,bytes,0,bytes.length,0);
    const dimensions=dimensionsFromHeader(bytes.subarray(0,read),item.mime_type);
    dimensionsCache.set(cacheKey,{size:item.byte_size,sha256:item.sha256,dimensions});
    if(dimensionsCache.size>512)dimensionsCache.delete(dimensionsCache.keys().next().value);
    return dimensions;
  }catch{return null;}finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}

function previewAllowed(dataDir,item,at=Date.now()){
  return previewEligible(item,at)&&!!imageDimensions(dataDir,item);
}

function createPreviewReadLimiter({globalLimit=4,ownerLimit=2}={}){
  let active=0;const owners=new Map();
  return {
    acquire(owner){
      const current=owners.get(owner)||0;if(active>=globalLimit||current>=ownerLimit)return null;
      active++;owners.set(owner,current+1);let released=false;
      return ()=>{if(released)return;released=true;active=Math.max(0,active-1);const next=Math.max(0,(owners.get(owner)||1)-1);if(next)owners.set(owner,next);else owners.delete(owner);};
    },
    counts(){return {global:active,owners:new Map(owners)};}
  };
}

module.exports={MAX_PREVIEW_BYTES,MAX_PREVIEW_PIXELS,MAX_HEADER_BYTES,previewEligible,imageDimensions,previewAllowed,dimensionsFromHeader,createPreviewReadLimiter};
