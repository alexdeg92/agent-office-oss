import { buildQuery } from '../config.js';
let styles;
export function loadAccessStyles(){
  if(!globalThis.document)return Promise.resolve();
  return styles ||= new Promise((resolve,reject)=>{
    const sheet=document.createElement('link');sheet.rel='stylesheet';sheet.href=new URL('./access.css'+buildQuery,import.meta.url).href;
    sheet.onload=resolve;sheet.onerror=()=>{sheet.remove();styles=null;reject(Error('Access stylesheet unavailable'));};
    document.head.append(sheet);
  }).catch(error=>{styles=null;throw error;});
}
