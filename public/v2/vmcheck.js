// Dev/test validates received VMs against shared server schemas. Issues are value-free and
// recorded on __AO_VM_ISSUES; strict tests can throw. Production never loads the validator.

import { config, buildQuery } from './config.js';

let validateVM = null;
let report = defaultReport;

function defaultReport(where, name, issues) {
  const list = issues.map((i) => `${i.path} (${i.detail})`).join('; ');
  console.error(`[vm] ${where}: ${name} does not match its schema: ${list}`);
  try { (globalThis.__AO_VM_ISSUES ||= []).push({ where, name, issues }); } catch { /* frozen global */ }
}

/** Turns checking on (dev/test). `validate` is injectable for tests; by default the generated module is loaded. */
export async function enable({ validate = null, onIssue = null } = {}) {
  validateVM = validate || (await import('./generated/vm-schemas.js' + buildQuery)).validateVM;
  if (onIssue) report = onIssue;
}
export function disable() { validateVM = null; report = defaultReport; }
export const enabled = () => !!validateVM;

/** The schema name for an API path (GETs of the api.md §3 views, meta, me, layout, prefs), else null. */
export function schemaForPath(path) {
  if (String(path).split('?')[0].replace(/\/+$/, '') === '/api/v3/settings') return 'settings';
  const p = String(path).split('?')[0].replace(/\/+$/, '').replace(/^\/api\/v3(?=\/)/, '/api/v2');   // same routes on both versions
  if (p === '/api/v2/meta') return 'meta';
  if (p === '/api/v2/me') return 'me';
  if (p === '/api/v2/office/layout') return 'layout';
  if (p === '/api/v2/prefs') return 'prefs';
  const m = /^\/api\/v2\/views\/([a-z-]+)(\/[^/]+)?(\/(?:history|comments))?$/.exec(p);
  if (!m) return null;
  const [, view, one, history] = m;
  if (history) return view === 'projects' ? (history === '/comments' ? 'comments' : 'history') : null;
  const single = { projects: 'project', sessions: 'session', skills: 'skill', flows: 'flow', interlocutors: 'interlocutor' };
  const list = { health: 'health', projects: 'projects', 'project-candidates': 'candidates', logs: 'logs', skills: 'skills', flows: 'flows', access: 'access', office: 'office', chat: 'chat' };
  return one ? single[view] || null : list[view] || null;
}
/** The schema name for an SSE topic id (api.md §4.1), else null. */
export function schemaForTopic(topic) {
  const base = String(topic).split(/[:?]/)[0];
  const param = /^[a-z-]+:/.test(topic);
  if (param) return { comments: 'comments', project: 'project', session: 'session', skill: 'skill', flow: 'flow', interlocutor: 'interlocutor' }[base] || null;
  return { health: 'health', projects: 'projects', logs: 'logs', skills: 'skills', flows: 'flows', access: 'access', office: 'office', layout: 'layout', chat: 'chat', prefs: 'prefs' }[base] || null;
}

/** Checks one VM when checking is on; returns the issues (empty when valid, unknown or off). */
export function check(name, vm, where) {
  if (!validateVM || !name || vm === undefined) return [];
  if (name !== 'settings' && config.apiVersion !== 2) return [];   // Other v3 views still use contract tests.
  const r = validateVM(name, vm, name === 'settings' ? 3 : 2);
  if (r.ok) return [];
  report(where, name, r.issues);
  return r.issues;
}
