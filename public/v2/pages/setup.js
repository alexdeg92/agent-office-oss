import { chunkError } from '../build-update.js';
// First-run setup (F8; explorer-05 « installation », ADR-001 §5 / §12.1, G4): shown instead of the app when
// MetaVM.instance.configured === false. Welcome (one-time setup code) → runtime → gateway check → agents → identities
// → office → review → done. The step is in the URL (?etape=); the setup code and the runtime token live in memory
// only (never in the URL, storage or any echo); a connection change invalidates the check and the agents.
// Mock API: mock/setup.js (the G4 proposal); the rules: pages/setup-rules.js.
import { html, useEffect, useRef, useState } from '../lib.js';
import { msg, getLang } from '../i18n.js';
import { assetUrl, buildQuery } from '../config.js';
import { registerMessages } from '../messages.js';
import * as onboardingMessages from '../messages/onboarding.js';
import * as fmt from '../fmt.js';
import { get, post, put } from '../api.js';
import { services } from '../services.js';
import { chooseLang } from '../lang.js';
import { Frame, Icon, Skeleton, StateArt } from '../components/ui.js';
import { ThemeSwitch, LangSwitch, Logo } from '../components/shell.js';
import { Say } from '../components/editorial.js';
import { IdentitiesStep } from './setup-identities.js';
import { DetectionStep, SkillsStep } from './setup-onboarding.js';
import { ExternalAccessFlow, loadStyles as loadExternalAccessStyles } from './external-access.js';
import * as R from './setup-rules.js';

// The setup route owns its dictionary and stylesheet; other pages never load them.
registerMessages(onboardingMessages);
let styles;
export function loadStyles() {
  if (!globalThis.document) return Promise.resolve();
  if (!styles) styles = new Promise((resolve, reject) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('./setup.css' + buildQuery, import.meta.url).href;
    l.onload = resolve;
    l.onerror = () => { l.remove(); styles = null; reject(chunkError(new Error('Setup stylesheet unavailable'))); };
    document.head.append(l);
  }).then(() => loadExternalAccessStyles()).catch(error => { styles=null; throw error; });
  return styles;
}

const ART = { detection: 'setup-connecting', skills: 'setup-agents-found', network: 'setup-connecting', welcome: 'setup-welcome', runtime: 'setup-connecting', gateway: 'setup-connecting', agents: 'setup-agents-found', identities: 'setup-agents-found', office: 'setup-welcome', review: 'setup-all-set', done: 'setup-all-set' };
const zones = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC']; } })();

export function SetupPage() {
  const { router } = services;
  const [vm, setVm] = useState(undefined);
  const [loadError, setLoadError] = useState(null);
  const [s, setS] = useState(() => ({ code: '', adapter: '', fields: null, gatewayUrl: '', token: '', check: null, agents: null, primary: null, looks: {},
    detections: null, catalog: null, skillPlan: null, skillSelection: [], skillResults: null, accessStaged: false, accessDraft: null, accessLegacyFallback: false, ownerSaved: false, resumePending: false, name: '', owner: '', email: '', password: '', password2: '', passwordSet: false, locale: getLang(), timeZone: '', projet: true, projetResult: null }));
  const [busy, setBusy] = useState(null);
  const [saved, setSaved] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => router.subscribe(() => setTick((n) => n + 1)), []);   // ?etape changes re-render
  const [error, setError] = useState(null);
  const q = new URLSearchParams(location.search);
  const asked = Math.max(0, Math.min(R.STEPS.length - 1, Number(q.get('etape')) || 0));
  const DONE = R.STEPS.indexOf('done');
  const max = saved ? DONE : Math.min(asked, R.reachable(s));   // « done » only after a successful save
  const step = R.STEPS[max];

  async function load() {
    setLoadError(null);
    try {
      const r = await get('/api/v2/setup', { quiet: true });
      setVm(r.data);
      // Prefill from the server's non-secret draft (null unless the state is open); secrets only say they're set.
      const d = r.data.draft;
      const adapterId = s.adapter || (d && d.runtime.adapter) || (r.data.adapters[0] || {}).id;
      setS((x) => ({ ...x, adapter: x.adapter || adapterId, fields: (r.data.adapters.find((a) => a.id === (x.adapter || adapterId)) || {}).fields || null,
        gatewayUrl: x.gatewayUrl || (d && d.runtime.gatewayUrl) || '', name: x.name || (d ? d.instance.name : ''),
        owner: x.owner || (d ? d.owner.displayName : ''), email: x.email || (d ? d.owner.email : ''), passwordSet: !!(d && d.owner.passwordSet), ownerSaved: x.ownerSaved, resumePending: !!(d && d.owner.passwordSet) && !x.ownerSaved,
        network: { ...x.network, port: r.data.network?.port || x.network.port },
        timeZone: x.timeZone || (d && d.instance.timeZone) || r.data.suggestedTimeZone || fmt.timeZone() }));
    } catch (e) { setLoadError(e); }
  }
  useEffect(() => { load(); }, []);
  // A step the answers don't reach yet is never shown (no skipping); the URL follows the step really shown.
  useEffect(() => { if (vm && max !== asked) router.setQuery({ etape: max || null }); }, [max, asked, !!vm]);
  const go = (i) => { setError(null); router.setQuery({ etape: i || null }, { replace: false }); };
  const set = (patch) => { setError(null); setS((x) => ({ ...x, ...patch })); };
  // R20-02: every connection edit starts a new generation; a check or discovery answered for an older one is dropped
  // (result, error and busy state alike), so a late answer can never validate or fill in a different connection.
  const conn = useRef(0);
  const setConn = (patch) => { conn.current++; setBusy(null); setError(null); setS((x) => R.withConnection(x, patch)); };
  const fail = (e) => {
    if (e && e.code === 'forbidden' && e.details && e.details.some((d) => d.issue === 'locked')) { setVm((v) => ({ ...v, state: 'locked', draft: null })); return; }
    if (e?.code === 'forbidden' && e.details?.some(d => d.field === 'setupCode' && d.issue === 'expired')) { set({ code: '', token: '', check: null, skillPlan: null, skillResults: null }); go(0); setError(msg('onboarding.code.expired')); return; }
    if (e && e.code === 'rate_limited') { setError(msg('setup.err.tooMany', { n: e.retryAfterSec ?? 60 })); return; }   // wrong codes count toward the login throttle
    if (e && e.code === 'forbidden' && e.details && e.details.some((d) => d.field === 'setupCode')) { go(0); setError(msg('setup.err.codeInvalid')); return; }   // after go(), which clears errors
    setError(e ? e.message : msg('common.unexpected'));
  };
  const runtime = () => R.runtimeBody(s);

  async function check() {
    const g = conn.current;
    setBusy('check'); setError(null);
    try { const r = await post('/api/v2/setup/check', { setupCode: s.code.trim(), runtime: runtime() }, { quiet: true }); if (g === conn.current) set({ check: r.data.result }); }
    catch (e) { if (g === conn.current) fail(e); } finally { if (g === conn.current) setBusy(null); }
  }
  async function discover() {
    const g = conn.current;
    setBusy('discover'); setError(null);
    try {
      const r = await post('/api/v2/setup/discover', { setupCode: s.code.trim(), runtime: runtime() }, { quiet: true });
      if (g !== conn.current) return;
      const agents = r.data.result.agents;
      const primary = (agents.find((a) => a.isPrimary) || agents[0] || {}).id || null;
      set({ agents, primary, looks: {}, skillPlan: null, skillResults: null });   // the characters component suggests and reports each look
    } catch (e) { if (g === conn.current) fail(e); } finally { if (g === conn.current) setBusy(null); }
  }
  async function createOwner() {
    setBusy('owner'); setError(null);
    try {
      if (s.resumePending) {
        const r = await post('/api/v2/setup/resume', { setupCode: s.code.trim() }, { quiet: true });
        if (!r.data.result.owner) { set({ resumePending: false, passwordSet: false }); return; }
        set({ owner: r.data.result.owner.displayName, email: r.data.result.owner.email, ownerSaved: true, resumePending: false, passwordSet: true }); go(max + 1); return;
      }
      const r = await post('/api/v2/setup/owner', { setupCode: s.code.trim(), owner: { displayName: s.owner.trim(), email: s.email.trim(), password: s.password, passwordConfirmation: s.password2 } }, { quiet: true });
      set({ ownerSaved: true, passwordSet: true, password: '', password2: '', email: r.data.result.owner.email }); go(max + 1);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }
  async function detect() {
    setBusy('detect'); setError(null);
    try {
      const r = await post('/api/v2/setup/detect', { setupCode: s.code.trim() }, { quiet: true });
      const d = r.data.result.runtimes, selected = d.find(x => x.runtime === r.data.result.selected);
      if (selected) {
        const a = vm.adapters.find(x => x.id === selected.runtime);
        setConn({ adapter: a.id, fields: a.fields, gatewayUrl: selected.connection?.gatewayUrl || a.defaultGatewayUrl || '', token: '' });
      }
      if (!selected && d.filter(x => x.found && x.supported).length > 1) setConn({ adapter: '', fields: [], gatewayUrl: '', token: '' });
      set({ detections: d });
    } catch (e) { set({ detections: [] }); fail(e); } finally { setBusy(null); }
  }
  async function plan() {
    const g = conn.current;
    setBusy('plan'); setError(null);
    try {
      const r = await post('/api/v2/setup/integrations/plan', { setupCode: s.code.trim(), runtime: runtime(), locale: s.locale }, { quiet: true });
      if (g !== conn.current) return;
      const p = r.data.result;
      set({ skillPlan: p, skillResults: null, skillSelection: p.agents.filter(a => !['unsupported', 'conflict'].includes(a.status)).map(a => a.id) });
    } catch (e) { if (g === conn.current) fail(e); } finally { if (g === conn.current) setBusy(null); }
  }
  async function apply(action) {
    const g = conn.current;
    setBusy('install'); setError(null);
    try {
      const r = await post('/api/v2/setup/integrations/apply', { setupCode: s.code.trim(), planId: s.skillPlan.planId, agentIds: s.skillSelection, confirmed: true, action }, { quiet: true });
      if (g === conn.current) set({ skillResults: r.data.result.agents });
    } catch (e) { if (g === conn.current) fail(e); } finally { if (g === conn.current) setBusy(null); }
  }
  useEffect(() => {
    if (vm?.state !== 'open') return;
    if (step === 'detection' && s.detections === null) detect();
    if (step === 'gateway' && !s.check && s.detections?.some(d => d.runtime === s.adapter && d.connection?.gatewayUrl === s.gatewayUrl && d.connection?.tokenSet)) check();
    if (step === 'skills' && !s.skillPlan) plan();
    if (step === 'identities' && !s.catalog) get('/api/v2/setup/catalog', { quiet: true }).then(r => set({ catalog: r.data }), fail);
  }, [step, vm?.state]);

  async function save() {
    setBusy('save'); setError(null);
    try {
      const r = await put('/api/v2/setup', R.payload(s, vm), { quiet: true });
      const res = r && r.data && r.data.result;
      set({ token: '', password: '', password2: '', projetResult: (res && res.integrations && res.integrations.projet) || null }); setSaved(true); go(DONE);
    }
    catch (e) { fail(e); } finally { setBusy(null); }
  }
  function next(e) {
    if (e) e.preventDefault();
    const b = R.blocker(max, s);
    if (b) { setError(msg(b)); return; }
    if (step === 'welcome') { createOwner(); return; }
    if (step === 'review') { save(); return; }
    go(max + 1);
  }

  const [accessFooter,setAccessFooter]=useState(null);
  const closed = vm && vm.state !== 'open' && !saved;
  return html`<div class="ao-setup-page"><${Frame} tag="main" class="bu-page ao-setup" aria-labelledby="setup-titre"
    foot=${vm && !closed && step === 'network' ? html`<div class="ao-setup__footer">${accessFooter}</div>` : vm && !closed ? html`<div class="ao-setup__footer">${step === 'done' ? html`<a class="bu-btn bu-btn--primary bu-btn--lg" href=${router.href('bureau')} onClick=${(e) => { e.preventDefault(); location.assign(router.href('bureau')); }}>${msg('setup.open')}</a>`
            : html`<div class="ao-setup__nav">
              ${max > 0 ? html`<button type="button" class="bu-btn" onClick=${() => go(max - 1)}>${msg('setup.back')}</button>` : null}
              <button type="submit" form="setup-form" class="bu-btn bu-btn--primary" disabled=${!!busy} aria-busy=${busy === 'save' ? 'true' : undefined} aria-describedby=${error ? 'setup-erreur' : undefined}>
                ${msg(step === 'welcome' ? 'setup.start' : step === 'review' ? 'setup.save' : 'setup.next')}</button></div>`}</div>` : null} head=${html`
    <header class="ao-setup__top">
      <${Logo} kind="wordmark" class="ao-setup__logo" />
      <div class="ao-setup__prefs"><${LangSwitch} /><${ThemeSwitch} /></div>
    </header>
    <header class="ao-setup__head"><p class="bu-eyebrow">${msg('setup.eyebrow')}</p><h1 class="bu-title-lg" id="setup-titre">${msg('setup.title')}</h1></header>`}>
    ${loadError ? html`<div class="bu-card"><div class="bu-empty bu-empty--error"><p class="bu-empty__title">${msg('editorial.unavailable')}</p>
        <p class="bu-empty__text">${loadError.message}</p><button type="button" class="bu-btn" onClick=${load}><${Icon} name="refresh" />${msg('common.retry')}</button></div></div>`
      : !vm ? html`<div class="bu-card"><p class="bu-text-secondary" role="status">${msg('editorial.loading')}</p><${Skeleton} kind="title" /></div>`
      : closed ? html`<div class="bu-card"><div class="bu-empty">
          <h2 class="bu-empty__title ao-setup__h">${msg(vm.state === 'readonly' ? 'setup.readonly' : 'setup.locked')}</h2>
          <p class="bu-empty__text">${msg(vm.lockReason === 'missing-secrets' ? 'onboarding.secrets.missing' : vm.state === 'readonly' ? 'setup.readonly.text' : 'setup.locked.text')}</p>
          ${vm.state === 'locked' && !vm.lockReason ? html`<a class="bu-btn bu-btn--primary" href=${router.href('bureau')}>${msg('setup.open')}</a>` : null}</div></div>`
      : html`<div class="ao-setup__main">
        <nav class="bu-card ao-setup__steps" aria-label=${msg('setup.steps')}>
          <ol>${R.NUMBERED.map((name, k) => {
            const i = k + 1;
            const state = i < max ? 'done' : i === max ? 'current' : 'todo';
            return html`<li key=${name} class=${'ao-setup__step is-' + state}>
              ${i < max && step !== 'done' ? html`<a href=${'?' + new URLSearchParams({ ...Object.fromEntries(q), etape: String(i) })} onClick=${(e) => { e.preventDefault(); go(i); }}><span class="ao-setup__num">${String(i).padStart(2, '0')}</span>${msg('setup.step.' + name)}</a>`
                : html`<span aria-current=${i === max ? 'step' : undefined}><span class="ao-setup__num">${String(i).padStart(2, '0')}</span>${msg('setup.step.' + name)}${i < max ? html`<span class="bu-sr-only"> ${msg('setup.step.done')}</span>` : null}</span>`}</li>`;
          })}</ol>
        </nav>
        <form id="setup-form" class="bu-card ao-setup__body" onSubmit=${next} novalidate aria-labelledby="setup-etape">
          ${step !== 'welcome' && step !== 'done' ? html`<p class="bu-eyebrow">${msg('setup.stepOf', { n: max, total: R.NUMBERED.length })}</p>` : null}
          ${step === 'welcome' ? html`<${StateArt} slug="first-run" class="ao-setup__art" />`
            : step==='network' ? null : html`<img class="ao-setup__art" src=${assetUrl('bureau/assets/Illustrations/' + ART[step] + '.webp')} alt="" width="400" height="300" />`}
          <${Step} onAccessFooter=${setAccessFooter} step=${step} s=${s} vm=${vm} set=${set} setConn=${setConn} busy=${busy} check=${check} discover=${discover} detect=${detect} plan=${plan} apply=${apply} go=${go} max=${max}
            onUnavailableContinue=${()=>{set({accessStaged:true,accessDraft:{mode:'local'},accessLegacyFallback:true});go(R.STEPS.indexOf('review'));}} />
          ${error ? html`<p class="bu-field__error" role="alert" id="setup-erreur"><${Icon} name="alert" />${error}</p>` : null}
        </form>
        <aside class="bu-card bu-card--sunken ao-setup__note" aria-label=${msg('setup.margin')}>
          <p class="bu-card__title"><${Icon} name="info" />${msg('setup.margin')}</p>
          <p class="bu-caption bu-text-secondary">${msg('setup.margin.kept')}</p>
          <p class="bu-caption bu-text-secondary">${msg('setup.margin.secret')}</p>
        </aside>
      </div>`}
  </${Frame}></div>`;
}

function Field({ id, label, hint, children }) {
  return html`<div class="bu-field ao-setup__field"><label class="bu-field__label" for=${id}>${label}</label>${children}${hint ? html`<p class="bu-field__hint" id=${id + '-aide'}>${hint}</p>` : null}</div>`;
}

function Step({ step, s, vm, set, setConn, busy, check, discover, detect, plan, apply, go, max, onUnavailableContinue, onAccessFooter }) {
  switch (step) {
    case 'welcome': return html`<h2 class="bu-title ao-setup__h" id="setup-etape">${msg('onboarding.owner.head')}</h2>
      <p class="bu-text-secondary ao-setup__lede">${msg('onboarding.owner.text')}</p>
      ${s.resumePending ? html`<p role="status">${msg('onboarding.owner.resume')}</p>` : !s.ownerSaved ? html`      <${Field} id="setup-owner" label=${msg('setup.owner')}><input class="bu-input" id="setup-owner" maxlength="80" autocomplete="name" readOnly=${s.ownerSaved} value=${s.owner} onInput=${(e) => set({ owner: e.currentTarget.value })} /></${Field}>
      <${Field} id="setup-email" label=${msg('setup.email')} hint=${msg('setup.email.hint')}><input class="bu-input" id="setup-email" type="email" autocomplete="email" readOnly=${s.ownerSaved} value=${s.email}
        aria-describedby="setup-email-aide" onInput=${(e) => set({ email: e.currentTarget.value })} /></${Field}>
      <${Field} id="setup-password" label=${msg('setup.password')} hint=${msg(s.passwordSet ? 'setup.password.hintSet' : 'setup.password.hint')}>
        <input class="bu-input" id="setup-password" type="password" autocomplete="new-password" spellcheck="false" value=${s.password} aria-describedby="setup-password-aide"
          onInput=${(e) => set({ password: e.currentTarget.value })} /></${Field}>
      <${Field} id="setup-password2" label=${msg('setup.password2')}>
        <input class="bu-input" id="setup-password2" type="password" autocomplete="new-password" spellcheck="false" value=${s.password2}
          aria-invalid=${s.password2 && s.password2 !== s.password ? 'true' : undefined} onInput=${(e) => set({ password2: e.currentTarget.value })} /></${Field}>
` : html`<p role="status">${msg('onboarding.owner.saved')}</p><p>${s.owner} · ${s.email}</p><button class="bu-btn" type="button" onClick=${() => set({ ownerSaved: false })}>${msg('onboarding.owner.edit')}</button>`}
      <${Field} id="setup-code" label=${msg('setup.code')} hint=${msg('setup.code.hint')}>
        <input class="bu-input ao-setup__code" id="setup-code" autocomplete="off" autocapitalize="characters" spellcheck="false" value=${s.code}
          aria-describedby="setup-code-aide" onInput=${(e) => set({ code: e.currentTarget.value })} /></${Field}>`;
    case 'detection': return html`<${DetectionStep} s=${s} busy=${busy} detect=${detect} />`;
    case 'skills': return html`<${SkillsStep} s=${s} set=${set} busy=${busy} plan=${plan} apply=${apply} />`;
    case 'network': return html`<${ExternalAccessFlow} context="setup" onFooterChange=${onAccessFooter} setupCode=${s.code.trim()} onStaged=${draft => set({accessStaged:true,accessDraft:draft,accessLegacyFallback:false})} onUnavailableContinue=${onUnavailableContinue} onDone=${()=>go(max+1)} />`;
    case 'runtime': return html`<h2 class="bu-title ao-setup__h" id="setup-etape">${msg('setup.runtime.head')}</h2>
      <p class="bu-text-secondary ao-setup__lede">${msg('setup.runtime.text')}</p>
      <${Field} id="setup-adapter" label=${msg('setup.adapter')}>
        <select class="bu-select" id="setup-adapter" onChange=${(e) => { const a = vm.adapters.find((x) => x.id === e.currentTarget.value) || {};
          const detected = s.detections?.find(d => d.runtime === a.id);
          setConn({ adapter: a.id, fields: a.fields || [], gatewayUrl: detected?.connection?.gatewayUrl || a.defaultGatewayUrl || '', token: '' }); }}>
          ${!s.adapter ? html`<option value="" disabled selected>${msg('setup.err.adapter')}</option>` : null}
          ${vm.adapters.filter(a => a.connect !== false).map((a) => html`<option key=${a.id} value=${a.id} selected=${s.adapter === a.id}>${a.name}</option>`)}</select></${Field}>
      ${!R.takes(s, 'gatewayUrl') ? html`<p class="bu-text-secondary" id="setup-sans-passerelle">${msg('setup.adapter.noGateway')}</p>` : null}
      ${R.takes(s, 'gatewayUrl') ? html`<${Field} id="setup-url" label=${msg('setup.url')} hint=${msg('setup.url.hint')}>
        <input class="bu-input" id="setup-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" value=${s.gatewayUrl}
          placeholder=${(vm.adapters.find((a) => a.id === s.adapter) || {}).defaultGatewayUrl || 'ws://…'} aria-describedby="setup-url-aide"
          aria-invalid=${s.gatewayUrl && !R.validUrl(s.gatewayUrl) ? 'true' : undefined} onInput=${(e) => setConn({ gatewayUrl: e.currentTarget.value })} /></${Field}>` : null}
      ${R.takes(s, 'token') ? html`<${Field} id="setup-token" label=${msg('setup.token')} hint=${msg(s.detections?.find(d => d.runtime === s.adapter && d.connection?.gatewayUrl === s.gatewayUrl)?.connection?.tokenSet || vm.draft && vm.draft.runtime.tokenSet ? 'setup.token.hintSet' : 'setup.token.hint')}>
        <input class="bu-input" id="setup-token" type="password" autocomplete="off" spellcheck="false" value=${s.token} aria-describedby="setup-token-aide"
          onInput=${(e) => setConn({ token: e.currentTarget.value })} /></${Field}>` : null}`;
    case 'gateway': {
      const gateway = R.takes(s, 'gatewayUrl');
      const sentence = R.checkSentence(s.check, { gateway });
      return html`<h2 class="bu-title ao-setup__h" id="setup-etape">${msg('setup.gateway.head')}</h2>
        <p class="bu-text-secondary ao-setup__lede">${gateway ? msg('setup.gateway.text', { url: s.gatewayUrl.trim() }) : msg('setup.gateway.textNoGateway', { runtime: (vm.adapters.find((a) => a.id === s.adapter) || {}).name || s.adapter })}</p>
        <div class="ao-setup__status" role="status" aria-live="polite">
          ${busy === 'check' ? html`<span class="bu-spinner" aria-hidden="true"></span><span>${msg('setup.check.running')}</span>` : sentence ? html`<${Say} s=${sentence} />` : html`<span>${msg('setup.check.none')}</span>`}
        </div>
        ${s.check && !s.check.ok ? html`<p class="bu-text-secondary">${msg('setup.check.help.' + (s.check.status || 'failed'))}</p>` : null}
        <button type="button" class="bu-btn" onClick=${check} disabled=${busy === 'check'}><${Icon} name="refresh" />${msg(s.check ? 'setup.check.again' : 'setup.check.run')}</button>`;
    }
    case 'agents': return html`<h2 class="bu-title ao-setup__h" id="setup-etape">${msg('setup.agents.head')}</h2>
      <p class="bu-text-secondary ao-setup__lede">${msg('setup.agents.text')}</p>
      <div class="ao-setup__status" role="status" aria-live="polite">
        ${busy === 'discover' ? html`<span class="bu-spinner" aria-hidden="true"></span><span>${msg('setup.agents.running')}</span>`
          : s.agents ? html`<span>${msg('setup.agents.found', { n: s.agents.length })}</span>` : html`<span>${msg('setup.agents.none')}</span>`}
      </div>
      ${s.agents && s.agents.length ? html`<ul class="bu-list ao-setup__agents">${s.agents.map((a) => html`<li key=${a.id} class="bu-row">
          <span class="bu-avatar bu-avatar--agent" aria-hidden="true"><${Icon} name="agent" /></span>
          <span class="bu-row__main"><span class="bu-row__title"><label for=${'setup-agent-' + a.id}>${msg('onboarding.name.label', { id: a.id })}</label><input class="bu-input" id=${'setup-agent-' + a.id} maxlength="80" value=${a.name || ''} onInput=${e => set({ agents: s.agents.map(x => x.id === a.id ? { ...x, name: e.currentTarget.value } : x) })} />
            <span class="bu-caption">${msg(a.nameSource ? 'onboarding.name.source' : 'onboarding.name.missing', { source: a.nameSource })}</span>${a.isPrimary ? html` <span class="bu-chip bu-chip--sm bu-chip--accent">${msg('setup.agents.runtimePrimary')}</span>` : null}</span>
            <span class="bu-row__sub bu-mono-sm">${a.id}${a.model ? ' · ' + a.model : ''}</span>
            ${R.TAG_CHIP[a.projectTag] ? html`<span class="ao-setup__tag"><span class=${'bu-chip bu-chip--sm' + (R.TAG_CHIP[a.projectTag][0] ? ' bu-chip--' + R.TAG_CHIP[a.projectTag][0] : '')} data-project-tag=${a.projectTag}>${msg(R.TAG_CHIP[a.projectTag][1])}</span></span>` : null}</span></li>`)}</ul>` : null}
      ${s.agents && !s.agents.length ? html`<p class="ao-setup__warn">${msg('setup.agents.zero')}</p>` : null}
      <button type="button" class="bu-btn" onClick=${discover} disabled=${busy === 'discover'}><${Icon} name="refresh" />${msg(s.agents ? 'setup.agents.again' : 'setup.agents.run')}</button>`;
    case 'identities': return html`<h2 class="bu-title ao-setup__h" id="setup-etape">${msg('setup.ids.head')}</h2>
      <p class="bu-text-secondary ao-setup__lede">${msg('setup.ids.text')}</p>
      <${IdentitiesStep} manifest=${s.catalog} agents=${s.agents} value=${{ primary: s.primary, looks: s.looks }} onChange=${(v) => set({ primary: v.primary, looks: v.looks })} />`;
    case 'office': return html`<h2 class="bu-title ao-setup__h" id="setup-etape">${msg('setup.office.head')}</h2>
      <p class="bu-text-secondary ao-setup__lede">${msg('setup.office.text')}</p>
      <${Field} id="setup-name" label=${msg('setup.name')}><input class="bu-input" id="setup-name" maxlength="80" value=${s.name} onInput=${(e) => set({ name: e.currentTarget.value })} /></${Field}>
      <${Field} id="setup-lang" label=${msg('setup.locale')}>
        <select class="bu-select" id="setup-lang" onChange=${(e) => { set({ locale: e.currentTarget.value, skillPlan: null, skillResults: null }); chooseLang(e.currentTarget.value); }}>
          ${vm.locales.map((l) => html`<option key=${l} value=${l} selected=${s.locale === l}>${msg('lang.' + l)}</option>`)}</select></${Field}>
      <${Field} id="setup-zone" label=${msg('setup.zone')} hint=${msg('setup.zone.hint', { zone: vm.suggestedTimeZone })}>
        <input class="bu-input" id="setup-zone" list="setup-zones" autocomplete="off" value=${s.timeZone} aria-describedby="setup-zone-aide"
          aria-invalid=${s.timeZone && !R.validZone(s.timeZone) ? 'true' : undefined} onInput=${(e) => set({ timeZone: e.currentTarget.value })} />
        <datalist id="setup-zones">${zones.map((z) => html`<option key=${z} value=${z} />`)}</datalist></${Field}>`;
    case 'review': {
      const primary = (s.agents || []).find((a) => a.id === s.primary);
      const rows = [
        ['setup.step.runtime', [(vm.adapters.find((a) => a.id === s.adapter) || {}).name || s.adapter, R.takes(s, 'gatewayUrl') ? s.gatewayUrl.trim() : null].filter(Boolean).join(' · ')],
        ...(R.takes(s, 'token') ? [['setup.token', msg(s.token || s.detections?.find(d => d.runtime === s.adapter && d.connection?.gatewayUrl === s.gatewayUrl)?.connection?.tokenSet || (vm.draft && vm.draft.runtime.tokenSet) ? 'setup.review.tokenSet' : 'setup.review.tokenNone')]] : []),
        ['setup.review.primary', primary ? `${primary.name} (${primary.id})` : msg('editorial.notProvided')],
        ['setup.review.agents', msg('setup.agents.found', { n: (s.agents || []).length })],
        ['onboarding.review.looks', (s.agents || []).map(a => { const look = s.looks[a.id], c = [...(s.catalog?.characters || []), ...(s.catalog?.characterPacks?.packs || [])].find(c => c.id === look?.character); return a.name + ' : ' + (c?.names?.[s.locale] || c?.label || look?.character || '—'); }).join(', ')],
        ['setup.step.skills', (s.skillPlan?.agents || []).map(a => { const r = s.skillResults?.find(r => r.id === a.id); return ((s.agents || []).find(x => x.id === a.id)?.name || a.id) + ' : ' + msg('onboarding.skills.' + (r?.status || a.status)); }).join(', ') || msg('onboarding.skills.unsupported')],
        ['setup.name', s.name.trim()], ['setup.owner', s.owner.trim() || msg('editorial.notProvided')], ['setup.email', s.email.trim()],
        ['setup.password', msg(s.password || s.passwordSet ? 'setup.review.tokenSet' : 'setup.review.tokenNone')],
        ['onboarding.review.names', (s.agents || []).map(a => a.name).join(', ')],
        ['setup.step.network', msg(s.accessLegacyFallback?'access.localOnlyFallback':s.accessStaged ? 'access.staged' : 'access.title')],
        ['setup.locale', msg('lang.' + s.locale)], ['setup.zone', s.timeZone],
      ];
      return html`<h2 class="bu-title ao-setup__h" id="setup-etape">${msg('setup.review.head')}</h2>
        <p class="bu-text-secondary ao-setup__lede">${msg('setup.review.text')}</p>
        <dl class="bu-kv ao-setup__review">${rows.map(([k, v]) => html`<div key=${k} class="bu-kv__row"><dt>${msg(k)}</dt><dd>${v}</dd></div>`)}</dl>
        `;
    }
    case 'done': {
      const primary = (s.agents || []).find((a) => a.id === s.primary);
      const out = s.projetResult?.reason === 'reviewed' ? null : R.offersProjet(vm, s) ? R.projetOutcome(s.projetResult, primary && primary.projectTag) : null;   // nothing to say for a runtime it doesn't apply to
      return html`<h2 class="bu-title ao-setup__h" id="setup-etape">${msg('setup.done.head')}</h2>
      <p class="bu-text-secondary ao-setup__lede">${msg('setup.done.text')}</p><p class="bu-caption">${msg('onboarding.done.network')}</p>
      ${out ? html`<p class="ao-setup__tagresult" role="status" data-tag-result=${s.projetResult.status}>
        <span class=${'bu-chip bu-chip--sm' + (out.tone ? ' bu-chip--' + out.tone : '')}>${msg('setup.tag.chip.' + (out.key === 'setup.tag.result.already' ? 'already' : s.projetResult.status))}</span>
        <span>${msg(out.key, { agent: primary ? primary.name : s.primary || '' })}</span></p>` : null}`;
    }
    default: return html`<h2 class="bu-title ao-setup__h" id="setup-etape">${msg('setup.done.head')}</h2>
      <p class="bu-text-secondary ao-setup__lede">${msg('setup.done.text')}</p>`;
  }
}
