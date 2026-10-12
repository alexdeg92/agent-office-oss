// First-run setup (F8): the flow's rules (pages/setup-rules.js) and the mock G4 API (mock/setup.js), fr/en.
// The mock answers are checked against architect's final G4 examples (api.md 2.5 §5.7, examples/setup-*).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setMeta, setLang, msg } from '../../public/v2/i18n.js';
import * as R from '../../public/v2/pages/setup-rules.js';
import { createSetup, SETUP_CODE } from '../../public/v2/mock/setup.js';

const { compareExample } = createRequire(import.meta.url)('../helpers/contract-shape.js');

setMeta({ labels: {}, enums: {} });
const NB = ' ';
const base = () => ({ code: '', adapter: 'openclaw', gatewayUrl: '', token: '', check: null, agents: null, primary: null, looks: {}, name: '', owner: '', email: '', password: '', password2: '', passwordSet: false, locale: 'fr', timeZone: 'UTC' });

test('onboarding chapters require external access to be staged before final review', () => {
  const at = (name, s) => R.blocker(R.STEPS.indexOf(name), s);
  let s = base();
  assert.equal(R.reachable(s), 0); assert.equal(at('welcome', s), 'setup.err.code');
  assert.equal(at('welcome', { ...s, resumePending: true }), 'setup.err.code');
  assert.equal(at('welcome', { ...s, resumePending: true, code: 'AO-1' }), null, 'resume requires the code before private owner details');
  s = { ...s, code: 'AO-1' }; assert.equal(at('welcome', s), 'setup.err.owner');
  s.owner = 'Operator'; assert.equal(at('welcome', s), 'setup.err.email');
  s.email = 'operator@example.invalid'; assert.equal(at('welcome', s), 'setup.err.password');
  assert.equal(at('welcome', { ...s, password: 'short', password2: 'short' }), 'setup.err.passwordShort');
  assert.equal(at('welcome', { ...s, password: 'long-password', password2: 'different' }), 'setup.err.passwordMatch');
  s.passwordSet = true; assert.equal(R.reachable(s), 1);
  s.detections = []; assert.equal(at('runtime', s), 'setup.err.url');
  s.gatewayUrl = 'ws://127.0.0.1:18789'; assert.equal(R.reachable(s), R.STEPS.indexOf('gateway'));
  s.check = { ok: true }; s.agents = []; assert.equal(at('agents', s), 'setup.err.agents');
  s.agents = [{ id: 'a1', name: null }]; assert.equal(at('agents', s), 'onboarding.name.required');
  s.agents[0].name = 'Orion'; assert.equal(at('identities', s), 'setup.err.primary');
  s.primary = 'a1'; assert.equal(at('office', s), 'setup.err.name');
  s.name = 'Bureau'; s.timeZone = 'Mars/Base'; assert.equal(at('office', s), 'setup.err.zone');
  s.timeZone = 'UTC';
  assert.equal(at('network', s), 'access.stageRequired');
  assert.equal(R.reachable(s), R.STEPS.indexOf('network'));
  s.accessStaged = true; assert.equal(R.reachable(s), R.STEPS.indexOf('review'));
  assert.equal(R.payload(s).network, undefined, 'setup publishes the access plan staged server-side');
  assert.deepEqual(R.payload({ ...s, accessLegacyFallback: true }, { network: { port: 43210 } }).network,
    { mode: 'local', port: 43210, publicUrl: '' }, 'a pre-T-0078 setup publishes only the legacy local listener fallback');
  assert.equal(R.validNetwork({ mode: 'local', port: 0 }), false);
  assert.equal(R.validNetwork({ mode: 'local', port: 18789, publicUrl: null }), true);
});

test('a connection change invalidates the check, the agents and the identities', () => {
  const s = { ...base(), check: { ok: true }, agents: [{ id: 'a' }], primary: 'a', looks: { a: { character: 'timmy' } } };
  const t = R.withConnection(s, { gatewayUrl: 'ws://autre:1' });
  assert.deepEqual([t.check, t.agents, t.primary, t.looks], [null, null, null, {}]);
});

test('the payload sends the token only when one was typed; the check reads as a sentence in fr/en', () => {
  const s = { ...base(), code: ' AO-1 ', gatewayUrl: ' ws://h:1 ', agents: [{ id: 'a' }], primary: 'a', name: 'B', owner: 'C', email: 'n@example.invalid' };
  assert.equal('token' in R.payload(s).runtime, false);
  assert.equal('password' in R.payload(s).owner, false, 'a kept password is not resent');
  assert.equal(R.payload({ ...s, password: 'douze-car-123' }).owner.password, 'douze-car-123');
  assert.equal(R.payload({ ...s, token: 's3cr3t' }).runtime.token, 's3cr3t');
  assert.equal(R.payload(s).setupCode, 'AO-1');
  const ok = R.checkSentence({ ok: true, protocol: 4, latencyMs: 42 });
  assert.equal(msg(ok.key, ok.params), `Passerelle connectée${NB}: protocole v4, réponse en 42${NB}ms.`);
  setLang('en');
  assert.equal(msg(R.checkSentence({ ok: false, status: 'unauthorized' }).key), 'The gateway rejected the token.');
  setLang('fr');
});

test('mock G4 API: the setup code guards every call; secrets are write-only; validation; locked; scenarios', () => {
  const db = createSetup();
  assert.equal(db.vm().state, 'open');
  assert.equal(db.check({ setupCode: 'faux', runtime: {} }).error[1], 'forbidden');
  assert.deepEqual(db.check({ setupCode: SETUP_CODE, runtime: { adapter: 'openclaw', gatewayUrl: 'ftp://x' } }).error[3], [{ field: 'runtime.gatewayUrl', issue: 'invalid' }]);
  assert.equal(db.check({ setupCode: SETUP_CODE, runtime: { adapter: 'openclaw', gatewayUrl: 'ws://h:1', token: 's3cr3t' } }).result.ok, true);
  const vm = JSON.stringify(db.vm());
  assert.ok(!vm.includes('s3cr3t') && db.vm().draft.runtime.tokenSet === true, 'never echoed, only tokenSet');
  const bad = db.save({ setupCode: SETUP_CODE, instance: { name: '' }, owner: { email: 'x' }, agents: {} }).error[3].map((d) => d.field);
  assert.deepEqual(bad, ['instance.name', 'owner.displayName', 'owner.email', 'owner.password', 'runtime.adapter', 'agents.primary']);
  const body = { setupCode: SETUP_CODE, instance: { name: 'B' }, owner: { displayName: 'C', email: 'n@example.invalid', password: 'court' }, runtime: { adapter: 'openclaw', gatewayUrl: 'ws://h:1' }, agents: { primary: 'a' } };
  assert.deepEqual(db.save(body).error[3], [{ field: 'owner.password', issue: 'too-short' }]);
  assert.equal(db.save({ ...body, owner: { ...body.owner, password: 'douze-car-123' } }).result.configured, true);
  assert.ok(!JSON.stringify(db.vm()).includes('douze-car-123'));
  assert.deepEqual([db.vm().state, db.vm().configured, db.vm().draft], ['locked', true, null], 'configured: setup closes, no draft');
  assert.deepEqual(db.check({ setupCode: SETUP_CODE, runtime: {} }).error.slice(1, 4), ['forbidden', 'Ce bureau est déjà configuré.', [{ issue: 'locked' }]]);
  assert.equal(createSetup({ hook: 'injoignable' }).check({ setupCode: SETUP_CODE, runtime: { adapter: 'openclaw', gatewayUrl: 'ws://h:1' } }).result.status, 'unreachable');
  assert.equal(createSetup({ hook: 'injoignable' }).discover({ setupCode: SETUP_CODE, runtime: { adapter: 'openclaw', gatewayUrl: 'ws://h:1' } }).error[1], 'upstream_failed');
  assert.deepEqual(createSetup({ hook: 'sans-agent' }).discover({ setupCode: SETUP_CODE, runtime: { adapter: 'openclaw', gatewayUrl: 'ws://h:1' } }).result.agents, []);
  assert.deepEqual([createSetup({ hook: 'lecture' }).vm().state, createSetup({ hook: 'lecture' }).vm().draft], ['readonly', null]);
});

test('R20-03: the code is single-use; locked and read-only refuse every guarded route, and a replay changes nothing', () => {
  const db = createSetup();
  const body = { setupCode: SETUP_CODE, instance: { name: 'Premier' }, owner: { displayName: 'C', email: 'n@example.invalid', password: 'douze-car-123' },
    runtime: { adapter: 'openclaw', gatewayUrl: 'ws://h:1' }, agents: { primary: 'a' } };
  assert.equal(db.save(body).result.configured, true);
  const replay = db.save({ ...body, instance: { name: 'Remplacé' } });
  assert.deepEqual([replay.error && replay.error[0], replay.error && replay.error[3]], [403, [{ issue: 'locked' }]], 'a second save with the same code is refused');
  for (const op of ['check', 'discover']) assert.deepEqual(db[op]({ setupCode: SETUP_CODE, runtime: { adapter: 'openclaw', gatewayUrl: 'ws://h:1' } }).error?.[3], [{ issue: 'locked' }], op + ' after the save');
  assert.equal(db.vm().draft, null, 'nothing about the saved office is shown');
  for (const hook of ['verrouille', 'lecture']) {
    const other = createSetup({ hook });
    for (const op of ['check', 'discover', 'save']) {
      const r = other[op]({ ...body, runtime: { adapter: 'openclaw', gatewayUrl: 'ws://h:1' } });
      assert.equal(r.error && r.error[0], 403, `${hook}: ${op} is refused`);
      assert.equal(r.error[1], hook === 'lecture' ? 'readonly' : 'forbidden');
    }
  }
});

test('wrong codes count toward the throttle: the 7th attempt is a 429 with a Retry-After', () => {
  const db = createSetup();
  for (let i = 0; i < 6; i++) assert.equal(db.check({ setupCode: 'faux', runtime: {} }).error[0], 403);
  const e = db.check({ setupCode: SETUP_CODE, runtime: {} }).error;
  assert.deepEqual([e[0], e[1], e[4]], [429, 'rate_limited', { retryAfterSec: 30 }]);
});

test('G6: the demo runtime takes no connection: no URL or token field, check and discovery work, nothing extra is sent', () => {
  const vm = createSetup().vm();
  const demo = vm.adapters.find((a) => a.id === 'demo');
  assert.deepEqual([demo.fields, demo.defaultGatewayUrl], [[], null]);
  const s = { ...base(), code: 'AO-1', adapter: 'demo', fields: [], gatewayUrl: '', token: 'reste-d-avant' };
  assert.equal(R.blocker(R.STEPS.indexOf('runtime'), s), null, 'no gateway address is asked for');
  assert.deepEqual(R.runtimeBody(s), { adapter: 'demo' }, 'neither a URL nor a leftover token');
  assert.equal(R.blocker(R.STEPS.indexOf('runtime'), { ...s, adapter: 'openclaw', fields: ['gatewayUrl', 'token'] }), 'setup.err.url');
  const db = createSetup();
  const check = db.check({ setupCode: SETUP_CODE, runtime: { adapter: 'demo' } }).result;
  assert.deepEqual([check.ok, check.protocol], [true, null]);
  assert.equal(msg(R.checkSentence(check, { gateway: false }).key), 'Moteur prêt, aucune connexion nécessaire.');
  assert.ok(db.discover({ setupCode: SETUP_CODE, runtime: { adapter: 'demo' } }).result.agents.length > 0);
  assert.deepEqual(db.check({ setupCode: SETUP_CODE, runtime: { adapter: 'demo', gatewayUrl: 'ws://h:1' } }).error[3], [{ field: 'runtime.gatewayUrl', issue: 'unexpected-field' }]);
});

test('R22-10: the throttle releases after its Retry-After; a wrong code then counts again from zero', () => {
  let t = 1_000_000;
  const db = createSetup({ now: () => t });
  const rt = { adapter: 'openclaw', gatewayUrl: 'ws://h:1' };
  for (let i = 0; i < 6; i++) db.check({ setupCode: 'faux', runtime: rt });
  const blocked = db.check({ setupCode: SETUP_CODE, runtime: rt }).error;
  assert.equal(blocked[0], 429);
  t += 10_000;
  assert.deepEqual(db.check({ setupCode: SETUP_CODE, runtime: rt }).error[4], { retryAfterSec: 20 }, 'the wait shrinks as time passes');
  t += 20_001;
  assert.equal(db.check({ setupCode: SETUP_CODE, runtime: rt }).result.ok, true, 'after the wait the right code works');
  assert.equal(db.check({ setupCode: 'faux', runtime: rt }).error[0], 403, 'a new wrong code is a 403 again, not a 429');
});

test('mock setup routes match the G4 examples (envelopes, CommandResult, error, request bodies)', async () => {
  const server = await import('../../public/v2/mock/server.js');
  server.configure({ scenario: '1', standalone: true });
  const call = (m, p, b) => server.handle(m, p, b);
  const vmBody = (await call('GET', '/api/v2/setup')).body;
  assert.deepEqual(compareExample('setup-vm', vmBody, { envelope: true }), []);
  const runtime = { adapter: 'openclaw', gatewayUrl: 'ws://127.0.0.1:18789', token: 'jeton-de-test' };
  const checkBody = { setupCode: SETUP_CODE, runtime };
  assert.deepEqual(compareExample('setup-check-request', checkBody), []);
  assert.deepEqual(compareExample('setup-check-result', (await call('POST', '/api/v2/setup/check', checkBody)).body, { envelope: true }), []);
  assert.deepEqual(compareExample('setup-discover-result', (await call('POST', '/api/v2/setup/discover', checkBody)).body, { envelope: true }), []);
  const wrong = await call('POST', '/api/v2/setup/check', { ...checkBody, setupCode: 'faux' });
  assert.equal(wrong.status, 403);
  assert.deepEqual(compareExample('error-403-setup', wrong.body), []);
  // The body the UI builds (R.payload) for the save, with a typed password and no retyped token.
  const s = { ...base(), code: SETUP_CODE, gatewayUrl: runtime.gatewayUrl, agents: [{ id: 'atlas' }], primary: 'atlas',
    looks: { atlas: { character: 'timmy', variant: null, accessories: ['headphones'] } }, name: 'Bureau de Camille', owner: 'Camille',
    email: 'camille@example.invalid', password: 'douze-car-123', password2: 'douze-car-123', locale: 'en', timeZone: 'Europe/Paris' };
  assert.deepEqual(compareExample('setup-save-request', R.payload(s)), []);
  assert.deepEqual(R.payload(s, vmBody.data).integrations, { projet: true }, 'architect-56: the project tag, on by default');
  assert.deepEqual(compareExample('setup-save-request', R.payload(s, vmBody.data)), []);
  const saved = await call('PUT', '/api/v2/setup', R.payload(s, vmBody.data));
  assert.deepEqual(compareExample('setup-save-result', saved.body, { envelope: true }), []);
  assert.deepEqual(saved.body.data.result.integrations, { projet: { status: 'installed' } });
  const after = (await call('GET', '/api/v2/setup')).body;
  assert.deepEqual(compareExample('setup-vm', after, { envelope: true }), [], 'locked: draft null is allowed');
  assert.equal(after.data.draft, null);
});

test('architect-56 · the project tag: offered for its adapters only, opt-out in the body, every outcome has a line', () => {
  const vm = { integrations: [{ id: 'projet', adapters: ['openclaw'], default: true }] };
  assert.equal(R.offersProjet(vm, { adapter: 'openclaw' }), true);
  assert.equal(R.offersProjet(vm, { adapter: 'demo' }), false);
  assert.equal(R.offersProjet({}, { adapter: 'openclaw' }), false, 'an older server lists no integration');
  const s = { ...base(), code: SETUP_CODE, primary: 'a', projet: false };
  assert.deepEqual(R.payload(s, vm).integrations, { projet: false });
  assert.equal('integrations' in R.payload(s, {}), false, 'nothing sent to a server that offers nothing');
  const o = (r, before) => (R.projetOutcome(r, before) || {}).key;
  assert.equal(o({ status: 'installed' }, 'absent'), 'setup.tag.result.installed');
  assert.equal(o({ status: 'installed' }, 'installed'), 'setup.tag.result.already');
  assert.equal(o({ status: 'skipped', reason: 'opted-out' }), 'setup.tag.result.optedOut');
  assert.equal(o({ status: 'skipped', reason: 'agent-not-found' }), 'setup.tag.result.skipped');
  assert.equal(o({ status: 'conflict', reason: 'skill-not-ours' }), 'setup.tag.result.conflict');
  assert.equal(o({ status: 'failed', reason: 'error' }), 'setup.tag.result.failed');
  assert.equal(R.projetOutcome(null), null);
  for (const lang of ['fr', 'en']) {
    setLang(lang);
    for (const k of ['installed', 'already', 'outdated', 'conflict', 'optedOut', 'adapter', 'skipped', 'failed']) assert.ok(!msg('setup.tag.result.' + k, { agent: 'A' }).startsWith('setup.'), lang + ' ' + k);
  }
  setLang('fr');
});

test('architect-56 · the mock: discovery reports each agent’s tag, the save installs, opts out, or reports a conflict or a failure', () => {
  const rt = { adapter: 'openclaw', gatewayUrl: 'ws://127.0.0.1:18789', token: 't' };
  const body = (extra) => ({ setupCode: SETUP_CODE, instance: { name: 'B', locale: 'fr', timeZone: 'UTC' }, owner: { displayName: 'C', email: 'c@example.invalid', password: 'douze-car-123' }, runtime: rt, agents: { primary: 'atelier-agent', looks: {} }, ...extra });
  assert.deepEqual(createSetup().discover({ setupCode: SETUP_CODE, runtime: rt }).result.agents.map((a) => a.projectTag), ['absent', 'outdated']);
  assert.equal(createSetup({ hook: 'etiquette-deja' }).discover({ setupCode: SETUP_CODE, runtime: rt }).result.agents[0].projectTag, 'installed');
  assert.deepEqual(createSetup().save(body()).result.integrations.projet, { status: 'installed' });
  assert.deepEqual(createSetup().save(body({ integrations: { projet: false } })).result.integrations.projet, { status: 'skipped', reason: 'opted-out' });
  assert.equal(createSetup({ hook: 'etiquette-conflit' }).save(body()).result.integrations.projet.status, 'conflict');
  assert.equal(createSetup({ hook: 'etiquette-erreur' }).save(body()).result.integrations.projet.status, 'failed');
  assert.equal(createSetup().save(body({ integrations: { projet: 'oui' } })).error[0], 400);
});


test('modern mock onboarding endpoints: owner first, detection, reviewed per-agent installs and write-only secrets', () => {
  const db = createSetup();
  const owner = { displayName: 'Operator', email: 'owner@example.invalid', password: 'synthetic-password', passwordConfirmation: 'synthetic-password' };
  const b = { setupCode: SETUP_CODE, owner, runtime: { adapter: 'openclaw', gatewayUrl: 'ws://synthetic:1234' } };
  assert.equal(db.onboard('owner', { ...b, setupCode: 'wrong' }).error[0], 403);
  assert.equal(db.onboard('owner', b).result.owner.passwordSet, true);
  assert.ok(!JSON.stringify(db.vm()).includes(owner.password));
  assert.deepEqual(db.onboard('detect', b).result.runtimes, []);
  const p = db.onboard('integrations/plan', b).result;
  assert.equal(p.agents.length, 2);
  const apply = { ...b, planId: p.planId, agentIds: p.agents.map(a => a.id), confirmed: true };
  assert.ok(db.onboard('integrations/apply', apply).result.agents.every(a => a.status === 'installed'));
  assert.ok(db.onboard('integrations/apply', { ...apply, action: 'uninstall' }).result.agents.every(a => a.status === 'absent'));
  assert.equal(db.onboard('network', { ...b, action: 'probe' }).result.ok, true);
});
