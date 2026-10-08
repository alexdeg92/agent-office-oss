'use strict';
const crypto = require('node:crypto');
const { classify, inputsOf } = require('./classify');
// Bureau color tokens: accent/accent-text, label-{teal,amber,rose} and their light backgrounds.
const PALETTES = [['#5F5FF7', '#9C9CFF'], ['#4FD1DC', '#E7F1F2'], ['#F2BE5C', '#F2EEE6'], ['#F58FB8', '#F6EBF0']];
const MOTIFS = {
  website: '<rect x="10" y="12" width="124" height="94" rx="9"/><path d="M10 36h124M25 24h2m10 0h2m10 0h2M25 52h40v38H25zM80 53h36M80 69h28M80 85h32"/>',
  newsletter: '<rect x="20" y="4" width="96" height="104" rx="8"/><path d="M35 24h65M35 40h38M35 56h65M35 72h65M35 88h48M4 64l12 12m104 0 16-12"/>',
  app: '<rect x="37" y="1" width="70" height="112" rx="12"/><path d="M57 13h30M62 102h20M50 32h18v18H50zM78 32h16v18H78zM50 64h44M50 78h34"/>',
  data: '<path d="M12 103h121M25 95V64h20v31M61 95V39h20v56M97 95V15h20v80M21 42l43-23 42-12"/>',
  doc: '<path d="M32 4h62l25 26v78H32zM94 4v26h25M48 49h54M48 67h54M48 85h38"/>',
  ops: '<rect x="15" y="8" width="110" height="30" rx="6"/><rect x="15" y="45" width="110" height="30" rx="6"/><rect x="15" y="82" width="110" height="30" rx="6"/><path d="M30 23h3m12 0h3M30 60h3m12 0h3M30 97h3m12 0h3M80 23h28M80 60h28M80 97h28"/>',
  marketing: '<path d="M21 46h35l62-26v74L56 68H21zM35 69l9 32h20l-8-32M128 41l12-7M128 75l12 7M57 46v22"/>',
  bug: '<rect x="43" y="30" width="58" height="67" rx="27"/><path d="M56 30V14m31 16V14M43 47H24m77 0h19M43 65H17m84 0h25M46 85l-20 18m72-18 20 18M72 32v63"/>',
  project: '<rect x="17" y="26" width="110" height="80" rx="9"/><path d="M17 45h110M28 26V13h43l13 13M36 66h35M36 82h67"/>',
};
const escape = (text) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const LIMITS = { cover: 25 * 1024, thumb: 6 * 1024 };
function generateCode(project) {
  const p = inputsOf(project), type = classify(project);
  const seed = crypto.createHash('sha256').update(p.slug).digest();
  const [accent, pale] = PALETTES[seed[0] % PALETTES.length];
  const words = p.name.replace(/[\u0000-\u001f\u007f]/g, '').split(/\s+/), lines = [''];
  for (const word of words) {
    const i = lines.length - 1;
    if ((lines[i] + ' ' + word).trim().length > 23 && lines[i] && lines.length < 3) lines.push(word);
    else lines[i] = (lines[i] + ' ' + word).trim();
  }
  const title = lines.map((line, i) => `<text x="28" y="${173 + i * 24}" font-size="20" textLength="${Math.min(418, line.length * 11)}" lengthAdjust="spacingAndGlyphs">${escape(line)}</text>`).join('');
  const body = `<rect width="480" height="270" fill="#0E1117"/><rect x="266" y="-24" width="224" height="310" rx="64" fill="${accent}" opacity=".2" transform="rotate(${seed[1] % 13 - 6} 370 135)"/><circle cx="${35 + seed[2] % 100}" cy="50" r="30" fill="${accent}" opacity=".18"/><g transform="translate(295 35)" fill="none" stroke="${pale}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${MOTIFS[type]}</g><path d="M28 124h48" stroke="${accent}" stroke-width="5"/><g fill="#E9ECF2" font-family="sans-serif" font-weight="600">${title}</g>`;
  const svg = (width, height) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 480 270">${body}</svg>`);
  const result = { cover: svg(480, 270), thumb: svg(160, 90), ext: 'svg' };
  if (result.cover.length > LIMITS.cover || result.thumb.length > LIMITS.thumb) throw new Error('cover-budget');
  return result;
}
module.exports = { generateCode, LIMITS };
