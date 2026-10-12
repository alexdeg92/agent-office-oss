'use strict';
const {ApiError}=require('../api/v2/errors');
const {TOPICS,COMMANDS}=require('./route-declarations');
const {schemasFor}=require('../api/v2/vm/schemas');
const {validate}=require('../schema');
const {PROJECT_CONTEXT_READS,mayRead:mayReadComment}=require('./comment-provenance');
const {labelsFor}=require('../i18n');
const REQUIREMENTS=new Map([...TOPICS].map(([name,spec])=>[name,spec.resource]));
REQUIREMENTS.set('history','projects');REQUIREMENTS.set('candidates','projects');
REQUIREMENTS.set('layoutRevision','store');
REQUIREMENTS.set('orchestrators','orchestrators');REQUIREMENTS.set('teams','teams');
const SELF=new Set(['meta','me','settings']);
const SAFE_HISTORY=new Set(['project-created','renamed','status','priority','archived','restored','commit','agent-action']);
const SUMMARY_ROLES=new Set(['main','primary','agent']);
const denied=()=>new ApiError('forbidden',{details:[{issue:'permission-denied'}]});

// This module has no shared last-good cache. Both transports receive a fresh actor projection.
function createViewProjection({store,cfg={}}) {
  function identity(user) {
    const current=store.users.byId(typeof user==='string'?user:user?.id);
    if(current?.status!=='active')throw new ApiError('unauthorized');return current;
  }
  const can=(user,key,level='read')=>store.policy.can(user,key,level);
  function authorize(user,name) {
    const current=identity(user),resource=REQUIREMENTS.get(name);
    if(!resource&&!SELF.has(name))throw new Error('undeclared view projection '+name);
    if(resource&&!can(current,resource))throw denied();return current;
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
    if(!can(user,'logs')) {
      card.people.visible=[];card.people.hiddenCount=null;card.lastActivityAt=null;
      card.flags.visible=card.flags.visible.filter(f=>f.kind!=='risk');card.flags.hiddenCount=null;
    }
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
        for(const o of vm.occupants){o.sessionKey=null;o.tokens=null;o.lastSeenAt=null;o.execution={status:'unknown',evidence:{level:'unknown',observedAt:null,expiresAt:null}};delete o.exchanges;}
        vm.journal=[];
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
    if(name==='projects')for(const column of vm.columns)column.cards=column.cards.map(c=>card(user,c));
    if(name==='project') {
      cover(user,vm);
      vm.sources=vm.sources.filter(s=>s.kind!=='sessionGroup'||logs).filter(s=>s.kind!=='workspace'||runtimes);
      if(!logs){for(const s of vm.sources)s.sessionCount=null;vm.lastActivityAt=null;vm.flags=vm.flags.filter(f=>f.kind!=='risk');}
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
      for(const [group,key] of [['instance','settings.instance'],['network','settings.network'],['restart','settings.restart']])if(!can(user,key))vm[group]=null;
      if(!runtimes){vm.runtimes=[];vm.agents=[];} else {
        for(const runtime of vm.runtimes)for(const value of Object.values(runtime.values))value.editable=value.editable&&can(user,'settings.runtimes','write');
        for(const agent of vm.agents){if(!can(user,'settings.integrations'))agent.integrations=[];if(!can(user,'store'))agent.lookRoute=null;}
      }
      for(const [group,key] of [['instance','settings.instance'],['network','settings.network']])if(vm[group])for(const value of Object.values(vm[group]))if(value&&Object.hasOwn(value,'editable'))value.editable=value.editable&&can(user,key,'write');
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
      const groups={instance:'settings.instance',network:'settings.network',runtime:'settings.runtimes',runtimes:'settings.runtimes',agents:'settings.runtimes',detected:'settings.runtimes',integrations:'settings.integrations'};
      const changed=(raw.changed||[]).filter(group=>groups[group]&&can(user,groups[group]));
      return changed.length?{type:'settings',revision:raw.revision,changed,...(can(user,'settings.network')?{restartRequired:!!raw.restartRequired}:{})}:null;
    }
    // Toast messages have no declared resource/provenance. Do not forward global private parameters.
    return null;
  }
  return {authorize,project,frame,capabilities,
    mayExposeSources:user=>can(identity(user),'health')&&can(user,'settings.runtimes')&&can(user,'logs'),
    build:(user,name,builder,options)=>{user=authorize(user,name);const before=store.rbac.fingerprint(user.id),raw=builder();if(before!==store.rbac.fingerprint(user.id))throw denied();return project(user,name,raw,options);},
  };
}
module.exports={createViewProjection,REQUIREMENTS};
