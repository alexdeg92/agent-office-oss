'use strict';
const fs=require('node:fs'), fsp=fs.promises, path=require('node:path');
const {createHash}=require('node:crypto');
const {parse,PROFILE,projectName:projectBasename}=require('./profile');
const MAX_SESSIONS=2000, MAX_DIRS=10000, MAX_ENTRIES=4096, MAX_READ=256*1024, MAX_LINE=1024*1024, MAX_EVENTS=256;
const MAX_PROJECT_SAMPLE=64*1024, MAX_PROJECT_HEAD=8*1024, MAX_PROJECT_TAIL=MAX_PROJECT_SAMPLE-MAX_PROJECT_HEAD;
const MAX_FILTER_BYTES=256*1024;
const invalid=()=>Object.assign(new Error('rollout path refused'),{code:'EUNSAFEPATH'});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
async function chainOf(dir){const parts=[];for(let p=path.resolve(dir);;p=path.dirname(p)){parts.unshift(p);if(p===path.dirname(p))break;}const out=[];for(const p of parts){const s=await fsp.lstat(p);if(!s.isDirectory()||s.isSymbolicLink())throw invalid();out.push({path:p,dev:s.dev,ino:s.ino});}return out;}
async function verify(chain){for(const p of chain){const s=await fsp.lstat(p.path);if(!s.isDirectory()||s.isSymbolicLink()||!same(p,s))throw invalid();}}
async function pin(chain){let fd;try{for(const item of chain){const next=await fsp.open(fd?`/proc/self/fd/${fd.fd}/${path.basename(item.path)}`:item.path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const st=await next.stat();if(!st.isDirectory()||!same(item,st)){await next.close();throw invalid();}await fd?.close();fd=next;}return fd;}catch(error){await fd?.close();throw error;}}
async function readAt(fd,size,position,stats){const buf=Buffer.alloc(size);let n=0;while(n<size){const r=await fd.read(buf,n,size-n,position+n);if(!r.bytesRead)break;n+=r.bytesRead;stats.bytes+=r.bytesRead;}if(n!==size)throw invalid();return buf;}
function sampledLines(head,tail,counters=null,hasGap=false){const parse=(buffer,{skipPartialFirst=false,dropPartialLast=false}={})=>{const text=buffer.toString('utf8'),parts=text.split('\n');if(skipPartialFirst)parts.shift();if(dropPartialLast&&parts.at(-1)!=='')parts.pop();if(parts.at(-1)==='')parts.pop();const out=[];for(const raw of parts){if(!raw)continue;try{out.push(JSON.parse(raw));}catch{if(counters)counters.malformedLines++;}}return out;};const headRows=hasGap?parse(head,{dropPartialLast:true}):[];const tailRows=parse(tail,{skipPartialFirst:hasGap});const lines=hasGap?[...headRows,...tailRows]:tailRows;if(hasGap)Object.defineProperty(lines,'gapBeforeIndex',{value:headRows.length});return lines;}
function projectMetadataSample(head,tail,size){if(size<=MAX_PROJECT_SAMPLE)return {head:tail,tail};return {head:head.subarray(0,MAX_PROJECT_HEAD),tail:tail.subarray(Math.max(0,tail.length-MAX_PROJECT_TAIL))};}
function latestProjectCwd(lines){let cwd=null;for(const data of lines){if(data?.type==='session_meta'&&typeof data.payload?.cwd==='string')cwd=data.payload.cwd;else if(data?.type==='turn_context'&&typeof data.payload?.cwd==='string')cwd=data.payload.cwd;}return cwd;}
async function projectHint(row,stats,reserve){
 const before=await fsp.lstat(row.filename);if(!before.isFile()||before.isSymbolicLink()||!same(row,before))throw invalid();await verify(row.chain);const parent=await pin(row.chain);let fd;
 try{fd=await fsp.open(`/proc/self/fd/${parent.fd}/${path.basename(row.filename)}`,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const st=await fd.stat();if(!st.isFile()||!same(before,st))throw invalid();const cost=Math.min(st.size,MAX_PROJECT_SAMPLE);if(!reserve(cost))return {limited:true};const whole=st.size<=MAX_PROJECT_SAMPLE,tailSize=whole?st.size:MAX_PROJECT_TAIL,tail=await readAt(fd,tailSize,st.size-tailSize,stats),headSize=whole?st.size:MAX_PROJECT_HEAD,head=whole?tail:await readAt(fd,headSize,0,stats);await verify(row.chain);const after=await fsp.lstat(row.filename);if(after.isSymbolicLink()||!same(st,after)||after.size!==st.size||after.mtimeMs!==st.mtimeMs||after.ctimeMs!==st.ctimeMs)throw invalid();Object.assign(row,{size:after.size,mtime:after.mtimeMs,ctime:after.ctimeMs});const sample=projectMetadataSample(head,tail,st.size);return {name:projectBasename(latestProjectCwd(sampledLines(sample.head,sample.tail,stats,st.size>MAX_PROJECT_SAMPLE))),bytes:cost};
 }finally{await fd?.close();await parent.close();}
}
const idOf=filename=>'codex:'+createHash('sha256').update(filename).digest('hex');
const filenameSessionRef=name=>name.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i)?.[1]||null;
function createFiles({home,include=[],exclude=[],now=Date.now,agentGrouping='project'}={}) {
 const root=path.resolve(home,'sessions'),index=new Map(),cache=new Map(),stats={entries:0,files:0,truncated:false,bytes:0,malformedLines:0,unknownLineTypes:0,unknownKeys:0}; let closed=false,scanning=null,filterCursorKey=null,changeHandler=null;const watchers=new Map();
 function ensureWatcher(dir){if(!changeHandler||closed||watchers.has(dir)||watchers.size>=4096)return;try{const w=fs.watch(dir,{persistent:false},(_event,name)=>changeHandler?.({path:name==null?null:path.resolve(dir,String(name))}));w.on('error',()=>{w.close();watchers.delete(dir);});watchers.set(dir,w);}catch{}}
 async function scan(){if(scanning)return scanning;scanning=(async()=>{
   stats.truncated=false;stats.entries=0;
   let rootChain=await chainOf(root);const rows=[];let dirs=0,entries=0,stop=false;
   const countEntry=()=>{entries++;if(entries>=MAX_ENTRIES){stats.truncated=true;stop=true;}return !stop;};
   try {ensureWatcher(root);let rootDir=await fsp.opendir(root);for await(const year of rootDir){if(closed)return[];if(stop||!countEntry())break;if(!year.isDirectory()||year.isSymbolicLink()||!/^[0-9]{4}$/.test(year.name))continue;if(++dirs>MAX_DIRS){stats.truncated=true;stop=true;break;}const yp=path.join(root,year.name);let yd;try{yd=await fsp.opendir(yp);}catch{continue;}ensureWatcher(yp);const yc=await chainOf(yp);
     try{for await(const month of yd){if(closed)return[];if(stop||!countEntry())break;if(!month.isDirectory()||month.isSymbolicLink()||!/^[0-9]{2}$/.test(month.name))continue;if(++dirs>MAX_DIRS){stats.truncated=true;stop=true;break;}const mp=path.join(yp,month.name);let md;try{md=await fsp.opendir(mp);}catch{continue;}ensureWatcher(mp);const mc=await chainOf(mp);
         try{for await(const day of md){if(closed)return[];if(stop||!countEntry())break;if(!day.isDirectory()||day.isSymbolicLink()||!/^(0[1-9]|[12]\d|3[01])$/.test(day.name))continue;if(++dirs>MAX_DIRS){stats.truncated=true;stop=true;break;}const dp=path.join(mp,day.name);let dd;try{dd=await fsp.opendir(dp);}catch{continue;}ensureWatcher(dp);const dc=await chainOf(dp);
         try{for await(const file of dd){if(closed)return[];if(stop||!countEntry())break;if(!file.isFile()||file.isSymbolicLink()||!/^rollout-[A-Za-z0-9_-]{1,160}\.jsonl$/.test(file.name))continue;const filename=path.join(dp,file.name);let st;try{st=await fsp.lstat(filename);}catch{continue;}if(!st.isFile()||st.isSymbolicLink())continue;const sessionId=file.name.slice(8,-6);const key=idOf(filename);rows.push({key,sessionId,identitySessionRef:filenameSessionRef(file.name),filename,dev:st.dev,ino:st.ino,size:st.size,mtime:st.mtimeMs,ctime:st.ctimeMs,chain:dc});}
         }finally{await verify(dc);await dd.close().catch(()=>{});}
       }}finally{await verify(mc);await md.close().catch(()=>{});}
     }}finally{await verify(yc);await yd.close().catch(()=>{});}
   }
   await verify(rootChain); rows.sort((a,b)=>b.mtime-a.mtime||a.key.localeCompare(b.key));if(rows.length>MAX_SESSIONS){stats.truncated=true;rows.length=MAX_SESSIONS;}
   const next=new Map(rows.map(row=>[row.key,{...index.get(row.key),...row}]));for(const key of index.keys())if(!next.has(key))cache.delete(key);index.clear();for(const [k,v] of next)index.set(k,v);stats.entries=entries;stats.files=rows.length;return [...index.values()];
 }finally{scanning=null;}})();return scanning;}
 async function filterRows(rows){if(!include.length&&!exclude.length){stats.filterBytes=0;stats.filterBudgetExhausted=false;Object.defineProperty(rows,'capacityLimited',{value:false});return rows;}const allowed=new Set();let budget=0,limited=false;stats.filterBytes=0;stats.filterBudgetExhausted=false;const known=row=>row.hintMtime===row.mtime&&row.hintCtime===row.ctime&&row.hintSize===row.size;const matches=row=>{const name=row.hintedProject;return name?!(exclude.includes(name)||include.length&&!include.includes(name)):!include.length&&!exclude.length;};
   // Reuse stable hints, then rotate the starting row so repeated changes near
   // the top of the list cannot starve older rollout metadata.
   for(const row of rows)if(known(row)&&matches(row))allowed.add(row.key);
   let start=filterCursorKey?rows.findIndex(row=>row.key===filterCursorKey)+1:0;if(start<0)start=0;if(start>=rows.length)start=0;const ordered=rows.slice(start).concat(rows.slice(0,start));
   const reserve=bytes=>{if(budget+bytes>MAX_FILTER_BYTES)return false;budget+=bytes;stats.filterBytes=budget;return true;};
   for(const row of ordered){if(closed)break;if(known(row))continue;try{const hint=await projectHint(row,stats,reserve);if(hint.limited){limited=true;break;}filterCursorKey=row.key;const changedProject=row.hintedProject!==hint.name;row.hintedProject=hint.name;row.hintMtime=row.mtime;row.hintCtime=row.ctime;row.hintSize=row.size;row.hintDev=row.dev;row.hintIno=row.ino;if(changedProject){delete row.projectName;delete row.projectId;delete row.agentId;cache.delete(row.key);}if(matches(row))allowed.add(row.key);}catch(error){if(error.code==='EUNSAFEPATH')throw error;limited=true;filterCursorKey=row.key;}}
   stats.filterBudgetExhausted=limited;const out=rows.filter(row=>allowed.has(row.key));Object.defineProperty(out,'capacityLimited',{value:limited});return out;}
 async function read(key){const row=index.get(key);if(!row||closed)return null;if(cache.has(key)&&row.loadedMtime===row.mtime&&row.loadedCtime===row.ctime&&row.loadedSize===row.size)return cache.get(key);
   const before=await fsp.lstat(row.filename);if(!before.isFile()||before.isSymbolicLink())throw invalid();await verify(row.chain);const parent=await pin(row.chain);let fd;
   try{fd=await fsp.open(`/proc/self/fd/${parent.fd}/${path.basename(row.filename)}`,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const st=await fd.stat();if(!st.isFile()||!same(before,st))throw invalid();
     const changed=row.readDev!==st.dev||row.readIno!==st.ino||st.size<(row.loadedSize||0)
       ||((st.size===(row.loadedSize||0))&&(row.loadedMtime!==st.mtimeMs||row.loadedCtime!==st.ctimeMs));
     const reset=changed||row.loadedSize===undefined||!cache.has(key);
     const prior=reset?null:row;
     let offset=reset?0:row.loadedSize, pending=reset?Buffer.alloc(0):Buffer.from(row.pendingLine||''), skipping=reset?false:row.skipLine===true;
     const amount=Math.min(MAX_READ,Math.max(0,st.size-offset));
     const chunk=amount?await readAt(fd,amount,offset,stats):Buffer.alloc(0);offset+=chunk.length;
     let input=Buffer.concat([pending,chunk]), lines=[], start=0, oversize=skipping;
     for(let end;(end=input.indexOf(10,start))>=0;start=end+1){
       const line=input.subarray(start,end);if(oversize){oversize=false;continue;}
       if(line.length>MAX_LINE){stats.oversizeLines=(stats.oversizeLines||0)+1;continue;}
       if(line.length)lines.push(line.toString('utf8'));
     }
     let remainder=input.subarray(start);
     if(remainder.length>MAX_LINE){remainder=Buffer.alloc(0);oversize=true;stats.oversizeLines=(stats.oversizeLines||0)+1;}
     const parsed=[];for(const line of lines){try{parsed.push(JSON.parse(line));}catch{stats.malformedLines++;}}
     const observedCwd=latestProjectCwd(parsed);const cwd=observedCwd||prior?.projectPath||null;const project=path.resolve(cwd||'/');const projectId='project:'+createHash('sha256').update(project).digest('hex');const agentId=agentGrouping==='runtime'?'runtime':projectId;
     const data=parse(parsed,{sessionKey:key,agentId,now,counters:stats,state:prior?.parserState||null});
     const events=[];for(const event of [...(prior?.events||[]),...data.events]){const existing=event.id?events.findIndex(old=>old.id===event.id):-1;if(existing>=0){events[existing]=event;continue;}events.push(event);if(events.length>MAX_EVENTS)events.shift();}
     const complete=offset>=st.size&&!remainder.length;
     const currentProjectHint=row.hintDev===st.dev&&row.hintIno===st.ino&&row.hintMtime===st.mtimeMs&&row.hintCtime===st.ctimeMs&&row.hintSize===st.size;
     if((include.length||exclude.length)&&!currentProjectHint){delete row.projectName;delete row.projectId;delete row.agentId;cache.delete(key);return null;}
     const safeProjectName=!complete&&currentProjectHint?row.hintedProject
       :observedCwd?projectBasename(observedCwd):(projectBasename(cwd)||prior?.safeProjectName||null);
     if((safeProjectName&&exclude.includes(safeProjectName))||include.length&&(!safeProjectName||!include.includes(safeProjectName)))return null;
     const projectName=agentGrouping==='runtime'?'Codex':safeProjectName;
     Object.assign(row,{identitySessionRef:data.sessionId||prior?.identitySessionRef||row.identitySessionRef,projectPath:cwd, safeProjectName,
       loadedSize:offset,loadedMtime:st.mtimeMs,loadedCtime:st.ctimeMs,readDev:st.dev,readIno:st.ino,pendingLine:Buffer.from(remainder),skipLine:oversize,
       projectId,agentId,projectName,model:data.model||prior?.model||null,activityAt:data.activityAt??prior?.activityAt??null,
       activity:data.activity,execution:data.execution??prior?.execution??null,parserState:data.state,usage:data.usage??prior?.usage??null,
       displayName:data.displayName||prior?.displayName||null,summary:data.summary||prior?.summary||null,events});
     await verify(row.chain);const after=await fsp.lstat(row.filename);if(after.isSymbolicLink()||!same(st,after)||after.size!==st.size||after.mtimeMs!==st.mtimeMs||after.ctimeMs!==st.ctimeMs)throw invalid();
     const trace={sessionKey:key,fetchedAt:now(),messageCount:events.length,window:{from:0,to:events.length},events};cache.set(key,trace);return trace;
   }finally{await fd?.close();await parent.close();}
 }
 async function refresh(key){const row=index.get(key);if(!row||closed)return null;await verify(row.chain);let st;try{st=await fsp.lstat(row.filename);}catch(error){if(error.code==='ENOENT')return null;throw error;}if(!st.isFile()||st.isSymbolicLink())return null;Object.assign(row,{dev:st.dev,ino:st.ino,size:st.size,mtime:st.mtimeMs,ctime:st.ctimeMs});return row;}
 return {scan,filterRows,read,refresh,keyForPath:file=>[...index.values()].find(row=>row.filename===path.resolve(file))?.key||null,
  watch(onChange){changeHandler=typeof onChange==='function'?onChange:null;ensureWatcher(root);for(const row of [...index.values()].sort((a,b)=>b.mtime-a.mtime)){ensureWatcher(path.dirname(row.filename));if(watchers.size>=4096)break;}},
  rows:()=>[...index.values()].filter(row=>row.agentId),cached:()=>[...cache.keys()],stats,bounds:{sessions:MAX_SESSIONS,readBytes:MAX_READ},close(){closed=true;changeHandler=null;for(const w of watchers.values())w.close();watchers.clear();cache.clear();},agentId:project=> 'project:'+createHash('sha256').update(project).digest('hex'),profile:PROFILE};
}
module.exports={createFiles,MAX_SESSIONS,MAX_ENTRIES,MAX_READ,MAX_FILTER_BYTES,MAX_FILTER_HEAD:MAX_PROJECT_SAMPLE,filenameSessionRef};
