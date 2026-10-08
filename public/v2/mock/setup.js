// Mock first-run setup (F8): api.md 2.5 §5.7 (G4, final) and its examples (docs/architecture/examples/setup-*).
// Invented data only; nothing is written anywhere.
//   GET  /api/v2/setup           → SetupVM { state, configured, adapters, draft (null unless open), suggestedTimeZone, locales }
//   POST /api/v2/setup/check     { setupCode, runtime } → CommandResult<{ ok, status, protocol, latencyMs }> (a failed connection is a 200)
//   POST /api/v2/setup/discover  { setupCode, runtime } → CommandResult<{ agents }> (unreachable runtime → 502 upstream_failed)
//   PUT  /api/v2/setup           { setupCode, instance, owner{…, password?}, runtime{…, token?}, agents, integrations? } → CommandResult<{ configured: true, integrations }>
// Write-only secrets: runtime.token and owner.password are accepted, never returned (draft: tokenSet / passwordSet).
// A wrong code → 403 forbidden {field:'setupCode', issue:'invalid'} and counts toward the login throttle (6 → 429).
// Every code-guarded route (check, discover, save) applies the live state: locked or read-only → 403 {issue:'locked'} / readonly. Hooks (?installation=…): injoignable, refuse, jeton, sans-agent,
// echec-enregistrement, verrouille, lecture, concurrent (open on load, locked for every later call).
// architect-56, the project tag: etiquette-deja (already installed for the primary agent), etiquette-conflit, etiquette-erreur.

export const SETUP_CODE = 'AO-7Q2K-91MX';   // the mock's « one-time code printed in the server log »

export function createSetup({ hook = null, now = () => Date.now() } = {}) {
  let state = hook === 'verrouille' ? 'locked' : hook === 'lecture' ? 'readonly' : 'open';
  let saveFailuresLeft = hook === 'echec-enregistrement' ? 1 : 0;
  let wrongCodes = 0;
  let blockedUntil = 0;   // R22-10: the throttle is a time window; after its Retry-After the code is accepted again
  let spent = false;   // R20-03: the code is single-use; a successful save spends it and locks the instance
  let tokenSet = false;
  const draft = { instance: { name: '', locale: 'fr', timeZone: null }, owner: { displayName: '', email: '', passwordSet: false },
    runtime: { adapter: 'openclaw', gatewayUrl: 'ws://127.0.0.1:18789', tokenSet: false } };
  const refuse = (status, code, message, details, extra) => ({ error: [status, code, message, details, extra] });
  const guard = (b) => {
    if (state === 'readonly') return refuse(403, 'readonly', 'L’installation n’est pas disponible sur une instance en lecture seule.');
    if (state === 'locked' || spent) return refuse(403, 'forbidden', 'Ce bureau est déjà configuré.', [{ issue: 'locked' }]);
    if (blockedUntil > now()) return refuse(429, 'rate_limited', 'Trop de tentatives. Réessayez plus tard.', null, { retryAfterSec: Math.ceil((blockedUntil - now()) / 1000) });
    if (blockedUntil) { blockedUntil = 0; wrongCodes = 0; }
    if (!b || b.setupCode !== SETUP_CODE) { if (++wrongCodes >= 6) blockedUntil = now() + 30_000; return refuse(403, 'forbidden', 'Code d’installation invalide.', [{ field: 'setupCode', issue: 'invalid' }]); }
    return null;
  };
  // G6: the demo adapter takes no other runtime field; for the others, a ws(s):// gateway address.
  const runtimeIssue = (r) => {
    if (!r || typeof r !== 'object' || !['openclaw', 'demo'].includes(r.adapter)) return { field: 'runtime.adapter', issue: 'invalid' };
    if (r.adapter === 'demo') { const extra = Object.keys(r).find((k) => k !== 'adapter'); return extra ? { field: 'runtime.' + extra, issue: 'unexpected-field' } : null; }
    return checkUrl(r.gatewayUrl) ? null : { field: 'runtime.gatewayUrl', issue: 'invalid' };
  };
  const DEMO_AGENTS = [{ id: 'lune', name: 'Lune', isPrimary: true, model: 'demo-a' }, { id: 'orage', name: 'Orage', isPrimary: false, model: 'demo-b' }];
  const checkUrl = (u) => typeof u === 'string' && /^wss?:\/\/[^\s/]+(:\d+)?(\/\S*)?$/.test(u.trim());
  const status = () => (hook === 'injoignable' ? 'unreachable' : hook === 'refuse' ? 'refused' : hook === 'jeton' ? 'unauthorized' : 'connected');
  return {
    configured: () => state === 'locked' && !hook,
    vm: () => { const out = {
      state,
      configured: state === 'locked',
      adapters: [{ id: 'openclaw', name: 'OpenClaw', fields: ['gatewayUrl', 'token'], defaultGatewayUrl: 'ws://127.0.0.1:18789' },
        { id: 'demo', name: 'Démo', fields: [], defaultGatewayUrl: null }],   // G6: no connection (api.md 2.5 §5.7)
      draft: state === 'open' ? { instance: { ...draft.instance }, owner: { ...draft.owner }, runtime: { ...draft.runtime, tokenSet } } : null,
      suggestedTimeZone: 'UTC',          // the server process's zone (ADR §12.7), never a built-in installation zone
      locales: ['fr', 'en'],
      integrations: [{ id: 'projet', adapters: ['openclaw'], default: true }],   // architect-56
    };
      if (hook === 'concurrent') state = 'locked';   // someone else finishes the setup right after this page loaded
      return out; },
    check(b) {
      const e = guard(b); if (e) return e;
      const bad = runtimeIssue(b.runtime);
      if (bad) return refuse(400, 'validation_failed', 'Certaines valeurs sont invalides.', [bad]);
      if (b.runtime.adapter === 'demo') return { result: { ok: true, status: 'connected', protocol: null, latencyMs: 0 } };
      if (b.runtime.token) tokenSet = true;
      const st = status();
      return { result: { ok: st === 'connected', status: st, protocol: st === 'connected' ? 4 : null, latencyMs: st === 'connected' ? 42 : null } };
    },
    discover(b) {
      const e = guard(b); if (e) return e;
      const bad = runtimeIssue(b.runtime);
      if (bad) return refuse(400, 'validation_failed', 'Certaines valeurs sont invalides.', [bad]);
      if (b.runtime.adapter === 'demo') return { result: { agents: DEMO_AGENTS.map((a) => ({ ...a })) } };
      if (status() !== 'connected') return refuse(502, 'upstream_failed', 'Le moteur n’a pas répondu.', [{ issue: status() }]);
      if (hook === 'sans-agent') return { result: { agents: [] } };
      return { result: { agents: [
        { id: 'atelier-agent', name: 'Orion', isPrimary: true, model: 'model-a', projectTag: hook === 'etiquette-deja' ? 'installed' : hook === 'etiquette-conflit' ? 'conflict' : 'absent' },
        { id: 'code-agent', name: 'Lyra', isPrimary: false, model: null, projectTag: 'outdated' },
      ] } };
    },
    save(b) {
      const e = guard(b); if (e) return e;
      const issues = [];
      const name = String((b.instance && b.instance.name) || '').trim();
      if (!name || name.length > 80) issues.push({ field: 'instance.name', issue: 'invalid' });
      const dn = String((b.owner && b.owner.displayName) || '').trim();
      if (!dn || dn.length > 80) issues.push({ field: 'owner.displayName', issue: 'invalid' });
      if (!b.owner || !/^[^@\s]+@[^@\s]+$/.test(String(b.owner.email || ''))) issues.push({ field: 'owner.email', issue: 'invalid' });
      const pw = b.owner && b.owner.password;
      if (pw == null ? !draft.owner.passwordSet : String(pw).length < 12) issues.push({ field: 'owner.password', issue: pw == null ? 'required' : 'too-short' });
      const rtIssue = runtimeIssue(b.runtime);
      if (rtIssue) issues.push(rtIssue);
      if (!b.agents || !/^[A-Za-z0-9_-]{1,64}$/.test(String(b.agents.primary || ''))) issues.push({ field: 'agents.primary', issue: 'invalid' });
      if (b.integrations != null && (typeof b.integrations !== 'object' || Object.keys(b.integrations).some((k) => k !== 'projet') || (b.integrations.projet != null && typeof b.integrations.projet !== 'boolean'))) issues.push({ field: 'integrations', issue: 'invalid' });
      if (issues.length) return refuse(400, 'validation_failed', 'Certaines valeurs sont invalides.', issues);
      if (saveFailuresLeft > 0) { saveFailuresLeft--; return refuse(503, 'upstream_unavailable', 'L’enregistrement a échoué. Réessayez.'); }
      state = 'locked'; spent = true;
      Object.assign(draft, { instance: { ...b.instance }, owner: { displayName: b.owner.displayName, email: b.owner.email, passwordSet: true } });
      const optIn = !(b.integrations && b.integrations.projet === false);
      const projet = b.runtime.adapter !== 'openclaw' ? { status: 'skipped', reason: 'adapter' } : !optIn ? { status: 'skipped', reason: 'opted-out' }
        : hook === 'etiquette-conflit' ? { status: 'conflict', reason: 'skill-not-ours' } : hook === 'etiquette-erreur' ? { status: 'failed', reason: 'error' } : { status: 'installed' };
      return { result: { configured: true, integrations: { projet } } };
    },
  };
}
