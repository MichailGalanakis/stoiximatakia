import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as rummy from '#engines/rummy';
import { KoumkanGameRuntime, ThanasisGameRuntime } from './card-game-runtime';
const runtime = new KoumkanGameRuntime();
const participants = [
  { userId: 'a', seat: 0 },
  { userId: 'b', seat: 1 },
] as const;
const create = () =>
  runtime.start({ gameId: 'koumkan', formatId: 'standard', participants });
const observe = (
  state: rummy.RummyState,
  userId = state.initial.players[state.turn]!,
) =>
  runtime.observe({ state, userId }) as rummy.RummyObservation & {
    lastPlay: unknown;
  };
const apply = (
  state: rummy.RummyState,
  action: unknown,
  userId = state.initial.players[state.turn]!,
) => runtime.apply({ state, action, userId, participants });

for (const [game, adapter] of [
  ['koumkan', runtime],
  ['thanasis', new ThanasisGameRuntime()],
] as const)
  void it(`${game} projects two zero reserve counts for the existing two-player room without changing state`, () => {
    const { state } = adapter.start({
      gameId: game,
      formatId: 'standard',
      participants,
    });
    const before = JSON.stringify(state);
    for (const userId of state.initial.players) {
      const view = adapter.observe({ state, userId }) as rummy.RummyObservation;
      assert.deepEqual(view.reserveCounts, [0, 0]);
      assert.deepEqual(view.reserveTaken, [false, false]);
    }
    assert.equal(JSON.stringify(state), before);
    assert.deepEqual(state.reserves, []);
  });

void it('Koum Kan starts the approved variant with two bound seats and independent secret seeds', () => {
  const first = create(),
    second = create();
  assert.equal(first.rulesVersion, rummy.RULES_VERSIONS.koumkan);
  assert.equal(runtime.version, '0.1.0');
  assert.equal(first.state.initial.game, 'koumkan');
  assert.deepEqual(first.state.initial.players, ['a', 'b']);
  assert.notEqual(first.state.initial.seed, second.state.initial.seed);
  assert.throws(
    () =>
      runtime.start({ gameId: 'biriba', formatId: 'standard', participants }),
    { code: 'engine_unavailable' },
  );
  assert.throws(
    () => runtime.start({ gameId: 'koumkan', formatId: 'other', participants }),
    { code: 'engine_unavailable' },
  );
});
void it('Koum Kan draw projections never expose the newly drawn opponent card or source state', () => {
  const { state } = create(),
    actor = state.initial.players[state.turn]!,
    other = state.initial.players[1 - state.turn]!;
  const accepted = apply(state, { type: 'draw', source: 'stock' });
  assert.equal(accepted.gameplay, true);
  assert.equal(accepted.state.ply, 1);
  const view = observe(accepted.state, other);
  assert.equal(view.hand.length, 10);
  assert.deepEqual(view.lastPlay, {
    playerId: actor,
    action: { type: 'draw', source: 'stock' },
  });
  for (const key of [
    'seed',
    'initial',
    'hands',
    'stock',
    'history',
    'turnDrawn',
    'reserves',
  ])
    assert.equal(Object.hasOwn(view, key), false);
  assert.equal(JSON.stringify(view).includes(state.initial.seed), false);
  assert.throws(() => observe(state, 'outsider'), {
    code: 'not_participating',
  });
});
void it('Koum Kan refuses other rummy variants, analysis, unsupported and modified snapshots', () => {
  const { state } = create();
  const thanasis = rummy.createGame({
    game: 'thanasis',
    players: ['a', 'b'],
    seed: '0'.repeat(64),
  });
  assert.ok(thanasis.ok);
  assert.throws(() => runtime.observe({ state: thanasis.state, userId: 'a' }), {
    code: 'platform_unavailable',
  });
  const analysis = rummy.createAnalysisGame({
    game: 'koumkan',
    players: ['a', 'b'],
    seed: '0'.repeat(64),
    firstStarter: 0,
    decks: [],
  });
  assert.ok(analysis.ok);
  assert.throws(() => runtime.observe({ state: analysis.state, userId: 'a' }), {
    code: 'platform_unavailable',
  });
  assert.throws(
    () =>
      runtime.observe({ state: { ...state, scores: [900, 0] }, userId: 'a' }),
    { code: 'platform_unavailable' },
  );
  assert.throws(
    () =>
      runtime.observe({
        state: { ...state, engineVersion: 'other' },
        userId: 'a',
      }),
    { code: 'engine_unavailable' },
  );
});
void it('Koum Kan exact selection is read-only and rejects spoofed actors and authority fields', () => {
  const drawn = apply(create().state, { type: 'draw', source: 'stock' }).state;
  const userId = drawn.initial.players[drawn.turn]!,
    saved = JSON.stringify(drawn),
    selection = { cards: [drawn.hands[drawn.turn]![0]!] };
  const result = runtime.preview({
    state: JSON.parse(saved) as unknown,
    userId,
    selection,
  });
  assert.deepEqual(result.selection, selection);
  assert.equal(result.discard, true);
  assert.equal(JSON.stringify(drawn), saved);
  assert.throws(
    () => runtime.preview({ state: drawn, userId: 'other', selection }),
    { code: 'invalid_game_action' },
  );
  assert.throws(
    () =>
      runtime.preview({
        state: drawn,
        userId,
        selection: { ...selection, scores: [0, 100] },
      }),
    { code: 'invalid_game_action' },
  );
  assert.throws(
    () => apply(drawn, { type: 'discard', card: selection.cards[0], userId }),
    { code: 'invalid_game_action' },
  );
  assert.throws(
    () =>
      runtime.apply({
        state: drawn,
        userId,
        action: { type: 'discard', card: selection.cards[0] },
        participants: [...participants]
          .reverse()
          .map((p, seat) => ({ ...p, seat })),
      }),
    { code: 'platform_unavailable' },
  );
});
void it('Koum Kan retains round results, classifies next as non-gameplay and maps the lowest-score winner', () => {
  const created = rummy.createGame({
    game: 'koumkan',
    players: ['a', 'b'],
    seed: '0'.repeat(64),
  });
  assert.ok(created.ok);
  let state = created.state,
    rounds = 0,
    result: ReturnType<typeof apply> | undefined;
  for (let moves = 0; !state.matchOutcome && moves < 1000; moves++) {
    const action =
      state.phase === 'round-end'
        ? { type: 'next' }
        : state.phase === 'draw'
          ? { type: 'draw', source: 'stock' }
          : { type: 'discard', card: state.hands[state.turn]![0]! };
    result = apply(state, action);
    if (action.type === 'next') {
      rounds++;
      assert.equal(result.gameplay, false);
      assert.equal(result.state.ply, state.ply);
      assert.deepEqual(result.state.scores, state.scores);
      assert.deepEqual(result.state.rounds, state.rounds);
    } else assert.equal(result.gameplay, true);
    state = result.state;
  }
  assert.ok(rounds > 0);
  assert.ok(state.matchOutcome);
  const outcome = result!.outcome;
  assert.ok(outcome?.kind === 'win');
  assert.deepEqual(outcome.winnerUserIds, state.matchOutcome.winnerIds);
  const winner = state.matchOutcome.winners[0]!;
  assert.ok(state.scores[winner]! < state.scores[1 - winner]!);
  assert.ok(Math.max(...state.scores) >= 100);
});
