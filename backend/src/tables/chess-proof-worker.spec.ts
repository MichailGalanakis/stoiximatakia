import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as chess from '#engines/chess';
import {
  ChessProofWorker,
  ChessProofWorkerError,
  chessSnapshotDigest,
} from './chess-proof-worker';

const mate = '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1';
const dead = '7k/8/8/8/8/8/8/K7 w - - 0 1';
const hardLive = '1Bb5/1p6/pPp3k1/2Pp3p/P2PpBpP/4P1P1/5K2/8 w - - 0 1';
void describe('unwired chess proof worker', () => {
  void it('solves and verifies root mate, dead closure and a normal live witness off-loop', async () => {
    const worker = new ChessProofWorker();
    try {
      for (const [fen, expected] of [
        [mate, 'not-dead'],
        [dead, 'dead'],
        [chess.START_FEN, 'not-dead'],
      ] as const) {
        const result = await worker.solve(fen);
        assert.equal(result.status, expected);
        const checked = chess.verifyReachabilityDecision(fen, result.evidence);
        assert.equal(checked.valid, true);
        assert.ok(Object.isFrozen(result));
        assert.ok(Object.isFrozen(result.evidence));
        assert.equal(worker.activeCount, 0);
      }
    } finally {
      await worker.close();
    }
  });
  void it('verification-only workers reject wrong roots/versions, forged closure and malformed input', async () => {
    const worker = new ChessProofWorker();
    const proof = chess.solveMateReachabilityExactly(dead).evidence;
    try {
      for (const evidence of [
        { ...proof, root: 'other-root' },
        { ...proof, engineVersion: 'old' },
        { ...proof, rulesVersion: 'other-rules' },
        {
          ...proof,
          nodes: [
            {
              position: chess.positionKey(chess.parseFen(chess.START_FEN)),
              leaf: 'material',
              successors: [],
            },
          ],
        },
        {
          kind: 'reachable-mate',
          engineVersion: chess.ENGINE_VERSION,
          rulesVersion: chess.RULES_VERSION,
          root: proof.root,
          winner: 'white',
          moves: [],
        },
        null,
      ]) {
        await assert.rejects(worker.verify(dead, evidence), {
          code: 'proof_failed',
        });
        assert.equal(worker.activeCount, 0);
      }
      await assert.rejects(worker.verify(chess.START_FEN, proof), {
        code: 'proof_failed',
      });
      await assert.rejects(worker.solve('not a FEN'), {
        code: 'proof_binding',
      });
      await assert.rejects(worker.verify(dead, 'x'.repeat(16_000_001)), {
        code: 'proof_resource',
      });
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      await assert.rejects(worker.verify(dead, cyclic), {
        code: 'proof_failed',
      });
      const verified = await worker.verify(dead, proof);
      assert.equal(verified.status, 'dead');
      assert.equal(worker.activeCount, 0);
    } finally {
      await worker.close();
    }
  });
  void it('snapshots verification input before callers can mutate it', async () => {
    const worker = new ChessProofWorker();
    try {
      const proof = JSON.parse(
        JSON.stringify(chess.solveMateReachabilityExactly(dead).evidence),
      ) as Record<string, unknown>;
      const pending = worker.verify(dead, proof);
      proof.root = 'changed-after-dispatch';
      const result = await pending;
      assert.equal(result.status, 'dead');
      assert.notEqual(result.evidence.root, proof.root);
    } finally {
      await worker.close();
    }
  });
  void it('keeps the main event loop responsive and aborts without returning an unknown or outcome', async () => {
    const worker = new ChessProofWorker(),
      controller = new AbortController();
    let settled = false;
    const pending = worker.solve(hardLive, { signal: controller.signal });
    const rejected = assert.rejects(pending, { code: 'proof_cancelled' });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      assert.equal(
        settled,
        false,
        'CPU search must not monopolize the calling event loop',
      );
      assert.equal(worker.activeCount, 1);
      controller.abort();
      await rejected;
      assert.equal(worker.activeCount, 0);
      assert.equal((await worker.solve(dead)).status, 'dead');
    } finally {
      await worker.close();
    }
  });
  void it('bounds worker admission without a queue and waits for shutdown cleanup', async () => {
    const worker = new ChessProofWorker(),
      controller = new AbortController();
    const pending = worker.solve(hardLive, { signal: controller.signal });
    const rejected = assert.rejects(pending, { code: 'proof_closed' });
    assert.equal(worker.activeCount, 1);
    await assert.rejects(worker.solve(dead), { code: 'proof_capacity' });
    await worker.onModuleDestroy();
    await rejected;
    assert.equal(worker.activeCount, 0);
    await assert.rejects(worker.solve(dead), { code: 'proof_closed' });
    await worker.close();
    const preAborted = new AbortController();
    preAborted.abort();
    const another = new ChessProofWorker();
    try {
      await assert.rejects(another.solve(dead, { signal: preAborted.signal }), {
        code: 'proof_cancelled',
      });
      assert.equal(another.activeCount, 0);
    } finally {
      await another.close();
    }
  });
  void it('rejects unsafe operational resource configurations', () => {
    assert.throws(
      () => new ChessProofWorker({ maxMemoryMb: 1 }),
      ChessProofWorkerError,
    );
    assert.throws(() => new ChessProofWorker({ maxMemoryMb: Infinity }), {
      code: 'proof_resource',
    });
  });
});

const strictParticipants = [
  { userId: 'white-player', seat: 0 },
  { userId: 'black-player', seat: 1 },
] as const;
function strictInitial() {
  const prepared = chess.prepareStrictGame({
    players: { white: 'white-player', black: 'black-player' },
  });
  assert.ok(prepared.ok);
  // A concrete four-ply standard-start witness, never a guessed live result.
  const result = chess.finishStrictCandidate(prepared.value, {
    kind: 'reachable-mate',
    engineVersion: chess.ENGINE_VERSION,
    rulesVersion: chess.RULES_VERSION,
    root: chess.positionKey(chess.parseFen(chess.START_FEN)),
    winner: 'black',
    moves: [
      { from: 'f2', to: 'f3' },
      { from: 'e7', to: 'e5' },
      { from: 'g2', to: 'g4' },
      { from: 'd8', to: 'h4' },
    ],
  });
  assert.ok(result.ok);
  return result.state;
}
void describe('whole experimental strict-profile worker jobs', () => {
  void it('binds canonical JSON digests and rejects non-JSON/coercing snapshots', () => {
    assert.equal(
      chessSnapshotDigest({ b: [2, 3], a: 1 }),
      chessSnapshotDigest({ a: 1, b: [2, 3] }),
    );
    assert.notEqual(chessSnapshotDigest([2, 3]), chessSnapshotDigest([3, 2]));
    let reads = 0;
    for (const value of [
      undefined,
      NaN,
      Infinity,
      new Date(),
      [undefined],
      Array(1),
      { a: undefined },
      {
        get a() {
          reads++;
          return 1;
        },
      },
      Object.assign({}, { [Symbol('hidden')]: 1 }),
    ])
      assert.throws(() => chessSnapshotDigest(value));
    assert.equal(reads, 0, 'digest must not invoke getters');
  });
  void it('prepares a strict move and both same-state observations entirely inside one worker', async () => {
    const worker = new ChessProofWorker();
    try {
      const input = {
        state: strictInitial(),
        userId: 'white-player',
        action: { type: 'move', from: 'e2', to: 'e4' },
        participants: strictParticipants,
      };
      const result = await worker.prepareStrictAction(input);
      const state = result.accepted.state as chess.StrictChessState;
      assert.equal(result.sourceHash, chessSnapshotDigest(input));
      assert.equal(result.stateHash, chessSnapshotDigest(state));
      assert.equal(result.engineVersion, chess.STRICT_ENGINE_VERSION);
      assert.equal(result.proofEngineVersion, chess.ENGINE_VERSION);
      assert.equal(state.revision, 1);
      assert.equal(result.accepted.gameplay, true);
      assert.equal(result.accepted.outcome, undefined);
      assert.equal(result.observations.length, 2);
      for (const [seat, entry] of result.observations.entries()) {
        assert.equal(entry.userId, strictParticipants[seat]!.userId);
        assert.equal(entry.observation.viewer, entry.userId);
        assert.equal(
          entry.observation.viewerColor,
          seat === 0 ? 'white' : 'black',
        );
        assert.equal(entry.observation.revision, state.revision);
        assert.equal(entry.observation.fen, state.fen);
        assert.equal(entry.observation.moves[0]!.san, 'e4');
        assert.equal(Object.hasOwn(entry.observation, 'decisions'), false);
      }
      assert.ok(Object.isFrozen(state));
      assert.ok(Object.isFrozen(result.observations));
      const coldInput = {
        state: JSON.parse(JSON.stringify(state)) as unknown,
        participants: strictParticipants,
      };
      const cold = await worker.observeStrict(coldInput);
      assert.deepEqual(cold.observations, result.observations);
      assert.equal(cold.sourceHash, chessSnapshotDigest(coldInput));
      assert.equal(cold.stateHash, result.stateHash);
      assert.equal(Object.hasOwn(cold, 'accepted'), false);
      assert.equal(worker.activeCount, 0);
    } finally {
      await worker.close();
    }
  });
  void it('returns only the roster-bound final outcome and durable SAN after a complete mate', async () => {
    const worker = new ChessProofWorker();
    let state = strictInitial();
    try {
      const sequence = [
        ['f2', 'f3'],
        ['e7', 'e5'],
        ['g2', 'g4'],
        ['d8', 'h4'],
      ] as const;
      for (const [from, to] of sequence) {
        const result = await worker.prepareStrictAction({
          state,
          userId: state.initial.players[state.turn],
          action: { type: 'move', from, to },
          participants: strictParticipants,
        });
        state = result.accepted.state as chess.StrictChessState;
        if (state.phase === 'ended') {
          assert.deepEqual(result.accepted.outcome, {
            kind: 'win',
            winnerUserIds: ['black-player'],
            reason: 'checkmate',
          });
          for (const entry of result.observations)
            assert.deepEqual(
              entry.observation.moves.map((m) => m.san),
              ['f3', 'e5', 'g4', 'Qh4#'],
            );
        } else assert.equal(result.accepted.outcome, undefined);
      }
      assert.equal(state.phase, 'ended');
    } finally {
      await worker.close();
    }
  });
  void it('rejects stale profile/evidence/roster/actor/illegal commands without any accepted output', async () => {
    const worker = new ChessProofWorker();
    const initial = strictInitial();
    try {
      for (const state of [
        { ...initial, engineVersion: 'old' },
        { ...initial, rulesVersion: 'old' },
        { ...initial, decisions: [] },
        {
          ...initial,
          decisions: [
            {
              ...initial.decisions[0],
              evidence: { ...initial.decisions[0]!.evidence, root: 'tampered' },
            },
          ],
        },
      ])
        await assert.rejects(
          worker.observeStrict({ state, participants: strictParticipants }),
          { code: 'proof_failed' },
        );
      await assert.rejects(
        worker.observeStrict({
          state: initial,
          participants: [
            { userId: 'black-player', seat: 0 },
            { userId: 'white-player', seat: 1 },
          ],
        }),
        { code: 'proof_failed' },
      );
      for (const [userId, action] of [
        ['outsider', { type: 'move', from: 'e2', to: 'e4' }],
        ['white-player', { type: 'move', from: 'e2', to: 'e5' }],
        ['white-player', { type: 'resign' }],
        ['white-player', { type: 'adjudication' }],
      ] as const)
        await assert.rejects(
          worker.prepareStrictAction({
            state: initial,
            userId,
            action,
            participants: strictParticipants,
          }),
          { code: 'proof_failed' },
        );
      assert.equal(worker.activeCount, 0);
    } finally {
      await worker.close();
    }
  });
  void it('snapshots a strict command before callers mutate its actor/action/roster', async () => {
    const worker = new ChessProofWorker();
    try {
      const input = {
        state: strictInitial(),
        userId: 'white-player',
        action: { type: 'move', from: 'e2', to: 'e4' },
        participants: [...strictParticipants].map<{
          userId: string;
          seat: number;
        }>((p) => ({ ...p })),
      };
      const sourceHash = chessSnapshotDigest(input),
        pending = worker.prepareStrictAction(input);
      input.userId = 'outsider';
      input.action.to = 'e5';
      input.participants[0]!.userId = 'different';
      const result = await pending;
      assert.equal(result.sourceHash, sourceHash);
      assert.equal(
        (result.accepted.state as chess.StrictChessState).history[0]!.playerId,
        'white-player',
      );
      assert.equal(result.observations[0]!.observation.moves[0]!.san, 'e4');
    } finally {
      await worker.close();
    }
  });
});

void it('strict workers classify all accepted draw/control decisions as gameplay and map an agreed draw', async () => {
  const worker = new ChessProofWorker();
  let state = strictInitial();
  try {
    const actions = [
      [
        'white-player',
        {
          type: 'claim-draw',
          reason: 'threefold-repetition',
          intendedMove: { from: 'e2', to: 'e4' },
        },
      ],
      // A rejected claim already carries a draw offer under the engine contract.
      ['black-player', { type: 'decline-draw' }],
      ['white-player', { type: 'move', from: 'e2', to: 'e4' }],
      ['black-player', { type: 'move', from: 'e7', to: 'e5' }],
      ['white-player', { type: 'offer-draw' }],
      ['black-player', { type: 'accept-draw' }],
    ] as const;
    for (const [userId, action] of actions) {
      const result = await worker.prepareStrictAction({
        state,
        userId,
        action,
        participants: strictParticipants,
      });
      assert.equal(result.accepted.gameplay, true);
      state = result.accepted.state as chess.StrictChessState;
      if (action.type === 'accept-draw')
        assert.deepEqual(result.accepted.outcome, {
          kind: 'draw',
          reason: 'draw-agreement',
        });
    }
    assert.equal(state.phase, 'ended');
    assert.equal(state.ply, 2);
  } finally {
    await worker.close();
  }
});
