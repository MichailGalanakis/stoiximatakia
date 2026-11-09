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
    new URL('./temporal-castling-fixtures.json', import.meta.url),
    'utf8',
  ),
);
const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
const swap = (piece) =>
  piece === piece.toUpperCase() ? piece.toLowerCase() : piece.toUpperCase();
const square = (name, reverse = false) =>
  reverse ? name[0] + (9 - Number(name[1])) : name;
const spec = (coordinate, reverse = false) => ({
  from: square(coordinate.slice(0, 2), reverse),
  to: square(coordinate.slice(2, 4), reverse),
  ...(coordinate[4] ? { promotion: coordinate[4] } : {}),
});
const action = (coordinate, reverse = false) => ({
  type: 'move',
  ...spec(coordinate, reverse),
});
const index = (name) => (Number(name[1]) - 1) * 8 + name.charCodeAt(0) - 97;
function transform(fen, reverse = false) {
  if (!reverse) return fen;
  const p = e.parseFen(fen),
    board = Array(64).fill(null);
  for (let from = 0; from < 64; from++)
    if (p.board[from])
      board[(7 - (from >> 3)) * 8 + (from % 8)] = swap(p.board[from]);
  const rights = new Set([...p.castling].map(swap));
  return e.toFen({
    ...p,
    board,
    turn: p.turn === 'white' ? 'black' : 'white',
    castling: [...'KQkq'].filter((right) => rights.has(right)).join(''),
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
function assertDraw(state, ply = 0) {
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
    assert.equal(view.fen, state.fen);
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
    test(`finite-tempo castling root ends before an extra action: ${f.id}; reverse=${reverse}`, () => {
      const fen = transform(f.fen, reverse),
        result = e.createAnalysisGame({ players, fen }),
        state = ok(result);
      assertDraw(state);
      assert.equal(state.fen, fen);
      assert.equal(state.initial.fen, fen);
      assert.equal(state.revision, 0);
      assert.equal(state.ply, 0);
      assert.deepEqual(state.history, []);
      assert.deepEqual(state.positionHistory, [e.positionKey(e.parseFen(fen))]);
      assert.equal(state.positionHistory[0].split(' ')[2], fen.split(' ')[2]);
      const noRights = fen.split(' ');
      noRights[2] = '-';
      assert.notEqual(
        state.positionHistory[0],
        e.positionKey(e.parseFen(noRights.join(' '))),
      );
      assert.deepEqual(
        result.events.map((event) => event.type),
        ['game-created', 'round-ended', 'match-ended'],
      );
      assert.deepEqual(result, cjs.createAnalysisGame({ players, fen }));
      const proof = e.analyzeDeadPosition(fen, 256);
      assert.equal(proof.status, 'dead');
      assert.ok(proof.nodes <= 256);
      assert.equal(proof.witness, null);
      if (f.expectedTemporalCertificate) {
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
      rejected(state, action(f.extraMove, reverse), 'GAME_ENDED');
      rejected(state, { type: 'offer-draw' }, 'GAME_ENDED');
      rejected(
        state,
        { type: 'claim-draw', reason: 'fifty-move' },
        'GAME_ENDED',
      );
      assert.equal(
        e.proveDeadPosition(state, 2000, 0).error.code,
        'GAME_ENDED',
      );
    });
  }

for (const f of fixtures.dead.filter((f) => f.castles))
  for (const reverse of [false, true]) {
    test(`one-turn castle diagnostics retain both original piece identities: ${f.id}; reverse=${reverse}`, () => {
      const fen = transform(f.fen, reverse),
        p = e.parseFen(fen),
        certificate = e.analyzeTemporalPosition(fen);
      assert.equal(certificate.maxClockMoves, 0);
      assert.equal(certificate.maxOtherMoves, 1);
      assert.equal(certificate.clockSide, reverse ? 'white' : 'black');
      assert.deepEqual(certificate.clockCastlingExclusions, []);
      assert.deepEqual(certificate, cjs.analyzeTemporalPosition(fen));
      const kingPiece = reverse ? 'k' : 'K',
        rookPiece = reverse ? 'r' : 'R';
      const kingRegions = certificate.regions.filter(
        (region) => region.piece === kingPiece,
      );
      assert.equal(
        kingRegions.length,
        1,
        'Alternative castles do not create extra king occupants.',
      );
      assert.equal(
        certificate.regions.filter((region) => region.piece === rookPiece)
          .length,
        f.castles.length,
      );
      assert.equal(certificate.castlingTransitions.length, f.castles.length);
      for (const coordinate of f.castles) {
        const castle = spec(coordinate, reverse),
          side = coordinate.endsWith('g1') ? 'K' : 'Q';
        const rookFrom = square(side === 'K' ? 'h1' : 'a1', reverse),
          rookTo = square(side === 'K' ? 'f1' : 'd1', reverse);
        const right = reverse ? side.toLowerCase() : side;
        assert.deepEqual(
          certificate.castlingTransitions.find(
            (entry) => entry.right === right,
          ),
          {
            right,
            kingFrom: castle.from,
            kingTo: castle.to,
            rookFrom,
            rookTo,
            minMoves: 1,
          },
        );
        const kingState = kingRegions[0].states.find(
          (state) => state.square === castle.to && state.piece === kingPiece,
        );
        const rookRegion = certificate.regions.find(
          (region) => region.from === rookFrom,
        );
        const rookState = rookRegion.states.find(
          (state) => state.square === rookTo && state.piece === rookPiece,
        );
        assert.equal(kingState.minMoves, 1);
        assert.equal(rookState.minMoves, 1);
        assert.equal(
          certificate.blockers.some((blocker) => blocker.square === rookFrom),
          false,
        );
        // This is an actual movement-rule castle edge, not a two-step synthetic
        // king/rook sequence. Its board result immediately stalemates the clock.
        const move = findLegalMove(p, castle);
        assert.equal(move.castle, side === 'K' ? 'king' : 'queen');
        const after = advance(p, move);
        assert.equal(after.board[index(castle.from)], null);
        assert.equal(after.board[index(rookFrom)], null);
        assert.equal(after.board[index(castle.to)], kingPiece);
        assert.equal(after.board[index(rookTo)], rookPiece);
        assert.equal(after.turn, reverse ? 'white' : 'black');
        assert.equal(after.castling, '');
        assert.equal(after.halfmove, p.halfmove + 1);
        assert.deepEqual(legalBoardMoves(after), []);
        assert.equal(inCheck(after), false);
        const terminal = setup(e.toFen(after));
        assert.equal(terminal.roundOutcome.reason, 'stalemate');
        roundtrip(terminal);
        rejected(setup(fen), { type: 'move', ...castle }, 'GAME_ENDED');
      }
    });
  }

for (const reverse of [false, true])
  test(`clock-side castle exclusion requires the permanent invariant; reverse=${reverse}`, () => {
    const f = fixtures.dead.find(
      (f) => f.id === 'clock-side-castle-invariantly-blocked',
    );
    const fen = transform(f.fen, reverse),
      certificate = e.analyzeTemporalPosition(fen);
    assert.equal(certificate.clockSide, reverse ? 'black' : 'white');
    assert.equal(certificate.frozenKing, square('e1', reverse));
    assert.equal(certificate.maxClockMoves, 0);
    assert.equal(certificate.maxOtherMoves, 1);
    assert.deepEqual(certificate.castlingTransitions, []);
    assert.deepEqual(certificate.clockCastlingExclusions, [
      {
        right: reverse ? 'k' : 'K',
        blockers: [square('f1', reverse), square('g1', reverse)],
        attackedKingPath: [],
      },
    ]);
    const state = setup(fen);
    assertDraw(state);
    assert.equal(state.fen.split(' ')[2], reverse ? 'k' : 'K');
  });

for (const reverse of [false, true])
  test(`retained rights select distinct one-turn regions without changing position identity; reverse=${reverse}`, () => {
    const original = fixtures.dead.find(
      (f) => f.id === 'both-castling-rights-at-terminal-frontier',
    ).fen;
    const keys = new Set();
    for (const rights of ['KQ', '-', 'K', 'Q', 'KQ']) {
      const fields = original.split(' ');
      fields[2] = rights;
      const fen = transform(fields.join(' '), reverse),
        state = setup(fen),
        certificate = e.analyzeTemporalPosition(fen);
      assertDraw(state);
      assert.equal(state.fen, fen);
      keys.add(state.positionHistory[0]);
      const expected =
        rights === '-'
          ? []
          : [...rights]
              .map((right) => (reverse ? right.toLowerCase() : right))
              .sort();
      assert.deepEqual(
        certificate.castlingTransitions.map((entry) => entry.right).sort(),
        expected,
      );
      const king = certificate.regions.find(
        (region) => region.piece === (reverse ? 'k' : 'K'),
      );
      for (const [right, destination] of [
        ['Q', 'c1'],
        ['K', 'g1'],
      ]) {
        assert.equal(
          king.states.some(
            (entry) =>
              entry.square === square(destination, reverse) &&
              entry.minMoves === 1,
          ),
          rights.includes(right),
        );
      }
    }
    assert.equal(keys.size, 4);
  });

for (const reverse of [false, true])
  test(`actual turn limits castle availability before immediate stalemate; reverse=${reverse}`, () => {
    const root = fixtures.dead.find(
      (f) => f.id === 'queenside-castle-as-terminal-move',
    ).fen;
    const otherStarts = transform(root, reverse),
      fields = root.split(' ');
    fields[1] = 'b';
    const clockStarts = transform(fields.join(' '), reverse);
    for (const fen of [otherStarts, clockStarts, otherStarts]) {
      const certificate = e.analyzeTemporalPosition(fen),
        state = setup(fen);
      const isOtherTurn = fen === otherStarts;
      assert.equal(certificate.maxOtherMoves, isOtherTurn ? 1 : 0);
      assert.equal(certificate.castlingTransitions.length, isOtherTurn ? 1 : 0);
      assert.equal(state.phase, 'ended');
      assert.equal(
        state.roundOutcome.reason,
        isOtherTurn ? 'dead-position-proven' : 'stalemate',
      );
      assert.equal(state.fen, fen);
      roundtrip(state);
    }
    assert.notEqual(
      e.positionKey(e.parseFen(otherStarts)),
      e.positionKey(e.parseFen(clockStarts)),
    );
  });

for (const reverse of [false, true])
  test(`the reported graph includes real castles but no post-stalemate continuation; reverse=${reverse}`, () => {
    let p = e.parseFen(transform(fixtures.dead[0].fen, reverse));
    assert.equal(
      legalBoardMoves(p).some((move) => move.castle),
      false,
      'The root corridor is temporarily occupied.',
    );
    for (const [ply, coordinate] of fixtures.analysisLineToCastle.entries()) {
      const move = findLegalMove(p, spec(coordinate, reverse));
      if (ply < 4) assert.equal(move.castle, undefined);
      else assert.equal(move.castle, 'queen');
      p = advance(p, move);
    }
    assert.equal(p.board[index(square('c1', reverse))], reverse ? 'k' : 'K');
    assert.equal(p.board[index(square('d1', reverse))], reverse ? 'r' : 'R');
    assert.equal(p.castling, '');
    assert.deepEqual(legalBoardMoves(p), []);
    assert.equal(inCheck(p), false);
    const ended = setup(e.toFen(p));
    assert.equal(ended.roundOutcome.reason, 'stalemate');
    roundtrip(ended);
    assert.throws(() =>
      e.validateMateWitness(
        transform(fixtures.dead[0].fen, reverse),
        reverse ? 'black' : 'white',
        fixtures.analysisLineToCastle.map((move) => spec(move, reverse)),
      ),
    );
  });

for (const f of fixtures.live)
  for (const reverse of [false, true]) {
    test(`castling-tempo analysis preserves actual mating continuation: ${f.id}; reverse=${reverse}`, () => {
      const fen = transform(f.fen, reverse),
        winner = reverse
          ? f.winner === 'white'
            ? 'black'
            : 'white'
          : f.winner;
      const line = f.witness.map((coordinate) => spec(coordinate, reverse));
      assert.deepEqual(e.validateMateWitness(fen, winner, line), line);
      let state = setup(fen),
        castles = 0;
      assert.equal(state.phase, 'playing');
      if (f.castle) {
        const castle = action(f.castle, reverse),
          view = ok(e.getObservation(state, state.initial.players[state.turn]));
        assert.equal(
          view.legalActions.some(
            (move) => move.type === 'move' && e.uci(move) === e.uci(castle),
          ),
          f.initiallyLegalCastle,
        );
        if (!f.initiallyLegalCastle) rejected(state, castle, 'ILLEGAL_MOVE');
      }
      for (const move of line) {
        assert.equal(state.phase, 'playing');
        assert.notEqual(e.analyzeDeadPosition(state.fen, 1).status, 'dead');
        roundtrip(state);
        const before = state,
          frozen = JSON.stringify(before),
          boardMove = findLegalMove(e.parseFen(before.fen), move);
        const actor = before.initial.players[before.turn],
          result = e.applyAction(
            before,
            actor,
            { type: 'move', ...move },
            before.revision,
          );
        assert.deepEqual(
          result,
          cjs.applyAction(
            JSON.parse(frozen),
            actor,
            { type: 'move', ...move },
            before.revision,
          ),
        );
        state = ok(result);
        assert.equal(JSON.stringify(before), frozen);
        assert.equal(state.ply, before.ply + 1);
        assert.equal(state.revision, before.revision + 1);
        assert.equal(state.history.length, before.history.length + 1);
        assert.equal(
          state.positionHistory.length,
          before.positionHistory.length + 1,
        );
        assert.equal(
          state.movesByColor[before.turn],
          before.movesByColor[before.turn] + 1,
        );
        if (boardMove.castle) {
          castles++;
          const rank = move.from[1],
            rookFrom = (boardMove.castle === 'king' ? 'h' : 'a') + rank,
            rookTo = (boardMove.castle === 'king' ? 'f' : 'd') + rank;
          const p = e.parseFen(state.fen),
            kingPiece = before.turn === 'white' ? 'K' : 'k',
            rookPiece = before.turn === 'white' ? 'R' : 'r';
          assert.equal(p.board[index(move.from)], null);
          assert.equal(p.board[index(rookFrom)], null);
          assert.equal(p.board[index(move.to)], kingPiece);
          assert.equal(p.board[index(rookTo)], rookPiece);
          assert.equal(p.castling, '');
          assert.match(result.events[0].san, /^O-O(?:-O)?[+#]?$/);
          const view = ok(e.getObservation(state, actor));
          assert.equal(view.moves.length, state.ply);
          assert.deepEqual(
            view.moves.at(-1).move,
            move,
            'The observation records one castle move, not two piece actions.',
          );
          roundtrip(state);
        }
      }
      assert.equal(castles, f.expectedCastles);
      assert.equal(state.roundOutcome.reason, 'checkmate');
      assert.equal(state.roundOutcome.winner, winner);
      assert.equal(state.roundOutcome.ply, f.witness.length);
      assert.equal(state.phase, 'ended');
      roundtrip(state);
    });
  }

for (const reverse of [false, true])
  test(`a live closing retreat commits the draw with Q retained; reverse=${reverse}`, () => {
    const f = fixtures.closing,
      before = setup(transform(f.fen, reverse)),
      move = action(f.move, reverse);
    const actor = before.initial.players[before.turn],
      frozen = JSON.stringify(before);
    assert.equal(before.phase, 'playing');
    rejected(before, move, 'STALE_REVISION', actor, 1);
    rejected(before, move, 'UNKNOWN_PLAYER', 'spectator');
    rejected(
      before,
      move,
      'NOT_YOUR_TURN',
      actor === players.white ? players.black : players.white,
    );
    const sent = { ...move, offerDraw: true },
      result = e.applyAction(before, actor, sent, 0),
      after = ok(result);
    assert.equal(JSON.stringify(before), frozen);
    assertDraw(after, 1);
    assert.equal(after.revision, 1);
    assert.equal(after.history.length, 1);
    assert.equal(after.fen.split(' ')[2], reverse ? 'q' : 'Q');
    assert.equal(
      after.positionHistory.at(-1),
      e.positionKey(e.parseFen(transform(fixtures.dead[0].fen, reverse))),
    );
    assert.deepEqual(
      result.events.map((event) => event.type),
      ['move-played', 'round-ended', 'match-ended'],
    );
    assert.deepEqual(
      result,
      cjs.applyAction(JSON.parse(frozen), actor, sent, 0),
    );
    rejected(after, action('c2c4', reverse), 'GAME_ENDED');
  });

for (const reverse of [false, true])
  test(`a rejected intended claim cannot delay the castling-tempo ending; reverse=${reverse}`, () => {
    const f = fixtures.closing,
      closing = spec(f.move, reverse);
    let state = setup(transform(f.fen, reverse));
    const actor = state.initial.players[state.turn],
      responder = actor === players.white ? players.black : players.white;
    state = play(
      state,
      { type: 'claim-draw', reason: 'fifty-move', intendedMove: closing },
      actor,
    );
    assert.equal(state.phase, 'playing');
    assert.deepEqual(state.forcedMove, closing);
    state = play(state, { type: 'decline-draw' }, responder);
    roundtrip(state);
    assert.equal(state.fen.split(' ')[2], reverse ? 'q' : 'Q');
    rejected(state, action('b7a6', reverse), 'FORCED_MOVE', actor);
    const result = e.applyAction(
        state,
        actor,
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

for (const reverse of [false, true])
  test(`a legal en-passant stalemate alternative does not erase the mating branch; reverse=${reverse}`, () => {
    const f = fixtures.live.find(
      (f) => f.id === 'active-en-passant-does-not-obscure-alternative-mate',
    );
    const fen = transform(f.fen, reverse),
      state = setup(fen),
      p = e.parseFen(fen),
      ep = spec('g5h6', reverse);
    assert.equal(state.phase, 'playing');
    assert.equal(e.analyzeTemporalPosition(fen), null);
    assert.equal(state.positionHistory[0].split(' ')[3], square('h6', reverse));
    assert.notEqual(findLegalMove(p, ep).enPassant, undefined);
    const next = play(state, { type: 'move', ...ep });
    assert.equal(next.roundOutcome.reason, 'stalemate');
    assert.equal(next.roundOutcome.ply, 1);
    assert.equal(next.fen.split(' ')[2], reverse ? 'q' : 'Q');
    assert.equal(next.fen.split(' ')[3], '-');
    roundtrip(next);
  });

test('castling diagnostics are detached and cannot strip authoritative rights', () => {
  const f = fixtures.dead.find(
    (f) => f.id === 'both-castling-rights-at-terminal-frontier',
  );
  const certificate = e.analyzeTemporalPosition(f.fen),
    original = JSON.parse(JSON.stringify(certificate));
  certificate.castlingTransitions[0].minMoves = 100;
  certificate.castlingTransitions[0].rookTo = 'a8';
  certificate.castlingTransitions.length = 0;
  certificate.clockCastlingExclusions.push({
    right: 'Q',
    blockers: [],
    attackedKingPath: [],
  });
  certificate.regions.length = 0;
  assert.deepEqual(e.analyzeTemporalPosition(f.fen), original);
  assert.deepEqual(cjs.analyzeTemporalPosition(f.fen), original);
  const state = setup(f.fen);
  assertDraw(state);
  assert.equal(state.fen.split(' ')[2], 'KQ');
  rejected(
    setup(fixtures.live[0].fen),
    { type: 'dead-position', certificate },
    'INVALID_ACTION',
  );
});

test('a stored playing phase or stripped raw right cannot resurrect the fixed root', () => {
  const actual = setup(fixtures.dead[0].fen),
    playing = JSON.parse(JSON.stringify(actual));
  playing.phase = 'playing';
  playing.roundOutcome = null;
  playing.matchOutcome = null;
  assert.equal(e.restoreState(playing).error.code, 'INVALID_STATE');
  assert.equal(
    e.applyAction(playing, players.white, action('c2c4'), 0).error.code,
    'INVALID_STATE',
  );
  const stripped = JSON.parse(JSON.stringify(actual)),
    fields = stripped.fen.split(' ');
  fields[2] = '-';
  stripped.fen = fields.join(' ');
  assert.equal(e.restoreState(stripped).error.code, 'INVALID_STATE');
  roundtrip(actual);
});

for (const name of [
  'v0.1.5-castling-tempo-root',
  'v0.1.5-castling-tempo-after-c2-c4',
  'v0.1.5-castling-tempo-proved',
  'v0.1.5-standard-root',
]) {
  test(`authentic v0.1.5 snapshots require their original engine: ${name}`, () => {
    const original = JSON.parse(
        readFileSync(new URL(`./legacy/${name}.json`, import.meta.url), 'utf8'),
      ),
      frozen = JSON.stringify(original);
    assert.equal(original.engineVersion, '0.1.5');
    assert.equal(e.restoreState(original).error.code, 'UNSUPPORTED_VERSION');
    assert.equal(cjs.restoreState(original).error.code, 'UNSUPPORTED_VERSION');
    assert.equal(
      e.applyAction(original, players.white, action('c2c4'), original.revision)
        .error.code,
      'UNSUPPORTED_VERSION',
    );
    assert.equal(JSON.stringify(original), frozen);
    if (name.includes('castling-tempo')) {
      const relabeled = JSON.parse(frozen);
      relabeled.engineVersion = e.ENGINE_VERSION;
      relabeled.rulesVersion = e.RULES_VERSION;
      assert.equal(e.restoreState(relabeled).error.code, 'INVALID_STATE');
      const replay = e.replay(relabeled.initial, relabeled.history);
      if (relabeled.history.length)
        assert.equal(replay.error.code, 'GAME_ENDED');
      else assertDraw(ok(replay));
    }
  });
}
