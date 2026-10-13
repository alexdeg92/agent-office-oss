import { loadModule, chunkError } from '../build-update.js';
// Public sign-in: a calm live office scene dissolving into one compact, accessible form.
import { html, useEffect, useRef, useState } from '../lib.js';
import { Frame, Icon } from '../components/ui.js';
import { Logo } from '../components/shell.js';
import * as api from '../api.js';
import { msg, getLang, agentName } from '../i18n.js';
import { config, buildQuery } from '../config.js';

const PREVIEW = [
  { id: 'main', role: 'main', character: 'fen', variant: 'clay', accessories: ['scarf'], station: 'sofa' },
  { id: 'subagent:a02', role: 'subagent', character: null, variant: null, accessories: [], station: null },
  { id: 'subagent:a03', role: 'subagent', character: 'filo', variant: 'teal', accessories: [], station: 'st-5' },
  { id: 'subagent:a04', role: 'subagent', character: 'cosmo', variant: 'sage', accessories: [], station: 'st-3' },
];
let bureauControls;
function loadBureauControls() {
  return bureauControls ??= loadModule(() => import('../components/bureau/index.js' + buildQuery)).then(async module => {
    await module.loadStyles();
    return module;
  });
}

function officeTheme() {
  const explicit = document.documentElement.dataset.theme;
  return explicit === 'dark' || (!explicit && !matchMedia('(prefers-color-scheme: light)').matches) ? 'night' : 'day';
}

function loadOfficeStyles() {
  const href = new URL('../office/office.css' + buildQuery, import.meta.url).href;
  const current = document.querySelector(`link[data-login-office="${CSS.escape(href)}"]`);
  if (current) return current.sheet ? Promise.resolve() : new Promise((resolve, reject) => {
    current.addEventListener('load', resolve, { once:true }); current.addEventListener('error', reject, { once:true });
  });
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = href; link.dataset.loginOffice = href;
    link.onload = resolve;
    link.onerror = () => { link.remove(); reject(chunkError(new Error('Login office stylesheet unavailable'))); };
    document.head.append(link);
  });
}

function OfficeBackdrop({ elementRef }) {
  useEffect(() => {
    let alive = true, scene = null, observer = null, frame = 0;
    const host = elementRef.current;
    const compose = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!alive || !scene) return;
        scene.fit();
        const mobile = innerWidth <= 820;
        scene.zoomBy(mobile ? 1.9 : 1.8);
        if (!mobile) scene.panBy(-40, 20);
      });
    };
    const updateTheme = () => scene?.setTheme(officeTheme());
    const start = async () => {
      await loadOfficeStyles();
      const [sceneModule, mockModule, manifestResponse, layoutResponse] = await Promise.all([
        loadModule(() => import('../office/scene.js' + buildQuery)),
        loadModule(() => import('../office/mock-office.js' + buildQuery)),
        api.getAsset('bureau/office/manifest.example.json'),
        api.getAsset('bureau/office/layout.example.json'),
      ]);
      const [manifest, baseLayout] = [manifestResponse, layoutResponse];
      const standard = baseLayout.agents.find(agent => agent.agentId === 'main' || agent.match?.kind === 'main');
      const previews = PREVIEW.map((agent,index) => index === 1 ? { ...agent, character:standard.character, station:standard.station } : agent);
      const layout = {
        ...baseLayout,
        agents: [
          ...previews.map(agent => ({ agentId:agent.id, character:agent.character, variant:agent.variant,
            accessories:agent.accessories, station:agent.station })),
          ...baseLayout.agents,
        ],
      };
      const mock = mockModule.createOfficeMock({ manifest, layout, scenario:'foule', mainName:agentName() });
      const occupants = mock.officeVM().occupants.slice(0, previews.length).map((occupant, index) => ({
        ...occupant,
        name: manifest.characterPacks.packs.concat(manifest.characters).find(c => c.id === previews[index].character)?.names?.[getLang()] ?? agentName(),
        state:'idle', destination:null, look:{ character:previews[index].character,
          variant:previews[index].variant, accessories:[...previews[index].accessories] },
      }));
      if (!alive) return;
      scene = new sceneModule.OfficeScene(host, {
        manifest, layout:baseLayout, assetBase:config.assetBase, theme:officeTheme(),
        surprisesEnabled:() => false,
      });
      scene.setPrimaryLabels(false);
      scene.controls.remove();
      await scene.setOccupants(occupants);
      if (!alive) { scene.destroy(); scene = null; return; }
      host.aoScene = scene;
      host.removeAttribute('tabindex'); host.removeAttribute('role');
      observer = new ResizeObserver(compose); observer.observe(host);
      const themeObserver = new MutationObserver(updateTheme);
      themeObserver.observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });
      const onPreference = () => { if (!document.documentElement.dataset.theme) updateTheme(); };
      const light = matchMedia('(prefers-color-scheme: light)');
      light.addEventListener('change', onPreference);
      host._loginThemeCleanup = () => { themeObserver.disconnect(); light.removeEventListener('change', onPreference); };
      await Promise.all([...host.querySelectorAll('img')].map(image => image.decode().catch(() => {})));
      if (!alive) return;
      compose(); host.dataset.sceneReady = 'true';
    };
    start().catch(error => { if (alive) { host.dataset.sceneError = 'true'; host.dispatchEvent(new CustomEvent('login-scene-error', { detail:error })); } });
    return () => {
      alive = false; cancelAnimationFrame(frame); observer?.disconnect(); host._loginThemeCleanup?.();
      if (scene) scene.destroy(); delete host.aoScene; delete host._loginThemeCleanup;
    };
  }, []);
  return null;
}

export function LoginPage({ onLoggedIn }) {
  const [controls, setControls] = useState(null);
  const [controlsError, setControlsError] = useState(false);
  const [controlAttempt, setControlAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    loadBureauControls().then(module => {
      if (!alive) return;
      // Controls load progressively. Preserve any values already entered into
      // the native fallback before replacing it with the shared controls.
      const form = document.querySelector('.bu-login__form');
      const focusedName = form?.contains(document.activeElement) ? document.activeElement.name : null;
      if (form) {
        const emailValue = form.elements.namedItem('email')?.value;
        const passwordValue = form.elements.namedItem('password')?.value;
        if (emailValue != null) setEmail(String(emailValue));
        if (passwordValue != null) setPassword(String(passwordValue));
      }
      setControls(module); setControlsError(false);
      if (focusedName) requestAnimationFrame(() => document.querySelector(`.bu-login__form [name="${CSS.escape(focusedName)}"]`)?.focus());
    })
      .catch(() => { if (alive) { setControls(null); setControlsError(true); } });
    return () => { alive = false; };
  }, [controlAttempt]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const scene = useRef(null);

  async function submit(event) {
    event.preventDefault();
    // Read the live controls at submission time. Password managers and browser
    // autofill may update the DOM without dispatching an input event, leaving
    // Preact's controlled value one step behind.
    const form = event.currentTarget;
    const emailValue = form.elements.namedItem('email')?.value || '';
    const passwordValue = form.elements.namedItem('password')?.value || '';
    // Keep browser-filled values stable across the busy/error rerenders too.
    setEmail(String(emailValue));
    setPassword(String(passwordValue));
    setBusy(true); setError(null);
    try {
      await api.login(String(emailValue).trim(), String(passwordValue));
      await onLoggedIn();
    } catch (err) {
      // Preserve the established auth contract: uniform bad-pair response and explicit throttle guidance.
      setError(err.code === 'unauthorized' ? msg('login.invalid')
        : err.code === 'rate_limited' && Number.isFinite(err.retryAfterSec) ? msg('login.tooMany', { n: err.retryAfterSec })
        : err.message);
      setBusy(false);
    }
  }

  const input = (id, label, type, name, autocomplete, value, onValueChange) => html`<${controls.Field} id=${id} label=${label} required
    control=${props => html`<${controls.TextInput} ...${props} type=${type} name=${name} autoComplete=${autocomplete} required
      value=${value} onValueChange=${onValueChange} busy=${busy} invalid=${Boolean(error)} describedBy=${error ? 'login-error' : undefined} />`} />`;
  const fallbackInput = (id, label, type, name, autocomplete, value, onValueChange) => html`<div class="bu-field bu-login__fallback-field">
    <label class="bu-field__label" for=${id}>${label} <span aria-hidden="true">*</span></label>
    <input class="bu-input" id=${id} name=${name} type=${type} autoComplete=${autocomplete} required value=${value}
      aria-invalid=${error ? 'true' : undefined} aria-describedby=${error ? 'login-error' : undefined} disabled=${busy}
      onInput=${event => onValueChange(event.currentTarget.value)} />
  </div>`;
  const submitButton = controls
    ? html`<${controls.Button} label=${msg('login.submit')} busyLabel=${msg('login.busy')} type="submit" variant="primary" size="lg" busy=${busy} />`
    : html`<button class="bu-btn bu-btn--primary bu-btn--lg bu-btn--block" type="submit" aria-busy=${busy ? 'true' : undefined} disabled=${busy}>${msg(busy ? 'login.busy' : 'login.submit')}</button>`;

  return html`<${Frame} tag="main" class="bu-login" bodyClass="ao-frame__body--framed">
    <div class="bu-login__scene" ref=${scene} aria-hidden="true" inert><${OfficeBackdrop} elementRef=${scene} /></div>
    <div class="bu-login__backing" aria-hidden="true"></div>
    <${Frame} tag="form" class="bu-login__form" bodyLabel=${msg('login.title')} onSubmit=${submit} novalidate
      head=${html`<div class="bu-login__brand"><${Logo} kind="mark" class="bu-login__mark" alt="Agent Office" /><h1>${msg('login.title')}</h1></div>`}
      foot=${html`${submitButton}
        <p class="bu-login__caption">${msg('login.sub')}</p>`}>
      ${controls ? input('login-email', msg('login.email'), 'email', 'email', 'username', email, setEmail) : fallbackInput('login-email', msg('login.email'), 'email', 'email', 'username', email, setEmail)}
      ${controls ? input('login-password', msg('login.password'), 'password', 'password', 'current-password', password, setPassword) : fallbackInput('login-password', msg('login.password'), 'password', 'password', 'current-password', password, setPassword)}
      ${controlsError ? html`<div class="bu-login__controls-error" role="status"><span>${msg('login.controlsUnavailable')}</span><button class="bu-btn bu-btn--ghost bu-btn--sm" type="button" onClick=${() => { bureauControls = null; setControlAttempt(n => n + 1); }}>${msg('common.retry')}</button></div>` : null}
      ${error ? html`<div class="bu-banner bu-banner--danger bu-login__error" id="login-error" role="alert"><${Icon} name="alert" /><span class="bu-banner__text">${error}</span></div>` : null}
    </${Frame}>
  </${Frame}>`;
}
