'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Read the deployed shell, including replacements made while the server stays running.
// Both the static frontend and the combined Express server use this source of truth.
function createBuildReader(root = path.join(__dirname, '../../public/v2')) {
  const file = path.join(root, 'index.html');
  let stamp, value;
  return () => {
    try {
      const st = fs.statSync(file);
      const next = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
      if (next !== stamp) {
        const source = fs.readFileSync(file, 'utf8');
        const buildId = /<meta name="ao-build" content="([a-zA-Z0-9_-]+)">/.exec(source)?.[1] || null;
        value = { source, buildId }; stamp = next;
      }
      return value;
    } catch { stamp = null; return { source: null, buildId: null }; }
  };
}
// A checkout run without `node scripts/build-frontend.js` serves an unstyled page (the generated Bureau CSS, fonts and art
// are missing): say so once at boot instead of failing silently in the browser.
function warnIfUnbuilt(root, warn = (m) => console.warn(m)) {
  if (fs.existsSync(path.join(root, 'bureau', 'bundle.css'))) return false;
  warn('Agent Office: the interface is not built (' + path.join(root, 'bureau') + ' is missing): run `node scripts/build-frontend.js` in this checkout, then restart.');
  return true;
}
module.exports = { createBuildReader, warnIfUnbuilt };
