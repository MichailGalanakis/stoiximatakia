import test from 'node:test';
import {
  assert,
  engine,
  finishRound,
  nextRound,
  ok,
  players,
  start,
  seed,
  allCards,
} from './helpers.mjs';

function roundEnd() {
  for (let n = 0; n < 20; n++) {
    const state = finishRound(start(n));
    if (state.phase === 'round-end') return state;
  }
  assert.fail('No unfinished seeded match found.');
}

test('round completion preserves the result screen until an explicit next control', () => {
  const state = roundEnd();
  assert.equal(state.roundNumber, 1);
  assert.equal(state.ply, 48);
  assert.equal(state.revision, 48);
  assert.equal(state.rounds.length, 1);
  assert.equal(state.matchOutcome, null);
  assert.deepEqual(state.hands, [[], []]);
  assert.deepEqual(state.stock, []);
  assert.deepEqual(state.table, []);
  assert.equal(allCards(state).length, 52);
  assert.deepEqual(state.scores, state.rounds[0].scores);
  for (const player of players) {
    const view = ok(engine.getObservation(state, player));
    assert.equal(view.phase, 'round-end');
    assert.deepEqual(view.legalActions, [{ type: 'next' }]);
    assert.deepEqual(ok(engine.chooseBotAction(view)).action, { type: 'next' });
    assert.ok(!JSON.stringify(view).includes(state.initial.seed));
  }
  assert.deepEqual(ok(engine.getObservation(state, null)).legalActions, []);
});

test('either participant can request the same deterministic next deal without a gameplay move', () => {
  const state = roundEnd();
  const [a, b] = players.map((player) => nextRound(state, player));
  assert.equal(a.phase, 'playing');
  assert.equal(a.roundNumber, 2);
  assert.equal(a.dealer, 1 - state.dealer);
  assert.equal(a.revision, state.revision + 1);
  assert.equal(a.history.length, state.history.length + 1);
  assert.equal(a.ply, state.ply);
  assert.deepEqual(a.scores, state.scores);
  assert.deepEqual(a.rounds, state.rounds);
  assert.deepEqual(a.hands, b.hands);
  assert.deepEqual(a.stock, b.stock);
  assert.deepEqual(a.table, b.table);
  assert.deepEqual(a.history.at(-1), {
    kind: 'player',
    playerId: players[0],
    action: { type: 'next' },
  });
  const transition = engine.applyAction(state, players[0], { type: 'next' });
  assert.deepEqual(
    transition.events.map((event) => event.type),
    ['round-started'],
  );
});

test('next is phase-bound, participant-bound and rejects extra action fields', () => {
  assert.equal(
    engine.applyAction(start(), players[0], { type: 'next' }).error.code,
    'ILLEGAL_MOVE',
  );
  const state = roundEnd();
  assert.equal(
    engine.applyAction(state, 'stranger', { type: 'next' }).error.code,
    'UNKNOWN_PLAYER',
  );
  assert.equal(
    engine.applyAction(state, players[0], { type: 'next', card: '2C' }).error
      .code,
    'INVALID_ACTION',
  );
  assert.equal(
    engine.applyAction(state, players[0], { type: 'lay', card: '2C' }).error
      .code,
    'ILLEGAL_MOVE',
  );
  const next = nextRound(state);
  assert.equal(
    engine.applyAction(next, players[0], { type: 'next' }, state.revision).error
      .code,
    'STALE_REVISION',
  );
  assert.equal(
    engine.applyAction(next, players[0], { type: 'next' }).error.code,
    'ILLEGAL_MOVE',
  );
});

test('round boundary and next control replay exactly across snapshot restoration', () => {
  const state = roundEnd();
  for (const candidate of [state, nextRound(state)]) {
    const restored = ok(engine.restoreState(JSON.stringify(candidate)));
    assert.deepEqual(restored, candidate);
    assert.deepEqual(
      ok(engine.replay(candidate.initial, candidate.history)),
      candidate,
    );
  }
  const next = nextRound(state);
  for (const change of [
    (copy) => {
      copy.ply++;
    },
    (copy) => {
      copy.phase = 'playing';
    },
    (copy) => {
      copy.history.push({
        kind: 'player',
        playerId: players[0],
        action: { type: 'next' },
      });
    },
  ]) {
    const forged = structuredClone(state);
    change(forged);
    assert.equal(engine.restoreState(forged).ok, false);
  }
  const forged = structuredClone(next);
  forged.history.pop();
  assert.equal(engine.restoreState(forged).ok, false);
});

test('terminal matches reject next and old automatic-round snapshots require their original version', () => {
  const initial = ok(
    engine.createAnalysisGame({
      players,
      seed: seed(),
      firstDealer: 0,
      decks: [],
      scores: [10000, 0],
    }),
  );
  const ended = finishRound(initial);
  assert.equal(ended.phase, 'ended');
  assert.equal(
    engine.applyAction(ended, players[0], { type: 'next' }).error.code,
    'GAME_ENDED',
  );
  for (const field of ['engineVersion', 'rulesVersion', 'schemaVersion']) {
    const old = structuredClone(start());
    old[field] =
      field === 'schemaVersion'
        ? 1
        : field === 'engineVersion'
          ? '0.1.0'
          : old.rulesVersion.replace('.v2', '.v1');
    assert.equal(engine.restoreState(old).error.code, 'UNSUPPORTED_VERSION');
  }
});
