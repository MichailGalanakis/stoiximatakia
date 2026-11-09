import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  engine as e,
  assert,
  ok,
  setup,
  start,
  play,
  rejected,
  players,
} from './helpers.mjs';
const fixtures = JSON.parse(
  readFileSync(new URL('./occupancy-fixtures.json', import.meta.url), 'utf8'),
);

function transformFen(fen, mirror, reverse) {
  const p = e.parseFen(fen),
    board = Array(64).fill(null);
  for (let sq = 0; sq < 64; sq++)
    if (p.board[sq]) {
      const f = sq % 8,
        r = sq >> 3,
        piece = p.board[sq];
      board[(reverse ? 7 - r : r) * 8 + (mirror ? 7 - f : f)] = reverse
        ? piece === piece.toUpperCase()
          ? piece.toLowerCase()
          : piece.toUpperCase()
        : piece;
    }
  return e.toFen({
    ...p,
    board,
    turn: reverse ? (p.turn === 'white' ? 'black' : 'white') : p.turn,
  });
}
function transformMove(coordinate, mirror, reverse) {
  const sq = (s) =>
    String.fromCharCode(
      97 + (mirror ? 7 - (s.charCodeAt(0) - 97) : s.charCodeAt(0) - 97),
    ) + (reverse ? 9 - Number(s[1]) : s[1]);
  return {
    from: sq(coordinate.slice(0, 2)),
    to: sq(coordinate.slice(2, 4)),
    ...(coordinate[4] ? { promotion: coordinate[4] } : {}),
  };
}

for (const fixture of fixtures.dead)
  for (const mirror of [false, true])
    for (const reverse of [false, true]) {
      test(`occupancy sets prove ${fixture.id}; mirror=${mirror}, reverse=${reverse}`, () => {
        const fen = transformFen(fixture.fen, mirror, reverse),
          certificate = e.analyzeLockedPosition(fen);
        assert.equal(certificate?.kind, 'permanent-pawn-wall-escape-sets');
        assert.ok(certificate.escapeSets.length > 0);
        for (const proof of certificate.escapeSets) {
          assert.ok(proof.candidates.length > proof.maxOccupants);
          assert.ok(
            Number.isInteger(proof.maxOccupants) && proof.maxOccupants >= 0,
          );
        }
        assert.deepEqual(e.analyzeDeadPosition(fen, 1), {
          status: 'dead',
          nodes: 1,
          witness: null,
        });
        const state = setup(fen);
        assert.equal(state.phase, 'ended');
        assert.equal(state.roundOutcome.reason, 'dead-position-proven');
        assert.equal(state.roundOutcome.winner, null);
        assert.equal(state.matchOutcome.kind, 'draw');
        assert.deepEqual(
          state.matchOutcome.scores.map((x) => x.points),
          [0.5, 0.5],
        );
        assert.deepEqual(
          ok(e.restoreState(ok(e.serializeState(state)))),
          state,
        );
        assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
      });
    }

for (const fixture of fixtures.live.filter((x) => !x.coveredByTransitionSuite))
  for (const mirror of [false, true])
    for (const reverse of [false, true]) {
      test(`actual mating witness prevents a false draw: ${fixture.id}; mirror=${mirror}, reverse=${reverse}`, () => {
        const fen = transformFen(fixture.fen, mirror, reverse);
        const winner = reverse
          ? fixture.winner === 'white'
            ? 'black'
            : 'white'
          : fixture.winner;
        const witness = fixture.witness.map((move) =>
          transformMove(move, mirror, reverse),
        );
        assert.deepEqual(e.validateMateWitness(fen, winner, witness), witness);
        let state = setup(fen);
        for (const move of witness) {
          assert.equal(state.phase, 'playing');
          assert.equal(e.analyzeLockedPosition(state.fen), null);
          assert.notEqual(e.analyzeDeadPosition(state.fen, 1).status, 'dead');
          state = play(state, { type: 'move', ...move });
        }
        assert.equal(state.phase, 'ended');
        assert.equal(state.roundOutcome.reason, 'checkmate');
        assert.equal(state.roundOutcome.winner, winner);
        assert.deepEqual(ok(e.restoreState(JSON.stringify(state))), state);
        assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
      });
    }

test('distinct same-symbol bishops can jointly occupy both escapes; one bishop cannot', () => {
  const dead = fixtures.dead[0],
    live = fixtures.live[0];
  const certificate = e.analyzeLockedPosition(dead.fen);
  const h1 = certificate.escapeSets.find(
    (x) => x.color === 'white' && x.from === 'h1',
  );
  assert.deepEqual([...h1.candidates].sort(), ['g1', 'h2']);
  assert.equal(h1.maxOccupants, 1);
  assert.equal(e.parseFen(live.fen).board.filter((x) => x === 'B').length, 2);
  assert.equal(e.analyzeLockedPosition(live.fen), null);
  assert.equal(setup(live.fen).phase, 'playing');
  // An actual mate above establishes the live side of this pair; null alone does not.
});

test('escape-set diagnostics are detached data and confer no player authority', () => {
  const fen = fixtures.dead[0].fen,
    certificate = e.analyzeLockedPosition(fen);
  certificate.escapeSets[0].candidates.length = 0;
  certificate.escapeSets[0].maxOccupants = 999;
  certificate.escapeSets.length = 0;
  assert.ok(e.analyzeLockedPosition(fen).escapeSets.length > 0);
  assert.equal(setup(fen).matchOutcome.kind, 'draw');
  rejected(
    start(),
    { type: 'dead-position', certificate },
    'INVALID_ACTION',
    players.white,
  );
});
