import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { it } from 'node:test';
import * as chess from '#engines/chess';
import { ChessProofWorker } from './chess-proof-worker';
import { StrictChessGameRuntime } from './strict-chess-game-runtime';

const participants = [
  { userId: 'white-player', seat: 0 },
  { userId: 'black-player', seat: 1 },
] as const;
const start = (runtime: StrictChessGameRuntime) =>
  runtime.start({
    gameId: 'chess',
    formatId: 'standard',
    participants,
  });
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  return value;
}
class CountedWorker extends ChessProofWorker {
  observations = 0;
  override observeStrict(
    ...args: Parameters<ChessProofWorker['observeStrict']>
  ) {
    this.observations++;
    return super.observeStrict(...args);
  }
}

void it('bootstraps verified strict standard play and serves canonical JSONB-order cache hits without worker/replay work', async (context) => {
  const worker = new CountedWorker(),
    runtime = await StrictChessGameRuntime.create({ worker });
  context.after(async () => {
    await runtime.close();
    await worker.close();
  });
  const before = performance.now(),
    { state, rulesVersion } = start(runtime),
    startMs = performance.now() - before;
  assert.equal(runtime.version, chess.STRICT_ENGINE_VERSION);
  assert.equal(rulesVersion, chess.STRICT_RULES_VERSION);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.decisions.length, 1);
  assert.equal(state.decisions[0]!.evidence.kind, 'reachable-mate');
  assert.deepEqual(state.initial.players, {
    white: 'white-player',
    black: 'black-player',
  });
  const reordered = reverseKeys(state),
    first = runtime.observe({ state: reordered, userId: 'white-player' });
  assert.equal(first.viewerColor, 'white');
  assert.equal(first.conformance.unprovedContinuation, false);
  assert.equal(
    first.conformance.automaticDeadPositionDetection,
    'required-verified-evidence',
  );
  assert.equal(Object.hasOwn(first, 'decisions'), false);
  assert.equal(Object.hasOwn(first, 'history'), false);
  assert.equal(Object.isFrozen(first), true);
  const begin = performance.now();
  for (let i = 0; i < 100; i++)
    assert.equal(
      runtime.observe({ state: reordered, userId: 'white-player' }),
      first,
    );
  context.diagnostic(
    `verified-root start ${startMs.toFixed(3)} ms; canonical warm observe mean ${((performance.now() - begin) / 100).toFixed(3)} ms`,
  );
  assert.equal(worker.observations, 0);
  assert.throws(() => runtime.apply(), { code: 'engine_unavailable' });
  assert.throws(() => runtime.observe({ state, userId: 'outsider' }), {
    code: 'not_participating',
  });
  assert.throws(
    () => runtime.start({ gameId: 'xeri', formatId: 'standard', participants }),
    { code: 'engine_unavailable' },
  );
  assert.throws(
    () =>
      runtime.start({ gameId: 'chess', formatId: 'analysis', participants }),
    { code: 'engine_unavailable' },
  );
});

void it('prepares real worker moves to checkmate and caches both actors with complete strict decision receipts', async (context) => {
  const runtime = await StrictChessGameRuntime.create();
  context.after(() => runtime.close());
  let { state } = start(runtime);
  for (const [index, coordinate] of [
    'f2f3',
    'e7e5',
    'g2g4',
    'd8h4',
  ].entries()) {
    const accepted = await runtime.prepare({
      state: reverseKeys(state),
      userId: state.initial.players[state.turn],
      participants,
      action: {
        type: 'move',
        from: coordinate.slice(0, 2),
        to: coordinate.slice(2, 4),
      },
    });
    assert.equal(accepted.gameplay, true);
    state = accepted.state as chess.StrictChessState;
    assert.equal(state.revision, index + 1);
    for (const userId of ['white-player', 'black-player']) {
      const view = runtime.observe({ state: reverseKeys(state), userId });
      assert.equal(view.viewer, userId);
      assert.equal(view.fen, state.fen);
      assert.equal(view.revision, state.revision);
    }
    if (index === 3)
      assert.deepEqual(accepted.outcome, {
        kind: 'win',
        winnerUserIds: ['black-player'],
        reason: 'checkmate',
      });
    else assert.equal(accepted.outcome, undefined);
  }
  assert.equal(state.phase, 'ended');
  assert.deepEqual(
    state.decisions.map((decision) => decision.revision),
    [0, 1, 2, 3, 4],
  );
  assert.equal(state.matchOutcome?.winnerId, 'black-player');
  assert.deepEqual(
    runtime.observe({ state, userId: 'white-player' }).moves.map((m) => m.san),
    ['f3', 'e5', 'g4', 'Qh4#'],
  );
});

void it('rejects invalid actions/rosters/versions without synchronous fallback or a forged cache view', async (context) => {
  const runtime = await StrictChessGameRuntime.create();
  context.after(() => runtime.close());
  const { state } = start(runtime);
  for (const action of [
    { type: 'move', from: 'e2', to: 'e5' },
    { type: 'resign' },
    { type: 'adjudicate', authority: 'browser' },
  ])
    await assert.rejects(
      runtime.prepare({ state, userId: 'white-player', action, participants }),
      { code: 'invalid_game_action' },
    );
  await assert.rejects(
    runtime.prepare({
      state,
      userId: 'outsider',
      action: { type: 'offer-draw' },
      participants,
    }),
    { code: 'not_participating' },
  );
  await assert.rejects(
    runtime.prepare({
      state,
      userId: 'white-player',
      action: { type: 'offer-draw' },
      participants: [participants[1], participants[1]],
    }),
    { code: 'platform_unavailable' },
  );
  assert.throws(
    () =>
      runtime.observe({
        state: { ...state, engineVersion: '0.3.0' },
        userId: 'white-player',
      }),
    { code: 'engine_unavailable' },
  );
  let getterCalls = 0;
  const accessor = { ...state };
  Object.defineProperty(accessor, 'revision', {
    enumerable: true,
    get() {
      getterCalls++;
      return 0;
    },
  });
  assert.throws(
    () => runtime.observe({ state: accessor, userId: 'white-player' }),
    { code: 'platform_unavailable' },
  );
  assert.equal(getterCalls, 0);
  assert.equal(runtime.observe({ state, userId: 'white-player' }).revision, 0);
});

void it('deduplicates verification-only cold repair, survives eviction and never inserts a tampered receipt', async (context) => {
  const worker = new CountedWorker(),
    runtime = await StrictChessGameRuntime.create({
      worker,
      maxCachedStates: 1,
    });
  context.after(async () => {
    await runtime.close();
    await worker.close();
  });
  const { state } = start(runtime);
  runtime.start({
    gameId: 'chess',
    formatId: 'standard',
    participants: [
      { userId: 'other-white', seat: 0 },
      { userId: 'other-black', seat: 1 },
    ],
  });
  assert.throws(() => runtime.observe({ state, userId: 'white-player' }), {
    code: 'platform_unavailable',
  });
  await Promise.all([
    runtime.warmObservations(reverseKeys(state)),
    runtime.warmObservations(state),
  ]);
  assert.equal(worker.observations, 1);
  assert.equal(
    runtime.observe({ state: reverseKeys(state), userId: 'black-player' })
      .viewerColor,
    'black',
  );
  const tampered = JSON.parse(JSON.stringify(state)) as chess.StrictChessState;
  Object.assign(tampered.decisions[0]!.evidence, { root: 'forged-proof-root' });
  assert.throws(
    () => runtime.observe({ state: tampered, userId: 'white-player' }),
    { code: 'platform_unavailable' },
  );
  await assert.rejects(runtime.warmObservations(tampered), {
    code: 'platform_unavailable',
  });
  assert.equal(worker.observations, 2);
  // Failed jobs leave no permanently pending cache key; a repair can retry.
  await assert.rejects(runtime.warmObservations(tampered), {
    code: 'platform_unavailable',
  });
  assert.equal(worker.observations, 3);
  assert.equal(
    runtime.observe({ state, userId: 'white-player' }).fen,
    chess.START_FEN,
  );
});

void it('enforces the serialized byte budget without evicting a previously valid cache entry for an oversized result', async (context) => {
  const baseline = await StrictChessGameRuntime.create();
  context.after(() => baseline.close());
  const root = start(baseline).state,
    bytes = Buffer.byteLength(
      JSON.stringify(
        participants.map((p) => ({
          userId: p.userId,
          observation: baseline.observe({ state: root, userId: p.userId }),
        })),
      ),
    ),
    runtime = await StrictChessGameRuntime.create({
      maxCachedBytes: bytes + 64,
    });
  context.after(() => runtime.close());
  const normal = start(runtime).state;
  assert.throws(
    () =>
      runtime.start({
        gameId: 'chess',
        formatId: 'standard',
        participants: [
          { userId: 'W'.repeat(100), seat: 0 },
          { userId: 'B'.repeat(100), seat: 1 },
        ],
      }),
    { code: 'platform_unavailable' },
  );
  assert.equal(
    runtime.observe({ state: normal, userId: 'white-player' }).revision,
    0,
  );
});
