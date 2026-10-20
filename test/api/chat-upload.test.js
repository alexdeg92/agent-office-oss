'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {privateDirectory,receiveUpload}=require('../../src/api/v3/chat-upload');

function requestWithFile(content,{mime='text/plain',name='note.txt',boundary='synthetic-boundary'}={}){
  const bytes=Buffer.isBuffer(content)?content:Buffer.from(content);
  const prefix=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const suffix=Buffer.from(`\r\n--${boundary}--\r\n`);const body=Buffer.concat([prefix,bytes,suffix]);const req=Readable.from([body]);
  req.headers={'content-type':`multipart/form-data; boundary=${boundary}`};return req;
}
const digest=bytes=>'sha-256=:'+crypto.createHash('sha256').update(bytes).digest('base64')+':';

test('private upload streams bounded content to an exclusive private file and verifies exact digest/type',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'ao-chat-upload-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=privateDirectory(base),body=Buffer.from('synthetic attachment text');
  const saved=await receiveUpload(requestWithFile(body),{root,maxBytes:1024,digestHeader:digest(body)});
  assert.equal(saved.mimeType,'text/plain');assert.equal(saved.size,body.length);assert.equal(fs.readFileSync(saved.file,'utf8'),body.toString());
  assert.equal(fs.statSync(saved.file).mode&0o777,0o600);assert.match(saved.storageName,/^[a-f0-9]{64}$/);
  await assert.rejects(receiveUpload(requestWithFile(body),{root,maxBytes:1024,digestHeader:digest(Buffer.from('different'))}));
  await assert.rejects(receiveUpload(requestWithFile(body,{mime:'application/pdf'}),{root,maxBytes:1024,digestHeader:digest(body)}));
  assert.deepEqual(fs.readdirSync(root),[saved.storageName]);
});

test('private upload directory refuses a symlink leaf',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'ao-chat-upload-link-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'ao-chat-upload-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.symlinkSync(outside,path.join(base,'chat-attachments'));
  assert.throws(()=>privateDirectory(base));
});
