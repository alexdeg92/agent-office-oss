'use strict';
const path=require('node:path');
const {safePath,exists,binary}=require('./helpers');
const runtime='codex',name='Codex';
const detect=({env,home})=>{const codexHome=env.CODEX_HOME||path.join(home,'.codex'),sessions=path.join(codexHome,'sessions');const found=exists(codexHome,env)||!!binary('codex',env);return {runtime,name,found,checkedPaths:[sessions],reason:found?'presence':'none',confidence:found?'presence':'none',agents:[],connection:null,home:codexHome};};
module.exports={runtime,name,detect};
