import test from 'node:test';
import {
  act,
  allCards,
  assert,
  close,
  deckFor,
  discard,
  engine,
  extend,
  legal,
  meld,
  pass,
  pileDraw,
  playOut,
  rejected,
  scripted,
  start,
  step,
  stockDraw,
} from './helpers.mjs';

const game = 'thanasis';
const table = (wildRank) => ({ game, wildRank });
/** 4C 5C 6C 7C + 9D 9H 9S + JH QH KH, with the odd card to discard. */
const winning = [
  '4C-0',
  '5C-0',
  '6C-0',
  '7C-0',
  '9D-0',
  '9H-0',
  '9S-0',
  'JH-0',
  'QH-0',
  'KH-0',
];
const junk = [
  '2D-0',
  '4D-0',
  '6D-0',
  '8D-0',
  '10D-0',
  '2H-0',
  '4H-0',
  '6H-0',
  '8H-0',
  '10H-0',
];
function ready(overrides = {}) {
  return scripted(game, {
    hands: [winning, ['2D-0', '4D-0', '6D-0', '8D-0', '10D-0']],
    indicator: '3S-0',
    stock: ['AS-0'],
    ...overrides,
  });
}
test('a deal is ten cards each from one pack, with no Jokers', () => {
  const state = start(game);
  assert.equal(engine.DECKS.thanasis.length, 52);
  assert.deepEqual(
    state.hands.map((hand) => hand.length),
    [10, 10],
  );
  assert.equal(state.stock.length, 31);
  assert.equal(new Set(allCards(state)).size, 52);
  assert.equal(state.rulesVersion, engine.RULES_VERSIONS.thanasis);
});
test('the first open card names the wild rank for that deal', () => {
  const state = ready();
  assert.equal(state.wildRank, 3);
  assert.equal(engine.isWild('3C-0', state), true);
  assert.equal(engine.isWild('4C-0', state), false);
  assert.deepEqual(state.discard, ['3S-0']);
});
test('penalties count Aces as one, courts as ten and wild cards as 25', () => {
  const points = (card) => engine.cardPoints(card, table(3));
  assert.equal(points('AC-0'), 1);
  assert.equal(points('9C-0'), 9);
  assert.equal(points('JC-0'), 10);
  assert.equal(points('KC-0'), 10);
  assert.equal(points('3C-0'), 25);
});
test('the stock is the only draw, and melds stay hidden', () => {
  const state = ready();
  rejected(state, pileDraw, 'ILLEGAL_MOVE');
  assert.deepEqual(legal(state).actions, [{ type: 'draw', source: 'stock' }]);
  const drawn = act(state, stockDraw);
  rejected(drawn, meld(['4C-0', '5C-0', '6C-0']), 'ILLEGAL_MOVE');
  rejected(drawn, extend('meld-0', ['4C-0']), 'ILLEGAL_MOVE');
});
test('closing lays two triples and a four and discards the eleventh card', () => {
  const state = act(ready(), stockDraw);
  const closed = step(state, close('AS-0'));
  const round = closed.events.find((event) => event.type === 'round-ended');
  assert.equal(round.outcome.closer, 0);
  assert.equal(round.outcome.reason, 'closed');
  assert.equal(round.outcome.results[0].points, 0);
  assert.deepEqual(
    round.outcome.melds.map((item) => item.slots.length).sort(),
    [3, 3, 4],
  );
  const shown = round.outcome.melds.flatMap((item) =>
    item.slots.map((slot) => slot.card),
  );
  assert.deepEqual([...shown].sort(), [...winning].sort());
  assert.equal(closed.state.phase, 'round-end');
});
test('a close that leaves a wrong partition is refused', () => {
  const state = act(ready(), stockDraw);
  rejected(state, close('KH-0'), 'ILLEGAL_MOVE');
  rejected(state, close('2C-0'), 'ILLEGAL_MOVE');
  assert.deepEqual(
    legal(state)
      .actions.filter((action) => action.type === 'close')
      .map((action) => action.card),
    ['AS-0'],
  );
});
test('two fives are not a close: the pattern is exactly 3 + 3 + 4', () => {
  const two = [
    '4C-0',
    '5C-0',
    '6C-0',
    '7C-0',
    '8C-0',
    '9H-0',
    '10H-0',
    'JH-0',
    'QH-0',
    'KH-0',
  ];
  const state = act(ready({ hands: [two, ['2D-0']] }), stockDraw);
  rejected(state, close('AS-0'), 'ILLEGAL_MOVE');
});
test('a wild card counts toward the close, in any meld', () => {
  const hand = ['4C-0', '5C-0', '3D-0', '7C-0', ...winning.slice(4)];
  const state = act(ready({ hands: [hand, ['2D-0']] }), stockDraw);
  const closed = act(state, close('AS-0'));
  assert.equal(closed.rounds[0].closer, 0);
  const four = closed.rounds[0].melds.find((item) => item.slots.length === 4);
  assert.deepEqual(
    four.slots.map((slot) => [slot.rank, slot.wild]),
    [
      [4, false],
      [5, false],
      [6, true],
      [7, false],
    ],
  );
});
test('three wild-rank cards can stand for themselves as a set', () => {
  const hand = [
    '4C-0',
    '5C-0',
    '6C-0',
    '7C-0',
    '9D-0',
    '9H-0',
    '9S-0',
    '3C-0',
    '3D-0',
    '3H-0',
  ];
  const state = act(ready({ hands: [hand, ['2D-0']] }), stockDraw);
  assert.equal(act(state, close('AS-0')).rounds[0].closer, 0);
});
test('the Ace plays high in a close, but never around the corner', () => {
  const high = ['JD-0', 'QD-0', 'KD-0', 'AD-0', ...winning.slice(4)];
  const state = act(
    ready({ hands: [high, ['2C-0']], stock: ['AS-0'] }),
    stockDraw,
  );
  assert.equal(act(state, close('AS-0')).rounds[0].closer, 0);
  const corner = ['QD-0', 'KD-0', 'AD-0', '2D-0', ...winning.slice(4)];
  const refused = act(
    ready({ hands: [corner, ['2C-0']], stock: ['AS-0'] }),
    stockDraw,
  );
  rejected(refused, close('AS-0'), 'ILLEGAL_MOVE');
});
test('the loser pays only for cards outside their best melds', () => {
  const loser = [
    '2C-0',
    '2D-0',
    '2H-0',
    'AD-0',
    'KD-0',
    '8H-0',
    '10S-0',
    'QS-0',
    '6D-0',
    '8S-0',
  ];
  const state = act(ready({ hands: [winning, loser] }), stockDraw);
  const closed = act(state, close('AS-0'));
  const expected = 1 + 10 + 8 + 10 + 10 + 6 + 8;
  assert.equal(closed.rounds[0].results[1].points, expected);
  assert.equal(closed.rounds[0].results[1].handPoints, expected);
  assert.deepEqual(closed.scores, [0, expected]);
});
test('penalty relief picks the melds that remove the most points', () => {
  const loser = [
    'JD-0',
    'JC-0',
    'JS-0',
    '10S-0',
    'QS-0',
    '2C-0',
    '2D-0',
    '2H-0',
    '4H-0',
    '6H-0',
  ];
  const state = act(ready({ hands: [winning, loser] }), stockDraw);
  const closed = act(state, close('AS-0'));
  // JS can sit in the Jacks or the spade run; either way 30 comes off, plus the 2s.
  assert.equal(closed.rounds[0].results[1].points, 10 + 10 + 4 + 6);
});
test('a wild card in hand costs 25 unless a meld uses it', () => {
  const holding = [
    '3C-0',
    '2D-0',
    '5H-0',
    '8H-0',
    '10S-0',
    'QS-0',
    '6D-0',
    '8S-0',
    'KD-0',
    'JD-0',
  ];
  const state = act(ready({ hands: [winning, holding] }), stockDraw);
  const closed = act(state, close('AS-0'));
  // The hand totals 94, and the wild card's best meld removes 45 of it.
  assert.equal(closed.rounds[0].results[1].points, 94 - 45);
});
test('five-card runs get no relief beyond their best short melds', () => {
  const runner = [
    '2D-0',
    '4D-0',
    '5D-0',
    '6D-0',
    '7D-0',
    '8D-0',
    'KS-0',
    'QS-0',
    '10S-0',
    '8S-0',
  ];
  const state = act(ready({ hands: [winning, runner] }), stockDraw);
  const closed = act(state, close('AS-0'));
  // 4-5-6-7-8 of diamonds only comes off four at a time, keeping the 4.
  assert.equal(closed.rounds[0].results[1].points, 2 + 4 + 10 + 10 + 10 + 8);
});
test('an empty stock scores both hands and needs no closer', () => {
  let state = ready({ hands: [['AC-0'], ['AD-0']], stock: [] });
  const total = state.stock.length;
  for (let turn = 0; turn < total - 1; turn++) state = pass(state);
  const drawn = act(state, stockDraw);
  const result = step(drawn, discard(drawn.hands[drawn.turn].at(-1)));
  const ended = result.events.find((event) => event.type === 'round-ended');
  assert.equal(ended.outcome.reason, 'stock');
  assert.equal(ended.outcome.closer, null);
  assert.deepEqual(
    ended.outcome.results.map((item) => item.points),
    ended.outcome.scores,
  );
});
function roundClosedBy(seat, scores = undefined) {
  const hands = seat === 0 ? [winning, junk] : [junk, winning];
  const state = scripted(
    game,
    { hands, indicator: '3S-0', stock: ['AS-0', 'JS-0'] },
    { firstStarter: seat, ...(scores ? { scores } : {}) },
  );
  return act(act(state, stockDraw), close('AS-0'));
}
test('after five deals the lower total wins', () => {
  const decks = [0, 1, 0, 1, 0].map((seat) =>
    deckFor(game, {
      hands: seat === 0 ? [winning, junk] : [junk, winning],
      indicator: '3S-0',
      stock: ['AS-0'],
    }),
  );
  let state = scripted(
    game,
    { hands: [], indicator: '3S-0' },
    { firstStarter: 0, decks },
  );
  for (let round = 1; round <= 5; round++) {
    assert.equal(state.roundNumber, round);
    assert.notEqual(state.phase, 'ended');
    state = act(act(state, stockDraw), close('AS-0'));
    if (round < 5) {
      assert.equal(state.phase, 'round-end');
      state = act(state, { type: 'next' });
    }
  }
  assert.equal(state.phase, 'ended');
  assert.equal(state.matchOutcome.side, 0);
  assert.equal(state.matchOutcome.reason, 'deals-completed');
  assert.deepEqual(
    state.rounds.map((round) => round.closer),
    [0, 1, 0, 1, 0],
  );
});
test('the fifth deal ends the match, and a tie keeps playing', () => {
  let state = start(game, 3);
  state = playOut(state, 7, (current) => current.roundNumber === 3);
  assert.equal(state.phase, 'draw');
  state = playOut(state, 8, () => false);
  assert.equal(state.phase, 'ended');
  assert.ok(state.rounds.length >= 5);
  assert.equal(state.matchOutcome.reason, 'deals-completed');
  const [first, second] = state.scores;
  assert.notEqual(first, second);
  assert.equal(state.scores[state.matchOutcome.side], Math.min(first, second));
  const prior = state.rounds.slice(4, -1);
  for (const round of prior)
    assert.equal(round.scores[0], round.scores[1], 'only a tie extends it');
});
test('the closer adds nothing and the other player pays', () => {
  const closed = roundClosedBy(1, [12, 3]);
  assert.equal(closed.scores[1], 3);
  assert.ok(closed.scores[0] > 12);
});
test('random matches always finish with every card accounted for', () => {
  for (let n = 0; n < 12; n++) {
    const end = playOut(
      start(game, n),
      n + 1,
      () => false,
      (state) => {
        assert.equal(allCards(state).length, 52);
        assert.equal(new Set(allCards(state)).size, 52);
      },
    );
    assert.equal(end.phase, 'ended');
  }
});
