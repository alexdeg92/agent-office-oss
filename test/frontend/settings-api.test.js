import test from 'node:test';
import assert from 'node:assert/strict';
import { configure } from '../../public/v2/config.js';
import * as api from '../../public/v2/api.js';
import { readSettings, settingsCommand, reauthenticate } from '../../public/v2/settings-api.js';
import { readFileSync } from 'node:fs';
import * as vmcheck from '../../public/v2/vmcheck.js';

test('Settings pins v3 on a v2 deployment; writes carry CSRF, password-confirmation 401 stays local',async () => {
  const original=globalThis.fetch,calls=[];
  configure({apiVersion:2,apiBase:'/backend',basePath:'/v2/'});
  let expired=0,issue='current-password'; const remove=api.onUnauthorized(()=>expired++);
  globalThis.fetch=async (url,opts={})=>{
    calls.push({url,...opts});
    const bad=url.endsWith('/reauth');
    const body=bad ? {error:{code:'unauthorized',details:[{field:'password',issue}]}} : {data:{revision:1},meta:{modelVersion:1}};
    return {ok:!bad,status:bad?401:200,headers:{get:()=>null},json:async()=>body};
  };
  try {
    await api.init({search:'',hostname:'settings.example.test'});
    await readSettings(); await settingsCommand('detect');
    await assert.rejects(reauthenticate('fixture wrong password'),e=>e.status===401);
    assert.equal(expired,0);
    assert.deepEqual(calls.slice(1).map(c=>c.url),['/backend/api/v3/settings','/backend/api/v3/settings/detect','/backend/api/v3/settings/reauth']);
    assert.equal(calls[2].headers['x-ao-request'],'1');
    assert.equal(calls[2].credentials,'same-origin');
    issue='expired-session';
    await assert.rejects(reauthenticate('fixture password'),e=>e.status===401);
    assert.equal(expired,1,'reauth with an expired owner session invokes the ordinary login flow');
    await assert.rejects(api.request('POST','/api/v3/settings/reauth',{}));
    assert.equal(expired,2,'ordinary unauthorized errors still expire the owner session');
  } finally {globalThis.fetch=original;remove();configure({});}
});

test('dev validation rejects leaked credentials in GET and command SettingsVMs without exposing their values',async () => {
  const original=globalThis.fetch;
  const vm=JSON.parse(readFileSync(new URL('../../docs/architecture/examples/settings/settings-vm.json',import.meta.url))).data;
  vm.runtimes[0].values.token.value='fixture credential must not be echoed';
  configure({apiVersion:2});
  await vmcheck.enable({onIssue:(_,name,issues)=>{throw Error(name+' rejected at '+issues[0].path);}});
  globalThis.fetch=async(_,opts)=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({data:opts.method==='GET'?vm:{ok:true,result:{},vm,revision:vm.revision}})});
  try{
    for(const command of [()=>readSettings(),()=>settingsCommand('instance',{name:'Fixture'},'PUT')]) {
      await assert.rejects(command(),error=>error.message.startsWith('settings rejected') && !error.message.includes('fixture credential'));
    }
  }finally{globalThis.fetch=original;vmcheck.disable();configure({});}
});
