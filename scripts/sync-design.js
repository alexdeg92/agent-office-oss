#!/usr/bin/env node
'use strict';
// Copies the Bureau design system into public/v2/bureau/ (migration-plan.md S8). A plain file copy,
// not a build: the copies are committed so production never runs this script.
//   node scripts/sync-design.js          copy (and delete stale files under the copied folders)
//   node scripts/sync-design.js --check  exit 1 if public/v2/bureau/ differs from design/
// Layout of the output:
//   public/v2/bureau/bureau.css                 ← design/css/bureau.css
//   public/v2/bureau/bundle.css                 ← design/components/bundle.css
//   public/v2/bureau/office/{manifest,layout}.example.json ← design/office/…
//   public/v2/mock/examples/*.json              ← docs/architecture/examples/ (contract examples the mocks are built from)
//   public/v2/bureau/assets/{Logos,Office,Characters,ProjectCovers,Illustrations}/…  ← design/assets/… (runtime images only)
//   public/v2/bureau/fonts/{*.woff2,OFL-*.txt} ← design/fonts/ (self-hosted fonts and their licences, which must travel with them)
//   public/v2/bureau/assets/Illustrations/*.webp ← design/derived/Illustrations/ (F10: web derivatives, design/scripts/derive-illustrations.py)
// Provenance never ships (artist-11, R14-05): prompts, tools/*.json, guides, rectification and anchor data, notes.
// They hold local paths and generation history; the app loads none of them. test/frontend/sync-design.test.js checks.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'public', 'v2', 'bureau');
const FILES = [
  ['design/css/bureau.css', 'bureau.css'],
  ['design/components/bundle.css', 'bundle.css'],
  // Office scene examples, loaded by the office demo and the app until the layout API serves them.
  ['design/office/manifest.example.json', 'office/manifest.example.json'],
  ['design/office/layout.example.json', 'office/layout.example.json'],
];
// Authoritative contract examples (api.md 2.1, docs/architecture/examples/): the /v2 mocks are built from them.
const EXAMPLES = ['project-vm', 'board-vm', 'candidates-vm', 'import-result', 'history-page', 'session-vm', 'error-409-project', 'health-vm', 'comment-thread-vm'];
const EXAMPLES_DEST = path.join(ROOT, 'public', 'v2', 'mock', 'examples');
const ASSET_GROUPS = ['Logos', 'Office', 'Characters', 'ProjectCovers', 'Illustrations'];
const DERIVED = path.join(ROOT, 'design', 'derived', 'Illustrations');
// Working files that the app never loads: alignment guides, unrectified renders, font sources, tools.
const SKIP = [/(^|\/)guides\//, /(^|\/)tools\//, /-raw\.png$/, /^Logos\/fonts\//];
// An allowlist, not a blocklist: only images the manifest and the UI can reference. No JSON, Markdown or text.
const KEEP_EXT = new Set(['.png', '.svg', '.ico', '.webp', '.jpg']);
// Composed accessory sheets and artist diagnostics. The office loads the pose the manifest names, not these.
const SKIP_SHIP = [/(^|\/)worn(\/|$)/i, /(^|\/)debug(\/|$)/i, /diagnostic/i];

function walkText(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'assets' && path.basename(dir) === 'bureau') return [];
      return walkText(p);
    }
    return /\.(js|css|html|webmanifest)$/.test(e.name) ? [p] : [];
  });
}

// Sprite paths the manifest names (`assets/Office/…`), plus UI chrome named from public/v2
// (`bureau/assets/Logos/…`, illustration file names). Relative to design/assets.
function shippedAssetKeys() {
  const keys = new Set();
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'design', 'office', 'manifest.example.json'), 'utf8'));
  const visit = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('assets/')) keys.add(value.slice('assets/'.length));
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(manifest);
  for (const pack of manifest.characterPacks?.packs ?? []) {
    const rel = pack.packManifest.replace(/^assets\//, '');
    const file = path.join(ROOT, 'design', 'assets', rel);
    keys.add(rel);
    const prefix = path.posix.dirname(rel) + '/';
    const readPack = node => {
      if (typeof node === 'string' && node.endsWith('.webp')) keys.add(prefix + node);
      else if (Array.isArray(node)) node.forEach(readPack);
      else if (node && typeof node === 'object') Object.values(node).forEach(readPack);
    };
    readPack(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  // The generated import map names the previous build's files. It cannot keep a disabled pack alive.
  const text = walkText(path.join(ROOT, 'public', 'v2')).map((file) => fs.readFileSync(file, 'utf8')
    .replace(/<script\b[^>]*type=["']importmap["'][^>]*>[\s\S]*?<\/script>/gi, '')).join('\n');
  for (const match of text.matchAll(/bureau\/assets\/([A-Za-z0-9_@./+-]+)/g)) keys.add(match[1]);
  // Lazy scene registries resolve paths against the office asset base rather than
  // naming bureau/ directly. Their declared image bundles must ship as well.
  for (const match of text.matchAll(/\bassets\/((?:Office|Characters|Logos|ProjectCovers|Illustrations)\/[A-Za-z0-9_@./+-]+)/g)) keys.add(match[1]);
  if (text.includes('bureau/assets/Logos/')) {
    const logos = path.join(ROOT, 'design', 'assets', 'Logos');
    for (const rel of walk(logos)) keys.add('Logos/' + rel);
  }
  const illus = path.join(ROOT, 'design', 'assets', 'Illustrations');
  if (fs.existsSync(illus)) {
    // Names may be built at runtime (setup's ART[step] + '.webp'), so the base name decides. F10: a referenced
    // illustration ships as its .webp derivative; the .png only where a page still names it.
    for (const name of new Set([...fs.readdirSync(illus), ...(fs.existsSync(DERIVED) ? fs.readdirSync(DERIVED) : [])])) {
      const base = name.replace(/\.[^.]+$/, '');
      if (!text.includes(base)) continue;
      keys.add('Illustrations/' + base + '.webp');
      if (text.includes(name)) keys.add('Illustrations/' + name);   // a page that still names the .png
    }
  }
  return keys;
}

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

function plan() {
  const pairs = FILES.map(([src, dst]) => [path.join(ROOT, src), path.join(DEST, dst)]);
  for (const e of EXAMPLES) pairs.push([path.join(ROOT, 'docs', 'architecture', 'examples', e + '.json'), path.join(EXAMPLES_DEST, e + '.json')]);
  const shipped = shippedAssetKeys();
  for (const g of ASSET_GROUPS) {
    const srcDir = path.join(ROOT, 'design', 'assets', g);
    for (const rel of walk(srcDir)) {
      const key = g + '/' + rel;
      if (SKIP.some((re) => re.test(key)) || SKIP_SHIP.some((re) => re.test(key))) continue;
      if (!KEEP_EXT.has(path.extname(rel).toLowerCase()) && !/^Characters\/[a-z][a-z0-9-]*\/manifest\.json$/.test(key)) continue;
      if (!shipped.has(key)) continue;
      pairs.push([path.join(srcDir, rel), path.join(DEST, 'assets', g, rel)]);
    }
  }
  const fonts = path.join(ROOT, 'design', 'fonts');
  for (const name of fs.existsSync(fonts) ? fs.readdirSync(fonts) : []) {
    if (/\.woff2$/.test(name) || /^OFL-[\w-]+\.txt$/.test(name)) pairs.push([path.join(fonts, name), path.join(DEST, 'fonts', name)]);
  }
  for (const name of fs.existsSync(DERIVED) ? fs.readdirSync(DERIVED) : []) {
    // A WebP the artist supplies (design/assets/Illustrations/<name>.webp) wins over a derivative of the same name.
    if (fs.existsSync(path.join(ROOT, 'design', 'assets', 'Illustrations', name))) continue;
    if (name.endsWith('.webp') && shipped.has('Illustrations/' + name)) pairs.push([path.join(DERIVED, name), path.join(DEST, 'assets', 'Illustrations', name)]);
  }
  return pairs;
}

function same(a, b) {
  if (!fs.existsSync(b)) return false;
  const sa = fs.statSync(a), sb = fs.statSync(b);
  return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
}

function main() {
  const check = process.argv.includes('--check');
  const pairs = plan();
  const wanted = new Set(pairs.map(([, d]) => d));
  const stale = [...FILES.map(([, d]) => path.join(DEST, d)), ...walk(path.join(DEST, 'assets')).map((r) => path.join(DEST, 'assets', r)), ...walk(path.join(DEST, 'fonts')).map((r) => path.join(DEST, 'fonts', r))]
    .filter((d) => fs.existsSync(d) && !wanted.has(d));
  const changed = pairs.filter(([s, d]) => !same(s, d));

  if (check) {
    for (const [, d] of changed) console.log('out of date: ' + path.relative(ROOT, d));
    for (const d of stale) console.log('stale: ' + path.relative(ROOT, d));
    if (changed.length || stale.length) { console.log('Run: node scripts/sync-design.js'); process.exit(1); }
    console.log(`public/v2/bureau is in sync (${pairs.length} files).`);
    return;
  }
  for (const [s, d] of changed) { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); }
  for (const d of stale) fs.rmSync(d);
  // Remove folders left empty by deletions.
  const prune = (dir) => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) prune(path.join(dir, e.name)); if (dir !== DEST && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); };
  prune(DEST);
  console.log(`sync-design: ${pairs.length} files, ${changed.length} copied, ${stale.length} removed → ${path.relative(ROOT, DEST)}/`);
}

if (require.main === module) main();
module.exports = { plan, DEST };
