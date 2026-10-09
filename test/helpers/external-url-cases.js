'use strict';
const { MAX_EXTERNAL_URL_LENGTH } = require('../../public/v2/url-policy.js');
const base = 'https://example.invalid/';
const allowed = [
  ['HTTPS://Example.INVALID:443/docs?q=one%20two#top', 'https://example.invalid/docs?q=one%20two#top'],
  ['HTTP://Example.INVALID:80', 'http://example.invalid/'],
  ['https://example.invalid:8443/docs', 'https://example.invalid:8443/docs'],
  ['https://bücher.invalid/été', 'https://xn--bcher-kva.invalid/%C3%A9t%C3%A9'],
  ['https://[::1]:8443/', 'https://[::1]:8443/'],
  ['https://example.invalid/%E2%80%94', 'https://example.invalid/%E2%80%94'],
  [base + 'a'.repeat(MAX_EXTERNAL_URL_LENGTH - base.length), base + 'a'.repeat(MAX_EXTERNAL_URL_LENGTH - base.length)],
];
const rejected = [
  'javascript:window.__urlPolicyMarker="executed"',
  null, undefined, '', 7, {}, [], 'not a URL', '/relative', '//example.invalid',
  'JaVaScRiPt:alert(1)',
  'data:text/html,<script>window.__urlPolicyMarker="executed"</script>',
  'file:///tmp/inert', 'ftp://example.invalid/', 'mailto:inert@example.invalid',
  'blob:https://example.invalid/id', 'custom-protocol://example.invalid/',
  'https://', 'https:/example.invalid', 'https:example.invalid', 'https:///example.invalid',
  'https://?q=x', 'https://[bad]/', 'https://example.invalid:99999/', 'https://example.invalid:/',
  'https://user:password@example.invalid/', 'https://user@example.invalid/', 'https://@example.invalid/',
  'https://example.invalid\\@other.invalid/', 'https://example.invalid/%', 'https://example.invalid/%GG',
  ' https://example.invalid/', 'https://example.invalid/ ', 'https://example.invalid/a b',
  '\tHTTPS://example.invalid/', 'java\nscript:alert(1)', 'https://exam\tple.invalid/',
  'https://example.invalid/\0', 'https://example.invalid/\u007f', 'https://example.invalid/\u0085',
  'https://example.invalid/\u00a0', 'https://example.invalid/%00', 'https://example.invalid/%0a',
  'https://example.invalid/%1F', 'https://example.invalid/%7f',
  base + 'a'.repeat(MAX_EXTERNAL_URL_LENGTH),
  base + 'é'.repeat(Math.floor(MAX_EXTERNAL_URL_LENGTH / 4)),
];
module.exports = { allowed, rejected };
