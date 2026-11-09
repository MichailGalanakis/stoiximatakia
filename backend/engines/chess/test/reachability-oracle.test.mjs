/** Movement oracle is a development-only dependency, never a game outcome oracle. */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { engine as e, assert, ok, players } from './helpers.mjs';
import { legalBoardMoves, moveSpec } from '../dist/esm/position.js';

const key = (fen) => fen.split(' ').slice(0, 4).join(' ');
function closeWithOracle(fen) {
  const chess = new Chess(fen),
    queue = [key(chess.fen())],
    seen = new Set(queue);
  let edges = 0,
    stalemates = 0,
    castles = 0;
  for (let index = 0; index < queue.length; index++) {
    chess.load(queue[index] + ' 0 1');
    const moves = chess.moves({ verbose: true });
    if (!moves.length) {
      assert.equal(
        chess.isCheck(),
        false,
        `reachable checkmate: ${chess.fen()}`,
      );
      stalemates++;
    }
    assert.deepEqual(
      legalBoardMoves(e.parseFen(chess.fen()))
        .map((m) => e.uci(moveSpec(m)))
        .sort(),
      moves.map((m) => m.lan).sort(),
    );
    edges += moves.length;
    for (const move of moves) {
      if (move.flags.includes('k') || move.flags.includes('q')) castles++;
      const next = key(move.after);
      if (!seen.has(next)) {
        assert.ok(
          seen.size < 100_000,
          'independent graph guard reached, not proof of a draw',
        );
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return { positions: seen.size, edges, stalemates, castles };
}

test('new root closes with chess.js, preserving thirty real castling edges', () => {
  const fen = 'kb6/p1p5/P1P5/p7/8/7P/P1P1PPPN/RB2K1NR w KQ - 0 1';
  assert.deepEqual(closeWithOracle(fen), {
    positions: 1692,
    edges: 3557,
    stalemates: 1335,
    castles: 30,
  });
  assert.equal(
    ok(e.createAnalysisGame({ players, fen })).matchOutcome.kind,
    'draw',
  );
});

test('castling/tempo corpus and color reversals close independently and end automatically', () => {
  const fixtures = JSON.parse(
    readFileSync(
      new URL('./temporal-castling-fixtures.json', import.meta.url),
      'utf8',
    ),
  );
  for (const f of fixtures.dead) {
    assert.deepEqual(closeWithOracle(f.fen), {
      positions: f.expectedGraphNodes,
      edges: f.expectedGraphEdges,
      stalemates: f.expectedStalemates,
      castles: f.expectedCastlingEdges,
    });
    const p = e.parseFen(f.fen),
      board = p.board.map((x) =>
        x === null
          ? null
          : x === x.toUpperCase()
            ? x.toLowerCase()
            : x.toUpperCase(),
      );
    const transformed = Array(64).fill(null);
    for (let sq = 0; sq < 64; sq++)
      transformed[(7 - (sq >> 3)) * 8 + (sq % 8)] = board[sq];
    const rights = [...p.castling]
      .map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))
      .join('');
    const reverse = e.toFen({
      ...p,
      board: transformed,
      turn: p.turn === 'white' ? 'black' : 'white',
      castling: rights,
    });
    assert.deepEqual(closeWithOracle(reverse), closeWithOracle(f.fen));
    for (const fen of [f.fen, reverse]) {
      const state = ok(e.createAnalysisGame({ players, fen }));
      assert.equal(state.matchOutcome?.kind, 'draw');
      assert.deepEqual(ok(e.restoreState(JSON.stringify(state))), state);
    }
  }
});

test('broader dead family combines both rights and different pawn obstructions', () => {
  for (const rights of ['KQ', 'Q', 'K', '-']) {
    for (const pawns of ['P1P1PPPN', 'P1P1P1PN', 'P1P2PPN']) {
      const fen = `kb6/p1p5/P1P5/p7/8/7P/${pawns}/RB2K1NR w ${rights} - 0 1`;
      closeWithOracle(fen);
      assert.equal(
        ok(e.createAnalysisGame({ players, fen })).matchOutcome?.kind,
        'draw',
        fen,
      );
    }
  }
});

test('real castling, sacrifice, underpromotion and en-passant witnesses still reach mate', () => {
  const fixtures = JSON.parse(
    readFileSync(
      new URL('./temporal-castling-fixtures.json', import.meta.url),
      'utf8',
    ),
  );
  const extra = {
    id: 'knight-sacrifice-and-bishop-underpromotion',
    fen: 'kb6/p1p5/P1P5/p7/7N/8/P1P1P1PP/RB2KBNR w KQ - 0 1',
    winner: 'white',
    witness: 'h4f5 a5a4 f5d6 c7d6 c6c7 d6d5 c7c8b d5d4 c8b7'.split(' '),
  };
  for (const f of [...fixtures.live, extra]) {
    const chess = new Chess(f.fen);
    let state = ok(e.createAnalysisGame({ players, fen: f.fen }));
    for (const coordinate of f.witness) {
      assert.equal(state.phase, 'playing', `false draw in ${f.id}`);
      const move = {
        from: coordinate.slice(0, 2),
        to: coordinate.slice(2, 4),
        ...(coordinate[4] ? { promotion: coordinate[4] } : {}),
      };
      chess.move(move);
      state = ok(
        e.applyAction(
          state,
          players[state.turn],
          { type: 'move', ...move },
          state.revision,
        ),
      );
      assert.equal(
        e.positionKey(e.parseFen(chess.fen())),
        e.positionKey(e.parseFen(state.fen)),
      );
    }
    assert.equal(chess.isCheckmate(), true);
    assert.equal(state.matchOutcome.winner, f.winner);
    assert.deepEqual(ok(e.restoreState(JSON.stringify(state))), state);
    assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
  }
});
