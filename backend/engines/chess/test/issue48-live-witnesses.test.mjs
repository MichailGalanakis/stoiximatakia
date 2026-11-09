import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { engine as e, assert, ok, players } from './helpers.mjs';

const fixture = JSON.parse(
  readFileSync(
    new URL('./issue48-live-mate-witnesses.json', import.meta.url),
    'utf8',
  ),
);

for (const winner of ['white', 'black'])
  test(`issue48 LIVE root retains its independently verified ${winner} mating continuation`, () => {
    const witness = fixture.witnesses[winner],
      moves = witness.uci.split(' ').map((uci) => ({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        ...(uci[4] ? { promotion: uci[4] } : {}),
      })),
      oracle = new Chess(fixture.fen);
    assert.equal(moves.length, winner === 'white' ? 79 : 84);
    assert.equal(moves.length, witness.plies);
    assert.deepEqual(e.validateMateWitness(fixture.fen, winner, moves), moves);
    let state = ok(e.createAnalysisGame({ players, fen: fixture.fen }));
    for (const [index, move] of moves.entries()) {
      assert.equal(state.phase, 'playing', `premature outcome at ply ${index}`);
      assert.equal(state.matchOutcome, null);
      oracle.move(move);
      state = ok(
        e.applyAction(
          state,
          players[state.turn],
          { type: 'move', ...move },
          state.revision,
        ),
      );
      assert.equal(
        e.positionKey(e.parseFen(state.fen)),
        e.positionKey(e.parseFen(oracle.fen())),
        `independent board mismatch at ply ${index + 1}`,
      );
    }
    assert.equal(oracle.isCheckmate(), true);
    assert.equal(oracle.fen(), witness.terminalFen);
    assert.equal(state.fen, witness.terminalFen);
    assert.equal(state.phase, 'ended');
    assert.equal(state.matchOutcome.kind, 'win');
    assert.equal(state.matchOutcome.winner, winner);
    assert.equal(state.matchOutcome.winnerId, players[winner]);
    assert.equal(state.matchOutcome.gameReason, 'checkmate');
    assert.equal(state.ply, witness.plies);
    assert.deepEqual(
      ok(e.getObservation(state, players[winner])).moves.map((m) => m.san),
      witness.san.split(' '),
    );
    assert.deepEqual(oracle.history(), witness.san.split(' '));
    assert.deepEqual(ok(e.restoreState(JSON.stringify(state))), state);
  });
