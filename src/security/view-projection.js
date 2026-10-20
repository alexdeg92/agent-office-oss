'use strict';
const {ApiError}=require('../api/v2/errors');
const {createHash}=require('node:crypto');
const {TOPICS,COMMANDS}=require('./route-declarations');
const {schemasFor}=require('../api/v2/vm/schemas');
const {validate}=require('../schema');
const {PROJECT_CONTEXT_READS,mayRead:mayReadComment}=require('./comment-provenance');
const {labelsFor}=require('../i18n');
const {projectCapabilityRows}=require('../projects/vm');
const {redactChatIdentity}=require('./redact-text');
const {scopeForAccount,portalChatIdentity,visibleToAccount}=require('../api/chat-identity');
const {executionState}=require('../engine/execution-state');
const boardAccessMetadata=require('../projects/board-access');
const boardAccessFor=boardAccessMetadata.forBoard;
const REQUIREMENTS=new Map([...TOPICS].map(([name,spec])=>[name,spec.resource]));
REQUIREMENTS.set('history','projects');REQUIREMENTS.set('candidates','projects');
REQUIREMENTS.set('layoutRevision','store');
REQUIREMENTS.set('orchestrators','orchestrators');REQUIREMENTS.set('teams','teams');
REQUIREMENTS.set('officeCharacters','office');
REQUIREMENTS.set('officePalette','office');
REQUIREMENTS.set('officeStore','store');
REQUIREMENTS.set('projectCreate','projects');REQUIREMENTS.set('projectKickoff','projects');
for(const name of ['chatAgents','chatAgentSessions','chatSession'])REQUIREMENTS.set(name,'chat');
for(const name of ['chat-agents-scope','chat-agent-sessions-scope','chat-session-scope'])REQUIREMENTS.set(name,'chat');
const SELF=new Set(['meta','me','settings']);
const SAFE_HISTORY=new Set(['project-created','renamed','status','priority','archived','restored','commit','agent-action']);
const SUMMARY_ROLES=new Set(['main','primary','agent']);
const CHAT_VIEW_SCHEMAS={'chat-agents':'chatAgents','chat-agent-sessions':'chatAgentSessions','chat-agent-sessions-archived':'chatAgentSessions','chat-session':'chatSession','chat-agents-scope':'chatAgents','chat-agent-sessions-scope':'chatAgentSessions','chat-session-scope':'chatSession',chatAgents:'chatAgents',chatAgentSessions:'chatAgentSessions',chatSession:'chatSession'};
const countLabel=n=>({key:n===1?'office.characters.count.one':'office.characters.count.other',params:{n}});
const denied=()=>new ApiError('forbidden',{details:[{issue:'permission-denied'}]});

// This module has no shared last-good cache. Both transports receive a fresh actor projection.
function createViewProjection({store,cfg={},isTeamProject=()=>false,chatSessionForKey=()=>null,officeSessions=null,officeEvents=null}) {
  // Stream snapshots are projected once when assembled and again at the frame
  // boundary. Remember this projector's private provenance outside the wire
  // object so the same principal's second pass is a no-op, while changed grants
  // still re-project using the original pre-filter facets.
  const projectedVmMetadata=new WeakMap();
  // A topic version is a deterministic fingerprint of the principal-visible VM.
  // It cannot reveal shared raw-topic churn and has no evictable counter state.
  function fingerprint(user,_topic,vm,_version=3) {
    identity(user);
    return createHash('sha256').update(JSON.stringify(vm)).digest('hex');
  }
  function revision(user,topic,vm,version=3) {
    // api.md requires a safe integer on the wire. Keep 52 digest bits as that
    // compatibility token; SSE compares the full digest to avoid treating a
    // truncated-hash collision as an unchanged payload.
    return Number.parseInt(fingerprint(user,topic,vm,version).slice(0,13),16);
  }
  function identity(user) {
    const current=store.users.byId(typeof user==='string'?user:user?.id);
    if(current?.status!=='active')throw new ApiError('unauthorized');return current;
  }
  const can=(user,key,level='read')=>store.policy.can(user,key,level);
  const sourceReadable=(user,kind)=>{
    if(kind==='runtime'||kind==='workspace')return can(user,'logs')&&can(user,'settings.runtimes');
    if(kind==='sessionGroup')return can(user,'logs');
    if(kind==='orchestrator-team')return can(user,'teams');
    return true;
  };
  function authorize(user,name) {
    const current=identity(user),resource=REQUIREMENTS.get(name);
    if(!resource&&!SELF.has(name))throw new Error('undeclared view projection '+name);
    if(resource&&!can(current,resource)||name==='officeStore'&&!can(current,'office'))throw denied();return current;
  }
  function capabilities(user,base={openclawWrites:true,storeWrites:true}) {
    const specs=[...COMMANDS.values()],allows=cls=>specs.some(s=>s.writeClass===cls&&s.requirements.length&&s.requirements.every(r=>can(user,r.resource,r.level)));
    return {openclawWrites:!!base.openclawWrites&&!cfg.readonly&&allows('openclaw'),storeWrites:!!base.storeWrites&&!cfg.readonlyStore&&allows('store')};
  }
  function history(user,items) {
    const allRelated=can(user,'logs')&&can(user,'flows')&&can(user,'settings.runtimes');
    return items.filter(item=>{
      if(item.actor?.kind==='agent'&&!allRelated)return false;
      if(item.session||item.kind==='session')return can(user,'logs');
      if(['flow-run','cron-run'].includes(item.kind))return can(user,'flows')&&can(user,'logs');
      return allRelated||SAFE_HISTORY.has(item.kind);
    });
  }
  function cover(user,value) {
    if(value.cover&&value.cover.source!=='upload'&&!PROJECT_CONTEXT_READS.every(r=>can(user,r.resource,r.level))) {
      value.cover=null;value.thumb={...value.thumb,kind:'monogram',url:null};
    }
    return value;
  }
  function card(user,card) {
    const descriptors=card.sourceDescriptors||[];
    const withheldSourceData=descriptors.some(source=>!sourceReadable(user,source.kind));
    card.sourceDescriptors=descriptors.filter(source=>sourceReadable(user,source.kind));
    if(!can(user,'logs')||withheldSourceData) {
      card.people.visible=[];card.people.hiddenCount=null;card.lastActivityAt=null;
      card.flags.visible=card.flags.visible.filter(f=>f.kind!=='risk');card.flags.hiddenCount=null;
    }
    if((!can(user,'logs')||withheldSourceData)&&card.counts)
      card.counts={...card.counts,sessions:null,agents:null,activity:null};
    return cover(user,card);
  }
  function field(value,source='file',editable=false) {
    return {value,source,editable,reason:editable?null:{key:'sourceError.permission-denied'}};
  }
  function project(user,name,raw,{version=3}={}) {
    if(version!==2&&version!==3)throw new TypeError('unsupported projection contract');
    name=name.split(/[?:]/,1)[0];user=authorize(user,name);
    const schemaName=CHAT_VIEW_SCHEMAS[name]||name;
    if(CHAT_VIEW_SCHEMAS[name]&&version!==3)throw new Error('unsupported chat projection version');
    const schema=schemasFor(version)[schemaName];
    if(!schema||!validate(schema,raw).ok)throw new Error('invalid raw view projection '+name);
    const permissions=store.rbac.fingerprint(user.id),content=createHash('sha256').update(JSON.stringify(raw)).digest('hex');
    const prior=projectedVmMetadata.get(raw);
    if(prior&&prior.userId===user.id&&prior.permissions===permissions&&prior.content===content)return structuredClone(raw);
    const privateBoardAccess=boardAccessFor(raw);
    const boardAccess=privateBoardAccess;
    const vm=structuredClone(raw),logs=can(user,'logs'),runtimes=can(user,'settings.runtimes');
    if(name==='office') {
      // Portal-chat occupants are private even to administrators. The old
      // unscoped session has ambiguous ownership and belongs only in Logs.
      const callerScope=scopeForAccount(user.id,store),hiddenChatOccupants=[];
      // Filter the canonical population independently from stage membership:
      // explicit/dashboard sessions often feed a primary aggregate but have no
      // standalone occupant of their own. All session-derived Office totals and
      // journal rows must use this account-visible population.
      const canonicalOfficeSessions=logs&&typeof officeSessions==='function'?(officeSessions()||[]):null;
      const visibleOfficeSessions=canonicalOfficeSessions?.filter(session=>visibleToAccount(session,callerScope,{legacy:false}))||null;
      const knownSessionKeys=canonicalOfficeSessions?new Set(canonicalOfficeSessions.map(session=>session.key).filter(Boolean)):null;
      const hiddenSessionKeys=new Set(canonicalOfficeSessions&&visibleOfficeSessions
        ?canonicalOfficeSessions.filter(session=>!visibleToAccount(session,callerScope,{legacy:false})).map(session=>session.key).filter(Boolean):[]);
      // liveEvents is a bounded journal and may outlive its canonical session.
      // An unknown source is not public provenance: fail closed until a current
      // session proves that the event belongs to this account's visible set.
      const sourceUnverifiableEvents=new Set(logs&&typeof officeEvents==='function'?(officeEvents()||[])
        .filter(event=>event.sessionKey&&(!knownSessionKeys?.has(event.sessionKey)||hiddenSessionKeys.has(event.sessionKey)))
        .map(event=>event.id):[]);
      vm.occupants=vm.occupants.filter(occupant=>{
        const session=occupant.sessionKey&&chatSessionForKey(occupant.sessionKey,version);
        const identity=portalChatIdentity(session);
        if(!identity)return true;
        if(identity.kind==='legacy'||identity.scope!==callerScope){hiddenChatOccupants.push({occupant,session});if(session?.key)hiddenSessionKeys.add(session.key);return false;}
        return true;
      });
      if(hiddenChatOccupants.length||hiddenSessionKeys.size||sourceUnverifiableEvents.size) {
        const hiddenIds=new Set(hiddenChatOccupants.map(row=>row.occupant.id));
        vm.journal=vm.journal.filter(event=>!hiddenIds.has(event.occupantId)&&!hiddenIds.has(event.agentId)&&!sourceUnverifiableEvents.has(event.id));
        vm.conversationIds=(vm.conversationIds||[]).filter(id=>!hiddenIds.has(id)&&!hiddenSessionKeys.has(id));
        vm.conversationCount=vm.conversationIds.length;
        vm.conversationLabel={key:'office.mobile.conversations',params:{n:vm.conversationCount}};
        for(const kpi of vm.kpis||[]) {
          if(canonicalOfficeSessions&&visibleOfficeSessions&&kpi.id==='tokens'&&Number.isFinite(kpi.value))kpi.value=visibleOfficeSessions.reduce((sum,session)=>sum+(session.usage?.total||0),0);
          else if(kpi.id==='tokens'&&Number.isFinite(kpi.value))kpi.value=Math.max(0,kpi.value-hiddenChatOccupants.reduce((sum,row)=>sum+(row.session?.usage?.total||0),0));
          if(canonicalOfficeSessions&&visibleOfficeSessions&&kpi.id==='runs'&&Number.isFinite(kpi.value))kpi.value=visibleOfficeSessions.filter(session=>executionState(session.run).status==='running').length;
          else if(kpi.id==='runs'&&Number.isFinite(kpi.value))kpi.value=Math.max(0,kpi.value-hiddenChatOccupants.filter(row=>row.session?.run?.status==='running').length);
          if(kpi.id==='subagents')kpi.value=vm.occupants.filter(row=>row.role==='subagent').length;
        }
        delete vm.occupantOverflowCount;
        const physicalFloors=Array.isArray(vm.rosterFloors)?vm.rosterFloors:[];
        Object.assign(vm,require('../api/v2/vm/office-roster').projectOfficeRoster(vm));
        const projectedFloors=new Map(vm.rosterFloors.map(floor=>[floor.id,floor]));
        vm.rosterFloors=physicalFloors.map(physical=>{
          const visible=projectedFloors.get(physical.id);
          if(visible){projectedFloors.delete(physical.id);return {...physical,...visible,layout:physical.layout,capacity:physical.capacity};}
          return {...physical,occupantIds:[],mobileLabelIds:[],items:[],count:0,activeCount:0,idleCount:0,
            countLabel:{key:'office.floor.count',params:{n:0}},statusLabel:{key:'office.floor.status',params:{active:0,idle:0}}};
        });
        vm.rosterFloors.push(...projectedFloors.values());
        const visibleIds=new Set(vm.occupants.map(row=>row.id));
        vm.unseatedTeams=(Array.isArray(vm.unseatedTeams)?vm.unseatedTeams:[]).flatMap(team=>{
          if(!visibleIds.has(team.parentId))return [];
          const root=vm.occupants.find(row=>row.id===team.parentId);
          const count=vm.occupants.filter(row=>row.parentId===team.parentId&&row.teamId===root?.teamId&&!row.stationUid).length;
          return count?[{...team,count}]:[];
        });
        if(vm.visitIntent) {
          if(!visibleIds.has(vm.visitIntent.hostId))delete vm.visitIntent;
          else {
            vm.visitIntent.desk=(vm.visitIntent.desk||[]).filter(id=>visibleIds.has(id));
            vm.visitIntent.meeting=(vm.visitIntent.meeting||[]).filter(id=>visibleIds.has(id));
            vm.visitIntent.visitors=(vm.visitIntent.visitors||[]).filter(row=>visibleIds.has(row.id));
            if(!visibleIds.has(vm.visitIntent.speaker))vm.visitIntent.speaker=null;
          }
        }
        const active=vm.kpis?.find(row=>row.id==='active');
        if(active) {
          const unknown=vm.occupants.some(row=>row.state==='unknown');
          active.value=unknown?null:vm.occupants.filter(row=>!['unknown','idle','offline'].includes(row.state)).length;
          active.sub=unknown?{key:'kpi.stateUnknown'}:active.value===0?{key:'kpi.idle',params:{agent:''}}:{key:'kpi.onStage',params:{n:vm.occupants.filter(row=>!['unknown','idle','offline'].includes(row.state)).length}};
        }
      }
      if(!logs) {
        vm.occupants=vm.occupants.filter(o=>SUMMARY_ROLES.has(o.role));
        for(const o of vm.occupants){
          o.communication=null;
          o.screenIntent=require('../engine/office/communication').projectScreenIntent(o);
          o.sessionKey=null;o.tokens=null;o.lastSeenAt=null;o.execution={status:'unknown',evidence:{level:'unknown',observedAt:null,expiresAt:null}};
          delete o.exchanges;delete o.visitPhase;delete o.visitOnStage;delete o.visitStateLabel;
        }
        vm.journal=[];
        // The cached OfficeVM is built from the full population. Rebuild every
        // count/tree derived from session rows only after the caller's rows have
        // been removed; even an exact overflow count reveals hidden activity.
        delete vm.occupantOverflowCount;
        vm.conversationIds=[];
        vm.conversationCount=0;
        vm.conversationLabel={key:'office.mobile.conversations',params:{n:0}};
        const physicalFloors=Array.isArray(vm.rosterFloors)?vm.rosterFloors:[];
        Object.assign(vm,require('../api/v2/vm/office-roster').projectOfficeRoster(vm));
        // Rebuild visible membership/counts, but retain the physical registry that
        // the scene needs to render even a floor with no visible occupants.
        const projectedFloors=new Map(vm.rosterFloors.map(floor=>[floor.id,floor]));
        vm.rosterFloors=physicalFloors.map(physical=>{
          const visible=projectedFloors.get(physical.id);
          if(visible){projectedFloors.delete(physical.id);return {...physical,...visible,layout:physical.layout,capacity:physical.capacity};}
          return {...physical,occupantIds:[],mobileLabelIds:[],items:[],count:0,activeCount:0,idleCount:0,
            countLabel:{key:'office.floor.count',params:{n:0}},
            statusLabel:{key:'office.floor.status',params:{active:0,idle:0}}};
        });
        vm.rosterFloors.push(...projectedFloors.values());
        const visibleIds=new Set(vm.occupants.map(o=>o.id));
        vm.unseatedTeams=(Array.isArray(vm.unseatedTeams)?vm.unseatedTeams:[]).flatMap(team=>{
          if(!visibleIds.has(team.parentId))return [];
          const root=vm.occupants.find(o=>o.id===team.parentId);
          const count=vm.occupants.filter(o=>o.parentId===team.parentId&&o.teamId===root?.teamId&&!o.stationUid).length;
          return count?[{...team,count}]:[];
        });
        delete vm.visitIntent;
      } else {
        vm.journal=vm.journal.filter(e=>!e.kind.startsWith('project.')||can(user,'projects'));
        if(!can(user,'flows'))vm.journal=vm.journal.filter(e=>!['cron.fired','run.started','run.succeeded','run.failed'].includes(e.kind));
      }
      vm.kpis=vm.kpis.filter(k=>k.id==='active'||['runs','subagents','tokens'].includes(k.id)&&logs||k.id==='flows'&&can(user,'flows')||k.id==='cpu'&&can(user,'health'));
      if(!logs)for(const k of vm.kpis)if(k.id==='active'){
        const unknown=vm.occupants.some(o=>o.state==='unknown');
        k.value=unknown?null:vm.occupants.filter(o=>!['unknown','idle','offline'].includes(o.state)).length;
        k.sub=unknown?{key:'kpi.stateUnknown'}:null;
      }
      if(!can(user,'flows'))vm.queue=[];
    }
    if(name==='officeCharacters') {
      if(!logs) {
        vm.groups=vm.groups.map(group=>{
          const rows=group.rows.filter(row=>SUMMARY_ROLES.has(row.role));
          return {...group,rows,count:rows.length,countLabel:countLabel(rows.length)};
        }).filter(group=>group.rows.length);
        vm.count=vm.groups.reduce((total,group)=>total+group.count,0);
        vm.countLabel=countLabel(vm.count);
      }
      for(const group of vm.groups)for(const row of group.rows) {
        row.name=redactChatIdentity(row.name,{id:row.id,role:row.role,maxLength:120})||'Agent';
        if(!logs) {
          row.lastSeenAt=null;
          if(row.inOffice&&row.role!=='primary'&&row.role!=='main') {
            row.state='unknown';row.stateLabel={key:'agentState.unknown'};
          }
        }
      }
    }
    if(name==='flow') {
      vm.editable=vm.editable&&can(user,'flows.edit','write');
      if(!logs)vm.runs=[];
      if(!runtimes&&Object.hasOwn(vm.job,'ext'))vm.job.ext={};
    }
    if(name==='access') {
      if(!logs)vm.interlocutors=[];
      if(!runtimes)for(const agent of vm.agents)agent.runtime=null;
    }
    if(name==='interlocutor'&&!can(user,'access'))vm.access={policy:null,enabled:null,requireMention:null};
    if(name==='health') {
      vm.cards=vm.cards.filter(c=>c.id!=='cron'||can(user,'flows')).filter(c=>c.id!=='plugins'||can(user,'skills'));
      if(!can(user,'access'))vm.channels=[];
      if(!runtimes||!logs)vm.sources=[];
      if(!runtimes)for(const channel of vm.channels)channel.lastError=null;
      if(!logs||!runtimes)vm.dataQuality=null;
    }
    if(name==='layout'&&!logs) {
      vm.agentsSeen=vm.agentsSeen.filter(a=>SUMMARY_ROLES.has(a.role)).map(a=>({...a,lastSeenAt:null}));
      // Opaque custom matching rules may contain exact conversation/session identities.
      vm.layout.data.agents=[];vm.default.data.agents=[];
    }
    if(name==='layoutRevision'&&!logs)vm.data.agents=[];
    if(name==='projects') {
      // Workspace project names and runtime source IDs are derived from private
      // session/transcript data. Projects access alone must not reveal either.
      // Keep the gate aligned with the permissions that expose those inputs.
      const runtimeProjectsReadable=logs&&runtimes;
      const isRuntimeCard=c=>(c.sourceDescriptors||[]).some(source=>source.kind==='runtime');
      const cardReadable=c=>(c.origin!=='orchestrator-team'||can(user,'teams'))&&(!isRuntimeCard(c)||runtimeProjectsReadable);
      const selectedFilter=vm.sourceFilters.find(source=>source.id===vm.sourceFilterId);
      const selectedFilterHidden=selectedFilter?!sourceReadable(user,selectedFilter.source?.kind):false;
      const hiddenSourceCounts=new Map();
      const hiddenSourceRows=Array.isArray(boardAccess?.sourceRows)?boardAccess.sourceRows.filter(row=>row.runtime&&!runtimeProjectsReadable||row.team&&!can(user,'teams')):null;
      const hiddenBoardRows=Array.isArray(boardAccess?.stageRows)?boardAccess.stageRows.filter(row=>row.runtime&&!runtimeProjectsReadable||row.team&&!can(user,'teams')):null;
      if(hiddenSourceRows)for(const row of hiddenSourceRows)for(const sourceId of row.sourceIds||[])
        hiddenSourceCounts.set(sourceId,(hiddenSourceCounts.get(sourceId)||0)+1);
      for(const column of vm.columns){
        if(!hiddenSourceRows)for(const hidden of column.cards.filter(c=>!cardReadable(c)))for(const source of hidden.sourceDescriptors||[])
          hiddenSourceCounts.set(source.id,(hiddenSourceCounts.get(source.id)||0)+1);
        column.cards=column.cards.filter(cardReadable).map(c=>card(user,c));
        column.count=column.cards.length;
        if(Number.isSafeInteger(column.taskCount)) column.taskCount=column.cards.length;
        if(column.summaryLabel) column.summaryLabel={key:'project.board.column.summary',params:{n:column.cards.length}};
      }
      vm.sourceFilters=vm.sourceFilters.filter(source=>sourceReadable(user,source.source?.kind))
        .map(source=>({...source,count:Math.max(0,source.count-(hiddenSourceCounts.get(source.id)||0))}))
        .filter(source=>source.count>0);
      // A caller may submit a previously visible restricted filter after grants
      // change. It is an unfiltered read; no selected ID/count/empty hint tells
      // whether the private source exists.
      const unresolvedFilter=selectedFilterHidden||!!(vm.sourceFilterId&&!vm.sourceFilters.some(source=>source.id===vm.sourceFilterId));
      if(unresolvedFilter) {
        vm.sourceFilterId=null;
        vm.sourceFilters=[];
        for(const column of vm.columns){
          column.cards=[];column.count=0;
          if(Number.isSafeInteger(column.taskCount)) column.taskCount=0;
          if(column.summaryLabel) column.summaryLabel={key:'project.board.column.summary',params:{n:0}};
        }
        if(vm.controls?.search&&vm.controls?.stage){
          vm.controls.search.counts=[{id:'matches',count:0}];
          vm.controls.stage.counts=[{id:'all',count:0},...vm.columns.map(column=>({id:column.id,count:0}))];
        }
      }
      const hasCards=vm.columns.some(column=>column.cards.length);
      vm.emptyStateLabel=hasCards?null:{key:vm.sourceFilterId?'project.empty.source':'project.empty.board'};
      if(vm.controls?.search&&vm.controls?.stage){
        const visibleCount=vm.columns.reduce((total,column)=>total+column.cards.length,0);
        // Search counts describe the search/source-filter population before
        // the selected stage is applied. stageRows is captured at that exact
        // boundary, so subtract restricted rows there instead of recounting
        // the already stage-filtered columns.
        const searchCount=Array.isArray(boardAccess?.stageRows)
          ? Math.max(0,(vm.controls.search.counts?.find(row=>row.id==='matches')?.count||0)
            -(hiddenBoardRows || []).length)
          : visibleCount;
        vm.controls.search.counts=[{id:'matches',count:searchCount}];
        if(Array.isArray(boardAccess?.stageRows)) {
          const stageCounts=new Map(vm.controls.stage.counts.map(row=>[row.id,row.count]));
          let hiddenTotal=0;
          for(const row of hiddenBoardRows||[]) {
            hiddenTotal++;
            stageCounts.set(row.status,Math.max(0,(stageCounts.get(row.status)||0)-1));
          }
          stageCounts.set('all',Math.max(0,(stageCounts.get('all')||0)-hiddenTotal));
          vm.controls.stage.counts=[{id:'all',count:stageCounts.get('all')||0},...vm.controls.stage.options.filter(row=>row.id!=='all').map(row=>({id:row.id,count:stageCounts.get(row.id)||0}))];
        } else {
          vm.controls.stage.counts=[{id:'all',count:visibleCount},...vm.columns.map(column=>({id:column.id,count:column.cards.length}))];
        }
      }
    }
    if(name==='project') {
      if(vm.capabilities) {
        const source=vm.capabilities;
        const write=source.write&&can(user,'projects','write')&&!cfg.readonlyStore;
        const readOnly=value=>value==='read-write'&&!write?'read-only':value;
        vm.capabilities={...source,write,
          comments:!can(user,'projects.comment')?'unsupported':source.comments==='read-write'&&(!can(user,'projects.comment','write')||cfg.readonlyStore)?'read-only':source.comments,
          history:readOnly(source.history),repository:readOnly(source.repository)};
        vm.capabilityRows=projectCapabilityRows(vm.capabilities);
      }
      if(!can(user,'projects','write')||cfg.readonlyStore||vm.capabilities?.write===false)vm.statusTransitions=[];
      const inaccessibleRuntime=(vm.sourceDescriptors||[]).some(source=>source.kind==='runtime'&&!sourceReadable(user,source.kind));
      if(inaccessibleRuntime)throw new ApiError('not_found');
      if(vm.teamProject&&!can(user,'teams'))throw new ApiError('not_found');
      // Team projects require teams.read, but canonical Office appearances are
      // separately protected by office.read. Cached project topics can contain
      // a portrait joined from Office, so remove both image forms at the
      // principal projection boundary (HTTP and SSE).
      if(vm.teamProject&&!can(user,'office')) {
        const roster=vm.teamProject.roster;
        if(roster)vm.teamProject.roster={...roster,members:roster.members.map(member=>({...member,portrait:{look:null,avatarUrl:null}}))};
      }
      cover(user,vm);
      const withheldSourceData=[...(vm.sourceDescriptors||[]),...(vm.sources||[])].some(source=>!sourceReadable(user,source.kind));
      vm.sources=vm.sources.filter(s=>sourceReadable(user,s.kind));
      vm.sourceDescriptors=(vm.sourceDescriptors||[]).filter(source=>sourceReadable(user,source.kind));
      if(!logs){for(const s of vm.sources)s.sessionCount=null;vm.lastActivityAt=null;vm.flags=vm.flags.filter(f=>f.kind!=='risk');
      }
      if(withheldSourceData||!logs){
        for(const s of vm.sources)s.sessionCount=null;
        vm.people=vm.people.filter(person=>person.origin==='manual'||person.kind==='git');
        vm.lastActivityAt=null;
        vm.flags=vm.flags.filter(flag=>flag.kind!=='risk');
        if(vm.counts)vm.counts={...vm.counts,sessions:null,agents:null,activity:null};
      }
      if(!logs||!can(user,'flows')||!runtimes){vm.summary=null;vm.summaryMeta=null;}
      vm.people=vm.people.filter(p=>logs||p.origin==='manual'||p.kind==='git');
      vm.recentHistory=history(user,vm.recentHistory);
      if(!logs||!can(user,'flows')||!runtimes)vm.historyNextCursor=null;
    }
    if(name==='history'){vm.items=history(user,vm.items);if(!logs||!can(user,'flows')||!runtimes)vm.nextCursor=null;}
    if(name==='candidates') {
      if(!can(user,'projects','write')||cfg.readonlyStore)vm.statusOptions=[];
      // Discovery combines transcript hints and local roots without per-field provenance.
      if(!logs||!runtimes||!can(user,'flows'))vm.candidates=[];
    }
    if(name==='comments') {
      if(isTeamProject(vm.projectId)&&!can(user,'teams'))throw denied();
      const write=can(user,'projects.comment','write')&&!cfg.readonlyStore;
      const related=PROJECT_CONTEXT_READS.every(r=>can(user,r.resource,r.level));
      vm.canComment=vm.canComment&&write;vm.canMention=vm.canMention&&write&&!cfg.readonly&&related;
      vm.items=vm.items.filter(item=>item.id.startsWith('hist:')?related:mayReadComment(store,user,item.id));
      if(!related)vm.nextCursor=null;
      if(!logs)vm.session=null;
      for(const item of vm.items) {
        if(item.replyTo&&!mayReadComment(store,user,item.replyTo))item.replyTo=null;
        const own=item.author.kind==='human'&&item.author.id===user.person_id;
        item.editable=write&&own&&item.kind==='comment'&&!item.deleted;
        item.deletable=write&&own&&item.kind==='comment'&&!item.deleted;
      }
    }
    if(name==='meta') {
      vm.capabilities=capabilities(user,vm.capabilities);vm.readonly=!vm.capabilities.openclawWrites;
      if(!runtimes){vm.runtime=null;if(vm.runtimes)vm.runtimes=[];}
      if(!['office','chat','access','logs'].some(r=>can(user,r)))vm.primaryAgent=null;
      if(!can(user,'settings.instance')&&Object.hasOwn(vm.instance,'name'))vm.instance.name=null;
      const base=labelsFor(vm.locale,version),allowed=key=>key.startsWith('agent.')&&['office','chat','access','logs'].some(r=>can(user,r))||key.startsWith('channel.')&&(logs||can(user,'access'))||/^(model|provider)\./.test(key)&&(logs||can(user,'access'));
      vm.labels={...base,...Object.fromEntries(Object.entries(vm.labels).filter(([key])=>!Object.hasOwn(base,key)&&allowed(key)))};
    }
    if(name==='me') {
      vm.email=user.email;vm.displayName=store.persons.list().find(p=>p.id===user.person_id)?.name||user.email.split('@')[0];
      vm.capabilities=capabilities(user,vm.capabilities);
      const snapshot=store.rbac.snapshot(user.id);
      vm.roleName=snapshot.role.name;
      vm.user={id:user.id,personId:user.person_id,roleId:user.role_id};vm.permissions=store.policy.permissions(user);
      vm.permissionRevision={user:user.permission_revision,role:snapshot.role.revision,registry:snapshot.registryRevision};
      vm.resourceStatus=Object.fromEntries(store.db.prepare('SELECT key,active FROM permission_resources').all().map(r=>[r.key,r.active&&store.registry.has(r.key)?'available':'unavailable']));
      for(const key of Object.keys(vm.resourceStatus))if(!Object.hasOwn(vm.permissions,key))vm.permissions[key]='none';
    }
    if(name==='settings') {
      for(const [group,key] of [['instance','settings.instance'],['office','settings.instance'],['network','settings.network'],['restart','settings.restart']])if(!can(user,key))vm[group]=null;
      if(!runtimes){vm.runtimes=[];vm.agents=[];} else {
        for(const runtime of vm.runtimes)for(const value of Object.values(runtime.values))value.editable=value.editable&&can(user,'settings.runtimes','write');
        for(const agent of vm.agents){if(!can(user,'settings.integrations'))agent.integrations=[];if(!can(user,'store'))agent.lookRoute=null;}
      }
      for(const [group,key] of [['instance','settings.instance'],['network','settings.network']])if(vm[group])for(const value of Object.values(vm[group]))if(value&&Object.hasOwn(value,'editable'))value.editable=value.editable&&can(user,key,'write');
      if(vm.office)for(const value of Object.values(vm.office))if(value&&Object.hasOwn(value,'editable'))value.editable=value.editable&&can(user,'settings.instance','write');
      if(vm.restart)vm.restart.supported=vm.restart.supported&&can(user,'settings.restart','write');
      const sectionResource={diagnostic:'health',runtimes:'settings.runtimes',connection:'settings.runtimes',integrations:'settings.integrations',instance:'settings.instance'};
      vm.diagnostics=vm.diagnostics.filter(d=>d.section==='account'||sectionResource[d.section]&&can(user,sectionResource[d.section]));
      const local=user.credential_source==='database'&&!cfg.readonlyStore,source=user.credential_source==='env'?'env':'file';
      vm.owner={revision:user.permission_revision,displayName:field(store.persons.list().find(p=>p.id===user.person_id)?.name||user.email,source,local),email:field(user.email,source,local),passwordChangeEnabled:local,reason:local?null:{key:'settings.externalAccount'}};
    }
    if(!validate(schema,vm).ok)throw new Error('invalid projected view '+name);
    if(name==='projects'&&privateBoardAccess)boardAccessMetadata.attach(vm,privateBoardAccess);
    projectedVmMetadata.set(vm,{userId:user.id,permissions,content:createHash('sha256').update(JSON.stringify(vm)).digest('hex')});
    return vm;
  }
  function frame(user,type,raw,options) {
    user=identity(user);
    if(type==='snapshot')return {...raw,data:project(user,raw.topic,raw.data,options)};
    if(type==='delta')throw new Error('raw deltas cannot be projected');
    if(type==='hello'||type==='heartbeat')return structuredClone(raw);
    if(type==='system')return {type:'system',gateway:raw.gateway,capabilities:capabilities(user,raw.capabilities),...(raw.closing?{closing:raw.closing}:{})};
    if(type==='cue')return can(user,'office')&&can(user,'logs')&&can(user,'flows')&&can(user,'projects')?structuredClone(raw):null;
    if(type==='settings') {
      const groups={instance:'settings.instance',office:'settings.instance',network:'settings.network',runtime:'settings.runtimes',runtimes:'settings.runtimes',agents:'settings.runtimes',detected:'settings.runtimes',integrations:'settings.integrations'};
      const changed=(raw.changed||[]).filter(group=>groups[group]&&can(user,groups[group]));
      return changed.length?{type:'settings',revision:raw.revision,changed,...(can(user,'settings.network')?{restartRequired:!!raw.restartRequired}:{})}:null;
    }
    // Toast messages have no declared resource/provenance. Do not forward global private parameters.
    return null;
  }
  return {authorize,project,frame,revision,fingerprint,capabilities,
    mayExposeSources:user=>can(identity(user),'health')&&can(user,'settings.runtimes')&&can(user,'logs'),
    build:(user,name,builder,options)=>{user=authorize(user,name);const before=store.rbac.fingerprint(user.id),raw=builder();if(before!==store.rbac.fingerprint(user.id))throw denied();return project(user,name,raw,options);},
  };
}
module.exports={createViewProjection,REQUIREMENTS};
