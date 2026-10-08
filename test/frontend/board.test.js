import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareCards, landingIndex, applyOverrides, settledOverrides, findCard, stepStatus, matchesQuery, labelTone, tintTone, accentTone, sortFlags, LABEL_TONES, priorityRank } from '../../public/v2/board.js';

const card = (id, priority, lastActivityAt) => ({ id, priority, lastActivityAt, name: id, revision: 1 });
const board = () => [
  { id: 'idea', count: 1, cards: [card('a', 'P2', 50)] },
  { id: 'todo', count: 3, cards: [card('b', 'P0', 10), card('c', 'P1', 90), card('d', 'P1', 30)] },
  { id: 'in-progress', count: 0, cards: [] },
  { id: 'in-review', count: 0, cards: [] },
  { id: 'shipped', count: 0, cards: [] },
];

test('compareCards: priority, then most recent activity, then id', () => {
  const list = [card('z', 'P1', 5), card('y', 'P0', 1), card('x', 'P1', 9), card('w', 'P1', 9)];
  assert.deepEqual(list.sort(compareCards).map((c) => c.id), ['y', 'w', 'x', 'z']);
});

test('landingIndex follows the server order and ignores the card itself', () => {
  const cards = board()[1].cards;
  assert.equal(landingIndex(cards, card('n', 'P1', 100)), 1, 'most recent P1 lands right after the P0');
  assert.equal(landingIndex(cards, card('n', 'P3', 100)), 3, 'lowest priority lands last');
  assert.equal(landingIndex(cards, card('n', 'P0', 1)), 1);
  assert.equal(landingIndex(cards, { ...cards[2] }), 2, 'a card already in the list is not counted against itself');
});

test('applyOverrides moves a card optimistically, by order, with counts', () => {
  const cols = board();
  const out = applyOverrides(cols, new Map([['a', { status: 'todo', at: 95 }]]));
  assert.deepEqual(out[0].cards, []);
  assert.equal(out[0].count, 0);
  assert.deepEqual(out[1].cards.map((c) => c.id), ['b', 'c', 'd', 'a'], 'a P2 lands after the P1 cards');
  assert.equal(out[1].count, 4);
  assert.equal(out[1].cards[3].lastActivityAt, 95, 'the server touches lastActivityAt on write');
  assert.equal(out[2], cols[2], 'untouched columns keep their identity');
  assert.deepEqual(cols[0].cards.map((c) => c.id), ['a'], 'the VM is not mutated');
  const toTop = applyOverrides(cols, new Map([['d', { status: 'idea', at: 1 }]]));
  assert.deepEqual(toTop[0].cards.map((c) => c.id), ['d', 'a'], 'P1 goes above P2');
  assert.equal(applyOverrides(cols, new Map()), cols);
});

test('settledOverrides: done once the VM shows the card in its target column (or no longer shows it)', () => {
  const cols = board();
  const o = new Map([['a', { status: 'todo' }], ['b', { status: 'todo' }], ['gone', { status: 'idea' }]]);
  assert.deepEqual(settledOverrides(cols, o).sort(), ['b', 'gone']);
});

test('findCard and stepStatus', () => {
  assert.deepEqual(findCard(board(), 'c'), { card: card('c', 'P1', 90), status: 'todo' });
  assert.equal(findCard(board(), 'zz'), null);
  assert.equal(stepStatus('idea', -1), 'idea');
  assert.equal(stepStatus('idea', 1), 'todo');
  assert.equal(stepStatus('shipped', 1), 'shipped');
  assert.equal(stepStatus('in-review', -1), 'in-progress');
});

test('matchesQuery ignores accents and case, every word must match', () => {
  assert.equal(matchesQuery('Tableau des dépenses', 'DEPENSE'), true);
  assert.equal(matchesQuery('Site du restaurant Chez Lucie', 'site lucie'), true);
  assert.equal(matchesQuery('Site du restaurant Chez Lucie', 'site paul'), false);
  assert.equal(matchesQuery('Nimporte', '   '), true);
});

test('label tone and monogram tint are stable and in range (no abstract covers any more)', () => {
  assert.equal(labelTone('client'), labelTone('client'));
  assert.ok(LABEL_TONES.includes(labelTone('site-web')));
  assert.equal(accentTone('teal', 'prj_a'), 'teal', 'the 2.3 accent is used as is');
  assert.equal(tintTone('label-teal', 'prj_a'), 'teal', 'a 2.2 tint still maps');
  assert.equal(tintTone('label-1', 'prj_a'), LABEL_TONES[0], "'label-<n>' is 1-based");
  assert.equal(tintTone('label-6', 'prj_a'), LABEL_TONES[5]);
  assert.equal(tintTone('label-3', 'prj_a'), LABEL_TONES[2]);
  assert.equal(tintTone(null, 'prj_portail'), tintTone(undefined, 'prj_portail'), 'without a tint: stable per id');
  assert.ok(LABEL_TONES.includes(tintTone('red;background:url(x)', 'prj_b')), 'anything else falls back to a known hue (never reaches CSS)');
});

test('priorityRank: any single digit P0–P9 by its number; unknown values sort last (architect-55 prep)', () => {
  assert.deepEqual(['P9', 'P3', 'P10', 'P0', null, 'P4'].sort((a, b) => priorityRank(a) - priorityRank(b)), ['P0', 'P3', 'P4', 'P9', 'P10', null]);
  assert.ok(compareCards(card('a', 'P4', 1), card('b', 'P7', 99)) < 0, 'P4 before P7 whatever the activity');
});

test('sortFlags: priority, risk, feature, label; stable within a kind', () => {
  const flags = [{ kind: 'label', key: 'a' }, { kind: 'feature', key: 'f' }, { kind: 'risk', key: 'r1' }, { kind: 'priority', key: 'P1' }, { kind: 'risk', key: 'r2' }, { kind: 'label', key: 'b' }];
  assert.deepEqual(sortFlags(flags).map((f) => f.key), ['P1', 'r1', 'r2', 'f', 'a', 'b']);
});

import { safeImageUrl } from '../../public/v2/board.js';
test('R7-04: image URLs are https or same-origin, never anything that could leave a CSS/URL context', () => {
  const o = 'https://timmy.exemple.ca';
  assert.equal(safeImageUrl('https://opengraph.githubassets.com/1/a/b', o), 'https://opengraph.githubassets.com/1/a/b');
  assert.equal(safeImageUrl('/v2/bureau/assets/ProjectCovers/cover-01.png', o), 'https://timmy.exemple.ca/v2/bureau/assets/ProjectCovers/cover-01.png');
  const hostile = "https://example.invalid/x');position:fixed;inset:0;z-index:999999;background:red;--x:url('x";
  assert.doesNotMatch(safeImageUrl(hostile, o) || '', /[');\s]/, 'quotes, parentheses, semicolons and spaces are percent-encoded');
  for (const bad of ['http://example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//evil.example/a.png', 'ftp://x/y', '', null, 42]) {
    assert.equal(safeImageUrl(bad, o), null, String(bad));
  }
});
