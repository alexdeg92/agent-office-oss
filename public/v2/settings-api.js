// Settings is a v3-only extension, including on deployments whose other views still use v2.
import { request } from './api.js';
import { check } from './vmcheck.js';

const ROOT = '/api/v3/settings';
const opts = {quiet:true, apiVersion:3};
export const readSettings = () => request('GET', ROOT, undefined, opts).then(r => r.data);
export const settingsCommand = (name, body = {}, method = 'POST') => request(method, ROOT + '/' + name, body, opts).then(r => {
  if (r.data?.vm) check('settings',r.data.vm,method + ' ' + ROOT + '/' + name);
  return r.data;
});
// A wrong confirmation password is a local form error, not an expired owner session.
export const reauthenticate = password => request('POST', ROOT + '/reauth', {password}, {...opts,
  notifyUnauthorized:error => !error.details?.some(d => d.issue === 'current-password'),
}).then(r => r.data);

// Poll only the config-owning API. Never send a second restart request on a polling failure.
export async function readBootId({signal}={}) {
  const timeout=AbortSignal.timeout(4000);
  const response=await request('GET','/api/v2/meta',undefined,{quiet:true,apiVersion:2,live:true,cache:'no-store',signal:signal ? AbortSignal.any([signal,timeout]) : timeout});
  const id=response?.data?.bootId;
  if(typeof id!=='string' || !id) throw Error('Restart identity unavailable');
  return id;
}
const pause=(ms,signal)=>new Promise((resolve,reject)=>{
  const done=()=>{signal?.removeEventListener('abort',aborted);resolve();};
  const timer=setTimeout(done,ms);
  const aborted=()=>{clearTimeout(timer);reject(signal.reason || Error('Aborted'));};
  if(signal?.aborted) aborted(); else signal?.addEventListener('abort',aborted,{once:true});
});
export async function pollRestart(bootId,{read=readBootId,signal,timeoutMs=90000,intervalMs=1000,now=Date.now,sleep=pause}={}) {
  if(typeof bootId!=='string' || !bootId) throw Error('Restart identity unavailable');
  const until=now()+timeoutMs;
  while(now()<until){
    signal?.throwIfAborted();
    try{const current=await read({signal});signal?.throwIfAborted();if(current && current!==bootId)return current;}
    catch(error){if(signal?.aborted)throw error;}
    signal?.throwIfAborted();
    await sleep(Math.min(intervalMs,Math.max(0,until-now())),signal);
  }
  throw Object.assign(Error('Restart timeout'),{code:'restart_timeout'});
}
