import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as rummy from '#engines/rummy';
import { ThanasisGameRuntime } from './card-game-runtime';

const runtime = new ThanasisGameRuntime();
const participants = [
  { userId: 'a', seat: 0 },
  { userId: 'b', seat: 1 },
] as const;
const create = () =>
  runtime.start({ gameId: 'thanasis', formatId: 'standard', participants });
const apply = (
  state: rummy.RummyState,
  action: unknown,
  userId = state.initial.players[state.turn]!,
) => runtime.apply({ state, action, userId, participants });
const observe = (state: unknown, userId: string) =>
  runtime.observe({ state, userId }) as rummy.RummyObservation & {
    lastPlay: unknown;
  };

void it('Thanasis binds the approved two-player five-deal variant with fresh secret seeds', () => {
  const first = create(),
    second = create();
  assert.equal(first.rulesVersion, rummy.RULES_VERSIONS.thanasis);
  assert.equal(runtime.version, '0.1.0');
  assert.equal(first.state.game, 'thanasis');
  assert.deepEqual(first.state.initial.players, ['a', 'b']);
  assert.notEqual(first.state.initial.seed, second.state.initial.seed);
  assert.deepEqual(
    first.state.hands.map((h) => h.length),
    [10, 10],
  );
  assert.equal(first.state.stock.length, 31);
  for (const gameId of ['koumkan', 'biriba'] as const)
    assert.throws(
      () => runtime.start({ gameId, formatId: 'standard', participants }),
      { code: 'engine_unavailable' },
    );
  assert.throws(
    () => runtime.start({ gameId: 'thanasis', formatId: '500', participants }),
    { code: 'engine_unavailable' },
  );
  assert.throws(
    () =>
      runtime.start({
        gameId: 'thanasis',
        formatId: 'standard',
        participants: [participants[0], participants[0]],
      }),
    { code: 'platform_unavailable' },
  );
});

void it('Thanasis projects the public indicator and stock-only draw without exposing private draws', () => {
  const { state } = create(),
    actor = state.initial.players[state.turn]!,
    other = state.initial.players[1 - state.turn]!;
  const initial = observe(state, actor);
  assert.equal(initial.wildRank, rummy.rankOf(state.indicator));
  assert.equal(initial.indicator, state.indicator);
  assert.deepEqual(initial.legalActions, [{ type: 'draw', source: 'stock' }]);
  const accepted = apply(state, initial.legalActions[0]);
  assert.equal(accepted.gameplay, true);
  assert.equal(accepted.state.ply, 1);
  const privateView = observe(accepted.state, other);
  assert.deepEqual(privateView.hand, state.hands[1 - state.turn]);
  assert.deepEqual(privateView.lastPlay, {
    playerId: actor,
    action: { type: 'draw', source: 'stock' },
  });
  assert.equal(JSON.stringify(privateView).includes(state.initial.seed), false);
  for (const key of [
    'initial',
    'seed',
    'hands',
    'stock',
    'reserves',
    'history',
    'turnDrawn',
  ])
    assert.equal(Object.hasOwn(privateView, key), false);
  assert.throws(() => observe(state, 'outsider'), {
    code: 'not_participating',
  });
});

void it('Thanasis refuses pile draws, premature closing, public melds and spoofed authority without mutation', () => {
  const { state } = create(),
    saved = JSON.stringify(state);
  for (const action of [
    { type: 'draw', source: 'discard' },
    { type: 'close', card: state.hands[state.turn]![0] },
    { type: 'draw', source: 'stock', winnerId: 'a' },
  ])
    assert.throws(() => apply(state, action), { code: 'invalid_game_action' });
  const drawn = apply(state, { type: 'draw', source: 'stock' }).state;
  assert.throws(
    () =>
      apply(drawn, {
        type: 'meld',
        cards: drawn.hands[drawn.turn]!.slice(0, 3),
        option: 0,
      }),
    { code: 'invalid_game_action' },
  );
  assert.throws(
    () =>
      apply(drawn, { type: 'discard', card: drawn.hands[1 - drawn.turn]![0] }),
    { code: 'invalid_game_action' },
  );
  assert.throws(
    () =>
      runtime.apply({
        state: drawn,
        userId: drawn.initial.players[drawn.turn]!,
        action: observe(drawn, drawn.initial.players[drawn.turn]!)
          .legalActions[0],
        participants: [
          { userId: 'b', seat: 0 },
          { userId: 'a', seat: 1 },
        ],
      }),
    { code: 'platform_unavailable' },
  );
  assert.equal(JSON.stringify(state), saved);
});

void it('Thanasis refuses wrong variants, unsupported versions, analysis and tampered snapshots', () => {
  const { state } = create();
  const other = rummy.createGame({
    game: 'koumkan',
    players: ['a', 'b'],
    seed: '0'.repeat(64),
  });
  const analysis = rummy.createAnalysisGame({
    game: 'thanasis',
    players: ['a', 'b'],
    seed: '0'.repeat(64),
    firstStarter: 0,
    decks: [],
  });
  assert.ok(other.ok && analysis.ok);
  for (const invalid of [
    other.state,
    analysis.state,
    { ...state, scores: [999, 0] },
    { ...state, rulesVersion: rummy.RULES_VERSIONS.koumkan },
  ])
    assert.throws(() => observe(invalid, 'a'));
  assert.throws(
    () => observe({ ...state, engineVersion: 'unsupported' }, 'a'),
    { code: 'engine_unavailable' },
  );
});

void it('Thanasis retains round results, makes Next non-gameplay and settles only the lowest total after five deals', () => {
  const created = rummy.createGame({
    game: 'thanasis',
    players: ['a', 'b'],
    seed: '0'.repeat(64),
  });
  assert.ok(created.ok);
  let state = created.state,
    nexts = 0,
    result: ReturnType<typeof apply> | undefined;
  for (let moves = 0; !state.matchOutcome && moves < 1000; moves++) {
    const action = observe(state, state.initial.players[state.turn]!)
      .legalActions[0]!;
    result = apply(state, action);
    if (action.type === 'next') {
      nexts++;
      assert.equal(result.gameplay, false);
      assert.equal(result.state.ply, state.ply);
      assert.deepEqual(result.state.rounds, state.rounds);
      assert.deepEqual(result.state.scores, state.scores);
    } else assert.equal(result.gameplay, true);
    state = result.state;
    if (state.phase === 'round-end') {
      assert.equal(result.outcome, undefined);
      assert.throws(() => apply(state, { type: 'draw', source: 'stock' }), {
        code: 'invalid_game_action',
      });
    }
  }
  assert.ok(state.matchOutcome);
  assert.ok(state.rounds.length >= 5);
  assert.equal(nexts, state.rounds.length - 1);
  assert.ok(result?.outcome?.kind === 'win');
  assert.deepEqual(result.outcome.winnerUserIds, state.matchOutcome.winnerIds);
  const winner = state.matchOutcome.winners[0]!;
  assert.ok(state.scores[winner]! < state.scores[1 - winner]!);
});
