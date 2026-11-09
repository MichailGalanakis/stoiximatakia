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
const fixtures = JSON.parse(
  readFileSync(
    new URL('./castling-proof-fixtures.json', import.meta.url),
    'utf8',
  ),
);
const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
const swap = (value) =>
  value === value.toUpperCase() ? value.toLowerCase() : value.toUpperCase();
const square = (value, reverse) =>
  reverse ? value[0] + (9 - Number(value[1])) : value;
const action = (coordinate, reverse = false) => ({
  type: 'move',
  from: square(coordinate.slice(0, 2), reverse),
  to: square(coordinate.slice(2, 4), reverse),
  ...(coordinate[4] ? { promotion: coordinate[4] } : {}),
});

// Reflection in the ranks plus color reversal preserves e1/e8 and all standard
// castling files. A horizontal mirror would move the king to d1/d8 and is not used.
function transformFen(fen, reverse) {
  if (!reverse) return fen;
  const p = e.parseFen(fen),
    board = Array(64).fill(null);
  for (let index = 0; index < 64; index++)
    if (p.board[index])
      board[(7 - (index >> 3)) * 8 + (index % 8)] = swap(p.board[index]);
  const rights = [...p.castling].map(swap);
  return e.toFen({
    ...p,
    board,
    turn: p.turn === 'white' ? 'black' : 'white',
    castling: [...'KQkq'].filter((right) => rights.includes(right)).join(''),
    ep: p.ep === null ? null : (7 - (p.ep >> 3)) * 8 + (p.ep % 8),
  });
}

function assertDraw(state, fen, ply) {
  assert.equal(state.engineVersion, '0.3.0');
  assert.equal(state.initial.mode, 'analysis');
  assert.equal(state.phase, 'ended');
  assert.equal(state.fen, fen);
  assert.equal(state.roundOutcome.reason, 'dead-position-proven');
  assert.equal(state.roundOutcome.ply, ply);
  for (const result of [state.roundOutcome, state.matchOutcome]) {
    assert.equal(result.kind, 'draw');
    assert.equal(result.winner, null);
    assert.equal(result.winnerId, null);
    assert.deepEqual(
      result.scores.map((score) => score.points),
      [0.5, 0.5],
    );
  }
  assert.equal(state.matchOutcome.gameReason, 'dead-position-proven');
  assert.equal(ok(e.isGameOver(state)), true);
  assert.equal(ok(e.isPlayStopped(state)), true);
  assert.deepEqual(ok(e.restoreState(ok(e.serializeState(state)))), state);
  assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
  assert.deepEqual(ok(cjs.restoreState(JSON.stringify(state))), state);
  assert.deepEqual(ok(cjs.replay(state.initial, state.history)), state);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.history));
  for (const viewer of [players.white, players.black, null]) {
    const view = ok(e.getObservation(state, viewer));
    assert.equal(view.phase, 'ended');
    assert.equal(view.analysisRoot, true);
    assert.deepEqual(view.legalActions, []);
    assert.equal(view.conformance.exhaustiveDeadPositionOracle, false);
    for (const strategy of ['first-legal', 'capture', 'random'])
      assert.equal(
        e.chooseBotAction(view, { strategy, randomState: 42 }).error.code,
        'GAME_ENDED',
      );
  }
}

for (const f of fixtures.dead)
  for (const reverse of [false, true]) {
    test(`permanently blocked castling cannot delay a dead draw: ${f.id}; reverse=${reverse}`, () => {
      const fen = transformFen(f.fen, reverse),
        right = reverse ? swap(f.right) : f.right;
      const result = e.createAnalysisGame({ players, fen }),
        state = ok(result);
      assertDraw(state, fen, 0);
      assert.equal(state.revision, 0);
      assert.equal(state.ply, 0);
      assert.deepEqual(state.history, []);
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
      const certificate = e.analyzeLockedPosition(fen);
      const exclusion = certificate.castlingExclusions.find(
        (entry) => entry.right === right,
      );
      assert.ok(
        exclusion.blockers.includes(square(f.permanentBlocker, reverse)),
      );
      // Logical irrelevance to this proof does not erase the historical entitlement.
      assert.equal(state.fen.split(' ')[2], right);
      assert.equal(state.initial.fen.split(' ')[2], right);
      assert.equal(state.positionHistory[0].split(' ')[2], right);
      const withoutRights = { ...e.parseFen(fen), castling: '' };
      assert.notEqual(
        e.positionKey(e.parseFen(fen)),
        e.positionKey(withoutRights),
      );
      rejected(
        state,
        action('e1d1', reverse),
        'GAME_ENDED',
        state.initial.players[state.turn],
      );
      assert.equal(
        e.proveDeadPosition(state, 2048, state.revision).error.code,
        'GAME_ENDED',
      );
    });
  }

for (const f of fixtures.closings)
  for (const reverse of [false, true]) {
    test(`a pawn closes the cage while the castling flag remains recorded: ${f.id}; reverse=${reverse}`, () => {
      const before = setup(transformFen(f.fen, reverse)),
        move = action(f.move, reverse);
      assert.equal(before.phase, 'playing');
      const frozen = JSON.stringify(before),
        actor = before.initial.players[before.turn];
      rejected(before, move, 'STALE_REVISION', actor, before.revision + 1);
      rejected(before, move, 'UNKNOWN_PLAYER', 'spectator');
      rejected(
        before,
        move,
        'NOT_YOUR_TURN',
        actor === players.white ? players.black : players.white,
      );
      const result = e.applyAction(before, actor, move, before.revision),
        after = ok(result);
      assert.equal(JSON.stringify(before), frozen);
      assertDraw(after, after.fen, 1);
      const target = transformFen(
        fixtures.dead.find((entry) => entry.id === f.target).fen,
        reverse,
      );
      assert.equal(
        e.positionKey(e.parseFen(after.fen)),
        e.positionKey(e.parseFen(target)),
      );
      assert.equal(after.fen.split(' ')[2], before.fen.split(' ')[2]);
      assert.equal(after.revision, before.revision + 1);
      assert.equal(after.ply, 1);
      assert.equal(after.positionHistory.length, 2);
      assert.deepEqual(after.history, [
        { kind: 'player', playerId: actor, action: move },
      ]);
      assert.deepEqual(
        result.events.map((event) => event.type),
        ['move-played', 'round-ended', 'match-ended'],
      );
      assert.deepEqual(
        cjs.applyAction(JSON.parse(frozen), actor, move, before.revision),
        result,
      );
      rejected(
        after,
        action('e1d1', reverse),
        'GAME_ENDED',
        after.initial.players[after.turn],
      );
    });
  }

for (const f of fixtures.live)
  for (const reverse of [false, true]) {
    test(`a temporary obstruction or attack preserves eventual castling mate: ${f.id}; reverse=${reverse}`, () => {
      const fen = transformFen(f.fen, reverse),
        winner = reverse ? 'black' : 'white';
      const moves = f.witness.map((coordinate) => action(coordinate, reverse));
      const witness = moves.map(({ type, ...spec }) => spec);
      assert.deepEqual(e.validateMateWitness(fen, winner, witness), witness);
      let state = setup(fen);
      const originalRights = state.fen.split(' ')[2],
        castle = action(f.castle, reverse);
      assert.equal(
        ok(e.getLegalActions(state, state.initial.players[state.turn])).some(
          (move) =>
            move.type === 'move' &&
            move.from === castle.from &&
            move.to === castle.to,
        ),
        f.initiallyLegalCastle,
      );
      if (!f.initiallyLegalCastle) rejected(state, castle, 'ILLEGAL_MOVE');
      for (let index = 0; index < moves.length; index++) {
        assert.equal(state.phase, 'playing');
        assert.equal(e.analyzeLockedPosition(state.fen), null);
        assert.notEqual(e.analyzeDeadPosition(state.fen, 1).status, 'dead');
        assert.equal(state.fen.split(' ')[2], originalRights);
        state = ok(e.restoreState(JSON.stringify(state)));
        const result = e.applyAction(
          state,
          state.initial.players[state.turn],
          moves[index],
          state.revision,
        );
        state = ok(result);
        if (index === moves.length - 1) {
          assert.match(result.events[0].san, /^O-O(?:-O)?#$/);
          assert.deepEqual(
            result.events.map((event) => event.type),
            ['move-played', 'round-ended', 'match-ended'],
          );
        }
      }
      assert.equal(state.roundOutcome.reason, 'checkmate');
      assert.equal(state.roundOutcome.winner, winner);
      assert.equal(state.fen.split(' ')[2], '-');
      assert.deepEqual(ok(e.restoreState(ok(e.serializeState(state)))), state);
      assert.deepEqual(ok(e.replay(state.initial, state.history)), state);
      assert.deepEqual(ok(cjs.restoreState(JSON.stringify(state))), state);
    });
  }

for (const reverse of [false, true])
  test(`inactive en-passant and permanent castling exclusions preserve their different identity rules; reverse=${reverse}`, () => {
    const fen = transformFen(fixtures.unusableEp.fen, reverse),
      state = setup(fen);
    assertDraw(state, fen, 0);
    const certificate = e.analyzeLockedPosition(fen);
    assert.equal(
      certificate.unusableEnPassant,
      square(fixtures.unusableEp.ep, reverse),
    );
    assert.equal(
      state.fen.split(' ')[3],
      square(fixtures.unusableEp.ep, reverse),
    );
    assert.equal(state.positionHistory[0].split(' ')[3], '-');
    assert.equal(state.positionHistory[0].split(' ')[2], reverse ? 'q' : 'Q');
    assert.deepEqual(e.analyzeDeadPosition(fen, 1), {
      status: 'dead',
      nodes: 1,
      witness: null,
    });
  });

test('castling-exclusion diagnostics cannot erase rights, mutate engine decisions, or authorize a player', () => {
  const f = fixtures.dead[0],
    certificate = e.analyzeLockedPosition(f.fen);
  certificate.castlingExclusions[0].blockers.length = 0;
  certificate.castlingExclusions.length = 0;
  assert.ok(e.analyzeLockedPosition(f.fen).castlingExclusions.length);
  assert.equal(setup(f.fen).fen, f.fen);
  const live = setup(fixtures.live[0].fen);
  rejected(live, { type: 'dead-position', certificate }, 'INVALID_ACTION');
  assert.equal(live.fen.split(' ')[2], 'K');
});

test('a pending intended-move claim does not delay a castling-cage draw or strip its right', () => {
  let state = setup(fixtures.closings[0].fen);
  state = play(state, {
    type: 'claim-draw',
    reason: 'fifty-move',
    intendedMove: { from: 'd4', to: 'd3' },
  });
  assert.equal(state.phase, 'playing');
  assert.deepEqual(state.forcedMove, { from: 'd4', to: 'd3' });
  const result = e.applyAction(
      state,
      players.black,
      action('d4d3'),
      state.revision,
    ),
    after = ok(result);
  assertDraw(after, after.fen, 1);
  assert.equal(after.revision, 2);
  assert.equal(after.fen.split(' ')[2], 'Q');
  assert.equal(after.forcedMove, null);
  assert.equal(after.drawOffer, null);
});

for (const name of [
  'v0.1.3-castling-root',
  'v0.1.3-castling-after-e1-d1',
  'v0.1.3-standard-root',
]) {
  test(`authentic historical castling semantics require their original engine: ${name}`, () => {
    const legacy = JSON.parse(
      readFileSync(new URL(`./legacy/${name}.json`, import.meta.url), 'utf8'),
    );
    assert.equal(legacy.engineVersion, '0.1.3');
    assert.equal(e.restoreState(legacy).error.code, 'UNSUPPORTED_VERSION');
    assert.equal(cjs.restoreState(legacy).error.code, 'UNSUPPORTED_VERSION');
    assert.equal(
      e.applyAction(legacy, players.white, action('e1d1'), legacy.revision)
        .error.code,
      'UNSUPPORTED_VERSION',
    );
    if (name.includes('castling')) {
      legacy.engineVersion = e.ENGINE_VERSION;
      legacy.rulesVersion = e.RULES_VERSION;
      assert.equal(e.restoreState(legacy).error.code, 'INVALID_STATE');
      const replay = e.replay(legacy.initial, legacy.history);
      if (legacy.history.length) assert.equal(replay.error.code, 'GAME_ENDED');
      else assertDraw(ok(replay), legacy.initial.fen, 0);
    }
  });
}
