// SettingsVM is runtime-agnostic. Secrets live only in the current in-memory draft.
export const SETTINGS_TABS = ['diagnostic', 'agents', 'connexion', 'access', 'instance', 'apparence', 'compte', 'users', 'roles'];
export const settingsTab = value => value==='integrations' ? 'connexion' : SETTINGS_TABS.includes(value) ? value : 'diagnostic';
export const diagnosticTab = section => ({runtimes: 'agents', connection: 'connexion', account: 'compte', office: 'instance'})[section] || settingsTab(section);
export const valuesOf = fields => Object.fromEntries(Object.entries(fields || {}).filter(([,f]) => f && typeof f === 'object' && 'value' in f).map(([k,f]) => [k, f.value]));
export const activeRuntime = vm => vm.runtimes.find(r => r.selected)?.id || vm.runtimes.find(r => r.supported)?.id || '';
export const agentRuntimeSelection = (vm, value) => value === 'all' ? 'all'
  : vm.runtimes.find(r => r.id === value)?.id || vm.runtimes.find(r => r.adapter === value && r.selected)?.id || vm.runtimes.find(r => r.adapter === value)?.id || activeRuntime(vm);
export const diagnosticFixes = vm => vm.diagnostics.filter(d => ['error','warning'].includes(d.level) && d.fix).map(d => d.fix);
export const automaticFix = fix => fix.automatic && !fix.requiresInput && !fix.requiresConsent && fix.kind !== 'runtime.enable';
export const selectableFix = fix => !fix.requiresInput && (automaticFix(fix) || fix.requiresConsent || fix.kind === 'runtime.enable');
export const fixAllItems = (fixes, selected) => fixes.filter(f => selectableFix(f) && selected.includes(f.id)).map(f => ({id:f.id,
  ...((f.requiresConsent || f.kind === 'runtime.enable') && {consent:true})}));
export const fixTab = fix => fix.kind.startsWith('runtime.') || fix.kind.startsWith('integration.') ? 'connexion' : fix.kind.startsWith('agent.') ? 'agents' : 'instance';
/** Provider and instance come from declared rows, never an opaque diagnostic ID. */
export function integrationRoute(vm,value=activeRuntime(vm)) {
  const runtime=vm.runtimes.find(r=>r.id===value) || vm.runtimes.find(r=>r.adapter===value&&r.supported) || vm.runtimes.find(r=>r.id===activeRuntime(vm));
  return {onglet:'connexion',connecteur:runtime?.adapter||runtime?.id||null,runtime:runtime?.id||null,section:'integrations'};
}

export function agentDraft(vm, runtime = activeRuntime(vm)) {
  const rows = vm.agents.filter(a => a.runtime === runtime && a.configured);
  return {runtime, primary: rows.find(a => a.isPrimary)?.agentId || null, otherPrimary: vm.agents.some(a => a.isPrimary && a.runtime !== runtime),
    agents: rows.map(a => ({id: a.agentId, name: a.name || '', hidden: a.hidden}))};
}
export function initialDrafts(vm) {
  const owner=vm.owner || {};
  return {
    agents: agentDraft(vm),
    connexion: {adapter: activeRuntime(vm), names:Object.fromEntries(vm.runtimes.map(r=>[r.id,r.name])), values: Object.fromEntries(vm.runtimes.map(r => [r.id, Object.fromEntries(r.fields.filter(f => !f.writeOnly).map(f => [f.id, r.values[f.id]?.value ?? '']))])), secrets: {}, enabled: Object.fromEntries(vm.runtimes.map(r => [r.id, r.enabled ?? r.selected])), herdrEnabled: !!vm.herdr?.enabled},
    instance: {instance: vm.instance ? valuesOf(vm.instance) : null, office: vm.office ? valuesOf(vm.office) : null, network: vm.network ? {mode: vm.network.mode.value, port: vm.network.port.value, publicUrl: vm.network.publicUrl.value || ''} : null},
    compte: {owner: {displayName: owner.displayName?.value ?? '', email: owner.email?.value ?? ''}, password: '', confirmation: ''},
  };
}
export function dirty(tab, drafts, vm) {
  if (!vm || !drafts[tab]) return false;
  return JSON.stringify(drafts[tab]) !== JSON.stringify(tab === 'agents' ? agentDraft(vm,drafts[tab].runtime) : initialDrafts(vm)[tab]);
}
export const hasDrafts = (drafts, vm) => ['agents','connexion','instance','compte'].some(tab => dirty(tab, drafts, vm));
export const pendingSections = (drafts, vm, plan) => SETTINGS_TABS.filter(tab => dirty(tab,drafts,vm) || tab==='connexion'&&!!plan?.result);
export const changedFields = (draft, fields) => Object.fromEntries(Object.entries(draft || {}).filter(([id,value]) => fields?.[id]?.editable && value !== fields[id].value));

/** Only declared fields, with a typed secret only when replacing it. An omitted secret preserves a matching saved credential. */
export function runtimeBody(draft, vm) {
  const runtime = connectionRows(draft, vm).find(r => r.id === draft.adapter);
  if (!runtime?.supported) return null;
  return {id: runtime.id, adapter: runtime.adapter || runtime.id, ...Object.fromEntries(runtime.fields.flatMap(f => {
    if (f.writeOnly) {
      const value = draft.secrets[runtime.id]?.[f.id];
      return value ? [[f.id, value]] : [];
    }
    const value = draft.values[runtime.id]?.[f.id];
    return value === undefined ? [] : [[f.id, typeof value === 'string' ? value.trim() : value]];
  }))};
}

export function runtimeError(draft, vm) {
  const runtime = connectionRows(draft, vm).find(r => r.id === draft.adapter);
  if (!runtime?.supported) return {key:'settings.connection.failed'};
  const changedAdapter = runtime.candidate ?? !runtime.selected;
  const changedAddress = runtime.fields.some(f => f.type === 'url' && draft.values[runtime.id]?.[f.id] !== runtime.values[f.id]?.value);
  for (const f of runtime.fields) {
    const value = f.writeOnly ? draft.secrets[runtime.id]?.[f.id] : draft.values[runtime.id]?.[f.id];
    const preserved = f.writeOnly && !Object.hasOwn(draft.secrets[runtime.id] || {},f.id) && runtime.values[f.id]?.tokenSet && !changedAdapter && !changedAddress;
    if (f.required && !preserved && (value === '' || value == null)) return {key:'settings.error.field',field:f.id,label:f.label};
    if (f.type === 'number' && !Number.isFinite(value)) return {key:'settings.error.field',field:f.id,label:f.label};
    if (f.type === 'select' && !f.options.some(o => o.value === value)) return {key:'settings.error.field',field:f.id,label:f.label};
  }
  return null;
}
export function agentError(draft) {
  const ids = new Set();
  for (const a of draft.agents) {
    if (!a.id?.trim() || ids.has(a.id.trim())) return 'settings.error.agentId';
    if (a.name?.trim().length > 80) return 'settings.error.name';
    ids.add(a.id.trim());
  }
  return draft.agents.length && !(draft.primary === null && draft.otherPrimary) && !draft.agents.some(a => a.id === draft.primary && !a.hidden) ? 'settings.error.primary' : null;
}
export const agentBody = (draft, revision) => ({expectedRevision: revision, runtime:draft.runtime, primary:draft.agents.length ? draft.primary : null,
  agents:draft.agents.map(a => ({id:a.id.trim(),name:a.name?.trim() || null,hidden:a.hidden}))});
export function instanceError(draft) {
  if (draft.instance) {
    if (!draft.instance.name?.trim() || draft.instance.name.trim().length > 80) return 'settings.error.name';
    try { if (!draft.instance.timeZone) throw Error(); new Intl.DateTimeFormat('en', {timeZone:draft.instance.timeZone}); } catch { return 'settings.error.zone'; }
  }
  if (!draft.network) return null;
  if (!Number.isInteger(draft.network.port) || draft.network.port < 1 || draft.network.port > 65535) return 'settings.error.port';
  if (draft.network.mode === 'local') return draft.network.publicUrl ? 'settings.error.network' : null;
  try {
    const u=new URL(draft.network.publicUrl);
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/' || (draft.network.mode !== 'lan' && u.protocol !== 'https:')) throw Error();
  } catch { return 'settings.error.network'; }
  return null;
}
export function accountError(draft) {
  if (!draft.owner.displayName?.trim() || draft.owner.displayName.trim().length > 80) return 'settings.error.name';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.owner.email.trim())) return 'settings.error.email';
  if (draft.password || draft.confirmation) {
    if (draft.password.length < 12 || draft.password.length > 1024) return 'settings.error.password';
    if (draft.password !== draft.confirmation) return 'settings.error.passwordMatch';
  }
  return null;
}
export const needsReauth = error => error?.code === 'forbidden' && error.details?.some(d => d.issue === 'reauth-required');
export const reauthValid = (vm, now = Date.now()) => Number.isFinite(vm.reauth?.expiresAt) && vm.reauth.expiresAt > now;

/** Store links are known in-app routes. Never follow arbitrary URLs supplied by a runtime. */
export function lookQuery(route) {
  if (typeof route !== 'string' || !route.startsWith('/boutique?') || /[\\\u0000-\u001f]/.test(route)) return null;
  const u = new URL(route, 'https://ui.example.invalid');
  if (u.origin !== 'https://ui.example.invalid' || u.pathname !== '/boutique') return null;
  const agent = u.searchParams.get('agent');
  return agent ? {onglet:'personnages',agent} : null;
}

export function runtimesBody(draft, vm) {
  const runtimes = connectionRows(draft, vm).filter(r => r.supported && (!r.candidate || draft.enabled[r.id])).map(r => ({
    ...runtimeBody({...draft, adapter:r.id}, vm), name:draft.names?.[r.id] || r.name, enabled:!!draft.enabled[r.id],
  }));
  const sourceChanged=draft.herdrTouched || !!draft.herdrEnabled!==!!vm.herdr?.enabled;
  return { runtimes, ...(sourceChanged?{herdrEnabled:!!draft.herdrEnabled}:{}) };
}
export function runtimesError(draft, vm) {
  for(const r of connectionRows(draft,vm).filter(r=>r.supported && (!r.candidate || draft.enabled[r.id]))) {
    const name=draft.names?.[r.id] ?? r.name;
    if(typeof name!=='string' || !name.trim() || name.length>80 || /[\x00-\x1f\x7f]/.test(name))return {key:'settings.connection.invalidName'};
  }
  for (const r of connectionRows(draft, vm).filter(r => r.supported && draft.enabled[r.id])) {
    const error=runtimeError({...draft, adapter:r.id},vm); if (error) return error;
  }
  return null;
}
export const connectionRows = (draft, vm) => [...vm.runtimes, ...(draft.additions || [])];
/** One provider entry, even when several saved or draft instances use its adapter. */
export function connectionProviders(draft, vm) {
  const groups=new Map();
  for (const row of connectionRows(draft,vm)) {
    const id=row.adapter || row.id;
    if (!groups.has(id)) groups.set(id,{id,name:row.brand?.providerName || row.name,brand:row.brand,rows:[]});
    const group=groups.get(id);
    if (!group.brand?.logo && row.brand?.logo) group.brand=row.brand;
    group.rows.push(row);
  }
  const providers=[...groups.values()].map(group=>{
    const configured=group.rows.filter(r=>!r.candidate);
    // A successful candidate probe or an unsaved activation is not a saved connection.
    const connected=configured.some(r=>(r.enabled ?? r.selected) && ['connected','capacity-limited'].includes(r.connection?.status));
    const failed=configured.some(r=>(r.enabled ?? r.selected) && ['unreachable','refused','unauthorized','unsupported-format'].includes(r.connection?.status))
      || group.rows.some(r=>r.detection?.status==='unreadable');
    const detected=group.rows.some(r=>r.detection ? ['detected','enabled'].includes(r.detection.status) : r.found);
    return {...group,instances:configured.length,status:connected?'connected':failed?'error':detected?'detected':'notDetected'};
  });
  if(vm.herdr){
    const source=vm.herdr,existing=providers.find(p=>p.id==='herdr');
    const connected=source.enabled && source.active && source.status==='available';
    const failed=source.enabled && ['unavailable','unsupported','stale'].includes(source.status);
    const running=source.enabled && source.active && source.status==='not-checked';
    const provider={id:'herdr',name:'herdr',brand:source.brand || existing?.brand,kind:'source',rows:[],instances:0,
      status:connected?'connected':failed?'error':running?'running':source.found?'detected':'notDetected'};
    if(existing)providers[providers.indexOf(existing)]=provider;else providers.push(provider);
  }
  return providers;
}
export const connectionProvider = (providers, query) => providers.find(p=>p.id===query || p.rows.some(r=>r.id===query));
export function connectionsChecked(draft, vm, checks) {
  return connectionRows(draft,vm).filter(r=>r.supported && draft.enabled[r.id]).every(r=>{
    const changed=r.candidate || !r.enabled || r.fields.some(f=>f.writeOnly ? Object.hasOwn(draft.secrets[r.id] || {},f.id) : draft.values[r.id]?.[f.id] !== r.values[f.id]?.value);
    return !changed || checks?.[r.id]?.ok === true;
  });
}
export function addRuntime(draft, vm, runtime) {
  const rows = connectionRows(draft,vm); let n=2, id;
  do { id=(runtime.adapter || runtime.id)+'-'+n++; } while (rows.some(r => r.id === id));
  const values=Object.fromEntries(runtime.fields.filter(f => !f.writeOnly).map(f => [f.id,draft.values[runtime.id]?.[f.id] ?? '']));
  const row={...runtime,id,candidate:true,enabled:false,selected:false,values:Object.fromEntries(runtime.fields.map(f => [f.id,{value:f.writeOnly?null:values[f.id],editable:true,source:'default',reason:null,...(f.writeOnly?{tokenSet:false}:{})}]))};
  return {...draft,additions:[...(draft.additions || []),row],names:{...draft.names,[id]:runtime.name},values:{...draft.values,[id]:values},enabled:{...draft.enabled,[id]:true}};
}


// Guarded accounts carry an independent user revision. Legacy servers retain their wire format.
export const guardedAccount = vm => Number.isInteger(vm?.owner?.revision);
export const accountRevision = vm => guardedAccount(vm) ? vm.owner.revision : vm.revision;
export const passwordBody = (vm,password) => ({...(guardedAccount(vm) ? {expectedRevision:accountRevision(vm)} : {}),password});
export const canManageUsers = me => me?.permissions?.users === 'write';
const tabResources={diagnostic:['health'],agents:['settings.runtimes'],connexion:['settings.runtimes'],integrations:['settings.integrations'],access:['settings.network'],instance:['settings.instance','settings.network']};
export function settingsAccess(tab,vm,me,level='read') {
  if(tab==='users'||tab==='roles')return canManageUsers(me);
  if(tab==='compte')return level==='read'||!!(vm?.owner?.displayName?.editable||vm?.owner?.email?.editable||vm?.owner?.passwordChangeEnabled);
  const resources=tabResources[tab];if(!resources)return level==='read';
  // A guarded response without fresh permission context grants no config actions.
  if(!me?.permissions)return !guardedAccount(vm);
  return resources.some(key=>me.permissions[key]==='write'||level==='read'&&me.permissions[key]==='read');
}
