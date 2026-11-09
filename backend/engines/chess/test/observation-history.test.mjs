import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  engine as e,
  assert,
  ok,
  start,
  setup,
  play,
  sequence,
} from './helpers.mjs';

const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');

test('complete public SAN history survives non-move commands, terminal restoration and either viewer', () => {
  let state = play(start(), { type: 'offer-draw' });
  state = play(state, { type: 'decline-draw' }, 'bob');
  state = sequence(state, [
    'e2e4',
    'e7e5',
    'd1h5',
    'b8c6',
    'f1c4',
    'g8f6',
    'h5f7',
  ]);
  const before = JSON.stringify(state);
  const expected = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'];
  for (const engine of [e, cjs]) {
    const restored = ok(engine.restoreState(before));
    for (const viewer of ['alice', 'bob', null]) {
      const history = ok(engine.getObservation(restored, viewer)).moves;
      assert.deepEqual(
        history.map((entry) => entry.san),
        expected,
      );
      assert.deepEqual(
        history.map((entry) => entry.by),
        ['white', 'black', 'white', 'black', 'white', 'black', 'white'],
      );
      assert.deepEqual(history.at(-1).move, { from: 'h5', to: 'f7' });
      assert.ok(Object.isFrozen(history));
      assert.ok(history.every(Object.isFrozen));
    }
  }
  assert.equal(JSON.stringify(state), before);
  assert.equal(state.ply, 7);
  assert.equal(state.revision, 9);
});

test('notation starts from the saved initial board and retains castling, en passant and promotion', () => {
  for (const [fen, moves, expected] of [
    ['r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 7', ['e8g8'], ['O-O']],
    ['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', ['e5d6'], ['exd6']],
    ['4k3/P7/8/8/8/8/8/4K3 w - - 0 1', ['a7a8q'], ['a8=Q+']],
  ]) {
    const state = sequence(setup(fen), moves);
    const restored = ok(e.restoreState(JSON.stringify(state)));
    assert.deepEqual(
      ok(e.getObservation(restored, null)).moves.map((entry) => entry.san),
      expected,
    );
  }
});

test('a pending intended-move claim stays out of notation until the bound move is actually played', () => {
  let state = play(start(), {
    type: 'claim-draw',
    reason: 'fifty-move',
    intendedMove: { from: 'e2', to: 'e4' },
  });
  state = play(state, { type: 'decline-draw' }, 'bob');
  const pending = ok(e.restoreState(JSON.stringify(state)));
  assert.deepEqual(ok(e.getObservation(pending, 'alice')).moves, []);
  assert.deepEqual(pending.forcedMove, { from: 'e2', to: 'e4' });
  state = sequence(pending, ['e2e4']);
  assert.deepEqual(ok(e.getObservation(state, 'alice')).moves, [
    { by: 'white', move: { from: 'e2', to: 'e4' }, san: 'e4' },
  ]);
  assert.equal(state.ply, 1);
  const resigned = play(state, {
    type: 'resign',
    mateWitness: [
      { from: 'e7', to: 'e5' },
      { from: 'd1', to: 'h5' },
      { from: 'b8', to: 'c6' },
      { from: 'f1', to: 'c4' },
      { from: 'g8', to: 'f6' },
      { from: 'h5', to: 'f7' },
    ],
  });
  assert.equal(resigned.phase, 'ended');
  assert.deepEqual(
    ok(e.getObservation(resigned, null)).moves,
    ok(e.getObservation(state, null)).moves,
  );
});
