// Chat route transport: pin the live v3 contract, keep mutations idempotent.
import * as api from '../api.js';
import {apiUrl,splitOrigin,buildQuery} from '../config.js';
import {getLang} from '../i18n.js';
import {loadModule} from '../build-update.js';
import * as vmcheck from '../vmcheck.js';
export const chatPath=(id,rest='')=>'/api/v3/chat/sessions/'+encodeURIComponent(id)+rest;
export const agentPath=(id,filter='active')=>'/api/v3/chat/agents/'+encodeURIComponent(id)+'/sessions?filter='+encodeURIComponent(filter);
export const commandKey=()=>crypto.randomUUID();
export function chatSchema(topic){return ({'chat-agents':'chatAgents','chat-agent-sessions':'chatAgentSessions','chat-agent-sessions-archived':'chatAgentSessions','chat-session':'chatSession'})[String(topic).split(':')[0]]||null;}
export async function chatRead(path,{signal}={}){
 const result=await api.get(path,{apiVersion:3,quiet:true,signal});
 const schema=path.includes('/chat/agents/')?'chatAgentSessions':path.includes('/chat/sessions/')?'chatSession':'chatAgents';
 vmcheck.check(schema,result.data,'GET '+path,3);return result;
}
let split;
async function fetchChat(path,options){
 if(splitOrigin){split||=loadModule(()=>import('../split-auth.js'+buildQuery)).then(auth=>{auth.configure(api.ApiError,api.toApiError);return auth;});return (await split).request(apiUrl(path,3),options,apiUrl('/api/auth/refresh'));}
 try{return await fetch(apiUrl(path,3),{...options,credentials:'same-origin'});}catch(error){if(options.signal?.aborted)throw error;throw new api.ApiError({code:'network'});}
}
export async function chatCommand(path,body,{method='POST',key=commandKey(),signal,digest}={}){
 if(api.isMock()){const result=await (await api.mock()).handle(method,path,body);if(result.status>=400)throw api.toApiError(result.status,result.body);return result.body.data;}
 const form=body instanceof FormData;
 const response=await fetchChat(path,{method,signal,headers:{accept:'application/json','accept-language':getLang(),'x-ao-request':'1','Idempotency-Key':key,...(digest?{'Content-Digest':digest}:{}),...(form||body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:form?body:JSON.stringify(body)});
 const json=await response.json().catch(()=>null);signal?.throwIfAborted();
 if(!response.ok){const error=api.toApiError(response.status,json,response.headers.get('x-request-id'));if(error.status===401)api.notifyUnauthorized();throw error;}
 return json?.data;
}
export async function chatUpload(id,file,options){
 const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());options.signal?.throwIfAborted();
 const encoded=btoa(String.fromCharCode(...new Uint8Array(digest))),form=new FormData();form.append('file',file,file.name);
 return chatCommand(chatPath(id,'/attachments'),form,{...options,digest:'sha-256=:'+encoded+':'});
}
export async function downloadAttachment(file){
 const response=await fetchChat(file.url,{method:'GET',headers:{accept:'application/octet-stream'}});
 if(!response.ok){const error=api.toApiError(response.status,await response.json().catch(()=>null));if(error.status===401)api.notifyUnauthorized();throw error;}
 const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download=file.name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
