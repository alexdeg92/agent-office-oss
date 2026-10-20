import { loadModule } from './build-update.js';
// Dev/test-only schema validation; diagnostics omit values.
import { config, buildQuery } from './config.js';

let validateVM = null;
let report = defaultReport;

function defaultReport(where, name, issues) {
  const list = issues.map((i) => `${i.path} (${i.detail})`).join('; ');
  console.error(`[vm] ${where}: ${name} does not match its schema: ${list}`);
  try { (globalThis.__AO_VM_ISSUES ||= []).push({ where, name, issues }); } catch { /* frozen global */ }
}

export async function enable({ validate = null, onIssue = null } = {}) {
  validateVM = validate || (await loadModule(() => import('./generated/vm-schemas.js' + buildQuery))).validateVM;
  if (onIssue) report = onIssue;
}
export function disable() { validateVM = null; report = defaultReport; }
export const enabled = () => !!validateVM;

export function schemaForPath(path) {
  if (String(path).split('?')[0].replace(/\/+$/, '') === '/api/v3/settings') return 'settings';
  const p = String(path).split('?')[0].replace(/\/+$/, '').replace(/^\/api\/v3(?=\/)/, '/api/v2');   // same routes on both versions
  if (p === '/api/v2/meta') return 'meta';
  if (p === '/api/v2/me') return 'me';
  if (p === '/api/v2/office/layout') return 'layout';
  if (p === '/api/v2/prefs') return 'prefs';
  if (p === '/api/v2/views/office/palette') return 'officePalette';
  if (p === '/api/v2/views/office/store') return 'officeStore';
  const m = /^\/api\/v2\/views\/([a-z-]+)(\/[^/]+)?(\/(?:history|comments))?$/.exec(p);
  if (!m) return null;
  const [, view, one, history] = m;
  if (history) return view === 'projects' ? (history === '/comments' ? 'comments' : 'history') : null;
  const single = { projects: 'project', sessions: 'session', skills: 'skill', flows: 'flow', interlocutors: 'interlocutor', office: 'officeCharacters' };
  const list = { health: 'health', projects: 'projects', 'project-candidates': 'candidates', logs: 'logs', skills: 'skills', flows: 'flows', access: 'access', office: 'office', chat: 'chat' };
  return one ? single[view] || null : list[view] || null;
}
export function schemaForTopic(topic) {
  const base = String(topic).split(/[:?]/)[0];
  const param = /^[a-z-]+:/.test(topic);
  if (param) return { comments: 'comments', project: 'project', session: 'session', skill: 'skill', flow: 'flow', interlocutor: 'interlocutor' }[base] || null;
  return { health: 'health', projects: 'projects', logs: 'logs', skills: 'skills', flows: 'flows', access: 'access', office: 'office', layout: 'layout', chat: 'chat', prefs: 'prefs' }[base] || null;
}

export function check(name, vm, where,apiVersion) {
  if (!validateVM || !name || vm === undefined) return [];
  if (apiVersion===undefined && name !== 'settings' && config.apiVersion !== 2) return [];   // Unpinned v3 views still use contract tests.
  const r = validateVM(name, vm, name === 'settings' ? 3 : apiVersion ?? 2);
  if (r.ok) return [];
  report(where, name, r.issues);
  return r.issues;
}
