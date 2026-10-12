'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
test('shipped systemd unit restarts the dedicated API restart status and declares the policy',()=>{
 const unit=read('agent-office.service');assert.match(unit,/^RestartForceExitStatus=75$/m);assert.match(unit,/^Environment=AO_RESTART_POLICY=on-failure$/m);assert.match(unit,/^Restart=on-failure$/m);
 const guide=read('docs/architecture/go-live.md');assert.match(guide,/RestartForceExitStatus=75/);assert.match(guide,/AO_RESTART_POLICY=on-failure/);
});
test('Homebrew and Docker supervisor declarations agree with their actual restart policies',()=>{
 const brew=read('packaging/homebrew/agent-office.rb');assert.match(brew,/keep_alive true/);assert.match(brew,/export AO_RESTART_POLICY=always/);
 for(const file of ['packaging/docker/compose.yml','packaging/docker/docker-compose.example.yml']){const docker=read(file);assert.match(docker,/restart: unless-stopped/);assert.match(docker,/AO_RESTART_POLICY: unless-stopped/);}
});
test('systemd presence alone is insufficient; an explicit restart policy exits with status 75',()=>{
 const {createHostSupervisor}=require('../../src/ops/host-supervisor');
 for(const env of [{INVOCATION_ID:'fixture'},{NOTIFY_SOCKET:'fixture'},{INVOCATION_ID:'fixture',AO_RESTART_POLICY:'no'}])assert.equal(createHostSupervisor({env,shutdown(){throw Error('must not exit')}}).supported,false);
 for(const env of [{AO_SUPERVISED:'1'},{AO_RESTART_POLICY:'always'},{AO_RESTART_POLICY:'on-failure'},{AO_RESTART_POLICY:'unless-stopped'}]){let status=null;const s=createHostSupervisor({env,shutdown:code=>{status=code;}});assert.equal(s.supported,true);s.restart();assert.equal(status,75);}
});
test('restart status exits a real scratch process and the npm wrapper propagates it',async()=>{
 const {spawnSync}=require('node:child_process');const result=spawnSync(process.execPath,['-e',"require(process.argv[1]).createHostSupervisor({env:{AO_RESTART_POLICY:'on-failure'},shutdown:code=>process.exit(code)}).restart()",path.join(root,'src/ops/host-supervisor.js')],{env:{HOME:require('node:os').tmpdir(),PATH:''},encoding:'utf8'});assert.equal(result.status,75,result.stderr);
 const child=new (require('node:events').EventEmitter)();const done=require('../../packaging/bin/agent-office').superviseChild(child);child.emit('exit',result.status);assert.equal(await done,75);
});
