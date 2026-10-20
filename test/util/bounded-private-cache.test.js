'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createBoundedPrivateCache}=require('../../src/util/bounded-private-cache');

test('bounded private cache enforces LRU entry and byte budgets, expires by TTL, and clears on close',()=>{
  let time=100;const cache=createBoundedPrivateCache({maxEntries:2,maxBytes:8,maxEntryBytes:8,ttlMs:10,now:()=>time,sizeOf:value=>Buffer.byteLength(value)});
  assert.equal(cache.set('a','1234'),true);assert.equal(cache.set('b','5678'),true);
  assert.equal(cache.get('a'),'1234','reads refresh LRU order');
  assert.equal(cache.set('c','abcd'),true);assert.equal(cache.get('b'),undefined,'least recently used entry is evicted');
  assert.equal(cache.byteLength,8);assert.equal(cache.set('too-large','012345678'),false,'an entry larger than the byte budget is never retained');
  time+=11;assert.equal(cache.size,0,'expired transcript data is removed on access');
  cache.set('private','data');cache.close();assert.equal(cache.size,0);assert.equal(cache.byteLength,0,'shutdown clears all retained bytes');assert.equal(cache.set('after-close','x'),false);
});
