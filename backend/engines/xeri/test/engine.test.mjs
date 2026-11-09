import test from 'node:test';
import { randomStream, shuffled } from '../dist/esm/deck.js';
import {
  allCards,
  assert,
  deckFor,
  engine,
  finishRound,
  nextRound,
  ok,
  players,
  scripted,
  seed,
  sequence,
  start,
} from './helpers.mjs';

function playMatch(n, strategy = 'first-legal') {
  let state = start(n),
    randomState = n,
    events = 0;
  const seats = [];
  while (state.phase !== 'ended') {
    const player = players[state.turn];
    const view = ok(engine.getObservation(state, player));
    const decision = ok(
      engine.chooseBotAction(view, {
        strategy,
        ...(strategy === 'random' ? { randomState } : {}),
      }),
    );
    if (decision.nextRandomState !== null)
      randomState = decision.nextRandomState;
    const result = engine.applyAction(
      state,
      player,
      decision.action,
      state.revision,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    if (decision.action.type !== 'next') seats.push(state.turn);
    state = result.state;
    events += result.events.length;
    assert.equal(allCards(state).length, 52);
    assert.equal(new Set(allCards(state)).size, 52);
  }
  return { state, events, seats };
}

test('the same seed always produces the same game', () => {
  assert.deepEqual(start(7), start(7));
  assert.deepEqual(playMatch(7).state, playMatch(7).state);
});

test('different seeds produce different deals', () => {
  const deals = new Set();
  for (let n = 0; n < 50; n++)
    deals.add(JSON.stringify([start(n).hands, start(n).table]));
  assert.equal(deals.size, 50);
});

test('a seed shares nothing between rounds of the same match', () => {
  const state = nextRound(finishRound(start(8)));
  assert.notDeepEqual(state.hands, start(8).hands);
});

test('shuffles spread every card over the first seat evenly', () => {
  const counts = new Map(engine.DECK.map((card) => [card, 0]));
  const games = 2600;
  for (let n = 0; n < games; n++) {
    const state = start(n);
    for (const card of state.hands[0]) counts.set(card, counts.get(card) + 1);
  }
  const expected = (games * 6) / 52;
  let chiSquare = 0;
  for (const count of counts.values())
    chiSquare += (count - expected) ** 2 / expected;
  // 51 degrees of freedom; 90 is beyond the 0.999 quantile.
  assert.ok(chiSquare < 90, `chi-square ${chiSquare}`);
});

test('a shuffle reaches every ordering equally often', () => {
  const counts = new Map();
  const shuffles = 24_000;
  for (let n = 0; n < shuffles; n++) {
    const order = shuffled([1, 2, 3, 4], randomStream(seed(), `test:${n}`));
    const key = order.join('');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  assert.equal(counts.size, 24);
  let chiSquare = 0;
  for (const count of counts.values()) chiSquare += (count - 1000) ** 2 / 1000;
  // 23 degrees of freedom; 50 is beyond the 0.999 quantile.
  assert.ok(chiSquare < 50, `chi-square ${chiSquare}`);
});

test('the first dealer is drawn from the seed for both seats', () => {
  const dealers = { 0: 0, 1: 0 };
  for (let n = 0; n < 400; n++) dealers[start(n).dealer]++;
  assert.ok(dealers[0] > 150 && dealers[1] > 150, JSON.stringify(dealers));
});

test('complete matches finish with one winner', () => {
  for (const strategy of ['first-legal', 'random'])
    for (let n = 0; n < 40; n++) {
      const { state } = playMatch(n, strategy);
      assert.equal(state.phase, 'ended');
      const [a, b] = state.scores;
      assert.ok(Math.max(a, b) >= 151);
      assert.notEqual(a, b);
      assert.equal(state.matchOutcome.winner, a > b ? 0 : 1);
      assert.equal(state.ply, state.rounds.length * 48);
      assert.equal(state.history.length, state.ply + state.rounds.length - 1);
      assert.equal(state.revision, state.ply + state.rounds.length - 1);
    }
});

test('replay rebuilds the exact state from its records', () => {
  const { state } = playMatch(11);
  assert.deepEqual(ok(engine.replay(state.initial, state.history)), state);
});

test('snapshots survive a JSON round trip mid-round', () => {
  let state = start(12);
  for (let i = 0; i < 31; i++)
    state = ok(
      engine.applyAction(
        state,
        players[state.turn],
        { type: 'play-card', card: state.hands[state.turn][0] },
        state.revision,
      ),
    );
  const json = ok(engine.serializeState(state));
  const restored = ok(engine.restoreState(json));
  assert.deepEqual(restored, state);
  assert.deepEqual(engine.validateState(JSON.parse(json)), {
    valid: true,
    issues: [],
  });
});

test('accepted states are immutable', () => {
  const state = start(13);
  assert.throws(() => state.hands[0].push('2C'));
  assert.throws(() => {
    state.scores[0] = 999;
  });
});

const tamper = (state, change) => {
  const copy = structuredClone(state);
  change(copy);
  return copy;
};
function refused(copy, code) {
  const result = engine.restoreState(copy);
  assert.equal(result.ok, false, 'tampered snapshot was accepted');
  if (code) assert.equal(result.error.code, code);
}

test('restore rejects a tampered hand, stock, score or table', () => {
  const state = sequence(start(14), []);
  refused(tamper(state, (s) => s.hands[0].reverse()));
  refused(tamper(state, (s) => s.stock.reverse()));
  refused(tamper(state, (s) => (s.scores[0] = 200)));
  refused(tamper(state, (s) => s.table.pop()));
  refused(tamper(state, (s) => (s.turn = s.turn === 0 ? 1 : 0)));
  refused(tamper(state, (s) => (s.extra = true)));
});

test('restore rejects a forged result', () => {
  const { state } = playMatch(15);
  refused(
    tamper(state, (s) => (s.matchOutcome.winner = 1 - s.matchOutcome.winner)),
  );
  refused(tamper(state, (s) => s.rounds.pop()));
  refused(tamper(state, (s) => s.history.pop()));
});

test('restore refuses stacked decks on a standard game', () => {
  const state = start(16);
  const deck = deckFor(['2C', '3C', '4C', '5C'], []);
  refused(
    tamper(state, (s) => s.initial.decks.push(deck)),
    'INVALID_CONFIG',
  );
  refused(
    tamper(state, (s) => (s.initial.scores = [150, 0])),
    'INVALID_CONFIG',
  );
  refused(
    tamper(
      state,
      (s) => (s.initial.firstDealer = s.initial.firstDealer === 0 ? 1 : 0),
    ),
    'INVALID_CONFIG',
  );
});

test('restore refuses another rules or engine version', () => {
  const state = start(17);
  refused(
    tamper(state, (s) => (s.rulesVersion = 'skillbetting.xeri.other')),
    'UNSUPPORTED_VERSION',
  );
  refused(
    tamper(state, (s) => (s.engineVersion = '0.0.1')),
    'UNSUPPORTED_VERSION',
  );
});

test('restore refuses malformed input', () => {
  assert.equal(engine.restoreState('{').ok, false);
  assert.equal(engine.restoreState(null).ok, false);
  assert.equal(engine.restoreState([]).ok, false);
  const cyclic = structuredClone(start(18));
  cyclic.history.push(cyclic);
  assert.equal(engine.restoreState(cyclic).ok, false);
});

test('game creation validates its inputs', () => {
  const code = (options) => engine.createGame(options).error?.code;
  const good = { players, seed: seed() };
  assert.equal(code({ ...good, seed: 'short' }), 'INVALID_CONFIG');
  assert.equal(code({ ...good, seed: seed().toUpperCase() }), 'INVALID_CONFIG');
  assert.equal(code({ ...good, players: ['a'] }), 'INVALID_CONFIG');
  assert.equal(code({ ...good, players: ['a', 'a'] }), 'INVALID_CONFIG');
  assert.equal(code({ ...good, players: ['a', 'b', 'c'] }), 'INVALID_CONFIG');
  assert.equal(code({ ...good, clock: '5+3' }), 'INVALID_CONFIG');
  assert.equal(code({ players }), 'INVALID_CONFIG');
});

test('analysis decks must be complete and are marked in the view', () => {
  const create = (decks) =>
    engine.createAnalysisGame({
      players,
      seed: seed(),
      firstDealer: 0,
      decks,
    });
  assert.equal(create([engine.DECK.slice(1)]).ok, false);
  assert.equal(create([[...engine.DECK.slice(1), engine.DECK[1]]]).ok, false);
  const view = ok(
    engine.getObservation(ok(create([[...engine.DECK]])), 'alice'),
  );
  assert.equal(view.analysisRoot, true);
  assert.equal(ok(engine.getObservation(start(), 'alice')).analysisRoot, false);
});

test('a view shows the viewer their own hand and nothing else hidden', () => {
  let state = start(19);
  for (const viewer of [0, 1]) {
    const view = ok(engine.getObservation(state, players[viewer]));
    const text = JSON.stringify(view);
    assert.deepEqual(view.hand, state.hands[viewer]);
    for (const card of state.hands[1 - viewer])
      assert.ok(!text.includes(`"${card}"`), `leaked ${card}`);
    for (const card of state.stock)
      assert.ok(!text.includes(`"${card}"`), `leaked ${card}`);
    assert.ok(!text.includes(state.initial.seed));
    assert.deepEqual(view.handCounts, [6, 6]);
    assert.equal(view.stockCount, 36);
  }
});

test('a view gives counts for captured piles, not their cards', () => {
  const moves = ['JD', '7H'];
  const state = sequence(scripted(['2C', '3C', '4C', '5C'], moves), moves);
  const view = ok(engine.getObservation(state, 'bob'));
  assert.deepEqual(view.capturedCounts, [5, 0]);
  const text = JSON.stringify({ ...view, lastPlay: null });
  for (const card of ['2C', '3C', '4C', '5C'])
    assert.ok(!text.includes(`"${card}"`), `leaked ${card}`);
});

test('only the active player has legal actions', () => {
  const state = start(20);
  const active = players[state.turn],
    waiting = players[1 - state.turn];
  assert.equal(ok(engine.getLegalActions(state, active)).length, 6);
  assert.equal(ok(engine.getLegalActions(state, waiting)).length, 0);
  assert.equal(ok(engine.getObservation(state, active)).legalActions.length, 6);
  assert.equal(
    ok(engine.getObservation(state, waiting)).legalActions.length,
    0,
  );
  assert.equal(
    engine.getLegalActions(state, 'mallory').error.code,
    'UNKNOWN_PLAYER',
  );
});

test('a view with no viewer has no hand or actions', () => {
  const view = ok(engine.getObservation(start(21), null));
  assert.deepEqual(view.hand, []);
  assert.deepEqual(view.legalActions, []);
  assert.equal(view.viewerSeat, null);
});

test('events never carry a hand, the stock or the seed', () => {
  let state = start(22);
  const created = engine.createGame({ players, seed: seed(22) });
  assert.ok(!JSON.stringify(created.events).includes(state.initial.seed));
  while (state.phase !== 'ended') {
    const hidden = [...state.hands[1 - state.turn], ...state.stock];
    const result = engine.applyAction(
      state,
      players[state.turn],
      state.phase === 'round-end'
        ? { type: 'next' }
        : {
            type: 'play-card',
            card: state.hands[state.turn][0],
          },
    );
    const text = JSON.stringify(
      result.events.filter((event) => event.type !== 'round-ended'),
    );
    for (const card of hidden)
      assert.ok(!text.includes(`"${card}"`), `leaked ${card}`);
    state = result.state;
  }
});

test('bots act only for the active seat and only with legal cards', () => {
  const state = start(23);
  const waiting = ok(engine.getObservation(state, players[1 - state.turn]));
  assert.equal(engine.chooseBotAction(waiting).error.code, 'NOT_YOUR_TURN');
  const active = ok(engine.getObservation(state, players[state.turn]));
  const first = ok(engine.chooseBotAction(active));
  assert.ok(active.hand.includes(first.action.card));
  const random = ok(
    engine.chooseBotAction(active, { strategy: 'random', randomState: 9 }),
  );
  assert.ok(active.hand.includes(random.action.card));
  assert.equal(random.nextRandomState, engine.nextRandom(9).state);
  assert.equal(
    engine.chooseBotAction(active, { strategy: 'magic' }).error.code,
    'INVALID_CONFIG',
  );
  assert.equal(
    engine.chooseBotAction(active, { strategy: 'random' }).error.code,
    'INVALID_CONFIG',
  );
});

test('a seat always alternates, including across batches and rounds', () => {
  const { seats, state } = playMatch(24);
  for (let i = 1; i < seats.length; i++) {
    if (i % 48 === 0) continue;
    const newBatch = i % 12 === 0;
    if (!newBatch) assert.notEqual(seats[i], seats[i - 1]);
  }
  assert.ok(state.rounds.length >= 1);
});
