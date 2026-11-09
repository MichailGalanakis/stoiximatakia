import { test } from 'node:test';
import {
  engine as e,
  assert,
  ok,
  setup,
  start,
  move,
  play,
  sequence,
  rejected,
  hasMove,
  players,
} from './helpers.mjs';

function roundtrip(state) {
  assert.deepEqual(ok(e.restoreState(ok(e.serializeState(state)))), state);
  assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
  assert.equal(e.validateState(state).valid, true);
  for (const viewer of [players.white, players.black, null]) {
    const observation = ok(e.getObservation(state, viewer));
    assert.equal(observation.fen, state.fen);
    assert.deepEqual(observation.roundOutcome, state.roundOutcome);
  }
}

// These transformations preserve pawn direction by reversing both ranks and
// colors together. The fixtures below have no castling rights to transform.
function transform(fen, coordinate, mirror, reverse) {
  const p = e.parseFen(fen),
    board = Array(64).fill(null);
  const square = (sq) =>
    (reverse ? 7 - (sq >> 3) : sq >> 3) * 8 + (mirror ? 7 - (sq % 8) : sq % 8);
  for (let sq = 0; sq < 64; sq++)
    if (p.board[sq]) {
      const piece = p.board[sq];
      board[square(sq)] = reverse
        ? piece === piece.toUpperCase()
          ? piece.toLowerCase()
          : piece.toUpperCase()
        : piece;
    }
  const name = (s) =>
    String.fromCharCode(
      97 + (mirror ? 7 - (s.charCodeAt(0) - 97) : s.charCodeAt(0) - 97),
    ) + (reverse ? 9 - Number(s[1]) : s[1]);
  return {
    fen: e.toFen({
      ...p,
      board,
      turn: reverse ? (p.turn === 'white' ? 'black' : 'white') : p.turn,
      ep: p.ep === null ? null : square(p.ep),
    }),
    spec: {
      from: name(coordinate.slice(0, 2)),
      to: name(coordinate.slice(2, 4)),
      ...(coordinate[4] ? { promotion: coordinate[4] } : {}),
    },
  };
}

for (const mirror of [false, true])
  for (const reverse of [false, true]) {
    test(`legal en passant can discover immediate mate; mirror=${mirror}, reverse=${reverse}`, () => {
      const { fen, spec } = transform(
        '8/7K/8/R4Ppk/7p/5P2/8/8 w - g6 0 1',
        'f5g6',
        mirror,
        reverse,
      );
      const winner = reverse ? 'black' : 'white',
        state = setup(fen);
      assert.equal(state.phase, 'playing');
      assert.equal(e.analyzeLockedPosition(fen), null);
      assert.notEqual(e.analyzeDeadPosition(fen, 1).status, 'dead');
      assert.ok(hasMove(state, e.uci(spec)));
      const withoutEp = fen.split(' ');
      withoutEp[3] = '-';
      assert.notEqual(
        e.positionKey(e.parseFen(fen)),
        e.positionKey(e.parseFen(withoutEp.join(' '))),
      );
      assert.deepEqual(e.validateMateWitness(fen, winner, [spec]), [spec]);
      roundtrip(state);

      const result = e.applyAction(
        state,
        state.initial.players[state.turn],
        { type: 'move', ...spec, offerDraw: true },
        state.revision,
      );
      const ended = ok(result);
      assert.equal(ended.roundOutcome.reason, 'checkmate');
      assert.equal(ended.roundOutcome.winner, winner);
      assert.equal(ended.roundOutcome.ply, 1);
      assert.equal(ended.fen.split(' ')[3], '-');
      assert.equal(ended.fen.split(' ')[4], '0');
      assert.equal(ended.drawOffer, null);
      assert.deepEqual(
        result.events.map((event) => event.type),
        ['move-played', 'round-ended', 'match-ended'],
      );
      assert.equal(result.events[0].san.endsWith('#'), true);
      assert.deepEqual(
        ended.matchOutcome.scores.map((score) => score.points),
        reverse ? [0, 1] : [1, 0],
      );
      roundtrip(ended);
      rejected(ended, { type: 'offer-draw' }, 'GAME_ENDED');
    });
  }

for (const reverse of [false, true])
  for (const [promotion, reason] of [
    ['q', 'stalemate'],
    ['r', null],
    ['b', 'dead-position-material'],
    ['n', 'dead-position-material'],
  ])
    test(`promotion=${promotion} determines the outcome and resets the 75-move counter; reverse=${reverse}`, () => {
      const { fen, spec } = transform(
        '8/k1P5/2K5/8/8/8/8/8 w - - 149 80',
        `c7c8${promotion}`,
        false,
        reverse,
      );
      const state = setup(fen);
      assert.equal(state.phase, 'playing');
      rejected(state, move(spec.from, spec.to), 'PROMOTION_REQUIRED');
      const result = e.applyAction(
        state,
        state.initial.players[state.turn],
        { type: 'move', ...spec },
        state.revision,
      );
      const next = ok(result);
      assert.equal(next.fen.split(' ')[4], '0');
      assert.equal(next.phase, reason === null ? 'playing' : 'ended');
      assert.equal(next.roundOutcome?.reason ?? null, reason);
      assert.deepEqual(
        result.events.map((event) => event.type),
        reason === null
          ? ['move-played']
          : ['move-played', 'round-ended', 'match-ended'],
      );
      if (reason !== null) {
        assert.equal(next.roundOutcome.kind, 'draw');
        assert.deepEqual(
          next.matchOutcome.scores.map((score) => score.points),
          [0.5, 0.5],
        );
      }
      roundtrip(next);
    });

test('a standard-start en-passant opportunity survives failed commands and restoration until a move is accepted', () => {
  const state = sequence(start(), ['e2e4', 'a7a6', 'e4e5', 'd7d5']);
  assert.equal(state.initial.mode, 'standard');
  assert.equal(state.fen.split(' ')[3], 'd6');
  assert.ok(hasMove(state, 'e5d6'));
  rejected(
    state,
    move('e5', 'd6'),
    'STALE_REVISION',
    'alice',
    state.revision - 1,
  );
  rejected(state, move('e5', 'd6'), 'NOT_YOUR_TURN', 'bob');
  rejected(state, move('e5', 'd7'), 'ILLEGAL_MOVE');
  roundtrip(state);
  const restored = ok(e.restoreState(ok(e.serializeState(state))));
  const next = play(restored, move('e5', 'd6'));
  assert.equal(
    next.fen,
    'rnbqkbnr/1pp1pppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3',
  );
  assert.equal(
    next.positionHistory.at(-1),
    e.positionKey(e.parseFen(next.fen)),
  );
  roundtrip(next);
});

test('declining a standard-start en-passant capture removes it from subsequent replayed turns', () => {
  const before = sequence(start(), ['e2e4', 'a7a6', 'e4e5', 'd7d5']);
  const declined = sequence(before, ['g1f3', 'a6a5']);
  assert.equal(declined.fen.split(' ')[3], '-');
  assert.equal(hasMove(declined, 'e5d6'), false);
  rejected(declined, move('e5', 'd6'), 'ILLEGAL_MOVE');
  roundtrip(declined);
});

test('an incorrect intended-move claim keeps en passant available and binding through offer rejection and replay', () => {
  const initial = sequence(start(), ['e2e4', 'a7a6', 'e4e5', 'd7d5']);
  const claimed = play(initial, {
    type: 'claim-draw',
    reason: 'threefold-repetition',
    intendedMove: { from: 'e5', to: 'd6' },
  });
  assert.equal(claimed.fen, initial.fen);
  assert.equal(claimed.ply, initial.ply);
  assert.deepEqual(claimed.forcedMove, { from: 'e5', to: 'd6' });
  assert.equal(claimed.drawOffer.by, 'white');
  rejected(claimed, move('g1', 'f3'), 'FORCED_MOVE');
  roundtrip(claimed);
  const declined = play(claimed, { type: 'decline-draw' }, 'bob');
  assert.equal(declined.fen.split(' ')[3], 'd6');
  assert.deepEqual(declined.forcedMove, claimed.forcedMove);
  roundtrip(declined);
  const captured = play(
    ok(e.restoreState(ok(e.serializeState(declined)))),
    move('e5', 'd6'),
  );
  assert.equal(captured.forcedMove, null);
  assert.equal(captured.fen.split(' ')[3], '-');
  assert.equal(captured.ply, initial.ply + 1);
  roundtrip(captured);
});

test('castling on the 150th halfmove removes rights and ends by the automatic 75-move rule', () => {
  const state = setup('4k3/8/8/8/8/8/8/R3K3 w Q - 149 80');
  assert.equal(state.phase, 'playing');
  assert.ok(hasMove(state, 'e1c1'));
  const result = e.applyAction(
    state,
    'alice',
    { type: 'move', from: 'e1', to: 'c1', offerDraw: true },
    state.revision,
  );
  const ended = ok(result);
  assert.equal(ended.fen, '4k3/8/8/8/8/8/8/2KR4 b - - 150 80');
  assert.equal(ended.roundOutcome.reason, 'seventy-five-move');
  assert.equal(ended.roundOutcome.winner, null);
  assert.equal(ended.drawOffer, null);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ['move-played', 'round-ended', 'match-ended'],
  );
  assert.equal(result.events[0].san, 'O-O-O');
  roundtrip(ended);
});

test('Black counter overflow rejects atomically without losing a pending offer or changing the outcome', () => {
  const initial = setup('4k3/8/8/8/8/8/8/R3K3 b - - 0 1000000');
  const state = play(initial, { type: 'offer-draw' }, 'alice');
  const result = rejected(state, move('e8', 'd8'), 'RESOURCE_LIMIT');
  assert.equal('state' in result, false);
  assert.equal('events' in result, false);
  assert.equal(state.phase, 'playing');
  assert.equal(state.roundOutcome, null);
  assert.equal(state.drawOffer.by, 'white');
  assert.equal(state.history.length, 1);
  assert.equal(state.ply, 0);
  roundtrip(state);
});

test('White may move at the maximum fullmove number while the resulting state stays observable and replayable', () => {
  const state = setup('4k3/8/8/8/8/8/8/R3K3 w - - 0 1000000');
  const next = play(state, move('a1', 'a2'));
  assert.equal(next.fen.split(' ')[5], '1000000');
  assert.equal(next.ply, 1);
  roundtrip(next);
  rejected(next, move('e8', 'd8'), 'RESOURCE_LIMIT');
});

test('Black can reach the counter limit and White can continue, but the next overflowing Black move cannot commit', () => {
  const initial = setup('4k3/8/8/8/8/8/8/R3K3 b - - 0 999999');
  const afterBlack = play(initial, move('e8', 'd8'));
  assert.equal(afterBlack.fen.split(' ')[5], '1000000');
  roundtrip(afterBlack);
  const afterWhite = play(afterBlack, move('a1', 'a2'));
  assert.equal(afterWhite.fen.split(' ')[5], '1000000');
  roundtrip(afterWhite);
  rejected(afterWhite, move('d8', 'c8'), 'RESOURCE_LIMIT');
});

test('checkmate at the last representable Black move beats 75 moves; overflow remains a resource error, not a chess result', () => {
  const fen = '8/8/8/8/8/6k1/5q2/7K b - - 149 999999';
  const spec = { from: 'f2', to: 'g2' };
  const state = setup(fen),
    ended = play(state, { type: 'move', ...spec });
  assert.equal(ended.fen.split(' ')[4], '150');
  assert.equal(ended.fen.split(' ')[5], '1000000');
  assert.equal(ended.roundOutcome.reason, 'checkmate');
  assert.equal(ended.roundOutcome.winner, 'black');
  roundtrip(ended);

  const atLimitFen = fen.replace('999999', '1000000'),
    atLimit = setup(atLimitFen);
  rejected(atLimit, { type: 'move', ...spec }, 'RESOURCE_LIMIT');
  assert.equal(atLimit.phase, 'playing');
  assert.equal(atLimit.roundOutcome, null);
  // Resource bounds constrain committed snapshots, not mathematical mating
  // possibility. A legal mate witness must retain its counter-independent meaning.
  assert.deepEqual(e.validateMateWitness(atLimitFen, 'black', [spec]), [spec]);
  assert.equal(
    e.analyzeMatePossibility(atLimitFen, 'black', 128).status,
    'possible',
  );
  roundtrip(atLimit);
});
