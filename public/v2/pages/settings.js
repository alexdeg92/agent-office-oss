import { html, useEffect, useLayoutEffect, useRef, useState } from '../lib.js';
import { msg, getLang } from '../i18n.js';
import { registerMessages } from '../messages.js';
import * as dictionary from '../messages/settings.js';
import { buildQuery } from '../config.js';
import { services } from '../services.js';
import { chooseLang } from '../lang.js';
import { readSettings, settingsCommand, reauthenticate } from '../settings-api.js';
import { ErrorState, Icon } from '../components/ui.js';
import { Modal } from '../components/modal.js';
import { SettingsFrame, SettingsFooter } from './settings-frame.js';
import { Switch, SettingRow, loadStyles as loadBureauStyles, Button, Field, TextInput, Radio } from '../components/bureau/index.js';
import { Diagnostics, Agents, Connection, Integrations, Instance, Account, SettingsNotice, RestartAction, settingsLabel } from './settings-views.js';
import * as R from './settings-rules.js';
import { readOnlyBanner } from './settings-labels.js';
import { readBootId, pollRestart } from '../settings-api.js';
import { surprisesEnabled, saveSurprises } from '../office/surprises.js';
import { FixAllSheet } from './settings-fix-all.js';
import { useStore } from '../hooks.js';
import { identityRegistry, identityTheme, loadIdentityPreviewStyles, setIdentityTheme } from '../identity-theme.js';
import { theme } from '../theme.js';
import { ExternalAccessFlow, loadStyles as loadExternalAccessStyles } from './external-access.js';

registerMessages(dictionary);
let styles;
export function loadStyles() {
  if (!globalThis.document) return Promise.resolve();
  return styles ||= Promise.all([loadBureauStyles(),loadExternalAccessStyles(),new Promise((resolve,reject) => {
    const sheet=document.createElement('link'); sheet.rel='stylesheet'; sheet.href=new URL('./settings.css' + buildQuery,import.meta.url).href;
    sheet.onload=resolve; sheet.onerror=() => { sheet.remove(); styles=null; reject(Error('Settings stylesheet unavailable')); };
    document.head.append(sheet);
  })]).catch(error => { styles=null; throw error; });
}
const readError=error => error?.code === 'network' || error?.name === 'TypeError' && /failed to fetch|fetch failed|networkerror|load failed/i.test(error.message || '')
  ? {message:msg('settings.loadInterrupted')} : error;
const newPlan=(vm,runtime=R.activeRuntime(vm)) => ({runtime, action:'install', result:null, agentIds:[], confirmed:false});
const errorText=error => error?.code === 'conflict' ? msg('settings.conflict') : error?.code === 'rate_limited'
  ? msg('settings.error.tooMany',{n:error.retryAfterSec ?? 60}) : error?.message || msg('common.unexpected');

function ReauthDialog({onClose,onConfirmed}) {
  const alive=useRef(true);
  useLayoutEffect(() => { document.getElementById('settings-current-password')?.focus(); return () => { alive.current=false; }; },[]);
  const [password,setPassword]=useState('');
  const [error,setError]=useState(null);
  const [busy,setBusy]=useState(false);
  async function submit(e) {
    e.preventDefault(); if (!password || busy) return;
    setBusy(true); setError(null);
    try { const result=await reauthenticate(password); if (!alive.current) return; setPassword(''); onConfirmed(result.result.expiresAt); }
    catch (err) { if (!alive.current) return; setPassword(''); setError(err.status === 401 ? msg('settings.reauth.invalid') : errorText(err)); setBusy(false); }
  }
  return html`<${Modal} title=${msg('settings.reauth.title')} desc=${msg('settings.reauth.text')} onClose=${() => !busy && onClose()}
    footer=${html`<${Button} type="button"  disabled=${busy} onClick=${onClose} variant="secondary" size="md" label=${msg('common.cancel')} />
      <${Button} type="submit" form="settings-reauth-form"  disabled=${busy || !password} busy=${busy} variant="primary" size="md" label=${msg('settings.reauth.confirm')} />`}>
    <form id="settings-reauth-form" class="ao-form" onSubmit=${submit}>
      <${Field} id="settings-current-password" label=${msg('settings.reauth.password')} error=${error ? html`<span id="settings-reauth-error">${error}</span>` : null} control=${props=>html`<${TextInput} ...${props} type="password" autoComplete="current-password" maxLength=${1024} value=${password} disabled=${busy} onValueChange=${setPassword} />`} />
    </form>
  </${Modal}>`;
}

function LazySettingsAccess({tab,me}) {
  const [view,setView]=useState(null);
  const [error,setError]=useState(null);
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let live=true;
    setError(null);
    import('./settings-access.js'+buildQuery).then(async module=>{
      await module.loadStyles();
      return module.SettingsAccess;
    }).then(Component=>{if(live)setView(()=>Component);},err=>{if(live)setError(err);});
    return()=>{live=false;};
  },[attempt]);
  if(error)return html`<${ErrorState} error=${{code:'network',message:msg('settings.loadInterrupted')}} onRetry=${()=>{setView(null);setError(null);setAttempt(n=>n+1);}} />`;
  if(!view)return html`<p class="bu-sr-only" role="status">${msg('common.loading')}</p>`;
  const Component=view;
  return html`<${Component} tab=${tab} me=${me} />`;
}

/** Device preference: committed immediately, independent of server Settings drafts. */
function Appearance() {
  const identity = useStore(identityTheme);
  const { pref: colorMode } = useStore(theme);
  useEffect(() => { loadIdentityPreviewStyles().catch(error => console.warn('Identity previews unavailable', error)); }, []);
  const [enabled,setEnabled]=useState(surprisesEnabled);
  useEffect(()=>{
    const sync=event=>setEnabled(event.detail);
    window.addEventListener('office-surprises-setting',sync);
    return ()=>window.removeEventListener('office-surprises-setting',sync);
  },[]);
  const label=msg('settings.appearance.surprises');
  const french=getLang().startsWith('fr');
  const activeIdentity=identityRegistry.themes.find(theme=>theme.id===identity.id) || identityRegistry.themes.find(theme=>theme.id===identityRegistry.default);
  return html`<section class="ao-settings__group" aria-labelledby="settings-appearance-office">
    <div class="ao-settings__identity" aria-labelledby="settings-identity-title">
      <h2 class="bu-heading-sm" id="settings-identity-title">${msg('settings.identity.title')}</h2>
      <p class="bu-caption ao-settings__identity-hint">${msg('settings.identity.hint')}</p>
      <div class="ao-settings__identity-options" role="radiogroup" aria-labelledby="settings-identity-title">
        ${identityRegistry.themes.map(theme => html`<${Radio} key=${theme.id} name="identity-theme" value=${theme.id} checked=${identity.id===theme.id}
          class="ao-settings__identity-choice" onCheckedChange=${checked=>checked&&setIdentityTheme(theme.id)}
          label=${html`<span class="ao-settings__identity-copy"><strong>${theme.label[french?'fr':'en']}</strong><span>${theme.description[french?'fr':'en']}</span>
            <span class="ao-settings__identity-preview" data-identity=${theme.id} data-theme=${colorMode === 'system' ? undefined : colorMode} aria-hidden="true">
              <span class="ao-settings__preview-rail"></span><span class="ao-settings__preview-scene"><i></i><i></i><i></i></span>
              <span class="ao-settings__preview-page"><b></b><em></em><em></em><i></i></span>
              <span class="ao-settings__preview-mobile"><i></i><b></b><em></em><em></em><u></u></span>
            </span></span>`} />`)}
      </div>
      <p class="bu-caption ao-settings__immediate ao-settings__identity-status">${msg('settings.identity.immediate',{identity:activeIdentity.label[french?'fr':'en']})}</p>
    </div>
    <h2 class="bu-heading-sm" id="settings-appearance-office">${msg('settings.appearance.office')}</h2>
    <${SettingRow} label=${label} description=${msg('settings.appearance.surprisesHint')} control=${html`<${Switch} id="settings-surprise-animations" checked=${enabled} label=${html`<span class="bu-sr-only">${label}</span>`} onCheckedChange=${value=>saveSurprises(value)} />`} />

    <p class="bu-caption ao-settings__immediate ao-settings__device-status">${msg('settings.appearance.immediate')}</p>
  </section>`;
}

export function SettingsPage({match}) {
  const [me,setMe]=useState(()=>services.me);
  useEffect(()=>{const changed=event=>setMe(event.detail||null);window.addEventListener('agent-office:me',changed);return()=>window.removeEventListener('agent-office:me',changed);},[]);
  const tab=R.settingsTab(match.query.onglet);
  const connectorQuery=match.query.connecteur || 'all';
  const [vm,setVm]=useState(null);
  const [drafts,setDrafts]=useState({});
  const [plan,setPlan]=useState(null);
  const [results,setResults]=useState(null);
  const [loadError,setLoadError]=useState(null);
  const [error,setError]=useState(null);
  const [notice,setNotice]=useState(null);
  const [busy,setBusy]=useState(null);
  const [check,setCheck]=useState(null);
  const [herdrTest,setHerdrTest]=useState(null);
  const [external,setExternal]=useState(false);
  const [accessFooter,setAccessFooter]=useState(null);
  const [dialog,setDialog]=useState(null);
  const [restartState,setRestartState]=useState(null);
  const [batch,setBatch]=useState(null);
  const [fixTarget,setFixTarget]=useState(null);
  const provider=vm&&drafts.connexion?R.connectionProvider(R.connectionProviders(drafts.connexion,vm),match.query.connecteur):null;
  const integrationRows=provider?.rows.filter(r=>r.supported&&vm.runtimes.some(saved=>saved.id===r.id)) || [];
  const integrationRuntime=integrationRows.find(r=>r.id===match.query.runtime)?.id || integrationRows.find(r=>r.id===plan?.runtime)?.id || integrationRows[0]?.id || '';
  const providerPlan=vm ? plan?.runtime===integrationRuntime ? plan : newPlan(vm,integrationRuntime) : null;
  const reviewingIntegrations=tab==='connexion'&&match.query.section==='integrations'&&!!integrationRuntime;

  const restartOperation=useRef(null);
  const vmRef=useRef(null), draftsRef=useRef({}), planRef=useRef(null), body=useRef(null), alive=useRef(true), busyRef=useRef(false), modalRef=useRef(null);
  const pendingRevision=useRef(null);
  const previousConnection=useRef(null);
  const isDirty=() => R.pendingSections(draftsRef.current,vmRef.current,planRef.current).length > 0;
  const setDraftState=next => { draftsRef.current=next; setDrafts(next); };
  const setPlanState=next => { planRef.current=next; setPlan(next); };
  function adopt(next, saved = []) {
    if (!alive.current || !next) return;
    const previous=vmRef.current;
    const clean=R.initialDrafts(next);
    const requested=R.agentRuntimeSelection(next,connectorQuery);
    clean.agents=R.agentDraft(next,requested);
    const merged={...draftsRef.current};
    for (const key of Object.keys(clean)) if (!previous || saved.includes(key) || !R.dirty(key,merged,previous)) merged[key]=clean[key];
    const sourceDraft=draftsRef.current.connexion;
    if(previous && !saved.includes('connexion') && !sourceDraft?.herdrTouched && !!sourceDraft?.herdrEnabled===!!previous.herdr?.enabled)
      merged.connexion={...merged.connexion,herdrEnabled:clean.connexion.herdrEnabled};
    vmRef.current=next; setVm(next); setDraftState(merged);
    if (!planRef.current || !next.runtimes.some(r=>r.id===planRef.current.runtime) && !planRef.current.result) setPlanState(newPlan(next));
    if (!pendingRevision.current || pendingRevision.current <= next.revision) { pendingRevision.current=null; setExternal(false); }
  }
  async function load(discard = false) {
    if (!alive.current || busyRef.current) return;
    busyRef.current=true; setBusy('load'); setLoadError(null);
    try {
      const next=await readSettings();
      if (!alive.current) return;
      if (discard) { setDraftState({}); vmRef.current=null; setPlanState(null); setCheck(null); setError(null); setNotice(null); }
      adopt(next);
    } catch (err) { if (alive.current) setLoadError(err); }
    finally { busyRef.current=false; if (alive.current) setBusy(null); }
  }
  function confirm(kind) {
    if (!alive.current) return Promise.resolve(false);
    return new Promise(resolve => { modalRef.current=resolve; setDialog({kind}); });
  }
  function closeDialog(result = false) { setDialog(null); modalRef.current?.(result); modalRef.current=null; }
  async function authentication(force = false) {
    if (!alive.current) return false;
    if (!force && R.reauthValid(vmRef.current)) return true;
    return confirm('reauth');
  }
  async function refresh() {
    if (isDirty() && !await confirm('refresh')) return;
    await load(true);
  }
  useLayoutEffect(() => {
    alive.current=true; void load();
    const changed=event => {
      if (!vmRef.current || event.revision <= vmRef.current.revision) return;
      pendingRevision.current=event.revision;
      if (busyRef.current || isDirty()) setExternal(true); else void load();
    };
    (services.settingsListeners ||= new Set()).add(changed);
    const guard=async url => {
      const target=new URL(url,location.href);
      if (target.pathname === new URL(services.router.href('parametres'),location.href).pathname) {
        const runtimeQuery=target.searchParams.get('connecteur')||'all';
        if (R.settingsTab(target.searchParams.get('onglet'))==='agents' && vmRef.current && R.dirty('agents',draftsRef.current,vmRef.current)) {
          const runtime=R.agentRuntimeSelection(vmRef.current,runtimeQuery);
          if (draftsRef.current.agents?.runtime !== runtime) {
            if (busyRef.current || !await confirm('switch')) return false;
            update('agents',R.agentDraft(vmRef.current,runtime));
          }
        }
        return true;
      }
      if (busyRef.current) return false;
      return !isDirty() || await confirm('discard');
    };
    (services.navigationGuards ||= new Set()).add(guard);
    const unload=e => { if (isDirty()) { e.preventDefault(); e.returnValue=''; } };
    window.addEventListener('beforeunload',unload);
    return () => {
      alive.current=false; modalRef.current?.(false); modalRef.current=null;
      restartOperation.current?.abort();
      services.settingsListeners.delete(changed); services.navigationGuards.delete(guard); window.removeEventListener('beforeunload',unload);
    };
  },[]);
  useEffect(()=>{
    if(!vm||match.query.onglet!=='integrations')return;
    services.router.setQuery(R.integrationRoute(vm,match.query.runtime || match.query.connecteur || R.activeRuntime(vm)));
  },[vm,match.query.onglet,match.query.connecteur,match.query.runtime]);
  useEffect(() => { setError(null); setNotice(null); if (body.current) body.current.scrollTop=0; },[tab,tab === 'connexion' ? match.query.connecteur : null,match.query.section]);
  useEffect(() => {
    if (tab !== 'connexion' || !vm || !body.current) return;
    const previous=previousConnection.current;
    const current=match.query.connecteur;
    const provider=R.connectionProvider(R.connectionProviders(draftsRef.current.connexion,vm),current || previous);
    previousConnection.current=current || null;
    const frame=requestAnimationFrame(()=>{
      if (current) { if(match.query.orchestrateur!=='herdr'&&match.query.section!=='integrations')document.getElementById('settings-provider-title')?.focus({preventScroll:true}); }
      else if (previous && provider) {
        const card=Array.from(body.current?.querySelectorAll('[data-provider]') || []).find(el=>el.dataset.provider===provider.id);
        card?.focus({preventScroll:true});card?.scrollIntoView({block:'nearest'});
      }
    });
    return()=>cancelAnimationFrame(frame);
  },[tab,match.query.connecteur,!!vm]);
  useEffect(() => { if ((tab==='users'||tab==='roles')&&!R.canManageUsers(me)) services.router.setQuery({onglet:'diagnostic'}); },[tab,me?.user?.id,me?.permissions?.users,me?.permissionRevision?.user,me?.permissionRevision?.permissions]);
  useEffect(() => {
    if (tab !== 'agents' || !vm) return;
    if (!match.query.connecteur) services.router.setQuery({connecteur:'all'});
    else {
      const resolved=R.agentRuntimeSelection(vm,connectorQuery);
      if (resolved !== 'all' && resolved !== connectorQuery) services.router.setQuery({connecteur:resolved});
    }
  },[tab,vm,match.query.connecteur]);
  useEffect(() => {
    if (tab !== 'agents' || !match.query.connecteur || !body.current) return;
    let frame, cancelled=false;
    frame=requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if (cancelled || !alive.current) return;
      const target=body.current?.querySelector('[data-fix-target="true"]');
      if (!target) return;
      target.scrollIntoView({block:'center',behavior:'instant'});
      target.tabIndex=-1; target.focus({preventScroll:true});
    }));
    return()=>{cancelled=true;cancelAnimationFrame(frame);};
  },[tab,match.query.connecteur,match.query.agent,vm]);
  useEffect(() => {
    if (tab !== 'agents' || !vmRef.current || connectorQuery === 'all' || !vmRef.current.runtimes.some(runtime=>runtime.id===connectorQuery)) return;
    const current= draftsRef.current.agents;
    if (current?.runtime === connectorQuery || R.dirty('agents',draftsRef.current,vmRef.current)) return;
    update('agents',R.agentDraft(vmRef.current,connectorQuery));
  },[connectorQuery,tab,vm]);
  useEffect(() => {
    if (tab !== 'connexion' || !fixTarget || !body.current) return;
    // Query navigation restores the frame after two paints. Land after that reset
    // and the sheet's focus restoration, so the requested card remains visible.
    let frame, cancelled=false;
    const land=() => {
      if (cancelled || !alive.current || !body.current) return;
      const card=Array.from(body.current.querySelectorAll('[data-runtime-connection]')).find(el => el.dataset.runtimeConnection === fixTarget);
      if (card) { card.scrollIntoView({block:'start',behavior:'instant'}); card.querySelector('h2')?.focus({preventScroll:true}); }
    };
    frame=requestAnimationFrame(() => { frame=requestAnimationFrame(() => { frame=requestAnimationFrame(land); }); });
    return () => { cancelled=true; cancelAnimationFrame(frame); };
  },[tab,fixTarget]);
  useEffect(() => {
    if (tab !== 'connexion' || match.query.section!=='integrations' || !body.current) return;
    let frame, cancelled=false;
    frame=requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if (cancelled || !alive.current) return;
      const target=body.current?.querySelector('#settings-provider-integrations [data-fix-target="true"]') || document.getElementById('settings-provider-integrations-title');
      if (!target) return;
      target.scrollIntoView({block:'start',behavior:'instant'});
      target.tabIndex=-1; target.focus({preventScroll:true});
    }));
    return()=>{cancelled=true;cancelAnimationFrame(frame);};
  },[tab,fixTarget,match.query.connecteur,match.query.section,match.query.runtime,vm]);
  function update(key, value) { if (busyRef.current) return; if(key==='connexion'&&match.query.section==='integrations')services.router.setQuery({section:null,runtime:null}); setDraftState({...draftsRef.current,[key]:value}); if (key === 'connexion') setCheck(null); setError(null); setNotice(null); }
  async function switchRuntime(key,id) {
    if (busyRef.current) return false;
    if (R.dirty(key,draftsRef.current,vmRef.current) && !await confirm('switch')) return false;
    const next=key === 'agents' ? R.agentDraft(vmRef.current,id) : {...R.initialDrafts(vmRef.current).connexion,adapter:id};
    update(key,next);
    if (key === 'agents') services.router.setQuery({connecteur:id === 'all' ? 'all' : id});
    return true;
  }
  async function viewDetected(connector) {
    if (busyRef.current || !vmRef.current) return;
    const runtime=R.agentRuntimeSelection(vmRef.current,connector);
    const dirty=R.dirty('agents',draftsRef.current,vmRef.current);
    if (dirty && draftsRef.current.agents?.runtime !== runtime) {
      if (!await confirm('switch')) return;
      update('agents',R.agentDraft(vmRef.current,runtime));
    } else if (!dirty) update('agents',R.agentDraft(vmRef.current,runtime));
    setBatch(null);
    // Set tab and filter atomically: a connector-only intermediate navigation
    // used to leave stale tab state and could restore the generic Instance tab.
    services.router.setQuery({onglet:'agents',connecteur:runtime,agent:null});
  }
  function viewOrchestrator() {
    if (busyRef.current) return;
    setBatch(null);
    services.router.setQuery({onglet:'connexion',connecteur:'herdr',agent:null,orchestrateur:'herdr'});
  }
  const select=id => id==='integrations' ? services.router.setQuery(R.integrationRoute(vmRef.current,planRef.current?.runtime)) : services.router.setQuery({onglet:id === 'diagnostic' ? null : id,section:null,runtime:null,...(tab === 'connexion' || id === 'connexion' ? {connecteur:null,orchestrateur:null} : {})});
  function fail(text) { setError(text); requestAnimationFrame(() => { if (body.current) body.current.scrollTop=0; }); }
  async function run(name, work, sensitive = false) {
    if (!alive.current || busyRef.current || vmRef.current?.readonly) return;
    busyRef.current=true; setBusy(name); setError(null); setNotice(null);
    try {
      if (sensitive && !await authentication()) return;
      if (!alive.current) return;
      try { await work(); }
      catch (err) {
        if (!alive.current) return;
        if (!R.needsReauth(err) || !await authentication(true)) throw err;
        if (!alive.current) return;
        await work();
      }
    } catch (err) { if (alive.current) fail(errorText(err)); }
    finally {
      busyRef.current=false;
      if (alive.current) {
        setBusy(null);
        // A change arriving while a command was running must not leave a clean view stale.
        if (pendingRevision.current > vmRef.current?.revision && !isDirty()) void load();
      }
    }
  }
  async function testConnection(id) {
    const draft={...draftsRef.current.connexion,adapter:id};
    const problem=R.runtimeError(draft,vmRef.current);
    if (problem) { fail(msg(problem.key,{name:settingsLabel(problem.label)})); return; }
    await run('check',async () => {
      const result=await settingsCommand('check',{runtime:R.runtimeBody(draft,vmRef.current)});
      setCheck(previous => ({...previous,[id]:result.result})); adopt(result.vm || await readSettings());
    },R.dirty('connexion',draftsRef.current,vmRef.current));
  }
  async function setAutoAdd(runtime,enabled) {
    await run('auto-add',async()=>{
      const result=await settingsCommand('auto-add',{expectedRevision:vmRef.current.revision,runtime,enabled},'PUT');
      adopt(result.vm || await readSettings());
    });
  }
  async function detect() {
    await run('detect',async () => { const result=await settingsCommand('detect'); if (result.vm) adopt(result.vm); else adopt(await readSettings()); });
  }
  async function testHerdr() {
    await run('herdrCheck', async () => { const result=await settingsCommand('herdr/check'); setHerdrTest(result.result); adopt(result.vm || await readSettings()); });
  }
  function openFixAll(fixes = R.diagnosticFixes(vmRef.current)) {
    if (busyRef.current || vmRef.current?.readonly) return;
    setError(null);
    setBatch({revision:vmRef.current.revision,fixes,selected:fixes.filter(R.automaticFix).map(f => f.id),result:null});
  }
  async function fixInput(fix) {
    if (busyRef.current) return;
    if (fix.kind === 'instance.restart') { await restart(); return; }
    if (fix.kind === 'client.reload') {
      if (!isDirty() || await confirm('discard')) location.reload();
      return;
    }
    const target=R.fixTab(fix), runtime=fix.target.runtime;
    if (target === 'agents') {
      const selected=R.agentRuntimeSelection(vmRef.current,runtime);
      if (R.dirty('agents',draftsRef.current,vmRef.current) && draftsRef.current.agents?.runtime !== selected && !await confirm('switch')) return;
      update('agents',R.agentDraft(vmRef.current,selected)); setBatch(null);
      services.router.setQuery({onglet:'agents',connecteur:selected,agent:fix.target.agentId || null});
      return;
    }
    if (fix.kind.startsWith('integration.')) {
      if (planRef.current?.result && !await confirm('switch')) return;
      setPlanState({...newPlan(vmRef.current),runtime});
      setFixTarget(`integration:${runtime}:${fix.target.agentId}:${fix.target.integration}`);
      setBatch(null);services.router.setQuery(R.integrationRoute(vmRef.current,runtime));return;
    }
    if (!alive.current) return;
    setFixTarget(target === 'connexion' ? runtime : null);
    setBatch(null);
    if (target === 'connexion') services.router.setQuery({onglet:target,connecteur:runtime,section:null});
    else services.router.setQuery({onglet:target,connecteur:null,agent:null});
  }
  // Keep individual integration corrections in the reviewed Integrations flow.
  // Fix-all remains the explicit entry point for batching automatic integration writes.
  const fixOne=fix => fix.kind.startsWith('integration.') ? fixInput(fix) : R.selectableFix(fix) ? openFixAll([fix]) : fixInput(fix);
  async function applyFixAll() {
    if (!batch || batch.result || batch.revision !== vmRef.current.revision) return;
    const items=R.fixAllItems(batch.fixes,batch.selected);
    if (!items.length) return;
    await run('fix-all',async () => {
      const response=await settingsCommand('fix-all',{expectedRevision:batch.revision,confirmed:true,items});
      if (!alive.current) return;
      setBatch(previous => ({...previous,result:response.result}));
      adopt(response.vm || await readSettings());
      // Re-diagnose disk-backed changes immediately; the same GET also runs after restart reload.
      const fresh=await readSettings(); if (alive.current) adopt(fresh);
    },items.some(item => batch.fixes.find(f => f.id === item.id)?.requiresReauth));
  }
  const restartActive=controller => alive.current && !controller.signal.aborted && restartOperation.current === controller;
  async function withRestartOperation(work) {
    if (!alive.current || busyRef.current || restartOperation.current) return;
    const controller=new AbortController(); restartOperation.current=controller;
    try { await work(controller); }
    finally { controller.abort(); if (restartOperation.current === controller) restartOperation.current=null; }
  }
  async function waitForRestart(bootId,controller) {
    if (!restartActive(controller)) return;
    setRestartState({status:'waiting',bootId});
    try { await pollRestart(bootId,{signal:controller.signal}); if (restartActive(controller)) location.reload(); }
    catch (err) { if (restartActive(controller)) setRestartState({status:'timeout',bootId}); }
  }
  async function restart() {
    if (busyRef.current || vmRef.current?.readonly || !vmRef.current?.restart?.supported) return;
    await withRestartOperation(async controller => {
      if (!await confirm('restart') || !restartActive(controller)) return;
      await run('restart',async () => {
        if (!restartActive(controller)) return;
        const bootId=await readBootId({signal:controller.signal});
        if (!restartActive(controller)) return;
        let result;
        try { result=await settingsCommand('restart',{expectedRevision:vmRef.current.revision,bootId,confirmed:true}); }
        catch (err) { if (!restartActive(controller)) return; if (err.code !== 'network') throw err; }
        if (!restartActive(controller)) return;
        // A lost response may mean the API already exited. Check its identity, never repeat the POST.
        await waitForRestart(result?.result?.bootId || bootId,controller);
      },true);
    });
  }
  const retryPoll=() => withRestartOperation(controller => run('restart',() => waitForRestart(restartState.bootId,controller)));
  async function setIntegrationPlan(next) {
    if(busyRef.current||!vmRef.current||vmRef.current.readonly||!R.settingsAccess('integrations',vmRef.current,me,'write'))return false;
    if(planRef.current?.result&&planRef.current.runtime!==next.runtime&&!await confirm('switch'))return false;
    setPlanState(next);setResults(null);
    services.router.setQuery(R.integrationRoute(vmRef.current,next.runtime));return true;
  }
  async function preparePlan() {
    if(!await setIntegrationPlan(providerPlan))return;
    await run('plan',async () => {
      const result=await settingsCommand('integrations/plan',{runtime:planRef.current.runtime,locale:getLang()});
      setPlanState({...planRef.current,result:result.result,confirmed:false,agentIds:result.result.agents.filter(a => !['conflict','unsupported'].includes(a.status)).map(a => a.id)});
      setResults(null);
    });
  }
  async function applyIntegrations() {
    const current=vmRef.current,pending=planRef.current;
    if(!current||current.readonly||busyRef.current||!R.settingsAccess('integrations',current,me,'write')||!reviewingIntegrations||pending?.runtime!==integrationRuntime)return;
    if(!pending.result||!pending.confirmed||!pending.agentIds.length){fail(msg('settings.confirmation.required'));return;}
    await run('save',async()=>{
      const result=await settingsCommand('integrations/apply',{planId:pending.result.planId,agentIds:pending.agentIds,confirmed:true,action:pending.action});
      setResults({...result.result,runtime:pending.runtime});setPlanState(newPlan(result.vm||vmRef.current,pending.runtime));
      adopt(result.vm||await readSettings());adopt(await readSettings());
    },true);
  }
  function pendingDetails() {
    if(planRef.current?.result&&!R.dirty('connexion',draftsRef.current,vmRef.current))services.router.setQuery(R.integrationRoute(vmRef.current,planRef.current.runtime));
    else select(R.pendingSections(draftsRef.current,vmRef.current,planRef.current)[0]);
  }
  async function save() {
    const current=vmRef.current;
    if (!current || current.readonly || busyRef.current || !R.settingsAccess(tab,current,me,'write')) return;
    const draft=draftsRef.current[tab];
    let problem=tab === 'agents' ? R.agentError(draft) : tab === 'instance' ? R.instanceError(draft) : tab === 'compte' ? R.accountError(draft) : null;
    if (tab === 'connexion') {
      const issue=R.runtimesError(draft,current);
      problem=issue ? msg(issue.key,{name:settingsLabel(issue.label)}) : null;
    }
    if (problem) { fail(problem.startsWith('settings.') ? msg(problem) : problem); return; }
    if (!R.dirty(tab,draftsRef.current,current)) return;
    const networkChanged=tab === 'instance' && draft.network && JSON.stringify(draft.network) !== JSON.stringify(R.initialDrafts(current).instance.network);
    const accountChanged=tab === 'compte' && Object.keys(R.changedFields(draft.owner,current.owner)).length>0;
    const sensitive=tab === 'connexion' || networkChanged || tab === 'compte' && (accountChanged || draft.password);
    await run('save',async () => {
      let result;
      if (tab === 'agents') result=await settingsCommand('agents',R.agentBody(draftsRef.current.agents,vmRef.current.revision),'PUT');
      if (tab === 'connexion') result=await settingsCommand('runtimes',{expectedRevision:vmRef.current.revision,...R.runtimesBody(draftsRef.current.connexion,vmRef.current)},'PUT');
      if (tab === 'instance') {
        const d=draftsRef.current.instance;
        const instance=R.changedFields(d.instance,vmRef.current.instance);
        if (Object.keys(instance).length) { result=await settingsCommand('instance',{expectedRevision:vmRef.current.revision,...instance},'PUT'); adopt(result.vm); }
        if (d.network && JSON.stringify(d.network) !== JSON.stringify(R.initialDrafts(vmRef.current).instance.network)) {
          result=await settingsCommand('network',{expectedRevision:vmRef.current.revision,...d.network,publicUrl:d.network.publicUrl.trim() || null},'PUT');
        }
      }
      if (tab === 'compte') {
        const d=draftsRef.current.compte;
        const owner=R.changedFields(d.owner,vmRef.current.owner);
        if (Object.keys(owner).length) {
          result=await settingsCommand('owner',{expectedRevision:R.accountRevision(vmRef.current),...owner},'PUT');
          const password=d.password,confirmation=d.confirmation;
          const refreshed=result.vm || await readSettings();
          adopt(refreshed,['compte']);
          if(password)setDraftState({...draftsRef.current,compte:{...R.initialDrafts(refreshed).compte,password,confirmation}});
        }
        if (d.password) {
          try { result=await settingsCommand('password',R.passwordBody(vmRef.current,d.password)); }
          catch (err) {
            if (!R.needsReauth(err) || !await authentication(true)) throw err;
            result=await settingsCommand('password',R.passwordBody(vmRef.current,d.password));
          }
        }
      }
      adopt(result?.vm || await readSettings(),[tab]);
      if (tab === 'instance' && vmRef.current.instance?.locale?.value && vmRef.current.instance.locale.value !== getLang()) chooseLang(vmRef.current.instance.locale.value);
      setCheck(null); setNotice(msg('settings.saved'));
    },!!sensitive);
  }

  const integrationRead=!!vm&&R.settingsAccess('integrations',vm,me,'read');
  const integrationWrite=!!vm&&R.settingsAccess('integrations',vm,me,'write');
  const canRead=!!vm && (R.settingsAccess(tab,vm,me,'read') || tab==='connexion'&&integrationRead);
  const canWrite=!!vm && R.settingsAccess(tab,vm,me,'write');
  const disabled=!!busy || !!vm?.readonly || !canWrite;
  const restartAction=(label) => vm ? html`<${RestartAction} capability=${vm.restart} state=${restartState} busy=${!!busy} readonly=${vm.readonly} label=${label} onRestart=${restart} onPoll=${retryPoll} />` : null;
  const currentDirty=vm && (reviewingIntegrations ? !!providerPlan?.result : tab === 'agents' && connectorQuery === 'all' ? false : R.dirty(tab,drafts,vm));
  const pendingSections=vm ? R.pendingSections(drafts,vm,plan) : [];
  const footer=tab==='access'?accessFooter:vm && pendingSections.length && ['agents','connexion','instance','compte'].includes(tab) ? html`<${SettingsFooter} dirty=${!!currentDirty} pendingSections=${R.pendingSections(drafts,vm,plan)} busy=${!!busy} writable=${!vm.readonly&&(reviewingIntegrations?integrationWrite:canWrite)} onDetails=${pendingDetails} onCancel=${() => {
    if (reviewingIntegrations) { setPlanState(newPlan(vm,integrationRuntime)); setResults(null); }
    else update(tab,tab === 'agents' ? R.agentDraft(vm,drafts.agents.runtime) : R.initialDrafts(vm)[tab]);
  }} form=${reviewingIntegrations?null:'settings-section-form'} onSave=${reviewingIntegrations?applyIntegrations:save} saveTestId=${reviewingIntegrations?'settings-integration-apply':undefined} saveLabel=${reviewingIntegrations ? msg('settings.integrations.apply') : null}
    canSave=${reviewingIntegrations ? !!providerPlan?.confirmed && !!providerPlan?.agentIds.length : tab === 'connexion' ? !R.runtimesError(drafts.connexion,vm) && R.connectionsChecked(drafts.connexion,vm,check) : true} />` : null;
  const head=vm?.readonly && tab !== 'apparence' ? html`<div class="ao-settings__banner"><${SettingsNotice} warning text=${readOnlyBanner(vm.disabledReason)} /></div>` : canRead&&!(canWrite||tab==='connexion'&&integrationWrite)&&tab!=='apparence' ? html`<div class="ao-settings__banner"><${SettingsNotice} warning text=${msg('settings.permissionReadOnly')} /></div>` : null;
  let content;
  if (!vm) content=loadError ? html`<${ErrorState} error=${readError(loadError)} onRetry=${() => load()} />` : html`<p role="status">${msg('settings.loading')}</p>`;
  else content=html`
    ${external ? html`<${SettingsNotice} warning text=${msg('settings.refresh.changed')} action=${html`<${Button} type="button"  disabled=${!!busy} onClick=${refresh} variant="secondary" size="sm" label=${msg('settings.refresh.action')} />`} />` : null}
    ${loadError ? html`<${ErrorState} compact error=${readError(loadError)} onRetry=${refresh} />` : null}
    ${error && !batch ? html`<div class="bu-banner bu-banner--danger" role="alert"><${Icon} name="alert" /><span class="bu-banner__text">${error}</span>${error===msg('settings.conflict')?html`<${Button} type="button" disabled=${!!busy} onClick=${refresh} variant="secondary" size="sm" label=${msg('settings.refresh.action')} />`:null}</div>` : null}
    ${notice ? html`<${SettingsNotice} text=${notice} />` : null}
    ${vm.network?.restartRequired ? html`<${SettingsNotice} warning text=${msg('settings.restart')} action=${restartAction()} />` : null}
    ${!canRead ? html`<div class="bu-banner bu-banner--warning" role="alert"><span class="bu-banner__text">${msg('settings.permissionDenied')}</span></div>` : null}
    ${pendingSections.length && !currentDirty ? html`<p class="bu-caption ao-settings__pending" role="status" title=${msg('settings.dirtySections',{sections:pendingSections.map(id => msg('settings.tab.' + id)).join(', ')})}>${msg('settings.dirtySections',{sections:pendingSections.map(id => msg('settings.tab.' + id)).join(', ')})}</p>` : null}
    <form id="settings-section-form" class="ao-settings__section" aria-busy=${busy ? 'true' : 'false'} novalidate onSubmit=${e => { e.preventDefault(); void save(); }}>
      ${canRead && tab === 'diagnostic' ? html`<${Diagnostics} vm=${vm} onFix=${fixOne} onViewDetected=${viewDetected} onViewOrchestrator=${viewOrchestrator} onFixAll=${() => openFixAll()} onRefresh=${refresh} busy=${!!busy||!canWrite} restartAction=${restartAction()} />` : null}
      ${canRead && tab === 'agents' ? html`<${Agents} vm=${vm} draft=${drafts.agents} selectedRuntime=${R.agentRuntimeSelection(vm,connectorQuery)} targetAgent=${match.query.agent || null} onChange=${v => update('agents',v)} onRuntime=${id => switchRuntime('agents',id)} onDetect=${detect} disabled=${disabled} busy=${busy === 'detect'} />` : null}
      ${canRead && tab === 'connexion' ? html`<${Connection} vm=${vm} providerQuery=${match.query.connecteur} target=${fixTarget} draft=${drafts.connexion} onChange=${v => update('connexion',v)} onRuntime=${id => switchRuntime('connexion',id)} onTest=${testConnection} onAutoAdd=${setAutoAdd} onTestHerdr=${testHerdr} herdrTest=${herdrTest} testResult=${check} disabled=${disabled} busy=${busy === 'check' || busy === 'herdrCheck'} highlightHerdr=${match.query.orchestrateur==='herdr'} integrationRuntime=${integrationRuntime} renderIntegrations=${()=>html`<${Integrations} vm=${vm} plan=${providerPlan} runtimes=${integrationRows} target=${fixTarget} onChange=${setIntegrationPlan} onPlan=${preparePlan} canRead=${integrationRead} disabled=${!!busy||vm.readonly||!integrationWrite} results=${results?.runtime===integrationRuntime?results:null} />`} />` : null}
      ${canRead && tab === 'instance' ? html`<${Instance} vm=${vm} draft=${drafts.instance} onChange=${v => update('instance',v)} disabled=${disabled} />` : null}
      ${tab === 'access' && canRead ? html`<${ExternalAccessFlow} context="settings" onFooterChange=${setAccessFooter} writable=${canWrite&&!vm.readonly} requestReauth=${()=>authentication()} />` : null}
      ${tab === 'apparence' ? html`<${Appearance} />` : null}
      ${canRead && tab === 'compte' ? vm.owner ? html`<${Account} vm=${vm} draft=${drafts.compte} onChange=${v => update('compte',v)} disabled=${disabled} />` : html`<p class="bu-caption" role="status">${msg('settings.access.unavailable')}</p>` : null}
      ${(tab === 'users' || tab === 'roles') && canRead ? html`<${LazySettingsAccess} tab=${tab} me=${me} />` : null}
    </form>`;
  return html`<${SettingsFrame} tab=${tab} onSelect=${select} head=${head} foot=${footer} busy=${!!busy} bodyRef=${body} me=${me}>${content}</${SettingsFrame}>
    ${batch && !dialog ? html`<${FixAllSheet} batch=${batch} busy=${!!busy} readonly=${vm?.readonly} readonlyReason=${vm?.disabledReason} stale=${batch.revision !== vm?.revision} error=${error}
      onClose=${() => { setBatch(null); setError(null); }} onToggle=${(id,on) => setBatch(previous => ({...previous,selected:on ? [...previous.selected,id] : previous.selected.filter(x => x !== id)}))}
      onApply=${applyFixAll} onInput=${fixInput} restartAction=${restartAction(msg('settings.restart.now'))} />` : null}
    ${dialog?.kind === 'reauth' ? html`<${ReauthDialog} onClose=${() => closeDialog(false)} onConfirmed=${expiresAt => {
      if (!alive.current) return;
      const next={...vmRef.current,reauth:{...vmRef.current.reauth,expiresAt}}; vmRef.current=next; setVm(next); closeDialog(true);
    }} />` : dialog ? html`<${Modal} title=${msg(dialog.kind === 'restart' ? 'settings.restart.title' : dialog.kind === 'refresh' ? 'settings.refresh.title' : dialog.kind === 'switch' ? 'settings.switch.title' : 'settings.discard.title')}
      desc=${dialog.kind === 'restart' ? msg('settings.restart.text') + (isDirty() ? ' ' + msg('settings.restart.drafts') : '') : msg(dialog.kind === 'refresh' ? 'settings.refresh.text' : dialog.kind === 'switch' ? 'settings.switch.text' : 'settings.discard.text')} onClose=${() => closeDialog(false)}
      footer=${html`<${Button} type="button"  onClick=${() => closeDialog(false)} variant="secondary" size="md" label=${msg('settings.discard.stay')} />
        <${Button} type="button"  onClick=${() => closeDialog(true)} variant="primary" size="md" label=${msg(dialog.kind === 'restart' ? 'settings.restart.confirm' : dialog.kind === 'refresh' ? 'settings.refresh.action' : dialog.kind === 'switch' ? 'settings.switch.confirm' : 'settings.discard.leave')} />`} />` : null}`;
}
