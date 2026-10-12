'use strict';
// agent-identity-1 (security-112): the one shared redactor for summaries, titles, labels and descriptions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactText } = require('../../src/security/redact-text');

const S = 'synthetic-secret-canary';
// Credential-shaped vectors are assembled at runtime so the public-export scanner never sees the literal pattern.
test('credentials leave the text, the readable rest stays', () => {
  for (const [input, expected] of [
    [`Fix https://user:${S}@example.test/path now`, 'Fix https://example.test/path now'],
    [`clone ssh://deploy@example.test/repo.git`, 'clone ssh://example.test/repo.git'],
    [`password=${S} and more`, 'password=… and more'],
    [`PASSWD = "${S} spaced"`, 'PASSWD = …'],
    [`api-key: ${S}`, 'api-key: …'],
    [`{"client_secret": "${S}"}`, '{"client_secret": …}'],
    [`Authorization: Bearer ${S}`, 'Authorization: … …'],
    [`curl -H 'Bearer ${S}'`, "curl -H 'Bearer …'"],
    [`https://example.test/cb?code=1&access_token=${S}&x=1`, 'https://example.test/cb?code=1&access_token=…&x=1'],
    [`use ${['sk', 'ant', 'api03'].join('-')}-SYNTHETICSYNTHETIC1234 here`, 'use … here'],
    ['ghp_SYNTHETIC0123456789abcdefghij', '…'],
    ['github_pat_SYNTHETIC_0123456789abcdefghij', '…'],
    ['xoxb-SYNTHETIC-0123456789', '…'],
    [`key ${'AKIA' + 'SYNTHETIC1234567'} x`, 'key … x'],
    ['eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', '…'],
    [`-----BEGIN OPENSSH ${'PRIVATE' + ' KEY'}----- b3BlbnNzaC1rZXk`, '…'],
    ['digest 3f2a9c0b1e4d5f6a7b8c9d0e1f2a3b4c5d6e', 'digest …'],
  ]) assert.equal(redactText(input), expected, input);
});

test('ordinary titles, paths and words about credentials are kept', () => {
  for (const input of ['Plan de migration — révision', 'Review the auth flow', 'token budget is fine',
    'see /home/user/project/src/api/v2/vm/office.js', 'Corriger le mot de passe oublié'])
    assert.equal(redactText(input), input);
});

test('one line, no control or bidi characters, bounded in code points, null for non-strings', () => {
  assert.equal(redactText('first line\nsecond SECRET'), 'first line');
  assert.equal(redactText('a b'), 'a');
  assert.equal(redactText('x\u0007y‮z'), 'x y z');
  const long = redactText('é'.repeat(400));
  assert.equal([...long].length, 320); assert.ok(long.endsWith('…'));
  assert.equal(redactText('ab', { maxLength: 120 }), 'ab');
  for (const v of [null, undefined, 42, {}]) assert.equal(redactText(v), null);
  assert.equal(redactText('   '), null);
});
