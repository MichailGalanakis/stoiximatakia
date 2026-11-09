import test from 'node:test';
import { movesFor } from '../dist/esm/combos.js';
import { assert, engine } from './helpers.mjs';

const { beats, cardPoints, combinations } = engine;
const kinds = (cards, top) =>
  combinations(cards, top).map((combo) => `${combo.kind}:${combo.value}`);
const one = (cards, top) => combinations(cards, top)[0];

test('card points add up to 100', () => {
  assert.equal(cardPoints('5C'), 5);
  assert.equal(cardPoints('10C'), 10);
  assert.equal(cardPoints('KC'), 10);
  assert.equal(cardPoints('DRAGON'), 25);
  assert.equal(cardPoints('PHOENIX'), -25);
  for (const card of ['2C', 'QC', 'AC', 'MAHJONG', 'DOG'])
    assert.equal(cardPoints(card), 0);
  assert.equal(
    engine.DECK.reduce((sum, card) => sum + cardPoints(card), 0),
    100,
  );
});
test('single cards rank from the Mah Jong to the Dragon', () => {
  assert.deepEqual(kinds(['MAHJONG']), ['single:1']);
  assert.deepEqual(kinds(['2C']), ['single:2']);
  assert.deepEqual(kinds(['KD']), ['single:13']);
  assert.deepEqual(kinds(['AD']), ['single:14']);
  assert.deepEqual(kinds(['DRAGON']), ['single:100']);
});
test('the Phoenix as a single sits half a step above the table', () => {
  assert.deepEqual(kinds(['PHOENIX']), ['single:1.5']);
  assert.deepEqual(kinds(['PHOENIX'], one(['AD'])), ['single:14.5']);
  assert.deepEqual(kinds(['PHOENIX'], one(['DRAGON'])), []);
  const phoenix = one(['PHOENIX'], one(['7D']));
  assert.equal(beats(one(['7C']), phoenix), false);
  assert.equal(beats(one(['8C']), phoenix), true);
});
test('the Dog is only a lead, and the Dragon only a single', () => {
  assert.deepEqual(kinds(['DOG']), ['dog:0']);
  assert.deepEqual(kinds(['DOG'], one(['2C'])), []);
  assert.deepEqual(kinds(['DOG', '2C']), []);
  assert.deepEqual(kinds(['DRAGON', 'AC']), []);
  assert.deepEqual(kinds(['DRAGON', 'PHOENIX']), []);
  assert.deepEqual(kinds(['DOG', 'PHOENIX']), []);
});
test('pairs and triples need one rank, with one Phoenix allowed', () => {
  assert.deepEqual(kinds(['7C', '7D']), ['pair:7']);
  assert.deepEqual(kinds(['7C', 'PHOENIX']), ['pair:7']);
  assert.deepEqual(kinds(['7C', '8C']), []);
  assert.deepEqual(kinds(['7C', '7D', '7H']), ['triple:7']);
  assert.deepEqual(kinds(['7C', '7D', 'PHOENIX']), ['triple:7']);
  assert.deepEqual(kinds(['7C', '8D', 'PHOENIX']), []);
  assert.deepEqual(kinds(['MAHJONG', 'PHOENIX']), []);
});
test('a full house compares by its triple, and the Phoenix can pick it', () => {
  assert.deepEqual(kinds(['7C', '7D', '7H', '2C', '2D']), ['full:7']);
  assert.deepEqual(kinds(['7C', '7D', '2H', '2C', 'PHOENIX']).sort(), [
    'full:2',
    'full:7',
  ]);
  assert.deepEqual(kinds(['7C', '7D', '7H', '2C', 'PHOENIX']), ['full:7']);
  assert.deepEqual(kinds(['7C', '7D', '7H', '7S', 'PHOENIX']), []);
  assert.deepEqual(kinds(['7C', '7D', '2C', '3D', 'PHOENIX']), []);
});
test('the Mah Jong joins only straights', () => {
  assert.deepEqual(kinds(['MAHJONG', '2C', '2D', '2H', 'PHOENIX']), []);
  assert.deepEqual(kinds(['MAHJONG', 'PHOENIX', '2C', '2D']), []);
  assert.deepEqual(kinds(['MAHJONG', '2C', '2D']), []);
});
test('consecutive pairs need adjacent ranks', () => {
  assert.deepEqual(kinds(['3C', '3D', '4C', '4D']), ['pairs:4']);
  assert.deepEqual(kinds(['3C', '3D', '4C', 'PHOENIX']), ['pairs:4']);
  assert.deepEqual(kinds(['3C', '3D', '5C', '5D']), []);
  assert.deepEqual(kinds(['3C', '3D', '4C', '4D', '5C', '5D']), ['pairs:5']);
  assert.deepEqual(kinds(['3C', '3D', '3H', 'PHOENIX']), []);
});
test('a straight needs five or more ranks, and the Ace is high', () => {
  const straight = ['2C', '3D', '4C', '5D', '6C'];
  assert.deepEqual(kinds(straight), ['straight:6']);
  assert.deepEqual(kinds(straight.slice(0, 4)), []);
  assert.deepEqual(kinds(['10C', 'JD', 'QC', 'KD', 'AC']), ['straight:14']);
  assert.deepEqual(kinds(['AC', '2D', '3C', '4D', '5C']), []);
  assert.deepEqual(kinds(['MAHJONG', '2D', '3C', '4D', '5C']), ['straight:5']);
});
test('the Phoenix fills a straight, but never as the Mah Jong', () => {
  assert.deepEqual(kinds(['2C', '3D', '5C', '6D', 'PHOENIX']), ['straight:6']);
  assert.deepEqual(kinds(['2C', '3D', '4C', '5D', 'PHOENIX']), ['straight:6']);
  assert.deepEqual(kinds(['10C', 'JD', 'QC', 'KD', 'PHOENIX']).sort(), [
    'straight:13',
    'straight:14',
  ]);
  assert.deepEqual(kinds(['MAHJONG', '2C', '3D', '4C', 'PHOENIX']), [
    'straight:5',
  ]);
});
test('bombs are four of a kind or a natural straight flush', () => {
  assert.deepEqual(kinds(['7C', '7D', '7H', '7S']), ['bomb:7']);
  assert.equal(one(['7C', '7D', '7H', '7S']).bomb, 4);
  const flush = ['2C', '3C', '4C', '5C', '6C'];
  assert.deepEqual(kinds(flush), ['bomb:6']);
  assert.equal(one(flush).bomb, 5);
  assert.deepEqual(kinds([...flush.slice(0, 4), 'PHOENIX']), ['straight:6']);
  assert.deepEqual(kinds(['MAHJONG', '2C', '3C', '4C', '5C']), ['straight:5']);
  assert.deepEqual(kinds(['7C', '7D', '7H', 'PHOENIX']), []);
});
test('a normal play needs the same kind and size at a higher value', () => {
  assert.equal(beats(one(['8C']), one(['7C'])), true);
  assert.equal(beats(one(['7D']), one(['7C'])), false);
  assert.equal(beats(one(['8C', '8D']), one(['7C'])), false);
  assert.equal(
    beats(
      one(['3C', '4D', '5C', '6D', '7C', '8D']),
      one(['2C', '3D', '4C', '5D', '6C']),
    ),
    false,
  );
  assert.equal(beats(one(['2C']), null), true);
});
test('a bomb beats any ordinary play, and only a stronger bomb beats it', () => {
  const four = one(['7C', '7D', '7H', '7S']),
    higher = one(['9C', '9D', '9H', '9S']),
    flush = one(['2C', '3C', '4C', '5C', '6C']),
    longer = one(['2D', '3D', '4D', '5D', '6D', '7D']),
    taller = one(['3H', '4H', '5H', '6H', '7H']),
    equal = one(['2S', '3S', '4S', '5S', '6S']);
  assert.equal(beats(four, one(['DRAGON'])), true);
  assert.equal(beats(four, one(['2C', '3D', '4C', '5D', '6C'])), true);
  assert.equal(beats(higher, four), true);
  assert.equal(beats(four, higher), false);
  assert.equal(beats(flush, higher), true);
  assert.equal(beats(higher, flush), false);
  assert.equal(beats(longer, taller), true);
  assert.equal(beats(taller, flush), true);
  assert.equal(beats(equal, flush), false);
  assert.equal(beats(one(['AC']), four), false);
  assert.equal(beats(one(['DRAGON']), four), false);
});
function shuffledHand(n, size) {
  let x = n * 2654435761 + 1;
  const deck = [...engine.DECK];
  for (let i = deck.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = (x >>> 8) % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck.slice(0, size);
}
const keyOf = (cards, option) => `${[...cards].sort().join()}|${option}`;
function everySubset(hand, top) {
  const found = new Set();
  for (let mask = 1; mask < 1 << hand.length; mask++) {
    const cards = hand.filter((_, index) => mask & (1 << index));
    combinations(cards, top).forEach((combo, option) => {
      if (beats(combo, top)) found.add(keyOf(cards, option));
    });
  }
  return found;
}
test('the move list matches every subset of the hand', () => {
  const tops = [
    null,
    one(['7C']),
    one(['AC']),
    one(['8C', '8D']),
    one(['6C', '6D', '6H', '2S', '2D']),
    one(['3C', '4D', '5C', '6D', '7H']),
    one(['9C', '9D', '9H', '9S']),
  ];
  for (let n = 0; n < 40; n++) {
    const hand = shuffledHand(n, 8 + (n % 7));
    const top = tops[n % tops.length];
    const moves = movesFor(hand, top);
    const listed = new Set(
      moves.map((move) => {
        // Order within a play must not change which reading an option names.
        assert.equal(move.combo.size, move.cards.length);
        return keyOf(move.cards, move.option);
      }),
    );
    assert.deepEqual([...listed].sort(), [...everySubset(hand, top)].sort());
    assert.equal(listed.size, moves.length, 'a repeated move');
  }
});
test('hands rich in pairs and the Phoenix still list everything', () => {
  const hand = [
    '3C',
    '3D',
    '4C',
    '4D',
    '5C',
    '5D',
    '6C',
    '6D',
    '7C',
    '8D',
    'PHOENIX',
    'MAHJONG',
    '2H',
  ];
  const listed = new Set(
    movesFor(hand, null).map((move) => keyOf(move.cards, move.option)),
  );
  assert.deepEqual([...listed].sort(), [...everySubset(hand, null)].sort());
});
