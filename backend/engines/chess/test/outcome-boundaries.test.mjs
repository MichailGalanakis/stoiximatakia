import { test } from 'node:test';
import { createRequire } from 'node:module';
import { engine as e, assert, ok, players } from './helpers.mjs';

const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
const swap = (piece) =>
  piece === piece.toUpperCase() ? piece.toLowerCase() : piece.toUpperCase();
const square = (name, reverse) =>
  reverse ? name[0] + (9 - Number(name[1])) : name;
const spec = (coordinate, reverse = false) => ({
  from: square(coordinate.slice(0, 2), reverse),
  to: square(coordinate.slice(2, 4), reverse),
});
function transformed(fen, reverse) {
  if (!reverse) return fen;
  const p = e.parseFen(fen),
    board = Array(64).fill(null);
  assert.equal(p.ep, null);
  for (let index = 0; index < 64; index++)
    if (p.board[index])
      board[(7 - (index >> 3)) * 8 + (index % 8)] = swap(p.board[index]);
  return e.toFen({
    ...p,
    board,
    turn: p.turn === 'white' ? 'black' : 'white',
    castling: [...p.castling].map(swap).join(''),
  });
}
function roundtrip(state) {
  const serialized = ok(e.serializeState(state));
  assert.deepEqual(ok(e.restoreState(serialized)), state);
  assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
  assert.deepEqual(ok(cjs.restoreState(serialized)), state);
}

for (const reverse of [false, true])
  test(`an intended fifty-move claim can precede a castling mate without executing it; reverse=${reverse}`, () => {
    const fen = transformed('4rkr1/4p1p1/8/8/8/2B5/8/4K2R w K - 99 1', reverse);
    const created = ok(
      e.createAnalysisGame({
        players,
        fen,
        movesBeforeStart: { white: 1, black: 1 },
      }),
    );
    const castle = spec('e1g1', reverse),
      actor = created.initial.players[created.turn];
    const winner = reverse ? 'black' : 'white';
    assert.equal(created.phase, 'playing');
    assert.deepEqual(e.validateMateWitness(fen, winner, [castle]), [castle]);
    const claims = ok(e.getDrawClaims(created, actor));
    assert.deepEqual(claims.current, []);
    assert.ok(
      claims.byIntendedMove.some(
        (entry) =>
          entry.reason === 'fifty-move' && e.uci(entry.move) === e.uci(castle),
      ),
    );
    const claimedResult = e.applyAction(
      created,
      actor,
      { type: 'claim-draw', reason: 'fifty-move', intendedMove: castle },
      created.revision,
    );
    const claimed = ok(claimedResult);
    assert.equal(claimed.roundOutcome.reason, 'fifty-move');
    assert.equal(claimed.roundOutcome.kind, 'draw');
    assert.equal(claimed.fen, created.fen);
    assert.equal(claimed.ply, 0);
    assert.deepEqual(claimed.positionHistory, created.positionHistory);
    assert.deepEqual(claimed.movesByColor, created.movesByColor);
    assert.equal(claimed.fen.split(' ')[2], reverse ? 'k' : 'K');
    assert.deepEqual(
      claimedResult.events.map((event) => event.type),
      ['draw-claim-accepted', 'round-ended', 'match-ended'],
    );
    roundtrip(claimed);
    // Choosing to play the actual move is a different accepted action: its
    // checkmate immediately wins and the castle consumes the recorded right.
    const playedResult = e.applyAction(
        created,
        actor,
        { type: 'move', ...castle },
        created.revision,
      ),
      played = ok(playedResult);
    assert.equal(played.roundOutcome.reason, 'checkmate');
    assert.equal(played.roundOutcome.winner, winner);
    assert.equal(played.fen.split(' ')[2], '-');
    assert.equal(e.parseFen(played.fen).halfmove, 100);
    assert.equal(playedResult.events[0].san, 'O-O#');
    assert.equal(played.ply, 1);
    roundtrip(played);
  });

for (const reverse of [false, true])
  test(`a checked live player may accept a valid draw offer before moving; reverse=${reverse}`, () => {
    const fen = transformed('5Q1k/8/5K2/8/8/8/8/8 b - - 0 1', reverse);
    const root = ok(
      e.createAnalysisGame({
        players,
        fen,
        movesBeforeStart: { white: 1, black: 1 },
      }),
    );
    const winner = reverse ? 'black' : 'white',
      offerer = root.initial.players[winner],
      responder = root.initial.players[root.turn];
    const witness = ['h8h7', 'f8g7'].map((move) => spec(move, reverse));
    assert.deepEqual(e.validateMateWitness(fen, winner, witness), witness);
    assert.equal(root.phase, 'playing');
    assert.equal(ok(e.getObservation(root, responder)).inCheck, true);
    const offered = ok(
      e.applyAction(root, offerer, { type: 'offer-draw' }, root.revision),
    );
    assert.equal(offered.turn, root.turn);
    assert.equal(offered.fen, fen);
    assert.ok(
      ok(e.getLegalActions(offered, responder)).some(
        (action) => action.type === 'accept-draw',
      ),
    );
    const agreed = ok(
      e.applyAction(
        offered,
        responder,
        { type: 'accept-draw' },
        offered.revision,
      ),
    );
    assert.equal(agreed.roundOutcome.reason, 'draw-agreement');
    assert.equal(agreed.roundOutcome.winner, null);
    assert.equal(agreed.fen, fen);
    assert.equal(agreed.ply, 0);
    roundtrip(agreed);
    // The same live board can instead continue legally to checkmate. The first
    // move rejects the opponent's offer without consuming any extra board turn.
    const evadedResult = e.applyAction(
        offered,
        responder,
        { type: 'move', ...witness[0] },
        offered.revision,
      ),
      evaded = ok(evadedResult);
    assert.deepEqual(
      evadedResult.events.map((event) => event.type),
      ['draw-declined', 'move-played'],
    );
    assert.equal(evaded.phase, 'playing');
    assert.equal(evaded.drawOffer, null);
    const mated = ok(
      e.applyAction(
        evaded,
        offerer,
        { type: 'move', ...witness[1] },
        evaded.revision,
      ),
    );
    assert.equal(mated.roundOutcome.reason, 'checkmate');
    assert.equal(mated.roundOutcome.winner, winner);
    assert.equal(mated.ply, 2);
    roundtrip(mated);
  });

test('non-board claims and offer responses never fabricate repetition occurrences or consume a turn', () => {
  let state = ok(e.createGame({ players }));
  const initial = state,
    witness = ['f2f3', 'e7e5', 'g2g4', 'd8h4'].map((move) => spec(move));
  e.validateMateWitness(state.fen, 'black', witness);
  for (let count = 0; count < 8; count++) {
    const result = e.applyAction(
      state,
      players.white,
      { type: 'claim-draw', reason: 'threefold-repetition' },
      state.revision,
    );
    state = ok(result);
    assert.ok(
      result.events.some((event) => event.type === 'draw-claim-rejected'),
    );
    assert.equal(state.phase, 'playing');
    assert.equal(state.forcedMove, null);
    state = ok(
      e.applyAction(
        state,
        players.black,
        { type: 'decline-draw' },
        state.revision,
      ),
    );
    assert.equal(state.fen, initial.fen);
    assert.equal(state.turn, 'white');
    assert.equal(state.ply, 0);
    assert.deepEqual(state.positionHistory, initial.positionHistory);
    assert.deepEqual(state.movesByColor, { white: 0, black: 0 });
    assert.deepEqual(ok(e.getDrawClaims(state, players.white)), {
      current: [],
      byIntendedMove: [],
    });
  }
  assert.equal(state.revision, 16);
  assert.equal(state.history.length, 16);
  assert.equal(state.roundOutcome, null);
  assert.equal(state.matchOutcome, null);
  roundtrip(state);
  for (const move of witness)
    state = ok(
      e.applyAction(
        state,
        state.initial.players[state.turn],
        { type: 'move', ...move },
        state.revision,
      ),
    );
  assert.equal(state.roundOutcome.reason, 'checkmate');
  assert.equal(state.roundOutcome.winner, 'black');
  assert.equal(state.ply, 4);
  roundtrip(state);
});
