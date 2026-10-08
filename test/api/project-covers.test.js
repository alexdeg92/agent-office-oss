'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScenario } = require('../helpers/scenario');
const { startServer, waitFor } = require('../helpers/harness');
const { createRasterizer } = require('../../src/projects/covers/raster');
const { LIMITS } = require('../../src/projects/covers/code');
const sc = loadScenario('synthetic-basic');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEVbW/bKAi89AAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==';
const view = async (h, id) => (await h.get('/api/v2/views/projects/' + id)).json.data;
async function create(h) { const r = await h.request('POST', '/api/v2/projects', { name: 'Bureau', summary: 'Site web' }); assert.equal(r.status, 200, r.text); return r.json.data.vm; }
async function covered(h, p) { await waitFor(async () => (await view(h, p.id)).cover, { what: 'generated cover' }); return view(h, p.id); }
describe('project covers HTTP: lifecycle, VM, media, conditional caching, upload and guards', () => {
  let h, p;
  before(async () => { h = await startServer(sc, { readonly: true }); p = await covered(h, await create(h)); });
  after(async () => { if (h) await h.stop(); });
  it('creates code cover on an OpenClaw read-only runtime and publishes detail/board on both API versions', async () => {
    assert.equal(p.cover.source, 'code'); assert.equal(p.thumb.kind, 'cover');
    assert.match(p.cover.url, /^\/api\/v2\/project-covers\/[a-f0-9]{64}\.svg$/);
    for (const v of [2, 3]) {
      const board = await h.get('/api/v' + v + '/views/projects'); assert.equal(board.status, 200, board.text);
      const card = board.json.data.columns.flatMap((c) => c.cards).find((c) => c.id === p.id); assert.deepEqual(card.cover, p.cover);
      const detail = await h.get('/api/v' + v + '/views/projects/' + p.id); assert.deepEqual(detail.json.data.cover, p.cover);
    }
    assert.ok(!h.cliCalls().some((a) => a[0] === 'agent'));
  });
  it('serves bounded images with authenticated immutable caching, content ETag, HEAD and conditional 304', async () => {
    for (const [url, width, height, budget] of [[p.cover.url, 480, 270, LIMITS.cover], [p.cover.thumbUrl, 160, 90, LIMITS.thumb]]) {
      const r = await h.get(url); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
      assert.match(r.headers.get('cache-control'), /private, max-age=31536000, immutable/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.match(r.headers.get('content-security-policy'), /sandbox/);
      assert.ok(Buffer.byteLength(r.text) <= budget); assert.match(r.text, new RegExp(`width="${width}" height="${height}"`));
      const etag = r.headers.get('etag'); assert.match(etag, /^"[a-f0-9]{64}"$/);
      const cached = await fetch(h.base + url, { headers: { cookie: h.cookie, 'if-none-match': 'W/' + etag } }); assert.equal(cached.status, 304); assert.equal(await cached.text(), '');
      const head = await fetch(h.base + url, { method: 'HEAD', headers: { cookie: h.cookie } }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
      assert.equal((await fetch(h.base + url)).status, 401);
    }
    assert.equal((await h.get('/api/v2/project-covers/not-a-hash.svg')).status, 404);
    assert.equal((await h.get('/api/v2/project-covers/' + 'f'.repeat(64) + '.svg')).status, 404);
  });
  it('summary change refreshes the cover; label type changes refresh the motif; status-only does not refresh', async () => {
    let r = await h.request('PATCH', '/api/v2/projects/' + p.id, { expectedRevision: p.revision, summary: 'Une infolettre pour le Bureau' }); assert.equal(r.status, 200, r.text);
    await waitFor(async () => (await view(h, p.id)).cover.url !== p.cover.url); p = await view(h, p.id);
    const old = p.cover.url;
    r = await h.request('POST', '/api/v2/projects/' + p.id + '/flags', { expectedRevision: p.revision, kind: 'label', label: 'ops' }); assert.equal(r.status, 200, r.text);
    await waitFor(async () => (await view(h, p.id)).cover.url !== old); p = await view(h, p.id);
    const at = p.cover.generatedAt, image = p.cover.url;
    r = await h.request('PUT', '/api/v2/projects/' + p.id + '/status', { expectedRevision: p.revision, status: 'shipped' }); assert.equal(r.status, 200, r.text);
    p = await view(h, p.id); assert.equal(p.cover.url, image); assert.equal(p.cover.generatedAt, at);
    const regen = await h.request('POST', '/api/v2/projects/' + p.id + '/cover/regenerate', { expectedRevision: p.revision }); assert.equal(regen.status, 202); assert.equal(regen.json.data.result.queued, true);
    assert.equal((await h.request('POST', '/api/v2/projects/' + p.id + '/cover/regenerate', { expectedRevision: 0 })).status, 409);
    assert.equal((await h.request('POST', '/api/v2/projects/' + p.id + '/cover/regenerate', {})).status, 400);
    assert.equal((await h.request('POST', '/api/v2/projects/prj_nope/cover/regenerate', { expectedRevision: 1 })).status, 404);
  });
  it('manual raster upload has priority and records its audit, including regeneration and upload commands', async (t) => {
    if (!createRasterizer()) { t.skip('optional ImageMagick unavailable'); return; }
    const upload = await h.request('PUT', '/api/v2/projects/' + p.id + '/cover', { expectedRevision: p.revision, image: png }); assert.equal(upload.status, 200, upload.text);
    p = upload.json.data.vm; assert.equal(p.cover.source, 'upload'); assert.match(p.cover.url, /\.webp$/);
    assert.ok((await h.get(p.cover.url)).headers.get('content-type').includes('image/webp'));
    const changed = await h.request('PATCH', '/api/v2/projects/' + p.id, { expectedRevision: p.revision, summary: 'Une nouvelle application' }); assert.equal(changed.status, 200, changed.text);
    assert.deepEqual(changed.json.data.vm.cover, p.cover);
    const regen = await h.request('POST', '/api/v2/projects/' + p.id + '/cover/regenerate', { expectedRevision: changed.json.data.vm.revision }); assert.equal(regen.status, 202); assert.equal(regen.json.data.result.queued, false);
    const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(h.tmp, 'data', 'agent-office.sqlite'), { readOnly: true });
    try { const commands = db.prepare('SELECT command FROM audit_log').all().map((r) => r.command); assert.ok(commands.includes('projects.regenerateCover')); assert.ok(commands.includes('projects.uploadCover')); } finally { db.close(); }
  });
  it('rejects SVG, URLs, unknown body fields and oversized upload data', async () => {
    const revision = (await view(h, p.id)).revision;
    for (const image of ['https://host/image.png', Buffer.from('<svg/>').toString('base64'), 'x'.repeat(65540)]) {
      assert.equal((await h.request('PUT', '/api/v2/projects/' + p.id + '/cover', { expectedRevision: revision, image })).status, 400);
    }
    assert.equal((await h.request('POST', '/api/v2/projects/' + p.id + '/cover/regenerate', { expectedRevision: revision, actor: 'x' })).status, 400);
  });
});
describe('project covers store read-only guard and configured public media URLs', () => {
  it('read-only store creates no covers or agent turns and refuses regenerate/upload', async () => {
    const h = await startServer(sc, { env: { PORTAL_READONLY_STORE: '1' }, readonly: true });
    try {
      assert.equal(fs.existsSync(path.join(h.tmp, 'data', 'project-covers')), false);
      assert.equal((await h.request('POST', '/api/v2/projects/prj_nope/cover/regenerate', { expectedRevision: 1 })).status, 403);
      assert.equal((await h.request('PUT', '/api/v2/projects/prj_nope/cover', { expectedRevision: 1, image: png })).status, 403);
      assert.ok(!h.cliCalls().some((a) => a[0] === 'agent'));
    } finally { await h.stop(); }
  });
  it('media URLs use configured origin and /backend prefix', async () => {
    const h = await startServer(sc, { readonly: true, env: { AO_PUBLIC_URL: 'https://bureau.example', AO_PUBLIC_API_BASE: '/backend' } });
    try { const p = await covered(h, await create(h)); assert.match(p.cover.url, /^https:\/\/bureau.example\/backend\/api\/v2\/project-covers\//); assert.match(p.cover.thumbUrl, /^https:\/\/bureau.example\/backend\//); }
    finally { await h.stop(); }
  });
});
