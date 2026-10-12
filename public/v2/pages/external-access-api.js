// T-0076 external-access contract client. Setup credentials stay in request bodies only.
import { request } from '../api.js';
const ROOT='/api/v3';
const opts={quiet:true,apiVersion:3};
const unwrap=promise=>promise.then(response=>response.data);
export const readExternalAccess=({setupCode}={})=>setupCode
  ? unwrap(request('POST',ROOT+'/setup/access/state',{setupCode},{...opts,apiVersion:3}))
  : unwrap(request('GET',ROOT+'/settings/access',undefined,opts));
export const planExternalAccess=(context,body)=>unwrap(request('POST',`${ROOT}/${context}/access/plan`,body,opts));
export const startExternalAccessChecks=(context,body)=>unwrap(request('POST',`${ROOT}/${context}/access/checks`,body,opts));
export const readExternalAccessChecks=(context,body)=>unwrap(request('POST',`${ROOT}/${context}/access/checks/status`,body,opts));
export const cancelExternalAccessChecks=(context,body)=>unwrap(request('POST',`${ROOT}/${context}/access/checks/cancel`,body,opts));
export const applyExternalAccess=(context,body)=>unwrap(request('POST',`${ROOT}/${context}/access/apply`,body,opts));
export const verifyExternalAccess=(context,body)=>unwrap(request('POST',`${ROOT}/${context}/access/verify`,body,opts));
