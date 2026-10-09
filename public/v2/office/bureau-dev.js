// Standalone harness for the Bureau page: the real page component on a fake stream fed by
// mock-office.js, until frontend wires the route and the mock API (see office-dev-03).
// Query: ?scenario=1|vide|panne  &tick=<ms>  &agent=<occupantId>  &steps=<n> (fast-forward the script)
//        &lang=en (UI language)  &conn=retrying (the stream is reconnecting: the cached sentence)
//        &api=3 (the mock speaks contract 3.0: primary, *scheduled, direct:…)  &lecture=1 (read-only instance: no store writes)  &nom=<name> (MetaVM.primaryAgent; empty: none)  &layout=404 (the server has no layout route yet, before S14b: the page uses the shipped layout)
import { html, render, useState, useEffect } from '../lib.js';
import { services } from '../services.js';
import * as i18n from '../i18n.js';
import { setMeta, agentName } from '../i18n.js';
import { createStore } from '../store.js';
import { config, configure, buildQuery } from '../config.js';
import * as fmt from '../fmt.js';
import { toApiError } from '../api.js';
import { Toasts } from '../components/ui.js';
import { META } from '../mock/meta.js';
import { BureauPage } from './page.js';
import { SPRITE } from '../icons.js';
import { createOfficeMock } from './mock-office.js';

const q = new URLSearchParams(location.search);
const dev = location.pathname.includes('/public/v2/office/');
const designBase = dev ? '../../../design/' : config.assetBase;
for (const href of dev ? ['css/bureau.css', 'components/bundle.css'] : ['bureau.css', 'bundle.css']) {
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = designBase + href + buildQuery;
  document.head.append(l);
}
const jsonBase = dev ? `${designBase}office/` : `${config.assetBase}office/`;
const [manifest, layout] = await Promise.all(['manifest', 'layout'].map((n) => fetch(`${jsonBase}${n}.example.json`).then((r) => r.json())));

// The harness simulates a server that sends MetaVM.primaryAgent (frontend's mock only does with ?agent=):
// ?nom=<name> picks the name, ?nom= (empty) sends none so the « l’agent » fallback can be checked.
const agentParam = q.get('nom');
// An explicit ?nom= wins over whatever the mock sends.
const primary = agentParam === '' ? null : agentParam ? { id: 'main', name: agentParam, avatarUrl: null } : (META.primaryAgent ?? { id: 'main', name: 'Orion', avatarUrl: null });
setMeta({ ...META, primaryAgent: primary });
// ?api=3: the client speaks contract 3.0 too (config.apiVersion), like a v3 deployment.
if (q.get('api') === '3') configure({ basePath: config.basePath, apiBase: config.apiBase, apiVersion: 3 });
if (q.get('lang')) {
  if (typeof i18n.setLang === 'function') i18n.setLang(q.get('lang')); else fmt.setLocale(q.get('lang') === 'en' ? 'en-CA' : 'fr-CA');
  document.documentElement.lang = q.get('lang') === 'en' ? 'en' : 'fr';
}
if (q.get('theme')) document.documentElement.dataset.theme = q.get('theme');
document.body.insertAdjacentHTML('afterbegin', SPRITE);
// The primary agent's name comes from MetaVM.primaryAgent (frontend's i18n.agentName, fallback « l’agent »).
// The occupant's name is runtime data: the primary agent's name when the server knows it, else the raw id (the page falls back).
const om = createOfficeMock({ manifest, layout, scenario: q.get('scenario') ?? '1', mainName: primary ? primary.name : 'main', timeZone: fmt.timeZone(), version: q.get('api') === '3' ? 3 : 2 });
for (let i = 0; i < Number(q.get('steps') ?? 0); i++) om.tick();

// ---- fake stream: topic → setter; every tick rebuilds the VMs (the real mock diffs them into deltas) ----
const subs = new Map();
const subscribed = new Set();   // every topic the page asked for (tests: no `layout` topic before S14b)
async function publish(topic) {
  const set = subs.get(topic);
  if (!set) return;
  const data = topic === 'office' ? await om.officeVM() : await om.layoutVM();
  set({ data, loading: false, error: null });
}
services.stream = {
  status: createStore({ conn: q.get('conn') ?? 'open', gateway: null, capabilities: q.get('lecture') ? { openclawWrites: false, storeWrites: false } : null, lastFrameAt: q.get('conn') ? Date.now() - 95_000 : null, topicsOk: true }),
  subscribe(topic, url, set) { subscribed.add(topic); subs.set(topic, set); publish(topic); return () => subs.delete(topic); },
  retry(topic) { publish(topic); },
};
const wrap = (fn) => async (...a) => {
  try { return await fn(...a); } catch (e) { throw e?.status ? toApiError(e.status, { error: e.error }) : e; }
};
services.officeApi = {
  get: wrap(() => (q.get('layout') === '404' ? Promise.reject({ status: 404, error: { code: 'not_found', message: 'Introuvable.' } }) : om.layoutVM())),
  getRevision: wrap((rev) => om.getRevision(rev)),
  put: wrap(async (body) => { const r = await om.putLayout(body); publish('layout'); publish('office'); return r; }),
  putTheme: wrap(async (body) => { const r = await om.putTheme(body); publish('layout'); return r; }),
};
services.officeAssetBase = designBase;
services.cueListeners ??= new Set();
setInterval(async () => {
  const cues = om.tick();
  await publish('office');
  await publish('layout');   // the seen inventory changes as agents leave (architect-41: the layout topic is invalidated)
  for (const f of cues) for (const fn of services.cueListeners) fn(f);
}, Number(q.get('tick') ?? 3000));

// ---- minimal router: query in the URL, href for links ----
function useMatch() {
  const [m, set] = useState(() => ({ name: 'bureau', params: {}, query: Object.fromEntries(new URLSearchParams(location.search)) }));
  useEffect(() => {
    services.router = {
      href: (name, params = {}) => `#${name}${params.sessionKey ? ':' + params.sessionKey : ''}`,
      setQuery(patch) {
        const qs = new URLSearchParams(location.search);
        for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') qs.delete(k); else qs.set(k, String(v)); }
        history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : ''));
        set({ name: 'bureau', params: {}, query: Object.fromEntries(qs) });
      },
    };
  }, []);
  return m;
}
services.router = { href: () => '#', setQuery: () => {} };

function Dev() {
  const match = useMatch();
  return html`<${BureauPage} match=${match} /><${Toasts} />`;
}
render(html`<${Dev} />`, document.getElementById('app'));
// Tests wait on conditions, never on the clock: until(cond) resolves with cond()'s first truthy value and rejects
// (naming the condition) after `ms`, so a slow full-suite run only takes longer, it doesn't flake.
const until = (cond, ms = 30_000) => new Promise((resolve, reject) => {
  const t0 = performance.now();
  const step = () => {
    let v; try { v = cond(); } catch { v = null; }
    if (v) return resolve(v);
    if (performance.now() - t0 > ms) return reject(new Error(`until: timed out on ${cond}`));
    setTimeout(step, 10);
  };
  step();
});
window.officeBench = { om, services, publish, until, subscribed };

// Explicit opt-in QA controls. Calls the real lifecycle, including work guards and A* walking.
if (q.get('life') === '1') {
  const { mountAnimationControls } = await import('./animation-tools.js' + buildQuery);
  await until(() => document.querySelector('.ao-bureau__stage')?.aoScene);
  const scene = document.querySelector('.ao-bureau__stage').aoScene;
  mountAnimationControls(scene, document.getElementById('app'), { weather:q.get('weather')??undefined });
  window.officeLife = { scene, interact: (...a)=>scene.interact(...a), react: (...a)=>scene.react(...a), surprise:(...a)=>scene.surprise(...a), theme:t=>scene.setTheme(t), weather:w=>{const c=[...scene.chars.values()].find(c=>c.egg?.controller?.room);if(c)c.egg.controller.room.root.dataset.weather=w;} };
}
