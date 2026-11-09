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
    new URL('./temporal-proof-fixtures.json', import.meta.url),
    'utf8',
  ),
);
const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
const swap = (piece) =>
  piece === piece.toUpperCase() ? piece.toLowerCase() : piece.toUpperCase();
function square(name, reverse = false, mirror = false) {
  return (
    String.fromCharCode(
      97 + (mirror ? 7 - (name.charCodeAt(0) - 97) : name.charCodeAt(0) - 97),
    ) + (reverse ? 9 - Number(name[1]) : name[1])
  );
}
function spec(coordinate, reverse = false, mirror = false) {
  return {
    from: square(coordinate.slice(0, 2), reverse, mirror),
    to: square(coordinate.slice(2, 4), reverse, mirror),
    ...(coordinate[4] ? { promotion: coordinate[4] } : {}),
  };
}
const action = (coordinate, reverse = false, mirror = false) => ({
  type: 'move',
  ...spec(coordinate, reverse, mirror),
});
function transform(fen, reverse = false, mirror = false) {
  if (!reverse && !mirror) return fen;
  const p = e.parseFen(fen),
    board = Array(64).fill(null);
  assert.equal(
    p.castling,
    '',
    'These transforms apply only to the new no-castling fixtures.',
  );
  const index = (sq) =>
    (reverse ? 7 - (sq >> 3) : sq >> 3) * 8 + (mirror ? 7 - (sq % 8) : sq % 8);
  for (let from = 0; from < 64; from++)
    if (p.board[from])
      board[index(from)] = reverse ? swap(p.board[from]) : p.board[from];
  return e.toFen({
    ...p,
    board,
    turn: reverse ? (p.turn === 'white' ? 'black' : 'white') : p.turn,
    ep: p.ep === null ? null : index(p.ep),
  });
}
function roundtrip(state) {
  assert.deepEqual(ok(e.restoreState(ok(e.serializeState(state)))), state);
  assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
  assert.deepEqual(ok(cjs.restoreState(JSON.stringify(state))), state);
  assert.deepEqual(ok(cjs.replay(state.initial, state.history)), state);
  assert.equal(e.validateState(state).valid, true);
}
function assertDraw(state, ply) {
  assert.equal(state.engineVersion, '0.3.0');
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
  assert.equal(state.pendingResignation, null);
  assert.equal(ok(e.isGameOver(state)), true);
  assert.equal(ok(e.isPlayStopped(state)), true);
  for (const viewer of [players.white, players.black, null]) {
    const view = ok(e.getObservation(state, viewer));
    assert.equal(view.phase, 'ended');
    assert.equal(view.analysisRoot, true);
    assert.deepEqual(view.legalActions, []);
    assert.equal(view.conformance.exhaustiveDeadPositionOracle, false);
    assert.equal(
      e.chooseBotAction(view, { strategy: 'first-legal' }).error.code,
      'GAME_ENDED',
    );
  }
  roundtrip(state);
}

for (const f of fixtures.dead)
  for (const reverse of [false, true]) {
    test(`finite-tempo proof automatically ends the analysis root: ${f.id}; reverse=${reverse}`, () => {
      const fen = transform(f.fen, reverse),
        result = e.createAnalysisGame({ players, fen }),
        state = ok(result);
      assertDraw(state, 0);
      assert.equal(state.fen, fen);
      assert.equal(state.initial.fen, fen);
      assert.equal(state.revision, 0);
      assert.equal(state.ply, 0);
      assert.deepEqual(state.history, []);
      assert.deepEqual(state.positionHistory, [e.positionKey(e.parseFen(fen))]);
      assert.deepEqual(
        result.events.map((event) => event.type),
        ['game-created', 'round-ended', 'match-ended'],
      );
      assert.deepEqual(result, cjs.createAnalysisGame({ players, fen }));
      assert.equal(e.analyzeDeadPosition(fen, 256).status, 'dead');
      if (f.expectedTemporalCertificate === false) {
        // Removing mobile blockers overapproximates this root's pawn regions.
        // The certificate safely declines; exact search closes certified children.
        assert.equal(e.analyzeTemporalPosition(fen), null);
        assert.equal(cjs.analyzeTemporalPosition(fen), null);
        assert.equal(e.analyzeDeadPosition(fen, 1).status, 'unknown');
      } else if (fen.split(' ')[3] === '-') {
        assert.deepEqual(e.analyzeDeadPosition(fen, 1), {
          status: 'dead',
          nodes: 1,
          witness: null,
        });
        const certificate = e.analyzeTemporalPosition(fen);
        assert.equal(certificate.kind, 'finite-pawn-tempo');
        assert.deepEqual(certificate, cjs.analyzeTemporalPosition(fen));
      } else {
        // The currently actionable right is retained, and the exact graph proves
        // its children with the unchanged budget after the initial right expires.
        assert.equal(
          state.positionHistory[0].split(' ')[3],
          square('f6', reverse),
        );
        assert.equal(e.analyzeTemporalPosition(fen), null);
        assert.equal(e.analyzeDeadPosition(fen, 1).status, 'unknown');
        assert.ok(
          legalBoardMoves(e.parseFen(fen)).some(
            (move) => move.enPassant !== undefined,
          ),
        );
      }
      rejected(state, action('e1d1', reverse), 'GAME_ENDED');
      rejected(state, { type: 'offer-draw' }, 'GAME_ENDED');
      assert.equal(
        e.proveDeadPosition(state, 1000, state.revision).error.code,
        'GAME_ENDED',
      );
    });
  }

for (const reverse of [false, true])
  test(`diagnostics retain turn bounds and immediate promotion types; reverse=${reverse}`, () => {
    const fen = transform(fixtures.dead[0].fen, reverse),
      certificate = e.analyzeTemporalPosition(fen);
    assert.equal(certificate.clockSide, reverse ? 'white' : 'black');
    assert.equal(certificate.frozenKing, square('a8', reverse));
    assert.equal(certificate.maxClockMoves, 2);
    assert.equal(certificate.maxOtherMoves, 3);
    assert.equal(
      certificate.pawnBounds.reduce((sum, bound) => sum + bound.maxAdvances, 0),
      2,
    );
    assert.deepEqual(
      certificate.pawnBounds.find(
        (bound) => bound.from === square('f5', reverse),
      ),
      {
        piece: reverse ? 'P' : 'p',
        from: square('f5', reverse),
        barrier: square('f2', reverse),
        maxAdvances: 2,
      },
    );
    const promoter = certificate.regions.find(
      (region) => region.from === square('g5', reverse),
    );
    const promotedStates = promoter.states.filter(
      (state) => state.piece.toLowerCase() !== 'p',
    );
    assert.deepEqual(
      promotedStates.map((state) => state.piece.toLowerCase()).sort(),
      ['b', 'n', 'q', 'r'],
    );
    // The promotion itself creates each attack pattern immediately. There is no
    // further own turn on which any promoted piece can leave the promotion square.
    for (const state of promotedStates) {
      assert.equal(state.square, square('g8', reverse));
      assert.equal(state.minMoves, 3);
    }
    assert.equal(promoter.reachable.includes(square('b8', reverse)), false);
    const clockStarts = e.parseFen(fen);
    clockStarts.turn = certificate.clockSide;
    const shorter = e.analyzeTemporalPosition(e.toFen(clockStarts));
    assert.equal(shorter.maxClockMoves, 2);
    assert.equal(shorter.maxOtherMoves, 2);
    assert.equal(
      shorter.regions
        .find((region) => region.from === square('g5', reverse))
        .states.some((state) => state.piece.toLowerCase() !== 'p'),
      false,
    );
  });

for (const reverse of [false, true])
  test(`temporal bounds cover a central cage and two distinct moving pawns; reverse=${reverse}`, () => {
    const central = fixtures.dead.find(
      (f) => f.id === 'central-king-with-two-bishop-cage',
    );
    const centralProof = e.analyzeTemporalPosition(
      transform(central.fen, reverse),
    );
    assert.equal(centralProof.frozenKing, square('c8', reverse));
    assert.equal(centralProof.maxClockMoves, 2);
    assert.equal(centralProof.maxOtherMoves, 3);
    const fixture = fixtures.dead.find(
      (f) => f.id === 'two-separate-pawn-clocks',
    );
    const certificate = e.analyzeTemporalPosition(
      transform(fixture.fen, reverse),
    );
    assert.equal(certificate.clockSide, reverse ? 'white' : 'black');
    assert.equal(certificate.frozenKing, square('h8', reverse));
    assert.equal(certificate.maxClockMoves, 2);
    assert.equal(certificate.maxOtherMoves, 3);
    const clocks = certificate.pawnBounds.filter(
      (bound) => bound.maxAdvances > 0,
    );
    assert.deepEqual(
      clocks.map((bound) => bound.from).sort(),
      [square('a5', reverse), square('c5', reverse)].sort(),
    );
    for (const clock of clocks) assert.equal(clock.maxAdvances, 1);
    assert.equal(
      certificate.pawnBounds.reduce((sum, bound) => sum + bound.maxAdvances, 0),
      2,
    );
    const promoter = certificate.regions.find(
      (region) => region.from === square('d5', reverse),
    );
    const promoted = promoter.states.filter(
      (state) => state.piece.toLowerCase() !== 'p',
    );
    assert.deepEqual(
      promoted.map((state) => state.piece.toLowerCase()).sort(),
      ['b', 'n', 'q', 'r'],
    );
    for (const state of promoted) {
      assert.equal(state.square, square('d8', reverse));
      assert.equal(state.minMoves, 3);
    }
  });

for (const reverse of [false, true])
  test(`unusable initial EP is diagnostic data, not erased state; reverse=${reverse}`, () => {
    const fen = transform(
        'kb6/p1p5/P1P5/5p2/8/8/P1P2P1P/4K3 w - f6 0 1',
        reverse,
      ),
      state = setup(fen);
    assertDraw(state, 0);
    assert.equal(state.fen, fen);
    assert.equal(state.initial.fen, fen);
    assert.equal(state.positionHistory[0].split(' ')[3], '-');
    assert.equal(
      e.analyzeTemporalPosition(fen).unusableEnPassant,
      square('f6', reverse),
    );
    assert.equal(
      legalBoardMoves(e.parseFen(fen)).some(
        (move) => move.enPassant !== undefined,
      ),
      false,
    );
    assert.deepEqual(e.analyzeDeadPosition(fen, 1), {
      status: 'dead',
      nodes: 1,
      witness: null,
    });
  });

test('temporal diagnostics are detached data and never player authority', () => {
  const fen = fixtures.dead[0].fen,
    certificate = e.analyzeTemporalPosition(fen),
    original = JSON.parse(JSON.stringify(certificate));
  certificate.clockSide = 'white';
  certificate.maxOtherMoves = 1000;
  certificate.blockers.length = 0;
  certificate.pawnBounds.length = 0;
  certificate.regions[0].states.length = 0;
  certificate.regions.length = 0;
  assert.deepEqual(e.analyzeTemporalPosition(fen), original);
  assert.deepEqual(cjs.analyzeTemporalPosition(fen), original);
  assertDraw(setup(fen), 0);
  rejected(
    setup(fixtures.live[0].fen),
    { type: 'dead-position', certificate },
    'INVALID_ACTION',
  );
  assert.throws(() => e.analyzeTemporalPosition('not a FEN'));
});

for (const reverse of [false, true])
  test(`file reflection also receives a structural temporal proof; reverse=${reverse}`, () => {
    const fen = transform(fixtures.dead[0].fen, reverse, true),
      state = setup(fen);
    assertDraw(state, 0);
    assert.deepEqual(e.analyzeDeadPosition(fen, 1), {
      status: 'dead',
      nodes: 1,
      witness: null,
    });
  });

for (const reverse of [false, true])
  test(`a demonstrably live king retreat ends at the accepted transition; reverse=${reverse}`, () => {
    const closing = fixtures.closing,
      fen = transform(closing.fen, reverse),
      before = setup(fen),
      move = action(closing.move, reverse);
    const witness = fixtures.live.find((f) => f.id === closing.liveWitnessId);
    const winner = reverse ? 'black' : 'white';
    assert.deepEqual(
      e.validateMateWitness(
        fen,
        winner,
        witness.witness.map((m) => spec(m, reverse)),
      ),
      witness.witness.map((m) => spec(m, reverse)),
    );
    assert.equal(before.phase, 'playing');
    const actor = before.initial.players[before.turn],
      frozen = JSON.stringify(before);
    rejected(before, move, 'STALE_REVISION', actor, before.revision + 1);
    rejected(before, move, 'UNKNOWN_PLAYER', 'spectator');
    rejected(
      before,
      move,
      'NOT_YOUR_TURN',
      actor === players.white ? players.black : players.white,
    );
    rejected(before, action('b7b8', reverse), 'ILLEGAL_MOVE', actor);
    const sent = { ...move, offerDraw: true },
      result = e.applyAction(before, actor, sent, before.revision),
      after = ok(result);
    assert.equal(JSON.stringify(before), frozen);
    assertDraw(after, 1);
    assert.equal(after.revision, 1);
    assert.equal(after.ply, 1);
    assert.deepEqual(after.history, [
      { kind: 'player', playerId: actor, action: sent },
    ]);
    assert.deepEqual(
      after.movesByColor,
      reverse ? { white: 1, black: 0 } : { white: 0, black: 1 },
    );
    const target = transform(fixtures.dead[0].fen, reverse);
    assert.equal(
      after.positionHistory.at(-1),
      e.positionKey(e.parseFen(target)),
    );
    assert.deepEqual(
      result.events.map((event) => event.type),
      ['move-played', 'round-ended', 'match-ended'],
    );
    assert.deepEqual(
      result,
      cjs.applyAction(JSON.parse(frozen), actor, sent, 0),
    );
    rejected(after, action('e1d1', reverse), 'GAME_ENDED');
  });

for (const f of fixtures.live)
  for (const reverse of [false, true]) {
    test(`temporal analysis preserves actual cooperative mate: ${f.id}; reverse=${reverse}`, () => {
      const fen = transform(f.fen, reverse),
        winner = reverse
          ? f.winner === 'white'
            ? 'black'
            : 'white'
          : f.winner;
      const line = f.witness.map((m) => spec(m, reverse));
      assert.deepEqual(e.validateMateWitness(fen, winner, line), line);
      let state = setup(fen);
      for (const move of line) {
        assert.equal(state.phase, 'playing');
        assert.equal(e.analyzeTemporalPosition(state.fen), null);
        assert.notEqual(e.analyzeDeadPosition(state.fen, 1).status, 'dead');
        roundtrip(state);
        const actor = state.initial.players[state.turn],
          result = e.applyAction(
            state,
            actor,
            { type: 'move', ...move },
            state.revision,
          );
        assert.deepEqual(
          result,
          cjs.applyAction(
            state,
            actor,
            { type: 'move', ...move },
            state.revision,
          ),
        );
        state = ok(result);
        assert.equal(result.events[0].uci, e.uci(move));
      }
      assert.equal(state.phase, 'ended');
      assert.equal(state.roundOutcome.reason, 'checkmate');
      assert.equal(state.roundOutcome.winner, winner);
      assert.equal(state.roundOutcome.ply, line.length);
      assert.equal(inCheck(e.parseFen(state.fen)), true);
      assert.deepEqual(legalBoardMoves(e.parseFen(state.fen)), []);
      roundtrip(state);
    });
  }

for (const reverse of [false, true])
  test(`turn parity remains part of identity and cached temporal outcomes; reverse=${reverse}`, () => {
    const live = fixtures.live.find(
      (f) => f.id === 'one-promoted-queen-move-releases-the-king',
    );
    const dead = fixtures.dead.find(
      (f) => f.id === 'last-promotion-with-finite-side-first',
    );
    const a = transform(live.fen, reverse),
      b = transform(dead.fen, reverse);
    assert.notEqual(e.positionKey(e.parseFen(a)), e.positionKey(e.parseFen(b)));
    assert.equal(a.split(' ')[0], b.split(' ')[0]);
    for (const order of [
      [a, b, a, b],
      [b, a, b, a],
    ])
      for (const fen of order) {
        assert.equal(setup(fen).phase, fen === a ? 'playing' : 'ended');
        assert.equal(
          ok(cjs.createAnalysisGame({ players, fen })).phase,
          fen === a ? 'playing' : 'ended',
        );
      }
  });

for (const reverse of [false, true])
  test(`all four last-turn promotions are immediately terminal stalemates; reverse=${reverse}`, () => {
    // These are board-rule continuations for checking the theorem's boundary.
    // The game itself has already ended at the earlier dead analysis root.
    const f = fixtures.lastPromotion,
      fen = transform(f.fen, reverse),
      position = e.parseFen(fen);
    const pawn = findLegalMove(position, {
      from: square(f.from, reverse),
      to: square(f.to, reverse),
      promotion: 'q',
    }).from;
    const variants = legalBoardMoves(position).filter(
      (move) => move.from === pawn && move.promotion,
    );
    assert.deepEqual(variants.map((m) => m.promotion).sort(), [
      'b',
      'n',
      'q',
      'r',
    ]);
    for (const move of variants) {
      const child = advance(position, move),
        childFen = e.toFen(child),
        state = setup(childFen);
      assert.equal(inCheck(child), false);
      assert.deepEqual(legalBoardMoves(child), []);
      assert.equal(state.roundOutcome.reason, 'stalemate');
      assert.equal(state.roundOutcome.winner, null);
      assert.equal(state.fen, childFen);
      roundtrip(state);
    }
    assertDraw(setup(fen), 0);
    rejected(setup(fen), action('g7g8q', reverse), 'GAME_ENDED');
  });

for (const reverse of [false, true])
  test(`promotion choice preserves immediate checkmate versus stalemate; reverse=${reverse}`, () => {
    const f = fixtures.promotionChoice,
      fen = transform(f.fen, reverse),
      state = setup(fen);
    assert.equal(state.phase, 'playing');
    assert.equal(e.analyzeTemporalPosition(fen), null);
    const original = JSON.stringify(state),
      actor = state.initial.players[state.turn];
    for (const [promotion, reason] of Object.entries(f.outcomes)) {
      const move = {
        type: 'move',
        from: square(f.from, reverse),
        to: square(f.to, reverse),
        promotion,
        offerDraw: true,
      };
      const result = e.applyAction(state, actor, move, state.revision),
        after = ok(result);
      assert.equal(after.phase, 'ended');
      assert.equal(after.roundOutcome.reason, reason);
      assert.equal(
        after.roundOutcome.winner,
        reason === 'checkmate' ? (reverse ? 'black' : 'white') : null,
      );
      assert.equal(after.roundOutcome.ply, 1);
      assert.equal(after.drawOffer, null);
      assert.equal(after.fen.split(' ')[4], '0');
      assert.deepEqual(
        result.events.map((event) => event.type),
        ['move-played', 'round-ended', 'match-ended'],
      );
      assert.deepEqual(
        result,
        cjs.applyAction(state, actor, move, state.revision),
      );
      roundtrip(after);
    }
    assert.equal(JSON.stringify(state), original);
  });

test('a continuation cannot pass through terminal promotion and later manufacture mate', () => {
  const position = e.parseFen(fixtures.lastPromotion.fen),
    move = findLegalMove(position, spec('g7g8q'));
  const child = advance(position, move);
  assert.deepEqual(legalBoardMoves(child), []);
  assert.equal(inCheck(child), false);
  assert.throws(() =>
    e.validateMateWitness(fixtures.lastPromotion.fen, 'white', [
      spec('g7g8q'),
      spec('a8b8'),
      spec('g8b7'),
    ]),
  );
  assert.throws(() =>
    e.validateMateWitness(
      fixtures.dead[0].fen,
      'white',
      fixtures.analysisBoardLineToPromotion.map((m) => spec(m)),
    ),
  );
});

test('intended closing move remains binding through claim rejection, decline, restoration and ending', () => {
  let state = setup(fixtures.closing.fen),
    closing = spec(fixtures.closing.move);
  state = play(state, {
    type: 'claim-draw',
    reason: 'fifty-move',
    intendedMove: closing,
  });
  assert.equal(state.phase, 'playing');
  assert.deepEqual(state.forcedMove, closing);
  state = play(state, { type: 'decline-draw' }, players.white);
  assert.equal(state.drawOffer, null);
  assert.deepEqual(state.forcedMove, closing);
  roundtrip(state);
  rejected(state, action('b7a6'), 'FORCED_MOVE', players.black);
  const result = e.applyAction(
      state,
      players.black,
      { type: 'move', ...closing },
      state.revision,
    ),
    final = ok(result);
  assertDraw(final, 1);
  assert.equal(final.revision, 3);
  assert.equal(final.history.length, 3);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ['move-played', 'round-ended', 'match-ended'],
  );
});

test('a cached playing phase cannot resurrect a proven temporal root', () => {
  const actual = setup(fixtures.dead[0].fen),
    fake = JSON.parse(JSON.stringify(actual));
  fake.phase = 'playing';
  fake.roundOutcome = null;
  fake.matchOutcome = null;
  assert.equal(e.restoreState(fake).error.code, 'INVALID_STATE');
  assert.equal(
    e.applyAction(fake, players.white, action('e1d1'), 0).error.code,
    'INVALID_STATE',
  );
  roundtrip(actual);
});

for (const name of [
  'v0.1.4-tempo-root',
  'v0.1.4-tempo-after-e1-d1',
  'v0.1.4-standard-root',
]) {
  test(`authentic v0.1.4 snapshots require their original engine: ${name}`, () => {
    const original = JSON.parse(
        readFileSync(new URL(`./legacy/${name}.json`, import.meta.url), 'utf8'),
      ),
      frozen = JSON.stringify(original);
    assert.equal(original.engineVersion, '0.1.4');
    assert.equal(e.restoreState(original).error.code, 'UNSUPPORTED_VERSION');
    assert.equal(cjs.restoreState(original).error.code, 'UNSUPPORTED_VERSION');
    assert.equal(
      e.applyAction(original, players.white, action('e1d1'), original.revision)
        .error.code,
      'UNSUPPORTED_VERSION',
    );
    assert.equal(JSON.stringify(original), frozen);
    if (name.includes('tempo')) {
      const relabeled = JSON.parse(frozen);
      relabeled.engineVersion = e.ENGINE_VERSION;
      relabeled.rulesVersion = e.RULES_VERSION;
      assert.equal(e.restoreState(relabeled).error.code, 'INVALID_STATE');
      const replay = e.replay(relabeled.initial, relabeled.history);
      if (relabeled.history.length)
        assert.equal(replay.error.code, 'GAME_ENDED');
      else assertDraw(ok(replay), 0);
    }
  });
}
