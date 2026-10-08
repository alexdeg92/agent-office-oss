// F13: third-party notices (public/v2/third-party.json, shown on « À propos »). Every vendored file the UI ships has
// an entry with its licence text; development-only tools (devDependencies, e.g. axe-core) are never listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../public/v2/', import.meta.url).pathname;
const { entries } = JSON.parse(readFileSync(join(ROOT, 'third-party.json'), 'utf8'));
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const rel = (f) => relative(ROOT, f).split('\\').join('/');
const LICENCE_MARK = { MIT: /MIT License/i, 'Apache-2.0': /Apache License[\s\S]*Version 2\.0/i, ISC: /ISC License/i, 'OFL-1.1': /SIL OPEN FONT LICENSE Version 1\.1/i };

test('every vendored file the UI ships has a notice: vendor/, the self-hosted fonts, the Lucide sprite', () => {
  const listed = new Set(entries.flatMap((e) => e.files));
  const shipped = [
    ...walk(join(ROOT, 'vendor')).map(rel).filter((f) => !/^vendor\/(VENDOR\.md|licenses\/)/.test(f)),
    ...walk(join(ROOT, 'bureau', 'fonts')).map(rel).filter((f) => f.endsWith('.woff2')),
    'icons.js',
  ];
  assert.ok(shipped.length >= 10, shipped.join());
  assert.deepEqual(shipped.filter((f) => !listed.has(f)), [], 'add an entry to public/v2/third-party.json');
});

test('each notice is complete: files exist, a known licence, its text ships and matches', () => {
  for (const e of entries) {
    assert.ok(e.name && e.version && e.licence, JSON.stringify(e));
    for (const f of e.files) assert.ok(existsSync(join(ROOT, f)), `${e.name}: ${f} is listed but missing`);
    assert.ok(LICENCE_MARK[e.licence], `${e.name}: unknown licence ${e.licence}`);
    const text = readFileSync(join(ROOT, e.licenceFile), 'utf8');
    assert.ok(statSync(join(ROOT, e.licenceFile)).size > 200, `${e.name}: licence text too short`);
    assert.match(text, LICENCE_MARK[e.licence], `${e.name}: ${e.licenceFile} is not the ${e.licence} text`);
  }
});

test('development-only tools are not listed (axe-core is a devDependency, never shipped)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const dev = Object.keys(pkg.devDependencies || {});
  assert.ok(dev.includes('axe-core'));
  const names = entries.map((e) => e.name.toLowerCase());
  assert.deepEqual(dev.filter((d) => names.some((n) => n.includes(d.toLowerCase()) || n.includes('axe'))), []);
  assert.deepEqual(walk(ROOT).map(rel).filter((f) => /axe/i.test(f) && !f.startsWith('bureau/assets/')), [], 'no axe file under public/v2');
});
