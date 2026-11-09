import { test } from 'node:test';
import {
  engine as e,
  assert,
  ok,
  start,
  setup,
  move,
  play,
  rejected,
} from './helpers.mjs';
const fool = [
  { from: 'f2', to: 'f3' },
  { from: 'e7', to: 'e5' },
  { from: 'g2', to: 'g4' },
  { from: 'd8', to: 'h4' },
];
const scholar = [
  { from: 'e2', to: 'e4' },
  { from: 'e7', to: 'e5' },
  { from: 'd1', to: 'h5' },
  { from: 'b8', to: 'c6' },
  { from: 'f1', to: 'c4' },
  { from: 'g8', to: 'f6' },
  { from: 'h5', to: 'f7' },
];
const wall = '7k/8/8/1p1p1p1p/pPpPpPpP/P1P1P1P1/8/K7 w - - 0 1';
const finiteTempoRoot = 'kb6/p1p5/P1P5/5pP1/8/8/P1P2P1P/4K3 w - - 0 1'; // fixed automatically in v0.1.5; full movement graph has 383 vertices
const complexCage = '6bk/8/8/8/p1p1p1p1/P1PpP1P1/P2P4/RNB1K3 w Q - 0 1'; // fixed automatically in v0.1.4; raw Q must survive

test('bounded cooperative search distinguishes unknown from impossible', () => {
  assert.equal(
    e.analyzeMatePossibility(e.START_FEN, 'white', 1).status,
    'unknown',
  );
  assert.equal(e.analyzeDeadPosition(e.START_FEN, 1).status, 'unknown');
  assert.equal(
    e.analyzeMatePossibility('4k3/8/8/8/8/8/P7/4K3 w - - 0 1', 'black', 1)
      .status,
    'impossible',
  );
});
test('a cooperative mate witness is independently checked, not treated as a prediction', () => {
  assert.deepEqual(e.validateMateWitness(e.START_FEN, 'black', fool), fool);
  assert.deepEqual(
    e.validateMateWitness(e.START_FEN, 'white', scholar),
    scholar,
  );
  assert.throws(() => e.validateMateWitness(e.START_FEN, 'white', fool));
  assert.throws(() => e.validateMateWitness(e.START_FEN, 'black', []));
  assert.throws(() =>
    e.validateMateWitness(e.START_FEN, 'black', [{ from: 'e2', to: 'e5' }]),
  );
  assert.throws(() =>
    e.validateMateWitness(e.START_FEN, 'black', [
      ...fool,
      { from: 'e2', to: 'e4' },
    ]),
  );
  assert.throws(() =>
    e.validateMateWitness(e.START_FEN, 'black', fool.slice(0, 3)),
  );
});
test('a sound small graph proof detects a fully locked pawn wall automatically', () => {
  assert.equal(e.analyzeDeadPosition(wall, 1000).status, 'dead');
  assert.equal(setup(wall).roundOutcome.reason, 'dead-position-proven');
});
test('a fixed automatic draw cannot be postponed or overwritten by an explicit proof', () => {
  const state = setup(complexCage);
  assert.equal(state.phase, 'ended');
  assert.equal(state.fen, complexCage);
  assert.deepEqual(e.analyzeDeadPosition(complexCage, 1), {
    status: 'dead',
    nodes: 1,
    witness: null,
  });
  assert.equal(
    e.proveDeadPosition(state, 5_000, state.revision).error.code,
    'GAME_ENDED',
  );
  assert.deepEqual(ok(e.restoreState(JSON.stringify(state))), state);
});
test('an inconclusive explicit proof never changes authoritative state or invents an outcome', () => {
  const state = start(),
    before = JSON.stringify(state);
  const result = e.proveDeadPosition(state, 1, state.revision);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROOF_INCONCLUSIVE');
  assert.equal(JSON.stringify(state), before);
  assert.equal(state.roundOutcome, null);
});
test('a finite-tempo certificate ends creation before an extra move or explicit proof', () => {
  const state = setup(finiteTempoRoot),
    before = JSON.stringify(state);
  assert.equal(state.phase, 'ended');
  assert.deepEqual(e.analyzeDeadPosition(finiteTempoRoot, 1), {
    status: 'dead',
    nodes: 1,
    witness: null,
  });
  for (const budget of [1, 256, 1000]) {
    assert.equal(
      e.proveDeadPosition(state, budget, state.revision).error.code,
      'GAME_ENDED',
    );
  }
  rejected(state, move('e1', 'd1'), 'GAME_ENDED');
  assert.equal(JSON.stringify(state), before);
  assert.equal(state.roundOutcome.reason, 'dead-position-proven');
  assert.equal(state.roundOutcome.winner, null);
  assert.equal(state.fen, finiteTempoRoot);
  assert.equal(state.ply, 0);
  assert.deepEqual(state.history, []);
  assert.deepEqual(ok(e.restoreState(before)), state);
  assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
});
test('a legal mate possibility prevents an explicit dead-position proof', () => {
  const state = setup('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1');
  const result = e.proveDeadPosition(state, 64);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_PROOF');
  const proof = e.analyzeMatePossibility(state.fen, 'white', 64);
  assert.equal(proof.status, 'possible');
  assert.ok(e.validateMateWitness(state.fen, 'white', proof.witness));
});
test('proof helpers enforce finite explicit resource bounds', () => {
  for (const maxNodes of [0, -1, 0.5, 100_001, NaN])
    assert.throws(() => e.analyzeDeadPosition(e.START_FEN, maxNodes));
  assert.throws(() => e.analyzeMatePossibility(e.START_FEN, 'green', 1));
});
test('resigning against a bare king is a draw, not an invented win', () => {
  const state = setup('4k3/8/8/8/8/8/P7/4K3 w - - 0 1');
  const next = play(state, { type: 'resign' }, 'alice');
  assert.equal(next.roundOutcome.reason, 'resignation-no-possible-mate');
  assert.equal(next.roundOutcome.winner, null);
});
test('resignation with an actual mate witness settles without guessing', () => {
  const state = start();
  const next = play(state, { type: 'resign', mateWitness: fool }, 'alice');
  assert.equal(next.roundOutcome.winner, 'black');
  assert.equal(next.roundOutcome.reason, 'resignation');
  assert.equal(next.fen, state.fen);
  assert.equal(next.ply, 0); // hypothetical proof is NOT gameplay
  assert.deepEqual(ok(e.restoreState(JSON.stringify(next))), next);
});
test('out-of-turn resignation is allowed, with a proof for the correct opponent', () => {
  const next = play(start(), { type: 'resign', mateWitness: scholar }, 'bob');
  assert.equal(next.roundOutcome.winner, 'white');
});
test('an invalid resignation witness is rejected atomically', () => {
  rejected(
    start(),
    { type: 'resign', mateWitness: scholar },
    'INVALID_PROOF',
    'alice',
  );
});
test('a mate-in-one position permits a quick exact resignation win', () => {
  const state = setup('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1');
  const next = play(state, { type: 'resign' }, 'bob');
  assert.equal(next.roundOutcome.winner, 'white');
  assert.equal(next.phase, 'ended');
});
test('unresolved resignation stops play and exposes no premature score or winner', () => {
  const next = play(start(), { type: 'resign' }, 'alice');
  assert.equal(next.phase, 'awaiting-adjudication');
  assert.equal(next.roundOutcome, null);
  assert.equal(next.matchOutcome, null);
  assert.equal(next.pendingResignation.prospectiveWinner, 'black');
  assert.equal(ok(e.isGameOver(next)), false);
  assert.equal(ok(e.isPlayStopped(next)), true);
  assert.deepEqual(ok(e.getLegalActions(next, 'bob')), []);
  rejected(next, move('e2', 'e4'), 'ADJUDICATION_PENDING', 'alice');
  assert.deepEqual(ok(e.restoreState(JSON.stringify(next))), next);
});
test('a pending resignation can be resolved with a checked witness, not client authority', () => {
  const state = play(start(), { type: 'resign' }, 'alice');
  rejected(
    state,
    { type: 'adjudication', opponentCanMate: true },
    'INVALID_ACTION',
    'bob',
  );
  const next = ok(e.resolveResignationWithWitness(state, fool, state.revision));
  assert.equal(next.roundOutcome.winner, 'black');
  assert.equal(next.revision, state.revision + 1);
  assert.equal(next.ply, 0);
  assert.deepEqual(ok(e.replay(next.initial, next.history)), next);
});
test('stale and irrelevant proof resolutions are rejected', () => {
  assert.equal(
    e.resolveResignationWithWitness(start(), fool, 0).error.code,
    'INVALID_PROOF',
  );
  const state = play(start(), { type: 'resign' }, 'alice');
  assert.equal(
    e.resolveResignationWithWitness(state, fool, 0).error.code,
    'STALE_REVISION',
  );
  assert.equal(
    e.resolveResignationWithWitness(state, scholar, state.revision).error.code,
    'INVALID_PROOF',
  );
});
test('trusted adjudication is separate from actions and retains private evidence only in authoritative history', () => {
  const state = play(start(), { type: 'resign' }, 'alice');
  const result = e.adjudicate(
    state,
    {
      type: 'resignation',
      opponentCanMate: true,
      authority: 'private-moderator-123',
      evidence: 'private-case-notes-456',
    },
    state.revision,
  );
  const next = ok(result);
  assert.equal(next.roundOutcome.winner, 'black');
  assert.equal(next.history.at(-1).decision.evidence, 'private-case-notes-456');
  assert.deepEqual(ok(e.restoreState(JSON.stringify(next))), next);
  for (const exposed of [
    ok(e.getObservation(next, 'alice')),
    ok(e.getObservation(next, null)),
    result.events,
  ]) {
    assert.equal(JSON.stringify(exposed).includes('private-case-notes'), false);
    assert.equal(JSON.stringify(exposed).includes('private-moderator'), false);
  }
});
test('trusted resignation adjudication can instead award the required draw', () => {
  const state = play(start(), { type: 'resign' }, 'alice');
  const next = ok(
    e.adjudicate(
      state,
      {
        type: 'resignation',
        opponentCanMate: false,
        authority: 'arbiter',
        evidence:
          'test decision: caller must verify actual mating impossibility',
      },
      state.revision,
    ),
  );
  assert.equal(next.roundOutcome.reason, 'resignation-no-possible-mate');
  assert.equal(next.roundOutcome.winner, null);
});
test('adjudicator input validation cannot overwrite a final outcome', () => {
  const state = start();
  assert.equal(
    e.adjudicate(
      state,
      {
        type: 'resignation',
        opponentCanMate: true,
        authority: 'a',
        evidence: 'e',
      },
      0,
    ).error.code,
    'INVALID_ADJUDICATION',
  );
  const pending = play(state, { type: 'resign' }, 'alice');
  assert.equal(
    e.adjudicate(
      pending,
      {
        type: 'resignation',
        opponentCanMate: true,
        authority: '',
        evidence: 'x',
      },
      pending.revision,
    ).error.code,
    'INVALID_ADJUDICATION',
  );
  const finished = play(state, { type: 'resign', mateWitness: fool }, 'alice');
  assert.equal(
    e.adjudicate(
      finished,
      { type: 'dead-position', authority: 'a', evidence: 'e' },
      finished.revision,
    ).error.code,
    'GAME_ENDED',
  );
});
test('trusted adjudication cannot replace the automatic finite-tempo outcome', () => {
  const state = setup(finiteTempoRoot),
    before = JSON.stringify(state);
  const result = e.adjudicate(
    state,
    {
      type: 'dead-position',
      authority: 'test-arbiter',
      evidence: 'already closed automatically',
    },
    state.revision,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'GAME_ENDED');
  assert.equal(JSON.stringify(state), before);
  assert.equal(state.roundOutcome.reason, 'dead-position-proven');
  assert.deepEqual(ok(e.restoreState(before)), state);
});

test('trusted finalization requires an explicit current revision even from untyped JavaScript', () => {
  const state = play(start(), { type: 'resign' }, 'alice');
  assert.equal(
    e.resolveResignationWithWitness(state, fool).error.code,
    'STALE_REVISION',
  );
  assert.equal(
    e.adjudicate(state, {
      type: 'resignation',
      opponentCanMate: true,
      authority: 'a',
      evidence: 'e',
    }).error.code,
    'STALE_REVISION',
  );
});
test('stopped-play and settled-result predicates cannot confuse a pending resignation with a payout', () => {
  const state = start();
  assert.equal(ok(e.isPlayStopped(state)), false);
  assert.equal(ok(e.isGameOver(state)), false);
  const finished = play(state, { type: 'resign', mateWitness: fool }, 'alice');
  assert.equal(ok(e.isPlayStopped(finished)), true);
  assert.equal(ok(e.isGameOver(finished)), true);
  assert.equal(e.isPlayStopped(null).ok, false);
  assert.equal(e.isGameOver(null).ok, false);
});
