// Projects own a pinned v3 transport; the app's configured Office version stays unchanged.
import {useEffect,useRef,useState} from '../lib.js';
import * as api from '../api.js';
import {apiUrl,versioned,splitOrigin,buildQuery} from '../config.js';
import {createStream} from '../stream.js';
import {loadModule} from '../build-update.js';
import * as vmcheck from '../vmcheck.js';

export function useProjectTopic(topic,url,{keepPrevious=false}={}) {
  const [view,setView]=useState({data:undefined,loading:true,error:null}),[attempt,setAttempt]=useState(0);
  const current=useRef(null),commands=useRef(null);
  useEffect(()=>{
    let active=true,client=null,off=null,generation=0;
    setView(previous=>({data:keepPrevious?previous.data:undefined,loading:true,error:null}));
    const clear=()=>{generation++;commands.current=null;client?.invalidateAuth();if(active)setView({data:undefined,loading:false,error:null});};
    const offAuth=api.onUnauthorized(clear);
    const identity=()=>{clear();setAttempt(value=>value+1);};
    window.addEventListener('agent-office:me',identity);
    const pagehide=()=>client?.stop();
    const pageshow=event=>{if(event.persisted){client?.start();client?.resync(topic);}};
    window.addEventListener('pagehide',pagehide);
    window.addEventListener('pageshow',pageshow);
    (async()=>{
      const {data:meta}=await api.get('/api/v3/meta',{apiVersion:3,quiet:true});
      const mock=api.isMock()?await api.mock():null;
      const split=splitOrigin&&!mock?await loadModule(()=>import('../split-stream.js'+buildQuery)):null;
      if(!active||generation)return;
      client=createStream({
        openSource:mock?path=>new mock.MockEventSource(versioned(path,3)):split?path=>split.openSource(path,{apiVersion:3}):path=>new EventSource(apiUrl(path,3),{withCredentials:true}),
        fetchVM:async path=>{const r=await api.get(path,{apiVersion:3,quiet:true});return {data:r.data,topic:r.meta?.topic,meta:r.meta};},
        postTopics:(id,body)=>api.post(`/api/v3/stream/${encodeURIComponent(id)}/topics`,body,{apiVersion:3,quiet:true}).then(r=>r.data?.topics??null),
        postResync:(id,name)=>api.post(`/api/v3/stream/${encodeURIComponent(id)}/resync`,{topic:name},{apiVersion:3,quiet:true}),
        checkAuth:async()=>{try{return await api.me()?'ok':'unauthorized';}catch{return 'unknown';}},
        onUnauthorized:()=>api.notifyUnauthorized(),
        check:(name,data,where)=>vmcheck.check(vmcheck.schemaForTopic(name),data,where,3),
        modelVersion:meta.modelVersion,contractVersion:meta.contractVersion,
      });
      current.current=client;
      // Commands reconcile through this subscription's client. Fence an old
      // response after navigation or an authentication/identity reset.
      commands.current={
        applyVM:(...args)=>{if(active&&!generation&&current.current===client)client.applyVM(...args);},
        resync:(...args)=>{if(active&&!generation&&current.current===client)client.resync(...args);},
      };
      off=client.subscribe(topic,url,state=>{if(active)setView(previous=>keepPrevious&&state.data===undefined?{...state,data:previous.data}:state);});client.start();
    })().catch(error=>{if(active)setView({data:undefined,loading:false,error});});
    return ()=>{active=false;off?.();client?.stop();if(current.current===client){current.current=null;commands.current=null;}offAuth();window.removeEventListener('agent-office:me',identity);window.removeEventListener('pagehide',pagehide);window.removeEventListener('pageshow',pageshow);};
  },[topic,url,attempt]);
  return {...view,stream:commands.current,retry:()=>current.current?current.current.retry(topic):setAttempt(value=>value+1)};
}
