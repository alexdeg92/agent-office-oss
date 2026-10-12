#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const source = path.join(ROOT, 'design/identity-1');
const output = path.join(ROOT, 'public/v2/identity-themes');

function build() {
  const registry = JSON.parse(fs.readFileSync(path.join(source, 'registry.json'), 'utf8'));
  if (!registry.themes.length || !registry.themes.some(theme => theme.id === registry.default)) throw Error('identity registry needs a default theme');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  for (const theme of registry.themes) {
    if (!/^[a-z][a-z0-9-]*$/.test(theme.id)) throw Error(`invalid identity id: ${theme.id}`);
    const dir = path.join(source, theme.id);
    const tokens = JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8'));
    const authored = fs.readFileSync(path.join(dir, 'tokens.css'), 'utf8');
    const overlay = JSON.parse(fs.readFileSync(path.join(dir, 'overlay.json'), 'utf8'));
    const overlays = fs.readFileSync(path.join(dir, 'overlays.css'), 'utf8');
    if (!tokens.color?.tokens?.some(token => token.name === 'accent')) throw Error(`missing semantic accent tokens for ${theme.id}`);
    const fontDir = path.join(dir, 'fonts');
    const publicFonts = path.join(output, theme.id, 'fonts');
    fs.mkdirSync(publicFonts, { recursive: true });
    for (const file of fs.readdirSync(fontDir)) {
      if (/\.(?:woff2?|ttf|otf|txt)$/i.test(file)) fs.copyFileSync(path.join(fontDir, file), path.join(publicFonts, file));
    }
    const families = new Set(Object.values(overlay.fonts || {}));
    for (const match of authored.matchAll(/font-family\s*:\s*([^;]+);/g)) {
      for (const family of match[1].matchAll(/["']([^"']+)["']/g)) families.add(family[1]);
    }
    let scoped = authored.replace(/url\(["']?fonts\//g, 'url("fonts/')
      .replace(/:root\b/g, `[data-identity="${theme.id}"]`)
      .replace(/\[data-theme=(['"])(dark|light)\1\]/g, `[data-identity="${theme.id}"][data-theme="$2"]`)
      .replace(/(url\(["'][^"']+\.ttf)["']\)\s*format\(["']woff2["']\)/gi, '$1") format("truetype")');
    for (const family of families) {
      const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      scoped = scoped.replace(new RegExp(`(["'])${escaped}(["'])`, 'g'), `$1${theme.id} ${family}$2`);
    }
    const scopedOverlays = overlays.replace(/([^{}]+)\{/g, (rule, selector) => {
      const trimmed = selector.trim();
      if (!trimmed || trimmed.startsWith('@')) return rule;
      return `${trimmed.split(',').map(part => {
        const item = part.trim();
        return item.startsWith('[data-theme=')
          ? item.replace(/^\[data-theme=/, `[data-identity="${theme.id}"][data-theme=`)
          : `[data-identity="${theme.id}"] ${item}`;
      }).join(',')} {`;
    });
    fs.writeFileSync(path.join(output, theme.id, 'theme.css'), `/* ${theme.id}: generated from tokens.css + overlays.css */\n${scoped}\n${scopedOverlays}`);
  }
  fs.writeFileSync(path.join(output, 'registry.js'), `// GENERATED from design/identity-1/registry.json\nexport const identityRegistry = Object.freeze(${JSON.stringify(registry)});\n`);
}
if (require.main === module) { try { build(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { build };
