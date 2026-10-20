// One route-owned v3 stream, shared by the three chat panes.
import {useState,useEffect,useRef} from '../lib.js';
import * as api from '../api.js';
import {apiUrl,versioned,splitOrigin,buildQuery} from '../config.js';
import {loadModule} from '../build-update.js';
import {createStream} from '../stream.js';
import * as vmcheck from '../vmcheck.js';
import {chatRead,chatSchema} from './chat-api.js';
export function useChatConnection(){
 const [state,setState]=useState({client:null,error:null,epoch:0}),[attempt,retry]=useState(0);
 useEffect(()=>{
  let live=true,client=null;const controller=new AbortController();
  setState(old=>({client:null,error:null,epoch:old.epoch+1}));
  const reset=()=>{client?.invalidateAuth();controller.abort();if(live)setState(old=>({client:null,error:null,epoch:old.epoch+1}));};
  const offAuth=api.onUnauthorized(reset),identity=()=>{reset();retry(n=>n+1);};
  const hide=()=>client?.stop(),show=e=>{if(e.persisted){client?.start();}};
  window.addEventListener('agent-office:me',identity);window.addEventListener('pagehide',hide);window.addEventListener('pageshow',show);
  (async()=>{
   const meta=await api.get('/api/v3/meta',{apiVersion:3,quiet:true,signal:controller.signal});
   const mock=api.isMock()?await api.mock():null;
   if(mock)await mock.handle('GET','/api/v3/chat/agents');
   const split=splitOrigin&&!mock?await loadModule(()=>import('../split-stream.js'+buildQuery)):null;
   if(!live||controller.signal.aborted)return;
   client=createStream({openSource:path=>mock?new mock.MockEventSource(versioned(path,3)):split?split.openSource(path,{apiVersion:3}):new EventSource(apiUrl(path,3),{withCredentials:true}),
    fetchVM:async path=>{const r=await chatRead(path,{signal:controller.signal});return {data:r.data,topic:r.meta?.topic,meta:r.meta};},
    postTopics:(id,body)=>api.post('/api/v3/stream/'+encodeURIComponent(id)+'/topics',body,{apiVersion:3,quiet:true}).then(r=>r.data?.topics??null),
    postResync:(id,topic)=>api.post('/api/v3/stream/'+encodeURIComponent(id)+'/resync',{topic},{apiVersion:3,quiet:true}),
    checkAuth:async()=>{try{return await api.me()?'ok':'unauthorized';}catch{return 'unknown';}},onUnauthorized:api.notifyUnauthorized,
    check:(name,data,where)=>vmcheck.check(chatSchema(name),data,where,3),modelVersion:meta.data.modelVersion,contractVersion:meta.data.contractVersion});
   setState(old=>({...old,client,error:null}));client.start();
  })().catch(error=>{if(live&&!controller.signal.aborted)setState(old=>({...old,error}));});
  return()=>{live=false;controller.abort();client?.stop();offAuth();window.removeEventListener('agent-office:me',identity);window.removeEventListener('pagehide',hide);window.removeEventListener('pageshow',show);};
 },[attempt]);
 return {...state,retry:()=>retry(n=>n+1)};
}
export function useChatTopic(client,topic,url){
 const [state,setState]=useState({key:null,data:undefined,loading:true,error:null});
 const generation=useRef(0);
 useEffect(()=>{const current=++generation.current;setState({key:topic,data:undefined,loading:!!topic,error:null});if(!client||!topic)return;
  return client.subscribe(topic,url,value=>{if(current===generation.current)setState({key:topic,...value});});
 },[client,topic,url]);
 // A changed target can never display the previous target's cached payload.
 return {...(state.key===topic?state:{data:undefined,loading:true,error:null}),retry:()=>client?.retry(topic)};
}
