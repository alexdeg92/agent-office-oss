import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configure } from '../../public/v2/config.js';
import { safeReturn, inApp, parse, href, withSticky, activeTab, activeNav, NAV, BOTTOM_TABS, routeByName } from '../../public/v2/router.js';

// The cases below run with the UI mounted at /v2/ (dev/staging); the F7 block at the end re-runs the essentials at /.
configure({ basePath: '/v2/', apiBase: '' });

test('parse: root and /v2 go to the default route', () => {
  assert.equal(parse('/v2').name, 'bureau');
  assert.equal(parse('/v2/').name, 'bureau');
});

test('parse: static and param routes, query kept', () => {
  const m = parse('/v2/sante', '?gravite=warn&probleme=iss_1');
  assert.equal(m.name, 'sante');
  assert.deepEqual(m.query, { gravite: 'warn', probleme: 'iss_1' });
  const p = parse('/v2/projets/prj_abc');
  assert.equal(p.name, 'projet');
  assert.deepEqual(p.params, { projectId: 'prj_abc' });
  assert.equal(parse('/v2/projets/prj_abc/').name, 'projet');
});

test('parse: params are decoded (session keys contain colons)', () => {
  const m = parse('/v2/journaux/' + encodeURIComponent('agent:main:discord:42'));
  assert.equal(m.name, 'session');
  assert.equal(m.params.sessionKey, 'agent:main:discord:42');
});

test('parse: unknown paths and malformed escapes → introuvable', () => {
  assert.equal(parse('/v2/nimporte/quoi').name, 'introuvable');
  assert.equal(parse('/v2/projets/%E0%A4%A').name, 'introuvable');
});

test('href round-trips through parse', () => {
  const url = href('session', { sessionKey: 'agent:main:a/b' }, { vue: 'arbre', vide: '', nul: null });
  assert.equal(url, '/v2/journaux/agent%3Amain%3Aa%2Fb?vue=arbre');
  const [path, qs] = url.split('?');
  const m = parse(path, '?' + qs);
  assert.equal(m.params.sessionKey, 'agent:main:a/b');
  assert.deepEqual(m.query, { vue: 'arbre' });
});

test('href throws on unknown route or missing param', () => {
  assert.throws(() => href('nope'));
  assert.throws(() => href('projet', {}));
});

test('withSticky keeps mock mode across navigation without overriding', () => {
  assert.equal(withSticky('/v2/sante', '?mock=1&gravite=warn'), '/v2/sante?mock=1');
  assert.equal(withSticky('/v2/sante?mock=vide', '?mock=1'), '/v2/sante?mock=vide');
  assert.equal(withSticky('/v2/sante', ''), '/v2/sante');
});

test('detail pages light their parent in the sidebar and bottom bar', () => {
  const m = parse('/v2/flux/job_1');
  assert.equal(activeNav(m), 'flux');
  assert.equal(activeTab(m), 'plus'); // Flux de travail lives under Plus on mobile (BRIEF decisions log)
  assert.equal(activeTab(parse('/v2/projets/prj_1')), 'projets');
  assert.equal(activeNav(parse('/v2/x/y')), null);
});

test('navigation matches the decisions log', () => {
  assert.deepEqual(NAV.map((r) => r.label), ['Bureau', 'Discuter', 'Flux de travail', 'Projets', 'Habilitations', 'Journaux', 'Compétences', 'Santé système', 'Boutique']);   // Boutique: office-dev-21 (PM, 2026-10-07)
  assert.deepEqual(BOTTOM_TABS.map((n) => routeByName(n).label), ['Bureau', 'Discuter', 'Projets', 'Journaux', 'Plus']);
});

test('/projets/importer is the import screen, not a project id', () => {
  assert.equal(parse('/v2/projets/importer').name, 'importer');
  assert.equal(parse('/v2/projets/prj_importer').name, 'projet');
  assert.equal(activeNav(parse('/v2/projets/importer', '?source=github')), 'projets');
});

test('safeReturn: same-origin /v2 paths only, normalised, never the login page', () => {
  const o = 'https://exemple.ca';
  assert.equal(safeReturn('/v2/sante?mock=1', o), '/v2/sante?mock=1');
  assert.equal(safeReturn('/v2/../admin', o), null, 'dot segments cannot escape /v2');
  assert.equal(safeReturn('/v2/x/../connexion', o), null, 'nor normalise back to the login page');
  assert.equal(safeReturn('//evil.example/v2/x', o), null, 'protocol-relative');
  assert.equal(safeReturn('https://evil.example/v2/x', o), null);
  assert.equal(safeReturn('/v2/connexion?suite=/v2/x', o), null);
  assert.equal(safeReturn('', o), null);
  assert.equal(safeReturn('/v2/projets/./prj_a', o), '/v2/projets/prj_a');
});

test('F7: the same routes at basePath / (production), API prefix excluded from the app', () => {
  configure({ basePath: '/', apiBase: '/backend' });
  try {
    assert.equal(parse('/').name, 'bureau');
    assert.equal(parse('/projets/prj_abc').params.projectId, 'prj_abc');
    assert.equal(href('session', { sessionKey: 'agent:main:a/b' }), '/journaux/agent%3Amain%3Aa%2Fb');
    assert.equal(parse(href('competence', { skillName: 'météo' })).params.skillName, 'météo');
    assert.equal(parse('/v2/sante').name, 'introuvable', 'no /v2 left at the root');
    const o = 'https://agent.exemple.ca';
    assert.equal(safeReturn('/sante?mock=1', o), '/sante?mock=1');
    assert.equal(safeReturn('/connexion?suite=/x', o), null);
    assert.equal(safeReturn('/backend/api/logout', o), null, 'never return into the API');
    assert.equal(inApp('/backend'), false);
    assert.equal(inApp('/backendx'), true);
    assert.equal(safeReturn('/../sante', o), '/sante');
  } finally {
    configure({ basePath: '/v2/', apiBase: '' });
  }
});

test('F7: at /v2/ nothing outside the mount point is in the app', () => {
  assert.equal(inApp('/v2'), true);
  assert.equal(inApp('/v2x/sante'), false);
  assert.equal(parse('/v2x/sante').name, 'introuvable');
  assert.equal(safeReturn('/sante', 'https://h.example'), null);
});
