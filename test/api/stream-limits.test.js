'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createStreamHub } = require('../../src/api/v2/stream');
function fixture(limits = {}, extra = {}) {
  const topics = new EventEmitter();
  let value = 0, pad = '';
  topics.parse = id => ['x','office','health'].includes(id) ? { id } : null;
  topics.current = id => ({ id, rev: value + 1, vm: { value, pad } });
  const hub = createStreamHub({ topics, engine: { sources: () => [] }, systemState: () => ({}), contractVersion: '3.0', modelVersion: 1,
    heartbeatMs: 60000, limits, ...extra });
  return { hub, topics,
    change(next = '') { pad = next; topics.emit('change', { id: 'x', rev: ++value + 1, snapshot: { value, pad } }); },
    open(sid = 'owner', last = null, res = response(), requested = 'x') {
      const req = Object.assign(new EventEmitter(), { headers: last ? { 'last-event-id': last } : {}, query: { topics: requested }, session: { sid, exp: Date.now() + 60000 } });
      hub.open(req, res); const st = [...hub._streams.values()].find(st => st.res === res);
      return { req, res, st };
    }, close() { hub.closeAll(); } };
}
function response() {
  const res = new EventEmitter(); res.lines = []; res.block = false; res.ended = false; res.writableLength = 0;
  res.writeHead = () => {};
  res.write = line => { res.lines.push(String(line)); return !res.block; };
  res.end = res.destroy = () => { res.ended = true; };
  return res;
}
test('S03-01: blocked output stops until drain and preserves frame order', () => {
  const f = fixture({ pendingBytes: 4096 });
  try {
    const { res, st } = f.open(); res.block = true; f.change(); const count = res.lines.length;
    f.change(); f.change(); assert.equal(res.lines.length, count, 'no write after false');
    assert.equal(st.snapshotWaiting.size, 1); assert.ok(st.pendingBytes + st.blockedBytes <= 4096);
    res.block = false; res.emit('drain'); assert.equal(res.lines.length, count + 1);
    assert.equal(st.pendingBytes, 0); assert.equal(st.drain, null);
    const ids = res.lines.filter(x => x.startsWith('id:')).map(x => Number(x.match(/:(\d+)\n/)[1]));
    assert.deepEqual(ids, [1, 2, 3, 4]);
    assert.match(res.lines.at(-1), /"value":3/);
  } finally { f.close(); }
});
test('S03-01: a never-draining client closes within its byte budget and resets by snapshot', () => {
  const f = fixture({ pendingBytes: 1024 });
  try {
    const { res, st } = f.open(); const last = `${st.id}:${st.seq}`; res.block = true;
    f.change('x'.repeat(300)); const count = res.lines.length;
    for (let i = 0; i < 6; i++) f.hub.toast('info', { key: 'synthetic', params: { pad: 'x'.repeat(300) } });
    assert.equal(res.lines.length, count); assert.equal(res.ended, true); assert.equal(f.hub._streams.size, 0);
    assert.equal(st.buffer.length, 0); assert.equal(st.pendingBytes, 0);
    const next = f.open('owner', last); assert.notEqual(next.st.id, st.id);
    assert.match(next.res.lines.join(''), /"resumed":false/); assert.match(next.res.lines.join(''), /event: snapshot/);
  } finally { f.close(); }
});
test('S03-01: drain wait has a deadline even without further events', async () => {
  const f = fixture({ drainMs: 20 });
  try { const { res, st } = f.open(); res.block = true; f.change(); await new Promise(r => setTimeout(r, 60));
    assert.equal(res.ended, true); assert.equal(f.hub._streams.size, 0); assert.equal(st.drain, null);
  } finally { f.close(); }
});
test('S03-01: individual oversize frames and Node writable backlog close the stream', () => {
  for (const kind of ['frame', 'node-backlog']) {
    const f = fixture({ frameBytes: 1024, pendingBytes: 1024 });
    try { const { res } = f.open(); const count = res.lines.length;
      if (kind === 'node-backlog') res.writableLength = 1024;
      if (kind === 'frame') f.hub.toast('info', { key: 'synthetic', params: { pad: 'x'.repeat(2048) } });
      else f.hub.toast('info', { key: 'synthetic' });
      assert.equal(res.lines.length, count); assert.equal(res.ended, true); assert.equal(f.hub._streams.size, 0);
    } finally { f.close(); }
  }
});
test('S03-01: session eviction and global refusal release admission without leaking timers', () => {
  const f = fixture({ perSession: 2, global: 3 });
  try { const a = f.open(), b = f.open(), c = f.open('other');
    const d = f.open(); assert.equal(a.res.ended, true); assert.equal(f.hub._streams.size, 3);
    const rejected = response(); assert.throws(() => f.open('third', null, rejected), { code: 'rate_limited' }); assert.deepEqual(rejected.lines, []);
    f.hub.revokeSession(a.req.session);
    for (const st of [a.st, b.st, d.st]) for (const timer of ['heartbeat', 'expiry', 'gc', 'drain']) assert.equal(st[timer], null);
    assert.equal(f.hub._streams.size, 1); f.open('third'); assert.equal(f.hub._streams.size, 2); assert.equal(c.res.ended, false);
  } finally { f.close(); }
});
test('critic-06: oldest disconnected slot is evicted and reconnect resyncs at the cap', () => {
  const f = fixture({ perSession: 2 });
  try { const a = f.open(), b = f.open(); a.req.emit('close'); const last = `${a.st.id}:${a.st.seq}`;
    f.open(); assert.equal(f.hub._streams.size, 2); assert.equal(f.hub._streams.has(a.st.id), false);
    b.req.emit('close'); const next = f.open('owner', last);
    assert.match(next.res.lines.join(''), /"resumed":false/); assert.equal(f.hub._streams.size, 2);
  } finally { f.close(); }
});
test('critic-06: valid resume replaces a half-open response without consuming another slot', () => {
  const f = fixture({ perSession: 1, global: 1 });
  try { const a = f.open(); const last = `${a.st.id}:${a.st.seq}`; f.change();
    const b = f.open('owner', last); assert.equal(b.st.id, a.st.id); assert.equal(a.res.ended, true);
    assert.equal(f.hub._streams.size, 1); assert.match(b.res.lines.join(''), /"resumed":true/);
    assert.match(b.res.lines.join(''), /event: snapshot/); a.req.emit('close'); assert.equal(b.st.res, b.res);
  } finally { f.close(); }
});
test('S03-01/critic-06: replay is bounded by bytes and 500 frames; missed ranges resync', () => {
  for (const mode of ['bytes', 'frames']) {
    const f = fixture(mode === 'bytes' ? { replayBytes: 1024 } : {});
    try { const a = f.open(), last = `${a.st.id}:${a.st.seq}`; a.req.emit('close');
      for (let i = 0; i < (mode === 'bytes' ? 10 : 501); i++) f.change('x'.repeat(150));
      assert.ok(a.st.buffer.length <= 500);
      assert.ok(a.st.buffer.reduce((n, x) => n + Buffer.byteLength(x.line), 0) <= (mode === 'bytes' ? 1024 : 2 * 1024 * 1024));
      const b = f.open('owner', last); assert.notEqual(b.st.id, a.st.id); assert.match(b.res.lines.join(''), /"resumed":false/);
    } finally { f.close(); }
  }
});
test('S03-01: expiry and resume-GC release admission and all resources', async () => {
  const f = fixture({ perSession: 1, global: 1 }, { resumeMs: 15 });
  try { const a = f.open(); a.req.emit('close'); await new Promise(r => setTimeout(r, 45));
    assert.equal(f.hub._streams.size, 0); for (const k of ['expiry', 'heartbeat', 'gc', 'drain']) assert.ok(a.st[k] == null);
    const b = f.open(); b.st.exp = 0; f.open('third'); assert.equal(b.res.ended, true); assert.equal(f.hub._streams.size, 1);
  } finally { f.close(); }
});
test('S03-01: replay obeys backpressure and write errors release admission', () => {
  const f = fixture({ pendingBytes: 2048 });
  try { const a = f.open(), last = `${a.st.id}:${a.st.seq}`; a.req.emit('close'); f.change(); f.change();
    const res = response(); res.block = true; const b = f.open('owner', last, res);
    assert.equal(res.lines.length, 1); assert.ok(b.st.pending.length >= 3);
    res.block = false; res.emit('drain'); assert.match(res.lines.join(''), /"resumed":true/);
    res.write = () => { throw Error('socket failed'); }; f.change(); assert.equal(f.hub._streams.has(b.st.id), false);
  } finally { f.close(); }
});

test('PM: ten tabs share eight slots; newest tabs load without 429', () => {
  const f = fixture();
  try {
    const tabs = [];
    for (let i = 0; i < 10; i++) { tabs.push(f.open()); assert.ok(f.hub._streams.size <= 8); }
    assert.equal(f.hub._streams.size, 8);
    assert.equal(tabs[0].res.ended, true); assert.equal(tabs[1].res.ended, true);
    for (const tab of tabs.slice(2)) { assert.equal(tab.res.ended, false); assert.match(tab.res.lines.join(''), /event: hello[\s\S]*event: snapshot/); }
    assert.equal(f.hub._streams.has(tabs[0].st.id), false);
  } finally { f.close(); }
});
test('PM: a required 2 MiB office snapshot loads once, waits for drain and logs once', () => {
  const logs = [], f = fixture({}, { log: message => logs.push(message) });
  f.topics.current = id => ({ id, rev: 1, vm: { pad: id === 'office' ? 'x'.repeat(2 * 1024 * 1024) : 'health' } });
  const res = response(), write = res.write;
  res.write = line => { const ready = write(line); if (line.includes('"topic":"office"')) { res.writableLength = Buffer.byteLength(line); return false; } return ready; };
  try {
    const { st } = f.open('owner', null, res, 'office,health');
    assert.equal(st.closed, false); assert.equal(f.hub._streams.size, 1); assert.equal(res.ended, false);
    assert.equal(res.lines.filter(x => x.includes('"topic":"office"')).length, 1);
    assert.equal(res.lines.some(x => x.includes('"topic":"health"')), false, 'no writes after snapshot backpressure');
    assert.equal(st.snapshotWaiting.has('health'), true); assert.ok(st.bufferBytes <= 2 * 1024 * 1024);
    res.writableLength = 0; res.emit('drain');
    assert.equal(res.lines.filter(x => x.includes('"topic":"office"')).length, 1);
    assert.equal(res.lines.filter(x => x.includes('"topic":"health"')).length, 1);
    assert.equal(st.snapshotWaiting.size, 0); assert.equal(st.closed, false); assert.equal(logs.length, 1);
    f.hub.resync({ params: { streamId: st.id }, session: { sid: 'owner' }, body: { topic: 'office' } }, { json() {} });
    assert.equal(logs.length, 1, 'large snapshots do not spam logs'); assert.equal(st.closed, false);
  } finally { f.close(); }
});
test('PM: oversized deltas resync their topic; deferred data cannot falsely resume after a drop', () => {
  const f = fixture({ frameBytes: 1024 });
  try {
    const a = f.open(), last = `${a.st.id}:${a.st.seq}`;
    f.topics.emit('change', { id:'x', rev:2, baseRev:1, ops:[{op:'set',path:['pad'],value:'x'.repeat(2048)}] });
    assert.equal(a.st.closed, false); assert.match(a.res.lines.at(-1), /event: snapshot/);
    a.res.block=true; f.change(); f.change(); assert.equal(a.st.snapshotWaiting.size,1);
    a.req.emit('close'); const b=f.open('owner',last); assert.notEqual(b.st.id,a.st.id); assert.match(b.res.lines.join(''), /"resumed":false/);
  } finally { f.close(); }
});
test('S03-01: both API hubs share session and global admission limits', () => {
  const admission = new Map(), a = fixture({ perSession:2, global:3 }, { admission }), b = fixture({ perSession:2, global:3 }, { admission });
  try {
    const first=a.open(), second=b.open(); const third=a.open(); assert.equal(first.res.ended,true);
    assert.equal(admission.size,2); assert.equal(a.hub._streams.size,1); assert.equal(b.hub._streams.size,1);
    a.open('other'); assert.equal(admission.size,3); assert.throws(()=>b.open('third'), {code:'rate_limited'});
    b.hub.revokeSession(second.req.session); assert.equal(admission.size,2); assert.equal(third.res.ended,false);
  } finally { a.close();b.close();assert.equal(admission.size,0); }
});

test('PM: real HTTP delivers a 2 MiB office frame and following topic on one connection', { timeout: 10000 }, async () => {
  const http = require('node:http'), { openSse } = require('../helpers/sse-client');
  const logs = [], f = fixture({}, { log: message => logs.push(message) }); let opened = 0;
  f.topics.current = id => ({ id, rev: 1, vm: { pad: id === 'office' ? 'x'.repeat(2 * 1024 * 1024) : 'health' } });
  const server = http.createServer((req,res) => { opened++; req.session={sid:'synthetic-owner',exp:Date.now()+60000}; req.query={topics:'office,health'}; f.hub.open(req,res); });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const client = openSse(`http://127.0.0.1:${server.address().port}`, '/stream');
  try {
    await client.next(frame => frame.event === 'hello');
    const office = await client.next(frame => frame.event === 'snapshot' && frame.data.topic === 'office');
    assert.equal(office.data.data.pad.length, 2 * 1024 * 1024);
    const health = await client.next(frame => frame.event === 'snapshot' && frame.data.topic === 'health');
    assert.equal(health.data.data.pad,'health'); assert.equal(opened,1); assert.equal(f.hub._streams.size,1); assert.equal(logs.length,1);
  } finally { client.close(); f.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); }
});

test('S03-01: repeated topic replacement cannot grow deferred snapshot IDs past subscriptions', () => {
  const f = fixture();
  f.topics.parse = id => /^x\d*$/.test(id) ? { id } : null;
  try {
    const { st, res }=f.open(); res.block=true; f.hub.toast('info',{key:'synthetic'});
    let previous='x';
    for(let i=0;i<100;i++) {
      const next='x'+i;
      f.hub.changeTopics({params:{streamId:st.id},session:{sid:'owner'},body:{remove:[previous],add:[next]}},{json(){}});
      assert.equal(st.snapshotWaiting.size,1); assert.equal(st.topics.size,1); previous=next;
    }
    res.block=false;res.emit('drain');assert.equal(st.snapshotWaiting.size,0);assert.match(res.lines.at(-1),/"topic":"x99"/);
  } finally { f.close(); }
});

test('security B1: steadily progressing snapshot survives multiple drain deadlines', async () => {
  const f = fixture({ drainMs: 30 }); const res = response(), write = res.write;
  res.socket = { bytesWritten: 0 };
  res.write = line => { const ready = write(line); if (line.includes('event: snapshot')) { res.writableLength = 2 * 1024 * 1024; return false; } return ready; };
  f.topics.current = id => ({ id, rev: 1, vm: { pad: 'x'.repeat(2 * 1024 * 1024) } });
  let progress;
  try {
    const { st } = f.open('owner', null, res);
    progress = setInterval(() => { res.writableLength -= 64 * 1024; res.socket.bytesWritten += 64 * 1024; }, 10);
    await new Promise(r => setTimeout(r, 130));
    assert.equal(st.closed, false); assert.equal(res.ended, false);
    clearInterval(progress); progress = null; res.writableLength = 0; res.emit('drain');
    assert.equal(st.drain, null); assert.equal(res.lines.filter(line => line.includes('event: snapshot')).length, 1);
  } finally { clearInterval(progress); f.close(); }
});
test('security B1: a progressing snapshot is still dropped when progress stops', async () => {
  const f = fixture({ drainMs: 30 }), res = response(), write = res.write;
  res.write = line => { const ready = write(line); if (line.includes('event: snapshot')) { res.writableLength = 2 * 1024 * 1024; return false; } return ready; };
  f.topics.current = id => ({ id, rev: 1, vm: { pad: 'x'.repeat(2 * 1024 * 1024) } });
  try {
    const { st } = f.open('owner', null, res); res.writableLength -= 64 * 1024;
    await new Promise(r => setTimeout(r, 45)); assert.equal(st.closed, false);
    await new Promise(r => setTimeout(r, 65)); assert.equal(st.closed, true); assert.equal(st.drain, null); assert.equal(f.hub._streams.size, 0);
  } finally { f.close(); }
});
test('security B1: a near-cap snapshot with existing backlog is delivered as the one in-flight snapshot', () => {
  const f = fixture(), res = response(), write = res.write;
  f.topics.current = id => ({ id, rev:1, vm:{ pad:'x'.repeat(1024*1024-8192) } });
  try {
    const { st } = f.open('owner', null, res, '');
    res.writableLength = 12 * 1024;
    res.write = line => { write(line); res.writableLength += Buffer.byteLength(line); return false; };
    f.hub.changeTopics({params:{streamId:st.id},session:{sid:'owner'},body:{add:['office']}},{json(){}});
    assert.equal(st.closed, false); assert.equal(res.ended, false);
    assert.equal(res.lines.filter(line => line.includes('event: snapshot')).length, 1);
    assert.equal(st.largeInFlight, true); assert.equal(st.bufferBytes, 0);
    for(let i=0;st.blocked && i<100;i++){res.writableLength=0;res.emit('drain');}assert.equal(st.drain,null);assert.equal(st.closed,false);
  } finally { f.close(); }
});

test('security B1: a required snapshot uses bounded contiguous UTF-8 slices before following frames', () => {
  const f=fixture(),res=response(),write=res.write,raw=[];const pad='😃'.repeat(512*1024);
  f.topics.current=id=>({id,rev:1,vm:{pad:id==='office'?pad:'health'}});
  res.write=line=>{raw.push(Buffer.from(line));write(line);return false;};
  try {
    const {st}=f.open('owner',null,res,'office,health');
    for(let i=0;st.blocked && i<100;i++)res.emit('drain');
    assert.equal(st.closed,false);assert.equal(st.inFlight,null);assert.equal(st.snapshotWaiting.size,0);
    assert.ok(raw.length>32);assert.ok(raw.every(chunk=>chunk.length<=64*1024));
    const frames=Buffer.concat(raw).toString('utf8').split('\n\n').filter(line=>line.includes('event: snapshot')).map(line=>JSON.parse(line.split('\n').find(l=>l.startsWith('data: ')).slice(6)));
    assert.deepEqual(frames.map(frame=>frame.topic),['office','health']);assert.equal(frames[0].data.pad,pad);
  } finally {f.close();}
});
test('security B1: throttled real HTTP receives a 16 MiB snapshot beyond the five-second deadline on one connection', { timeout:30000 }, async () => {
  const http=require('node:http'), f=fixture();let opened=0, req;
  f.topics.current=id=>({id,rev:1,vm:{pad:id==='office'?'x'.repeat(16*1024*1024):'health'}});
  const server=http.createServer((request,res)=>{
    if(request.url!=='/synthetic-slow-stream'){res.writeHead(404);res.end();return;}
    opened++;request.session={sid:'synthetic-slow-owner',exp:Date.now()+60000};request.query={topics:'office,health'};f.hub.open(request,res);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const started=Date.now(), chunks=[];let received=0;
    await new Promise((resolve,reject)=>{
      req=http.get({host:'127.0.0.1',port:server.address().port,path:'/synthetic-slow-stream'},async res=>{
        try { for await(const chunk of res){chunks.push(chunk);received+=chunk.length;await new Promise(r=>setTimeout(r,50));
          if(received>16*1024*1024 && Buffer.concat(chunks).toString('utf8').includes('"topic":"health"')){resolve();break;}
        }}catch(e){reject(e);}
      });req.on('error',reject);
    });
    assert.ok(Date.now()-started>5000);assert.equal(opened,1);assert.equal(f.hub._streams.size,1);
    const frames=Buffer.concat(chunks).toString('utf8').split('\n\n').filter(s=>s.includes('event: snapshot')).map(s=>JSON.parse(s.split('\n').find(l=>l.startsWith('data: ')).slice(6)));
    assert.equal(frames.find(frame=>frame.topic==='office').data.pad.length,16*1024*1024);assert.equal(frames.find(frame=>frame.topic==='health').data.pad,'health');
  } finally { req?.destroy();f.close();server.closeAllConnections();await new Promise(r=>server.close(r)); }
});

test('security B1: disconnect during a snapshot forces resync even with its current sequence header', () => {
  const f=fixture(),res=response(),write=res.write;
  f.topics.current=id=>({id,rev:1,vm:{pad:'x'.repeat(2*1024*1024)}});
  res.write=line=>{write(line);return !line.includes('event: snapshot');};
  try {
    const a=f.open('owner',null,res);assert.equal(a.st.snapshotWaiting.size,0);
    const last=`${a.st.id}:${a.st.seq}`;a.req.emit('close');assert.equal(a.st.inFlight,null);
    const b=f.open('owner',last);assert.notEqual(b.st.id,a.st.id);assert.match(b.res.lines.join(''),/"resumed":false/);
  } finally {f.close();}
});
