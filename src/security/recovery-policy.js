'use strict';
function recoveryRouteAllowed(req) {
  const method=String(req.method||'').toUpperCase();
  let path=(req.baseUrl||'')+(req.path||'');
  // Match Express defaults for route matching: case-insensitive and one
  // optional trailing slash, without accepting extra path segments.
  if(path.length>1&&path.endsWith('/'))path=path.slice(0,-1);
  path=path.toLowerCase();
  return method==='GET'&&path==='/api/v3/settings/recovery'
    ||method==='POST'&&path==='/api/v3/settings/reauth'
    ||method==='PUT'&&path==='/api/v3/settings/owner'
    ||method==='POST'&&path==='/api/v3/settings/password'
    ||method==='POST'&&path==='/api/logout';
}
function recoverySessionAllowed(req,session) {return session?.recoveryOnly!==true||recoveryRouteAllowed(req);}
module.exports={recoveryRouteAllowed,recoverySessionAllowed};
