'use strict';
const {createTeamStoreReader}=require('./store-reader');
module.exports={createSource:createTeamStoreReader,setup:{name:'Agent Team PM',capabilities:{autoEnableDefault:false,orchestration:{teams:true,members:true,tasks:true},
  projectSource:{id:'agent-team-pm',label:'Agent Team PM'},teamTasks:{read:true,write:false}}}};
