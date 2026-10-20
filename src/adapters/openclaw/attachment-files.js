'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const SAFE_AGENT=/^[A-Za-z0-9_-]{1,64}$/;
const SAFE_FILE=/^att_[A-Za-z0-9_-]{32,}$/;
const SAFE_SCOPE=/^[a-f0-9]{64}$/;
const INBOX_NAME=/^[A-Za-z0-9_-]{1,48}$/;
const O_DIRECTORY=fs.constants.O_DIRECTORY||0;
const O_NOFOLLOW=fs.constants.O_NOFOLLOW||0;
const O_NONBLOCK=fs.constants.O_NONBLOCK||0;
const displayName=value=>String(value||'attachment').normalize('NFKC').replace(/[\\/\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069<>]/g,'').trim().slice(0,120)||'attachment';
const sameObject=(a,b)=>a.dev===b.dev&&a.ino===b.ino;

function createAttachmentFiles({workspaceForAgent,inboxName='agent-office-inbox',now=()=>Date.now(),afterInboxOpen=null,maxScan=4096,procFdRoot='/proc/self/fd'}={}){
  if(typeof workspaceForAgent!=='function'||!INBOX_NAME.test(inboxName)||!Number.isSafeInteger(maxScan)||maxScan<1||maxScan>10000)throw new TypeError('invalid attachment inbox configuration');
  const descriptorPathsAvailable=typeof procFdRoot==='string'&&path.isAbsolute(procFdRoot)&&fs.existsSync(procFdRoot);
  const procPath=fd=>path.join(procFdRoot,String(fd));
  const scanStates=new Map(),scanning=new Set(),MAX_SCAN_STATES=128;
  const closeScan=state=>{try{state?.dir?.close?.().catch(()=>{});}catch{}};
  const rememberScan=(key,state)=>{scanStates.delete(key);scanStates.set(key,state);while(scanStates.size>MAX_SCAN_STATES){const [oldKey,oldState]=scanStates.entries().next().value;scanStates.delete(oldKey);closeScan(oldState);}};
  const assertDirectory=stat=>stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0;
  async function openInbox(agentId,principalScope,{create=false}={}){
    if(!descriptorPathsAvailable)throw new Error('attachment inbox unsupported on this platform');
    if(!SAFE_AGENT.test(String(agentId||''))||!SAFE_SCOPE.test(String(principalScope||'')))throw new Error('invalid attachment scope');
    const workspace=workspaceForAgent(agentId);if(typeof workspace!=='string'||!path.isAbsolute(workspace))throw new Error('agent workspace unavailable');
    const parent=fs.realpathSync(workspace),parentStat=fs.lstatSync(parent);if(!parentStat.isDirectory()||parentStat.isSymbolicLink())throw new Error('agent workspace unavailable');
    const workspaceHandle=await fs.promises.open(parent,fs.constants.O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK);
    let rootHandle=null,inboxHandle=null;
    try{
      const workspaceStat=await workspaceHandle.stat();if(!workspaceStat.isDirectory()||!sameObject(workspaceStat,parentStat))throw new Error('agent workspace changed');
      const inboxPath=path.join(parent,inboxName),inboxPinnedPath=path.join(procPath(workspaceHandle.fd),inboxName);
      if(create){try{await fs.promises.mkdir(inboxPinnedPath,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}}
      const inboxStat=fs.lstatSync(inboxPath);if(!assertDirectory(inboxStat)||fs.realpathSync(inboxPath)!==inboxPath)throw new Error('unsafe attachment inbox');
      rootHandle=await fs.promises.open(inboxPinnedPath,fs.constants.O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK);
      const rootStat=await rootHandle.stat();if(!assertDirectory(rootStat)||!sameObject(rootStat,inboxStat)||fs.realpathSync(procPath(rootHandle.fd))!==inboxPath)throw new Error('attachment inbox changed');
      const scopePath=path.join(inboxPath,principalScope),scopePinnedPath=path.join(procPath(rootHandle.fd),principalScope);
      if(create){try{await fs.promises.mkdir(scopePinnedPath,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}}
      const scopeEntry=fs.lstatSync(scopePath);if(!assertDirectory(scopeEntry)||fs.realpathSync(scopePath)!==scopePath)throw new Error('unsafe attachment principal inbox');
      inboxHandle=await fs.promises.open(scopePinnedPath,fs.constants.O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK);
      const pinnedStat=await inboxHandle.stat();if(!assertDirectory(pinnedStat)||!sameObject(scopeEntry,pinnedStat))throw new Error('attachment inbox changed');
      const realPinned=fs.realpathSync(procPath(inboxHandle.fd));if(path.relative(path.join(parent,inboxName),realPinned).startsWith('..')||realPinned!==scopePath)throw new Error('attachment inbox escaped');
      const verify=()=>{
        const handleStat=fs.fstatSync(inboxHandle.fd),named=fs.lstatSync(scopePath),parentNow=fs.lstatSync(parent),inboxNow=fs.lstatSync(inboxPath),rootNow=fs.fstatSync(rootHandle.fd);
        const pinnedNow=fs.realpathSync(procPath(inboxHandle.fd));
        if(!assertDirectory(handleStat)||!sameObject(handleStat,named)||!sameObject(parentNow,workspaceStat)||!sameObject(inboxNow,rootNow)||!sameObject(inboxNow,fs.lstatSync(inboxPinnedPath))||
          fs.realpathSync(procPath(rootHandle.fd))!==inboxPath||
          !assertDirectory(named)||!assertDirectory(inboxNow)||pinnedNow!==scopePath||path.relative(path.join(parent,inboxName),pinnedNow).startsWith('..'))throw new Error('attachment inbox changed');
      };
      await afterInboxOpen?.({agentId,principalScope,path:scopePath,fd:inboxHandle.fd});verify();
      return {workspaceHandle,rootHandle,inboxHandle,parent,scopePath,verify,close:async()=>{await inboxHandle?.close();await rootHandle?.close();await workspaceHandle.close();}};
    }catch(error){try{await inboxHandle?.close();}catch{}try{await rootHandle?.close();}catch{}try{await workspaceHandle.close();}catch{}throw error;}
  }
  return {
    canStage({agentId,principalScope}){try{return descriptorPathsAvailable&&SAFE_AGENT.test(String(agentId||''))&&SAFE_SCOPE.test(String(principalScope||''))&&typeof workspaceForAgent(agentId)==='string'&&path.isAbsolute(workspaceForAgent(agentId));}catch{return false;}},
    async stage({agentId,principalScope,files}){
      if(!Array.isArray(files)||!files.length||files.length>5)throw new Error('invalid attachment batch');
      const inbox=await openInbox(agentId,principalScope,{create:true}),created=[],out=[];const pinned=procPath(inbox.inboxHandle.fd);
      try{for(const item of files){inbox.verify();if(!item||!Buffer.isBuffer(item.content)||!Number.isSafeInteger(item.size)||item.size!==item.content.length||item.size<1||!/^[a-f0-9]{64}$/.test(item.sha256||''))throw new Error('invalid attachment');
        const digest=crypto.createHash('sha256').update(item.content).digest('hex');if(digest!==item.sha256)throw new Error('attachment digest mismatch');
        const fileName=SAFE_FILE.test(String(item.fileName||''))?item.fileName:`att_${crypto.randomBytes(24).toString('base64url')}`,file=path.join(pinned,fileName);
        const handle=await fs.promises.open(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|O_NOFOLLOW,0o600);created.push(fileName);
        try{inbox.verify();await handle.writeFile(item.content);await handle.sync();const stat=await handle.stat();inbox.verify();if(!stat.isFile()||stat.size!==item.size||(stat.mode&0o077)!==0)throw new Error('unsafe attachment copy');}finally{await handle.close();}
        inbox.verify();out.push({displayName:displayName(item.name),mimeType:item.mimeType,size:item.size,reference:path.join(inbox.scopePath,fileName),fileName,createdAt:now()});
      }return out;}catch(error){for(const name of created)try{inbox.verify();await fs.promises.unlink(path.join(pinned,name));inbox.verify();}catch{}throw error;}finally{await inbox.close();}
    },
    async remove({agentId,principalScope,fileNames}){
      if(!Array.isArray(fileNames)||fileNames.length>20||fileNames.some(name=>!SAFE_FILE.test(String(name||''))))return false;
      let inbox;try{inbox=await openInbox(agentId,principalScope);}catch(error){if(error.code==='ENOENT')return true;throw error;}
      try{const pinned=procPath(inbox.inboxHandle.fd);for(const name of fileNames){inbox.verify();const target=path.join(pinned,name);try{const st=fs.lstatSync(target);if(st.isSymbolicLink()||!st.isFile())return false;inbox.verify();await fs.promises.unlink(target);inbox.verify();}catch(error){if(error.code!=='ENOENT')throw error;}}return true;}finally{await inbox.close();}
    },
    async prune({agentId,principalScope,olderThan=now()-86400000,limit=50}={}){
      if(!Number.isSafeInteger(olderThan)||!Number.isSafeInteger(limit)||limit<1||limit>50)return 0;
      const scanKey=`${agentId}:${principalScope}`;if(scanning.has(scanKey))return 0;scanning.add(scanKey);
      let inbox;try{inbox=await openInbox(agentId,principalScope);}catch(error){scanning.delete(scanKey);if(error.code==='ENOENT')return 0;throw error;}
      try{inbox.verify();const pinned=procPath(inbox.inboxHandle.fd),directoryStat=await inbox.inboxHandle.stat();let state=scanStates.get(scanKey);
        if(state){try{const current=fs.fstatSync(state.dir.fd);if(!sameObject(current,directoryStat))throw new Error('attachment scan directory changed');}catch{scanStates.delete(scanKey);closeScan(state);state=null;}}
        if(!state)state={dir:await fs.promises.opendir(pinned),pending:[],done:false};
        const names=state.pending.splice(0,maxScan);
        while(names.length<maxScan&&!state.done){inbox.verify();const entry=await state.dir.read();if(!entry){state.done=true;break;}if(SAFE_FILE.test(entry.name))names.push(entry.name);}
        inbox.verify();const candidates=[];
        for(const name of names){inbox.verify();try{const stat=fs.lstatSync(path.join(pinned,name));inbox.verify();if(!stat.isSymbolicLink()&&stat.isFile()&&stat.mtimeMs<=olderThan)candidates.push({name,mtime:stat.mtimeMs});}catch{}}
        candidates.sort((a,b)=>a.mtime-b.mtime||a.name.localeCompare(b.name));let removed=0;
        for(const item of candidates.slice(0,limit)){inbox.verify();try{const file=path.join(pinned,item.name),stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.mtimeMs>olderThan)continue;await fs.promises.unlink(file);inbox.verify();removed++;}catch(error){if(error.code!=='ENOENT')throw error;}}
        state.pending=candidates.slice(limit).map(item=>item.name);
        if(state.done&&!state.pending.length){scanStates.delete(scanKey);closeScan(state);}else rememberScan(scanKey,state);
        return removed;
      }finally{await inbox.close();scanning.delete(scanKey);}
    },
    close(){for(const state of scanStates.values())closeScan(state);scanStates.clear();scanning.clear();},
  };
}
module.exports={createAttachmentFiles,SAFE_FILE,INBOX_NAME,SAFE_SCOPE};
