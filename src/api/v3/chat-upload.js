'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const Busboy=require('busboy');

const MAX_FILE=20*1024*1024;
function privateDirectory(dataDir){
  if(!Number.isInteger(fs.constants.O_NOFOLLOW))throw new Error('safe chat uploads are unavailable');
  if(typeof dataDir!=='string'||!path.isAbsolute(dataDir))throw new Error('chat upload directory unavailable');
  const parent=fs.realpathSync(dataDir),root=path.join(parent,'chat-attachments');
  try{fs.mkdirSync(root,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  const st=fs.lstatSync(root);if(st.isSymbolicLink()||!st.isDirectory()||(st.mode&0o077)!==0)throw new Error('unsafe chat upload directory');
  if(fs.realpathSync(root)!==root)throw new Error('unsafe chat upload directory');
  return root;
}
function expectedDigest(header){
  const m=typeof header==='string'&&header.match(/^sha-256=:([A-Za-z0-9+/]{43}=):$/);if(!m)throw new Error('invalid digest');
  const b=Buffer.from(m[1],'base64');if(b.length!==32||b.toString('base64')!==m[1])throw new Error('invalid digest');return b;
}
function sniff(bytes){
  if(bytes.subarray(0,5).toString('ascii')==='%PDF-')return 'application/pdf';
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii')))return 'image/gif';
  if(bytes.length>=12&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP')return 'image/webp';
  if(bytes.includes(0))return null;
  // A sniff window may end halfway through a multibyte code point. Validate
  // complete sequences here and let the streaming full-file decoder validate
  // the eventual tail when the upload finishes.
  try{new TextDecoder('utf-8',{fatal:true}).decode(bytes,{stream:true});return 'text/plain';}catch{return null;}
}
async function writeAll(handle,buffer,position){let offset=0;while(offset<buffer.length){const out=await handle.write(buffer,offset,buffer.length-offset,position+offset);if(!out.bytesWritten)throw new Error('upload write failed');offset+=out.bytesWritten;}}
async function saveFile(stream,{root,maxBytes,maxImageBytes=maxBytes}){
  const storageName=crypto.randomBytes(32).toString('hex'),file=path.join(root,storageName);
  const flags=fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW;
  const handle=await fs.promises.open(file,flags,0o600),digest=crypto.createHash('sha256'),decoder=new TextDecoder('utf-8',{fatal:true});
  let size=0,head=Buffer.alloc(0),text=true;
  try{
    let pos=0;
    for await(const chunk of stream){
      size+=chunk.length;if(size>maxBytes)throw Object.assign(new Error('upload too large'),{code:'TOO_LARGE'});
      digest.update(chunk);if(head.length<32)head=Buffer.concat([head,chunk.subarray(0,32-head.length)]);
      if(chunk.includes(0))text=false;
      if(text){try{decoder.decode(chunk,{stream:true});}catch{text=false;}}
      await writeAll(handle,chunk,pos);pos+=chunk.length;
    }
    if(text){try{decoder.decode();}catch{text=false;}}
    if(!size)throw Object.assign(new Error('empty upload'),{code:'INVALID'});
    const mimeType=sniff(head);
    if(!mimeType||mimeType==='text/plain'&&!text)throw Object.assign(new Error('unsupported upload content'),{code:'INVALID'});
    if(mimeType.startsWith('image/')&&size>maxImageBytes)throw Object.assign(new Error('image upload too large'),{code:'TOO_LARGE'});
    const sha256=digest.digest('hex');
    const st=await handle.stat();if(!st.isFile()||st.size!==size||(st.mode&0o077)!==0)throw Object.assign(new Error('unsafe upload'),{code:'INVALID'});
    await handle.sync();await handle.close();
    return {file,storageName,size,mimeType,sha256};
  }catch(error){try{await handle.close();}catch{}try{await fs.promises.unlink(file);}catch{}throw error;}
}
async function receiveUpload(req,{root,maxBytes,maxImageBytes=maxBytes,digestHeader}){
  const expected=expectedDigest(digestHeader);
  return new Promise((resolve,reject)=>{
    let fileTask=null,fileInfo=null,failed=null,settled=false;
    const fail=e=>{if(!failed)failed=e;try{req.unpipe(parser);}catch{}try{parser.destroy();}catch{};};
    let parser;
    try{parser=Busboy({headers:req.headers,limits:{files:1,fields:0,fileSize:Math.min(MAX_FILE,maxBytes)}});}catch{reject(new Error('invalid multipart'));return;}
    parser.on('file',(field,stream,info)=>{
      if(field!=='file'||fileTask){stream.resume();fail(Object.assign(new Error('invalid multipart fields'),{code:'INVALID'}));return;}
      fileInfo=info;stream.once('limit',()=>fail(Object.assign(new Error('upload too large'),{code:'TOO_LARGE'})));
      fileTask=saveFile(stream,{root,maxBytes,maxImageBytes}).catch(e=>{fail(e);throw e;});
      fileTask.catch(()=>{});
    });
    parser.on('filesLimit',()=>fail(Object.assign(new Error('too many files'),{code:'INVALID'})));
    parser.on('fieldsLimit',()=>fail(Object.assign(new Error('fields not allowed'),{code:'INVALID'})));
    parser.on('field',()=>fail(Object.assign(new Error('fields not allowed'),{code:'INVALID'})));
    parser.on('error',fail);
    parser.on('close',async()=>{
      if(settled)return;settled=true;
      let saved=null;
      try{
        saved=fileTask&&await fileTask;
        if(failed)throw failed;if(!saved||!fileInfo)throw Object.assign(new Error('file required'),{code:'INVALID'});
        const actual=Buffer.from(saved.sha256,'hex');if(!crypto.timingSafeEqual(actual,expected))throw Object.assign(new Error('digest mismatch'),{code:'INVALID'});
        const declared=String(fileInfo.mimeType||'').toLowerCase();if(declared!==saved.mimeType)throw Object.assign(new Error('content type mismatch'),{code:'INVALID'});
        resolve({...saved,name:String(fileInfo.filename||'attachment').normalize('NFKC').replace(/[\\/\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,120)||'attachment'});
      }catch(e){if(saved?.file)try{fs.unlinkSync(saved.file);}catch{}reject(e);}
    });
    req.pipe(parser);
  });
}
async function readPrivateAttachment(dataDir,item,{maxBytes=MAX_FILE,maxImageBytes=maxBytes}={}){
  if(!item||typeof item.storage_name!=='string'||!/^[a-f0-9]{64}$/.test(item.storage_name)||!Number.isSafeInteger(item.byte_size)||item.byte_size<1||item.byte_size>maxBytes||
      typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))throw new Error('invalid private attachment reference');
  const root=privateDirectory(dataDir),filename=path.join(root,item.storage_name);
  const handle=await fs.promises.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|(fs.constants.O_NONBLOCK||0));
  try{
    const stat=await handle.stat();if(!stat.isFile()||stat.size!==item.byte_size||(stat.mode&0o077)!==0)throw new Error('unsafe private attachment');
    const content=await handle.readFile();if(content.length!==item.byte_size)throw new Error('private attachment size changed');
    const digest=crypto.createHash('sha256').update(content).digest();const expected=Buffer.from(item.sha256,'hex');
    if(expected.length!==digest.length||!crypto.timingSafeEqual(expected,digest))throw new Error('private attachment digest changed');
    const image=String(item.mime_type||'').startsWith('image/');if(image&&content.length>maxImageBytes)throw Object.assign(new Error('attachment exceeds image limit'),{code:'TOO_LARGE'});
    return {name:String(item.display_name||'attachment'),mimeType:item.mime_type,size:content.length,sha256:item.sha256,content};
  }finally{await handle.close();}
}
module.exports={privateDirectory,expectedDigest,receiveUpload,readPrivateAttachment,MAX_FILE};
