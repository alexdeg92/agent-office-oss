'use strict';
const {match}=require('path-to-regexp');
const {ApiError,sendError}=require('../api/v2/errors');
const REFRESH=/^\/api\/auth\/refresh\/?$/i;
const METHODS=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
const HEADERS=new Set(['authorization','content-type','x-ao-csrf','x-ao-request','last-event-id']);
function canonicalOrigin(value) {
  if(typeof value!=='string'||value.length>512)throw new TypeError('invalid access origin');
  let u;try{u=new URL(value);}catch{throw new TypeError('invalid access origin');}
  if(u.protocol!=='https:'||u.hostname.includes('*')||u.username||u.password||u.search||u.hash||u.pathname!=='/'||u.origin!==value)throw new TypeError('invalid access origin');
  return value;
}
function allowedOrigins(value) {
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{throw new TypeError('invalid allowed origins');}}
  if(!Array.isArray(value)||value.length>16)throw new TypeError('invalid allowed origins');
  const origins=value.map(canonicalOrigin);if(new Set(origins).size!==origins.length)throw new TypeError('duplicate allowed origin');
  return Object.freeze(origins);
}
function canonicalApiBase(value) {
  if(typeof value!=='string'||!value||value.length>1024)throw new TypeError('invalid public API base');
  let u;try{u=new URL(value);}catch{throw new TypeError('invalid public API base');}
  const prefix=u.pathname==='/'?'':u.pathname;
  if(u.protocol!=='https:'||u.hostname.includes('*')||u.username||u.password||u.search||u.hash||prefix.length>256||prefix&&!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix)||value!==u.origin+prefix)throw new TypeError('invalid public API base');
  return value;
}
function createAccessBoundary({installationId,apiPublicUrl,origins}) {
  if(typeof installationId!=='string'||!installationId||installationId.length>256||/[\x00-\x20\x7f]/.test(installationId))throw new TypeError('invalid installation id');
  const apiBase=canonicalApiBase(apiPublicUrl),list=allowedOrigins(origins),set=new Set(list),apiOrigin=new URL(apiBase).origin;
  return Object.freeze({apiPublicUrl:apiBase,apiOrigin,origins:list,audience:installationId+'@'+apiBase,
    allows(origin){try{return set.has(canonicalOrigin(origin));}catch{return false;}}});
}
// Use actual registered route rows, including literal aliases. Match with Express's
// path-to-regexp semantics; no prefix-based method guesses or wildcard preflights.
function createCorsRouteIndex(rows) {
  const paths=new Map();
  for(const row of rows) {
    if(!METHODS.has(row.method)||row.method==='OPTIONS'||typeof row.path!=='string'||row.path==='/.*/')continue;
    let methods=paths.get(row.path);if(!methods)paths.set(row.path,methods=new Set());methods.add(row.method);if(row.method==='GET')methods.add('HEAD');
  }
  const routes=[...paths].map(([path,methods])=>({matches:match(path,{sensitive:false,trailing:true}),methods}));
  return path=>{
    if(typeof path!=='string'||path.length>2048)return [];
    const methods=new Set();try{for(const route of routes)if(route.matches(path))for(const method of route.methods)methods.add(method);}catch{return [];}
    return [...methods].sort();
  };
}
// Opt-in middleware only: callers must mount before credential admission/body parsing.
// current() is evaluated on every request, so a cached preflight cannot preserve a
// removed origin. Policy activation and persistent family revocation are separate.
function createCorsGate({current,methodsFor,onRefused=()=>{}}) {
  if(typeof current!=='function'||typeof methodsFor!=='function')throw new TypeError('invalid CORS boundary');
  const refuse=(req,res,issue)=>{onRefused(req,res,issue);return sendError(req,res,new ApiError('forbidden',{details:[{issue}]}));};
  return (req,res,next)=>{
    res.vary('Origin');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Strict-Transport-Security','max-age=31536000');
    const refresh=REFRESH.test(req.path),preflight=req.method==='OPTIONS',origin=req.headers.origin,policy=current();
    if(preflight){res.vary('Access-Control-Request-Method');res.vary('Access-Control-Request-Headers');}
    if(origin===undefined&&!refresh&&!preflight)return next();
    res.setHeader('Cache-Control','no-store');
    if(!policy?.allows(origin))return refuse(req,res,'origin');
    let methods;
    if(preflight) {
      const method=req.headers['access-control-request-method'],raw=req.headers['access-control-request-headers'];methods=methodsFor(req.path);
      if(typeof method!=='string'||!METHODS.has(method)||!methods.includes(method))return refuse(req,res,'cors-method');
      if(raw!==undefined&&(typeof raw!=='string'||raw.length>1024))return refuse(req,res,'cors-headers');
      const headers=raw===undefined||raw.trim()===''?[]:raw.toLowerCase().split(',').map(h=>h.trim());
      if(headers.length>HEADERS.size||new Set(headers).size!==headers.length||headers.some(h=>!HEADERS.has(h)))return refuse(req,res,'cors-headers');
      res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Methods',methods.join(', '));
      if(headers.length)res.setHeader('Access-Control-Allow-Headers',headers.join(', '));
      if(refresh)res.setHeader('Access-Control-Allow-Credentials','true');
      res.setHeader('Access-Control-Max-Age','300');return res.status(204).end();
    }
    res.setHeader('Access-Control-Allow-Origin',origin);if(refresh)res.setHeader('Access-Control-Allow-Credentials','true');
    res.setHeader('Access-Control-Expose-Headers','X-Request-Id, Retry-After');next();
  };
}
module.exports={canonicalOrigin,allowedOrigins,canonicalApiBase,createAccessBoundary,createCorsRouteIndex,createCorsGate};
