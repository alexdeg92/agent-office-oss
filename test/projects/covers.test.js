'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classify, fingerprint } = require('../../src/projects/covers/classify');
const { generateCode, LIMITS } = require('../../src/projects/covers/code');
const { createCoverEngine } = require('../../src/projects/covers/engine');
const { createCoverStore } = require('../../src/projects/covers/store');
const { createRasterizer, rasterKind } = require('../../src/projects/covers/raster');
const { bind: commands } = require('../../src/adapters/openclaw/commands');
const { tapCli } = require('../../src/adapters/openclaw/taps');
const { buildBoardVM, buildProjectVM } = require('../../src/projects/vm');
const { createVmCheck } = require('../../src/api/v2/vm/check');
const { compareExample } = require('../helpers/contract-shape');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await wait(10); } throw new Error('timed out'); }
const project = (id = 'prj_cover', extra = {}) => ({ id, name: 'Site Bureau', summary: 'Créer un site web pour une équipe.', status: 'todo', priority: 'P2', flags: [], sources: [], people: [], revision: 1, summaryMeta: null, createdAt: 1, lastActivityAt: 1, archivedAt: null, ...extra });
function setup(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-covers-'));
  const projects = new Map([['prj_cover', project()]]);
  const engine = createCoverEngine({ dataDir, getProject: (id) => projects.get(id), debounceMs: 15, timeoutMs: 150, rasterize: null, ...options });
  t.after(() => { engine.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { engine, projects, dataDir };
}
test('classification: French/English types, labels outrank content, sources participate, no accidental substrings', () => {
  for (const [text, type] of [['site web', 'website'], ['infolettre', 'newsletter'], ['application PWA', 'app'], ['Données SQL', 'data'], ['documentation', 'doc'], ['déploiement', 'ops'], ['campagne marketing', 'marketing'], ['bogue régression', 'bug'], ['Projet personnel', 'project']]) {
    assert.equal(classify(project('p', { name: 'Nouveau projet', summary: text })), type, text);
  }
  assert.equal(classify(project('p', { name: 'Données', summary: 'documentation', flags: [{ kind: 'label', label: 'infolettre' }] })), 'newsletter');
  assert.equal(classify(project('p', { name: 'Nouveau', summary: '', sources: [{ kind: 'workspace', ref: { path: 'newsletter' } }] })), 'newsletter');
  assert.equal(classify(project('p', { name: 'Happy', summary: 'Capital' })), 'project');
  assert.equal(fingerprint(project()), fingerprint(project('prj_cover', { status: 'shipped' })));
  assert.notEqual(fingerprint(project()), fingerprint(project('prj_cover', { summary: 'Une infolettre' })));
});
test('code: deterministic slug seed, all motifs, low resolution/budgets, literal escaped title without monogram', () => {
  for (const summary of ['site web', 'infolettre', 'application', 'data', 'documentation', 'ops', 'marketing', 'bug', 'personnel']) {
    const p = project('p', { name: 'Bureau <script> & été', summary });
    const a = generateCode(p), b = generateCode({ ...p });
    assert.deepEqual(a, b); assert.ok(a.cover.length <= LIMITS.cover); assert.ok(a.thumb.length <= LIMITS.thumb);
    assert.match(a.cover.toString(), /width="480" height="270"/); assert.match(a.thumb.toString(), /width="160" height="90"/);
    assert.match(a.cover.toString(), /&lt;script&gt; &amp; été/); assert.doesNotMatch(a.cover.toString(), /<script>|<image|href=|initials|monogram/);
    assert.notDeepEqual(a, generateCode({ ...p, sources: [{ kind: 'sessionGroup', ref: { groupId: 'projet:autre', name: 'autre' } }] }));
  }
  assert.ok(generateCode(project('p', { name: 'é'.repeat(80) })).thumb.length <= LIMITS.thumb);
});
test('queue: debounce newest inputs, serialize all projects, preserve revisions and skip status-only refresh', async (t) => {
  let running = 0, max = 0, calls = [];
  const { engine, projects } = setup(t, { generators: [{ id: 'code', supports: () => true, async generate({ project: p }) { running++; max = Math.max(max, running); calls.push(p.summary); await wait(25); running--; return generateCode(p); } }] });
  engine.observe(projects.get('prj_cover'));
  projects.set('prj_cover', project('prj_cover', { summary: 'Une infolettre' })); engine.observe(projects.get('prj_cover'));
  projects.set('prj_other', project('prj_other')); engine.observe(projects.get('prj_other'));
  await until(() => engine.pending === 0);
  assert.equal(max, 1); assert.deepEqual(calls, ['Une infolettre', 'Créer un site web pour une équipe.']);
  assert.equal(projects.get('prj_cover').revision, 1);
  projects.get('prj_cover').status = 'shipped'; assert.equal(engine.observe(projects.get('prj_cover')), false);
  assert.equal(engine.vm('prj_cover').source, 'code');
});
test('queue: failed/oversized agent generators and timed-out discovery fall back to code', async (t) => {
  for (const plugin of [
    { supports() { throw new Error('failure'); } },
    { supports: () => true, generate: () => ({ cover: Buffer.alloc(26000), thumb: Buffer.alloc(1), ext: 'webp' }) },
    { supports: () => new Promise(() => {}), generate: () => { throw new Error('must not run'); } },
  ]) {
    const { engine } = setup(t, { timeoutMs: 25, generators: [{ id: 'agent', ...plugin }] });
    engine.observe(project()); await until(() => engine.pending === 0); assert.equal(engine.vm('prj_cover').source, 'code');
  }
});
test('queue: abort a slow agent on timeout; discard stale output and generate latest summary', async (t) => {
  let aborted = 0;
  const { engine, projects } = setup(t, { timeoutMs: 50, generators: [{ id: 'agent', supports: () => true,
    generate: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }, { once: true })) }] });
  engine.observe(project()); await until(() => engine.pending === 1); await wait(20);
  projects.set('prj_cover', project('prj_cover', { summary: 'Infolettre récente' })); engine.observe(projects.get('prj_cover'));
  await until(() => engine.pending === 0);
  assert.ok(aborted >= 1); assert.equal(engine.store.get('prj_cover').fingerprint, fingerprint(projects.get('prj_cover')));
});
test('manual upload wins over an active generation, automatic changes and regeneration; persists after restart', async (t) => {
  const { engine, projects, dataDir } = setup(t, { rasterize: async () => generateCode(project('p', { name: 'Image choisie' })),
    generators: [{ id: 'agent', supports: () => true, async generate({ project: p }) { await wait(50); return generateCode(p); } }] });
  engine.observe(project()); await wait(25);
  await engine.upload('prj_cover', Buffer.from('fake-raster'));
  assert.equal(engine.vm('prj_cover').source, 'upload');
  projects.get('prj_cover').summary = 'Nouvelle documentation'; assert.equal(engine.observe(projects.get('prj_cover')), false);
  assert.equal(engine.regenerate('prj_cover'), false);
  const restored = createCoverStore({ dataDir, writable: false }); assert.deepEqual(restored.vm('prj_cover'), engine.vm('prj_cover'));
  assert.ok(restored.read(restored.get('prj_cover').file)); assert.equal(restored.read('../x'), null);
});
test('read-only store does not enqueue, call the runtime or create files; close aborts work', async (t) => {
  const { engine, dataDir } = setup(t, { writable: false });
  assert.equal(engine.observe(project()), false); assert.equal(engine.pending, 0); assert.equal(fs.existsSync(path.join(dataDir, 'project-covers')), false);
  await assert.rejects(engine.upload('prj_cover', Buffer.from('fake')), /readonly/);
  const active = setup(t, { generators: [{ id: 'agent', supports: () => new Promise(() => {}) }] });
  active.engine.observe(project()); await wait(30); active.engine.close(); await until(() => active.engine.pending === 0);
  assert.equal(active.engine.vm('prj_cover'), null);
});
test('VM: cover fields on board/detail obey both runtime schemas and example sidecars', () => {
  const cover = { url: 'https://bureau.example/a.svg', thumbUrl: 'https://bureau.example/t.svg', source: 'code', generatedAt: 123 };
  const options = { coverOf: () => cover };
  const p = project(), board = buildBoardVM([p], options), detail = buildProjectVM(p, [], options);
  assert.deepEqual(detail.cover, cover); assert.equal(detail.thumb.kind, 'cover'); assert.equal(detail.thumb.url, cover.url);
  assert.deepEqual(board.columns[1].cards[0].cover, cover);
  for (const version of [2, 3]) {
    const check = createVmCheck({ mode: 'throw', version });
    assert.deepEqual(check.issuesOf('project', detail), []); assert.deepEqual(check.issuesOf('projects', version === 3 ? { ...board, agent: null } : board), []);
  }
  assert.deepEqual(compareExample('project-vm', detail), []); assert.deepEqual(compareExample('board-vm', board), []);
});
test('agentTurn returns media files and tap preserves abort options without polluting primary skills', async () => {
  const calls = []; const cli = { async run(args, ms, options) {
    calls.push({ args, options });
    if (args[0] === 'gateway') {
      const p = JSON.parse(args.find(a => a.startsWith('--params=')).slice(9));
      return { ok: true, out: JSON.stringify({ ok: true, key: p.key, entry: { sendPolicy: 'deny' } }) };
    }
    return { ok: true, out: '{"result":{"payloads":[{"text":"Done","mediaUrl":"/tmp/image.webp"}]}}' };
  }, parseJson: JSON.parse };
  let ingested = 0; tapCli(cli, { ingest: () => ingested++ });
  const signal = new AbortController().signal;
  const out = await commands(cli).agentTurn({ agentId: 'artist', text: 'Image', sessionRef: 'agent:artist:ao-projet-bureau', timeoutMs: 1234, signal });
  assert.deepEqual(out.files, ['/tmp/image.webp']); assert.equal(calls[1].options.signal, signal);
  assert.ok(calls[1].args.includes('--channel=webchat')); assert.ok(calls[1].args.includes('--reply-channel=webchat'));
  assert.ok(!calls[1].args.some((a) => /^--(?:deliver|to|reply-to)=?/.test(a)));
  await cli.run(['skills', 'list', '--agent', 'artist', '--json'], 1000, { signal, background: true }); assert.equal(ingested, 0);
});
test('local raster normalization produces bounded WebP cover/thumbnail and rejects SVG/network input', async (t) => {
  const rasterize = createRasterizer(); if (!rasterize) { t.skip('ImageMagick is optional'); return; }
  // A valid 1×1 PNG, resized by the production codec path.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEVbW/bKAi89AAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==', 'base64');
  const result = await rasterize(png); assert.equal(result.ext, 'webp'); assert.equal(rasterKind(result.cover), 'webp');
  assert.ok(result.cover.length <= LIMITS.cover); assert.ok(result.thumb.length <= LIMITS.thumb);
  await assert.rejects(rasterize(Buffer.from('<svg><image href="https://host"/></svg>')), /invalid-raster/);
});
test('cover generation is silent: no image, agent, delivery or message tool is invoked', async (t) => {
  const calls = [];
  const runtime = {
    async imageGenerators() { calls.push('imageGenerators'); throw new Error('must not run'); },
    commands: {
      async agentTurn() { calls.push('agentTurn'); throw new Error('must not run'); },
      async message() { calls.push('message'); throw new Error('must not run'); },
      async sendMessage() { calls.push('sendMessage'); throw new Error('must not run'); },
    },
  };
  const { engine } = setup(t, { runtime });
  engine.observe(project()); await until(() => engine.pending === 0);
  assert.deepEqual(calls, []);
  assert.equal(engine.vm('prj_cover').source, 'code');
});
test('failed manual upload during first generation releases priority and restores the automatic cover', async (t) => {
  const { engine } = setup(t, { rasterize: async () => { throw new Error('invalid'); }, generators: [{ id: 'code', supports: () => true, async generate({ project: p }) { await wait(40); return generateCode(p); } }] });
  engine.observe(project()); await wait(25);
  await assert.rejects(engine.upload('prj_cover', Buffer.from('invalid')), /cover-failed/);
  await until(() => engine.pending === 0); assert.equal(engine.vm('prj_cover').source, 'code');
});
