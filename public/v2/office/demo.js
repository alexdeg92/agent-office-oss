import {mockPalette} from '../mock/palette.js';
// Standalone demo: mock OfficeVM.occupants driving the scene (no API needed).
// Query params: ?theme=auto|day|night  &reduced=1  &scenario=mix|all  &assets=<base>  &select=<id>
import { OfficeScene } from './scene.js';
import { STATES, STATE_LABELS } from './states.js';
import { resolveTheme } from './theme.js';
import { indexManifest } from './assets.js';
import { resolveOccupants, validateLayout } from './layout-rules.js';
import { createMockLayoutStore } from './mock-store.js';
import { openEditor } from './editor.js';
import { config, buildQuery } from '../config.js';
import * as fmt from '../fmt.js';

const q = new URLSearchParams(location.search);
// Dev (static server at the repo root, page at /public/v2/office/demo.html): read design/ directly.
// App (<basePath>office/demo.html): Bureau CSS and assets come from config.assetBase (scripts/sync-design.js).
const dev = location.pathname.includes('/public/v2/office/');
const designBase = q.get('assets') ?? (dev ? '../../../design/' : config.assetBase);
const css = dev ? ['css/bureau.css', 'components/bundle.css'] : ['bureau.css', 'bundle.css'];
for (const href of css.reverse()) {
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = designBase + href + buildQuery;
  document.head.prepend(l);
}
const jsonBase = dev ? `${designBase}office/` : `${config.assetBase}office/`;
let [manifest, layout] = await Promise.all(
  ['manifest.example.json', 'layout.example.json'].map((f) => fetch(jsonBase + f).then((r) => r.json())),
);


// ---- mock occupants: the sources the server sees; names, looks and desks are resolved from the
// layout with layout-rules.js, the algorithm the server uses for OfficeVM (api-proposal.md §2).
const index = indexManifest(manifest);
const NAMES = ['Scout', 'Plume', 'Atlas', 'Écho', 'Nova', 'Pixel', 'Orion'];
let seq = 0;
const t0 = Date.now();
// Mock data: the primary agent's discovered name (data, not a code literal of the product).
const occupants = [{ id: 'main', role: 'main', sourceName: 'Timmy', state: 'working', stateSince: t0 }];
function addSub(state = 'working') {
  const n = seq++;
  const o = { id: `subagent:${n}`, role: 'subagent', sourceName: NAMES[n % NAMES.length], state, stateSince: Date.now() };
  occupants.push(o);
  return o;
}
const resolved = () => {
  const r = resolveOccupants(layout, index, occupants);
  return occupants.map((o, i) => ({ ...o, ...r[i] }));
};

const scenario = q.get('scenario') ?? 'mix';
if (scenario === 'mix') {
  addSub('thinking'); addSub('waiting'); addSub('error');
} else if (scenario === 'all') {
  occupants[0].state = 'working';
  ['thinking', 'researching', 'writing', 'calling', 'waiting'].forEach((s) => addSub(s));
}

// ---- scene ----
const stage = document.getElementById('stage');
const roster = document.getElementById('roster');
let themeMode = q.get('theme') ?? 'auto';
const scene = new OfficeScene(stage, {
  manifest, layout, assetBase: designBase, theme: themeMode, timeZone: () => fmt.timeZone(),
  onSelect: (id) => { renderRoster(); renderDrawer(id); },
});
if (q.get('debug') === 'landmarks') { scene.setDebugLandmarks(true); document.getElementById('landmarks').checked = true; }
document.getElementById('landmarks').addEventListener('change', (e) => scene.setDebugLandmarks(e.target.checked));
document.getElementById('legacy').checked = scene.legacyAccessories;   // follows manifest.accessoriesV2.complete
document.getElementById('legacy').addEventListener('change', (e) => scene.setLegacyAccessories(e.target.checked));
if (q.get('legacy') === '0') { scene.setLegacyAccessories(false); document.getElementById('legacy').checked = false; }
if (q.get('reduced') === '1') { scene.setReducedMotion(true); document.getElementById('reduced').checked = true; }
const push = () => {
  if (editor) { editor.apply(); renderRoster(); return; }   // the editor previews its draft
  scene.setOccupants(resolved());
  renderRoster();
};
let editor = null;
push();
if (q.get('select')) scene.select(q.get('select'));

// ---- controls ----
function renderRoster() {
  const view = new Map(resolved().map((r) => [r.id, r]));
  roster.replaceChildren(...occupants.map((o) => {
    const v = view.get(o.id);
    const row = document.createElement('div');
    row.className = 'demo__row';
    row.setAttribute('role', 'listitem');
    if (scene.selected === o.id) row.setAttribute('aria-current', 'true');
    const name = document.createElement('span');
    name.className = 'demo__name';
    const dot = document.createElement('span');
    dot.className = 'ao-dot';
    dot.style.setProperty('--_s', `var(--bu-state-${STATES.includes(o.state) ? o.state : 'idle'})`);
    name.append(dot);
    name.append(v.name);
    if (!v.stationUid) { const s = document.createElement('small'); s.textContent = ' · sans poste'; name.append(s); }
    const cel = button('Célébrer', () => scene.cue(o.id, 'celebrating'));
    const rm = o.role === 'main' ? document.createElement('span') : button('Retirer', () => { occupants.splice(occupants.indexOf(o), 1); push(); });
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `État de ${v.name}`);
    for (const s of STATES) sel.add(new Option(STATE_LABELS[s], s, false, s === o.state));
    sel.addEventListener('change', () => { o.state = sel.value; o.stateSince = Date.now(); push(); });
    row.append(name, cel, rm, sel);
    return row;
  }));
}
function button(label, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'bu-btn bu-btn--sm';
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}
function renderDrawer(id) {
  const o = resolved().find((x) => x.id === id);
  const d = document.getElementById('drawer');
  d.innerHTML = '<h2>Agent sélectionné</h2>';
  if (!o) return;
  // DOM text only (review R4: no raw interpolation of names, states or stations).
  const p = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = o.name;
  const role = o.roleLabel.key === 'custom' ? o.roleLabel.params.text : o.role === 'main' ? 'Agent principal' : 'Sous-agent';
  p.append(strong, ` · ${role}`, document.createElement('br'), `État : ${STATE_LABELS[o.state]}`, document.createElement('br'), `Poste : ${o.stationUid ?? 'aucun (zone debout)'}`);
  d.append(p);
}

document.getElementById('add').addEventListener('click', () => { addSub('working'); push(); });
document.getElementById('delegate').addEventListener('click', () => {
  scene.cue('main', 'delegating');
  addSub('working');
  push();
});
document.getElementById('tour').addEventListener('click', () => {
  let i = 0;
  const step = () => {
    if (i >= STATES.length) return;
    occupants.forEach((o, k) => { o.state = STATES[(i + k) % STATES.length]; });
    push();
    i++;
    setTimeout(step, 1800);
  };
  step();
});
document.getElementById('reduced').addEventListener('change', (e) => scene.setReducedMotion(e.target.checked ? true : null));
document.getElementById('ui-theme').addEventListener('click', () => {
  const r = document.documentElement;
  r.dataset.theme = r.dataset.theme === 'dark' ? 'light' : 'dark';
});
const themeBtns = [...document.querySelectorAll('[data-theme-mode]')];
function syncTheme() {
  for (const b of themeBtns) b.setAttribute('aria-pressed', String(b.dataset.themeMode === themeMode));
  const now = resolveTheme(themeMode === 'auto' ? { ...layout.theme, mode: 'auto' } : themeMode, new Date(), fmt.timeZone());
  document.getElementById('theme-meta').textContent = themeMode === 'auto'
    ? `Automatique : nuit de ${layout.theme.nightFrom} à ${layout.theme.nightTo} (heure de l’instance, ${fmt.timeZone()}). En ce moment : ${now === 'night' ? 'Nuit' : 'Jour'}.`
    : '';
}
for (const b of themeBtns) b.addEventListener('click', () => { themeMode = b.dataset.themeMode; scene.setTheme(themeMode); syncTheme(); });
syncTheme();

// ---- customization editor (O2) on the mock layout API ----
const store = createMockLayoutStore({
  data: layout, defaultData: structuredClone(layout), manifest, timeZone: fmt.timeZone(),
  validate: (d) => validateLayout(d, index),
  agentsSeen: [{ id: 'subagent:archiviste', role: 'subagent', name: 'Archiviste', lastSeenAt: Date.now() - 3 * 86_400_000 }],
});
const toastBox = document.getElementById('toasts');
function toast(message, level = 'success') {
  const t = document.createElement('div');
  t.className = `bu-toast bu-toast--${level}`;
  t.innerHTML = '<span class="bu-toast__text"></span>';
  t.firstChild.textContent = message;
  toastBox.append(t);
  setTimeout(() => t.remove(), 3500);
}
const editBtn = scene.addControl({ label: 'Personnaliser', text: true, icon: '<path d="M12 20h9"/><path d="M16.38 3.62a1 1 0 0 1 3 3L7.37 18.64a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z"/>', onClick: () => startEditing() });
async function startEditing(mode) {
  if (editor) return;
  document.getElementById('demoside').hidden = true;
  document.getElementById('editaside').hidden = false;
  document.getElementById('editdemo').hidden = false;
  editBtn.hidden = true;
  editor = await openEditor({
    scene, store, getPaletteVM:mockPalette, assetBase: designBase, toast, timeZone: fmt.timeZone(),
    barHost: document.getElementById('editbar'), asideHost: document.getElementById('editaside'),
    getOccupants: () => occupants,
    onExit: ({ saved, layout: next }) => {
      editor = null;
      if (saved) layout = next;
      document.getElementById('demoside').hidden = false;
      document.getElementById('editaside').hidden = true;
      document.getElementById('editdemo').hidden = true;
      editBtn.hidden = false;
      scene.setLayout(layout);
      scene.setTheme(themeMode);
      push();
      editBtn.focus();
    },
  });
  if (mode) editor.setMode(mode);
}
document.getElementById('external').addEventListener('click', () => {
  const r = store.externalEdit((d) => { d.theme = { ...d.theme, mode: 'fixed', fixed: 'night' }; });
  toast(`Version ${r.revision} enregistrée sur un autre appareil.`, 'warning');
});
if (q.get('edit')) startEditing(q.get('edit') === '1' ? null : q.get('edit'));

window.officeDemo = { scene, occupants, push, addSub, store, get editor() { return editor; }, startEditing };
