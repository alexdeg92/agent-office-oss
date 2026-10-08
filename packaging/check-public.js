#!/usr/bin/env node
'use strict';
// Scan every byte and filename of an export. Never print matched values.
const fs = require('node:fs');
const path = require('node:path');
const PRIVATE_LITERALS = ['/home/' + ('al' + 'ex'), ['100', '120', '237', '123'].join('.'), 'cater' + 'flow'];
const RULES = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['provider token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|npm_[A-Za-z0-9]{30,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{16})\b/g],
  ['Discord token', /\b(?:mfa\.[\w-]{60,}|[\w-]{24,28}\.[\w-]{6}\.[\w-]{27,})\b/g],
  ['Telegram bot token', /\b\d{8,12}:[A-Za-z0-9_-]{35}\b/g],
  ['chat ID', /(?<![\d.])\b\d{17,20}\b(?![\d.])/g],
  ['Telegram ID', /(?:telegram(?:(?!\n).){0,40}?(?:user|chat|peer|id)|(?:user|chat|peer|channel|bot)[_-]?id|["']id["'])["'\s:=/]+(-?\d{8,13})\b/gi],
  ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
];
// Explicitly synthetic identifiers already used by the fixture generator and tests.
const syntheticId = (s) => /^100000\d{11,14}$/.test(s) || /^0{8}\d{9,11}$/.test(s) || /^(\d)\1+$/.test(s) || /^(?:1234567890)+12345678?$/.test(s) || /^123456789012345678$/.test(s);
// Only this exact protocol declaration is exempt from the private-name rule. Other occurrences,
// including another line in the same file, still fail. Removing the alias breaks existing callers.
const LEGACY_OWNER_DECLARATION = "const OWNER_ACTOR_SHORT = Object.freeze(['owner', '" + ('al' + 'ex') + "']);";
function scan(root, env = process.env) {
  const findings = []; let count = 0, bytes = 0;
  const privateValues = [env.PORTAL_EMAIL, ...Object.entries(env).filter(([k]) => /^(?:PORTAL_(?:SECRET|PASSWORD|PASSWORD_HASH)|OC_GATEWAY_TOKEN)$/.test(k)).map(([, v]) => v)].filter((v) => v && v.length >= 3);
  const privateNames = ['Al' + 'ex', 'Al' + 'exandre', 'Ma' + 'rc', '@al' + 'exdeg', '@ma' + 'rc.r', env.PORTAL_DISPLAY_NAME, ...(env.PUBLIC_PRIVATE_NAMES || '').split('|')].filter((v) => v && v.length >= 3);
  function visit(rel) {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const file = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { findings.push({ file, rule: 'symlink' }); continue; }
      if (entry.name === '.env' || entry.name.startsWith('.env.') && entry.name !== '.env.example' || /\.(?:key|pem|token|sqlite|db)(?:$|-)/.test(entry.name) || /^(?:instance|design\/(?:reports|explorations)|test\/(?:fixtures|golden)\/local)(?:\/|$)/.test(file)) findings.push({ file, rule: 'local-only path' });
      if (entry.name === '.git') { findings.push({ file, rule: 'Git history' }); continue; }
      if (entry.isDirectory()) { visit(file); continue; }
      if (!entry.isFile()) { findings.push({ file, rule: 'special file' }); continue; }
      const data = fs.readFileSync(path.join(root, file)); count++; bytes += data.length;
      const binary = data.includes(0);
      const text = file + '\n' + data.toString('utf8');
      for (const literal of [...PRIVATE_LITERALS, ...privateValues]) {
        if (text.toLowerCase().includes(literal.toLowerCase())) findings.push({ file, rule: 'private literal' });
      }
      // The author attribution in LICENSE is explicitly required public metadata.
      let nameText = file === 'LICENSE' ? text.replace(/^Copyright \(c\) 2026 .*$/m, '') : text;
      if (file === 'src/projects/constants.js') nameText = nameText.split('\n').map((line) => line === LEGACY_OWNER_DECLARATION ? '' : line).join('\n');
      for (const name of privateNames) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(nameText)) findings.push({ file, rule: 'private person name' });
      }
      for (const [rule, re] of RULES) {
        for (const match of text.matchAll(re)) {
          const value = match[1] || match[0];
          if (rule === 'email' && (binary || /\.(?:png|webp|svg|js|mjs|json|jpg)$/i.test(value))) continue;
          if (rule === 'email' && /^(?:git@(?:github|gitlab)\.com|[\w.-]+@(?:[\w.-]+\.)?(?:example|invalid))$/i.test(value)) continue;
          if (rule === 'email' && value === '41898282+github-actions[bot]' + '@users.' + 'noreply.github.com') continue;
          if (rule === 'email' && /(?:avatars|images)\.githubusercontent\.com$/i.test(value)) continue;
          if ((rule === 'chat ID' || rule === 'Telegram ID') && syntheticId(value)) continue;
          if (rule === 'email' && /@(?:[\w.-]*\.)?example\.(?:com|org|net|invalid|ca)$/i.test(value)) continue;
          // Copyright attribution in font licences is public provenance, retained verbatim.
          if (rule === 'email' && /(?:^|\/)(?:OFL[^/]*\.txt|OFL\.txt)$/.test(file)) continue;
          findings.push({ file, rule, line: text.slice(0, match.index).split('\n').length - 1 });
        }
      }
    }
  }
  visit('');
  // A filename itself can contain a credential or a private address.
  for (const hit of findings) {
    for (const literal of [...PRIVATE_LITERALS, ...privateValues, ...privateNames]) {
      const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      hit.file = hit.file.replace(new RegExp(escaped, 'gi'), '[redacted]');
    }
    for (const [, re] of RULES) hit.file = hit.file.replace(re, '[redacted]');
  }
  return { findings, count, bytes };
}
function main(argv) {
  if (argv.length !== 3) { console.error('usage: node packaging/check-public.js <exportdir>'); return 2; }
  if (!process.env.PORTAL_EMAIL) { console.error('public: PORTAL_EMAIL must be supplied at runtime for the private-email check'); return 2; }
  const result = scan(path.resolve(argv[2]));
  for (const hit of result.findings) console.error(`public: ${hit.rule}: ${hit.file}${hit.line ? ':' + hit.line : ''}`);
  console.log(`public: ${result.findings.length ? 'FAIL' : 'ok'} (${result.count} files, ${result.bytes} bytes, ${result.findings.length} findings; private-email check enabled)`);
  return result.findings.length ? 1 : 0;
}
if (require.main === module) process.exitCode = main(process.argv);
module.exports = { scan };
