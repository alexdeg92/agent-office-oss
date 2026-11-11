'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);
const {createEngine}=require('../../src/engine');
const {normaliseSession}=require('../../src/adapters/openclaw/normalise/session');
const {buildOfficeVM,createStateTracker}=require('../../src/api/v2/vm/office');
const {project2x}=require('../../src/api/v2/project2x');
const {project3x}=require('../../src/api/v2/project3x');
const raw=require('../fixtures/channel-account-dm.json').body.value;
const NOW=1794355200000;
function channelOffice({channel='wechat-native-isolated',peer='synthetic-peer',person='Synthetic person',sender=null,canReadSessions=true,version=3}={}){
  const engine=createEngine({now:()=>NOW});
  engine.setGatewayConnected(true);
  engine.ingestCanonical('agents',[{id:'synthetic-agent',name:'Synthetic agent',workspace:null,model:null,fallbackModels:[],isPrimary:true,mainSessionKey:'agent:synthetic-agent:main'}]);
  const session=normaliseSession({...raw,key:`agent:synthetic-agent:${channel}:synthetic-account:direct:${peer}`,updatedAt:NOW,hasActiveRun:true}).session;
  engine.ingestCanonical('sessions.snapshot',[normaliseSession({key:'agent:synthetic-agent:main',updatedAt:NOW,hasActiveRun:false}).session,session]);
  const P=version===3?project3x:project2x;
  const options={engine,now:NOW,tracker:createStateTracker(),canReadSessions,P,names:{interlocutorName:()=>person,senderName:()=>sender},actorOf:()=>({kind:'system',name:'System'})};
  return {engine,session,options,vm:buildOfficeVM(options)};
}
module.exports={channelOffice,NOW};
