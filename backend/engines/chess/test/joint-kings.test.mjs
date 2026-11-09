import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Chess } from 'chess.js';
import {
  engine as e,
  assert,
  ok,
  players,
  setup,
  move,
  play,
  rejected,
} from './helpers.mjs';

const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
const fixture = JSON.parse(
  readFileSync(
    new URL('./standard-dead-proofgame.json', import.meta.url),
    'utf8',
  ),
);
const swap = (piece) =>
  piece === piece.toUpperCase() ? piece.toLowerCase() : piece.toUpperCase();
function transform(fen, mirror, reverse) {
  const p = e.parseFen(fen),
    board = Array(64).fill(null);
  for (let sq = 0; sq < 64; sq++)
    if (p.board[sq]) {
      let target = mirror ? Math.floor(sq / 8) * 8 + 7 - (sq % 8) : sq;
      if (reverse) target = 63 - target;
      board[target] = reverse ? swap(p.board[sq]) : p.board[sq];
    }
  return e.toFen({
    ...p,
    board,
    turn: reverse ? (p.turn === 'white' ? 'black' : 'white') : p.turn,
  });
}

for (const mirror of [false, true])
  for (const reverse of [false, true]) {
    test(`terminal king-corridor proof is structural, mirrored=${mirror}, colours reversed=${reverse}`, () => {
      const fen = transform(fixture.fen, mirror, reverse),
        certificate = e.analyzeKingCorridor(fen);
      assert.equal(certificate.kind, 'terminal-king-corridor');
      assert.equal(certificate.states, 30);
      assert.equal(certificate.terminalFrontier.length, 4);
      assert.equal(
        certificate.terminalFrontier.filter((edge) => edge.capture).length,
        2,
      );
      assert.deepEqual(cjs.analyzeKingCorridor(fen), certificate);
      const state = setup(fen);
      assert.equal(state.phase, 'ended');
      assert.equal(state.ply, 0);
      assert.equal(state.roundOutcome.reason, 'dead-position-proven');
      const proof = e.solveMateReachability(fen, { maxExpanded: 0 });
      assert.equal(proof.status, 'dead');
      assert.equal(proof.evidence.nodes[0].leaf, 'king-corridor');
      assert.deepEqual(
        e.verifyReachabilityEvidence(fen, proof.evidence, { maxExpanded: 0 }),
        { valid: true },
      );
      assert.deepEqual(ok(e.restoreState(JSON.stringify(state))), state);
      rejected(state, { type: 'offer-draw' }, 'GAME_ENDED');
    });
  }

test('bishop shuffles and removal do not change the corridor proof', () => {
  for (const update of [
    (p) => {
      p.board[37] = null;
      p.board[19] = 'B';
    },
    (p) => {
      p.board[21] = null;
    },
  ]) {
    const p = e.parseFen(fixture.fen);
    update(p);
    const fen = e.toFen(p),
      result = e.analyzeKingCorridor(fen);
    assert.equal(result.states, 30);
    assert.equal(setup(fen).phase, 'ended');
  }
});

test('an in-class legal bishop mate is never pruned as a bishop-wait stalemate', () => {
  const fen = 'k1B5/p1K5/P7/8/8/8/8/8 w - - 0 1';
  for (const mirror of [false, true])
    for (const reverse of [false, true]) {
      const transformed = transform(fen, mirror, reverse),
        oracle = new Chess(transformed);
      const originalFrom = 58,
        originalTo = 49;
      const square = (sq) => {
        let target = mirror ? Math.floor(sq / 8) * 8 + 7 - (sq % 8) : sq;
        if (reverse) target = 63 - target;
        return 'abcdefgh'[target % 8] + (Math.floor(target / 8) + 1);
      };
      const action = move(square(originalFrom), square(originalTo));
      assert.equal(e.analyzeKingCorridor(transformed), null);
      const state = setup(transformed);
      assert.equal(state.phase, 'playing');
      oracle.move(action);
      assert.equal(oracle.isCheckmate(), true);
      const finished = play(state, action);
      assert.equal(finished.roundOutcome.reason, 'checkmate');
      assert.equal(e.analyzeKingCorridor(finished.fen), null);
      assert.equal(
        e.validateMateWitness(transformed, state.turn, [
          { from: action.from, to: action.to },
        ]).length,
        1,
      );
    }
});

test('a vacated diagonal king origin can discover mate and cannot be a terminal stalemate leaf', () => {
  const fen = 'k7/p7/P1K5/3B4/8/8/8/8 w - - 0 1';
  for (const mirror of [false, true])
    for (const reverse of [false, true]) {
      const transformed = transform(fen, mirror, reverse),
        oracle = new Chess(transformed);
      const square = (sq) => {
        let target = mirror ? Math.floor(sq / 8) * 8 + 7 - (sq % 8) : sq;
        if (reverse) target = 63 - target;
        return 'abcdefgh'[target % 8] + (Math.floor(target / 8) + 1);
      };
      const action = move(square(42), square(50));
      assert.equal(e.analyzeKingCorridor(transformed), null);
      const state = setup(transformed);
      assert.equal(state.phase, 'playing');
      oracle.move(action);
      assert.equal(oracle.isCheckmate(), true);
      assert.equal(play(state, action).roundOutcome.reason, 'checkmate');
      assert.equal(
        e.validateMateWitness(transformed, state.turn, [
          { from: action.from, to: action.to },
        ]).length,
        1,
      );
    }
});

test('opening a fixed wall or mixing mobile bishop colours declines this theorem', () => {
  for (const update of [
    (p) => {
      p.board[52] = null;
    },
    (p) => {
      p.board[37] = null;
      p.board[36] = 'B';
    },
  ]) {
    const p = e.parseFen(fixture.fen);
    update(p);
    assert.equal(e.analyzeKingCorridor(e.toFen(p)), null);
  }
});

test('the published standard-start proof game ends at the first dead move, not after its construction continuation', () => {
  const oracle = new Chess();
  oracle.loadPgn(fixture.pgn);
  const history = oracle.history({ verbose: true }),
    running = new Chess();
  let state = ok(e.createGame({ players }));
  for (let index = 0; index < 109; index++) {
    const m = history[index];
    assert.equal(state.phase, 'playing');
    const action = {
      type: 'move',
      from: m.from,
      to: m.to,
      ...(m.promotion ? { promotion: m.promotion } : {}),
    };
    running.move(m);
    state = play(state, action);
    assert.equal(
      e.positionKey(e.parseFen(state.fen)),
      running.fen().split(' ').slice(0, 4).join(' '),
    );
    assert.equal(
      ok(e.getObservation(state, players.white)).moves.at(-1).san,
      m.san,
    );
  }
  assert.equal(history[108].san, 'Bcxe2');
  assert.equal(state.phase, 'ended');
  assert.equal(state.ply, 109);
  assert.equal(state.roundOutcome.reason, 'dead-position-proven');
  assert.equal(state.roundOutcome.winner, null);
  assert.equal(state.history.length, 109);
  const continuation = history[109];
  rejected(state, move(continuation.from, continuation.to), 'GAME_ENDED');
  for (const engine of [e, cjs]) {
    assert.deepEqual(ok(engine.restoreState(JSON.stringify(state))), state);
    assert.deepEqual(ok(engine.replay(state.initial, state.history)), state);
  }
});

test('authentic 0.2.0 snapshots retain old bindings and cannot be relabelled across the new immediate ending', () => {
  for (const name of ['king-corridor-root', 'standard']) {
    const original = readFileSync(
        new URL(`./legacy/v0.2.0-${name}.json`, import.meta.url),
        'utf8',
      ),
      snapshot = JSON.parse(original);
    assert.equal(snapshot.engineVersion, '0.2.0');
    assert.equal(snapshot.phase, 'playing');
    for (const engine of [e, cjs])
      assert.equal(
        engine.restoreState(original).error.code,
        'UNSUPPORTED_VERSION',
      );
    if (name === 'king-corridor-root') {
      snapshot.engineVersion = e.ENGINE_VERSION;
      snapshot.rulesVersion = e.RULES_VERSION;
      assert.equal(e.restoreState(snapshot).error.code, 'INVALID_STATE');
    }
    assert.equal(JSON.parse(original).engineVersion, '0.2.0');
  }
});

test('an independent chess.js movement graph closes the same wall with one surviving mobile bishop', () => {
  const p = e.parseFen(fixture.fen);
  for (let sq = 0; sq < 64; sq++)
    if (p.board[sq] === 'B' && sq !== 53) p.board[sq] = null;
  const fen = e.toFen(p);
  assert.equal(e.analyzeKingCorridor(fen).kind, 'terminal-king-corridor');
  const identity = (value) => value.split(' ').slice(0, 4).join(' ');
  const root = identity(fen),
    queue = [root],
    seen = new Set([root]);
  let edges = 0,
    stalemates = 0;
  for (let index = 0; index < queue.length; index++) {
    assert.ok(
      queue.length < 10000,
      'independent graph must remain within its test resource scope',
    );
    const chess = new Chess(queue[index] + ' 0 1');
    assert.equal(
      chess.isCheckmate(),
      false,
      'no concrete reachable vertex is mate',
    );
    if (chess.isStalemate()) {
      stalemates++;
      continue;
    }
    for (const action of chess.moves({ verbose: true })) {
      chess.move(action);
      edges++;
      const next = identity(chess.fen());
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
      chess.undo();
    }
  }
  assert.ok(seen.size > 30);
  assert.ok(edges > seen.size);
  assert.ok(stalemates > 0);
});
