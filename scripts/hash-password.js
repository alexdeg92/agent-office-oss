#!/usr/bin/env node
'use strict';
/*
 * Prints an scrypt hash for PORTAL_PASSWORD_HASH (PM audit (A)). The password is read from stdin: typed without
 * echo on a terminal (asked twice), or piped (`printf %s "$pw" | node scripts/hash-password.js`). Only the hash is
 * printed; the password is never written anywhere.
 *   agent-office hash-password   (the CLI wrapper calls this script)
 */
const { hashPassword } = require('../src/security/password');

function readHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); return resolve(value); }
        if (c === '\u0003') { process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1); else value += c;
      }
    };
    stdin.on('data', onData);
  });
}
const readPiped = () => new Promise((resolve) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => resolve(s.replace(/\r?\n$/, ''))); });

async function main() {
  let pw;
  if (process.stdin.isTTY) {
    pw = await readHidden('Mot de passe : ');
    if (pw !== await readHidden('Confirmer : ')) { process.stderr.write('Les deux saisies diffèrent.\n'); return 1; }
  } else pw = await readPiped();
  if (pw.length < 12) { process.stderr.write('Au moins 12 caractères.\n'); return 1; }
  process.stdout.write(await hashPassword(pw) + '\n');
  process.stderr.write('Mettez cette valeur dans PORTAL_PASSWORD_HASH et retirez PORTAL_PASSWORD.\n');
  return 0;
}

if (require.main === module) main().then((code) => process.exit(code));
