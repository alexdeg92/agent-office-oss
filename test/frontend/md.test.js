import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseInline, plainText } from '../../public/v2/md.js';

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

test('links reject network-path slash/backslash forms and preserve same-origin paths', () => {
  for (const href of ['//outside.example/path', '/\\outside.example/path', '///outside.example', '\\\\outside.example']) {
    assert.deepEqual(parseInline(`[texte](${href})`), [{ t: 'text', v: 'texte' }], href);
  }
  for (const href of ['/projects/item?x=1#note', '/#note', '#note', 'https://outside.example/path', 'http://outside.example', 'mailto:operator@example.test']) {
    assert.equal(parseInline(`[texte](${href})`)[0].href, href);
  }
});


test('GFM tables: alignment, optional edge pipes, inline markup and ragged rows', () => {
  const table = parse('Nom | État | Total\n:--- | :-: | ---:\n**Alpha** | `ok` | 2\nBeta\nGamma | oui | 3 | ignoré')[0];
  assert.equal(table.t, 'table');
  assert.deepEqual(table.align, ['left', 'center', 'right']);
  assert.equal(table.header.length, 3); assert.equal(table.rows.length, 3);
  assert.deepEqual(table.rows[0][0], [{t:'b', c:[{t:'text',v:'Alpha'}]}]);
  assert.deepEqual(table.rows[1], [[{t:'text',v:'Beta'}], [], []]);
  assert.equal(table.rows[2].length, 3);
  assert.equal(plainText('Nom | État\n--- | ---\n**Alpha** | `ok`'), 'Nom · État\nAlpha · ok');
});

test('GFM tables: escaped pipes, unsafe source, block boundaries and invalid headers', () => {
  const blocks = parse('| f\\|oo | état |\n| --- | --- |\n| `a\\|b` | **x\\|y** |\n> suite');
  assert.deepEqual(blocks.map(b=>b.t), ['table','quote']);
  assert.deepEqual(blocks[0].header[0], [{t:'text',v:'f|oo'}]);
  assert.deepEqual(blocks[0].rows[0][0], [{t:'code',v:'a|b'}]);
  assert.deepEqual(blocks[0].rows[0][1], [{t:'b',c:[{t:'text',v:'x|y'}]}]);
  assert.equal(parse('| a | b |\n| --- |\n| c |')[0].t,'p');
  assert.equal(parse('```\n| a | b |\n| --- | --- |\n```')[0].t,'code');
  const unsafe = parse('| a | b |\n| --- | --- |\n| <img src=x onerror=alert(1)> | [x](javascript:bad) |')[0];
  assert.deepEqual(unsafe.rows[0][0], [{t:'text',v:'<img src=x onerror=alert(1)>'}]);
  assert.deepEqual(unsafe.rows[0][1], [{t:'text',v:'x'}]);
  assert.equal(parse('| a |\n| - |')[0].rows.length, 0);
});
