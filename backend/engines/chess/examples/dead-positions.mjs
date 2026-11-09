import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  ENGINE_VERSION,
  createAnalysisGame,
  analyzeLockedPosition,
  analyzeTemporalPosition,
  analyzeDeadPosition,
  applyAction,
  restoreState,
  replay,
} from '../dist/esm/index.js';
const load = (name) =>
  JSON.parse(readFileSync(new URL(`../test/${name}`, import.meta.url), 'utf8'));
const corpora = [
  'dead-position-fixtures.json',
  'occupancy-fixtures.json',
  'castling-proof-fixtures.json',
  'finite-tempo-fixtures.json',
  'temporal-proof-fixtures.json',
  'temporal-castling-fixtures.json',
].map(load);
const fixtures = [
  ...new Map(
    corpora.flatMap((corpus) => corpus.dead).map((entry) => [entry.fen, entry]),
  ).values(),
];
const players = { white: 'alice', black: 'bob' };
function unwrap(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.state ?? result.value;
}
let reported = null;
const cases = fixtures.map((f) => {
  const created = createAnalysisGame({ players, fen: f.fen }),
    state = unwrap(created);
  assert.equal(state.phase, 'ended');
  assert.equal(state.fen, f.fen);
  assert.deepEqual(unwrap(restoreState(JSON.stringify(state))), state);
  assert.deepEqual(unwrap(replay(state.initial, state.history)), state);
  const structural = analyzeLockedPosition(f.fen),
    temporal = analyzeTemporalPosition(f.fen);
  const proof1 = analyzeDeadPosition(f.fen, 1),
    proof256 = analyzeDeadPosition(f.fen, 256);
  assert.equal(proof256.status, 'dead');
  if (f.id === 'reported-finite-tempo-castling') {
    const extra = applyAction(
      state,
      'alice',
      { type: 'move', from: 'c2', to: 'c4' },
      state.revision,
    );
    assert.equal(extra.ok, false);
    assert.equal(extra.error.code, 'GAME_ENDED');
    reported = {
      id: f.id,
      fen: f.fen,
      phase: state.phase,
      outcome: state.roundOutcome,
      retainedCastling: state.fen.split(' ')[2],
      positionIdentity: state.positionHistory[0],
      events: created.events.map((event) => event.type),
      temporalCertificate: temporal,
      oneNodeProof: proof1,
      automaticBudgetProof: proof256,
      extraMove: 'c2c4',
      extraMoveError: extra.error.code,
    };
    assert.equal(reported.retainedCastling, 'Q');
    assert.equal(reported.positionIdentity.split(' ')[2], 'Q');
    assert.equal(temporal, null);
    assert.deepEqual(proof1, { status: 'unknown', nodes: 1, witness: null });
    assert.deepEqual(proof256, { status: 'dead', nodes: 116, witness: null });
  }
  return {
    id: f.id,
    automaticPhase: state.phase,
    reason: state.roundOutcome?.reason,
    retainedFen: state.fen,
    structuralCertificate: structural?.kind ?? null,
    castlingExclusions: structural?.castlingExclusions ?? null,
    temporalCertificate: temporal
      ? {
          kind: temporal.kind,
          clockSide: temporal.clockSide,
          frozenKing: temporal.frozenKing,
          maxClockMoves: temporal.maxClockMoves,
          maxOtherMoves: temporal.maxOtherMoves,
          castlingTransitions: temporal.castlingTransitions,
          clockCastlingExclusions: temporal.clockCastlingExclusions,
          originalPieceRegions: temporal.regions.length,
          abstractTypedStates: temporal.regions.reduce(
            (count, entry) => count + entry.states.length,
            0,
          ),
        }
      : null,
    proof1,
    proof256,
    restored: true,
    replayed: true,
  };
});
assert.ok(reported);
console.log(
  JSON.stringify(
    {
      engineVersion: ENGINE_VERSION,
      reported,
      cases,
      limitations:
        'These sufficient proofs and selected regressions do not establish exhaustive automatic recognition. A root certificate may decline while certified exact descendants close the unchanged search allowance. See KNOWN_LIMITATIONS.md. Analysis fixtures have no established standard-start history.',
    },
    null,
    2,
  ),
);
