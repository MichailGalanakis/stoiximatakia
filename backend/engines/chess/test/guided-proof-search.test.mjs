import { test } from 'node:test';
import { createRequire } from 'node:module';
import { Chess } from 'chess.js';
import { engine as e, assert, ok, players } from './helpers.mjs';

const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
const hard = '1Bb5/1p6/pPp3k1/2Pp3p/P2PpBpP/4P1P1/5K2/8 w - - 0 1';
const ordinary = [
  [e.START_FEN, 8423],
  ['r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4', 1683],
  ['7k/8/8/1p1p1p1p/pPpPpPpP/P1P1P1P1/8/KB6 w - - 0 1', 10391],
  ['6bk/8/8/8/p1p1p1p1/P1PpP1P1/3P4/RN5K w - - 0 1', 18610],
  ['4rkr1/4p1p1/8/8/8/2B5/8/4K1NR w K - 0 1', 1290],
  ['7k/8/8/8/p1p1p1p1/P1P1P1P1/4b2B/6BK b - - 0 1', 2],
  ['kb6/p1p5/P1P5/1Q3pP1/5P2/8/8/4K3 w - f6 0 1', 36],
  ['kb6/p1p5/P1P5/5pP1/8/8/3P1P1P/4K3 w - - 0 1', 488],
  ['kb6/p1p3P1/P1P5/5p2/8/8/P1P2P1P/4K3 w - - 0 1', 44],
];
function oracle(fen, evidence) {
  const board = new Chess(fen);
  for (const move of evidence.moves) board.move(move);
  assert.equal(board.isCheckmate(), true);
  assert.notEqual(board.turn(), evidence.winner === 'white' ? 'w' : 'b');
  return board;
}

test('original bounded positive strategy and first-attempt witnesses stay unchanged across the ordinary nine-case matrix', () => {
  for (const [fen, visited] of ordinary) {
    const original = e.findMateReachabilityWitness(fen);
    assert.equal(original.status, 'not-dead');
    assert.equal(original.visited, visited);
    assert.deepEqual(
      e.verifyReachabilityDecision(fen, original.evidence).verdict,
      'not-dead',
    );
    oracle(fen, original.evidence);
    assert.deepEqual(e.solveMateReachabilityExactly(fen), {
      status: 'not-dead',
      evidence: original.evidence,
    });
  }
});

test('generic pawn-bait ordering resolves the known live search tail within one bounded attempt and preserves actual game endings', () => {
  assert.equal(e.findMateReachabilityWitness(hard).status, 'unknown');
  const result = e.findMateReachabilityWitness(hard, {
    strategy: 'pawn-bait-before-capture',
  });
  assert.equal(result.status, 'not-dead');
  assert.ok(result.visited <= 30000);
  assert.ok(result.evidence.moves.length > 0);
  assert.deepEqual(
    e.verifyReachabilityDecision(hard, result.evidence).verdict,
    'not-dead',
  );
  assert.deepEqual(
    cjs.findMateReachabilityWitness(hard, {
      strategy: 'pawn-bait-before-capture',
    }),
    result,
  );
  assert.deepEqual(e.solveMateReachabilityExactly(hard), {
    status: 'not-dead',
    evidence: result.evidence,
  });
  const independent = oracle(hard, result.evidence),
    running = new Chess(hard);
  let state = ok(e.createAnalysisGame({ players, fen: hard }));
  for (const move of result.evidence.moves) {
    assert.equal(
      state.phase,
      'playing',
      'no repetition/move-count/dead ending precedes the witness mate',
    );
    running.move(move);
    state = ok(
      e.applyAction(
        state,
        state.initial.players[state.turn],
        { type: 'move', ...move },
        state.revision,
      ),
    );
    assert.equal(
      e.positionKey(e.parseFen(state.fen)),
      running.fen().split(' ').slice(0, 4).join(' '),
    );
  }
  assert.equal(state.roundOutcome.reason, 'checkmate');
  assert.equal(state.roundOutcome.winner, result.evidence.winner);
  assert.equal(
    e.positionKey(e.parseFen(state.fen)),
    independent.fen().split(' ').slice(0, 4).join(' '),
  );
  assert.deepEqual(
    e.findMateReachabilityWitness(hard, {
      strategy: 'pawn-bait-before-capture',
      maxNodes: 1,
    }),
    { status: 'unknown', evidence: null, visited: 1 },
  );
  assert.throws(
    () => e.findMateReachabilityWitness(hard, { strategy: 'unsupported' }),
    { code: 'INVALID_CONFIG' },
  );
});
