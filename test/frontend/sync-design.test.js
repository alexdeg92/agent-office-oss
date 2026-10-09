// public/v2/bureau ships runtime assets only (artist-11, review R14-05): no provenance file (prompts, tools/*.json,
// guides, rectification/anchor data, notes) and no local path anywhere, in what sync-design plans or what is on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import sync from '../../scripts/sync-design.js';

const RUNTIME_EXT = new Set(['.png', '.svg', '.ico', '.webp', '.jpg']);
const PROVENANCE = [/\.md$/i, /\.txt$/i, /(^|\/)tools\//, /(^|\/)guides\//, /rectification/i, /anchors\.json$/, /prompts?/i, /-raw\.png$/];
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const rel = (f) => relative(sync.DEST, f).split('\\').join('/');
// The only non-image files allowed: the two stylesheets and the office scene examples.
const ALLOWED_OTHER = new Set(['bureau.css', 'bundle.css', 'office/manifest.example.json', 'office/layout.example.json']);

function offenders(files) {
  return files.map(rel).filter((r) => {
    if (r.startsWith('../')) return false;   // mock/examples: contract examples, not design assets
    if (/^fonts\/([\w-]+\.woff2|OFL-[\w-]+\.txt)$/.test(r)) return false;   // self-hosted fonts and the licence the OFL requires with them
    if (/^assets\/Characters\/[a-z][a-z0-9-]*\/manifest\.json$/.test(r)) return false;
    if (PROVENANCE.some((re) => re.test(r))) return true;
    return !ALLOWED_OTHER.has(r) && !RUNTIME_EXT.has(extname(r).toLowerCase());
  });
}

test('sync-design plans runtime assets only (no provenance, no data files under assets/)', () => {
  const planned = sync.plan().map(([, d]) => d);
  assert.deepEqual(offenders(planned), []);
  const worn = planned.map(rel).filter((r) => /(^|\/)worn(\/|$)/i.test(r) || /(^|\/)debug(\/|$)/i.test(r) || /diagnostic/i.test(r));
  assert.deepEqual(worn, []);
});

test('planned and shipped pack manifests match the enabled registry, including after a pack is disabled', () => {
  const manifest=JSON.parse(readFileSync(new URL('../../design/office/manifest.example.json',import.meta.url)));
  const expected=manifest.characterPacks.packs.map(p=>p.id).sort();
  const ids=files=>files.map(rel).flatMap(r=>{const m=/^assets\/Characters\/([a-z][a-z0-9-]*)\/manifest\.json$/.exec(r);return m?[m[1]]:[];}).sort();
  assert.deepEqual(ids(sync.plan().map(([,d])=>d)),expected);
  assert.deepEqual(ids(walk(sync.DEST)),expected);
});

test('public/v2/bureau on disk holds no provenance file and no local path (/home/) in any file, binary included', () => {
  const files = walk(sync.DEST);
  if (!files.length) return;   // not synced in this checkout: the plan test above still applies
  assert.deepEqual(offenders(files), []);
  const leaks = files.filter((f) => readFileSync(f).includes('/home/')).map(rel);
  assert.deepEqual(leaks, [], 'local paths must never ship');
});

test('F10: every illustration has a fresh .webp derivative (sources unchanged since derive-illustrations.py), and the UI names only derivatives', async () => {
  const { createHash } = await import('node:crypto');
  const fsm = await import('node:fs');
  const pathm = await import('node:path');
  const root = pathm.join(pathm.dirname(new URL(import.meta.url).pathname), '..', '..');
  const derived = pathm.join(root, 'design', 'derived', 'Illustrations');
  const manifest = JSON.parse(fsm.readFileSync(pathm.join(derived, 'manifest.json'), 'utf8')).files;
  const sources = fsm.readdirSync(pathm.join(root, 'design', 'assets', 'Illustrations')).filter((n) => n.endsWith('.png') && !n.endsWith('-raw.png'));
  const stale = [];
  for (const png of sources) {
    const webp = png.replace(/\.png$/, '.webp');
    const sha = createHash('sha256').update(fsm.readFileSync(pathm.join(root, 'design', 'assets', 'Illustrations', png))).digest('hex');
    if (!manifest[webp] || manifest[webp].sha256 !== sha || !fsm.existsSync(pathm.join(derived, webp))) stale.push(webp);
  }
  assert.deepEqual(stale, [], 'run: python3 design/scripts/derive-illustrations.py');
  const mine = ['app.css', 'components/ui.js', 'pages/setup.js', 'pages/access.js', 'pages/journaux.js', 'pages/import.js', 'pages/chat.js', 'pages/projects.js']
    .map((f) => fsm.readFileSync(pathm.join(root, 'public', 'v2', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
  assert.deepEqual([...mine.matchAll(/Illustrations\/[\w-]+\.png/g)].map((m) => m[0]), [], 'illustrations load as WebP');
  // Each .webp the UI names is a derivative, or a WebP the artist supplies directly (artist-15 state spots).
  const supplied = (n) => fsm.existsSync(pathm.join(root, 'design', 'assets', 'Illustrations', n));
  for (const m of mine.matchAll(/(?:Illustrations\/|')([\w-]+\.webp)/g)) assert.ok(manifest[m[1]] || supplied(m[1]), m[1]);
});
