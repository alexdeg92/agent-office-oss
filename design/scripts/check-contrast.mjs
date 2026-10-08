#!/usr/bin/env node
// Bureau — WCAG contrast check for every text/graphic pair the components use.
// Usage: node design/scripts/check-contrast.mjs   (exit 1 if any pair fails)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(fs.readFileSync(path.join(root, 'tokens.json'), 'utf8'));
const byName = Object.fromEntries(tokens.color.tokens.map((t) => [t.name, t.value]));

const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lum = (h) => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// OKLab lightness (0–1), to check that colours which must be told apart differ in lightness
const okL = (h) => { const [r, g, b] = rgb(h).map(lin); const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b); return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s; };

const SURFACES = ['bg', 'bg-sunken', 'surface', 'surface-raised', 'surface-overlay', 'surface-hover', 'surface-selected'];
const STATUS = ['success', 'warning', 'danger', 'info'];
const STATES = ['idle', 'thinking', 'working', 'researching', 'writing', 'calling', 'waiting', 'error', 'offline'];

const DISTINCT = [['success', 'danger'], ['warning', 'danger'], ['state-working', 'state-error'], ['state-waiting', 'state-error'], ['state-idle', 'state-offline'], ['state-thinking', 'state-working']];

const checks = []; // [fg, bg, min, what]
for (const t of ['text-primary', 'text-secondary', 'text-tertiary', 'accent-text']) for (const s of SURFACES) checks.push([t, s, 4.5, 'texte']);
for (const t of ['text-primary', 'text-secondary', 'text-tertiary']) checks.push([t, 'accent-subtle', 4.5, 'texte']);
checks.push(['accent-text', 'accent-subtle', 4.5, 'texte']);
for (const f of ['accent', 'accent-hover', 'accent-pressed', 'danger-fill']) checks.push(['text-on-accent', f, 4.5, 'texte sur aplat']);
for (const s of STATUS) {
  for (const b of ['bg', 'surface', 'surface-raised', 'surface-overlay', `${s}-bg`]) checks.push([s, b, 4.5, 'texte statut']);
  checks.push(['text-primary', `${s}-bg`, 4.5, 'texte bannière']);
}
for (const s of STATES) {
  if (s === 'offline') {
    for (const b of ['surface', 'surface-raised', 'state-offline-bg']) checks.push([`state-${s}`, b, 3, 'graphique']);
    checks.push(['text-tertiary', 'state-offline-bg', 4.5, 'texte état']);
  } else for (const b of ['bg', 'surface', 'surface-raised', `state-${s}-bg`]) checks.push([`state-${s}`, b, 4.5, 'texte état']);
}
const LABELS = ['slate', 'indigo', 'teal', 'amber', 'rose', 'green'];
for (const l of LABELS) for (const b of ['surface', 'surface-raised', `label-${l}-bg`]) checks.push([`label-${l}`, b, 4.5, 'texte étiquette']);
for (const b of ['bg', 'bg-sunken', 'surface', 'surface-raised', 'surface-overlay']) checks.push(['border-control', b, 3, 'bordure contrôle']);
for (const b of ['bg', 'surface', 'surface-raised', 'surface-overlay']) { checks.push(['focus-ring', b, 3, 'anneau focus']); checks.push(['accent', b, 3, 'graphique accent']); }

let fails = 0;
const rows = [];
for (const theme of ['dark', 'light']) {
  for (const [fg, bg, min, what] of checks) {
    const a = byName[fg]?.[theme], b = byName[bg]?.[theme];
    if (!a || !b) { console.error(`missing token ${!a ? fg : bg}`); process.exit(2); }
    const r = ratio(a, b);
    const ok = r >= min;
    if (!ok) fails++;
    rows.push({ theme, fg, bg, r, min, ok, what });
  }
}

const args = new Set(process.argv.slice(2));
for (const theme of ['dark', 'light']) {
  const mine = rows.filter((r) => r.theme === theme);
  const worst = mine.slice().sort((x, y) => x.r / x.min - y.r / y.min).slice(0, 8);
  console.log(`\n${theme === 'dark' ? 'Sombre' : 'Clair'}: ${mine.filter((r) => r.ok).length}/${mine.length} paires conformes. Les plus serrées :`);
  for (const r of worst) console.log(`  ${r.ok ? 'ok ' : 'ÉCHEC'} ${r.r.toFixed(2).padStart(5)}:1 (min ${r.min})  ${r.fg} sur ${r.bg}`);
  if (args.has('--all')) for (const r of mine) console.log(`  ${r.ok ? 'ok ' : 'ÉCHEC'} ${r.r.toFixed(2)} ${r.fg} / ${r.bg}`);
  const ls = STATES.map((s) => [s, okL(byName[`state-${s}`][theme])]).sort((x, y) => x[1] - y[1]);
  console.log(`  Luminosité OKLab des états : ${ls.map(([s, l]) => `${s} ${l.toFixed(2)}`).join(' · ')}`);
  // Pairs that sit next to each other with opposite meaning must differ in lightness, not only hue.
  for (const [a, b] of DISTINCT) {
    const d = Math.abs(okL(byName[a][theme]) - okL(byName[b][theme]));
    const ok = d >= 0.08; if (!ok) fails++;
    console.log(`  ${ok ? 'ok ' : 'ÉCHEC'} ΔL ${d.toFixed(2)} (min 0.08)  ${a} ↔ ${b}`);
  }
}
console.log(fails ? `\n${fails} paire(s) en échec.` : '\nToutes les paires respectent WCAG AA.');
process.exit(fails ? 1 : 0);
