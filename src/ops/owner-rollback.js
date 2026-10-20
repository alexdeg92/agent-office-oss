'use strict';
const crypto=require('node:crypto');
const path=require('node:path');
const {openStore}=require('../store');
const {defaultDataDir}=require('../config');
const {hashPasswordSync,verifyPassword,isHash}=require('../security/password');

function parse(args) {
  const options={mode:null,data:null,config:null,envFile:null};
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg==='--dry-run'||arg==='--apply') {
      if(options.mode)throw new Error('choose one of --dry-run or --apply');
      options.mode=arg.slice(2);
    } else if(['--data','--config','--env-file'].includes(arg)) {
      const value=args[++i];if(!value||value.startsWith('-'))throw new Error(`missing value for ${arg}`);
      options[arg.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if(!options.mode)throw new Error('specify --dry-run or --apply');
  return options;
}

function readHiddenPassword(stdin=process.stdin,stderr=process.stderr) {
  if(!stdin.isTTY||typeof stdin.setRawMode!=='function')throw new Error('apply requires a terminal for environment credential verification');
  return new Promise((resolve,reject)=>{
    stderr.write('Verify the retained environment password (hidden): ');
    stdin.setRawMode(true);stdin.resume();stdin.setEncoding('utf8');let value='';
    const finish=(error)=>{try{stdin.setRawMode(false);}catch{}stdin.pause();stdin.off('data',onData);stderr.write('\n');error?reject(error):resolve(value);};
    const onData=chunk=>{for(const c of chunk){
      if(c==='\r'||c==='\n')return finish();
      if(c==='\u0003')return finish(new Error('cancelled'));
      if(c==='\u007f'||c==='\b')value=value.slice(0,-1);
      else if(!/[\x00-\x1f\x7f]/.test(c)&&value.length<1024)value+=c;
    }};
    stdin.on('data',onData);
  });
}

function environment(env) {
  const email=String(env.PORTAL_EMAIL||'').trim().toLowerCase(),displayName=String(env.PORTAL_DISPLAY_NAME||'').trim();
  const secret=env.PORTAL_SECRET,passwordHash=env.PORTAL_PASSWORD_HASH||null,password=env.PORTAL_PASSWORD||null;
  if(!/^[^@\s]{1,64}@[^@\s]{1,190}$/.test(email)||!displayName||displayName.length>80||typeof secret!=='string'||secret.length<32||secret.length>256
    ||(passwordHash&&!isHash(passwordHash))||(!passwordHash&&(!password||password.length>1024)))throw new Error('complete retained environment owner credentials are required');
  return {email,displayName,secret,passwordHash,password,credentialHash:passwordHash||hashPasswordSync(password)};
}

function fingerprint(envCred) {
  return crypto.createHmac('sha256',envCred.secret)
    .update(JSON.stringify(['agent-office/env-credential/v1',envCred.email,envCred.passwordHash?'hash':'password',envCred.passwordHash||envCred.password]))
    .digest('hex');
}

async function run(args,env=process.env,io={}) {
  const out=io.out||((text)=>process.stdout.write(text+'\n'));
  const err=io.err||((text)=>process.stderr.write(text+'\n'));
  let options;
  try{options=parse(args);}catch(error){err(`agent-office owner rollback-env: ${error.message}`);return 1;}
  let effective={...env};
  if(options.envFile) {
    try{effective=require('../../packaging/bin/agent-office').loadEnvFile(options.envFile,effective);}
    catch(error){err(`agent-office owner rollback-env: cannot read env file (${error.code||'error'})`);return 1;}
  }
  if(options.config)effective.AO_CONFIG=options.config;
  if(options.data)effective.AO_DATA_DIR=options.data;
  let credentials;
  try{credentials=environment(effective);}catch(error){err(`agent-office owner rollback-env: ${error.message}`);return 1;}
  const instance=effective.AO_ENV||(effective.PORTAL_READONLY==='1'?'staging':effective.NODE_ENV==='production'?'production':'dev');
  const dataDir=path.resolve(effective.AO_DATA_DIR||defaultDataDir(effective,instance));
  let store;
  try {
    store=(io.openStore||openStore)({dir:dataDir,instance,ownerName:credentials.displayName,log:()=>{}});
    const owner=store.users.owner(),migration=store.db.prepare('SELECT state FROM owner_auth_migration WHERE singleton=1').get();
    if(!owner||owner.status!=='active'||owner.credential_source!=='database'||migration?.state!=='complete')throw new Error('owner rollback is not available for this store');
    if(options.mode==='dry-run') {
      out('dry-run: owner profile and credential mode are eligible; application data will be preserved');return 0;
    }
    let password;
    try{password=await (io.readPassword||(()=>readHiddenPassword(io.stdin||process.stdin,io.stderr||process.stderr)) )();}
    catch{throw new Error('environment credential verification was not completed');}
    if(!await verifyPassword(password,credentials.credentialHash))throw new Error('environment credential verification failed');
    if(owner.person_id!==store.owner.id)throw new Error('owner identity is not the configured instance owner');
    store.users.rollbackEnvOwner({email:credentials.email,displayName:credentials.displayName,fingerprint:fingerprint(credentials),personId:owner.person_id,
      auditWrite:()=>store.audit.append({at:Date.now(),requestId:'req_owner_env_rollback',actor:{kind:'system',component:'engine'},command:'auth.owner.rollbackEnv',target:null,outcome:'ok',detail:'env-credentials-restored'})});
    out('owner rollback complete; non-owner data preserved');return 0;
  } catch(error) {
    err(`agent-office owner rollback-env: ${error.message==='environment credential verification failed'?'environment credential verification failed':error.message==='environment credential verification was not completed'?'environment credential verification was not completed':'refused or failed'}`);return 1;
  } finally {try{store?.close();}catch{}}
}

module.exports={parse,run,readHiddenPassword};
