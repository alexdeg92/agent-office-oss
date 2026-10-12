// Invented state seeded from backend-codex's SettingsVM examples. No host probes, storage or real credentials.
const clone=x => structuredClone(x);
const ok=data => ({status:200,body:{data,meta:{modelVersion:1,generatedAt:Date.now(),stale:[]}}});
const fail=(status,code,issue,field='settings') => ({status,body:{error:{code,message:null,details:[{field,issue}],requestId:'mock-settings'}}});
export function createSettingsMock({vm, examples, now=Date.now, onChange=() => {}}) {
  let state=clone(vm), expiresAt=null, plans=new Map();
  function snapshot() { return {...clone(state),reauth:{...state.reauth,expiresAt}}; }
  const result=(value,includeVm=false) => ok({ok:true,result:value,revision:includeVm ? state.revision : null,vm:includeVm ? snapshot() : null});
  const recent=() => expiresAt != null && expiresAt > now();
  const rowOf=runtime => state.runtimes.find(r => r.id === (runtime?.id || runtime?.adapter));
  function saved(changed) {
    state.revision++;
    onChange({revision:state.revision,changed,restartRequired:state.network.restartRequired});
    return result({changed,restartRequired:state.network.restartRequired},true);
  }
  function setField(fields,id,value) {
    if (fields[id]?.editable) fields[id]={...fields[id],value,source:'file'};
  }
  function checkCandidate(runtime) {
    const row=rowOf(runtime) || state.runtimes.find(r => r.adapter === runtime?.adapter && r.supported);
    if (!row?.supported) return {ok:false,status:'unsupported',protocol:null,latencyMs:null};
    const address=row.fields.find(f => f.type === 'url');
    const secret=row.fields.find(f => f.writeOnly);
    const changedUrl=address && runtime[address.id] !== row.values[address.id]?.value;
    if (secret && (runtime[secret.id] === 'fixture rejected token' || secret.required && !runtime[secret.id] && (!row.values[secret.id]?.tokenSet || changedUrl || !row.selected))) return {ok:false,status:'unauthorized',protocol:null,latencyMs:null};
    if (address) {
      try { if (!['ws:','wss:','http:','https:'].includes(new URL(runtime[address.id]).protocol)) throw Error(); }
      catch { return {ok:false,status:'unreachable',protocol:null,latencyMs:null}; }
    }
    return clone(examples['check-result']?.data.result || {ok:true,status:'connected',protocol:null,latencyMs:null});
  }
  function changedRuntime(runtime) {
    const row=rowOf(runtime);
    return !row?.selected || row.fields.some(f => f.writeOnly ? !!runtime[f.id] : runtime[f.id] !== row.values[f.id]?.value);
  }
  function forbiddenFields(fields,body) {
    return Object.entries(body).find(([id,value]) => fields[id] && !fields[id].editable && fields[id].value !== value)?.[0];
  }
  function updateDiagnostics() {
    const fix=(kind,target,label,automatic=false,requiresInput=false,requiresConsent=false) => state.readonly ? null : ({id:kind+':'+[target.runtime,target.agentId,target.integration].filter(Boolean).join(':'),kind,target,label,detail:null,automatic,requiresInput,requiresConsent,requiresReauth:!kind.startsWith('agent.'),requiresRestart:false});
    state.diagnostics=state.diagnostics.filter(d => !d.id.startsWith('agent:') && d.id !== 'restart').map(d => {
      const row=state.runtimes.find(r => d.id === 'runtime:'+r.id);
      if (!row) return d;
      if (!row.supported) return {...d,level:'info',fix:null};
      if (row.enabled && row.connection.status === 'connected') return {...d,level:'ok',fix:null,label:{key:'settings.diagnostic.connected',params:{runtime:row.name}}};
      return d;
    });
    for (const a of state.agents) {
      const issue=a.configured && a.integrations.find(i=>i.status!=='installed');
      const params={agent:a.name || a.agentId,...(issue ? {integration:issue.id} : {})};
      const kind=!a.configured ? 'agent.configure' : issue?.status === 'missing' ? 'integration.install' : issue?.status === 'outdated' ? 'integration.update' : 'integration.review';
      state.diagnostics.push({id:'agent:' + a.id,level:issue?.status === 'unsupported' ? 'info' : !a.configured || issue ? 'warning' : 'ok',
        label:{key:issue ? 'settings.diagnostic.integration.'+issue.status : a.configured ? 'settings.diagnostic.agentConfigured' : 'settings.diagnostic.agentFound',params},
        detail:issue ? {key:'settings.diagnostic.integrationDetail.'+issue.status,params} : null,section:a.configured ? 'integrations' : 'runtimes',
        fix:(!a.configured || issue && issue.status !== 'unsupported') ? fix(kind,{runtime:a.runtime,agentId:a.agentId,integration:issue?.id || null},{key:'settings.fix.'+kind,params:{agentName:a.name || a.agentId,...(issue && {integration:issue.id})}},['integration.install','integration.update'].includes(kind),['agent.configure','integration.review'].includes(kind)) : null});
    }
    if (state.network.restartRequired) state.diagnostics.push({id:'restart',level:'warning',label:{key:'settings.restart'},detail:null,section:'instance',fix:fix('instance.restart',{runtime:null,agentId:null,integration:null},{key:'settings.fix.instance.restart'})});
  }
  return {
    vm:snapshot,
    async handle(method,path,body={}) {
      const command=path.replace(/^\/api\/v3\/settings\/?/,'');
      if (method === 'GET' && !command) return ok(snapshot());
      if (state.readonly) return fail(403,'readonly','readonly');
      if (command === 'reauth' && method === 'POST') {
        if (body.password !== examples['reauth-request'].password) return fail(401,'unauthorized','current-password','password');
        expiresAt=now()+300000; return result({expiresAt});
      }
      if ((method === 'PUT' || command === 'fix-all') && body.expectedRevision !== state.revision) return fail(409,'conflict','settings-revision');
      const needsAuth=['runtime','runtimes','network','password','integrations/apply','fix-all'].includes(command)
        || command === 'check' && changedRuntime(body.runtime)
        || command === 'owner' && body.email != null && body.email !== state.owner.email.value;
      if (needsAuth && !recent()) return fail(403,'forbidden','reauth-required');
      if (command === 'fix-all' && method === 'POST') {
        const fixes=state.diagnostics.flatMap(d => d.fix ? [d.fix] : []);
        if (!body.confirmed || !Array.isArray(body.items) || !body.items.length || body.items.length>100 || new Set(body.items.map(i=>i.id)).size!==body.items.length || body.items.some(i=>!fixes.some(f=>f.id===i.id))) return fail(400,'validation','invalid','items');
        if (body.items.some(i=>fixes.find(f=>f.id===i.id)?.requiresConsent && i.consent!==true)) return fail(400,'validation','consent-required','items');
        // Synthetic effects only. Production orchestration is covered by the backend's real commands.
        const items=body.items.map(item => {
          const f=fixes.find(f=>f.id===item.id), scripted=examples['fix-all-partial-result']?.data.result.items.find(i=>i.id===item.id);
          const status=f.requiresInput ? 'input-required' : scripted?.status === 'failed' ? 'failed' : 'applied';
          const changed=[];
          if (status==='applied' && f.kind.startsWith('integration.')) {
            const a=state.agents.find(a=>a.runtime===f.target.runtime && a.agentId===f.target.agentId);
            const integration=a?.integrations.find(i=>i.id===f.target.integration); if (integration) integration.status='installed'; changed.push('integrations');
          }
          if (status==='applied' && f.kind==='runtime.enable') {
            const r=state.runtimes.find(r=>r.id===f.target.runtime);r.enabled=true;r.selected=true;r.connection.status='connected';changed.push('runtimes');
          }
          if (status==='applied') state.revision++;
          return {id:item.id,status,changed,error:status==='failed' ? scripted.error : null,restartRequired:false};
        });
        updateDiagnostics();onChange({revision:state.revision,changed:items.flatMap(i=>i.changed),restartRequired:state.network.restartRequired});
        return result({items,restartRequired:state.network.restartRequired},true);
      }
      if (command === 'check' && method === 'POST') {
        const checked=checkCandidate(body.runtime);
        if (!changedRuntime(body.runtime)) {
          const r=rowOf(body.runtime);
          if (r) r.connection={status:checked.status,protocol:checked.protocol,latencyMs:checked.latencyMs,checkedAt:now()};
        }
        return result(checked);
      }
      if (command === 'herdr/check' && method === 'POST') {
        if(state.herdr){state.herdr.status=state.herdr.found?'available':'not-detected';state.herdr.checkedAt=now();}
        return result({ found: !!state.herdr?.found, status: state.herdr?.found ? 'available' : 'not-detected', agentCount: state.herdr?.found ? 3 : 0 });
      }
      if (command === 'detect' && method === 'POST') { updateDiagnostics(); return result({runtimes:clone(state.runtimes),agents:clone(state.agents)},true); }
      if (command === 'auto-add' && method === 'PUT') {
        const row=state.runtimes.find(r=>r.id===body.runtime && r.enabled);
        if (!row?.autoAdd || typeof body.enabled !== 'boolean') return fail(400,'validation','invalid','runtime');
        row.autoAdd={...row.autoAdd,enabled:body.enabled,managed:true};
        return saved(['runtimes.autoAdd']);
      }
      if (command === 'agents' && method === 'PUT') {
        if (!Array.isArray(body.agents) || new Set(body.agents.map(a => a.id)).size !== body.agents.length || body.agents.some(a => !a.id || a.name !== null && (typeof a.name !== 'string' || !a.name.trim() || a.name.trim().length > 80))) return fail(400,'validation','invalid','agents');
        if (body.agents.length && body.primary !== null && !body.agents.some(a => a.id === body.primary && !a.hidden)) return fail(400,'validation','invalid','primary');
        const found=state.agents.filter(a => a.runtime === body.runtime);
        state.agents=state.agents.filter(a => a.runtime !== body.runtime);
        for (const a of found) if (!body.agents.some(next => next.id === a.agentId)) state.agents.push({...a,configured:false,isPrimary:false});
        for (const a of body.agents) {
          const existing=found.find(x => x.agentId === a.id);
          state.agents.push({...existing,id:body.runtime + ':' + a.id,agentId:a.id,runtime:body.runtime,name:a.name,detectedName:existing?.detectedName || null,nameSource:existing?.nameSource || null,
            configured:true,hidden:!!a.hidden,isPrimary:a.id === body.primary,model:null,lookRoute:'/boutique?onglet=personnages&agent=' + encodeURIComponent(a.id === body.primary ? 'primary' : 'agent:' + a.id),integrations:existing?.integrations || []});
        }
        updateDiagnostics(); return saved(['agents']);
      }
      if (command === 'runtime' && method === 'PUT') {
        const row=rowOf(body.runtime);
        if (!row?.supported) return fail(400,'validation','unsupported','runtime');
        const blocked=forbiddenFields(row.values,body.runtime);
        if (blocked) return fail(403,'forbidden','env-override',blocked);
        const checked=checkCandidate(body.runtime);
        if (!checked.ok) return fail(502,'upstream_failed',checked.status,'runtime');
        const changed=[];
        for (const f of row.fields) if (Object.hasOwn(body.runtime,f.id)) {
          if (f.writeOnly) { row.values[f.id]={...row.values[f.id],value:null,tokenSet:!!body.runtime[f.id]}; changed.push('runtime.' + f.id); }
          else if (row.values[f.id]?.value !== body.runtime[f.id]) { setField(row.values,f.id,body.runtime[f.id]); changed.push('runtime.' + f.id); }
        }
        for (const r of state.runtimes) r.selected=r.id === row.id;
        row.connection={status:'connected',protocol:checked.protocol,latencyMs:checked.latencyMs,checkedAt:now()};
        return saved(changed.length ? changed : ['runtime.adapter']);
      }
      if (command === 'runtimes' && method === 'PUT') {
        if (body.herdrEnabled !== undefined && typeof body.herdrEnabled !== 'boolean') return fail(400,'validation','invalid','herdrEnabled');
        if (body.herdrEnabled && !state.herdr?.found) return fail(400,'validation','not-detected','herdrEnabled');
        if (!Array.isArray(body.runtimes) || body.runtimes.length>32 || new Set(body.runtimes.map(r=>r.id)).size!==body.runtimes.length) return fail(400,'validation','invalid','runtimes');
        const next=[];
        for (const r of body.runtimes) {
          const existing=rowOf(r), descriptor=existing || state.runtimes.find(x=>x.adapter===r.adapter && x.supported);
          if (!descriptor?.supported || existing && existing.adapter!==r.adapter || !/^[a-z][a-z0-9-]{0,31}$/.test(r.id) || typeof r.enabled!=='boolean') return fail(400,'validation','invalid','runtimes');
          if (forbiddenFields(descriptor.values,r)) return fail(403,'forbidden','env-override','runtimes');
          const checked=r.enabled ? checkCandidate(r) : null;
          if (checked && !checked.ok) return fail(502,'upstream_failed',checked.status,'runtimes');
          if(r.name!==undefined && (typeof r.name!=='string' || !r.name.trim() || r.name.length>80 || /[\x00-\x1f\x7f]/.test(r.name)))return fail(400,'validation','invalid','runtimes.name');
          const row={...clone(descriptor),id:r.id,name:r.name?.trim() || descriptor.name,candidate:false,enabled:r.enabled,selected:r.enabled};
          for (const f of row.fields) if (Object.hasOwn(r,f.id)) row.values[f.id]={...row.values[f.id],value:f.writeOnly?null:r[f.id],source:'file',...(f.writeOnly?{tokenSet:!!r[f.id]}:{})};
          row.connection={status:r.enabled?'connected':'not-configured',protocol:checked?.protocol??null,latencyMs:checked?.latencyMs??null,checkedAt:now()}; next.push(row);
        }
        state.runtimes=[...next,...state.runtimes.filter(r=>!next.some(n=>n.id===r.id)).map(r=>({...r,candidate:true,enabled:false,selected:false}))];
        if (body.herdrEnabled !== undefined) {
          state.herdr.enabled=body.herdrEnabled; state.herdr.active=body.herdrEnabled;
        }
        updateDiagnostics(); return saved(['runtimes', ...(body.herdrEnabled === undefined ? [] : ['sources.herdr'])]);
      }
      if (['instance','network','owner'].includes(command) && method === 'PUT') {
        const fields=state[command], blocked=forbiddenFields(fields,body);
        if (blocked) return fail(403,'forbidden','env-override',blocked);
        const changed=[];
        for (const [id,value] of Object.entries(body)) if (fields[id]?.editable && fields[id].value !== value) { setField(fields,id,value); changed.push(command + '.' + id); }
        if (command === 'network') state.network.restartRequired=['mode','port','publicUrl'].some(id => state.network[id].value !== state.network.active[id]);
        updateDiagnostics(); return saved(changed);
      }
      if (command === 'password' && method === 'POST') {
        if (!state.owner.passwordChangeEnabled || body.password?.length < 12) return fail(400,'validation','invalid','password');
        expiresAt=null; return saved(['owner.password']);
      }
      if (command === 'integrations/plan' && method === 'POST') {
        const plan=clone(examples['integration-plan-result'].data.result);
        plan.planId='fixture-plan-' + now(); plans.set(plan.planId,{plan,runtime:body.runtime,expires:now()+600000});
        return result(plan);
      }
      if (command === 'integrations/apply' && method === 'POST') {
        const stored=plans.get(body.planId);
        if (!stored || stored.expires <= now() || !body.confirmed || !Array.isArray(body.agentIds) || !body.agentIds.length || body.agentIds.some(id => !stored.plan.agents.some(a => a.id === id && !['conflict','unsupported'].includes(a.status)))) return fail(400,'validation','invalid','planId');
        plans.delete(body.planId);
        const status=body.action === 'uninstall' ? 'missing' : 'installed';
        for (const a of state.agents) if (a.runtime === stored.runtime && body.agentIds.includes(a.agentId)) for (const i of a.integrations) i.status=status;
        updateDiagnostics();
        state.revision++; onChange({revision:state.revision,changed:['integrations'],restartRequired:state.network.restartRequired});
        return result({agents:body.agentIds.map(id => ({id,status:body.action === 'uninstall' ? 'uninstalled' : 'installed',changed:['skill','block'],backup:stored.plan.backupDir + '/' + id + '-fixture',reason:null}))},true);
      }
      return fail(404,'not_found','unknown');
    },
  };
}
