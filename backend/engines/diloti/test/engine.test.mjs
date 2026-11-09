import test from 'node:test';
import { randomStream, shuffled } from '../dist/esm/deck.js';
import { splitsInto, listActions, declaration } from '../dist/esm/rules.js';
import {
  allCards,
  assert,
  deckFor,
  engine,
  finishRound,
  nextRound,
  lay,
  ok,
  players,
  scripted,
  seed,
  start,
} from './helpers.mjs';

function playMatch(n, strategy = 'random', visit = () => {}) {
  let state = start(n),
    randomState = n,
    decisions = 0;
  while (state.phase !== 'ended') {
    const player = players[state.turn];
    const view = ok(engine.getObservation(state, player));
    visit(state, view);
    const decision = ok(
      engine.chooseBotAction(view, {
        strategy,
        ...(strategy === 'random' ? { randomState } : {}),
      }),
    );
    if (decision.nextRandomState !== null)
      randomState = decision.nextRandomState;
    state = ok(
      engine.applyAction(state, player, decision.action, state.revision),
    );
    decisions++;
    assert.equal(allCards(state).length, 52);
    assert.equal(new Set(allCards(state)).size, 52);
  }
  return { state, decisions };
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

test('later rounds are dealt from fresh shuffles', () => {
  assert.notDeepEqual(nextRound(finishRound(start(8))).hands, start(8).hands);
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

test('splitsInto finds exact disjoint sums', () => {
  assert.equal(splitsInto([2, 3, 4, 5, 7], 7), true);
  assert.equal(splitsInto([7, 7, 7], 7), true);
  assert.equal(splitsInto([5, 5, 4, 3, 2, 1], 10), true);
  assert.equal(splitsInto([], 7), true);
  assert.equal(splitsInto([2, 5, 3], 7), false);
  assert.equal(splitsInto([6, 6, 1, 1], 7), true);
  assert.equal(splitsInto([5, 5, 2, 2], 7), true);
  assert.equal(splitsInto([4, 4, 4, 2], 7), false);
  assert.equal(splitsInto([9], 7), false);
  assert.equal(splitsInto([3, 3, 3, 3, 3, 3, 2, 2, 2], 9), false);
});

test('splitsInto stays quick on the largest possible table', () => {
  const values = [];
  for (let value = 1; value <= 10; value++)
    values.push(value, value, value, value);
  const started = Date.now();
  assert.equal(splitsInto(values, 10), true);
  assert.equal(splitsInto([...values.slice(0, -2), 9, 1, 3], 10), false);
  assert.ok(Date.now() - started < 1000);
});

test('complete matches finish with one winner', () => {
  for (const strategy of ['first-legal', 'random'])
    for (let n = 0; n < 6; n++) {
      const { state } = playMatch(n, strategy);
      assert.equal(state.phase, 'ended');
      const [a, b] = state.scores;
      assert.ok(Math.max(a, b) >= 61);
      assert.notEqual(a, b);
      assert.equal(state.matchOutcome.winner, a > b ? 0 : 1);
      assert.equal(state.ply, state.rounds.length * 48);
      assert.equal(state.revision, state.ply + state.rounds.length - 1);
    }
});

test('a declarer never holds two open declarations or loses a capture card', () => {
  for (let n = 0; n < 8; n++)
    playMatch(n, 'random', (state) => {
      for (const seat of [0, 1]) {
        const owned = state.table.filter((item) => item.owner === seat);
        assert.ok(owned.length <= 1);
        if (owned.length)
          assert.ok(
            state.hands[seat].some(
              (card) => engine.cardValue(card) === owned[0].value,
            ),
            'owner lost the capture card',
          );
      }
    });
});

test('some legal action is always listed for the active player', () => {
  for (let n = 0; n < 8; n++)
    playMatch(n, 'random', (state, view) => {
      assert.ok(view.legalActions.length > 0, JSON.stringify(state.table));
    });
});

/** Every syntactically possible selection on a small table, tried against the engine. */
function bruteForce(state) {
  const seat = state.turn;
  const legal = new Set();
  const key = (a) =>
    `${a.type}:${a.card}:${a.value ?? ''}:${[...(a.table ?? [])].sort().join()}`;
  const ids = state.table.map((item) => item.id);
  const trial = (action) => {
    if (engine.applyAction(state, players[seat], action).ok)
      legal.add(key(action));
  };
  for (const card of state.hands[seat]) {
    trial(lay(card));
    for (let mask = 1; mask < 1 << ids.length; mask++) {
      const table = ids.filter((_, index) => mask & (1 << index));
      trial({ type: 'capture', card, table });
      for (let value = 1; value <= 10; value++)
        trial({ type: 'declare', card, table, value });
    }
  }
  return { legal, key };
}

test('the action list equals an exhaustive search on small tables', () => {
  let states = 0;
  for (let n = 0; n < 30; n++) {
    let state = start(n);
    let randomState = n;
    for (let ply = 0; ply < 48; ply++) {
      if (state.table.length <= 6 && state.roundNumber === 1 && ply % 2 === 0) {
        const { legal, key } = bruteForce(state);
        const listed = ok(engine.getLegalActions(state, players[state.turn]));
        assert.equal(listed.complete, true);
        const keys = new Set(listed.actions.map(key));
        assert.equal(keys.size, listed.actions.length, 'duplicate action');
        assert.deepEqual(keys, legal);
        states++;
      }
      const view = ok(engine.getObservation(state, players[state.turn]));
      const decision = ok(
        engine.chooseBotAction(view, { strategy: 'random', randomState }),
      );
      randomState = decision.nextRandomState;
      state = ok(
        engine.applyAction(state, players[state.turn], decision.action),
      );
      if (state.roundNumber > 1) break;
    }
  }
  assert.ok(states > 100, `checked ${states} states`);
});

test('a crowded table is capped and says so', () => {
  const table = [];
  for (const suit of ['C', 'D', 'H', 'S'])
    for (const rank of ['A', '2', '3', '4', '5', '6', '7'])
      table.push({
        id: `${rank}${suit}`,
        cards: [`${rank}${suit}`],
        value: rank === 'A' ? 1 : Number(rank),
        owner: null,
        group: false,
      });
  const hand = ['8C', '8D', '9C', '9D', '10C', '10D'];
  const started = Date.now();
  const list = listActions(table, hand, 0);
  assert.equal(list.complete, false);
  assert.ok(list.actions.length > 0);
  assert.ok(list.actions.length <= 256 * hand.length);
  assert.ok(Date.now() - started < 3000, 'listing took too long');
  for (const action of list.actions)
    if (action.type === 'declare')
      assert.ok(
        'group' in
          declaration(table, hand, 0, action.card, action.table, action.value),
      );
});

test('replay rebuilds the exact state from its records', () => {
  const { state } = playMatch(11);
  assert.deepEqual(ok(engine.replay(state.initial, state.history)), state);
});

test('snapshots survive a JSON round trip mid-round', () => {
  let state = start(12);
  let randomState = 3;
  for (let i = 0; i < 31; i++) {
    const view = ok(engine.getObservation(state, players[state.turn]));
    const decision = ok(
      engine.chooseBotAction(view, { strategy: 'random', randomState }),
    );
    randomState = decision.nextRandomState;
    state = ok(engine.applyAction(state, players[state.turn], decision.action));
  }
  const json = ok(engine.serializeState(state));
  assert.deepEqual(ok(engine.restoreState(json)), state);
  assert.deepEqual(engine.validateState(JSON.parse(json)), {
    valid: true,
    issues: [],
  });
});

test('accepted states are immutable', () => {
  const state = start(13);
  assert.throws(() => state.hands[0].push('2C'));
  assert.throws(() => {
    state.table[0].value = 1;
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

test('restore rejects a tampered hand, stock, table or score', () => {
  const state = start(14);
  refused(tamper(state, (s) => s.hands[0].reverse()));
  refused(tamper(state, (s) => s.stock.reverse()));
  refused(tamper(state, (s) => (s.scores[0] = 60)));
  refused(tamper(state, (s) => s.table.pop()));
  refused(tamper(state, (s) => (s.table[0].value = 1)));
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
  const deck = deckFor(['2C', '3C', '4C', '5C']);
  refused(
    tamper(state, (s) => s.initial.decks.push(deck)),
    'INVALID_CONFIG',
  );
  refused(
    tamper(state, (s) => (s.initial.scores = [60, 0])),
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
    tamper(state, (s) => (s.rulesVersion = 'skillbetting.diloti.other')),
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
    engine.createAnalysisGame({ players, seed: seed(), firstDealer: 0, decks });
  assert.equal(create([engine.DECK.slice(1)]).ok, false);
  assert.equal(create([[...engine.DECK.slice(1), engine.DECK[1]]]).ok, false);
  const view = ok(
    engine.getObservation(ok(create([[...engine.DECK]])), 'alice'),
  );
  assert.equal(view.analysisRoot, true);
  assert.equal(ok(engine.getObservation(start(), 'alice')).analysisRoot, false);
});

test('a view shows the viewer their own hand and nothing else hidden', () => {
  const state = start(19);
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
  const state = ok(
    engine.applyAction(scripted(['2C', '5C', '3C', '4C'], ['7D']), 'alice', {
      type: 'capture',
      card: '7D',
      table: ['2C', '5C'],
    }),
  );
  const view = ok(engine.getObservation(state, 'bob'));
  assert.deepEqual(view.capturedCounts, [3, 0]);
  const text = JSON.stringify(view);
  assert.ok(!text.includes('"2C"'));
  assert.ok(!text.includes('"5C"'));
});

test('only the active player has legal actions', () => {
  const state = start(20);
  const active = players[state.turn],
    waiting = players[1 - state.turn];
  assert.ok(ok(engine.getLegalActions(state, active)).actions.length >= 6);
  assert.equal(ok(engine.getLegalActions(state, waiting)).actions.length, 0);
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
    const result = engine.applyAction(state, players[state.turn], {
      type: 'lay',
      card: state.hands[state.turn][0],
    });
    const next = result.ok
      ? result
      : engine.applyAction(
          state,
          players[state.turn],
          ok(engine.getLegalActions(state, players[state.turn])).actions[0],
        );
    const text = JSON.stringify(
      next.events.filter((event) => event.type !== 'round-ended'),
    );
    for (const card of hidden)
      assert.ok(!text.includes(`"${card}"`), `leaked ${card}`);
    state = next.state;
  }
});

test('bots act only for the active seat and only with legal actions', () => {
  const state = start(23);
  const waiting = ok(engine.getObservation(state, players[1 - state.turn]));
  assert.equal(engine.chooseBotAction(waiting).error.code, 'NOT_YOUR_TURN');
  const active = ok(engine.getObservation(state, players[state.turn]));
  const first = ok(engine.chooseBotAction(active));
  assert.ok(engine.applyAction(state, players[state.turn], first.action).ok);
  const random = ok(
    engine.chooseBotAction(active, { strategy: 'random', randomState: 9 }),
  );
  assert.ok(engine.applyAction(state, players[state.turn], random.action).ok);
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
