'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);

// A healthy, empty registered team. Runtime occupants remain canonical engine
// rows; this fixture supplies the unrelated Members/host panels' real API data.
function emptyTeamSource({clock}) {
 return {detected:true,hasHerdr:true,hasTeamStore:true,enabled:true,start(){},close(){},onChange:()=>()=>{},
  getSnapshot:()=>({observedAt:clock.value,revision:1,hostRevision:1,teamRevision:1,sourcesReady:true,
   team:{id:'team:empty-fixture',label:'Équipe synthétique',status:'active'},
   hosts:[],orchestrators:[],agents:[],identityLinks:[],members:[],tasks:[],reviews:[],
   privateMemberSessionKeys:{},privateMemberSessionRefs:{}})};
}
const emptyTeamOptions={orchestratorTeams:emptyTeamSource,
 sourcePrincipalFor:()=>({id:'admin-fixture',role:'admin',permissionRevision:1}),sessionsReadable:()=>true};
module.exports={emptyTeamOptions};
