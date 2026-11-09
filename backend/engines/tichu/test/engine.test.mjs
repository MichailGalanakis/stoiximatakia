import test from 'node:test';
import { randomStream, shuffled } from '../dist/esm/deck.js';
import {
  act,
  allGrandsPass,
  assert,
  deckOf,
  engine,
  filled,
  nextMover,
  noGrand,
  ok,
  playing,
  playOut,
  players,
  play,
  rejected,
  seed,
  start,
} from './helpers.mjs';

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
const midGame = (n) =>
  playOut(
    start(n),
    n + 1,
    (state) => state.ply >= 30 && state.phase === 'play',
  );

test('the same seed always produces the same game', () => {
  assert.deepEqual(start(7), start(7));
  assert.deepEqual(midGame(7), midGame(7));
});
test('different seeds produce different deals', () => {
  const deals = new Set();
  for (let n = 0; n < 50; n++) deals.add(JSON.stringify(start(n).hands));
  assert.equal(deals.size, 50);
});
test('each round gets a new shuffle', () => {
  const state = playOut(
    start(8, '1000'),
    3,
    (current) => current.roundNumber === 2,
  );
  assert.notDeepEqual(state.hands, start(8, '1000').hands);
});
test('shuffles spread every card over the first seat evenly', () => {
  const counts = new Map(engine.DECK.map((card) => [card, 0]));
  const games = 1400;
  for (let n = 0; n < games; n++)
    for (const card of start(n).hands[0])
      counts.set(card, counts.get(card) + 1);
  const expected = (games * 8) / 56;
  let chiSquare = 0;
  for (const count of counts.values())
    chiSquare += (count - expected) ** 2 / expected;
  // 55 degrees of freedom; 95 is beyond the 0.999 quantile.
  assert.ok(chiSquare < 95, `chi-square ${chiSquare}`);
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
test('replay rebuilds the exact state from its records', () => {
  const state = midGame(9);
  assert.deepEqual(ok(engine.replay(state.initial, state.history)), state);
});
test('snapshots survive a JSON round trip mid-round', () => {
  const state = midGame(10);
  const json = ok(engine.serializeState(state));
  assert.deepEqual(ok(engine.restoreState(json)), state);
  assert.deepEqual(engine.validateState(JSON.parse(json)), {
    valid: true,
    issues: [],
  });
});
test('accepted states are immutable', () => {
  const state = start(11);
  assert.throws(() => state.hands[0].push('2C'));
  assert.throws(() => {
    state.scores[0] = 999;
  });
});
test('restore rejects tampered cards, turns or scores', () => {
  const state = midGame(12);
  refused(tamper(state, (s) => s.hands[0].reverse()));
  refused(tamper(state, (s) => (s.scores[0] = 500)));
  refused(tamper(state, (s) => s.pile.push('2C')));
  refused(tamper(state, (s) => (s.turn = (s.turn + 1) % 4)));
  refused(tamper(state, (s) => (s.wish = 7)));
  refused(tamper(state, (s) => (s.extra = true)));
});
test('restore rejects a forged history', () => {
  const state = midGame(13);
  refused(tamper(state, (s) => s.history.pop()));
  refused(tamper(state, (s) => (s.history[0].playerId = 'mallory')));
});
test('restore refuses stacked decks on a standard game', () => {
  const state = start(14);
  refused(
    tamper(state, (s) => s.initial.decks.push(deckOf(filled([])))),
    'INVALID_CONFIG',
  );
  refused(
    tamper(state, (s) => (s.initial.scores[0] = 10)),
    'INVALID_CONFIG',
  );
});
test('restore refuses another rules or engine version', () => {
  const state = start(15);
  refused(
    tamper(state, (s) => (s.rulesVersion = 'skillbetting.other')),
    'UNSUPPORTED_VERSION',
  );
  refused(
    tamper(state, (s) => (s.engineVersion = '0.0.1')),
    'UNSUPPORTED_VERSION',
  );
  refused(
    tamper(state, (s) => (s.schemaVersion = 99)),
    'UNSUPPORTED_VERSION',
  );
});
test('restore refuses malformed input', () => {
  assert.equal(engine.restoreState('{').ok, false);
  assert.equal(engine.restoreState(null).ok, false);
  assert.equal(engine.restoreState([]).ok, false);
  const cyclic = structuredClone(start(16));
  cyclic.history.push(cyclic);
  assert.equal(engine.restoreState(cyclic).ok, false);
});
test('a view shows the viewer their own hand and nothing hidden', () => {
  const state = midGame(17);
  for (const [seat, id] of players.entries()) {
    const view = ok(engine.getObservation(state, id));
    const text = JSON.stringify(view);
    assert.deepEqual(view.hand, state.hands[seat]);
    const hidden = [
      ...state.hands.flatMap((hand, index) => (index === seat ? [] : hand)),
      ...state.captured.flat(),
    ].filter((card) => !state.pile.includes(card));
    for (const card of hidden)
      assert.ok(!text.includes(`"${card}"`), `leaked ${card}`);
    assert.ok(!text.includes(state.initial.seed));
    assert.deepEqual(
      view.handCounts,
      state.hands.map((hand) => hand.length),
    );
  }
});
test('the later cards stay hidden during the Grand Tichu decisions', () => {
  const state = start(18);
  const text = JSON.stringify(ok(engine.getObservation(state, 'north')));
  for (const card of state.stock)
    assert.ok(!text.includes(`"${card}"`), `leaked ${card}`);
});
test('a view with no viewer has no hand or actions', () => {
  const view = ok(engine.getObservation(start(19), null));
  assert.deepEqual(view.hand, []);
  assert.deepEqual(view.legalActions, []);
  assert.equal(view.viewerSeat, null);
  assert.equal(view.yourMove, false);
});
test('events never carry a hand, the stock or the seed', () => {
  const created = engine.createGame({
    players,
    seed: seed(20),
    format: 'single',
  });
  assert.ok(!JSON.stringify(created.events).includes(seed(20)));
  playOut(
    start(20),
    4,
    () => false,
    (state, before, events) => {
      const hidden = [...before.stock, ...before.hands.flat()];
      const shown = events.filter(
        (event) =>
          !['cards-played', 'round-ended', 'match-ended'].includes(event.type),
      );
      const text = JSON.stringify(shown);
      for (const card of hidden)
        assert.ok(!text.includes(`"${card}"`), `leaked ${card}`);
    },
  );
});
test('ply moves by one on every action but next', () => {
  playOut(
    start(21, '1000'),
    5,
    (state) => state.roundNumber === 2,
    (state, before, _events, action) => {
      assert.equal(state.ply, before.ply + (action.type === 'next' ? 0 : 1));
      assert.equal(state.revision, before.revision + 1);
    },
  );
});
test('legal actions are always accepted', () => {
  let state = start(22);
  let random = 77;
  while (state.phase !== 'ended') {
    const id = nextMover(state);
    const listed = ok(engine.getLegalActions(state, id));
    for (const action of listed.actions.slice(0, 40)) {
      const result = engine.applyAction(state, id, action, state.revision);
      assert.equal(result.ok, true, JSON.stringify([action, result]));
    }
    const view = ok(engine.getObservation(state, id));
    const decision = ok(
      engine.chooseBotAction(view, { strategy: 'random', randomState: random }),
    );
    random = decision.nextRandomState;
    state = ok(engine.applyAction(state, id, decision.action, state.revision));
  }
});
test('an exchange list says it is incomplete', () => {
  const state = allGrandsPass(start(23));
  const listed = ok(engine.getLegalActions(state, 'north'));
  assert.equal(listed.complete, false);
  assert.ok(listed.actions.every((action) => action.type !== 'pass'));
  assert.ok(listed.actions.some((action) => action.type === 'declare'));
  const done = act(state, 0, listed.actions[0]);
  assert.equal(ok(engine.getLegalActions(done, 'north')).complete, true);
});
test('a hand with too many plays to list says so, and can still pass', () => {
  const rich = [
    'MAHJONG',
    'PHOENIX',
    '2C',
    '3D',
    '4C',
    '5D',
    '6C',
    '7D',
    '8C',
    '9D',
    '10C',
    'JD',
    'QC',
    'KD',
  ];
  const state = playing([rich, ['AC']]);
  const led = ok(engine.getLegalActions(state, 'north'));
  assert.equal(led.complete, false);
  assert.equal(led.actions.length, 513, 'the cap plus the Tichu call');
  assert.ok(led.actions.some((action) => action.type === 'declare'));
  const single = state.hands[0].find((card) => card === '2C');
  const next = act(state, 0, play([single]));
  assert.equal(next.turn, 1);
  const small = ok(engine.getLegalActions(next, 'east'));
  assert.equal(small.complete, true);
  assert.ok(small.actions.some((action) => action.type === 'pass'));
});
test('play options describe only readings that beat the table', () => {
  const state = playing([['MAHJONG', '2C', '3D', '5C', '6D', 'PHOENIX']]);
  const options = ok(
    engine.getPlayOptions(state, 'north', ['2C', '3D', '5C', '6D', 'PHOENIX']),
  );
  assert.deepEqual(
    options.map((option) => [option.kind, option.value, option.option]),
    [['straight', 6, 0]],
  );
  assert.equal(
    engine.getPlayOptions(state, 'north', ['KD', 'KC']).error.code,
    'ILLEGAL_MOVE',
  );
  assert.equal(
    engine.getPlayOptions(state, 'north', ['2C', '2C']).error.code,
    'ILLEGAL_MOVE',
  );
  assert.equal(
    engine.getPlayOptions(state, 'mallory', []).error.code,
    'UNKNOWN_PLAYER',
  );
});
test('bots act only when the game waits on them', () => {
  const state = act(start(24), 0, noGrand);
  const done = ok(engine.getObservation(state, 'north'));
  assert.equal(engine.chooseBotAction(done).error.code, 'NOT_YOUR_TURN');
  const waiting = ok(engine.getObservation(state, 'east'));
  const first = ok(engine.chooseBotAction(waiting));
  assert.deepEqual(first.action, waiting.legalActions[0]);
  const random = ok(
    engine.chooseBotAction(waiting, { strategy: 'random', randomState: 9 }),
  );
  assert.equal(random.nextRandomState, engine.nextRandom(9).state);
  assert.equal(
    engine.chooseBotAction(waiting, { strategy: 'magic' }).error.code,
    'INVALID_CONFIG',
  );
  assert.equal(
    engine.chooseBotAction(waiting, { strategy: 'random' }).error.code,
    'INVALID_CONFIG',
  );
});
test('first-legal bots finish a points match', () => {
  let state = start(25, '500');
  let moves = 0;
  while (state.phase !== 'ended') {
    const id = nextMover(state);
    const decision = ok(
      engine.chooseBotAction(ok(engine.getObservation(state, id))),
    );
    state = ok(engine.applyAction(state, id, decision.action, state.revision));
    moves += 1;
    assert.ok(moves < 20_000, 'match did not finish');
  }
  assert.ok(Math.max(...state.scores) >= 500);
});
test('a stale revision is refused', () => {
  const state = start(26);
  const result = engine.applyAction(
    state,
    'north',
    noGrand,
    state.revision + 1,
  );
  assert.equal(result.error.code, 'STALE_REVISION');
});
test('malformed actions are refused cleanly', () => {
  const state = start(27);
  for (const action of [
    null,
    'grand',
    [],
    {},
    { type: 'bid' },
    { type: 'grand' },
    { type: 'grand', call: 'yes' },
    { type: 'grand', call: true, extra: 1 },
    { type: 'exchange', cards: 'x' },
    { type: 'play', cards: ['ZZ'] },
    { type: 'play', cards: [], option: -1 },
    { type: 'play', cards: [], option: 100 },
    { type: 'play', cards: Array(70).fill('2C') },
    { type: 'dragon', to: 9 },
    { type: 'pass', extra: 1 },
  ])
    rejected(state, 0, action, 'INVALID_ACTION');
});
test('game creation validates its inputs', () => {
  const code = (options) => engine.createGame(options).error?.code;
  const good = { players, seed: seed(), format: 'single' };
  assert.equal(code({ ...good, format: '700' }), 'INVALID_CONFIG');
  assert.equal(code({ ...good, seed: 'short' }), 'INVALID_CONFIG');
  assert.equal(code({ ...good, seed: seed().toUpperCase() }), 'INVALID_CONFIG');
  assert.equal(code({ ...good, players: ['a', 'b'] }), 'INVALID_CONFIG');
  assert.equal(
    code({ ...good, players: ['a', 'a', 'b', 'c'] }),
    'INVALID_CONFIG',
  );
  assert.equal(code({ ...good, clock: '5+3' }), 'INVALID_CONFIG');
  assert.equal(code({ players, format: 'single' }), 'INVALID_CONFIG');
  assert.equal(code(null), 'INVALID_CONFIG');
});
test('analysis decks must be complete and are marked in the view', () => {
  const create = (decks, extra = {}) =>
    engine.createAnalysisGame({
      players,
      seed: seed(),
      format: 'single',
      decks,
      ...extra,
    });
  assert.equal(create([engine.DECK.slice(1)]).ok, false);
  assert.equal(create([[...engine.DECK.slice(1), engine.DECK[1]]]).ok, false);
  assert.equal(create([engine.DECK], { scores: [1] }).ok, false);
  assert.equal(create([engine.DECK], { scores: [999_999, 0] }).ok, false);
  const view = ok(engine.getObservation(ok(create([engine.DECK])), 'north'));
  assert.equal(view.analysisRoot, true);
  assert.equal(
    ok(engine.getObservation(start(28), 'north')).analysisRoot,
    false,
  );
});
test('a play needs different cards from the hand', () => {
  const state = playing([['MAHJONG', '3C', '3D']]);
  rejected(state, 0, play(['3C', '3C']), 'ILLEGAL_MOVE');
  rejected(state, 0, play(['KH']), 'ILLEGAL_MOVE');
});
