'use strict';
require('./scratch-home.cjs').requireScratchHome(__filename);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
// Dedicated scratch child: never starts server.js or reads the invoking user's HOME.
const {settingsFixture}=require('./settings-fixture');
const {detectRuntimes}=require('../../src/adapters/detection');
const {createHostSupervisor}=require('../../src/ops/host-supervisor');
let h;
process.on('message',async options=>{
 try{
  const real=await import('../frontend/helpers/settings-real-home.js');
  h=await settingsFixture({...real.realisticOptions,...options,
   fake:{start:async()=>options.gateway},detect:ctx=>detectRuntimes({...ctx,env:{...ctx.env,PATH:''}}),listenDesired:true,
   config(config,context){real.realisticOptions.config(config);config.network.port=options.port;},
   supervisor:createHostSupervisor({env:{AO_RESTART_POLICY:'always'},shutdown:exitCode=>process.exit(exitCode)})
  });
  const meta=(await h.get('/api/v2/meta')).json.data;
  process.send({type:'ready',base:h.base,cookie:h.cookie,bootId:meta.bootId,paths:h.paths});
 }catch(error){process.send({type:'error',error:error.stack});process.exit(1);}
});
process.on('SIGTERM',async()=>{await h?.close();process.exit(0);});
