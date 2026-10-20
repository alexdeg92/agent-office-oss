import { loadModule } from '../build-update.js';
import { buildQuery } from '../config.js';
// In-browser mock of API v2 (used with ?mock=… or while /api/v2 answers 404). It speaks the exact
// api.md shapes: envelopes, the error format, and an SSE-like source with hello/snapshot/delta/system frames.
// Scenarios (?mock=<name>): 1 (normal), vide (empty collections), lent (slow first load),
// erreur (views fail with upstream_unavailable), panne (gateway down), conflit (every project move answers 409).
// Contract 3.0 (G5): with config.apiVersion 3 the same mock answers /api/v3 (and v3 topics) through mock/v3.js.
import { assetUrl, config } from '../config.js';
import * as v3 from './v3.js';
import { schemaForPath, schemaForTopic } from '../vmcheck.js';
import { META, PROPOSED_AGENT } from './meta.js';
import { fr as storeLabels } from '../office/store-labels.js';
Object.assign(META.labels,storeLabels);
import { buildHealth, withIssue } from './health.js';
import { diff } from './diff.js';
import * as projects from './projects.js';
import { seedCandidates, importCandidates, candidatesVM } from './candidates.js';
import { createLogs } from './logs.js';
import { createSkills } from './skills.js';
import { createFlows } from './flows.js';
import { createAccess } from './access.js';
import { createChat } from './chat.js';
import { createSetup } from './setup.js';
import { createExternalAccessMock } from './external-access.js';
import { createOfficeMock } from '../office/mock-office.js';

let scenario = '1';
let standalone = true;
// Mock session: survives reloads within the tab (sessionStorage), logged in by default.
const SESSION_KEY = 'ao.mock.loggedOut';
let loggedIn = (() => { try { return sessionStorage.getItem(SESSION_KEY) !== '1'; } catch { return true; } })();
function setLoggedIn(v) { loggedIn = v; try { if (v) sessionStorage.removeItem(SESSION_KEY); else sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* memory only */ } }
const TICK_MS = 3000;

export function configure(opts) {
  settingsDb=null;chatV3Db=null;chatV3Flight=null;
  externalAccessDb={};
  scenario = opts.scenario || '1';
  standalone = !!opts.standalone;
  // ?agent=<name>: another instance's agent name (platform direction: the UI must never assume « Timmy »).
  const agent = globalThis.location && new URLSearchParams(location.search).get('agent');
  if (agent) { META.primaryAgent = { ...PROPOSED_AGENT, name: agent, avatarUrl: null }; const person = projects.PERSONS.get('per_timmy'); person.name = agent; person.avatarUrl = null; }
  // ?mock=installation: a first run (F8). MetaVM.instance.configured === false (proposed, frontend-11) until the mock
  // setup is saved; the completion survives a reload within the tab (sessionStorage, mock only).
  if (scenario === 'installation') {
    let done = false;
    try { done = sessionStorage.getItem('ao.mock.configured') === '1'; } catch { /* no storage */ }
    if (!done) { META.instance = { ...META.instance, configured: false }; META.primaryAgent = null; }
  }
  // ?fuseau=<IANA>: another instance's time zone (R12-08: nothing assumes the installation's zone).
  const zone = globalThis.location && new URLSearchParams(location.search).get('fuseau');
  if (zone) META.instance = { ...META.instance, timeZone: zone };
  // ?lecture=1: behave like staging (PORTAL_READONLY): OpenClaw writes are refused with 403 readonly.
  if (globalThis.location && new URLSearchParams(location.search).has('lecture')) {
    // ?lecture=tout: the store too (PORTAL_READONLY_STORE): projects and the issue mute are refused as well.
    META.capabilities = { ...META.capabilities, openclawWrites: false, storeWrites: new URLSearchParams(location.search).get('lecture') !== 'tout' };
    META.readonly = true;
  }
}
const READONLY = () => fail(403, 'readonly', 'Instance de test : actions désactivées.');
export const isStandalone = () => standalone;

// ---- auth (standalone only: a static server has no /api/login) ----
export function me() { return loggedIn ? { email: 'Owner@example.invalid', displayName: 'Owner', gwConnected: scenario !== 'panne' } : null; }
export async function login(email, password) {
  await sleep(400);
  if (!email || !password || password.length < 4) {
    const err = { status: 401, body: { error: { code: 'unauthorized', message: 'Identifiants invalides. Vérifiez le courriel et le mot de passe.', requestId: rid() } } };
    const { toApiError } = await loadModule(() => import('../api.js' + buildQuery));
    throw toApiError(err.status, err.body);
  }
  setLoggedIn(true);
  return { ok: true, email };
}
export async function logout() {
  // Test hook (?mock=…&echec-deconnexion=1): the logout request never reaches the server (R4-11).
  if (globalThis.location && new URLSearchParams(location.search).has('echec-deconnexion')) {
    const { ApiError } = await loadModule(() => import('../api.js' + buildQuery));
    throw new ApiError({ code: 'network', message: 'Le serveur ne répond pas. Vérifiez la connexion, puis réessayez.' });
  }
  setLoggedIn(false);
  return { ok: true };
}

// ---- view models: one current copy per topic, diffed into deltas on change ----
let tick = 0;
const vms = new Map();     // topic → last VM sent
const revs = new Map();    // topic → rev
let db = null;             // projects store (in memory, reset on reload)
const projectsDb = () => {
  if (db) return db;
  db = scenario === 'vide' ? { projects: new Map(), history: new Map() } : projects.seed();
  if (globalThis.location && new URLSearchParams(location.search).has('commentaires-pages') && scenario !== 'vide') {
    for (let i = 0; i < 55; i++) projects.commentCommand(db, 'POST', 'prj_portail', null, { body: 'Suivi de discussion ' + i });
  }
  if (globalThis.location && new URLSearchParams(location.search).has('historique-pages') && scenario !== 'vide') {
    const history = db.history.get('prj_portail'), oldest = history.at(-1);
    for (let i = 1; i <= 55; i++) history.push({ ...oldest, id: 'history-page-' + i, at: oldest.at - i * 1000 });
  }
  const delivery = globalThis.location && new URLSearchParams(location.search).get('livraison');
  if (['failed','no-reply','working'].includes(delivery)) {
    const id='prj_portail';
    const comment=projects.commentCommand(db,'POST',id,null,{body:'@main Reprends le suivi.'}).comment;
    const event=projects.requestSummary(db,id,{expectedRevision:projects.buildProjectVM(db,id).revision}).comment;
    for(const c of [comment,event]) c.delivery[0].status=delivery;
  }
  return db;
};
let candidates = null;      // discovery candidates (« Importer des projets »)
const importedKeys = new Set();
let logs = null;            // Journaux sessions and transcripts
const logsDb = () => logs || (logs = createLogs(Date.now(), { empty: scenario === 'vide' }));
let skills = null;          // Compétences
const skillsDb = () => skills || (skills = createSkills());
let flows = null, access = null;  // Flux de travail, Habilitations
const flowsDb = () => flows || (flows = createFlows());
const accessDb = () => access || (access = createAccess());
let setup = null;           // first-run setup (?installation=<hook> picks a scenario)
const setupDb = () => setup || (setup = createSetup({ hook: globalThis.location ? new URLSearchParams(location.search).get('installation') : null }));
let chat = null;            // Discuter (?echec-chat=1: every turn fails like a CLI timeout)
const chatDb = () => chat || (chat = createChat(Date.now(), { full: !!(globalThis.location && new URLSearchParams(location.search).has('chat-plein')), empty: scenario === 'vide', failTurns: !!(globalThis.location && new URLSearchParams(location.search).has('echec-chat')) }));
const flowTopics = (ids) => (t) => t === 'flows' || ids.some((id) => t === 'flow:' + encodeURIComponent(id));
let lastRestartAt = -Infinity;
// Bureau (office-dev-03 §5): built lazily from the office examples served under <basePath>bureau/office/.
let om = null, omPromise = null;
function officeMock() {
  if (!omPromise) {
    const get = (f,base='bureau/office/') => fetch(new URL(assetUrl(base + f), globalThis.location ? location.origin : 'http://localhost')).then((r) => r.json());
    omPromise = Promise.all([get('manifest.example.json'), get('layout.example.json'),get('office-floors.json','mock/examples/')])
      .then(([manifest, layout,floorDefaults]) => (om = createOfficeMock({ manifest, layout,floorDefaults, scenario, version: config.apiVersion })));   // office-dev-14: D3/D4 in the configured contract
  }
  return omPromise;
}
/** Office errors are thrown as {status, error}; map them to an HTTP-like answer. */
async function officeCall(fn) {
  try { return await fn(); } catch (e) { if (e && e.status && e.error) return { status: e.status, body: { error: { requestId: rid(), ...e.error } } }; throw e; }
}
const candidateList = () => candidates || (candidates = seedCandidates());

function healthVM() {
  if (!vms.has('health')) {
    const now = Date.now();
    let health = buildHealth(scenario, now, tick);
    // Explicit synthetic failure state for the terminal transcript-repair browser evidence.
    // It contains no filesystem path or transcript/session identifier.
    if (scenario === 'transcript-terminal') health = { ...health,
      healthChecks: [{ id: 'claude-code|transcript-scan', adapter: 'claude-code', severity: 'error', causeCode: 'format',
        textKey: 'healthCheck.transcript.format', impactKey: 'healthImpact.transcripts', remedy: 'none', active: true,
        actionId: null, guidedPath: null, target: 'transcript', changedAt: now, resolvedAt: null }],
      healthAudit: [{ checkId: 'claude-code|transcript-scan', actionId: 'rescan', at: now, outcome: 'failed', attempts: 3 }] };
    vms.set('health', health); revs.set('health', 1);
  }
  return vms.get('health');
}
const BOARD_FILTERS = ['all', 'at-risk', 'with-timmy'];
const boardTopic = (filter) => (filter === 'all' ? 'projects' : `projects?filter=${filter}`);

/** Builds the current VM of a topic, or undefined when the topic is unknown. */
/** A topic's VM in the configured contract: v3 topics name 3.0 query values (D2 kind, D8 filter + agent). */
function build(topic) {
  // Projects pins its transport to v3 even while the rest of the UI still uses the
  // configured contract. Its topic snapshots must match the same v3 VM as its GET.
  if (config.apiVersion !== 3 && !/^projects(?:\?|$)/.test(topic)) return build2(topic);
  const [base, query = ''] = topic.split(/\?(.*)/s);
  const t = v3.queryTo2x(query);
  let vm = build2(base + (t.query.toString() ? '?' + t.query : ''));
  const name = schemaForTopic(topic);
  if (vm === undefined || !name) return vm;
  vm = v3.project(name, vm, { primaryId: META.primaryAgent && META.primaryAgent.id, query:t.query });
  if (name === 'logs' && t.internalOnly) vm = { ...vm, items: vm.items.filter((i) => i.kind === 'internal') };
  if (name === 'projects' && t.agent) vm = { ...vm, agent: t.agent };
  return vm;
}
function build2(topic) {
  if (topic === 'health') return healthVM();
  const board = /^projects(?:\?(.*))?$/.exec(topic);
  if (board) {
    const q = new URLSearchParams(board[1] || ''), filter = q.get('filter') || 'all';
    if (!BOARD_FILTERS.includes(filter)) return undefined;
    return projects.buildBoardVM(projectsDb(), filter, { search:q.get('search') || '', source:q.get('source') || null, stage:q.get('stage') || 'all' });
  }
  const cm = /^comments:(.+)$/.exec(topic);
  if (cm) return projects.buildCommentsVM(projectsDb(), decodeURIComponent(cm[1]), { canComment: META.capabilities.storeWrites, canMention: META.capabilities.storeWrites && META.capabilities.openclawWrites && META.runtime.capabilities?.projectComments !== false }) || undefined;
  const pr = /^project:(.+)$/.exec(topic);
  if (pr) return projects.buildProjectVM(projectsDb(), pr[1]) || undefined;
  if (topic === 'office') return om ? om.officeVM() : undefined;
  if (topic === 'layout' || topic.startsWith('layout?floorId=')) return om ? om.layoutVM(new URLSearchParams(topic.split('?')[1]).get('floorId')) : undefined;
  if (topic === 'flows') return scenario === 'vide' ? { flows: [], counts: { total: 0, enabled: 0 } } : flowsDb().list();
  const fl = /^flow:(.+)$/.exec(topic);
  if (fl) return flowsDb().detail(decodeURIComponent(fl[1])) || undefined;
  if (topic === 'access') return scenario === 'vide' ? { agents: [], interlocutors: [], policy: { dm: null, group: null, channelsEnabled: 0, channelsTotal: 0, execSecurity: null } } : accessDb().access();
  const il = /^interlocutor:(.+)$/.exec(topic);
  if (il) return accessDb().interlocutor(decodeURIComponent(il[1])) || undefined;
  if (topic === 'skills') return scenario === 'vide' ? { skills: [], counts: { total: 0, active: 0 } } : skillsDb().list();
  const sk = /^skill:(.+)$/.exec(topic);
  if (sk) return skillsDb().detail(decodeURIComponent(sk[1])) || undefined;
  if (topic === 'logs' || topic.startsWith('logs?')) {
    const q = new URLSearchParams(topic.slice(5));
    for (const k of q.keys()) if (!['kind', 'heartbeat', 'connector', 'agent'].includes(k)) return undefined;
    return logsDb().page(q.get('kind'), null, undefined, { heartbeats: q.get('heartbeat') === 'include', connector: q.get('connector'), agent: q.get('agent') });
  }
  if (/^chat-(?:agents|agent-sessions|session)(?::|$)/.test(topic)) return chatV3Db?.build(topic);
  if (topic === 'chat') return chatDb().vm();
  const se = /^session:(.+)$/.exec(topic);
  if (se) { const key=decodeURIComponent(se[1]); const vm=logsDb().session(key) || (key.includes(':ao-projet-') ? logsDb().session('agent:main:main') : null); return vm ? {...vm,key} : undefined; }
  return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => 'req_' + Math.random().toString(36).slice(2, 10);
const staleSources = () => (scenario === 'erreur' || scenario === 'vide' ? [] : healthVM().sources.filter((x) => x.state !== 'fresh').map((x) => x.id));
/** Ok<T> envelope (api.md 2.0 §2.1); `topic` for reads that back an SSE topic. */
const ok = (data, topic) => ({ status: 200, body: { data, meta: { modelVersion: META.modelVersion, generatedAt: Date.now(), stale: staleSources(), ...(topic ? { topic: { id: topic, rev: revs.get(topic) } } : {}) } } });
const cmd = (result = null, revision = null, vm = null, status = 200) => ({ status, body: { data: { ok: true, result, revision, vm }, meta: { modelVersion: META.modelVersion, generatedAt: Date.now(), stale: staleSources() } } });
/** Current VM of a topic for a GET: rebuilt, published if it changed, returned with its revision. */
function read(topic) { const vm = build(topic); if (vm === undefined) return undefined; publish(topic, vm); return ok(vms.get(topic), topic); }
const fail = (status, code, message, details) => ({ status, body: { error: { code, message, ...(details ? { details } : {}), requestId: rid() } } });

async function viewDelay() {
  await sleep(scenario === 'lent' ? 86_400_000 : 250);
  return scenario === 'erreur' ? fail(503, 'upstream_unavailable', 'La passerelle OpenClaw est injoignable. Réessayez dans un instant.') : null;
}

const LOG_KINDS_2X = ['main', 'cron', 'chat-direct', 'chat-group', 'dashboard', 'acp', 'explicit'];
let chatV3Db,chatV3Flight;
async function chatV3Mock(){
 if(!chatV3Db)chatV3Flight ||= loadModule(()=>import('./chat-v3.js'+buildQuery)).then(module=>chatV3Db=module.createChatV3Mock({scenario,slow:!!(globalThis.location&&new URLSearchParams(location.search).has('chat-lent')),full:!!(globalThis.location&&new URLSearchParams(location.search).has('chat-plein')),failTurns:!!(globalThis.location&&new URLSearchParams(location.search).has('echec-chat')),readonly:!!(globalThis.location&&new URLSearchParams(location.search).has('lecture')),onChange:()=>republishMatching(topic=>/^chat-(?:agents|agent-sessions(?:-archived)?|session)(?::|$)/.test(topic))}));
 return chatV3Db||await chatV3Flight;
}
let settingsDb;
let externalAccessDb={};
function externalAccessMock(path) {
  const key=String(path).startsWith('/api/v3/setup/access')?'setup':'settings';
  return externalAccessDb[key] ||= createExternalAccessMock({setupCode:'AO-7Q2K-91MX',readonly:key==='settings'&&(scenario==='settings-readonly'||scenario==='lecture'),unavailable:scenario==='external-access-unavailable'});
}
async function settingsMock() {
  if (!settingsDb) settingsDb = (async () => {
    const {createSettingsMock}=await loadModule(() => import('./settings.js' + buildQuery));
    const variant=['settings-fixall','settings-fixall-partial','settings-fixall-delayed'].includes(scenario) ? 'settings-fixall-vm' : ['settings-readonly','settings-env','settings-restart-manual'].includes(scenario) ? scenario + '-vm' : 'settings-vm';
    const names=[variant,'check-result','integration-plan-result','reauth-request',...(scenario === 'settings-fixall-partial' ? ['fix-all-partial-result'] : [])];
    const examples=Object.fromEntries(await Promise.all(names.map(async name => [name,await fetch(assetUrl('mock/examples/settings/' + name + '.json')).then(r => r.json())])));
    return createSettingsMock({vm:examples[variant].data,examples,onChange: event => {
      // A real SSE frame is its own task, never dispatched inside the HTTP response that caused it.
      setTimeout(() => { for (const source of sources) source._emit('settings',{type:'settings',...event}); }, 0);
    }});
  })().catch(error => { settingsDb=null; throw error; });
  return settingsDb;
}
/** handle(method, path, body) → { status, body }. /api/v3 paths: the 2.5 mock, then the 3.0 projection (mock/v3.js). */
export async function handle(method, path, body) {
  if (/^\/api\/v3\/chat\/(?:agents|sessions|attachments)(?:\/|$|\?)/.test(path)) {
    const delay=await viewDelay();if(delay)return delay;
    const result=await (await chatV3Mock()).handle(method,path,body);
    if(method==='POST'&&/\/messages$/.test(path)&&globalThis.location&&new URLSearchParams(location.search).has('chat-lent'))await sleep(1500);
    return result;
  }
  if (/^\/api\/v3\/(?:setup|settings)\/access(?:\/|$|\?)/.test(path)) return externalAccessMock(path)(method,path,body);
  if (/^\/api\/v3\/settings(?:\/|$|\?)/.test(path)) {
    await sleep(scenario === 'settings-fixall-delayed' && method === 'POST' && path.endsWith('/fix-all') ? 8000 : scenario === 'lent' ? 900 : 50);
    if (scenario === 'erreur') return fail(503,'upstream_unavailable','Le serveur ne répond pas.');
    return (await settingsMock()).handle(method,new URL(path,'http://mock').pathname,body);
  }
  if (!/^\/api\/v3(\/|$)/.test(path)) return handle2(method, path, body);
  const u = new URL(path, 'http://mock');
  const q = u.searchParams;
  if (u.pathname === '/api/v3/views/logs' && LOG_KINDS_2X.includes(q.get('kind'))) return fail(400, 'validation_failed', 'Type de session inconnu.', [{ field: 'kind', issue: 'invalid' }]);
  if (u.pathname === '/api/v3/views/projects' && q.get('filter') === 'with-timmy') return fail(400, 'validation_failed', 'Filtre inconnu.', [{ field: 'filter', issue: 'invalid' }]);
  const t = v3.queryTo2x(u.search);
  const r = await handle2(method, u.pathname.replace(/^\/api\/v3/, '/api/v2') + (t.query.toString() ? '?' + t.query : ''), body);
  if (r.status >= 400 || !r.body || r.body.data == null || typeof r.body.data !== 'object') return r;
  const primaryId = META.primaryAgent && META.primaryAgent.id;
  let data = r.body.data;
  const name = method === 'GET' ? schemaForPath(u.pathname) : null;
  if (name === 'meta') data = v3.meta(data, { capabilities: v3.capabilitiesFrom(globalThis.location ? location.search : '') });
  else if (name) data = v3.project(name, data, { primaryId, query:u.searchParams });
  else if (data.vm && /^\/api\/v3\/flows\//.test(u.pathname)) data = { ...data, vm: v3.project('flow', data.vm, { primaryId }) };   // flow commands' CommandResult
  if (name === 'logs' && t.internalOnly) data = { ...data, items: data.items.filter((i) => i.kind === 'internal') };
  if (name === 'projects' && t.agent) data = { ...data, agent: t.agent };
  return { ...r, body: { ...r.body, data } };
}
async function handle2(method, path, body) {
  const url = new URL(path, 'http://mock');
  const p = url.pathname;
  if (method === 'GET' && p === '/api/v2/meta') {
    // Branding is internal fixture data for the standalone Bureau harness,
    // not a MetaVM field. Keep mock responses on the same contract as the API.
    const { brand, ...runtime } = META.runtime || {};
    return ok({ ...META, runtime: META.runtime ? runtime : null });
  }
  // ---- First-run setup (F8, G4 proposal; mock/setup.js) ----
  if (p === '/api/v2/setup' || p.startsWith('/api/v2/setup/')) {
    // ?setup-lent=<ms>: a slow runtime, so a test can change the connection while a check or a discovery is in flight (R20-02).
    const slow = globalThis.location ? Number(new URLSearchParams(location.search).get('setup-lent')) || 0 : 0;
    await sleep(p.endsWith('/check') ? slow || 1200 : p.endsWith('/discover') ? slow || 900 : 300);
    const db = setupDb();
    if (method === 'GET' && p === '/api/v2/setup/catalog') return ok(await fetch(assetUrl('bureau/office/manifest.example.json')).then(r => r.json()));
    if (method === 'GET' && p === '/api/v2/setup') return ok(db.vm());
    const out = method === 'POST' && p === '/api/v2/setup/check' ? db.check(body)
      : method === 'POST' && p === '/api/v2/setup/discover' ? db.discover(body)
      : method === 'PUT' && p === '/api/v2/setup' ? db.save(body)
      : method === 'POST' ? db.onboard(p.slice('/api/v2/setup/'.length), body) : null;
    if (!out) return fail(404, 'not_found', 'Route inconnue (maquette).');
    if (out.error) {
      const [st, code, message, details, extra] = out.error;
      const r = fail(st, code, message, details);
      if (extra && extra.retryAfterSec) r.body.retryAfterSec = extra.retryAfterSec;   // the Retry-After of a real 429
      return r;
    }
    if (method === 'PUT') {
      try { sessionStorage.setItem('ao.mock.configured', '1'); } catch { /* no storage */ }
      META.instance = { ...META.instance, configured: true };
    }
    return cmd(out.result, null, null);   // api.md 2.5 §5.7: every setup command answers a CommandResult
  }
  if (method === 'GET' && p === '/api/v2/me') return loggedIn ? ok(me()) : fail(401, 'unauthorized', 'Votre session a expiré. Reconnectez-vous.');

  if (method === 'GET' && p === '/api/v2/views/health') return (await viewDelay()) || read('health');
  if (method === 'GET' && p === '/api/v2/views/projects') {
    const filter = url.searchParams.get('filter') || 'all';
    if (!BOARD_FILTERS.includes(filter)) return fail(400, 'validation_failed', 'Filtre invalide.', [{ field: 'filter', issue: 'enum' }]);
    const query = new URLSearchParams();
    for (const key of ['filter','search','source','stage']) if (url.searchParams.has(key)) query.set(key,url.searchParams.get(key));
    return (await viewDelay()) || read('projects' + (query.size ? '?' + query : ''));
  }
  if (method === 'GET' && p === '/api/v2/views/project-candidates') {
    return (await viewDelay()) || ok(candidatesVM(candidateList(), Date.now() - 4 * 60_000));
  }
  if (method !== 'GET' && !META.capabilities.storeWrites && (p.startsWith('/api/v2/projects') || /^\/api\/v2\/health\/issues\//.test(p))) return READONLY();
  if (method === 'POST' && p === '/api/v2/projects/import') {
    await sleep(600);
    const out = importCandidates(projectsDb(), candidateList(), body, Date.now(), importedKeys);
    if (out.status) return out;
    candidates = out.list;
    republishProjects(out.created.map((x) => x.id));
    return cmd({ created: out.created, skipped: out.skipped });
  }
  if (method === 'GET' && p === '/api/v2/views/logs') {
    const kind = url.searchParams.get('kind');
    const heartbeat = url.searchParams.get('heartbeat');
    const cursor = url.searchParams.get('cursor');
    const err = await viewDelay();
    if (err) return err;
    const connector = url.searchParams.get('connector'), agent = url.searchParams.get('agent');
    if (cursor) { const page = logsDb().page(kind, cursor, undefined, { heartbeats: heartbeat === 'include', connector, agent }); return page ? ok(page) : fail(400, 'validation_failed', 'Certaines valeurs sont invalides.', [{ field: 'cursor', issue: 'invalid' }]); }
    const q = new URLSearchParams([...(agent ? [['agent', agent]] : []), ...(connector ? [['connector', connector]] : []), ...(heartbeat === 'include' ? [['heartbeat', 'include']] : []), ...(kind ? [['kind', kind]] : [])]).toString();
    return read(q ? 'logs?' + q : 'logs');
  }
  if (method === 'GET' && p === '/api/v2/views/office/palette') {
    const {mockPalette}=await loadModule(() => import('./palette.js' + buildQuery));
    try {return (await viewDelay()) || ok(await mockPalette({floorId:url.searchParams.get('floorId') || '1',category:url.searchParams.get('category') || '',search:url.searchParams.get('search') || ''}));}
    catch {return fail(400,'validation_failed','Sélection invalide.');}
  }
  if (method === 'GET' && p === '/api/v2/views/office/store') {
    await officeMock();
    const response=await fetch(assetUrl('mock/examples/office-store-catalog.json'));
    if(!response.ok)return fail(503,'upstream_unavailable','Catalogue indisponible.');
    const catalog=await response.json(),section=url.searchParams.get('section') || 'mobilier',category=url.searchParams.get('category') || '';
    const value=Object.hasOwn(catalog,section)&&Object.hasOwn(catalog[section],category) ? catalog[section][category] : null;
    if(!value)return fail(400,'validation_failed','Sélection invalide.');
    const vm=structuredClone(value);vm.floorId=url.searchParams.get('floorId') || '1';
    if(vm.floors)vm.floors.options=om.officeVM().rosterFloors.map(floor=>({id:floor.id,label:floor.label,count:null}));
    return (await viewDelay()) || ok(vm);
  }
  if (p === '/api/v2/views/office' || p.startsWith('/api/v2/office/')) {
    await officeMock();
    if (method === 'GET' && p === '/api/v2/views/office') return (await viewDelay()) || read('office');
    const floor=url.searchParams.get('floorId');
    if (method === 'GET' && p === '/api/v2/office/layout') return (await viewDelay()) || read(floor==null?'layout':'layout?floorId='+encodeURIComponent(floor));
    const rev = /^\/api\/v2\/office\/layout\/revisions\/(\d+)$/.exec(p);
    if (method === 'GET' && rev) return officeCall(async () => ok(await om.getRevision(Number(rev[1]),floor)));
    if (method === 'PUT' && (p === '/api/v2/office/layout' || p === '/api/v2/office/layout/theme')) {
      return officeCall(async () => {
        const result = p.endsWith('/theme') ? await om.putTheme(body || {},floor) : await om.putLayout(body || {},floor);
        republishMatching((t) => t === 'layout' || t.startsWith('layout?floorId=') || t === 'office');
        return { status: 200, body: { data: result, meta: { modelVersion: META.modelVersion, generatedAt: Date.now(), stale: [] } } };
      });
    }
    return fail(404, 'not_found', 'Route inconnue (maquette).');
  }
  // ---- Discuter (api.md §3.3, §5.2; an OpenClaw-class write: 403 readonly on staging) ----
  if (method === 'GET' && p === '/api/v2/views/chat') return (await viewDelay()) || read('chat');
  if (method === 'POST' && p === '/api/v2/chat/messages') {
    // ?chat-lent=1: the 202 arrives late (R19-01 regression), after the turn already shows as pending.
    const slow = globalThis.location && new URLSearchParams(location.search).has('chat-lent');
    await sleep(slow ? 1500 : 300);
    if (!META.capabilities.openclawWrites) return READONLY();
    const out = chatDb().post(body && body.text, () => republishMatching((t) => t === 'chat'));
    if (out.error) return fail(...out.error);
    republishMatching((t) => t === 'chat');
    return cmd({ turnId: out.turnId }, null, null, 202);
  }
  // ---- Flux de travail (OpenClaw writes: 403 readonly on staging) ----
  if (method === 'GET' && p === '/api/v2/views/flows') return (await viewDelay()) || read('flows');
  const fv = /^\/api\/v2\/views\/flows\/([^/]+)$/.exec(p);
  if (method === 'GET' && fv) { const e = await viewDelay(); if (e) return e; return read('flow:' + fv[1]) || fail(404, 'not_found', 'Cette tâche n’existe plus.'); }
  const fc = /^\/api\/v2\/flows(?:\/([^/]+))?(\/enabled|\/runs)?$/.exec(p);
  if (fc && method !== 'GET') {
    await sleep(450);
    if (!META.capabilities.openclawWrites) return READONLY();
    const id = fc[1] ? decodeURIComponent(fc[1]) : null;
    const db = flowsDb();
    const out = !id && method === 'POST' ? db.create(body)
      : id && !fc[2] && method === 'PATCH' ? db.edit(id, body)
      : id && fc[2] === '/enabled' && method === 'PUT' ? db.setEnabled(id, body)
      : id && fc[2] === '/runs' && method === 'POST' ? db.runNow(id, (ids) => republishMatching(flowTopics(ids)))
      : id && !fc[2] && method === 'DELETE' ? db.remove(id) : null;
    if (!out) return fail(404, 'not_found', 'Route inconnue (maquette).');
    if (out.error) return fail(...out.error);
    republishMatching(flowTopics(out.touched));
    return cmd(out.result ?? null);
  }
  // ---- Habilitations ----
  if (method === 'GET' && p === '/api/v2/views/access') return (await viewDelay()) || read('access');
  const iv = /^\/api\/v2\/views\/interlocutors\/([^/]+)$/.exec(p);
  if (method === 'GET' && iv) { const e = await viewDelay(); if (e) return e; return read('interlocutor:' + iv[1]) || fail(404, 'not_found', 'Cet interlocuteur est inconnu.'); }
  if (method === 'GET' && p === '/api/v2/views/skills') return (await viewDelay()) || read('skills');
  const skv = /^\/api\/v2\/views\/skills\/([^/]+)$/.exec(p);
  if (method === 'GET' && skv) {
    const err = await viewDelay();
    if (err) return err;
    return read('skill:' + skv[1]) || fail(404, 'not_found', 'Cette compétence n’existe pas.');
  }
  const skt = /^\/api\/v2\/skills\/([^/]+)\/enabled$/.exec(p);
  if (method === 'PUT' && skt) {
    await sleep(500);
    if (!META.capabilities.openclawWrites) return READONLY();
    const id = decodeURIComponent(skt[1]);
    const out = skillsDb().toggle(id, body);
    if (out.error) return fail(...out.error);
    republishMatching((t) => t === 'skills' || t === 'skill:' + encodeURIComponent(id));
    return cmd(out.result);
  }
  if (method === 'POST' && p === '/api/v2/gateway/restart') {
    await sleep(700);
    if (!META.capabilities.openclawWrites) return READONLY();
    if (!body || body.confirm !== 'redemarrer' || Object.keys(body).length !== 1) return fail(400, 'validation_failed', 'Tapez « redemarrer » pour confirmer.', [{ field: 'confirm', issue: 'invalid' }]);
    if (Date.now() - lastRestartAt < 120_000) return fail(429, 'rate_limited', 'La passerelle vient de redémarrer. Réessayez dans deux minutes.');
    lastRestartAt = Date.now();
    for (const src of sources) src._emit('system', { type: 'system', gateway: 'down', capabilities: META.capabilities });
    setTimeout(() => {
      skillsDb().restarted();
      republishMatching((t) => t === 'skills' || t.startsWith('skill:'));
      for (const src of sources) { src._emit('system', { type: 'system', gateway: 'up', capabilities: META.capabilities }); src._emit('toast', { type: 'toast', level: 'success', message: { key: 'toast.gatewayUp' } }); }
    }, 2500);
    return cmd({ via: 'rpc' });
  }
  const sess = /^\/api\/v2\/views\/sessions\/([^/]+)$/.exec(p);
  if (method === 'GET' && sess) {
    const err = await viewDelay();
    if (err) return err;
    return read('session:' + sess[1]) || fail(404, 'not_found', 'Cette session n’existe plus.');
  }
  const commentsView = /^\/api\/v2\/views\/projects\/([^/]+)\/comments$/.exec(p);
  if (method === 'GET' && commentsView) {
    const e = await viewDelay(); if (e) return e;
    const id = decodeURIComponent(commentsView[1]), cursor = url.searchParams.get('cursor');
    if (!projectsDb().projects.has(id)) return fail(404,'not_found','Ce projet n’existe plus.');
    if (cursor) { const vm = projects.buildCommentsVM(projectsDb(),id,{cursor,canComment:META.capabilities.storeWrites,canMention:META.capabilities.openclawWrites}); return vm ? ok(vm) : fail(400,'validation_failed','Curseur invalide.'); }
    return read('comments:'+encodeURIComponent(id));
  }
  const retryWrite = /^\/api\/v2\/projects\/([^/]+)\/comments\/([^/]+)\/retry$/.exec(p);
  if(retryWrite && method==='POST') {
    if(!META.capabilities.openclawWrites || META.runtime.capabilities?.projectComments===false)return READONLY();
    const id=decodeURIComponent(retryWrite[1]), cid=decodeURIComponent(retryWrite[2]);
    const out=projects.retryComment(projectsDb(),id,cid,body);
    if(out.error)return fail(...out.error);
    const refresh=()=>{republishMatching(t=>t==='comments:'+encodeURIComponent(id));republishProjects([id]);};
    refresh();
    setTimeout(()=>{out.comment.delivery.find(d=>d.agentId===body.agentId).status='working';refresh();},100);
    setTimeout(()=>{projects.replyToComment(projectsDb(),id,out.comment,{summary:out.comment.kind==='event',agentId:body.agentId});if(out.comment.kind==='event')projectsDb().projects.get(id).summaryPending=false;refresh();},1400);
    return cmd({comment:out.comment},null,null,202);
  }
  const commentsWrite = /^\/api\/v2\/projects\/([^/]+)\/comments(?:\/([^/]+))?$/.exec(p);
  const summaryWrite = /^\/api\/v2\/projects\/([^/]+)\/summary\/regenerate$/.exec(p);
  if ((commentsWrite && (method === 'POST' ? !commentsWrite[2] : ['PATCH','DELETE'].includes(method) && !!commentsWrite[2])) || (summaryWrite && method === 'POST')) {
    await sleep(250);
    const id = decodeURIComponent((commentsWrite || summaryWrite)[1]);
    if (summaryWrite && (!META.capabilities.openclawWrites || META.runtime.capabilities?.projectComments === false)) return READONLY();
    const out = summaryWrite ? projects.requestSummary(projectsDb(),id,body) : projects.commentCommand(projectsDb(),method,id,commentsWrite[2] && decodeURIComponent(commentsWrite[2]),body,{canMention:META.capabilities.openclawWrites && META.runtime.capabilities?.projectComments !== false});
    if (out.status) return out;
    if (out.error) return fail(...out.error);
    const refresh = () => { republishMatching((t) => t === 'comments:'+encodeURIComponent(id)); republishProjects([id]); };
    refresh();
    if ((summaryWrite || (method === 'POST' && out.comment.delivery.some((d) => d.status === 'pending')))) setTimeout(() => {
      projects.replyToComment(projectsDb(),id,out.comment,{fail:!!(globalThis.location && new URLSearchParams(location.search).has('echec-commentaire')),summary:!!summaryWrite});
      if (summaryWrite) projectsDb().projects.get(id).summaryPending = false;
      refresh();
    }, 1400);
    return cmd(summaryWrite ? {turnId:out.turnId} : {comment:out.comment},out.revision || null,summaryWrite ? projects.buildProjectVM(projectsDb(),id) : null,summaryWrite ? 202 : method === 'POST' ? 201 : 200);
  }
  const hist = /^\/api\/v2\/views\/projects\/([^/]+)\/history$/.exec(p);
  if (method === 'GET' && hist) {
    await sleep(300);
    if (!projectsDb().projects.has(decodeURIComponent(hist[1]))) return fail(404, 'not_found', 'Ce projet n’existe pas.');
    const limit = Number(url.searchParams.get('limit') || 20);
    const page = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? projects.historyPage(projectsDb(), decodeURIComponent(hist[1]), url.searchParams.get('cursor'), limit) : null;
    return page ? ok(page) : fail(400, 'validation_failed', 'Certaines valeurs sont invalides.', [{ field: 'cursor', issue: 'invalid' }]);
  }
  const one = /^\/api\/v2\/views\/projects\/([^/]+)$/.exec(p);
  if (method === 'GET' && one) {
    const err = await viewDelay();
    if (err) return err;
    return read('project:' + decodeURIComponent(one[1])) || fail(404, 'not_found', 'Ce projet n’existe pas ou a été archivé.');
  }

  if (p.startsWith('/api/v2/projects')) {
    await sleep(350);
    const out = projects.command(projectsDb(), method, p, body, { conflictMode: scenario === 'conflit' });
    if (!out) return fail(404, 'not_found', 'Route inconnue (maquette).');
    if (out.status) {
      if (out.status === 409) republishProjects(null); // the client resyncs to the server's version
      return out;
    }
    republishProjects(out.touched);
    const pid = out.result && out.result.id ? out.result.id : decodeURIComponent((/^\/api\/v2\/projects\/([^/]+)/.exec(p) || [])[1] || '');
    return cmd(out.result || null, out.revision ?? null, projects.buildProjectVM(projectsDb(), pid));
  }

  const mute = /^\/api\/v2\/health\/issues\/([^/]+)\/muted$/.exec(p);
  if (method === 'PUT' && mute) {
    await sleep(300);
    const keys = Object.keys(body || {});
    if (keys.some((k) => k !== 'muted') || typeof body.muted !== 'boolean') return fail(400, 'validation_failed', 'Certaines valeurs sont invalides.', [{ field: 'muted', issue: 'boolean attendu' }]);
    const vm = healthVM();
    const issue = vm.dataQuality.issues.find((i) => i.id === mute[1]);
    if (!issue) return fail(404, 'not_found', 'Ce problème n’existe plus.');
    if (!issue.mutable) return fail(400, 'validation_failed', 'Les erreurs ne peuvent pas être mises en sourdine.', [{ field: 'muted', issue: 'error-not-mutable' }]);
    const state = body.muted ? 'muted' : 'open';
    publish('health', withIssue(vm, issue.id, { state }));
    for (const s of sources) s._emit('toast', { type: 'toast', level: 'success', message: { key: body.muted ? 'toast.issueMuted' : 'toast.issueUnmuted' } });
    return cmd({ state });
  }

  const streamRoute = /^\/api\/v2\/stream\/([^/]+)\/(topics|resync)$/.exec(p);
  if (method === 'POST' && streamRoute) {
    if (failTopics > 0) { failTopics--; return fail(503, 'upstream_unavailable', 'Service momentanément indisponible.'); }
    const s = sources.find((x) => x.streamId === streamRoute[1]);
    if (!s) return fail(404, 'not_found', 'Flux inconnu.');
    if (streamRoute[2] === 'resync') {
      if (!s.topics.has(body.topic)) return fail(400, 'validation_failed', 'Sujet non abonné.', [{ field: 'topic', issue: 'unknown-topic' }]);
      setTimeout(() => s._snapshot(body.topic), 30);
      return ok({ queued: true });
    }
    const unknown = (body.add || []).find((t) => build(t) === undefined && !/^(project|comments|session|skill|flow|interlocutor):/.test(t) && t !== 'office' && t !== 'layout');
    if (unknown) return fail(400, 'validation_failed', 'Sujet inconnu.', [{ field: 'add', issue: 'unknown-topic' }]);
    for (const t of body.remove || []) s.topics.delete(t);
    for (const t of body.add || []) { s.topics.add(t); setTimeout(() => s._snapshot(t), 30); }
    return ok({ topics: [...s.topics] });
  }
  return fail(404, 'not_found', 'Route inconnue (maquette).');
}

// ---- SSE ----
const sources = [];
let seq = 0;
const SERVER_EPOCH = 'ep_' + Math.random().toString(36).slice(2, 8);
/** Test hook: the next N stream-control POSTs fail with 503 (?mock=…&echecs=N). */
let failTopics = Number(new URLSearchParams(globalThis.location ? location.search : '').get('echecs')) || 0;
let timer = null;

function publish(topic, next) {
  const prev = vms.get(topic);
  vms.set(topic, next);
  if (!prev) { revs.set(topic, 1); return; }
  const ops = diff(prev, next, []);
  if (!ops.length) return;
  const baseRev = revs.get(topic) || 1;
  const rev = baseRev + 1;
  revs.set(topic, rev);
  const frame = JSON.stringify(ops).length > JSON.stringify(next).length
    ? { type: 'snapshot', topic, rev, data: next }
    : { type: 'delta', topic, rev, baseRev, ops };
  for (const s of sources) if (s.topics.has(topic)) s._emit(frame.type, frame);
}

/** Rebuilds every subscribed topic that matches. */
function republishMatching(match) {
  for (const topic of new Set(sources.flatMap((s) => [...s.topics]))) if (match(topic)) { const vm = build(topic); if (vm) publish(topic, vm); }
}

/** Rebuilds every subscribed board topic and the touched projects' topics (all project topics when touched is null). */
function republishProjects(touched) {
  const live = new Set(sources.flatMap((s) => [...s.topics]));
  for (const topic of live) {
    const isBoard = topic === 'projects' || topic.startsWith('projects?');
    const pr = /^project:(.+)$/.exec(topic);
    if (isBoard || (pr && (touched == null || touched.includes(pr[1])))) {
      const vm = build(topic);
      if (vm) publish(topic, vm);
    }
  }
}

function startTicking() {
  if (timer || scenario === 'erreur' || scenario === 'vide') return;
  timer = setInterval(() => {
    tick++;
    if (!sources.length) return;
    publish('health', keepIssueStates(buildHealth(scenario, Date.now(), tick)));
    // Every 30 s Timmy moves the weekly-watch project, so the board shows a live move by someone else.
    if (tick % 10 === 0 && scenario === '1') republishProjects([projects.timmyMove(projectsDb())]);
    // The office script advances: cue frames go out, then the office VM is republished.
    if (om) { for (const cue of om.tick()) for (const s of sources) s._emit('cue', cue); republishMatching((t) => t === 'office'); }
    // The live main session takes a step every tick: the Journaux list and an open transcript update over SSE.
    if (scenario === '1') { const key = logsDb().tick(); if (key) republishMatching((t) => t === 'logs' || t.startsWith('logs?') || t === 'session:' + encodeURIComponent(key)); }
    for (const s of sources) s._emit('heartbeat', { type: 'heartbeat', at: Date.now() });
  }, TICK_MS);
}
// Mute state is "server state": keep it across rebuilds.
function keepIssueStates(next) {
  const prev = vms.get('health');
  if (!prev) return next;
  let vm = next;
  for (const i of prev.dataQuality.issues) if (vm.dataQuality.issues.some((x) => x.id === i.id)) vm = withIssue(vm, i.id, { state: i.state });
  return vm;
}

/** EventSource look-alike: addEventListener(type, fn), close(), readyState. */
export class MockEventSource {
  constructor(url) {
    const u = new URL(url, 'http://mock');
    this.url = url;
    this.apiVersion = /^\/api\/v3(?:\/|$)/.test(u.pathname) ? 3 : 2;
    this.readyState = 0;
    this.listeners = new Map();
    this.seq = 0;
    this.topics = new Set((u.searchParams.get('topics') || '').split(',').filter(Boolean));
    this.streamId = 'str_' + Math.random().toString(36).slice(2, 12);
    sources.push(this);
    setTimeout(() => {
      if (this.readyState === 2) return;
      this.readyState = 1;
      this._emit('hello', { type: 'hello', streamId: this.streamId, serverEpoch: SERVER_EPOCH, modelVersion: META.modelVersion, contractVersion: this.apiVersion === 3 ? v3.meta(META).contractVersion : META.contractVersion,
        serverTime: Date.now(), resumed: false, topics: [...this.topics] });
      this._emit('system', { type: 'system', gateway: scenario === 'panne' ? 'down' : 'up', capabilities: META.capabilities });
      for (const t of this.topics) this._snapshot(t);
      startTicking();
    }, 120);
  }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  close() { this.readyState = 2; const i = sources.indexOf(this); if (i >= 0) sources.splice(i, 1); }
  _snapshot(topic) {
    if (scenario === 'erreur' || scenario === 'lent') return;
    const data = build(topic);
    if (data === undefined) return;
    publish(topic, data); // brings the shared topic VM up to date first (snapshot = current rev, §4.3)
    this._emit('snapshot', { type: 'snapshot', topic, rev: revs.get(topic), data: vms.get(topic) });
  }
  _emit(type, frame) {
    if (this.readyState === 2) return;
    const ev = { type, data: JSON.stringify(frame), lastEventId: `${this.streamId}:${++this.seq}` };
    for (const fn of this.listeners.get(type) || []) fn(ev);
  }
}
