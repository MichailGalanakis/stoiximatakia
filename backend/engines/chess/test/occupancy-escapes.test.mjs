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

// Analysis diagrams only: no standard-start history is asserted for these roots.
const fixture = '7k/8/8/1p1p1p1p/pPpPpPpP/P1P1P1P1/6b1/K1B5 w - - 0 1';
const predecessor = '7k/8/8/pp1p1p1p/1PpPpPpP/P1P1P1P1/6b1/K1B5 b - - 0 1';
const closingMove = { type: 'move', from: 'a5', to: 'a4' };
// The alternative pawn capture opens the wall; the promoted queen eventually
// mates with the bishop's support. This proves the predecessor is live.
const predecessorMate =
  'a5b4 c1d2 g2f1 a1b1 b4b3 b1c1 b3b2 c1d1 h8g8 d1e1 g8h8 e1f2 h8g8 f2g1 g8h8 g1h1 b2b1q d2c1 b1c2 c1b2 c2g2'.split(
    ' ',
  );
const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');

function transformFen(fen, mirror, reverse) {
  const position = e.parseFen(fen),
    board = Array(64).fill(null);
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece) continue;
    const f = sq % 8,
      r = sq >> 3;
    board[(reverse ? 7 - r : r) * 8 + (mirror ? 7 - f : f)] = reverse
      ? piece === piece.toUpperCase()
        ? piece.toLowerCase()
        : piece.toUpperCase()
      : piece;
  }
  return e.toFen({
    ...position,
    board,
    turn: reverse
      ? position.turn === 'white'
        ? 'black'
        : 'white'
      : position.turn,
  });
}

function transformMove(move, mirror, reverse) {
  const square = (s) =>
    String.fromCharCode(
      97 + (mirror ? 7 - (s.charCodeAt(0) - 97) : s.charCodeAt(0) - 97),
    ) + (reverse ? 9 - Number(s[1]) : s[1]);
  return {
    type: 'move',
    from: square(move.from),
    to: square(move.to),
    ...(move.promotion ? { promotion: move.promotion } : {}),
  };
}

function assertFinalDraw(state, ply) {
  assert.equal(state.engineVersion, '0.3.0');
  assert.equal(state.initial.mode, 'analysis');
  assert.equal(state.phase, 'ended');
  assert.equal(state.roundOutcome.kind, 'draw');
  assert.equal(state.roundOutcome.reason, 'dead-position-proven');
  assert.equal(state.roundOutcome.ply, ply);
  assert.equal(state.matchOutcome.kind, 'draw');
  assert.equal(state.matchOutcome.reason, 'single-game-complete');
  assert.equal(state.matchOutcome.gameReason, 'dead-position-proven');
  for (const outcome of [state.roundOutcome, state.matchOutcome]) {
    assert.equal(outcome.winner, null);
    assert.equal(outcome.winnerId, null);
    assert.deepEqual(outcome.scores, [
      { playerId: players.white, color: 'white', points: 0.5 },
      { playerId: players.black, color: 'black', points: 0.5 },
    ]);
  }
  assert.equal(ok(e.isPlayStopped(state)), true);
  assert.equal(ok(e.isGameOver(state)), true);
  assert.equal(state.drawOffer, null);
  assert.equal(state.forcedMove, null);
  assert.equal(state.pendingResignation, null);
  assert.deepEqual(e.validateState(state), { valid: true, issues: [] });
  assert.deepEqual(ok(e.restoreState(ok(e.serializeState(state)))), state);
  assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
  assert.deepEqual(ok(cjs.restoreState(JSON.stringify(state))), state);
  assert.deepEqual(ok(cjs.replay(state.initial, state.history)), state);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.history));
  assert.ok(Object.isFrozen(state.matchOutcome.scores));
  for (const actor of [players.white, players.black])
    assert.deepEqual(ok(e.getLegalActions(state, actor)), []);
  for (const viewer of [players.white, players.black, null]) {
    const observation = ok(e.getObservation(state, viewer));
    assert.equal(observation.analysisRoot, true);
    assert.equal(observation.phase, 'ended');
    assert.deepEqual(observation.legalActions, []);
    assert.deepEqual(observation.roundOutcome, state.roundOutcome);
    assert.deepEqual(observation.matchOutcome, state.matchOutcome);
    assert.equal(observation.conformance.exhaustiveDeadPositionOracle, false);
    for (const strategy of ['first-legal', 'capture', 'random']) {
      assert.equal(
        e.chooseBotAction(observation, { strategy, randomState: 42 }).error
          .code,
        'GAME_ENDED',
      );
    }
  }
}

for (const mirror of [false, true])
  for (const reverse of [false, true]) {
    test(`the two-bishop occupancy position ends at creation; mirror=${mirror}, reverse=${reverse}`, () => {
      const fen = transformFen(fixture, mirror, reverse);
      const result = e.createAnalysisGame({ players, fen });
      const state = ok(result);
      assertFinalDraw(state, 0);
      assert.equal(state.revision, 0);
      assert.equal(state.ply, 0);
      assert.deepEqual(state.history, []);
      assert.equal(state.positionHistory.length, 1);
      assert.deepEqual(
        result.events.map((event) => event.type),
        ['game-created', 'round-ended', 'match-ended'],
      );
      assert.deepEqual(result, cjs.createAnalysisGame({ players, fen }));
      assert.deepEqual(e.analyzeDeadPosition(fen, 1), {
        status: 'dead',
        nodes: 1,
        witness: null,
      });
      assert.equal(
        e.proveDeadPosition(state, 1, state.revision).error.code,
        'GAME_ENDED',
      );
      rejected(state, { type: 'resign' }, 'GAME_ENDED', players.white);
      rejected(state, { type: 'offer-draw' }, 'GAME_ENDED', players.black);
    });

    test(`closing the occupancy wall ends in the accepted move; mirror=${mirror}, reverse=${reverse}`, () => {
      const before = setup(transformFen(predecessor, mirror, reverse));
      assert.equal(before.phase, 'playing');
      const action = transformMove(closingMove, mirror, reverse);
      const actor = before.initial.players[before.turn];
      assert.ok(
        ok(e.getLegalActions(before, actor)).some(
          (a) => JSON.stringify(a) === JSON.stringify(action),
        ),
      );
      const immutableBefore = JSON.stringify(before);
      const result = e.applyAction(before, actor, action, before.revision);
      const ended = ok(result);
      assert.equal(JSON.stringify(before), immutableBefore);
      assertFinalDraw(ended, 1);
      assert.equal(ended.revision, before.revision + 1);
      assert.equal(ended.ply, 1);
      assert.equal(ended.positionHistory.length, 2);
      assert.equal(
        e.positionKey(e.parseFen(ended.fen)),
        e.positionKey(e.parseFen(transformFen(fixture, mirror, reverse))),
      );
      assert.deepEqual(ended.history, [
        { kind: 'player', playerId: actor, action },
      ]);
      assert.deepEqual(
        result.events.map((event) => event.type),
        ['move-played', 'round-ended', 'match-ended'],
      );
      assert.deepEqual(result.events[0].move, {
        from: action.from,
        to: action.to,
      });
      assert.equal(result.events[0].playerId, actor);
      assert.deepEqual(result.events[1].outcome, ended.roundOutcome);
      assert.deepEqual(result.events[2].outcome, ended.matchOutcome);
      assert.deepEqual(
        cjs.applyAction(
          JSON.parse(immutableBefore),
          actor,
          action,
          before.revision,
        ),
        result,
      );
      rejected(ended, action, 'GAME_ENDED', actor);
      rejected(
        ended,
        { type: 'claim-draw', reason: 'fifty-move' },
        'GAME_ENDED',
        actor,
      );
      assert.equal(
        e.adjudicate(
          ended,
          {
            type: 'dead-position',
            authority: 'test',
            evidence: 'no overwrite',
          },
          ended.revision,
        ).error.code,
        'GAME_ENDED',
      );
    });

    test(`the precursor's alternative capture and promotion can actually mate; mirror=${mirror}, reverse=${reverse}`, () => {
      const fen = transformFen(predecessor, mirror, reverse);
      const actions = predecessorMate.map((coordinate) =>
        transformMove(
          {
            from: coordinate.slice(0, 2),
            to: coordinate.slice(2, 4),
            ...(coordinate[4] ? { promotion: coordinate[4] } : {}),
          },
          mirror,
          reverse,
        ),
      );
      const witness = actions.map(({ type, ...spec }) => spec);
      const winner = reverse ? 'white' : 'black';
      assert.deepEqual(e.validateMateWitness(fen, winner, witness), witness);
      let state = setup(fen);
      for (let index = 0; index < actions.length; index++) {
        assert.equal(
          state.phase,
          'playing',
          `premature end before witness ply ${index + 1}`,
        );
        assert.equal(
          e.analyzeLockedPosition(state.fen),
          null,
          `false structural proof at witness prefix ${index}`,
        );
        assert.notEqual(e.analyzeDeadPosition(state.fen, 1).status, 'dead');
        state = play(state, actions[index]);
      }
      assert.equal(state.phase, 'ended');
      assert.equal(state.roundOutcome.reason, 'checkmate');
      assert.equal(state.roundOutcome.winner, winner);
      assert.equal(state.roundOutcome.ply, actions.length);
      assert.equal(state.matchOutcome.winnerId, players[winner]);
      assert.equal(
        state.history.filter(
          (record) =>
            record.kind === 'player' && record.action.promotion === 'q',
        ).length,
        1,
      );
      assert.deepEqual(ok(e.restoreState(ok(e.serializeState(state)))), state);
      assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
      assert.deepEqual(ok(cjs.restoreState(JSON.stringify(state))), state);
    });
  }

test('the closing move still requires the correct actor, revision and legal action atomically', () => {
  const before = setup(predecessor);
  rejected(
    before,
    closingMove,
    'STALE_REVISION',
    players.black,
    before.revision + 1,
  );
  rejected(before, closingMove, 'UNKNOWN_PLAYER', 'spectator');
  rejected(before, closingMove, 'NOT_YOUR_TURN', players.white);
  rejected(
    before,
    { type: 'move', from: 'a5', to: 'a3' },
    'ILLEGAL_MOVE',
    players.black,
  );
  rejected(
    before,
    { type: 'dead-position', certificate: e.analyzeLockedPosition(fixture) },
    'INVALID_ACTION',
    players.black,
  );
  assertFinalDraw(play(before, closingMove), 1);
});

test('the forced closing move selected by a bot uses the same transition and clears pending draw state', () => {
  let state = setup(predecessor);
  state = play(state, { type: 'offer-draw' }, players.white);
  const rejectedClaim = e.applyAction(
    state,
    players.black,
    {
      type: 'claim-draw',
      reason: 'fifty-move',
      intendedMove: { from: 'a5', to: 'a4' },
    },
    state.revision,
  );
  state = ok(rejectedClaim);
  assert.ok(
    rejectedClaim.events.some((event) => event.type === 'draw-claim-rejected'),
  );
  assert.equal(state.revision, 2);
  assert.equal(state.ply, 0);
  assert.deepEqual(state.forcedMove, { from: 'a5', to: 'a4' });
  assert.equal(state.drawOffer.by, 'black');
  const restored = ok(e.restoreState(ok(e.serializeState(state))));
  const observation = ok(e.getObservation(restored, players.black));
  const decision = ok(
    e.chooseBotAction(observation, { strategy: 'first-legal' }),
  );
  assert.deepEqual(decision.action, closingMove);
  const result = e.applyAction(
    restored,
    players.black,
    decision.action,
    restored.revision,
  );
  const ended = ok(result);
  assertFinalDraw(ended, 1);
  assert.equal(ended.revision, 3);
  assert.equal(ended.history.length, 3);
  assert.equal(ended.positionHistory.length, 2);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ['move-played', 'round-ended', 'match-ended'],
  );
});

test('restoration and multiplayer actions reject client erasure of an automatic occupancy result', () => {
  const ended = setup(fixture);
  const tampered = JSON.parse(ok(e.serializeState(ended)));
  tampered.phase = 'playing';
  tampered.roundOutcome = null;
  tampered.matchOutcome = null;
  const snapshot = JSON.stringify(tampered);
  assert.equal(e.restoreState(tampered).error.code, 'INVALID_STATE');
  assert.equal(
    e.applyAction(
      tampered,
      players.white,
      { type: 'move', from: 'a1', to: 'b1' },
      tampered.revision,
    ).error.code,
    'INVALID_STATE',
  );
  assert.equal(JSON.stringify(tampered), snapshot);
  assertFinalDraw(ok(e.replay(ended.initial, ended.history)), 0);
});

for (const name of [
  'v0.1.2-occupancy-root',
  'v0.1.2-occupancy-after-move',
  'v0.1.2-standard-root',
]) {
  test(`historical snapshots preserve original engine semantics: ${name}`, () => {
    // Produced and replay-validated with the unmodified v0.1.2 release.
    const state = JSON.parse(
      readFileSync(new URL(`./legacy/${name}.json`, import.meta.url), 'utf8'),
    );
    const immutable = JSON.stringify(state);
    assert.equal(state.engineVersion, '0.1.2');
    assert.equal(e.restoreState(state).error.code, 'UNSUPPORTED_VERSION');
    assert.equal(cjs.restoreState(state).error.code, 'UNSUPPORTED_VERSION');
    assert.equal(
      e.applyAction(
        state,
        players.white,
        { type: 'move', from: 'a1', to: 'b1' },
        state.revision,
      ).error.code,
      'UNSUPPORTED_VERSION',
    );
    assert.equal(JSON.stringify(state), immutable);
    if (name.includes('occupancy')) {
      state.engineVersion = e.ENGINE_VERSION;
      state.rulesVersion = e.RULES_VERSION;
      assert.equal(e.restoreState(state).error.code, 'INVALID_STATE');
      const replayed = e.replay(state.initial, state.history);
      if (state.history.length) assert.equal(replayed.error.code, 'GAME_ENDED');
      else assertFinalDraw(ok(replayed), 0);
    }
  });
}
