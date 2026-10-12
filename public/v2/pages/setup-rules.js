// First-run setup (F8): the flow's rules, pure and testable. Steps (explorer-05 E5, PM's F8 brief):
//   0 welcome (one-time setup code) → 1 runtime → 2 gateway check → 3 agents → 4 identities → 5 office → 6 review → 7 done.
// Nothing here stores or echoes the runtime token or the owner password; a change to the connection invalidates the check and the agents.

export const STEPS = ['welcome', 'detection', 'runtime', 'gateway', 'agents', 'identities', 'office', 'skills', 'network', 'review', 'done'];
export const NUMBERED = STEPS.slice(1, -1);   // the six numbered chapters

/** api.md 2.5 §5.7 (G6): an adapter declares the runtime fields it takes; `demo` takes none (no gateway, no token). */
export const takes = (s, field) => !Array.isArray(s.fields) || s.fields.includes(field);
export const validUrl = (u) => typeof u === 'string' && /^wss?:\/\/[^\s/]+(:\d+)?(\/\S*)?$/.test(u.trim());
export const validEmail = (e) => typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim());
export const validZone = (z) => { try { return !!z && !!new Intl.DateTimeFormat('en', { timeZone: z }); } catch { return false; } };

/** The first problem that blocks leaving `step` (a message key), or null when the step is complete. */
export function blocker(step, s) {
  switch (STEPS[step]) {
    case 'welcome': return !s.code.trim() ? 'setup.err.code' : s.resumePending ? null : !s.owner.trim() ? 'setup.err.owner' : !validEmail(s.email) ? 'setup.err.email' : passwordBlocker(s);
    case 'detection': return s.detections ? null : 'onboarding.detect.wait';
    case 'runtime': return !s.adapter ? 'setup.err.adapter' : !takes(s, 'gatewayUrl') || validUrl(s.gatewayUrl) ? null : 'setup.err.url';
    case 'gateway': return s.check && s.check.ok ? null : 'setup.err.check';
    case 'agents': return !s.agents?.length ? 'setup.err.agents' : s.agents.some(a => !a.name?.trim()) ? 'onboarding.name.required' : null;
    case 'identities': return !s.primary || !s.agents.some(a => a.id === s.primary) ? 'setup.err.primary' : s.ownerSaved && s.agents.some(a => !s.looks[a.id]?.character) ? 'onboarding.styles.wait' : null;
    case 'office': return !s.name.trim() ? 'setup.err.name' : !validZone(s.timeZone) ? 'setup.err.zone' : null;
    case 'network': return s.accessStaged ? null : 'access.stageRequired';
    default: return null;
  }
}
/** api.md 2.5 §5.7: the owner password is write-only, at least 12 characters, required unless one is already set. */
export function passwordBlocker(s) {
  if (!s.password && !s.password2) return s.passwordSet ? null : 'setup.err.password';
  if (s.password.length < 12) return 'setup.err.passwordShort';
  return s.password === s.password2 ? null : 'setup.err.passwordMatch';
}
/** The furthest step reachable from the start given the current answers (no skipping past an incomplete step). */
export function reachable(s) {
  let i = 0;
  while (i < STEPS.length - 2 && !blocker(i, s)) i++;
  return i;
}

/** A connection change invalidates everything learned from the previous connection (explorer-05). */
export function validNetwork(n) {
  if (!n || !['local', 'lan', 'tailnet', 'public', 'tunnel'].includes(n.mode) || !Number.isInteger(n.port) || n.port < 1 || n.port > 65535) return false;
  if (n.mode === 'local') return !n.publicUrl;
  try { const u = new URL(n.publicUrl); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' && (n.mode === 'lan' || u.protocol === 'https:'); } catch { return false; }
}

export function withConnection(s, patch) {
  return { ...s, ...patch, check: null, agents: null, primary: null, looks: {}, skillPlan: null, skillResults: null, skillsConfirmed: false };
}

/** The gateway check as a sentence: { key, params, tone }. */
export function checkSentence(r, { gateway = true } = {}) {
  if (!r) return null;
  if (r.ok && !gateway) return { key: 'setup.check.noGateway', tone: 'success' };   // G6: an adapter without a connection (demo)
  if (r.ok) return { key: 'setup.check.connected', params: { protocol: r.protocol ?? '—', ms: r.latencyMs ?? '—' }, tone: 'success' };
  const key = { unreachable: 'setup.check.unreachable', refused: 'setup.check.refused', unauthorized: 'setup.check.unauthorized' }[r.status] || 'setup.check.failed';
  return { key, tone: 'danger' };
}

/** The runtime part of every setup request: only the fields the adapter takes (the demo's is `{adapter}` alone). */
export function runtimeBody(s) {
  return { adapter: s.adapter, ...(takes(s, 'gatewayUrl') ? { gatewayUrl: s.gatewayUrl.trim() } : {}), ...(takes(s, 'token') && s.token ? { token: s.token } : {}) };
}
/** The request body for PUT /api/v2/setup (the token only when one was typed; never stored elsewhere). */
export function payload(s, vm) {
  return {
    setupCode: s.code.trim(),
    instance: { name: s.name.trim(), locale: s.locale, timeZone: s.timeZone },
    owner: { displayName: s.owner.trim(), email: s.email.trim(), ...(s.password ? { password: s.password } : {}) },
    runtime: runtimeBody(s),
    agents: { primary: s.primary, looks: s.looks, ...(s.ownerSaved ? { names: Object.fromEntries((s.agents || []).map(a => [a.id, a.name.trim()])) } : {}) },
    ...(s.accessLegacyFallback ? { network: { mode: 'local', port: vm?.network?.port || 18789, publicUrl: '' } } : {}),
    ...(offersProjet(vm, s) ? { integrations: { projet: s.projet !== false, ...(s.ownerSaved ? { reviewed: true } : {}) } } : {}),
  };
}

// architect-56 · the project tag: setup offers to install it for the primary agent (opt-out, on by default) when the
// server lists the `projet` integration for the chosen runtime adapter.
export const offersProjet = (vm, s) => !!(vm && Array.isArray(vm.integrations)
  && vm.integrations.some((i) => i && i.id === 'projet' && Array.isArray(i.adapters) && i.adapters.includes(s.adapter)));

/** Discovery's projectTag → the chip shown next to an agent ([tone, message key]); unknown shows nothing. */
export const TAG_CHIP = { installed: ['success', 'setup.tag.installed'], outdated: ['warning', 'setup.tag.outdated'],
  absent: [null, 'setup.tag.absent'], conflict: ['danger', 'setup.tag.conflict'] };

/**
 * The done step's line about the install: { tone, key }. `before` is the primary agent's projectTag at discovery, so an
 * install that found it already in place reads « déjà installée ». null when the save answered nothing about it.
 */
export function projetOutcome(result, before) {
  if (!result || typeof result.status !== 'string') return null;
  switch (result.status) {
    case 'installed': return before === 'installed' ? { tone: 'success', key: 'setup.tag.result.already' } : { tone: 'success', key: 'setup.tag.result.installed' };
    case 'outdated': return { tone: 'warning', key: 'setup.tag.result.outdated' };
    case 'conflict': return { tone: 'danger', key: 'setup.tag.result.conflict' };
    case 'skipped': return { tone: null, key: result.reason === 'opted-out' ? 'setup.tag.result.optedOut' : result.reason === 'adapter' ? 'setup.tag.result.adapter' : 'setup.tag.result.skipped' };
    default: return { tone: 'danger', key: 'setup.tag.result.failed' };
  }
}
