'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ensureDecorPack } = require('../../public/v2/office/decor-pack-loader');
const { decorDescriptors, DECOR_BUDGETS } = require('../../public/v2/office/decor-packs');
const pack = JSON.parse(fs.readFileSync(require('node:path').resolve(__dirname, '../../design/assets/Decor/style-preview/manifest.json')));
const makeIndex = () => ({ furniture: new Map(decorDescriptors(pack,'assets/Decor/style-preview/').map(f => [f.id,f])) });
const text = JSON.stringify(pack);
const until = async fn => { for(let i=0;i<100&&!fn();i++) await new Promise(r=>setTimeout(r,1)); assert.ok(fn()); };

test('two independent indexes share a single bounded metadata request; no sprite prefetch', async () => {
  const original = global.fetch, urls = [];
  global.fetch = async url => { urls.push(url); return new Response(text); };
  try {
    const a=makeIndex(),b=makeIndex();
    await Promise.all([ensureDecorPack(a,pack.items[0].id,'/dedupe/'),ensureDecorPack(b,pack.items[1].id,'/dedupe/')]);
    assert.equal(urls.length,1);assert.match(urls[0],/manifest\.json$/);
    assert.ok([...a.furniture.values()].every(f=>f.packLoaded));
    assert.ok([...b.furniture.values()].every(f=>f.packLoaded));
  } finally {global.fetch=original;}
});
test('cancelling one consumer does not cancel the other or install into the cancelled index',async()=>{
  const original=global.fetch;let resolve,signal;
  global.fetch=(_,options)=>{signal=options.signal;return new Promise(r=>{resolve=r;});};
  try {
    const a=makeIndex(),b=makeIndex(),controller=new AbortController();
    const first=ensureDecorPack(a,pack.items[0].id,'/shared-cancel/',{signal:controller.signal});
    const second=ensureDecorPack(b,pack.items[0].id,'/shared-cancel/');
    const rejected=assert.rejects(first,{name:'AbortError'});
    await until(()=>resolve);controller.abort();await rejected;
    assert.equal(signal.aborted,false);resolve(new Response(text));await second;
    assert.ok([...a.furniture.values()].every(f=>!f.packLoaded));
    assert.ok([...b.furniture.values()].every(f=>f.packLoaded));
  }finally{global.fetch=original;}
});
test('releasing every consumer aborts fetch; retry starts a fresh request',async()=>{
  const original=global.fetch;let calls=0,held;
  global.fetch=(_,options)=>{calls++;if(calls>1)return Promise.resolve(new Response(text));return new Promise((resolve,reject)=>{held=options.signal;held.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')));});};
  try {
    const index=makeIndex(),controller=new AbortController();
    const first=ensureDecorPack(index,pack.items[0].id,'/all-cancel/',{signal:controller.signal});
    const rejection=assert.rejects(first,{name:'AbortError'});await until(()=>held);controller.abort();await rejection;
    assert.ok(held.aborted);assert.ok(!index.furniture.get(pack.items[0].id).packLoaded);
    await ensureDecorPack(index,pack.items[0].id,'/all-cancel/');assert.equal(calls,2);
  }finally{global.fetch=original;}
});
test('streamed metadata is admitted by raw bytes before parsing even with a false Content-Length',async()=>{
  const original=global.fetch;let cancelled=false;
  global.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(DECOR_BUDGETS.metadata));c.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}}),{headers:{'content-length':'1'}});
  try {
    const index=makeIndex();await assert.rejects(ensureDecorPack(index,pack.items[0].id,'/oversize/'),/exceeds budget/);
    assert.ok(cancelled);assert.ok([...index.furniture.values()].every(f=>!f.packLoaded));
  }finally{global.fetch=original;}
});
test('malformed pack geometry cannot partially install; next load can retry',async()=>{
  const original=global.fetch;let calls=0;
  const bad=structuredClone(pack);bad.items.at(-1).anchor.y++;
  global.fetch=async()=>new Response(JSON.stringify(++calls===1?bad:pack));
  try {
    const index=makeIndex();await assert.rejects(ensureDecorPack(index,pack.items[0].id,'/bad-geometry/'),/geometry mismatch/);
    assert.ok([...index.furniture.values()].every(f=>!f.packLoaded));
    await ensureDecorPack(index,pack.items[0].id,'/bad-geometry/');assert.ok(index.furniture.get(pack.items[0].id).packLoaded);
  }finally{global.fetch=original;}
});
