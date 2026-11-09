import test from 'node:test';
import {
  act,
  advance,
  allCards,
  assert,
  capture,
  declarationOf,
  deckFor,
  declare,
  engine,
  expectedCardPoints,
  finishRound,
  nextRound,
  firstLegal,
  lay,
  ok,
  players,
  rejected,
  scripted,
  seed,
  sequence,
  start,
  tableIds,
} from './helpers.mjs';

const fullDeck = new Set(engine.DECK);
const LAYOUT = ['2C', '3C', '4C', '5C'];

test('6.1 deals six cards each, four table cards and leaves 36 in stock', () => {
  const state = start();
  assert.deepEqual(
    state.hands.map((hand) => hand.length),
    [6, 6],
  );
  assert.equal(state.table.length, 4);
  assert.equal(state.stock.length, 36);
  assert.deepEqual(new Set(allCards(state)), fullDeck);
  assert.ok(state.table.every((item) => item.cards.length === 1));
});

test('6.1 the non-dealer starts and leads every batch of the round', () => {
  let state = start(1);
  const starter = state.dealer === 0 ? 1 : 0;
  assert.equal(state.turn, starter);
  const batches = [];
  for (let batch = 1; batch <= 3; batch++) {
    for (let i = 0; i < 12; i++) state = act(state, firstLegal(state));
    batches.push([state.batch, state.turn, state.stock.length]);
  }
  assert.deepEqual(batches, [
    [2, starter, 24],
    [3, starter, 12],
    [4, starter, 0],
  ]);
});

test('6.1 a new batch does not refresh the table', () => {
  let state = scripted(LAYOUT);
  for (let i = 0; i < 12; i++) state = act(state, firstLegal(state));
  assert.equal(state.batch, 2);
  const onTable = state.table.flatMap((item) => item.cards);
  assert.equal(onTable.length + state.captured.flat().length, 16);
  assert.equal(state.stock.length, 24);
});

test('6.1 three or four equal court cards in the layout are replaced', () => {
  for (const layout of [
    ['KC', 'KD', 'KH', '5C'],
    ['QC', 'QD', 'QH', 'QS'],
  ]) {
    const state = scripted(layout);
    for (const rank of ['J', 'Q', 'K'])
      assert.ok(
        state.table.filter((item) => item.id.startsWith(rank)).length < 3,
      );
    assert.equal(state.table.length, 4);
    assert.deepEqual(new Set(allCards(state)), fullDeck);
  }
});

test('6.1 two equal courts or three unequal courts stay in the layout', () => {
  for (const layout of [
    ['KC', 'KD', '2H', '5C'],
    ['KC', 'QD', 'JH', '5C'],
  ])
    assert.deepEqual(tableIds(scripted(layout)), layout);
});

test('6.1 layout replacement leaves the dealt hands alone', () => {
  const starter = ['6C', '7C', '8C', '9C', '10C', 'AC'];
  const state = scripted(['KC', 'KD', 'KH', '5C'], starter);
  assert.deepEqual(state.hands[0], starter);
});

test('6.2 a numeral captures an equal-value loose card', () => {
  const state = sequence(scripted(LAYOUT, ['5D']), [capture('5D', '5C')]);
  assert.deepEqual(tableIds(state), ['2C', '3C', '4C']);
  assert.deepEqual(state.captured[0], ['5D', '5C']);
  assert.equal(state.lastCapturer, 0);
});

test('6.2 a numeral captures loose cards summing to its value', () => {
  const state = sequence(scripted(LAYOUT, ['7D']), [capture('7D', '2C', '5C')]);
  assert.deepEqual(tableIds(state), ['3C', '4C']);
});

test('6.2 worked arithmetic: 7 takes (2+5), (3+4) and the loose 7', () => {
  const state = sequence(scripted(LAYOUT, ['7D', '10C'], ['7H']), [
    lay('10C'),
    lay('7H'),
    capture('7D', '2C', '5C', '3C', '4C', '7H'),
  ]);
  assert.deepEqual(tableIds(state), ['10C']);
  assert.equal(state.captured[0].length, 6);
});

test('6.2 a card cannot belong to two captured combinations', () => {
  const state = scripted(['2C', '5C', '7H', '9S'], ['7D']);
  rejected(state, capture('7D', '2C', '5C', '5C'), 'ILLEGAL_MOVE');
  const three = scripted(['2C', '5C', '3H', '9S'], ['7D']);
  rejected(three, capture('7D', '2C', '5C', '3H'), 'ILLEGAL_MOVE');
});

test('6.2 captures must be complete sums', () => {
  const state = scripted(LAYOUT, ['9D', '6D', '7D']);
  rejected(state, capture('9D', '2C', '3C'), 'ILLEGAL_MOVE');
  rejected(state, capture('9D', '2C'), 'ILLEGAL_MOVE');
  rejected(state, capture('6D', '2C', '3C', '4C'), 'ILLEGAL_MOVE');
  rejected(state, capture('9D'), 'ILLEGAL_MOVE');
  rejected(state, capture('9D', '99'), 'ILLEGAL_MOVE');
  rejected(state, capture('7D', '2C', '5C', '99'), 'ILLEGAL_MOVE');
});

test('6.2 numeral captures are optional', () => {
  const state = sequence(scripted(LAYOUT, ['5D']), [lay('5D')]);
  assert.deepEqual(tableIds(state), [...LAYOUT, '5D']);
  assert.deepEqual(state.captured, [[], []]);
});

test('6.2 several combinations may be taken or only one of them', () => {
  const state = scripted(['2C', '5C', '3H', '4H'], ['7D']);
  const one = act(state, capture('7D', '2C', '5C'));
  assert.deepEqual(tableIds(one), ['3H', '4H']);
});

test('6.2 an Ace counts as one', () => {
  const state = sequence(scripted(['AC', '2C', '3C', '9H'], ['3D']), [
    capture('3D', 'AC', '2C'),
  ]);
  assert.deepEqual(tableIds(state), ['3C', '9H']);
  const ace = scripted(['AC', '2C', '3C', '9H'], ['AD']);
  rejected(ace, capture('AD', '2C'), 'ILLEGAL_MOVE');
  assert.deepEqual(tableIds(act(ace, capture('AD', 'AC'))).length, 3);
});

test('6.2 a court captures exactly one loose court of its rank', () => {
  const state = scripted(['KC', 'KD', 'QC', '5C'], ['KH', 'QD']);
  const taken = act(state, capture('KH', 'KD'));
  assert.deepEqual(tableIds(taken), ['KC', 'QC', '5C']);
  rejected(state, capture('KH', 'KC', 'KD'), 'ILLEGAL_MOVE');
  rejected(state, capture('KH', 'QC'), 'ILLEGAL_MOVE');
  rejected(state, capture('QD', 'KC'), 'ILLEGAL_MOVE');
});

test('6.2 a court must take its match and cannot be left beside it', () => {
  const state = scripted(['KC', '2C', '3C', '5C'], ['KH', 'QH']);
  rejected(state, lay('KH'), 'ILLEGAL_MOVE');
  assert.deepEqual(tableIds(act(state, lay('QH'))).at(-1), 'QH');
});

test('6.2 courts have no additive value and numerals cannot take them', () => {
  const state = scripted(['KC', 'QC', '2C', '5C'], ['10D']);
  rejected(state, capture('10D', 'KC'), 'ILLEGAL_MOVE');
  rejected(state, capture('10D', 'QC', '2C'), 'ILLEGAL_MOVE');
});

test('6.3 a plain declaration sums the played numeral and table cards', () => {
  const state = sequence(scripted(LAYOUT, ['3D', '8H']), [
    declare('3D', 8, '5C'),
  ]);
  assert.deepEqual(declarationOf(state), {
    id: 'declaration-1',
    cards: ['3D', '5C'],
    value: 8,
    owner: 0,
    group: false,
  });
  assert.deepEqual(tableIds(state), ['2C', '3C', '4C', 'declaration-1']);
  assert.equal(state.captured[0].length, 0);
  assert.equal(state.lastCapturer, null);
});

test('6.3 the declarer must keep a card of the declared value', () => {
  const state = scripted(LAYOUT, ['3D', '7H']);
  rejected(state, declare('3D', 8, '5C'), 'ILLEGAL_MOVE');
});

test('6.3 the played card does not count as the card kept', () => {
  const state = scripted(['2C', '6C', '4C', '5C'], ['8H']);
  rejected(state, declare('8H', 8, '2C', '6C'), 'ILLEGAL_MOVE');
});

test('6.3 a declaration totals at most ten', () => {
  const state = scripted(['6C', '7C', '3D', '9H'], ['5D', 'KH']);
  rejected(state, declare('5D', 11, '6C'), 'ILLEGAL_MOVE');
  rejected(state, declare('5D', 0, '6C'), 'ILLEGAL_MOVE');
});

test('6.3 the declared value must equal the sum', () => {
  const state = scripted(LAYOUT, ['3D', '9H']);
  rejected(state, declare('3D', 9, '5C'), 'ILLEGAL_MOVE');
});

test('6.3 court cards cannot be declared', () => {
  const state = scripted(['KC', '2C', '3C', '5C'], ['QD', '8H', '10H']);
  rejected(state, declare('QD', 8, '5C'), 'ILLEGAL_MOVE');
  rejected(state, declare('8H', 10, 'KC'), 'ILLEGAL_MOVE');
});

test('6.3 a declaration is one unit and cannot be taken piecemeal', () => {
  const state = sequence(scripted(LAYOUT, ['3D', '8H'], ['5D']), [
    declare('3D', 8, '5C'),
  ]);
  rejected(state, capture('5D', '5C'), 'ILLEGAL_MOVE');
});

test('6.3 any player can capture a declaration at its exact value', () => {
  const state = sequence(scripted(LAYOUT, ['3D', '8H'], ['8S']), [
    declare('3D', 8, '5C'),
    capture('8S', 'declaration-1'),
  ]);
  assert.deepEqual(tableIds(state), ['2C', '3C', '4C']);
  assert.deepEqual(state.captured[1], ['8S', '3D', '5C']);
});

test('6.3 a plain declaration is never part of a larger sum', () => {
  const state = sequence(
    scripted(['2C', '3C', '4C', '5C'], ['3D', '8H'], ['10S']),
    [declare('3D', 8, '5C')],
  );
  rejected(state, capture('10S', 'declaration-1', '2C'), 'ILLEGAL_MOVE');
});

test('6.2 a matching card may also collect equal-value sets', () => {
  const state = sequence(
    scripted(['2C', '6C', '4C', '5C'], ['3D', '8H'], ['8S']),
    [declare('3D', 8, '5C'), capture('8S', 'declaration-1', '2C', '6C')],
  );
  assert.deepEqual(tableIds(state), ['4C']);
  assert.equal(state.captured[1].length, 5);
});

test('6.3 an opponent may raise a plain declaration holding the new value', () => {
  const state = sequence(scripted(LAYOUT, ['3D', '8H'], ['AD', '9S']), [
    declare('3D', 8, '5C'),
    declare('AD', 9, 'declaration-1'),
  ]);
  assert.deepEqual(declarationOf(state), {
    id: 'declaration-2',
    cards: ['AD', '3D', '5C'],
    value: 9,
    owner: 1,
    group: false,
  });
});

test('6.3 raising needs the new capture card', () => {
  const state = sequence(scripted(LAYOUT, ['3D', '8H'], ['AD', '10S']), [
    declare('3D', 8, '5C'),
  ]);
  rejected(state, declare('AD', 9, 'declaration-1'), 'ILLEGAL_MOVE');
});

test('6.3 a raised owner is released and may raise again', () => {
  let state = sequence(
    scripted(LAYOUT, ['3D', '8H', 'AH', '10H'], ['AD', '9S']),
    [declare('3D', 8, '5C'), declare('AD', 9, 'declaration-1')],
  );
  state = act(state, declare('AH', 10, 'declaration-2'));
  assert.equal(declarationOf(state).owner, 0);
  assert.equal(declarationOf(state).value, 10);
});

test('6.3 you cannot raise your own plain declaration', () => {
  const state = sequence(scripted(LAYOUT, ['3D', '8H', 'AH', '9H'], ['KS']), [
    declare('3D', 8, '5C'),
    lay('KS'),
  ]);
  rejected(state, declare('AH', 9, 'declaration-1'), 'ILLEGAL_MOVE');
});

test('6.3 a group joins components of one value', () => {
  const state = sequence(
    scripted(['2C', '4C', '3H', '5C'], ['3D', '6H', '6S']),
    [declare('3D', 6, '2C', '4C', '3H')],
  );
  assert.deepEqual(declarationOf(state), {
    id: 'declaration-1',
    cards: ['3D', '2C', '4C', '3H'],
    value: 6,
    owner: 0,
    group: true,
  });
});

test('6.3 a loose card worth the value can join a group', () => {
  const state = sequence(scripted(['2C', '4C', '6H', '5C'], ['6D', '6S']), [
    declare('6D', 6, '2C', '4C', '6H'),
  ]);
  assert.equal(declarationOf(state).group, true);
  assert.equal(declarationOf(state).cards.length, 4);
});

test('6.3 you may extend your declaration into a group, not raise it', () => {
  const state = sequence(
    scripted(['2C', '4C', '9H', '10H'], ['2D', '4D', '6H', '6D'], ['KS']),
    [declare('2D', 6, '4C'), lay('KS')],
  );
  const extended = act(state, declare('6D', 6, 'declaration-1'));
  assert.deepEqual(declarationOf(extended), {
    id: 'declaration-3',
    cards: ['6D', '2D', '4C'],
    value: 6,
    owner: 0,
    group: true,
  });
  rejected(state, declare('4D', 10, 'declaration-1'), 'ILLEGAL_MOVE');
});

test('6.3 a group cannot be raised', () => {
  const state = sequence(
    scripted(['2C', '4C', '3H', '5C'], ['3D', '6H', '6S'], ['AD', '7S']),
    [declare('3D', 6, '2C', '4C', '3H')],
  );
  rejected(state, declare('AD', 7, 'declaration-1'), 'ILLEGAL_MOVE');
});

test('6.3 a self-raise cannot pose as a new group', () => {
  const state = sequence(
    scripted(['2C', '6C', '9C', '10C'], ['AD', '3D', '3H', '6H'], ['KS']),
    [declare('AD', 3, '2C'), lay('KS')],
  );
  rejected(state, declare('3H', 6, 'declaration-1', '6C'), 'ILLEGAL_MOVE');
});

test('6.3 a group cannot be absorbed into a higher group', () => {
  const state = sequence(
    scripted(['AC', '2C', '6C', '10C'], ['QD', '3H', '6H'], ['3D', '3S']),
    [lay('QD'), declare('3D', 3, 'AC', '2C')],
  );
  assert.equal(declarationOf(state).group, true);
  rejected(state, declare('3H', 6, 'declaration-2', '6C'), 'ILLEGAL_MOVE');
});

test('6.3 any extra equal-value component may join a group', () => {
  const state = sequence(
    scripted(['2C', '4C', '3H', '5C'], ['3D', '6H', '6S'], ['6C', '6D']),
    [declare('3D', 6, '2C', '4C', '3H'), declare('6C', 6, 'declaration-1')],
  );
  assert.equal(declarationOf(state).owner, 1);
  assert.equal(declarationOf(state).value, 6);
  assert.equal(declarationOf(state).cards.length, 5);
});

test('6.4 a declarer cannot leave a loose card', () => {
  const state = sequence(scripted(LAYOUT, ['3D', '8H', '10H'], ['KS']), [
    declare('3D', 8, '5C'),
    lay('KS'),
  ]);
  rejected(state, lay('10H'), 'ILLEGAL_MOVE');
});

test('6.4 a declarer cannot start a separate declaration', () => {
  const state = sequence(
    scripted(['2C', '3C', '4C', '5C'], ['3D', '8H', 'AH', '4H'], ['KS']),
    [declare('3D', 8, '5C'), lay('KS')],
  );
  rejected(state, declare('AH', 4, '3C'), 'ILLEGAL_MOVE');
});

test('6.4 a declarer may capture other cards while keeping a capture card', () => {
  const state = sequence(scripted(LAYOUT, ['3D', '8H', '2H'], ['KS']), [
    declare('3D', 8, '5C'),
    lay('KS'),
    capture('2H', '2C'),
  ]);
  assert.deepEqual(tableIds(state), ['3C', '4C', 'declaration-1', 'KS']);
});

test('6.4 the last capture card cannot be spent elsewhere', () => {
  const state = sequence(
    scripted(['2C', '6C', '4C', '5C'], ['3D', '8H'], ['KS']),
    [declare('3D', 8, '5C'), lay('KS')],
  );
  rejected(state, capture('8H', '2C', '6C'), 'ILLEGAL_MOVE');
  assert.deepEqual(tableIds(act(state, capture('8H', 'declaration-1'))), [
    '2C',
    '6C',
    '4C',
    'KS',
  ]);
});

test('6.4 a duplicate capture card may be used', () => {
  const state = sequence(
    scripted(['2C', '6C', '4C', '5C'], ['3D', '8H', '8D'], ['KS']),
    [declare('3D', 8, '5C'), lay('KS'), capture('8H', '2C', '6C')],
  );
  assert.deepEqual(tableIds(state), ['4C', 'declaration-1', 'KS']);
});

test('6.4 worked example: raise the rival 4 to 9 and group both nines', () => {
  const state = sequence(
    scripted(
      ['6C', '3C', '2H', '10C'],
      ['3D', '9H', '5H', '9D'],
      ['2D', '4S', 'KS'],
    ),
    [
      declare('3D', 9, '6C'),
      declare('2D', 4, '2H'),
      declare('5H', 9, 'declaration-1', 'declaration-2'),
    ],
  );
  assert.deepEqual(declarationOf(state), {
    id: 'declaration-3',
    cards: ['5H', '3D', '6C', '2D', '2H'],
    value: 9,
    owner: 0,
    group: true,
  });
  assert.equal(state.table.filter((item) => item.owner !== null).length, 1);
});

test('6.4 the owner always has a legal play', () => {
  const state = sequence(scripted(LAYOUT, ['3D', '8H'], ['KS']), [
    declare('3D', 8, '5C'),
    lay('KS'),
  ]);
  const { actions } = ok(engine.getLegalActions(state, 'alice'));
  assert.ok(actions.length > 0);
  assert.ok(actions.every((action) => action.type !== 'lay'));
});

test('6.5 the first play of a round never scores a xeri', () => {
  const state = sequence(scripted(['AC', '2C', '3C', '4C'], ['10D']), [
    capture('10D', 'AC', '2C', '3C', '4C'),
  ]);
  assert.deepEqual(state.table, []);
  assert.deepEqual(state.xeris, []);
  assert.equal(state.lastPlay.xeri, false);
});

test('6.5 a capture emptying the table is a 10-point xeri', () => {
  const state = sequence(scripted(['2C', '5C', '3C', '4C'], ['7D'], ['7H']), [
    capture('7D', '2C', '5C'),
    capture('7H', '3C', '4C'),
  ]);
  assert.deepEqual(state.table, []);
  assert.deepEqual(state.xeris, [{ seat: 1, card: '7H' }]);
  assert.equal(state.lastPlay.xeri, true);
});

test('6.5 a capture leaving anything on the table is no xeri', () => {
  const state = sequence(scripted(['2C', '5C', '3C', '4C'], ['7D'], ['3H']), [
    capture('7D', '2C', '5C'),
    capture('3H', '3C'),
  ]);
  assert.deepEqual(tableIds(state), ['4C']);
  assert.deepEqual(state.xeris, []);
});

test('6.5 taking a declaration can empty the table for a xeri', () => {
  const state = sequence(
    scripted(['2C', '5C', '3H', '4H'], ['7D', '8H'], ['AS', '8S']),
    [
      capture('7D', '2C', '5C'),
      declare('AS', 8, '3H', '4H'),
      capture('8H', 'declaration-2'),
    ],
  );
  assert.deepEqual(state.table, []);
  assert.deepEqual(state.xeris, [{ seat: 0, card: '8H' }]);
});

/**
 * A complete scripted round: the starter sweeps the layout on the first play, the
 * dealer takes two 4s with an 8, and then every remaining card pairs off, the
 * starter laying and the dealer capturing, down to the round's final card.
 */
function sweepingRound() {
  const layout = ['AC', 'AD', '3C', '3D'];
  const opening = [
    capture('8C', ...layout),
    lay('4C'),
    lay('4D'),
    capture('8S', '4C', '4D'),
  ];
  const paired = [
    ['AH', 'AS'],
    ['3H', '3S'],
    ['4H', '4S'],
    ['8D', '8H'],
    ...['2', '5', '6', '7', '9', '10', 'J', 'Q', 'K'].flatMap((rank) => [
      [`${rank}C`, `${rank}D`],
      [`${rank}H`, `${rank}S`],
    ]),
  ];
  const actions = [
    ...opening,
    ...paired.flatMap(([laid, taker]) => [lay(laid), capture(taker, laid)]),
  ];
  const order = actions.map((action) => action.card);
  const hand = (from, seat) =>
    order.slice(from, from + 12).filter((_, index) => index % 2 === seat);
  const rest = [12, 24, 36].flatMap((from) => [
    ...hand(from, 0),
    ...hand(from, 1),
  ]);
  const state = ok(
    engine.createAnalysisGame({
      players,
      seed: seed(),
      firstDealer: 1,
      decks: [deckFor(layout, hand(0, 0), hand(0, 1), rest)],
    }),
  );
  return { state, actions };
}

test('6.5 a legal final-card capture scores a xeri', () => {
  const { state, actions } = sweepingRound();
  assert.equal(actions.length, 48);
  const finished = sequence(state, actions);
  assert.equal(finished.lastPlay.xeri, true);
  assert.equal(finished.ply, 48);
  const [starter, dealer] = finished.rounds[0].results;
  assert.equal(finished.rounds[0].leftoverCards, 0);
  assert.equal(finished.rounds[0].lastCapturer, 1);
  assert.equal(starter.xeriPoints, 0);
  assert.equal(dealer.xeriPoints, 230);
  assert.equal(starter.cards + dealer.cards, 52);
  assert.equal(finished.matchOutcome.winnerId, 'bob');
});

test('6.5 a Jack has no sweeping power in Diloti', () => {
  const state = scripted(['2C', '3C', '4C', '5C'], ['JD']);
  rejected(state, capture('JD', '2C', '3C', '4C', '5C'), 'ILLEGAL_MOVE');
  const loose = act(state, lay('JD'));
  assert.deepEqual(tableIds(loose).at(-1), 'JD');
});

test('6.5 leftovers go to the last capturer and are not a xeri', () => {
  let collected = 0;
  for (let n = 0; n < 60; n++) {
    let state = start(n);
    while (state.ply < 47) state = advance(state);
    const marks = state.xeris.length;
    const capturer = state.lastCapturer;
    const result = engine.applyAction(
      state,
      players[state.turn],
      firstLegal(state),
    );
    const played = result.events.find((e) => e.type === 'card-played');
    const { outcome } = result.events.find((e) => e.type === 'round-ended');
    if (outcome.leftoverCards === 0) continue;
    collected++;
    assert.equal(
      outcome.lastCapturer,
      played.capturedCount ? played.seat : capturer,
    );
    const points =
      outcome.results[0].xeriPoints + outcome.results[1].xeriPoints;
    assert.equal(points, (marks + (played.xeri ? 1 : 0)) * 10);
  }
  assert.ok(collected > 0, 'expected rounds ending with table cards');
});

test('6.5 every complete round adds up to the rulebook totals', () => {
  let majorities = 0;
  for (let n = 0; n < 100; n++) {
    const state = finishRound(start(n));
    const [a, b] = state.rounds[0].results;
    assert.equal(a.cards + b.cards, 52);
    assert.equal(
      a.aces +
        b.aces +
        a.tenOfDiamonds +
        b.tenOfDiamonds +
        a.twoOfClubs +
        b.twoOfClubs,
      7,
    );
    if (a.cards === b.cards) {
      assert.deepEqual([a.majority, b.majority], [0, 0]);
    } else {
      majorities++;
      assert.equal(a.majority + b.majority, 4);
      assert.equal((a.cards > b.cards ? a : b).majority, 4);
    }
    assert.equal(
      a.total + b.total,
      (a.cards === b.cards ? 7 : 11) + a.xeriPoints + b.xeriPoints,
    );
  }
  assert.ok(majorities > 0);
});

test('6.5 a 26-26 split awards no majority', () => {
  let ties = 0;
  for (let n = 0; n < 120 && !ties; n++) {
    let state = start(n);
    let randomState = n;
    while (state.roundNumber === 1) {
      const view = ok(engine.getObservation(state, players[state.turn]));
      const decision = ok(
        engine.chooseBotAction(view, { strategy: 'random', randomState }),
      );
      randomState = decision.nextRandomState;
      state = act(state, decision.action);
    }
    const [a, b] = state.rounds[0].results;
    if (a.cards !== b.cards) continue;
    ties++;
    assert.deepEqual([a.majority, b.majority], [0, 0]);
    assert.equal(a.total + b.total, 7 + a.xeriPoints + b.xeriPoints);
  }
  assert.ok(ties > 0, 'expected a 26-26 round');
});

test('6.5 scored piles match an independent card count', () => {
  for (let n = 0; n < 30; n++) {
    let state = start(n);
    while (state.phase !== 'ended') state = finishRound(state);
    const last = state.rounds.at(-1);
    for (const seat of [0, 1]) {
      const result = last.results[seat];
      assert.equal(result.cards, state.captured[seat].length);
      assert.equal(
        result.total,
        expectedCardPoints(state.captured[seat]) +
          result.majority +
          state.xeris.filter((mark) => mark.seat === seat).length * 10,
      );
    }
  }
});

test('6.1 dealers alternate after a complete round', () => {
  let state = start(3);
  const first = state.dealer;
  state = nextRound(finishRound(state));
  assert.equal(state.roundNumber, 2);
  assert.equal(state.dealer, first === 0 ? 1 : 0);
  assert.equal(state.turn, first);
  assert.equal(state.ply, 48);
  assert.equal(state.roundPly, 0);
  assert.equal(state.batch, 1);
  assert.deepEqual(state.captured, [[], []]);
  assert.deepEqual(state.xeris, []);
  assert.equal(state.lastCapturer, null);
  assert.deepEqual(new Set(allCards(state)), fullDeck);
});

test('6.5 scores accumulate between rounds', () => {
  let state = finishRound(start(4));
  const first = state.rounds[0];
  state = finishRound(state);
  const second = state.rounds[1];
  assert.deepEqual(second.scores, [
    first.scores[0] + second.results[0].total,
    first.scores[1] + second.results[1].total,
  ]);
  assert.deepEqual(state.scores, second.scores);
});

/** One seeded first round, re-run from chosen opening scores. */
function withOpening(makeScores) {
  const options = { players, seed: seed(5), firstDealer: 0, decks: [] };
  const base = ok(engine.createAnalysisGame(options));
  const totals = finishRound(base).rounds[0].results.map((r) => r.total);
  return finishRound(
    ok(engine.createAnalysisGame({ ...options, scores: makeScores(totals) })),
  );
}

test('6.5 one player reaching 61 wins the match', () => {
  const state = withOpening(([a]) => [61 - a, 0]);
  assert.equal(state.phase, 'ended');
  assert.equal(state.matchOutcome.winner, 0);
  assert.equal(state.matchOutcome.winnerId, 'alice');
  assert.equal(state.matchOutcome.reason, 'target-reached');
  assert.equal(state.matchOutcome.scores[0].points, 61);
});

test('6.5 60 does not end the match', () => {
  const state = withOpening(([a, b]) => [60 - a, 60 - b]);
  assert.equal(state.phase, 'round-end');
  assert.equal(state.roundNumber, 1);
});

test('6.5 both over the target, the higher total wins', () => {
  const state = withOpening(([a, b]) => [70 - a, 65 - b]);
  assert.equal(state.phase, 'ended');
  assert.equal(state.matchOutcome.winner, 0);
  assert.deepEqual(state.scores, [70, 65]);
});

test('6.5 an exact tie at the target plays another round', () => {
  const state = withOpening(([a, b]) => [70 - a, 70 - b]);
  assert.equal(state.phase, 'round-end');
  assert.deepEqual(state.scores, [70, 70]);
  assert.equal(state.matchOutcome, null);
});

test('a finished match keeps all 52 cards and refuses further play', () => {
  const state = withOpening(([a]) => [61 - a, 0]);
  assert.deepEqual(new Set(allCards(state)), fullDeck);
  assert.equal(state.table.length, 0);
  rejected(state, lay('2C'), 'GAME_ENDED', 'alice');
});

test('rejects play out of turn, unknown cards and strangers', () => {
  const state = scripted(LAYOUT, ['6C']);
  rejected(state, lay('6C'), 'NOT_YOUR_TURN', 'bob');
  rejected(state, lay('6C'), 'UNKNOWN_PLAYER', 'mallory');
  rejected(state, lay('2C'), 'ILLEGAL_MOVE');
  rejected(state, lay('ZZ'), 'INVALID_ACTION');
  rejected(state, { type: 'lay' }, 'INVALID_ACTION');
  rejected(state, { type: 'resign', card: '6C' }, 'INVALID_ACTION');
  rejected(state, { ...lay('6C'), extra: true }, 'INVALID_ACTION');
  rejected(state, { ...capture('6C', '2C'), value: 2 }, 'INVALID_ACTION');
  rejected(state, { type: 'capture', card: '6C' }, 'INVALID_ACTION');
  rejected(state, { type: 'declare', card: '6C', table: [] }, 'INVALID_ACTION');
  rejected(state, null, 'INVALID_ACTION');
});

test('rejects a stale revision and leaves the state untouched', () => {
  const state = scripted(LAYOUT, ['6C']);
  const result = engine.applyAction(state, 'alice', lay('6C'), 7);
  assert.equal(result.error.code, 'STALE_REVISION');
  assert.equal(state.revision, 0);
  assert.equal(state.hands[0].length, 6);
});

test('a court can be laid again once its match is gone', () => {
  const state = sequence(
    scripted(['KC', '2C', '3C', '5C'], ['KH', 'KD'], ['9S']),
    [capture('KH', 'KC'), lay('9S')],
  );
  assert.deepEqual(tableIds(act(state, lay('KD'))).at(-1), 'KD');
});
