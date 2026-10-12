// Loaded only for split-origin deployments; credentials and access tokens never enter storage.
let humanAccessToken = null;
let refreshFlight = null;
let ApiErrorType, toApiErrorFn;

export const configure = (ApiError, toApiError) => { ApiErrorType=ApiError;toApiErrorFn=toApiError; };

function value(result) {
  if(result.ok)return result.value;
  const error=result.error;
  if(error.code==='network')throw new ApiErrorType({code:'network'});
  throw toApiErrorFn(error.status,error.json,error.requestId);
}

async function authOperation(url, body, csrfToken = null) {
  let response;
  try {
    response = await fetch(url, {method:'POST',credentials:'include',cache:'no-store',redirect:'error',
      headers:{accept:'application/json','content-type':'application/json','x-ao-request':'1',...(csrfToken?{'x-ao-csrf':csrfToken}:{})},body:JSON.stringify(body)});
  } catch { return {ok:false,error:{code:'network'}}; }
  const json = await response.json().catch(()=>null);
  if (!response.ok) return {ok:false,error:{status:response.status,json,requestId:response.headers.get('x-request-id')}};
  return {ok:true,value:json};
}

export async function login(url, email, password) {
  const challenge = value(await authOperation(url,{operation:'challenge',purpose:'login'}));
  const result = value(await authOperation(url,{operation:'login',email,password},challenge.csrfToken));
  humanAccessToken = result.accessToken;
  return {data:result.me};
}

export async function logout(url) {
  if (!humanAccessToken) return {data:{ok:true}};
  const challenge = value(await authOperation(url,{operation:'challenge',purpose:'logout'}));
  const result = value(await authOperation(url,{operation:'logout'},challenge.csrfToken));
  humanAccessToken = null;
  return {data:result};
}

export function refresh(url) {
  if (refreshFlight) return refreshFlight;
  refreshFlight = (async()=>{
    const challenge = await authOperation(url,{operation:'challenge',purpose:'refresh'});
    if (!challenge.ok) {
      humanAccessToken = null;
      if(challenge.error.status===401)return false;
      return value(challenge);
    }
    const result = await authOperation(url,{operation:'refresh'},challenge.value.csrfToken);
    if (!result.ok) {
      humanAccessToken = null;
      if(result.error.status===401)return false;
      return value(result);
    }
    humanAccessToken = result.value.accessToken;
    return !!humanAccessToken;
  })().finally(()=>{refreshFlight=null;});
  return refreshFlight;
}

export async function request(url, options, refreshUrl) {
  const send = () => fetch(url,{...options,credentials:'omit',redirect:'error',headers:{...options.headers,...(humanAccessToken?{authorization:'Bearer '+humanAccessToken}:{})}});
  let response;
  try { response=await send(); } catch { throw new ApiErrorType({code:'network'}); }
  if(response.status===401&&humanAccessToken&&['GET','HEAD'].includes(String(options.method||'GET').toUpperCase())&&!/\/api\/auth\//.test(url)){
    if(await refresh(refreshUrl)){try{response=await send();}catch{throw new ApiErrorType({code:'network'});}}
  }
  return response;
}

export async function me(url, read) {
  if(!humanAccessToken&&!await refresh(url))return null;
  try{return (await read())?.data??null;}
  catch(error){if(error instanceof ApiErrorType&&error.status===401)return null;throw error;}
}
