import test from 'node:test';
import {
  act,
  allCards,
  assert,
  deckFor,
  discard,
  engine,
  extend,
  legal,
  meld,
  ok,
  pass,
  pileDraw,
  playersOf,
  playOut,
  rejected,
  replace,
  scripted,
  seed,
  start,
  step,
  stockDraw,
} from './helpers.mjs';

const game = 'koumkan';
const table = { game, wildRank: null };
const run = (layout) => scripted(game, layout);
const finisher = [
  '5C-0',
  '6C-0',
  '7C-0',
  'KH-0',
  'QD-0',
  '2S-0',
  '3S-0',
  '4S-0',
  'JD-0',
  'JC-0',
];
/** Seat 0 melds nine cards on the first turn and is left holding only `keep`. */
function downToOne({
  keep = 'KH-0',
  other = ['3H-0'],
  stock = [],
  ...options
}) {
  const hand = finisher.map((card) => (card === 'KH-0' ? keep : card));
  let state = scripted(
    game,
    {
      hands: [hand, other],
      indicator: '9D-0',
      stock: ['JH-0', '8D-1', ...stock],
    },
    options,
  );
  state = act(state, stockDraw);
  state = act(state, meld(['5C-0', '6C-0', '7C-0']));
  state = act(state, meld(['2S-0', '3S-0', '4S-0']));
  state = act(state, meld(['JD-0', 'JC-0', 'JH-0']));
  state = act(state, discard('QD-0'));
  state = act(state, stockDraw);
  return act(state, discard('8D-1'));
}
function closeOut(options = {}) {
  let state = downToOne({ ...options, stock: ['8C-1'] });
  state = act(state, stockDraw);
  state = act(state, extend('meld-0', ['8C-1']));
  return act(state, discard('KH-0'));
}
test('a deal is ten cards each from two packs and two Jokers', () => {
  const state = start(game);
  assert.equal(engine.DECKS.koumkan.length, 106);
  assert.deepEqual(
    state.hands.map((hand) => hand.length),
    [10, 10],
  );
  assert.equal(state.discard.length, 1);
  assert.equal(state.stock.length, 85);
  assert.equal(new Set(allCards(state)).size, 106);
  assert.equal(state.phase, 'draw');
  assert.equal(state.rulesVersion, engine.RULES_VERSIONS.koumkan);
});
test('the opening discard is never a Joker', () => {
  const stock = ['9D-0', '9D-1'];
  const hands = [['AC-0'], ['AD-0']];
  const deck = deckFor(game, { hands, indicator: 'JOKER-0', stock });
  const state = ok(
    engine.createAnalysisGame({
      game,
      players: playersOf(game),
      seed: seed(),
      firstStarter: 0,
      decks: [deck],
    }),
  );
  assert.equal(state.indicator, '9D-0');
  assert.deepEqual(state.discard, ['9D-0']);
  assert.equal(state.stock[0], '9D-1');
  assert.equal(state.stock.at(-1), 'JOKER-0');
});
test('card penalties match the designer values', () => {
  const points = (card) => engine.cardPoints(card, table);
  assert.equal(points('AH-0'), 11);
  assert.equal(points('2H-0'), 2);
  assert.equal(points('10H-0'), 10);
  assert.equal(points('JH-0'), 10);
  assert.equal(points('QH-0'), 10);
  assert.equal(points('KH-0'), 10);
  assert.equal(points('JOKER-0'), 20);
});
test('a turn draws first, then discards', () => {
  const state = run({
    hands: [['3C-0'], ['4C-0']],
    indicator: '9D-0',
    stock: ['KD-1'],
  });
  rejected(state, discard('3C-0'), 'ILLEGAL_MOVE');
  rejected(state, meld(['3C-0']), 'ILLEGAL_MOVE');
  const drawn = act(state, stockDraw);
  assert.equal(drawn.hands[0].at(-1), 'KD-1');
  rejected(drawn, stockDraw, 'ILLEGAL_MOVE');
  rejected(drawn, pileDraw, 'ILLEGAL_MOVE');
  const done = act(drawn, discard('3C-0'));
  assert.equal(done.turn, 1);
  assert.equal(done.phase, 'draw');
  assert.equal(done.hands[0].length, 10);
  assert.equal(done.discard.at(-1), '3C-0');
});
test('the top discard can be drawn instead of the stock', () => {
  const state = run({
    hands: [['3C-0'], ['4C-0']],
    indicator: '9D-0',
    stock: ['KD-1'],
  });
  const drawn = act(state, pileDraw);
  assert.equal(drawn.hands[0].at(-1), '9D-0');
  assert.deepEqual(drawn.discard, []);
  assert.equal(drawn.stock[0], 'KD-1');
  const back = act(drawn, discard('9D-0'));
  assert.deepEqual(back.discard, ['9D-0']);
});
test('a drawn pile card is public in the event, a stock card is not', () => {
  const state = run({
    hands: [['3C-0'], ['4C-0']],
    indicator: '9D-0',
    stock: ['KD-1'],
  });
  assert.deepEqual(step(state, pileDraw).events[0].cards, ['9D-0']);
  assert.deepEqual(step(state, stockDraw).events[0].cards, []);
});
function meldedHand() {
  return run({
    hands: [
      ['5C-0', '6C-0', '7C-0', 'KH-0', 'QD-0'],
      ['8C-0', '4C-0', '9H-1', 'JOKER-1'],
    ],
    indicator: '9D-0',
    stock: ['KD-1', '3H-1', '3S-1'],
  });
}
test('a meld opens the player, who may then lay off in the same turn', () => {
  const drawn = act(meldedHand(), stockDraw);
  rejected(drawn, extend('meld-0', ['KH-0']), 'ILLEGAL_MOVE');
  const opened = act(drawn, meld(['5C-0', '6C-0', '7C-0']));
  assert.deepEqual(opened.opened, [true, false]);
  assert.equal(opened.melds[0].id, 'meld-0');
  assert.equal(opened.melds[0].owner, 0);
  assert.equal(opened.turn, 0);
  assert.equal(opened.hands[0].length, 8);
});
test('a lay-off needs the player to have opened, on any meld on the table', () => {
  let state = act(act(meldedHand(), stockDraw), meld(['5C-0', '6C-0', '7C-0']));
  state = act(state, discard('KH-0'));
  state = act(state, stockDraw);
  rejected(state, extend('meld-0', ['8C-0']), 'ILLEGAL_MOVE');
});
test('laying off extends either end of an opponent meld', () => {
  const dealt = run({
    hands: [
      ['5C-0', '6C-0', '7C-0', 'KH-0', 'QD-0'],
      ['8C-0', '4C-0', '3H-0', '3S-0', '3D-0'],
    ],
    indicator: '9D-0',
    stock: ['KD-1', '3C-1', '3C-0'],
  });
  let state = act(act(dealt, stockDraw), meld(['5C-0', '6C-0', '7C-0']));
  state = act(state, discard('KH-0'));
  state = act(state, stockDraw);
  state = act(state, meld(['3H-0', '3S-0', '3D-0']));
  const high = act(state, extend('meld-0', ['8C-0']));
  assert.deepEqual(
    high.melds[0].slots.map((slot) => slot.rank),
    [5, 6, 7, 8],
  );
  assert.equal(high.melds[0].owner, 0);
  const low = act(high, extend('meld-0', ['4C-0']));
  assert.deepEqual(
    low.melds[0].slots.map((slot) => slot.rank),
    [4, 5, 6, 7, 8],
  );
});
test('a lay-off must fit the meld', () => {
  let state = act(act(meldedHand(), stockDraw), meld(['5C-0', '6C-0', '7C-0']));
  rejected(state, extend('meld-0', ['KH-0']), 'ILLEGAL_MOVE');
  rejected(state, extend('meld-9', ['KH-0']), 'ILLEGAL_MOVE');
  rejected(state, extend('meld-0', []), 'ILLEGAL_MOVE');
  rejected(state, extend('meld-0', ['8C-0']), 'ILLEGAL_MOVE');
  assert.equal(state.melds.length, 1);
});
test('a set takes a fourth card of the missing suit, and stops at four', () => {
  const dealt = run({
    hands: [
      ['7C-0', '7D-0', '7H-0', '7S-0', '7S-1', 'KD-0'],
      ['3H-0', '4H-0'],
    ],
    indicator: '9D-0',
    stock: ['KD-1'],
  });
  const state = act(act(dealt, stockDraw), meld(['7C-0', '7D-0', '7H-0']));
  const full = act(state, extend('meld-0', ['7S-0']));
  assert.equal(full.melds[0].slots.length, 4);
  rejected(full, extend('meld-0', ['7S-1']), 'ILLEGAL_MOVE');
});
function jokerTable(extra = {}) {
  return run({
    hands: [
      ['5C-0', '7C-0', 'JOKER-0', 'KH-0', 'QD-0', '6D-1'],
      ['6C-1', 'QS-0', 'QH-0', 'QC-0', '9S-0', '9H-0', '6C-0'],
    ],
    indicator: '9D-0',
    stock: ['KD-1', '3H-1', '3S-1', '2S-1'],
    ...extra,
  });
}
test('the exact natural card takes a Joker back, after opening', () => {
  let state = act(
    act(jokerTable(), stockDraw),
    meld(['5C-0', '7C-0', 'JOKER-0']),
  );
  assert.equal(state.melds[0].slots[1].wild, true);
  state = act(state, discard('KH-0'));
  state = act(state, stockDraw);
  rejected(state, replace('meld-0', '6C-1'), 'ILLEGAL_MOVE');
  state = act(state, meld(['QS-0', 'QH-0', 'QC-0']));
  rejected(state, replace('meld-0', '9S-0'), 'ILLEGAL_MOVE');
  rejected(state, replace('meld-9', '6C-1'), 'ILLEGAL_MOVE');
  const result = step(state, replace('meld-0', '6C-1'));
  const slot = result.state.melds[0].slots[1];
  assert.deepEqual(slot, { card: '6C-1', rank: 6, suit: 'C', wild: false });
  assert.ok(result.state.hands[1].includes('JOKER-0'));
  assert.equal(result.state.hands[1].includes('6C-1'), false);
  assert.equal(result.events[0].joker, 'JOKER-0');
  assert.equal(result.state.turn, 1);
});
test('a Joker cannot be swapped for another wild card or the wrong suit', () => {
  let state = act(
    act(
      run({
        hands: [
          ['5C-0', '7C-0', 'JOKER-0', '6D-1', 'JOKER-1', '8D-0'],
          ['2H-0'],
        ],
        indicator: '9D-0',
        stock: ['KD-1'],
      }),
      stockDraw,
    ),
    meld(['5C-0', '7C-0', 'JOKER-0']),
  );
  rejected(state, replace('meld-0', 'JOKER-1'), 'ILLEGAL_MOVE');
  rejected(state, replace('meld-0', '6D-1'), 'ILLEGAL_MOVE');
  rejected(state, replace('meld-0', '6C-0'), 'ILLEGAL_MOVE');
});
test('only a wild slot can be replaced, never a natural card', () => {
  const state = act(
    act(
      run({
        hands: [['5C-0', '7C-0', 'JOKER-0', '5C-1', '4D-0'], ['2H-0']],
        indicator: '9D-0',
        stock: ['KD-1'],
      }),
      stockDraw,
    ),
    meld(['5C-0', '7C-0', 'JOKER-0']),
  );
  rejected(state, replace('meld-0', '5C-1'), 'ILLEGAL_MOVE');
});
test('the Joker in an Ace-high slot goes back for an Ace', () => {
  const state = act(
    act(
      run({
        hands: [['QC-0', 'KC-0', 'JOKER-0', 'AC-1', '4D-0'], ['2H-0']],
        indicator: '9D-0',
        stock: ['KD-1'],
      }),
      stockDraw,
    ),
    meld(['QC-0', 'KC-0', 'JOKER-0'], 1),
  );
  assert.equal(state.melds[0].slots[2].rank, 14);
  const swapped = act(state, replace('meld-0', 'AC-1'));
  assert.equal(swapped.melds[0].slots[2].card, 'AC-1');
  assert.equal(swapped.melds[0].slots[2].rank, 14);
});
test('a Joker in a set is replaced only by its assigned suit', () => {
  const state = act(
    act(
      run({
        hands: [['6C-0', '6H-0', 'JOKER-0', '6D-1', '6S-1', '4D-0'], ['2H-0']],
        indicator: '9D-0',
        stock: ['KD-1'],
      }),
      stockDraw,
    ),
    meld(['6C-0', '6H-0', 'JOKER-0']),
  );
  assert.equal(state.melds[0].slots[2].suit, 'D');
  rejected(state, replace('meld-0', '6S-1'), 'ILLEGAL_MOVE');
  rejected(state, extend('meld-0', ['6D-1']), 'ILLEGAL_MOVE');
  const full = act(state, extend('meld-0', ['6S-1']));
  assert.equal(full.melds[0].slots.length, 4);
  const swapped = act(state, replace('meld-0', '6D-1'));
  assert.equal(swapped.melds[0].slots[2].card, '6D-1');
});
test('a Joker laid off keeps the one already placed where it was', () => {
  const state = act(
    act(
      run({
        hands: [
          ['6C-0', '8C-0', 'JOKER-1', 'JOKER-0', '9C-0', '4D-0'],
          ['2H-0'],
        ],
        indicator: '9D-0',
        stock: ['KD-1'],
      }),
      stockDraw,
    ),
    meld(['6C-0', '8C-0', 'JOKER-1']),
  );
  const below = ok(
    engine.getMeldOptions(state, 'seat0', {
      cards: ['JOKER-0'],
      meld: 'meld-0',
    }),
  ).find((option) => option.slots[0].rank === 5);
  assert.ok(below, 'a Joker can land below the one on the table');
  const next = act(state, extend('meld-0', ['JOKER-0'], below.option));
  assert.deepEqual(
    next.melds[0].slots.map((slot) => [slot.rank, slot.card]),
    [
      [5, 'JOKER-0'],
      [6, '6C-0'],
      [7, 'JOKER-1'],
      [8, '8C-0'],
    ],
  );
});
test('going out needs a final discard', () => {
  const state = act(downToOne({ stock: ['8C-1'] }), stockDraw);
  rejected(state, extend('meld-0', ['KH-0']), 'ILLEGAL_MOVE');
  assert.equal(state.hands[0].length, 2);
  const out = act(state, extend('meld-0', ['8C-1']));
  const last = step(out, discard('KH-0'));
  const ended = last.events.find((event) => event.type === 'round-ended');
  assert.equal(ended.outcome.closer, 0);
  assert.equal(ended.outcome.reason, 'closed');
  assert.equal(ended.outcome.results[0].points, 0);
});
test('a play may never empty the hand without a discard', () => {
  const state = act(downToOne({ keep: '8C-1', stock: ['9C-1'] }), stockDraw);
  rejected(state, extend('meld-0', ['8C-1', '9C-1']), 'ILLEGAL_MOVE');
  const down = act(state, extend('meld-0', ['8C-1']));
  assert.deepEqual(down.hands[0], ['9C-1']);
  assert.equal(act(down, discard('9C-1')).rounds[0].closer, 0);
});
test('with one card, the pile is closed and the new card is kept', () => {
  const state = downToOne({ stock: ['9H-1'] });
  assert.deepEqual(state.hands[0], ['KH-0']);
  rejected(state, pileDraw, 'ILLEGAL_MOVE');
  assert.deepEqual(
    legal(state).actions.map((action) => action.source),
    ['stock'],
  );
  const drawn = act(state, stockDraw);
  rejected(drawn, discard('9H-1'), 'ILLEGAL_MOVE');
  assert.deepEqual(act(drawn, discard('KH-0')).hands[0], ['9H-1']);
});
test('the newly drawn card can go with a bigger hand', () => {
  const state = act(
    run({ hands: [['3C-0'], ['4C-0']], indicator: '9D-0', stock: ['KD-1'] }),
    stockDraw,
  );
  assert.equal(act(state, discard('KD-1')).discard.at(-1), 'KD-1');
});
test('an empty stock ends the round after the last discard', () => {
  const state = scripted(game, {
    hands: [
      ['AC-0', 'AD-0'],
      ['JOKER-0', 'KC-0'],
    ],
    indicator: '9D-0',
  });
  let current = state;
  const total = current.stock.length;
  for (let turn = 0; turn < total - 1; turn++) current = pass(current);
  assert.equal(current.stock.length, 1);
  assert.equal(current.roundNumber, 1);
  const seat = current.turn;
  const penalties = (hand) =>
    hand.reduce((sum, card) => sum + engine.cardPoints(card, table), 0);
  const drawn = act(current, stockDraw);
  const last = drawn.hands[seat].at(-1);
  const hands = [...drawn.hands];
  hands[seat] = hands[seat].filter((card) => card !== last);
  const result = step(drawn, discard(last));
  const ended = result.events.find((event) => event.type === 'round-ended');
  assert.equal(ended.outcome.reason, 'stock');
  assert.equal(ended.outcome.closer, null);
  assert.deepEqual(
    ended.outcome.results.map((item) => item.points),
    hands.map(penalties),
  );
});
test('the match ends at 100 and the lower total wins', () => {
  const state = closeOut({ other: ['AH-0', 'JOKER-0'], scores: [10, 60] });
  assert.equal(state.phase, 'ended');
  assert.equal(state.matchOutcome.side, 0);
  assert.deepEqual(state.matchOutcome.winnerIds, ['seat0']);
  assert.equal(state.matchOutcome.reason, 'limit-reached');
  assert.ok(state.scores[1] >= 100);
  assert.equal(state.scores[0], 10);
});
test('the higher score decides nothing: the lower total wins even past 100', () => {
  const state = closeOut({ scores: [150, 90] });
  assert.equal(state.phase, 'ended');
  assert.equal(
    state.matchOutcome.side,
    state.scores[0] < state.scores[1] ? 0 : 1,
  );
});
test('the match ends on exactly 100 and not on 99', () => {
  const loss = closeOut().scores[1];
  const exact = closeOut({ scores: [0, 100 - loss] });
  assert.equal(exact.scores[1], 100);
  assert.equal(exact.phase, 'ended');
  const short = closeOut({ scores: [0, 99 - loss] });
  assert.equal(short.scores[1], 99);
  assert.equal(short.phase, 'round-end');
});
test('below the limit the scores stay up until next, which rotates the starter', () => {
  const ended = closeOut();
  assert.equal(ended.phase, 'round-end');
  assert.equal(ended.roundNumber, 1);
  assert.equal(ended.melds.length, 3);
  const next = act(ended, { type: 'next' });
  assert.equal(next.phase, 'draw');
  assert.equal(next.roundNumber, 2);
  assert.equal(next.starter, 1);
  assert.equal(next.turn, 1);
  assert.deepEqual(next.melds, []);
  assert.deepEqual(next.opened, [false, false]);
  assert.equal(next.rounds.length, 1);
  assert.equal(new Set(allCards(next)).size, 106);
});
test('an exact tie for the lead past 100 plays another round', () => {
  const loss = closeOut().scores[1];
  const ended = closeOut({ scores: [120, 120 - loss] });
  assert.deepEqual(ended.scores, [120, 120]);
  assert.equal(ended.phase, 'round-end');
  assert.equal(ended.matchOutcome, null);
  assert.equal(act(ended, { type: 'next' }).roundNumber, 2);
});
test('random matches always finish with every card accounted for', () => {
  for (let n = 0; n < 6; n++) {
    const end = playOut(
      start(game, n),
      n + 1,
      () => false,
      (state) => {
        assert.equal(new Set(allCards(state)).size, 106);
        assert.equal(allCards(state).length, 106);
      },
    );
    assert.equal(end.phase, 'ended');
    assert.ok(Math.max(...end.scores) >= 100);
    assert.equal(end.scores[end.matchOutcome.side], Math.min(...end.scores));
    assert.notEqual(end.scores[0], end.scores[1]);
  }
});
