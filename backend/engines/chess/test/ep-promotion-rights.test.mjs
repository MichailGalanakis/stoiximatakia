import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { engine as e, assert, ok, players, rejected } from './helpers.mjs';
import {
  legalBoardMoves,
  moveSpec,
  squareIndex,
} from '../dist/esm/position.js';

const fixtures = JSON.parse(
  readFileSync(
    new URL('./ep-promotion-rights-fixtures.json', import.meta.url),
    'utf8',
  ),
);
const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
const swap = (piece) =>
  piece === piece.toUpperCase() ? piece.toLowerCase() : piece.toUpperCase();
function transformed(fen, mirror, reverse) {
  const fields = fen.split(' ');
  let ranks = fields[0].split('/');
  if (mirror) ranks = ranks.map((rank) => [...rank].reverse().join(''));
  if (reverse)
    ranks = ranks.reverse().map((rank) => rank.replace(/[a-z]/gi, swap));
  fields[0] = ranks.join('/');
  if (reverse) {
    fields[1] = fields[1] === 'w' ? 'b' : 'w';
    fields[2] = fields[2].replace(/[kq]/gi, swap);
  }
  if (fields[3] !== '-') fields[3] = square(fields[3], mirror, reverse);
  assert.ok(
    !mirror || fields[2] === '-',
    'File reflections here are used only without castling rights.',
  );
  return fields.join(' ');
}
function square(name, mirror = false, reverse = false) {
  return (
    String.fromCharCode(
      mirror ? 104 - (name.charCodeAt(0) - 97) : name.charCodeAt(0),
    ) + (reverse ? 9 - Number(name[1]) : name[1])
  );
}
const spec = (coordinate, mirror = false, reverse = false) => ({
  from: square(coordinate.slice(0, 2), mirror, reverse),
  to: square(coordinate.slice(2, 4), mirror, reverse),
  ...(coordinate[4] ? { promotion: coordinate[4] } : {}),
});
const action = (coordinate, mirror = false, reverse = false) => ({
  type: 'move',
  ...spec(coordinate, mirror, reverse),
});
function setup(fen) {
  return ok(
    e.createAnalysisGame({
      players,
      fen,
      movesBeforeStart: { white: 1, black: 1 },
    }),
  );
}
function apply(state, move, actor = state.initial.players[state.turn]) {
  const result = e.applyAction(state, actor, move, state.revision);
  assert.deepEqual(result, cjs.applyAction(state, actor, move, state.revision));
  return { state: ok(result), events: result.events };
}
function roundtrip(state) {
  const json = ok(e.serializeState(state));
  assert.deepEqual(ok(e.restoreState(json)), state);
  assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
  assert.deepEqual(ok(cjs.restoreState(json)), state);
  assert.deepEqual(ok(cjs.replay(state.initial, state.history)), state);
  assert.equal(e.validateState(state).valid, true);
  for (const viewer of [players.white, players.black, null]) {
    const observation = ok(e.getObservation(state, viewer));
    assert.equal(observation.fen, state.fen);
    assert.equal(observation.phase, state.phase);
    if (viewer === null) assert.deepEqual(observation.legalActions, []);
  }
}

for (const mirror of [false, true])
  for (const reverse of [false, true]) {
    test(`one pinned en-passant capturer does not erase the other legal capture; mirror=${mirror}, reverse=${reverse}`, () => {
      const fixture = fixtures.onePinnedEnPassant,
        fen = transformed(fixture.fen, mirror, reverse),
        state = setup(fen);
      assert.equal(state.phase, 'playing');
      const expected = spec(fixture.legal, mirror, reverse),
        pinned = action(fixture.illegal, mirror, reverse);
      const position = e.parseFen(fen),
        epMoves = legalBoardMoves(position)
          .filter((move) => move.enPassant !== undefined)
          .map(moveSpec);
      assert.deepEqual(epMoves, [expected]);
      const noEp = fen.split(' ');
      noEp[3] = '-';
      assert.notEqual(
        e.positionKey(position),
        e.positionKey(e.parseFen(noEp.join(' '))),
      );
      assert.equal(state.positionHistory[0].split(' ')[3], fen.split(' ')[3]);
      rejected(state, pinned, 'ILLEGAL_MOVE');
      rejected(
        state,
        { type: 'move', ...expected },
        'STALE_REVISION',
        state.initial.players[state.turn],
        state.revision + 1,
      );
      roundtrip(state);
      const result = apply(state, { type: 'move', ...expected }),
        after = result.state,
        board = e.parseFen(after.fen).board;
      assert.equal(board[squareIndex(expected.to)], reverse ? 'p' : 'P');
      assert.equal(
        board[squareIndex(square(fixture.captured, mirror, reverse))],
        null,
      );
      assert.equal(board[squareIndex(expected.from)], null);
      assert.equal(after.fen.split(' ')[3], '-');
      assert.equal(after.fen.split(' ')[4], '0');
      assert.equal(after.ply, 1);
      assert.equal(after.revision, 1);
      assert.equal(result.events[0].san, expected.from[0] + 'x' + expected.to);
      roundtrip(after);
    });

    test(`two pinned en-passant capturers preserve raw FEN but not repetition eligibility; mirror=${mirror}, reverse=${reverse}`, () => {
      const fixture = fixtures.bothPinnedEnPassant,
        fen = transformed(fixture.fen, mirror, reverse),
        state = setup(fen);
      assert.equal(state.phase, 'playing');
      assert.equal(
        legalBoardMoves(e.parseFen(fen)).filter(
          (move) => move.enPassant !== undefined,
        ).length,
        0,
      );
      const noEp = fen.split(' ');
      noEp[3] = '-';
      assert.equal(
        e.positionKey(e.parseFen(fen)),
        e.positionKey(e.parseFen(noEp.join(' '))),
      );
      assert.notEqual(state.fen.split(' ')[3], '-');
      assert.equal(state.positionHistory[0].split(' ')[3], '-');
      for (const coordinate of fixture.illegal)
        rejected(state, action(coordinate, mirror, reverse), 'ILLEGAL_MOVE');
      roundtrip(state);
      const after = apply(state, action(fixture.quiet, mirror, reverse)).state;
      assert.equal(after.fen.split(' ')[3], '-');
      assert.equal(after.fen.split(' ')[4], '1');
      roundtrip(after);
    });
  }

for (const reverse of [false, true])
  for (const promotion of ['q', 'r', 'b', 'n']) {
    test(`promotion capture removes only the captured rook's castling right; promotion=${promotion}, reverse=${reverse}`, () => {
      const fixture = fixtures.promotionCapturesOriginalRook,
        fen = transformed(fixture.fen, false, reverse),
        state = setup(fen);
      assert.equal(state.phase, 'playing');
      const move = action(fixture.capture + promotion, false, reverse),
        result = apply(state, move),
        after = result.state;
      assert.equal(after.phase, 'playing');
      assert.equal(after.fen.split(' ')[2], reverse ? 'Q' : 'q');
      assert.equal(
        after.positionHistory.at(-1).split(' ')[2],
        reverse ? 'Q' : 'q',
      );
      assert.equal(after.fen.split(' ')[4], '0');
      assert.equal(
        e.parseFen(after.fen).board[squareIndex(move.to)],
        reverse ? promotion : promotion.toUpperCase(),
      );
      assert.equal(e.parseFen(after.fen).board[squareIndex(move.from)], null);
      const checked = promotion === 'q' || promotion === 'r';
      assert.equal(
        ok(e.getObservation(after, after.initial.players[after.turn])).inCheck,
        checked,
      );
      assert.equal(
        result.events[0].san,
        move.from[0] +
          'x' +
          move.to +
          '=' +
          promotion.toUpperCase() +
          (checked ? '+' : ''),
      );
      roundtrip(after);
      const castle = action(fixture.remainingCastle, false, reverse);
      const legal = ok(
        e.getLegalActions(after, after.initial.players[after.turn]),
      );
      assert.equal(
        legal.some(
          (candidate) =>
            candidate.type === 'move' && e.uci(candidate) === e.uci(castle),
        ),
        !checked,
      );
      const forged = JSON.parse(JSON.stringify(after));
      const fields = forged.fen.split(' ');
      fields[2] = reverse ? 'KQ' : 'kq';
      forged.fen = fields.join(' ');
      assert.equal(e.restoreState(forged).ok, false);
      if (checked) rejected(after, castle, 'ILLEGAL_MOVE');
      else {
        const castled = apply(after, castle),
          final = castled.state,
          board = e.parseFen(final.fen).board;
        assert.equal(board[squareIndex(castle.to)], reverse ? 'K' : 'k');
        assert.equal(
          board[squareIndex(square(fixture.rookArrival, false, reverse))],
          reverse ? 'R' : 'r',
        );
        assert.equal(final.fen.split(' ')[2], '-');
        assert.equal(final.fen.split(' ')[4], '1');
        assert.equal(final.ply, 2);
        assert.equal(castled.events[0].san, 'O-O-O');
        roundtrip(final);
      }
    });
  }

for (const reverse of [false, true])
  test(`an incorrect intended promotion claim binds its exact promotion without consuming rights; reverse=${reverse}`, () => {
    const fixture = fixtures.promotionCapturesOriginalRook,
      root = setup(transformed(fixture.fen, false, reverse));
    const intendedMove = spec(fixture.capture + 'n', false, reverse),
      otherChoice = spec(fixture.capture + 'q', false, reverse);
    const actor = root.initial.players[root.turn],
      opponent =
        root.initial.players[root.turn === 'white' ? 'black' : 'white'];
    const claimed = apply(root, {
      type: 'claim-draw',
      reason: 'fifty-move',
      intendedMove,
    }).state;
    assert.equal(claimed.phase, 'playing');
    assert.equal(claimed.fen, root.fen);
    assert.equal(claimed.ply, 0);
    assert.deepEqual(claimed.positionHistory, root.positionHistory);
    assert.deepEqual(claimed.forcedMove, intendedMove);
    rejected(claimed, { type: 'move', ...otherChoice }, 'FORCED_MOVE');
    rejected(
      claimed,
      { type: 'claim-draw', reason: 'fifty-move', intendedMove: otherChoice },
      'FORCED_MOVE',
    );
    assert.deepEqual(
      ok(e.getLegalActions(claimed, actor)).filter(
        (move) => move.type === 'move',
      ),
      [{ type: 'move', ...intendedMove }],
    );
    roundtrip(claimed);
    const declined = apply(claimed, { type: 'decline-draw' }, opponent).state;
    assert.equal(declined.fen, root.fen);
    assert.deepEqual(declined.forcedMove, intendedMove);
    assert.equal(declined.drawOffer, null);
    assert.equal(declined.revision, 2);
    assert.equal(declined.ply, 0);
    roundtrip(declined);
    const captured = apply(declined, { type: 'move', ...intendedMove }).state;
    assert.equal(captured.forcedMove, null);
    assert.equal(captured.revision, 3);
    assert.equal(captured.ply, 1);
    assert.equal(captured.fen.split(' ')[2], reverse ? 'Q' : 'q');
    assert.equal(captured.fen.split(' ')[4], '0');
    assert.equal(
      e.parseFen(captured.fen).board[squareIndex(intendedMove.to)],
      reverse ? 'n' : 'N',
    );
    roundtrip(captured);
  });
