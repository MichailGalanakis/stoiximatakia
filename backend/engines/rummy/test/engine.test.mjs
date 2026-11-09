import test from 'node:test';
import { randomStream, shuffled } from '../dist/esm/deck.js';
import {
  act,
  allCards,
  assert,
  deckFor,
  discard,
  engine,
  legal,
  meld,
  ok,
  pass,
  pileDraw,
  playersOf,
  playOut,
  rejected,
  scripted,
  seed,
  start,
  stockDraw,
} from './helpers.mjs';

const GAMES = ['koumkan', 'thanasis', 'biriba'];
const short = (game, n) =>
  playOut(start(game, n), n + 1, (state) => state.roundNumber === 2);
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
function playMatch(game, n, strategy) {
  let state = start(game, n),
    randomState = n,
    moves = 0;
  while (state.phase !== 'ended') {
    const id = state.initial.players[state.turn];
    const view = ok(engine.getObservation(state, id));
    const decision = ok(
      engine.chooseBotAction(view, {
        strategy,
        ...(strategy === 'random' ? { randomState } : {}),
      }),
    );
    if (decision.nextRandomState !== null)
      randomState = decision.nextRandomState;
    state = ok(engine.applyAction(state, id, decision.action, state.revision));
    moves += 1;
    assert.ok(moves < 60_000, 'match did not finish');
  }
  return state;
}

for (const game of GAMES) {
  test(`${game}: the same seed always produces the same game`, () => {
    assert.deepEqual(start(game, 7), start(game, 7));
    assert.deepEqual(short(game, 7), short(game, 7));
  });
  test(`${game}: different seeds produce different deals`, () => {
    const deals = new Set();
    for (let n = 0; n < 40; n++) {
      const state = start(game, n);
      deals.add(JSON.stringify([state.hands, state.discard]));
    }
    assert.equal(deals.size, 40);
  });
  test(`${game}: each round gets a new shuffle`, () => {
    const state = short(game, 8);
    assert.equal(state.roundNumber, 2);
    assert.notDeepEqual(state.hands, start(game, 8).hands);
  });
  test(`${game}: the first starter is drawn from the seed for every seat`, () => {
    const seats = new Map();
    for (let n = 0; n < 400; n++) {
      const { starter } = start(game, n);
      seats.set(starter, (seats.get(starter) ?? 0) + 1);
    }
    assert.equal(seats.size, engine.SEATS[game]);
    for (const count of seats.values())
      assert.ok(count > 60, JSON.stringify([...seats]));
  });
  test(`${game}: replay rebuilds the exact state from its records`, () => {
    const state = short(game, 9);
    assert.deepEqual(ok(engine.replay(state.initial, state.history)), state);
  });
  test(`${game}: snapshots survive a JSON round trip mid-round`, () => {
    const state = playOut(start(game, 10), 3, (current) => current.ply >= 41);
    const json = ok(engine.serializeState(state));
    assert.deepEqual(ok(engine.restoreState(json)), state);
    assert.deepEqual(engine.validateState(JSON.parse(json)), {
      valid: true,
      issues: [],
    });
  });
  test(`${game}: accepted states are immutable`, () => {
    const state = start(game, 11);
    assert.throws(() => state.hands[0].push('2C-0'));
    assert.throws(() => {
      state.scores[0] = 999;
    });
  });
  test(`${game}: restore rejects tampered cards, turns or scores`, () => {
    const state = playOut(start(game, 12), 5, (current) => current.ply >= 7);
    refused(tamper(state, (s) => s.hands[0].reverse()));
    refused(tamper(state, (s) => s.stock.reverse()));
    refused(tamper(state, (s) => (s.scores[0] = 500)));
    refused(tamper(state, (s) => s.discard.push('2C-0')));
    refused(tamper(state, (s) => (s.turn = (s.turn + 1) % engine.SEATS[game])));
    refused(tamper(state, (s) => (s.extra = true)));
  });
  test(`${game}: restore rejects a forged history`, () => {
    const state = short(game, 13);
    refused(tamper(state, (s) => s.rounds.pop()));
    refused(tamper(state, (s) => s.history.pop()));
    refused(tamper(state, (s) => (s.history[0].playerId = 'mallory')));
  });
  test(`${game}: restore refuses stacked decks on a standard game`, () => {
    const state = start(game, 14);
    const deck = deckFor(game, { hands: [], indicator: '9D-0' });
    refused(
      tamper(state, (s) => s.initial.decks.push(deck)),
      'INVALID_CONFIG',
    );
    refused(
      tamper(state, (s) => (s.initial.scores[0] = 10)),
      'INVALID_CONFIG',
    );
    refused(
      tamper(state, (s) => {
        s.initial.firstStarter =
          (s.initial.firstStarter + 1) % engine.SEATS[game];
      }),
      'INVALID_CONFIG',
    );
  });
  test(`${game}: restore refuses another rules or engine version`, () => {
    const state = start(game, 15);
    refused(
      tamper(state, (s) => (s.rulesVersion = 'skillbetting.other')),
      'UNSUPPORTED_VERSION',
    );
    refused(
      tamper(state, (s) => (s.engineVersion = '0.0.1')),
      'UNSUPPORTED_VERSION',
    );
    refused(
      tamper(state, (s) => (s.schemaVersion = 2)),
      'UNSUPPORTED_VERSION',
    );
    refused(
      tamper(state, (s) => (s.game = 'xeri')),
      'UNSUPPORTED_VERSION',
    );
  });
  test(`${game}: a view shows the viewer their own hand and nothing hidden`, () => {
    const state = playOut(start(game, 16), 6, (current) => current.ply >= 9);
    for (const [seat, id] of state.initial.players.entries()) {
      const view = ok(engine.getObservation(state, id));
      const text = JSON.stringify(view);
      assert.deepEqual(view.hand, state.hands[seat]);
      // The indicator and any pile just taken were face up, wherever they sit now.
      const seen = new Set([state.indicator, ...state.pickup]);
      const hidden = [
        ...state.hands.flatMap((hand, index) => (index === seat ? [] : hand)),
        ...state.stock,
        ...state.reserves.flat(),
      ].filter((card) => !seen.has(card));
      for (const card of hidden)
        assert.ok(!text.includes(`"${card}"`), `leaked ${card}`);
      assert.ok(!text.includes(state.initial.seed));
      assert.equal(view.stockCount, state.stock.length);
      assert.deepEqual(
        view.handCounts,
        state.hands.map((hand) => hand.length),
      );
    }
  });
  test(`${game}: a view with no viewer has no hand or actions`, () => {
    const view = ok(engine.getObservation(start(game, 17), null));
    assert.deepEqual(view.hand, []);
    assert.deepEqual(view.legalActions, []);
    assert.equal(view.viewerSeat, null);
  });
  test(`${game}: events never carry a hand, the stock or the seed`, () => {
    const created = engine.createGame({
      game,
      players: playersOf(game),
      seed: seed(18),
    });
    assert.ok(!JSON.stringify(created.events).includes(seed(18)));
    playOut(
      start(game, 18),
      9,
      (state) => state.roundNumber === 2,
      (state, before, events, action) => {
        const hidden = [
          ...before.hands.flatMap((hand, seat) =>
            seat === before.turn ? [] : hand,
          ),
          ...before.reserves.flat(),
        ];
        const shown = events.filter(
          (event) =>
            !['round-ended', 'round-started', 'match-ended'].includes(
              event.type,
            ),
        );
        const text = JSON.stringify(shown);
        for (const card of hidden)
          assert.ok(!text.includes(`"${card}"`), `leaked ${card}`);
        const drawn = events.find(
          (event) => event.type === 'card-drawn' && event.source === 'stock',
        );
        if (drawn) assert.deepEqual(drawn.cards, []);
        assert.equal(state.ply, before.ply + (action.type === 'next' ? 0 : 1));
      },
    );
  });
  test(`${game}: only the active player has legal actions`, () => {
    const state = start(game, 19);
    const active = state.initial.players[state.turn];
    const waiting =
      state.initial.players[(state.turn + 1) % engine.SEATS[game]];
    assert.ok(legal(state).actions.length > 0);
    assert.deepEqual(ok(engine.getLegalActions(state, waiting)), {
      actions: [],
      complete: true,
    });
    assert.ok(ok(engine.getObservation(state, active)).legalActions.length > 0);
    assert.equal(
      engine.getLegalActions(state, 'mallory').error.code,
      'UNKNOWN_PLAYER',
    );
  });
  test(`${game}: bots act only for the active seat`, () => {
    const state = start(game, 20);
    const id = state.initial.players[(state.turn + 1) % engine.SEATS[game]];
    const waiting = ok(engine.getObservation(state, id));
    assert.equal(engine.chooseBotAction(waiting).error.code, 'NOT_YOUR_TURN');
    const active = ok(
      engine.getObservation(state, state.initial.players[state.turn]),
    );
    const first = ok(engine.chooseBotAction(active));
    assert.deepEqual(first.action, active.legalActions[0]);
    const random = ok(
      engine.chooseBotAction(active, { strategy: 'random', randomState: 9 }),
    );
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
  test(`${game}: a move is refused on a stale revision or the wrong turn`, () => {
    const state = start(game, 21);
    const id = state.initial.players[state.turn];
    const stale = engine.applyAction(state, id, stockDraw, state.revision + 1);
    assert.equal(stale.error.code, 'STALE_REVISION');
    const other = state.initial.players[(state.turn + 1) % engine.SEATS[game]];
    rejected(state, stockDraw, 'NOT_YOUR_TURN', other);
    rejected(state, stockDraw, 'UNKNOWN_PLAYER', 'mallory');
  });
  test(`${game}: malformed actions are refused cleanly`, () => {
    const state = start(game, 22);
    for (const action of [
      null,
      'draw',
      [],
      {},
      { type: 'pass' },
      { type: 'draw' },
      { type: 'draw', source: 'pocket' },
      { type: 'draw', source: 'stock', extra: 1 },
      { type: 'meld', cards: 'x' },
      { type: 'meld', cards: ['ZZ'] },
      { type: 'discard', card: 7 },
      { type: 'extend', meld: 5, cards: [] },
      { type: 'replace', meld: 'meld-0' },
      { type: 'meld', cards: [], option: -1 },
      { type: 'meld', cards: Array(200).fill('2C-0') },
    ])
      rejected(state, action, 'INVALID_ACTION');
  });
  test(`${game}: a finished round waits for next from any participant`, () => {
    const start2 = playOut(
      start(game, 40),
      41,
      (state) => state.phase === 'round-end',
    );
    assert.equal(start2.roundNumber, 1);
    assert.equal(start2.rounds.length, 1);
    const held = start2.hands[0][0];
    rejected(start2, stockDraw, 'ILLEGAL_MOVE');
    if (held) rejected(start2, discard(held), 'ILLEGAL_MOVE');
    for (const id of start2.initial.players)
      assert.deepEqual(ok(engine.getLegalActions(start2, id)).actions, [
        { type: 'next' },
      ]);
    const last = start2.initial.players.at(-1);
    const result = engine.applyAction(start2, last, { type: 'next' });
    const next = ok(result);
    assert.equal(next.roundNumber, 2);
    assert.equal(next.ply, start2.ply);
    assert.equal(next.revision, start2.revision + 1);
    assert.deepEqual(next.scores, start2.scores);
    assert.equal(next.rounds.length, 1);
    assert.deepEqual(
      result.events.map((event) => event.type),
      ['round-started'],
    );
    assert.deepEqual(ok(engine.replay(next.initial, next.history)), next);
    rejected(next, { type: 'next' }, 'ILLEGAL_MOVE');
    const stranger = engine.applyAction(start2, 'mallory', { type: 'next' });
    assert.equal(stranger.error.code, 'UNKNOWN_PLAYER');
  });
  test(`${game}: every card action moves ply by one`, () => {
    playOut(
      start(game, 42),
      43,
      (state) => state.roundNumber === 2,
      (state, before, _events, action) => {
        const step = action.type === 'next' ? 0 : 1;
        assert.equal(state.ply, before.ply + step);
        assert.equal(state.revision, before.revision + 1);
      },
    );
  });
  test(`${game}: a cheating hand gets no help from an unknown id`, () => {
    const drawn = act(start(game, 23), stockDraw);
    const held = drawn.hands[drawn.turn];
    const card = engine.DECKS[game].find((item) => !held.includes(item));
    rejected(drawn, discard(card), 'ILLEGAL_MOVE');
  });
  test(`${game}: a finished match refuses more moves`, () => {
    const state = ok(
      engine.createAnalysisGame({
        game,
        players: playersOf(game),
        seed: seed(),
        firstStarter: 0,
        decks: [],
        scores: game === 'biriba' ? [9_000, 0] : [0, 9_000],
      }),
    );
    const end = playOut(state, 2, () => false);
    assert.equal(end.phase, 'ended');
    rejected(end, stockDraw, 'GAME_ENDED');
    rejected(end, { type: 'next' }, 'GAME_ENDED');
    assert.equal(ok(engine.isGameOver(end)), true);
    assert.deepEqual(legal(end), { actions: [], complete: true });
    const view = ok(engine.getObservation(end, end.initial.players[end.turn]));
    assert.equal(engine.chooseBotAction(view).error.code, 'GAME_ENDED');
  });
}
test('shuffles spread every card over the first seat evenly', () => {
  const counts = new Map(engine.DECKS.thanasis.map((card) => [card, 0]));
  const games = 1560;
  for (let n = 0; n < games; n++)
    for (const card of start('thanasis', n).hands[0])
      counts.set(card, counts.get(card) + 1);
  const expected = (games * 10) / 52;
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
test('complete matches finish under both bots', () => {
  for (const strategy of ['first-legal', 'random']) {
    const koum = playMatch('koumkan', 30, strategy);
    assert.ok(Math.max(...koum.scores) >= 100);
    const thanasis = playMatch('thanasis', 31, strategy);
    assert.ok(thanasis.rounds.length >= 5);
  }
});
test('a Biriba match finishes once a team stays past the target', () => {
  // Random play can lose points every round, so the teams start well ahead of it.
  const state = ok(
    engine.createAnalysisGame({
      game: 'biriba',
      players: playersOf('biriba'),
      seed: seed(),
      firstStarter: 0,
      decks: [],
      scores: [2_900, 2_800],
    }),
  );
  const end = playOut(state, 6, () => false);
  assert.equal(end.phase, 'ended');
  assert.ok(Math.max(...end.scores) >= 2005);
  assert.notEqual(end.scores[0], end.scores[1]);
});
test('game creation validates its inputs', () => {
  const code = (options) => engine.createGame(options).error?.code;
  const good = {
    game: 'koumkan',
    players: playersOf('koumkan'),
    seed: seed(),
  };
  assert.equal(code({ ...good, game: 'xeri' }), 'INVALID_CONFIG');
  assert.equal(code({ ...good, seed: 'short' }), 'INVALID_CONFIG');
  assert.equal(code({ ...good, seed: seed().toUpperCase() }), 'INVALID_CONFIG');
  assert.equal(code({ ...good, players: ['a'] }), 'INVALID_CONFIG');
  assert.equal(code({ ...good, players: ['a', 'a'] }), 'INVALID_CONFIG');
  assert.equal(code({ ...good, clock: '5+3' }), 'INVALID_CONFIG');
  assert.equal(
    code({ ...good, players: playersOf('biriba') }),
    'INVALID_CONFIG',
  );
  assert.equal(code({ game: 'koumkan', seed: seed() }), 'INVALID_CONFIG');
  assert.equal(code(null), 'INVALID_CONFIG');
});
test('analysis decks must be complete for their game', () => {
  const create = (game, decks, extra = {}) =>
    engine.createAnalysisGame({
      game,
      players: playersOf(game),
      seed: seed(),
      firstStarter: 0,
      decks,
      ...extra,
    });
  const deck = engine.DECKS.koumkan;
  assert.equal(create('koumkan', [deck.slice(1)]).ok, false);
  assert.equal(create('koumkan', [[...deck.slice(1), deck[1]]]).ok, false);
  assert.equal(create('thanasis', [deck]).ok, false);
  assert.equal(create('koumkan', [deck], { firstStarter: 2 }).ok, false);
  assert.equal(create('koumkan', [deck], { scores: [1] }).ok, false);
  assert.equal(create('koumkan', [deck], { scores: [99_999, 0] }).ok, false);
  const view = ok(
    engine.getObservation(ok(create('koumkan', [deck])), 'seat0'),
  );
  assert.equal(view.analysisRoot, true);
  assert.equal(
    ok(engine.getObservation(start('koumkan'), 'seat0')).analysisRoot,
    false,
  );
});
test('restore refuses malformed input', () => {
  assert.equal(engine.restoreState('{').ok, false);
  assert.equal(engine.restoreState(null).ok, false);
  assert.equal(engine.restoreState([]).ok, false);
  const cyclic = structuredClone(start('koumkan', 24));
  cyclic.history.push(cyclic);
  assert.equal(engine.restoreState(cyclic).ok, false);
});
test('the pile and melds are public, the packet is a count', () => {
  const state = pass(start('biriba', 25));
  const view = ok(engine.getObservation(state, 'seat2'));
  assert.deepEqual(view.discard, state.discard);
  assert.deepEqual(view.reserveCounts, [11, 11]);
  assert.deepEqual(view.reserveTaken, [false, false]);
  assert.equal(view.trump, state.trump);
  assert.equal(view.wildRank, null);
});
test('the Thanasis wild rank is public, and the pile can never be drawn', () => {
  const state = start('thanasis', 26);
  const view = ok(engine.getObservation(state, 'seat0'));
  assert.equal(view.wildRank, engine.rankOf(state.indicator));
  rejected(state, pileDraw, 'ILLEGAL_MOVE');
});
test('every listed action is accepted by applyAction', () => {
  const state = act(
    scripted('koumkan', {
      hands: [['5C-0', '6C-0', '7C-0', 'KH-0']],
      indicator: '9D-0',
      stock: ['KD-1'],
    }),
    stockDraw,
  );
  const listed = legal(state).actions;
  assert.ok(listed.some((action) => action.type === 'meld'));
  assert.ok(listed.some((action) => action.type === 'discard'));
  for (const action of listed)
    assert.equal(allCards(act(state, action)).length, 106);
  assert.ok(
    allCards(act(state, meld(['5C-0', '6C-0', '7C-0']))).length === 106,
  );
});
