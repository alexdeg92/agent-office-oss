'use strict';
// Fail if an npm pack file list contains local captures, instance files, or env files.
//   node packaging/check-pack.js pack.json
// pack.json is the stdout of `npm pack --dry-run --json`.

const fs = require('node:fs');

// Compressed tarball. 15 MB would drop login art or office sprites (those pngs barely gzip).
// The runtime set (manifest sprites plus the illustrations and logos the UI names) lands near 22 MB.
// 55 MiB: the 24 MiB app plus up to eleven bundled character packs at their 2.5 MiB cap (characters-2a).
// Past that, packs ship as separate downloads instead of growing this budget.
const PACK_BUDGET_BYTES = 55 * 1024 * 1024;

const RULES = [
  { why: 'fixtures/local', re: /(^|\/)fixtures\/local(\/|$)/ },
  { why: 'golden/local', re: /(^|\/)golden\/local(\/|$)/ },
  { why: 'instance/', re: /(^|\/)instance(\/|$)/ },
  { why: '.env', re: /(^|\/)\.env($|\.)/, allow: (p) => p === '.env.example' || p.endsWith('/.env.example') },
  { why: 'design/reports', re: /(^|\/)design\/reports(\/|$)/ },
  { why: 'design sources', re: /(^|\/)design\// },
  { why: 'worn art', re: /(^|\/)worn(\/|$)/ },
  { why: 'debug art', re: /(^|\/)debug(\/|$)|diagnostic/i },
  { why: 'test fixtures', re: /(^|\/)test\/fixtures(\/|$)/ },
];

const REQUIRED = ['public/v2/index.html', 'public/v2/bureau/bureau.css'];

function packItem(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  return Array.isArray(data) ? data[0] : data;
}

function packPaths(json) {
  const item = packItem(json);
  return (item.files || []).map((file) => (typeof file === 'string' ? file : file.path).replace(/\\/g, '/').replace(/^package\//, ''));
}

function packSize(json) {
  const size = Number(packItem(json).size);
  return Number.isFinite(size) ? size : null;
}

function missingAssets(paths) {
  return REQUIRED.filter((file) => !paths.includes(file));
}

function forbiddenIn(paths) {
  const hits = [];
  for (const file of paths) {
    for (const rule of RULES) {
      if (rule.allow && rule.allow(file)) continue;
      if (rule.re.test(file)) hits.push({ path: file, why: rule.why });
    }
  }
  return hits;
}

function main(argv) {
  const file = argv[2];
  if (!file) {
    process.stderr.write('usage: node packaging/check-pack.js <npm-pack.json>\n');
    return 2;
  }
  const raw = fs.readFileSync(file, 'utf8');
  const paths = packPaths(raw);
  const hits = forbiddenIn(paths);
  const missing = missingAssets(paths);
  const size = packSize(raw);
  const over = size != null && size > PACK_BUDGET_BYTES;
  if (hits.length || missing.length || over) {
    for (const hit of hits) process.stderr.write(`pack: ${hit.why}: ${hit.path}\n`);
    for (const fileName of missing) process.stderr.write(`pack: missing frontend asset: ${fileName}\n`);
    if (over) process.stderr.write(`pack: size ${size} bytes exceeds the ${PACK_BUDGET_BYTES} byte budget\n`);
    return 1;
  }
  const sizeNote = size == null ? '' : `, ${size} bytes`;
  process.stdout.write(`pack: ok (${paths.length} files${sizeNote})\n`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { packPaths, packSize, forbiddenIn, missingAssets, PACK_BUDGET_BYTES };
