import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  engine as e,
  assert,
  ok,
  setup,
  move,
  play,
  rejected,
  players,
} from './helpers.mjs';
import { advance, legalBoardMoves, inCheck } from '../dist/esm/position.js';
const fixtures = JSON.parse(
  readFileSync(
    new URL('./dead-position-fixtures.json', import.meta.url),
    'utf8',
  ),
);
const cage = fixtures.dead.find((f) => f.id === 'immobile-rook-knight-cage');
const predecessor = '6bk/8/8/8/p1ppp1p1/P1P1P1P1/P2P4/RN5K b - - 0 1';
const spec = (x) => ({
  from: x.slice(0, 2),
  to: x.slice(2, 4),
  ...(x[4] ? { promotion: x[4] } : {}),
});

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
      (mirror ? 7 - (s.charCodeAt(0) - 97) : s.charCodeAt(0) - 97) + 97,
    ) + (reverse ? 9 - Number(s[1]) : s[1]);
  return {
    from: sq(coordinate.slice(0, 2)),
    to: sq(coordinate.slice(2, 4)),
    ...(coordinate[4] ? { promotion: coordinate[4] } : {}),
  };
}

for (const mirror of [false, true])
  for (const reverse of [false, true]) {
    test(`the pawn move closing the piece cage ends immediately; mirror=${mirror}, reverse=${reverse}`, () => {
      const before = setup(transformFen(predecessor, mirror, reverse));
      assert.equal(before.phase, 'playing');
      assert.equal(e.analyzeLockedPosition(before.fen), null);
      const frozen = JSON.stringify(before),
        action = { type: 'move', ...transformMove('d4d3', mirror, reverse) };
      const result = e.applyAction(
          before,
          before.initial.players[before.turn],
          action,
          before.revision,
        ),
        ended = ok(result);
      assert.equal(JSON.stringify(before), frozen);
      assert.equal(ended.phase, 'ended');
      assert.equal(ended.roundOutcome.reason, 'dead-position-proven');
      assert.equal(ended.roundOutcome.ply, 1);
      assert.equal(ended.revision, 1);
      assert.equal(ended.ply, 1);
      assert.equal(
        ended.fen.split(' ').slice(0, 4).join(' '),
        transformFen(cage.fen, mirror, reverse)
          .split(' ')
          .slice(0, 4)
          .join(' '),
      );
      assert.deepEqual(
        result.events.map((x) => x.type),
        ['move-played', 'round-ended', 'match-ended'],
      );
      assert.deepEqual(ended.history, [
        {
          kind: 'player',
          playerId: before.initial.players[before.turn],
          action,
        },
      ]);
      assert.equal(ended.positionHistory.length, 2);
      assert.equal(ended.roundOutcome.winner, null);
      assert.equal(ended.matchOutcome.winner, null);
      assert.deepEqual(
        ended.matchOutcome.scores.map((x) => x.points),
        [0.5, 0.5],
      );
      assert.deepEqual(ok(e.restoreState(ok(e.serializeState(ended)))), ended);
      assert.deepEqual(ok(e.replay(ended.initial, ended.history)), ended);
      for (const viewer of [players.white, players.black, null]) {
        const observation = ok(e.getObservation(ended, viewer));
        assert.equal(observation.phase, 'ended');
        assert.deepEqual(observation.legalActions, []);
        assert.equal(observation.roundOutcome.reason, 'dead-position-proven');
        for (const strategy of ['first-legal', 'capture', 'random']) {
          assert.equal(
            e.chooseBotAction(observation, { strategy, randomState: 42 }).error
              .code,
            'GAME_ENDED',
          );
        }
      }
      for (const actor of [players.white, players.black])
        for (const a of [
          action,
          { type: 'resign' },
          { type: 'offer-draw' },
          { type: 'claim-draw', reason: 'fifty-move' },
        ])
          rejected(ended, a, 'GAME_ENDED', actor);
    });

    test(`a missing blocker permits sacrifice, promotion and actual mate; mirror=${mirror}, reverse=${reverse}`, () => {
      const f = fixtures.liveCageSacrifice,
        fen = transformFen(f.fen, mirror, reverse);
      const witness = f.witness.map((m) => transformMove(m, mirror, reverse)),
        winner = reverse ? 'white' : 'black';
      assert.equal(e.analyzeLockedPosition(fen), null);
      assert.deepEqual(e.validateMateWitness(fen, winner, witness), witness);
      let state = setup(fen);
      for (let i = 0; i < witness.length; i++) {
        assert.equal(
          state.phase,
          'playing',
          `false automatic ending at witness prefix ${i}`,
        );
        assert.equal(
          e.analyzeLockedPosition(state.fen),
          null,
          `false certificate at prefix ${i}`,
        );
        assert.notEqual(e.analyzeDeadPosition(state.fen, 1).status, 'dead');
        state = play(state, { type: 'move', ...witness[i] });
      }
      assert.equal(state.roundOutcome.reason, 'checkmate');
      assert.equal(state.roundOutcome.winner, winner);
      assert.deepEqual(ok(e.restoreState(JSON.stringify(state))), state);
    });
  }

test('stationary bishops and mutually dependent queen/knight/bishops are blockers too', () => {
  const bishop = e.analyzeLockedPosition(
    fixtures.dead.find((f) => f.id === 'immobile-rook-bishop-cage').fen,
  );
  assert.deepEqual(
    bishop.blockers.filter((x) => x.piece !== 'P' && x.piece !== 'p'),
    [
      { piece: 'R', square: 'a1' },
      { piece: 'B', square: 'b1' },
    ],
  );
  const mutual = e.analyzeLockedPosition(
    fixtures.dead.find((f) => f.id === 'mutually-blocked-queen-knight-bishops')
      .fen,
  );
  assert.deepEqual(
    mutual.blockers.filter((x) => x.piece !== 'P' && x.piece !== 'p'),
    [
      { piece: 'Q', square: 'a1' },
      { piece: 'N', square: 'b1' },
      { piece: 'B', square: 'c1' },
      { piece: 'B', square: 'b2' },
    ],
  );
  for (const certificate of [bishop, mutual]) {
    assert.equal(
      certificate.blockers.some((x) => x.piece.toLowerCase() === 'k'),
      false,
    );
    for (const blocker of certificate.blockers)
      assert.equal(
        certificate.regions.some((r) => r.from === blocker.square),
        false,
      );
  }
});

for (const [id, fen] of [
  [
    'enemy bishop can capture a supposed wall pawn',
    '5b1k/8/8/8/p1p1p1p1/P1PpP1P1/P2P4/RN5K w - - 0 1',
  ],
  [
    'enemy knight can capture candidate blockers',
    '7k/8/8/8/p1p1p1p1/P1PpP1P1/P1nP4/RN5K w - - 0 1',
  ],
  [
    'a geometric escape for the caged knight',
    '6bk/8/8/8/p1p1p1p1/P2pP1P1/P2P4/RN5K w - - 0 1',
  ],
  ['a pawn can leave its supporting square', predecessor],
])
  test(`do not retain merely current blockers: ${id}`, () => {
    // null/unknown are deliberately NOT asserted to prove mating possibility.
    assert.equal(e.analyzeLockedPosition(fen), null);
    assert.notEqual(e.analyzeDeadPosition(fen, 1).status, 'dead');
  });

test('fixed blockers stay unchanged and mobile regions contain every step of sampled exact continuations', () => {
  for (const f of fixtures.dead.filter((f) =>
    f.certificate.startsWith('permanent-blocker-'),
  )) {
    const certificate = e.analyzeLockedPosition(f.fen);
    let p = e.parseFen(f.fen),
      seed = 17;
    for (let i = 0; i < 400; i++) {
      for (const blocker of certificate.blockers) {
        const sq =
          (Number(blocker.square[1]) - 1) * 8 +
          blocker.square.charCodeAt(0) -
          97;
        assert.equal(p.board[sq], blocker.piece);
      }
      // These fixtures have one mobile piece per symbol, making identity exact.
      for (const region of certificate.regions) {
        const at = p.board.indexOf(region.piece);
        if (at < 0) continue; // captured pieces need no future region
        const square = String.fromCharCode(97 + (at % 8)) + (1 + (at >> 3));
        assert.ok(region.reachable.includes(square));
      }
      const moves = legalBoardMoves(p);
      assert.equal(moves.length === 0 && inCheck(p), false);
      if (!moves.length) break;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      p = advance(p, moves[seed % moves.length]);
    }
  }
  // Movement-rule continuations only: the engine itself has already ended these games.
});

test('full blocker diagnostics are untrusted, detached data, not player authority', () => {
  const certificate = e.analyzeLockedPosition(cage.fen);
  certificate.blockers.length = 0;
  certificate.regions.length = 0;
  assert.equal(setup(cage.fen).roundOutcome.reason, 'dead-position-proven');
  assert.ok(e.analyzeLockedPosition(cage.fen).blockers.length > 0);
  rejected(
    ok(e.createGame({ players })),
    { type: 'dead-position', certificate },
    'INVALID_ACTION',
  );
});

test('cold processes and both compiled module formats agree on creation and replay', () => {
  const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
  for (const f of fixtures.dead.filter((f) =>
    f.certificate.startsWith('permanent-blocker-'),
  )) {
    const a = e.createAnalysisGame({ players, fen: f.fen }),
      b = cjs.createAnalysisGame({ players, fen: f.fen });
    assert.deepEqual(a, b);
    assert.equal(a.state.engineVersion, '0.3.0');
    assert.deepEqual(
      cjs.restoreState(JSON.stringify(a.state)).value,
      e.restoreState(JSON.stringify(a.state)).value,
    );
  }
  const moduleUrl = new URL('../dist/esm/index.js', import.meta.url).href;
  const code = `import * as e from ${JSON.stringify(moduleUrl)}; const r=e.createAnalysisGame(${JSON.stringify({ players, fen: cage.fen })}); console.log(JSON.stringify(r));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    JSON.parse(run.stdout),
    e.createAnalysisGame({ players, fen: cage.fen }),
  );
});

for (const name of [
  'v0.1.1-cage-root',
  'v0.1.1-cage-after-move',
  'v0.1.1-standard-root',
])
  test(`actual historical snapshots require their original engine: ${name}`, () => {
    const snapshot = JSON.parse(
      readFileSync(new URL(`./legacy/${name}.json`, import.meta.url), 'utf8'),
    );
    const original = JSON.stringify(snapshot);
    assert.equal(snapshot.engineVersion, '0.1.1');
    assert.equal(e.restoreState(snapshot).error.code, 'UNSUPPORTED_VERSION');
    assert.equal(
      e.applyAction(snapshot, 'alice', move('e2', 'e4'), snapshot.revision)
        .error.code,
      'UNSUPPORTED_VERSION',
    );
    assert.equal(JSON.stringify(snapshot), original);
    if (name.includes('cage')) {
      snapshot.engineVersion = e.ENGINE_VERSION;
      snapshot.rulesVersion = e.RULES_VERSION;
      assert.equal(
        e.restoreState(snapshot).ok,
        false,
        'relabelled snapshots are not migrations',
      );
      if (snapshot.history.length)
        assert.equal(e.replay(snapshot.initial, snapshot.history).ok, false);
    }
  });

test('the earlier inert castling right miss is now structurally proved while rights remain recorded', () => {
  const fen = '6bk/8/8/8/p1p1p1p1/P1PpP1P1/P2P4/RNB1K3 w Q - 0 1';
  const state = setup(fen),
    certificate = e.analyzeLockedPosition(fen);
  assert.deepEqual(certificate.castlingExclusions, [
    { right: 'Q', blockers: ['b1'], attackedKingPath: [] },
  ]);
  assert.equal(e.analyzeDeadPosition(fen, 1).status, 'dead');
  assert.equal(state.phase, 'ended');
  assert.equal(state.fen, fen);
  assert.equal(state.roundOutcome.reason, 'dead-position-proven');
  assert.equal(
    e.proveDeadPosition(state, 1, state.revision).error.code,
    'GAME_ENDED',
  );
  assert.equal(
    ok(e.getObservation(state, 'alice')).conformance
      .exhaustiveDeadPositionOracle,
    false,
  );
});
