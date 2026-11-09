import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  engine as e,
  assert,
  ok,
  setup,
  play,
  rejected,
  players,
} from './helpers.mjs';
import {
  advance,
  findLegalMove,
  inCheck,
  legalBoardMoves,
} from '../dist/esm/position.js';

const fixtures = JSON.parse(
  readFileSync(
    new URL('./finite-tempo-fixtures.json', import.meta.url),
    'utf8',
  ),
);
const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
const swap = (piece) =>
  piece === piece.toUpperCase() ? piece.toLowerCase() : piece.toUpperCase();
const name = (square, reverse) =>
  reverse ? square[0] + (9 - Number(square[1])) : square;
const spec = (coordinate, reverse = false) => ({
  from: name(coordinate.slice(0, 2), reverse),
  to: name(coordinate.slice(2, 4), reverse),
  ...(coordinate[4] ? { promotion: coordinate[4] } : {}),
});
const action = (coordinate, reverse = false) => ({
  type: 'move',
  ...spec(coordinate, reverse),
});
function transformFen(fen, reverse) {
  if (!reverse) return fen;
  const p = e.parseFen(fen),
    board = Array(64).fill(null);
  assert.equal(p.castling, '');
  for (let index = 0; index < 64; index++)
    if (p.board[index])
      board[(7 - (index >> 3)) * 8 + (index % 8)] = swap(p.board[index]);
  return e.toFen({
    ...p,
    board,
    turn: p.turn === 'white' ? 'black' : 'white',
    ep: p.ep === null ? null : (7 - (p.ep >> 3)) * 8 + (p.ep % 8),
  });
}
function roundtrip(state) {
  assert.deepEqual(ok(e.restoreState(ok(e.serializeState(state)))), state);
  assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
  assert.deepEqual(ok(cjs.restoreState(JSON.stringify(state))), state);
  assert.deepEqual(ok(cjs.replay(state.initial, state.history)), state);
  assert.equal(e.validateState(state).valid, true);
}
function assertDead(state, ply) {
  assert.equal(state.initial.mode, 'analysis');
  assert.equal(state.phase, 'ended');
  assert.equal(state.roundOutcome.reason, 'dead-position-proven');
  assert.equal(state.roundOutcome.ply, ply);
  assert.equal(state.matchOutcome.gameReason, 'dead-position-proven');
  for (const outcome of [state.roundOutcome, state.matchOutcome]) {
    assert.equal(outcome.kind, 'draw');
    assert.equal(outcome.winner, null);
    assert.equal(outcome.winnerId, null);
    assert.deepEqual(
      outcome.scores.map((score) => score.points),
      [0.5, 0.5],
    );
  }
  assert.equal(state.drawOffer, null);
  assert.equal(state.forcedMove, null);
  assert.equal(ok(e.isGameOver(state)), true);
  assert.equal(ok(e.isPlayStopped(state)), true);
  for (const viewer of [players.white, players.black, null]) {
    const observation = ok(e.getObservation(state, viewer));
    assert.equal(observation.phase, 'ended');
    assert.equal(observation.analysisRoot, true);
    assert.deepEqual(observation.legalActions, []);
    assert.equal(observation.conformance.exhaustiveDeadPositionOracle, false);
    assert.equal(
      e.chooseBotAction(observation, { strategy: 'first-legal' }).error.code,
      'GAME_ENDED',
    );
  }
  roundtrip(state);
}

for (const f of fixtures.dead)
  for (const reverse of [false, true]) {
    test(`finite pawn tempos exhaust all continuations automatically: ${f.id}; reverse=${reverse}`, () => {
      const fen = transformFen(f.fen, reverse),
        result = e.createAnalysisGame({ players, fen }),
        state = ok(result);
      assertDead(state, 0);
      assert.equal(state.fen, fen);
      assert.equal(state.initial.fen, fen);
      assert.equal(state.ply, 0);
      assert.equal(state.revision, 0);
      assert.deepEqual(state.history, []);
      assert.deepEqual(state.positionHistory, [e.positionKey(e.parseFen(fen))]);
      assert.deepEqual(
        result.events.map((event) => event.type),
        ['game-created', 'round-ended', 'match-ended'],
      );
      assert.deepEqual(result, cjs.createAnalysisGame({ players, fen }));
      assert.equal(e.analyzeLockedPosition(fen), null);
      const proof = e.analyzeDeadPosition(fen, 256);
      assert.equal(proof.status, 'dead');
      assert.equal(proof.witness, null);
      assert.ok(proof.nodes <= f.expectedGraphNodes);
      // A structural proof can close a root without enumerating its full graph.
      // A legal initial en-passant edge is deliberately left to exact search.
      if (fen.split(' ')[3] === '-') {
        assert.equal(e.analyzeTemporalPosition(fen).kind, 'finite-pawn-tempo');
        assert.deepEqual(e.analyzeDeadPosition(fen, 1), {
          status: 'dead',
          nodes: 1,
          witness: null,
        });
      } else {
        assert.equal(e.analyzeTemporalPosition(fen), null);
        assert.equal(e.analyzeDeadPosition(fen, 1).status, 'unknown');
      }
      if (fen.split(' ')[3] !== '-') {
        const noEp = fen.split(' ');
        noEp[3] = '-';
        assert.equal(
          state.positionHistory[0].split(' ')[3],
          name('f6', reverse),
        );
        assert.notEqual(
          e.positionKey(e.parseFen(fen)),
          e.positionKey(e.parseFen(noEp.join(' '))),
        );
        rejected(state, action('g5f6', reverse), 'GAME_ENDED');
      }
      rejected(state, action('e1d1', reverse), 'GAME_ENDED');
      rejected(state, { type: 'offer-draw' }, 'GAME_ENDED');
    });
  }

for (const reverse of [false, true])
  test(`all seven legal branches of the en-passant root immediately stalemate; reverse=${reverse}`, () => {
    // This checks the fixture's shape using the engine move generator. Independent
    // chess.js graph evidence is produced separately by verify-independent.mjs.
    const fen = transformFen(fixtures.dead[0].fen, reverse),
      position = e.parseFen(fen);
    const legal = legalBoardMoves(position);
    assert.equal(legal.length, 7);
    assert.ok(legal.some((move) => move.enPassant !== undefined));
    for (const move of legal) {
      const child = advance(position, move);
      assert.equal(inCheck(child), false);
      assert.deepEqual(legalBoardMoves(child), []);
      const state = setup(e.toFen(child));
      assert.equal(state.roundOutcome.reason, 'stalemate');
      assert.equal(state.roundOutcome.kind, 'draw');
    }
  });

for (const f of fixtures.closings)
  for (const reverse of [false, true]) {
    test(`a legal king retreat enters a finite-tempo dead root in the same transition: ${f.id}; reverse=${reverse}`, () => {
      const fen = transformFen(f.fen, reverse),
        before = setup(fen),
        move = action(f.move, reverse);
      assert.equal(before.phase, 'playing');
      const actor = before.initial.players[before.turn],
        frozen = JSON.stringify(before);
      const position = e.parseFen(fen),
        expectedFen = e.toFen(
          advance(position, findLegalMove(position, spec(f.move, reverse))),
        );
      rejected(before, move, 'STALE_REVISION', actor, before.revision + 1);
      rejected(before, move, 'UNKNOWN_PLAYER', 'spectator');
      rejected(
        before,
        move,
        'NOT_YOUR_TURN',
        actor === players.white ? players.black : players.white,
      );
      const offeredMove = { ...move, offerDraw: true };
      const result = e.applyAction(before, actor, offeredMove, before.revision),
        after = ok(result);
      assert.equal(JSON.stringify(before), frozen);
      assertDead(after, 1);
      assert.equal(after.ply, 1);
      assert.equal(after.revision, before.revision + 1);
      assert.equal(after.fen, expectedFen);
      assert.deepEqual(
        after.movesByColor,
        reverse ? { white: 1, black: 0 } : { white: 0, black: 1 },
      );
      assert.deepEqual(after.history, [
        { kind: 'player', playerId: actor, action: offeredMove },
      ]);
      assert.equal(after.positionHistory.length, 2);
      const target = transformFen(
        fixtures.dead.find((entry) => entry.id === f.target).fen,
        reverse,
      );
      assert.equal(after.positionHistory[1], e.positionKey(e.parseFen(target)));
      assert.deepEqual(
        result.events.map((event) => event.type),
        ['move-played', 'round-ended', 'match-ended'],
      );
      assert.deepEqual(
        result,
        cjs.applyAction(
          JSON.parse(frozen),
          actor,
          offeredMove,
          before.revision,
        ),
      );
      rejected(after, action('e1d1', reverse), 'GAME_ENDED');
    });
  }

for (const f of fixtures.live)
  for (const reverse of [false, true]) {
    test(`a sparse opponent move set can still allow cooperative mate: ${f.id}; reverse=${reverse}`, () => {
      const fen = transformFen(f.fen, reverse),
        winner = reverse
          ? f.winner === 'white'
            ? 'black'
            : 'white'
          : f.winner;
      const witness = f.witness.map((move) => spec(move, reverse));
      assert.deepEqual(e.validateMateWitness(fen, winner, witness), witness);
      let state = setup(fen);
      for (const move of witness) {
        assert.equal(state.phase, 'playing');
        assert.notEqual(e.analyzeDeadPosition(state.fen, 1).status, 'dead');
        roundtrip(state);
        const before = state,
          actor = before.initial.players[before.turn];
        const result = e.applyAction(
          before,
          actor,
          { type: 'move', ...move },
          before.revision,
        );
        assert.deepEqual(
          result,
          cjs.applyAction(
            before,
            actor,
            { type: 'move', ...move },
            before.revision,
          ),
        );
        state = ok(result);
        assert.equal(result.events[0].uci, e.uci(move));
      }
      const finalPosition = e.parseFen(state.fen);
      assert.equal(inCheck(finalPosition), true);
      assert.deepEqual(legalBoardMoves(finalPosition), []);
      assert.equal(state.roundOutcome.reason, 'checkmate');
      assert.equal(state.roundOutcome.winner, winner);
      assert.equal(state.roundOutcome.ply, witness.length);
      assert.equal(state.phase, 'ended');
      roundtrip(state);
    });
  }

for (const reverse of [false, true])
  test(`one mating branch prevents a draw despite many stalemating alternatives; reverse=${reverse}`, () => {
    const f = fixtures.live[0],
      fen = transformFen(f.fen, reverse),
      state = setup(fen),
      position = e.parseFen(fen);
    const branches = legalBoardMoves(position).map((move) =>
      advance(position, move),
    );
    assert.ok(
      branches.filter(
        (child) => legalBoardMoves(child).length === 0 && !inCheck(child),
      ).length > 4,
    );
    assert.ok(
      branches.some(
        (child) => legalBoardMoves(child).length === 0 && inCheck(child),
      ),
    );
    assert.ok(branches.some((child) => legalBoardMoves(child).length > 0));
    assert.equal(state.phase, 'playing');
    assert.equal(e.analyzeDeadPosition(fen, 256).status, 'not-dead');
    const stalemate = play(state, action(f.stalematingAlternative, reverse));
    assert.equal(stalemate.roundOutcome.reason, 'stalemate');
    assert.equal(stalemate.roundOutcome.ply, 1);
    roundtrip(stalemate);
    const continuing = play(state, action(f.continuingAlternative, reverse));
    assert.equal(continuing.phase, 'playing');
    assert.ok(
      ok(
        e.getLegalActions(
          continuing,
          continuing.initial.players[continuing.turn],
        ),
      ).length > 0,
    );
    roundtrip(continuing);
  });

test('an incorrect intended-move claim cannot postpone a finite-tempo ending', () => {
  let state = setup(fixtures.closings[0].fen);
  const closing = spec(fixtures.closings[0].move);
  state = play(state, {
    type: 'claim-draw',
    reason: 'fifty-move',
    intendedMove: closing,
  });
  assert.equal(state.phase, 'playing');
  assert.deepEqual(state.forcedMove, closing);
  roundtrip(state);
  const result = e.applyAction(
      state,
      players.black,
      { type: 'move', ...closing },
      state.revision,
    ),
    after = ok(result);
  assertDead(after, 1);
  assert.equal(after.revision, 2);
  assert.equal(after.history.length, 2);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ['move-played', 'round-ended', 'match-ended'],
  );
});
