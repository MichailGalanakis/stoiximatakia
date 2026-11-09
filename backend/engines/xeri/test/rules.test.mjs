import test from 'node:test';
import {
  act,
  allCards,
  assert,
  deckFor,
  engine,
  expectedCardPoints,
  finishRound,
  nextRound,
  ok,
  players,
  rejected,
  scripted,
  seed,
  sequence,
  start,
  step,
} from './helpers.mjs';

const fullDeck = new Set(engine.DECK);
const pile = (...cards) => cards;

test('7.1 deals six cards each, four to the pile and leaves 36 in stock', () => {
  const state = start();
  assert.deepEqual(
    state.hands.map((hand) => hand.length),
    [6, 6],
  );
  assert.equal(state.table.length, 4);
  assert.equal(state.stock.length, 36);
  assert.deepEqual(new Set(allCards(state)), fullDeck);
});

test('7.1 the non-dealer starts and leads every batch of the round', () => {
  let state = start(1);
  const starter = state.dealer === 0 ? 1 : 0;
  assert.equal(state.turn, starter);
  const batches = [];
  for (let batch = 1; batch <= 3; batch++) {
    for (let i = 0; i < 12; i++) state = act(state, state.hands[state.turn][0]);
    batches.push([state.batch, state.turn, state.stock.length]);
  }
  assert.deepEqual(batches, [
    [2, starter, 24],
    [3, starter, 12],
    [4, starter, 0],
  ]);
});

test('7.1 a batch keeps the existing pile and adds no new layout', () => {
  const table = pile('2C', '3C', '4C', '5C');
  const moves = ['6C', '7C', '8C', '9C', '10C', 'QC'];
  moves.push('6D', '7D', '8D', '9D', '10D', 'QD');
  const state = sequence(scripted(table, moves), moves);
  assert.equal(state.batch, 2);
  assert.deepEqual(state.table.slice(0, 4), table);
  assert.equal(state.table.length, 16);
});

test('7.1 a Jack on top of the layout is replaced', () => {
  const state = scripted(pile('2C', '3C', '4C', 'JC'));
  assert.notEqual(state.table.at(-1).slice(0, -1), 'J');
  assert.deepEqual(new Set(allCards(state)), fullDeck);
  assert.equal(state.table.length, 4);
  assert.equal(state.stock.length, 36);
});

test('7.1 equal top two layout cards are replaced', () => {
  const state = scripted(pile('2C', '3C', '4C', '4D'));
  const [top, below] = [state.table.at(-1), state.table.at(-2)];
  assert.notEqual(top.slice(0, -1), below.slice(0, -1));
  assert.deepEqual(new Set(allCards(state)), fullDeck);
});

test('7.1 layout replacement leaves the dealt hands alone', () => {
  const blocked = deckFor(pile('2C', '3C', '4C', 'JC'), ['9H', '9S', '8H']);
  const state = ok(
    engine.createAnalysisGame({
      players,
      seed: seed(),
      firstDealer: 1,
      decks: [blocked],
    }),
  );
  assert.deepEqual(state.hands[0], blocked.slice(0, 6));
  assert.deepEqual(state.hands[1], blocked.slice(6, 12));
});

test('7.1 a covered Jack or covered pair stays in the layout', () => {
  const table = pile('JC', '3C', '3D', '5H');
  assert.deepEqual(scripted(table).table, table);
});

test('7.2 a card matching the top rank captures the whole pile', () => {
  const state = sequence(scripted(pile('2C', '3C', '4C', '5C'), ['5D']), [
    '5D',
  ]);
  assert.deepEqual(state.table, []);
  assert.deepEqual(state.captured[0], ['2C', '3C', '4C', '5C', '5D']);
  assert.equal(state.lastCapturer, 0);
});

test('7.2 suit does not matter and a covered rank cannot be matched', () => {
  const table = pile('2C', '3C', '4C', '5C');
  const state = sequence(scripted(table, ['4D']), ['4D']);
  assert.deepEqual(state.table, [...table, '4D']);
  assert.deepEqual(state.captured, [[], []]);
  assert.equal(state.lastCapturer, null);
});

test('7.2 a Jack captures a nonempty pile of any top rank', () => {
  const state = sequence(scripted(pile('2C', '3C', '4C', '5C'), ['JD']), [
    'JD',
  ]);
  assert.deepEqual(state.table, []);
  assert.equal(state.captured[0].length, 5);
});

test('7.2 any card on an empty table, Jack included, starts a new pile', () => {
  const moves = ['JD', 'JH'];
  let state = sequence(scripted(pile('2C', '3C', '4C', '5C'), moves), ['JD']);
  assert.deepEqual(state.table, []);
  state = act(state, 'JH');
  assert.deepEqual(state.table, ['JH']);
  assert.equal(state.lastCapturer, 0);
});

test('7.3 a lone card captured by its rank is a 10-point xeri', () => {
  const moves = ['JD', '7H', '7S'];
  const state = sequence(scripted(pile('2C', '3C', '4C', '5C'), moves), moves);
  assert.deepEqual(state.xeris, [
    { seat: 0, card: '7S', kind: 'ordinary', points: 10 },
  ]);
  assert.deepEqual(state.lastPlay, {
    seat: 0,
    card: '7S',
    capturedCount: 2,
    xeri: 'ordinary',
  });
});

test('7.3 Jack on a lone Jack scores 20 in place of 10', () => {
  const moves = ['JD', 'JH', 'JS'];
  const state = sequence(scripted(pile('2C', '3C', '4C', '5C'), moves), [
    'JD',
    'JH',
  ]);
  const after = scripted(pile('2C', '3C', '4C', '5C'), moves);
  assert.equal(state.table.length, 1);
  assert.deepEqual(sequence(after, moves).xeris, [
    { seat: 0, card: 'JS', kind: 'jack', points: 20 },
  ]);
});

test('7.3 a Jack taking a lone other card is an ordinary capture', () => {
  const moves = ['JD', '7H', 'JS'];
  const state = sequence(scripted(pile('2C', '3C', '4C', '5C'), moves), moves);
  assert.deepEqual(state.xeris, []);
  assert.deepEqual(state.table, []);
  assert.equal(state.lastPlay.xeri, null);
});

test('7.3 emptying a pile of two or more cards is never a xeri', () => {
  const moves = ['JD', '7H', '8H', '8S'];
  const state = sequence(scripted(pile('2C', '3C', '4C', '5C'), moves), moves);
  assert.deepEqual(state.table, []);
  assert.deepEqual(state.xeris, []);
});

test('7.3 a pile whose bottom card shares the rank is still no xeri', () => {
  const moves = ['JD', '3H', '5D', '3D', '3S'];
  const state = sequence(scripted(pile('2C', '3C', '4C', '5C'), moves), moves);
  assert.deepEqual(state.table, []);
  assert.equal(state.lastPlay.capturedCount, 4);
  assert.deepEqual(state.xeris, []);
});

test('7.5 a final-card xeri counts when the matching conditions hold', () => {
  const tail = ['JD', '2H', '2S'];
  const rest = engine.DECK.filter(
    (card) => !['2C', '3C', '4C', '5C', ...tail].includes(card),
  ).slice(0, 45);
  const moves = [...rest, ...tail];
  const state = finishPlay(scripted(pile('2C', '3C', '4C', '5C'), moves));
  const outcome = state.rounds[0];
  assert.equal(outcome.leftoverCards, 0);
  assert.equal(outcome.lastCapturer, 1);
  assert.ok(outcome.results[1].xeriPoints >= 10);
});

test('7.2 leftovers go to the last capturer and are not a xeri', () => {
  const tail = ['3D', 'JD', '2S'];
  const rest = engine.DECK.filter(
    (card) => !['2C', '3C', '4C', '5C', ...tail].includes(card),
  ).slice(0, 45);
  const moves = [...rest, ...tail];
  const state = finishPlay(scripted(pile('2C', '3C', '4C', '5C'), moves));
  const outcome = state.rounds[0];
  assert.equal(outcome.leftoverCards, 1);
  assert.equal(outcome.lastCapturer, 0);
  const marks = state.history.length;
  assert.equal(marks, 48);
  assert.equal(outcome.results[0].cards + outcome.results[1].cards, 52);
});

function finishPlay(state) {
  const moves = [];
  for (const deck of [state.initial.decks[0]]) {
    const hands = (from, to) => deck.slice(from, to);
    const stock = deck.slice(16);
    moves.push([hands(0, 6), hands(6, 12)]);
    for (let i = 0; i < 36; i += 12)
      moves.push([stock.slice(i, i + 6), stock.slice(i + 6, i + 12)]);
  }
  for (const [starter, dealer] of moves)
    for (let i = 0; i < 6; i++) {
      state = act(state, starter[i]);
      state = act(state, dealer[i]);
    }
  return state;
}

test('7.4 the arithmetic check: 10D taken by 10H is worth 13 points', () => {
  const moves = ['JD', '10D', '10H'];
  const state = sequence(scripted(pile('2C', '3C', '4C', '5C'), moves), moves);
  assert.deepEqual(state.xeris[0], {
    seat: 0,
    card: '10H',
    kind: 'ordinary',
    points: 10,
  });
  const taken = state.captured[0].slice(-2);
  assert.deepEqual(taken, ['10D', '10H']);
  assert.equal(expectedCardPoints(taken) + state.xeris[0].points, 13);
});

test('7.4 every complete round adds up to the rulebook totals', () => {
  let ties = 0,
    majorities = 0;
  for (let n = 0; n < 200; n++) {
    let state = start(n);
    state = finishRound(state);
    const round = state.rounds[0];
    const [a, b] = round.results;
    assert.equal(a.cards + b.cards, 52);
    assert.equal(
      a.cardPoints +
        b.cardPoints +
        a.tenOfDiamonds +
        b.tenOfDiamonds +
        a.twoOfClubs +
        b.twoOfClubs,
      22,
    );
    if (a.cards === b.cards) {
      ties++;
      assert.deepEqual([a.majority, b.majority], [0, 0]);
    } else {
      majorities++;
      assert.equal(a.majority + b.majority, 3);
      assert.equal((a.cards > b.cards ? a : b).majority, 3);
    }
    assert.equal(
      a.total + b.total,
      (a.cards === b.cards ? 22 : 25) + a.xeriPoints + b.xeriPoints,
    );
  }
  assert.ok(ties > 0, 'expected at least one 26-26 round');
  assert.ok(majorities > 0);
});

test('7.4 scored piles match an independent card count', () => {
  const finalRound = [];
  for (let n = 0; n < 60; n++) {
    let state = start(n);
    while (state.phase !== 'ended') {
      const before = state;
      state = finishRoundOnce(state, (piles) => {
        finalRound.push([before.roundNumber, piles]);
      });
    }
    const last = state.rounds.at(-1);
    for (const seat of [0, 1]) {
      const result = last.results[seat];
      assert.equal(result.cards, state.captured[seat].length);
      assert.equal(
        result.total,
        expectedCardPoints(state.captured[seat]) +
          result.majority +
          state.xeris
            .filter((mark) => mark.seat === seat)
            .reduce((sum, mark) => sum + mark.points, 0),
      );
    }
  }
  assert.ok(finalRound.length >= 60);
});

function finishRoundOnce(state, observe) {
  const next = finishRound(state);
  observe(next.captured);
  return next;
}

test('in-game rules: dealers alternate after a complete round', () => {
  let state = start(3);
  const first = state.dealer;
  state = nextRound(finishRound(state));
  assert.equal(state.roundNumber, 2);
  assert.equal(state.dealer, first === 0 ? 1 : 0);
  assert.equal(state.turn, first);
  assert.equal(state.ply, 48);
  assert.equal(state.batch, 1);
  assert.deepEqual(state.captured, [[], []]);
  assert.deepEqual(state.xeris, []);
  assert.equal(state.lastCapturer, null);
  assert.deepEqual(new Set(allCards(state)), fullDeck);
});

test('in-game rules: scores accumulate between rounds', () => {
  let state = start(4);
  state = finishRound(state);
  const first = state.rounds[0];
  state = finishRound(state);
  const second = state.rounds[1];
  assert.deepEqual(second.scores, [
    first.scores[0] + second.results[0].total,
    first.scores[1] + second.results[1].total,
  ]);
  assert.deepEqual(state.scores, second.scores);
});

/** One scripted first round, re-run from chosen opening scores. */
function withOpening(makeScores) {
  const deck = start(5);
  const base = ok(
    engine.createAnalysisGame({
      players,
      seed: seed(5),
      firstDealer: deck.initial.firstDealer,
      decks: [],
    }),
  );
  const totals = finishRound(base).rounds[0].results.map((r) => r.total);
  return finishRound(
    ok(
      engine.createAnalysisGame({
        players,
        seed: seed(5),
        firstDealer: deck.initial.firstDealer,
        decks: [],
        scores: makeScores(totals),
      }),
    ),
  );
}

test('in-game rules: one player reaching 151 wins the match', () => {
  const state = withOpening(([a, b]) => [151 - a, 100]);
  assert.equal(state.phase, 'ended');
  assert.equal(state.matchOutcome.winner, 0);
  assert.equal(state.matchOutcome.winnerId, 'alice');
  assert.equal(state.matchOutcome.reason, 'target-reached');
  assert.equal(state.matchOutcome.roundNumber, 1);
  assert.equal(state.matchOutcome.scores[0].points, 151);
});

test('in-game rules: 150 does not end the match', () => {
  const state = withOpening(([a, b]) => [150 - a, 150 - b]);
  assert.equal(state.phase, 'round-end');
  assert.equal(state.roundNumber, 1);
});

test('in-game rules: both over the target, the higher total wins', () => {
  const state = withOpening(([a, b]) => [160 - a, 155 - b]);
  assert.equal(state.phase, 'ended');
  assert.equal(state.matchOutcome.winner, 0);
  assert.deepEqual(state.scores, [160, 155]);
});

test('in-game rules: an exact tie at the target plays another round', () => {
  const state = withOpening(([a, b]) => [160 - a, 160 - b]);
  assert.equal(state.phase, 'round-end');
  assert.equal(state.roundNumber, 1);
  assert.deepEqual(state.scores, [160, 160]);
  assert.equal(state.matchOutcome, null);
});

test('a finished match keeps all 52 cards and refuses further play', () => {
  const state = withOpening(([a]) => [151 - a, 0]);
  assert.deepEqual(new Set(allCards(state)), fullDeck);
  assert.equal(state.table.length, 0);
  rejected(state, { type: 'play-card', card: '2C' }, 'GAME_ENDED', 'alice');
});

test('rejects play out of turn, unknown cards and strangers', () => {
  const state = scripted(pile('2C', '3C', '4C', '5C'), ['6C']);
  const card = { type: 'play-card', card: '6C' };
  rejected(state, card, 'NOT_YOUR_TURN', 'bob');
  rejected(state, card, 'UNKNOWN_PLAYER', 'mallory');
  rejected(state, { type: 'play-card', card: '2C' }, 'ILLEGAL_MOVE');
  rejected(state, { type: 'play-card', card: 'ZZ' }, 'INVALID_ACTION');
  rejected(state, { type: 'play-card' }, 'INVALID_ACTION');
  rejected(state, { type: 'resign' }, 'INVALID_ACTION');
  rejected(state, { ...card, extra: true }, 'INVALID_ACTION');
  rejected(state, null, 'INVALID_ACTION');
});

test('rejects a stale revision and leaves the state untouched', () => {
  const state = scripted(pile('2C', '3C', '4C', '5C'), ['6C']);
  const card = { type: 'play-card', card: '6C' };
  rejected(state, card, 'STALE_REVISION', 'alice', 7);
  assert.equal(state.revision, 0);
  assert.equal(state.hands[0].length, 6);
});

test('card-played events report the play and carry no private cards', () => {
  const moves = ['JD'];
  const state = scripted(pile('2C', '3C', '4C', '5C'), moves);
  const { events } = step(state, 'JD');
  assert.deepEqual(events, [
    {
      type: 'card-played',
      playerId: 'alice',
      seat: 0,
      card: 'JD',
      capturedCount: 5,
      xeri: null,
      ply: 1,
    },
  ]);
});
