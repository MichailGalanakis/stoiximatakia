import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  engine as e,
  assert,
  ok,
  setup,
  move,
  play,
  sequence,
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
const spec = (x) => ({
  from: x.slice(0, 2),
  to: x.slice(2, 4),
  ...(x[4] ? { promotion: x[4] } : {}),
});

for (const fixture of fixtures.dead)
  test(`automatic dead-position regression: ${fixture.id}`, () => {
    const before = fixture.fen;
    const certificate = e.analyzeLockedPosition(fixture.fen);
    assert.equal(certificate?.kind, fixture.certificate);
    assert.deepEqual(e.analyzeDeadPosition(fixture.fen, 1), {
      status: 'dead',
      nodes: 1,
      witness: null,
    });
    const result = e.createAnalysisGame({ players, fen: fixture.fen }),
      state = ok(result);
    assert.equal(state.phase, 'ended');
    assert.equal(state.roundOutcome.reason, 'dead-position-proven');
    assert.equal(state.roundOutcome.kind, 'draw');
    assert.equal(state.matchOutcome.kind, 'draw');
    assert.equal(state.roundOutcome.winnerId, null);
    assert.equal(state.matchOutcome.winnerId, null);
    assert.deepEqual(
      state.roundOutcome.scores.map((x) => x.points),
      [0.5, 0.5],
    );
    assert.equal(state.revision, 0);
    assert.equal(state.ply, 0);
    assert.deepEqual(state.history, []);
    assert.deepEqual(
      result.events.map((x) => x.type),
      ['game-created', 'round-ended', 'match-ended'],
    );
    assert.equal(ok(e.isGameOver(state)), true);
    assert.equal(ok(e.isPlayStopped(state)), true);
    for (const actor of ['alice', 'bob']) {
      assert.deepEqual(ok(e.getLegalActions(state, actor)), []);
      rejected(state, { type: 'resign' }, 'GAME_ENDED', actor);
      const view = ok(e.getObservation(state, actor));
      assert.deepEqual(view.legalActions, []);
      assert.equal(e.chooseBotAction(view).error.code, 'GAME_ENDED');
    }
    assert.deepEqual(ok(e.restoreState(JSON.stringify(state))), state);
    assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
    assert.equal(fixture.fen, before);
  });

// Horizontal reflection, colour/rank reversal, and both preserve ordinary pawn
// motion. No rotation by 90 degrees or unsupported Chess960 semantics is assumed.
function transform(fen, mirror, reverse) {
  const p = e.parseFen(fen),
    board = Array(64).fill(null);
  for (let i = 0; i < 64; i++)
    if (p.board[i]) {
      const f = i % 8,
        r = Math.floor(i / 8),
        piece = p.board[i];
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
for (const mirror of [false, true])
  for (const reverse of [false, true]) {
    test(`wall certificates respect board/colour symmetry: mirror=${mirror}, reverse=${reverse}`, () => {
      for (const fixture of fixtures.dead) {
        const fen = transform(fixture.fen, mirror, reverse);
        assert.equal(setup(fen).roundOutcome.reason, 'dead-position-proven');
        assert.equal(e.analyzeLockedPosition(fen).kind, fixture.certificate);
      }
    });
  }

test('a legal pawn move closes the wall and ends the game in the same transition', () => {
  const root = setup('7k/8/8/1p1p1p1p/p1pPpPpP/PPP1P1P1/8/K1B5 w - - 0 1');
  assert.equal(root.phase, 'playing');
  assert.equal(e.analyzeLockedPosition(root.fen), null);
  const before = JSON.stringify(root),
    result = e.applyAction(root, 'alice', move('b3', 'b4'), 0),
    state = ok(result);
  assert.equal(JSON.stringify(root), before);
  assert.equal(state.phase, 'ended');
  assert.equal(state.roundOutcome.reason, 'dead-position-proven');
  assert.equal(state.ply, 1);
  assert.equal(state.revision, 1);
  assert.equal(state.turn, 'black');
  assert.equal(state.history.length, 1);
  assert.equal(state.positionHistory.length, 2);
  assert.deepEqual(
    result.events.map((x) => x.type),
    ['move-played', 'round-ended', 'match-ended'],
  );
  assert.deepEqual(ok(e.restoreState(JSON.stringify(state))), state);
  assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
  rejected(state, move('h8', 'g8'), 'GAME_ENDED', 'bob');
});

test('dead-position closure takes priority over a pending draw offer, without requiring agreement', () => {
  let state = setup('7k/8/8/1p1p1p1p/p1pPpPpP/PPP1P1P1/8/K1B5 w - - 0 1');
  state = play(state, { type: 'offer-draw' }, 'bob');
  const next = play(state, { ...move('b3', 'b4'), offerDraw: true });
  assert.equal(next.phase, 'ended');
  assert.equal(next.drawOffer, null);
  assert.equal(next.roundOutcome.reason, 'dead-position-proven');
});

test('a dead position may contain a check, but must not be mistaken for checkmate', () => {
  const f = fixtures.dead.find((x) => x.id === 'in-check-but-mate-impossible');
  const p = e.parseFen(f.fen);
  assert.equal(inCheck(p), true);
  assert.ok(legalBoardMoves(p).length > 0);
  assert.equal(setup(f.fen).roundOutcome.kind, 'draw');
});

test('forced capture to bare kings is dead before the capture is played', () => {
  const fen = '8/8/8/8/8/8/r1k5/K7 w - - 0 1';
  assert.equal(legalBoardMoves(e.parseFen(fen)).length, 1);
  assert.equal(e.analyzeDeadPosition(fen, 1).status, 'unknown');
  assert.equal(e.analyzeDeadPosition(fen, 2).status, 'dead');
  const state = setup(fen);
  assert.equal(state.roundOutcome.reason, 'dead-position-proven');
  assert.equal(state.ply, 0);
});

test('a wrong-colour bishop can be sacrificed to unlock the wall and enable actual mate', () => {
  const f = fixtures.liveSacrifice,
    witness = f.witness.map(spec);
  assert.equal(e.analyzeLockedPosition(f.fen), null);
  assert.deepEqual(e.validateMateWitness(f.fen, f.winner, witness), witness);
  const state = setup(f.fen);
  assert.equal(state.phase, 'playing');
  const final = sequence(state, f.witness);
  assert.equal(final.roundOutcome.reason, 'checkmate');
  assert.equal(final.roundOutcome.winner, f.winner);
});

for (const [id, fen] of [
  ['breakable pawn pair', '7k/8/8/4p3/4P3/8/8/K7 w - - 0 1'],
  ['rook sacrifice', '7k/8/8/1p1p1p1p/pPpPpPpP/P1P1P1P1/8/K1R5 w - - 0 1'],
  ['knight sacrifice', '7k/8/8/1p1p1p1p/pPpPpPpP/P1P1P1P1/8/K1N5 w - - 0 1'],
  ['queen sacrifice', '7k/8/8/1p1p1p1p/pPpPpPpP/P1P1P1P1/8/K1Q5 w - - 0 1'],
  ['reserve pawn may promote', '7k/8/8/p1p1p1p1/P1P1P1P1/8/1P6/K7 w - - 0 1'],
  ['en passant opens file', '7k/8/8/3pP3/8/8/8/K7 w - d6 0 2'],
  ['mutual pawn captures', '7k/8/8/pp6/PP6/8/8/K7 w - - 0 1'],
  ['two knights can mate cooperatively', '4N1k1/8/6K1/4N3/8/8/8/8 w - - 0 1'],
  [
    'opposite-coloured bishops without a wall',
    '2b1k3/8/8/8/8/8/8/2B1K3 w - - 0 1',
  ],
])
  test(`must not auto-draw merely blocked/weak material: ${id}`, () => {
    assert.equal(e.analyzeLockedPosition(fen), null);
    assert.notEqual(e.analyzeDeadPosition(fen, 1).status, 'dead');
    assert.equal(setup(fen).phase, 'playing');
  });

test('a movable reserve pawn is tracked as mobile, never assumed to be a fixed blocker', () => {
  const f = fixtures.dead.find((x) => x.id === 'mobile-reserve-pawn');
  const c = e.analyzeLockedPosition(f.fen);
  assert.equal(c.pawns.includes('a2'), false);
  assert.deepEqual(c.regions.find((x) => x.from === 'a2').reachable, [
    'a2',
    'a3',
  ]);
});

test('hundreds of exact board transitions preserve the reserve-pawn certificate', () => {
  const f = fixtures.dead.find((x) => x.id === 'eight-mobile-reserve-pawns');
  let p = e.parseFen(f.fen),
    seed = 53,
    transitions = 0;
  for (let i = 0; i < 250; i++) {
    const moves = legalBoardMoves(p);
    if (!moves.length) break;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    p = advance(p, moves[seed % moves.length]);
    assert.ok(e.analyzeLockedPosition(e.toFen(p)));
    assert.equal(inCheck(p), false);
    transitions++;
  }
  assert.equal(transitions, 250);
  // These are movement-rule proof states, NOT playable moves past a game ending.
});

test('v0.1.1 rook/knight false negative is now certified at one node, not a larger budget', () => {
  const f = fixtures.dead.find((x) => x.id === 'immobile-rook-knight-cage');
  const state = setup(f.fen),
    certificate = e.analyzeLockedPosition(f.fen);
  assert.equal(state.phase, 'ended');
  assert.deepEqual(e.analyzeDeadPosition(f.fen, 1), {
    status: 'dead',
    nodes: 1,
    witness: null,
  });
  assert.deepEqual(
    certificate.blockers.filter((x) => ['R', 'N'].includes(x.piece)),
    [
      { piece: 'R', square: 'a1' },
      { piece: 'N', square: 'b1' },
    ],
  );
  assert.equal(
    certificate.regions.some((x) => ['a1', 'b1'].includes(x.from)),
    false,
  );
  for (const budget of [1, 20, 2048, 10000]) {
    assert.equal(e.analyzeDeadPosition(f.fen, budget).nodes, 1);
    assert.equal(
      e.proveDeadPosition(state, budget, state.revision).error.code,
      'GAME_ENDED',
    );
  }
});

test('diagnostic null/unknown is not evidence of a possible mate or an authorization', () => {
  assert.equal(e.analyzeLockedPosition(e.START_FEN), null);
  assert.equal(e.analyzeDeadPosition(e.START_FEN, 1).status, 'unknown');
  assert.throws(() => e.analyzeLockedPosition('not fen'));
  const state = setup(fixtures.dead[1].fen),
    changed = JSON.parse(JSON.stringify(state));
  changed.phase = 'playing';
  changed.roundOutcome = null;
  changed.matchOutcome = null;
  assert.equal(e.restoreState(changed).ok, false);
  assert.equal(
    ok(e.getObservation(state, 'alice')).conformance
      .exhaustiveDeadPositionOracle,
    false,
  );
});

test('v0.1.0 snapshots are explicitly rejected rather than relabelled or silently reinterpreted', () => {
  const legacy = JSON.parse(JSON.stringify(ok(e.createGame({ players }))));
  legacy.engineVersion = '0.1.0';
  assert.equal(e.restoreState(legacy).error.code, 'UNSUPPORTED_VERSION');
});

test('a returned diagnostic certificate is not trusted state or a player command', () => {
  const f = fixtures.dead[1],
    certificate = e.analyzeLockedPosition(f.fen);
  certificate.pawns.length = 0;
  assert.equal(setup(f.fen).roundOutcome.reason, 'dead-position-proven');
  const state = ok(e.createGame({ players }));
  rejected(state, { type: 'dead-position', certificate }, 'INVALID_ACTION');
});

test('a final double pawn advance can close the wall even with an unusable EP field', () => {
  const root = setup('7k/8/8/p1p1p1p1/2P1P1P1/8/P7/K7 w - - 0 1');
  assert.equal(root.phase, 'playing');
  const final = play(root, move('a2', 'a4'));
  assert.equal(final.fen.split(' ')[3], 'a3');
  assert.equal(e.analyzeLockedPosition(final.fen).unusableEnPassant, 'a3');
  assert.deepEqual(e.analyzeDeadPosition(final.fen, 1), {
    status: 'dead',
    nodes: 1,
    witness: null,
  });
  assert.equal(final.roundOutcome.reason, 'dead-position-proven');
  assert.equal(final.ply, 1);
  assert.deepEqual(ok(e.restoreState(JSON.stringify(final))), final);
  const withoutEp = final.fen.replace(' a3 ', ' - ');
  assert.ok(e.analyzeLockedPosition(withoutEp));
  assert.equal(setup(withoutEp).roundOutcome.reason, 'dead-position-proven');
  // Repeated/hot and cold-replayed evaluations must not depend on proof-cache order.
  assert.equal(setup(final.fen).roundOutcome.reason, 'dead-position-proven');
});

test('an opposing bishop can obstruct its own king and make a lone-bishop mate possible', () => {
  const fen = '8/8/8/8/8/8/b1KB4/k7 w - - 0 1';
  assert.equal(e.analyzeLockedPosition(fen), null);
  assert.equal(e.analyzeMatePossibility(fen, 'white', 32).status, 'possible');
  assert.deepEqual(e.validateMateWitness(fen, 'white', [spec('d2c3')]), [
    spec('d2c3'),
  ]);
  assert.equal(
    play(setup(fen), move('d2', 'c3')).roundOutcome.reason,
    'checkmate',
  );
});
