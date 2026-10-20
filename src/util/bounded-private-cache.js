'use strict';

const byteSize=value=>Buffer.byteLength(JSON.stringify(value)??'null','utf8');

function createBoundedPrivateCache({maxEntries=64,maxBytes=2*1024*1024,maxEntryBytes=512*1024,ttlMs=5*60*1000,now=()=>Date.now(),sizeOf=byteSize}={}){
  const entries=new Map();let bytes=0,closed=false;
  const remove=key=>{const entry=entries.get(key);if(!entry)return false;entries.delete(key);bytes-=entry.bytes;return true;};
  const pruneExpired=()=>{const at=now();for(const [key,entry] of entries)if(entry.expiresAt<=at)remove(key);};
  const expiryTimer=ttlMs>0?setInterval(pruneExpired,Math.max(50,Math.min(ttlMs,60_000))):null;expiryTimer?.unref?.();
  return Object.freeze({
    get(key){if(closed)return undefined;pruneExpired();const entry=entries.get(key);if(!entry)return undefined;entries.delete(key);entries.set(key,entry);return entry.value;},
    set(key,value){
      if(closed)return false;
      pruneExpired();remove(key);let size;
      try{size=sizeOf(value);}catch{return false;}
      if(!Number.isSafeInteger(size)||size<0||size>maxEntryBytes||size>maxBytes||maxEntries<1||ttlMs<=0)return false;
      entries.set(key,{value,bytes:size,expiresAt:now()+ttlMs});bytes+=size;
      while(entries.size>maxEntries||bytes>maxBytes)remove(entries.keys().next().value);
      return entries.has(key);
    },
    delete:remove,
    clear(){entries.clear();bytes=0;},
    close(){if(closed)return;closed=true;if(expiryTimer)clearInterval(expiryTimer);entries.clear();bytes=0;},
    get size(){pruneExpired();return entries.size;},
    get byteLength(){pruneExpired();return bytes;},
  });
}

module.exports={createBoundedPrivateCache};
