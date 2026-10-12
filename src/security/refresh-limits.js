'use strict';
// Rolling windows include refusals. Separate bounded maps prevent unknown IPs
// evicting a live family bucket. At capacity, reject new keys until old keys expire.
function createRefreshLimits({now=Date.now,ipLimit=60,familyLimit=30,maxIps=10000,maxFamilies=4096,windowMs=60000}={}) {
  for(const value of [ipLimit,familyLimit,maxIps,maxFamilies,windowMs])if(!Number.isSafeInteger(value)||value<1)throw new TypeError('invalid refresh limit');
  const ips=new Map(),families=new Map();
  function take(map,key,limit,max,t) {
    while(map.size&&map.values().next().value.until<=t)map.delete(map.keys().next().value);
    let row=map.get(key);
    if(!row&&map.size>=max)return {ok:false,retryAfterSec:Math.max(1,Math.ceil((map.values().next().value.until-t)/1000))};
    if(!row)row={times:[],until:t+windowMs};
    row.times=row.times.filter(at=>at>t-windowMs);row.times.push(t);if(row.times.length>limit+1)row.times.shift();row.until=t+windowMs;
    map.delete(key);map.set(key,row);
    return row.times.length<=limit?{ok:true}:{ok:false,retryAfterSec:Math.max(1,Math.ceil((row.times[0]+windowMs-t)/1000))};
  }
  return {admit(ip,familyId=null){const t=now(),a=take(ips,ip,ipLimit,maxIps,t),b=familyId?take(families,familyId,familyLimit,maxFamilies,t):{ok:true};return !a.ok?a:b;}};
}
module.exports={createRefreshLimits};
