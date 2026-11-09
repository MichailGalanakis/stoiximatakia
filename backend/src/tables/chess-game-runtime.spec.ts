import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as chess from '#engines/chess';
import { ChessGameRuntime } from './chess-game-runtime';

const participants = [
  { userId: 'black-player', seat: 1 },
  { userId: 'white-player', seat: 0 },
] as const;
const runtime = new ChessGameRuntime();
const create = () =>
  runtime.start({ gameId: 'chess', formatId: 'standard', participants });
function play(state: chess.ChessState, action: unknown) {
  return runtime.apply({
    state,
    userId: state.initial.players[state.turn],
    action,
    participants,
  });
}
const move = (from: chess.Square, to: chess.Square): chess.MoveAction => ({
  type: 'move',
  from,
  to,
});

void describe('prepared chess table runtime', () => {
  void it('pins the unchanged engine contract and binds white/black to fixed seats', () => {
    const result = create();
    assert.equal(result.rulesVersion, chess.RULES_VERSION);
    assert.equal(result.state.rulesVersion, chess.RULES_VERSION);
    assert.equal(runtime.version, chess.ENGINE_VERSION);
    assert.deepEqual(result.state.initial.players, {
      white: 'white-player',
      black: 'black-player',
    });
    assert.equal(result.state.initial.mode, 'standard');
    assert.equal(result.state.fen, chess.START_FEN);
    for (const changed of [
      { gameId: 'xeri' as const, formatId: 'standard', participants },
      { gameId: 'chess' as const, formatId: 'analysis', participants },
    ])
      assert.throws(() => runtime.start(changed), {
        code: 'engine_unavailable',
      });
    for (const roster of [
      [participants[0]],
      [participants[0], participants[0]],
      [
        { userId: 'white-player', seat: 0 },
        { userId: 'white-player', seat: 1 },
      ],
      [
        { userId: 'white-player', seat: 0 },
        { userId: 'black-player', seat: 2 },
      ],
    ])
      assert.throws(
        () =>
          runtime.start({
            gameId: 'chess',
            formatId: 'standard',
            participants: roster,
          }),
        { code: 'platform_unavailable' },
      );
  });

  void it('whitelists participant observations and never offers engine adjudication', () => {
    const { state } = create();
    for (const userId of ['white-player', 'black-player']) {
      const view = runtime.observe({ state, userId });
      assert.equal(view.viewer, userId);
      assert.equal(
        view.viewerColor,
        userId === 'white-player' ? 'white' : 'black',
      );
      assert.equal(view.rulesVersion, chess.RULES_VERSION);
      assert.equal(view.conformance.exhaustiveDeadPositionOracle, false);
      assert.equal(
        view.legalActions.some((a) => a.type === 'resign'),
        false,
      );
      for (const key of [
        'initial',
        'history',
        'positionHistory',
        'pendingResignation',
      ])
        assert.equal(Object.hasOwn(view, key), false);
    }
    assert.throws(() => runtime.observe({ state, userId: 'outsider' }), {
      code: 'not_participating',
    });
  });

  void it('restores authoritative state and rejects actors, illegal moves and extra authority', () => {
    const { state } = create(),
      saved = JSON.stringify(state),
      accepted = play(JSON.parse(saved) as chess.ChessState, move('e2', 'e4'));
    assert.equal(accepted.gameplay, true);
    assert.equal(accepted.state.revision, 1);
    assert.equal(accepted.state.ply, 1);
    assert.equal(accepted.outcome, undefined);
    assert.equal(JSON.stringify(state), saved);
    for (const [userId, action, code] of [
      ['outsider', move('e2', 'e4'), 'not_participating'],
      ['black-player', move('e7', 'e5'), 'invalid_game_action'],
      ['white-player', move('e2', 'e5'), 'invalid_game_action'],
      [
        'white-player',
        { ...move('e2', 'e4'), winnerId: 'white-player' },
        'invalid_game_action',
      ],
      ['white-player', { type: 'resign' }, 'invalid_game_action'],
      [
        'white-player',
        { type: 'dead-position', authority: 'browser', evidence: 'draw' },
        'invalid_game_action',
      ],
    ] as const)
      assert.throws(
        () => runtime.apply({ state, userId, action, participants }),
        { code },
      );
    assert.throws(
      () =>
        runtime.apply({
          state,
          userId: 'white-player',
          action: move('e2', 'e4'),
          participants: [
            { userId: 'white-player', seat: 1 },
            { userId: 'black-player', seat: 0 },
          ],
        }),
      { code: 'platform_unavailable' },
    );
  });

  void it('refuses tampered, old, analysis and backend-adjudicated histories', () => {
    const { state } = create();
    for (const changed of [
      { ...state, fen: state.fen.replace(' w ', ' b ') },
      { ...state, ply: 5 },
      { ...state, matchOutcome: { kind: 'win', winnerId: 'white-player' } },
    ])
      assert.throws(
        () => runtime.observe({ state: changed, userId: 'white-player' }),
        { code: 'platform_unavailable' },
      );
    assert.throws(
      () =>
        runtime.observe({
          state: { ...state, engineVersion: 'old' },
          userId: 'white-player',
        }),
      { code: 'engine_unavailable' },
    );
    const analysis = chess.createAnalysisGame({
      players: state.initial.players,
      fen: chess.START_FEN,
    });
    assert.ok(analysis.ok);
    assert.throws(
      () => runtime.observe({ state: analysis.state, userId: 'white-player' }),
      { code: 'platform_unavailable' },
    );
    const adjudicated = chess.adjudicate(
      state,
      {
        type: 'dead-position',
        authority: 'trusted-test',
        evidence: 'adapter rejects even authentic adjudication',
      },
      0,
    );
    assert.ok(adjudicated.ok);
    assert.throws(
      () =>
        runtime.observe({ state: adjudicated.state, userId: 'white-player' }),
      { code: 'platform_unavailable' },
    );
  });

  void it('maps a complete standard checkmate to the fixed winning participant', () => {
    let { state } = create();
    for (const action of [move('f2', 'f3'), move('e7', 'e5'), move('g2', 'g4')])
      state = play(state, action).state;
    const accepted = play(state, move('d8', 'h4'));
    assert.deepEqual(accepted.outcome, {
      kind: 'win',
      winnerUserIds: ['black-player'],
      reason: 'checkmate',
    });
    assert.equal(accepted.state.phase, 'ended');
    assert.equal(accepted.state.ply, 4);
    assert.equal(
      runtime.observe({ state: accepted.state, userId: 'white-player' })
        .legalActions.length,
      0,
    );
    assert.throws(() => play(accepted.state, move('e2', 'e4')), {
      code: 'match_ended',
    });
    assert.ok(
      chess.restoreState(JSON.parse(JSON.stringify(accepted.state)) as unknown)
        .ok,
    );
  });

  void it('counts offers and responses as gameplay and settles agreement as a draw', () => {
    let { state } = create();
    state = play(state, move('e2', 'e4')).state;
    state = play(state, move('e7', 'e5')).state;
    const offered = runtime.apply({
      state,
      userId: 'white-player',
      action: { type: 'offer-draw' },
      participants,
    });
    assert.equal(offered.gameplay, true);
    assert.equal(offered.state.ply, 2);
    assert.equal(offered.state.revision, 3);
    const declined = runtime.apply({
      state: offered.state,
      userId: 'black-player',
      action: { type: 'decline-draw' },
      participants,
    });
    assert.equal(declined.gameplay, true);
    const renewed = runtime.apply({
      state: declined.state,
      userId: 'black-player',
      action: { type: 'offer-draw' },
      participants,
    });
    const accepted = runtime.apply({
      state: renewed.state,
      userId: 'white-player',
      action: { type: 'accept-draw' },
      participants,
    });
    assert.deepEqual(accepted.outcome, {
      kind: 'draw',
      reason: 'draw-agreement',
    });
    assert.equal(accepted.state.phase, 'ended');
  });

  void it('accepts a valid intended-move repetition claim without executing that move', () => {
    let { state } = create();
    const cycle = [
      move('g1', 'f3'),
      move('g8', 'f6'),
      move('f3', 'g1'),
      move('f6', 'g8'),
    ];
    for (const action of [...cycle, ...cycle.slice(0, 3)])
      state = play(state, action).state;
    const accepted = runtime.apply({
      state,
      userId: 'black-player',
      action: {
        type: 'claim-draw',
        reason: 'threefold-repetition',
        intendedMove: { from: 'f6', to: 'g8' },
      },
      participants,
    });
    assert.equal(accepted.gameplay, true);
    assert.equal(accepted.state.ply, 7);
    assert.deepEqual(accepted.outcome, {
      kind: 'draw',
      reason: 'threefold-repetition',
    });
  });
});
