'use strict';
const {createTeamStoreReader}=require('./store-reader');
module.exports={createSource:createTeamStoreReader,setup:{name:'Agent Team PM',capabilities:{autoEnableDefault:false,teamTasks:{read:true,write:false}}}};
