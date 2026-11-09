import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as rummy from '#engines/rummy';
import { BiribaGameRuntime } from './card-game-runtime';
import { biribaMove } from '../../test/biriba-play';
const runtime = new BiribaGameRuntime();
const participants = ['a', 'b', 'c', 'd'].map((userId, seat) => ({
  userId,
  seat,
}));
const create = () =>
  runtime.start({
    gameId: 'biriba',
    formatId: 'standard',
    participants: [...participants].reverse(),
  });
const apply = (
  state: rummy.RummyState,
  action: unknown,
  userId = state.initial.players[state.turn]!,
) => runtime.apply({ state, action, userId, participants });
const observe = (state: unknown, userId: string) =>
  runtime.observe({ state, userId }) as rummy.RummyObservation & {
    lastPlay: unknown;
  };

void it('Biriba binds exactly four ordered funded seats to the approved team variant with independent secret seeds', () => {
  const first = create(),
    second = create();
  assert.equal(first.rulesVersion, rummy.RULES_VERSIONS.biriba);
  assert.equal(runtime.version, '0.1.0');
  assert.deepEqual(first.state.initial.players, ['a', 'b', 'c', 'd']);
  assert.notEqual(first.state.initial.seed, second.state.initial.seed);
  assert.deepEqual(
    first.state.hands.map((h) => h.length),
    [11, 11, 11, 11],
  );
  assert.deepEqual(
    first.state.reserves.map((h) => h.length),
    [11, 11],
  );
  assert.equal(first.state.stock.length, 41);
  for (const invalid of [
    participants.slice(0, 2),
    [...participants.slice(0, 3), { userId: 'a', seat: 3 }],
    [...participants.slice(0, 3), { userId: 'd', seat: 4 }],
  ])
    assert.throws(
      () =>
        runtime.start({
          gameId: 'biriba',
          formatId: 'standard',
          participants: invalid,
        }),
      { code: 'platform_unavailable' },
    );
  assert.throws(
    () =>
      runtime.start({ gameId: 'koumkan', formatId: 'standard', participants }),
    { code: 'engine_unavailable' },
  );
});
void it('Biriba gives each seat only its own cards, hiding partner/opponent hands, packets, seed and private stock draws', () => {
  const { state } = create();
  const accepted = apply(state, { type: 'draw', source: 'stock' });
  for (let seat = 0; seat < 4; seat++) {
    const view = observe(accepted.state, participants[seat]!.userId);
    assert.equal(view.viewerSeat, seat);
    assert.deepEqual(view.hand, accepted.state.hands[seat]);
    assert.deepEqual(
      view.handCounts,
      accepted.state.hands.map((h) => h.length),
    );
    assert.deepEqual(view.reserveCounts, [11, 11]);
    assert.equal(view.trump, rummy.suitOf(state.indicator));
    assert.deepEqual(view.lastPlay, {
      playerId: state.initial.players[state.turn],
      action: { type: 'draw', source: 'stock' },
    });
    for (const key of [
      'initial',
      'seed',
      'hands',
      'stock',
      'reserves',
      'reserveWaiting',
      'history',
      'turnDrawn',
    ])
      assert.equal(Object.hasOwn(view, key), false);
    assert.equal(JSON.stringify(view).includes(state.initial.seed), false);
  }
  assert.throws(() => observe(state, 'outsider'), {
    code: 'not_participating',
  });
});
void it('Biriba checks all four roster positions and rejects out-of-turn and spoofed authority without mutation', () => {
  const { state } = create(),
    saved = JSON.stringify(state),
    actor = state.initial.players[state.turn]!;
  for (const index of [2, 3]) {
    const changed = participants.map((p, i) =>
      i === index ? { ...p, userId: 'other' } : p,
    );
    assert.throws(
      () =>
        runtime.apply({
          state,
          userId: actor,
          action: { type: 'draw', source: 'stock' },
          participants: changed,
        }),
      { code: 'platform_unavailable' },
    );
  }
  assert.throws(
    () =>
      apply(
        state,
        { type: 'draw', source: 'stock' },
        state.initial.players[(state.turn + 2) % 4],
      ),
    { code: 'invalid_game_action' },
  );
  assert.throws(
    () =>
      apply(state, { type: 'draw', source: 'stock', winnerIds: ['a', 'c'] }),
    { code: 'invalid_game_action' },
  );
  assert.equal(JSON.stringify(state), saved);
});
void it('Biriba refuses mismatched variants, analysis, unsupported and modified snapshots', () => {
  const { state } = create();
  const other = rummy.createGame({
    game: 'koumkan',
    players: ['a', 'b'],
    seed: '0'.repeat(64),
  });
  const analysis = rummy.createAnalysisGame({
    game: 'biriba',
    players: ['a', 'b', 'c', 'd'],
    seed: '0'.repeat(64),
    firstStarter: 0,
    decks: [],
  });
  assert.ok(other.ok && analysis.ok);
  for (const invalid of [
    other.state,
    analysis.state,
    { ...state, scores: [9999, 0] },
  ])
    assert.throws(() => observe(invalid, 'a'), {
      code: 'platform_unavailable',
    });
  assert.throws(() => observe({ ...state, engineVersion: 'other' }, 'a'), {
    code: 'engine_unavailable',
  });
});
void it('Biriba exact selections use the active seat and own physical cards without changing game state', () => {
  const state = apply(create().state, { type: 'draw', source: 'stock' }).state,
    actor = state.initial.players[state.turn]!,
    selection = { cards: [state.hands[state.turn]![0]!] };
  const saved = JSON.stringify(state);
  assert.equal(
    runtime.preview({ state, userId: actor, selection }).discard,
    true,
  );
  assert.equal(JSON.stringify(state), saved);
  assert.throws(
    () =>
      runtime.preview({
        state,
        userId: state.initial.players[(state.turn + 2) % 4]!,
        selection,
      }),
    { code: 'invalid_game_action' },
  );
  assert.throws(
    () =>
      runtime.preview({
        state,
        userId: actor,
        selection: { cards: [state.hands[(state.turn + 2) % 4]![0]] },
      }),
    { code: 'invalid_game_action' },
  );
});
void it('Biriba plays a standard complete match, preserves Next and reports both opposite-seat winners', () => {
  const initial = rummy.createGame({
    game: 'biriba',
    players: ['a', 'b', 'c', 'd'],
    seed: '0'.repeat(64),
  });
  assert.ok(initial.ok);
  let state = initial.state,
    result: ReturnType<typeof apply> | undefined,
    nexts = 0;
  for (let moves = 0; !state.matchOutcome && moves < 2500; moves++) {
    const action = biribaMove(
      observe(state, state.initial.players[state.turn]!),
    );
    result = apply(
      state,
      action,
      action.type === 'next' ? 'd' : state.initial.players[state.turn]!,
    );
    if (action.type === 'next') {
      nexts++;
      assert.equal(result.gameplay, false);
      assert.equal(result.state.ply, state.ply);
      assert.deepEqual(result.state.scores, state.scores);
    } else assert.equal(result.gameplay, true);
    state = result.state;
  }
  assert.ok(state.matchOutcome);
  assert.ok(nexts > 0);
  assert.ok(result?.outcome?.kind === 'win');
  assert.deepEqual(result.outcome.winnerUserIds, state.matchOutcome.winnerIds);
  assert.equal(result.outcome.winnerUserIds.length, 2);
  const seats = result.outcome.winnerUserIds.map((id) =>
    state.initial.players.indexOf(id),
  );
  assert.equal(seats[1]! - seats[0]!, 2);
  assert.ok(Math.max(...state.scores) >= 2005);
});
