'use strict';
const {createHerdrReader}=require('./reader');
const path=require('node:path');
function detectSource({env,binaryPath=null}) {
  const files=require('../../ops/local-files');
  const requested=binaryPath==null&&typeof env.AO_HERDR_BIN==='string'?env.AO_HERDR_BIN:binaryPath;
  if(requested===false)return null;
  if(typeof requested==='string'){
    if(!path.isAbsolute(requested)||requested.length>4096||requested.includes('\0'))return null;
    return binaryPath==null&&env.AO_HERDR_BIN===requested?files.executable(requested,env):requested;
  }
  const absolutePath=String(env.PATH||'').split(path.delimiter).filter(dir=>path.isAbsolute(dir)&&dir.length<=4096&&!dir.includes('\0')).join(path.delimiter);
  const found=files.binary('herdr',{...env,PATH:absolutePath});
  return found&&path.isAbsolute(found)?found:null;
}
module.exports={createSource:createHerdrReader,detectSource,setup:{name:'herdr',capabilities:{autoEnableDefault:true,
  brand:{mark:'H',color:'#4f6d9a',foreground:'#ffffff',providerName:'herdr',logo:'assets/connectors/herdr.svg'}}}};
