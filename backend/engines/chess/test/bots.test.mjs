import { test } from 'node:test';
import {
  engine as e,
  assert,
  ok,
  start,
  setup,
  move,
  play,
  sequence,
} from './helpers.mjs';

test('bot chooses from the same legal-action interface as a human', () => {
  const state = start(),
    observation = ok(e.getObservation(state, 'alice'));
  for (const strategy of ['first-legal', 'capture', 'random']) {
    const decision = ok(
      e.chooseBotAction(observation, { strategy, randomState: 42 }),
    );
    assert.ok(
      observation.legalActions.some(
        (a) => JSON.stringify(a) === JSON.stringify(decision.action),
      ),
    );
    assert.equal(play(state, decision.action).ply, 1);
  }
});
test('random decisions are reproducible and advance only the explicit external RNG state', () => {
  const observation = ok(e.getObservation(start(), 'alice'));
  const a = ok(
    e.chooseBotAction(observation, { strategy: 'random', randomState: 0 }),
  );
  const b = ok(
    e.chooseBotAction(observation, { strategy: 'random', randomState: 0 }),
  );
  assert.deepEqual(a, b);
  assert.notEqual(a.nextRandomState, 0);
  assert.equal('randomState' in observation, false);
  assert.equal('seed' in observation, false);
});
test('capture bot takes a checkmate before ordinary captures', () => {
  const state = setup('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1');
  const decision = ok(e.chooseBotAction(ok(e.getObservation(state, 'alice'))));
  assert.equal(play(state, decision.action).roundOutcome.reason, 'checkmate');
});
test('bots reject spectator/off-turn views, unknown strategies and invalid/missing random state', () => {
  const state = start();
  for (const viewer of [null, 'bob'])
    assert.equal(
      e.chooseBotAction(ok(e.getObservation(state, viewer))).error.code,
      'NOT_YOUR_TURN',
    );
  const view = ok(e.getObservation(state, 'alice'));
  for (const options of [
    { strategy: 'not-a-bot' },
    { strategy: 'random' },
    { randomState: -1 },
    { strategy: 'random', randomState: Infinity },
    { strategy: 'random', randomState: 0x100000000 },
    { secret: 'bad' },
  ])
    assert.equal(e.chooseBotAction(view, options).ok, false);
  const ended = sequence(state, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  assert.equal(
    e.chooseBotAction(ok(e.getObservation(ended, 'alice'))).error.code,
    'GAME_ENDED',
  );
});
test('a rejected-claim compulsory move is also compulsory for bots', () => {
  const state = play(start(), {
    type: 'claim-draw',
    reason: 'threefold-repetition',
    intendedMove: { from: 'e2', to: 'e4' },
  });
  const decision = ok(
    e.chooseBotAction(ok(e.getObservation(state, 'alice')), {
      strategy: 'random',
      randomState: 123,
    }),
  );
  assert.deepEqual(decision.action, move('e2', 'e4'));
});

function selfPlay(seed, verifySnapshots) {
  let state = start(),
    rng = seed;
  while (state.phase === 'playing' && state.ply < 1400) {
    const actor = state.initial.players[state.turn],
      view = ok(e.getObservation(state, actor));
    const decision = ok(
      e.chooseBotAction(view, { strategy: 'random', randomState: rng }),
    );
    rng = decision.nextRandomState;
    const before = state;
    state = play(state, decision.action, actor);
    assert.equal(before.ply + 1, state.ply);
    assert.equal(state.positionHistory.length, state.ply + 1);
    const p = e.parseFen(state.fen);
    assert.equal(p.board.filter((x) => x === 'K').length, 1);
    assert.equal(p.board.filter((x) => x === 'k').length, 1);
    if (verifySnapshots && state.ply % 31 === 0)
      state = ok(e.restoreState(ok(e.serializeState(state))));
  }
  assert.equal(
    state.phase,
    'ended',
    `Self-play seed ${seed} exceeded the test limit.`,
  );
  assert.ok(state.roundOutcome);
  assert.ok(state.matchOutcome);
  if (verifySnapshots)
    assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
  return { state, rng };
}
for (let seed = 1; seed <= 12; seed++)
  test(`complete seeded random-v-random game ${seed}, with snapshot resumption`, () =>
    selfPlay(seed, true));
test('a full seeded game repeats byte-for-byte, including its outcome and RNG continuation', () => {
  assert.deepEqual(selfPlay(8, false), selfPlay(8, false));
});
