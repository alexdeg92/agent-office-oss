'use strict';
const {ApiError}=require('../api/v2/errors');
const {createHash}=require('node:crypto');
const {TOPICS,COMMANDS}=require('./route-declarations');
const {schemasFor}=require('../api/v2/vm/schemas');
const {validate}=require('../schema');
const {PROJECT_CONTEXT_READS,mayRead:mayReadComment}=require('./comment-provenance');
const {labelsFor}=require('../i18n');
const {redactChatIdentity}=require('./redact-text');
const REQUIREMENTS=new Map([...TOPICS].map(([name,spec])=>[name,spec.resource]));
REQUIREMENTS.set('history','projects');REQUIREMENTS.set('candidates','projects');
REQUIREMENTS.set('layoutRevision','store');
REQUIREMENTS.set('orchestrators','orchestrators');REQUIREMENTS.set('teams','teams');
REQUIREMENTS.set('officeCharacters','office');
REQUIREMENTS.set('officePalette','office');
REQUIREMENTS.set('officeStore','store');
const SELF=new Set(['meta','me','settings']);
const SAFE_HISTORY=new Set(['project-created','renamed','status','priority','archived','restored','commit','agent-action']);
const SUMMARY_ROLES=new Set(['main','primary','agent']);
const countLabel=n=>({key:n===1?'office.characters.count.one':'office.characters.count.other',params:{n}});
const denied=()=>new ApiError('forbidden',{details:[{issue:'permission-denied'}]});

// This module has no shared last-good cache. Both transports receive a fresh actor projection.
function createViewProjection({store,cfg={},isTeamProject=()=>false}) {
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
    const schema=schemasFor(version)[name];
    if(!schema||!validate(schema,raw).ok)throw new Error('invalid raw view projection '+name);
    const vm=structuredClone(raw),logs=can(user,'logs'),runtimes=can(user,'settings.runtimes');
    if(name==='office') {
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
      for(const column of vm.columns){
        for(const hidden of column.cards.filter(c=>!cardReadable(c)))for(const source of hidden.sourceDescriptors||[])
          hiddenSourceCounts.set(source.id,(hiddenSourceCounts.get(source.id)||0)+1);
        column.cards=column.cards.filter(cardReadable).map(c=>card(user,c));
        column.count=column.cards.length;
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
        for(const column of vm.columns){column.cards=[];column.count=0;}
      }
      const hasCards=vm.columns.some(column=>column.cards.length);
      vm.emptyStateLabel=hasCards?null:{key:vm.sourceFilterId?'project.empty.source':'project.empty.board'};
    }
    if(name==='project') {
      const inaccessibleRuntime=(vm.sourceDescriptors||[]).some(source=>source.kind==='runtime'&&!sourceReadable(user,source.kind));
      if(inaccessibleRuntime)throw new ApiError('not_found');
      if(vm.teamProject&&!can(user,'teams'))throw new ApiError('not_found');
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
