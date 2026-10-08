import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseInline } from '../../public/v2/md.js';

test('blocks: headings, paragraphs, lists, code, quotes, rules', () => {
  const ast = parse('# Titre\n\nUn paragraphe\nsur deux lignes.\n\n- un\n- deux\n\n1. a\n2. b\n\n```js\nconst x = 1;\n```\n\n> cité\n\n---');
  assert.deepEqual(ast.map((b) => b.t), ['h', 'p', 'ul', 'ol', 'code', 'quote', 'hr']);
  assert.equal(ast[0].level, 1);
  assert.deepEqual(ast[1].c, [{ t: 'text', v: 'Un paragraphe sur deux lignes.' }]);
  assert.equal(ast[2].items.length, 2);
  assert.deepEqual(ast[4], { t: 'code', lang: 'js', v: 'const x = 1;' });
});

test('inline: code, bold, italic, links', () => {
  assert.deepEqual(parseInline('a `b` **c** *d* [e](https://exemple.ca)'), [
    { t: 'text', v: 'a ' }, { t: 'code', v: 'b' }, { t: 'text', v: ' ' }, { t: 'b', c: [{ t: 'text', v: 'c' }] }, { t: 'text', v: ' ' },
    { t: 'i', c: [{ t: 'text', v: 'd' }] }, { t: 'text', v: ' ' }, { t: 'a', href: 'https://exemple.ca', c: [{ t: 'text', v: 'e' }] },
  ]);
  assert.deepEqual(parseInline('snake_case_name'), [{ t: 'text', v: 'snake_case_name' }], 'underscores inside words are not italics');
});

test('safety: unsafe link schemes keep their text and lose the link; raw HTML stays text', () => {
  assert.deepEqual(parseInline('[clic](javascript:alert(1))'), [{ t: 'text', v: 'clic' }, { t: 'text', v: ')' }]);
  assert.deepEqual(parseInline('[x](data:text/html,hi)'), [{ t: 'text', v: 'x' }]);
  const ast = parse('<script>alert(1)</script>');
  assert.deepEqual(ast, [{ t: 'p', c: [{ t: 'text', v: '<script>alert(1)</script>' }] }]);
  assert.deepEqual(parse(''), []);
  assert.deepEqual(parse(null), []);
});
