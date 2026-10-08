'use strict';

const crypto = require('node:crypto');

function hashEmail(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Drop raw emails, including an author name that is itself an address. */
function authorHint(name, email) {
  const rawName = String(name || '').trim();
  const rawEmail = String(email || '').trim();
  const found = rawName.match(EMAIL_RE);
  const stripped = rawName
    .replace(new RegExp(EMAIL_RE.source, 'g'), ' ')
    .replace(/[<>"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const clean = stripped || 'inconnu';
  const address = rawEmail || (found ? found[0] : '');
  if (!address || !EMAIL_RE.test(address)) return { name: clean, emailHash: null };
  return { name: clean, emailHash: hashEmail(address) };
}

module.exports = { hashEmail, authorHint };
