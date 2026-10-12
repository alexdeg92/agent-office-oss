'use strict';
// The UI's first load, computed from the files (no browser). Since F11 the pages are lazy: app.js names each one as
// `<route>: () => import('./pages/….js')`. This computes
//   - the core: index.html, its stylesheets and scripts, and the static ES-module graph from app.js;
//   - each route's own modules: the static graph of its page module, minus the core;
// with sizes (raw, gzip) and import depths. It also generates
//   - index.html's modulepreload block (the core: no import waterfall before the first render), and
//   - route-preload.js, a classic script that preloads the current URL's route modules while the core loads, and
//     gives app.js the table for preloading a route on navigation intent (hover, focus, touch).
// Used by the CI budget (test/frontend/budget.test.js) and `node scripts/first-load.js [--write | --json]`.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', 'public', 'v2');
const STATIC_IMPORT = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?['"]([^'"]+)['"]/g;
const LAZY_PAGE = /^\s*'?([\w-]+)'?:\s*\(\)\s*=>\s*import\('([^']+)'(?:\s*\+\s*buildQuery)?\)/gm;
const ROUTE = /\{ name: '([\w-]+)', path: '([^']+)'/g;

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function importsOf(src) {
  const code = strip(src).replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``');
  return [...code.matchAll(STATIC_IMPORT)].map((m) => m[1]);
}
const importMap = (root) => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  return JSON.parse((/<script type="importmap">([\s\S]*?)<\/script>/.exec(html) || [, '{"imports":{}}'])[1]).imports || {};
};
const norm = (rel) => path.posix.normalize(rel.split('?')[0].replace(/^\.\//, ''));

/** Static ES-module closure from `entries` (depth 1), breadth-first; `exclude` stops at modules already loaded. */
function closure(root, entries, exclude = new Set()) {
  const map = importMap(root);
  const out = new Map();
  const queue = entries.map((e) => [norm(e), 1]);
  while (queue.length) {
    const [rel, depth] = queue.shift();
    if (exclude.has(rel)) continue;
    if (out.has(rel)) { out.get(rel).depth = Math.min(out.get(rel).depth, depth); continue; }
    const buf = fs.readFileSync(path.join(root, rel));
    out.set(rel, { rel, kind: 'js', bytes: buf.length, gzip: zlib.gzipSync(buf, { level: 6 }).length, depth });
    for (const spec of importsOf(buf.toString('utf8'))) {
      if (map[spec]) queue.push([norm(map[spec]), depth + 1]);   // import-map targets resolve from the page
      else if (spec.startsWith('.')) queue.push([norm(path.posix.join(path.posix.dirname(rel), spec)), depth + 1]);
    }
  }
  return out;
}

/** The lazy pages app.js declares: [{ name, entry }] ('setup' included: the first-run flow). */
function lazyPages(root = ROOT) {
  const src = strip(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  return [...src.matchAll(LAZY_PAGE)].map((m) => ({ name: m[1], entry: norm(m[2]) }));
}
/** Route paths from router.js (name → '/journaux/:sessionKey'). */
function routePaths(root = ROOT) {
  const src = strip(fs.readFileSync(path.join(root, 'router.js'), 'utf8'));
  return Object.fromEntries([...src.matchAll(ROUTE)].map((m) => [m[1], m[2]]));
}

const sum = (l, k) => l.reduce((n, f) => n + f[k], 0);
const stats = (list) => ({ count: list.length, bytes: sum(list, 'bytes'), gzip: sum(list, 'gzip') });
/** Each lazy route's own modules (its page's static graph minus the core), with sizes. */
function routesOf(root = ROOT) {
  const core = new Set(closure(root, ['app.js']).keys());
  const routes = {};
  for (const p of lazyPages(root)) {
    const own = [...closure(root, [p.entry], core).values()];
    routes[p.name] = { entry: p.entry, modules: own.map((f) => f.rel).sort(), ...stats(own) };
  }
  return routes;
}

function firstLoad(root = ROOT) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const files = [];
  const file = (rel, kind) => { const buf = fs.readFileSync(path.join(root, norm(rel))); files.push({ rel: norm(rel), kind, bytes: buf.length, gzip: zlib.gzipSync(buf, { level: 6 }).length, depth: kind === 'html' ? 0 : 1 }); };
  file('index.html', 'html');
  for (const m of html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)) file(m[1], 'css');
  for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) file(m[1], 'js');   // classic boot scripts
  const core = closure(root, ['app.js']);
  files.push(...core.values());
  const preloads = new Set([...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => norm(m[1])));
  const list = files.map((f) => ({ ...f, preloaded: f.kind !== 'js' || preloads.has(f.rel) || f.depth === 1 }));
  const js = list.filter((f) => f.kind === 'js');
  const routes = routesOf(root);
  return {
    files: list.sort((a, b) => a.depth - b.depth || b.bytes - a.bytes),
    requests: list.length,
    js: stats(js),
    css: stats(list.filter((f) => f.kind === 'css')),
    depth: Math.max(...js.map((f) => f.depth)),
    // Without preloading, the browser discovers module N only after module N-1 arrived: one round trip per level.
    criticalDepth: Math.max(...list.filter((f) => !f.preloaded).map((f) => f.depth), 0),
    routes,
  };
}

// A release pins the whole local module graph, including dynamic imports, through URL keys in the import map.
function releaseFiles(root = ROOT, dir = '') {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    return e.isDirectory() ? releaseFiles(root, rel) : e.isFile() && /\.(?:js|mjs|css|json)$/.test(rel) && rel !== 'route-preload.js' ? [rel] : [];
  }).sort();
}
function buildId(root = ROOT) {
  const hash = crypto.createHash('sha256');
  for (const rel of releaseFiles(root)) hash.update(rel).update('\0').update(fs.readFileSync(path.join(root, rel)));
  return hash.digest('hex').slice(0, 16);
}
const versioned = (rel, version) => norm(rel) + '?v=' + version;
function releaseMap(root = ROOT, version = buildId(root)) {
  const bare = Object.fromEntries(Object.entries(importMap(root)).filter(([k]) => !k.startsWith('.')).map(([k,v]) => [k, './' + versioned(v, version)]));
  for (const rel of releaseFiles(root).filter((r) => /\.(?:js|mjs|json)$/.test(r))) bare['./' + rel] = './' + versioned(rel, version);
  return { imports: bare };
}
const MARK = /(<!-- modulepreload:start[^>]*-->\n)[\s\S]*?(<!-- modulepreload:end -->)/;
/** index.html's preload block: the core module graph, shallowest first, so none waits for its parent. */
function preloadBlock(root = ROOT) {
  return [...closure(root, ['app.js']).values()]
    .sort((a, b) => a.depth - b.depth || (a.rel < b.rel ? -1 : 1))   // stable: a size change doesn't reorder the file
    .map((f) => `<link rel="modulepreload" href="${versioned(f.rel, buildId(root))}">\n`).join('');
}

/** route-preload.js: the route table and the boot-time preload of the current URL's route.
 * Runs before app.js to preload route modules while the core loads; AO_ROUTES also
 * serves navigation intent. budget.test.js verifies the generated graph and byte limits.
 */
function routePreloadScript(root = ROOT) {
  const r = routesOf(root);
  const paths = routePaths(root);
  // The owner-only gallery has no navigation entry, so its graph is fetched only when the route is opened.
  const table = Object.entries(r).filter(([name]) => name !== 'ds').map(([name, x]) => [name, paths[name] || null, x.modules]);
  const source = `// GENERATED by scripts/first-load.js --write.
(function () {
  var ROUTES = ${JSON.stringify(table)};
  var done = {};
  function preload(name) {
    for (var i = 0; i < ROUTES.length; i++) {
      if (ROUTES[i][0] !== name) continue;
      var mods = ROUTES[i][2];
      for (var j = 0; j < mods.length; j++) {
        if (done[mods[j]]) continue;
        done[mods[j]] = 1;
        var l = document.createElement('link'); l.rel = 'modulepreload'; l.href = mods[j] + '?v=${buildId(root)}'; document.head.appendChild(l);
      }
    }
  }
  function routeOf(pathname) {
    var base = new URL(document.baseURI).pathname;
    var p = pathname.indexOf(base) === 0 ? '/' + pathname.slice(base.length) : pathname;
    p = p.replace(/\\/+$/, '') || '/';
    if (p === '/') return 'bureau';
    for (var i = 0; i < ROUTES.length; i++) {
      var pat = ROUTES[i][1];
      if (pat && new RegExp('^' + pat.replace(/:[\\w]+/g, '[^/]+') + '$').test(p)) return ROUTES[i][0];
    }
    return null;
  }
  self.AO_ROUTES = { preload: preload, routeOf: routeOf };
  var current = routeOf(location.pathname);
  current && preload(current);
})();
`;
  // The navigation manifest is shipped on every page. Keep its generated wrapper compact; module paths remain
  // readable in this source template and are emitted once per shared module in the generated table.
  return source.replace(/^\/\/ GENERATED[^\n]*\n/, '').replace(/\s+/g, ' ')
    .replace(/\s*([{}();,:=+<>!/*&|?-])\s*/g, '$1')
    .replace(/"([^"']*)"/g, (_match, value) => `'${value}'`);
}

/** Rewrites index.html's preload block and route-preload.js; returns the files that changed. */
function writePreloads(root = ROOT) {
  const changed = [];
  const file = path.join(root, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  if (!MARK.test(html)) throw new Error('index.html has no modulepreload markers');
  const version = buildId(root);
  const next = html.replace(MARK, (_, a, b) => a + preloadBlock(root) + b)
    .replace(/(<script type="importmap">)[\s\S]*?(<\/script>)/, (_,a,b) => a + '\n' + JSON.stringify(releaseMap(root, version), null, 2) + '\n' + b)
    .replace(/<meta name="ao-build" content="[^"]*">\n?/, '')
    .replace('<meta name="viewport"', '<meta name="ao-build" content="' + version + '">\n<meta name="viewport"')
    .replace(/((?:src|href)=")([^"]+\.(?:js|mjs|css))(?:\?v=[^"]*)?(")/g, (_,a,url,b) => a + versioned(url, version) + b);
  if (next !== html) { fs.writeFileSync(file, next); changed.push('index.html'); }
  const rp = path.join(root, 'route-preload.js');
  const script = routePreloadScript(root);
  if (!fs.existsSync(rp) || fs.readFileSync(rp, 'utf8') !== script) { fs.writeFileSync(rp, script); changed.push('route-preload.js'); }
  return changed;
}

module.exports = { firstLoad, routesOf, importsOf, closure, lazyPages, routePaths, preloadBlock, routePreloadScript, writePreloads, buildId, releaseMap, releaseFiles, MARK, ROOT };

if (require.main === module) {
  if (process.argv.includes('--write')) { const c = writePreloads(); console.log(c.length ? 'updated: ' + c.join(', ') : 'preloads up to date'); return; }
  const r = firstLoad();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  for (const f of r.files) console.log(`${String(f.depth).padStart(2)} ${f.rel.padEnd(42)} ${kb(f.bytes).padStart(10)} ${kb(f.gzip).padStart(9)} gz`);
  console.log(`\ncore: ${r.requests} requests · JS ${r.js.count} files ${kb(r.js.bytes)} (${kb(r.js.gzip)} gz) · CSS ${kb(r.css.bytes)} (${kb(r.css.gzip)} gz)`);
  for (const [name, x] of Object.entries(r.routes)) console.log(`  route ${name.padEnd(14)} +${String(x.count).padStart(2)} modules ${kb(x.bytes).padStart(9)} (${kb(x.gzip)} gz)`);
}
