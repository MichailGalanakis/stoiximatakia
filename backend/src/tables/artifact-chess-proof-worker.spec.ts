import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, it, type TestContext } from 'node:test';
import * as chess from '#engines/chess';
import {
  ArtifactChessProofWorker,
  ArtifactChessProofWorkerError,
} from './artifact-chess-proof-worker';
import { chessSnapshotDigest } from './chess-proof-json';

const participants = [
    { userId: 'alice', seat: 0 },
    { userId: 'bob', seat: 1 },
  ],
  players = { white: 'alice', black: 'bob' },
  connectionString =
    'postgres://private-user:private-secret@127.0.0.1:1/private-db',
  nodeWorkers = createRequire(__filename)(
    'node:worker_threads',
  ) as typeof import('node:worker_threads');
const pins = {
  schemaVersion: 3,
  engineVersion: chess.ARTIFACT_ENGINE_VERSION,
  rulesVersion: chess.ARTIFACT_RULES_VERSION,
  proofEngineVersion: chess.ENGINE_VERSION,
  proofRulesVersion: chess.RULES_VERSION,
  proofFormat: chess.REACHABILITY_STREAM_FORMAT,
};
const unwrap = <T>(result: chess.Result<T>): T => {
  if (!result.ok) assert.fail(result.error.code);
  return result.value;
};
async function initialFixture() {
  const candidate = unwrap(chess.prepareArtifactGame({ players })),
    header = JSON.stringify({
      format: chess.REACHABILITY_STREAM_FORMAT,
      kind: 'reachable-mate',
      engineVersion: chess.ENGINE_VERSION,
      rulesVersion: chess.RULES_VERSION,
      root: candidate.root,
      winner: 'black',
    }),
    moves = ['f2f3', 'e7e5', 'g2g4', 'd8h4'].map((move) => ({
      from: move.slice(0, 2),
      to: move.slice(2),
    }));
  async function* records() {
    for (const move of moves) yield await Promise.resolve(JSON.stringify(move));
  }
  const token = await chess.verifyStreamingReachability(
    candidate.fen,
    header,
    records(),
  );
  assert.equal(token.valid, true);
  const binding = unwrap(
      chess.bindVerifiedArtifact(token, {
        artifactId: createHash('sha256').update(header).digest('hex'),
        root: candidate.root,
        kernelEngineVersion: chess.ENGINE_VERSION,
        kernelRulesVersion: chess.RULES_VERSION,
        format: chess.REACHABILITY_STREAM_FORMAT,
      }),
    ),
    transition = chess.finishArtifactCandidate(candidate, binding);
  if (!transition.ok) assert.fail(transition.error.code);
  return { state: transition.state, bindings: [binding] };
}
function views(
  state: chess.ArtifactChessState,
  bindings: readonly chess.CheckedArtifactBinding[],
) {
  return participants.map(({ userId }) => ({
    userId,
    observation: unwrap(chess.getArtifactObservation(state, userId, bindings)),
  }));
}
function mockTransport(
  t: TestContext,
  reply: (task: Record<string, unknown>) => unknown,
): void {
  class FakeWorker extends EventEmitter {
    constructor(
      _path: unknown,
      options: { workerData: Record<string, unknown> },
    ) {
      super();
      queueMicrotask(() =>
        this.emit('message', JSON.stringify(reply(options.workerData))),
      );
    }
    terminate = (): Promise<number> => Promise.resolve(0);
  }
  t.mock.method(nodeWorkers, 'Worker', FakeWorker);
}
function envelope(task: Record<string, unknown>, result: unknown) {
  const { input: _input, connectionString: _secret, ...binding } = task;
  void _input;
  void _secret;
  return { ...binding, ok: true, result };
}
void describe('artifact chess proof worker boundaries', () => {
  void it('binds and freezes initial/observe replies without exposing credentials or proof bodies', async (t) => {
    const { state, bindings } = await initialFixture();
    mockTransport(t, (task) =>
      envelope(task, {
        ...pins,
        sourceHash: task.inputHash,
        stateHash: chessSnapshotDigest(state),
        observations: views(state, bindings),
        ...(task.mode === 'initial'
          ? { initial: { state, rulesVersion: chess.ARTIFACT_RULES_VERSION } }
          : {}),
      }),
    );
    const worker = new ArtifactChessProofWorker({ connectionString });
    try {
      const initial = await worker.prepareInitial(participants);
      assert.deepEqual(initial.initial.state, state);
      assert.equal(initial.sourceHash, chessSnapshotDigest({ participants }));
      assert.ok(Object.isFrozen(initial));
      assert.ok(Object.isFrozen(initial.initial.state));
      const observed = await worker.observe({ state, participants });
      assert.deepEqual(observed.observations, views(state, bindings));
      assert.equal(worker.activeCount, 0);
      for (const result of [initial, observed]) {
        const json = JSON.stringify(result);
        assert.ok(!json.includes('private-secret'));
        assert.ok(!json.includes('reachable-mate'));
        for (const view of result.observations) {
          assert.equal('decisions' in view.observation, false);
          assert.equal('history' in view.observation, false);
        }
      }
    } finally {
      await worker.close();
    }
  });
  void it('rejects mismatched nonce, profile, digest, roster and unwhitelisted payloads', async (t) => {
    const { state, bindings } = await initialFixture();
    const mutations = [
      (reply: Record<string, unknown>) => {
        reply.job = 'another-worker';
      },
      (reply: Record<string, unknown>) => {
        reply.engineVersion = 'old';
      },
      (reply: Record<string, unknown>) => {
        reply.ok = false;
        reply.engineCode = 'UNKNOWN_ENGINE_CODE';
      },
      (reply: Record<string, unknown>) => {
        (reply.result as Record<string, unknown>).stateHash = '0'.repeat(64);
      },
      (reply: Record<string, unknown>) => {
        (reply.result as Record<string, unknown>).sourceHash = '0'.repeat(64);
      },
      (reply: Record<string, unknown>) => {
        (reply.result as Record<string, unknown>).evidence = {
          verdict: 'dead',
        };
      },
      (reply: Record<string, unknown>) => {
        const result = reply.result as { observations: { userId: string }[] };
        result.observations[0]!.userId = 'mallory';
      },
      (reply: Record<string, unknown>) => {
        const result = reply.result as {
          observations: { observation: Record<string, unknown> }[];
        };
        result.observations[0]!.observation.decisions = state.decisions;
      },
    ];
    let mutation = mutations[0]!;
    mockTransport(t, (task) => {
      const reply = envelope(task, {
        ...pins,
        sourceHash: task.inputHash,
        stateHash: chessSnapshotDigest(state),
        observations: JSON.parse(
          JSON.stringify(views(state, bindings)),
        ) as unknown,
        initial: { state, rulesVersion: chess.ARTIFACT_RULES_VERSION },
      });
      mutation(reply);
      return reply;
    });
    const worker = new ArtifactChessProofWorker({ connectionString });
    try {
      for (mutation of mutations) {
        await assert.rejects(worker.prepareInitial(participants), {
          code: 'proof_binding',
        });
        assert.equal(worker.activeCount, 0);
      }
    } finally {
      await worker.close();
    }
  });
  void it('snapshots input before dispatch and binds accepted outcomes to the returned state', async (t) => {
    const { state, bindings } = await initialFixture(),
      candidate = unwrap(
        chess.prepareArtifactAction(
          state,
          'alice',
          { type: 'offer-draw' },
          0,
          bindings,
        ),
      ),
      transition = chess.finishArtifactCandidate(candidate);
    if (!transition.ok) assert.fail(transition.error.code);
    let tamper = false;
    mockTransport(t, (task) =>
      envelope(task, {
        ...pins,
        sourceHash: task.inputHash,
        stateHash: chessSnapshotDigest(transition.state),
        observations: views(transition.state, bindings),
        accepted: {
          state: transition.state,
          gameplay: true,
          ...(tamper
            ? {
                outcome: {
                  kind: 'win',
                  winnerUserIds: ['alice'],
                  reason: 'forged',
                },
              }
            : {}),
        },
      }),
    );
    const worker = new ArtifactChessProofWorker({ connectionString }),
      source = {
        state: JSON.parse(JSON.stringify(state)) as chess.ArtifactChessState,
        userId: 'alice',
        action: { type: 'offer-draw' },
        participants: [...participants],
      };
    try {
      const digest = chessSnapshotDigest(source),
        pending = worker.prepareAction(source);
      source.userId = 'mallory';
      source.action.type = 'resign';
      source.participants[0] = { userId: 'mallory', seat: 0 };
      const prepared = await pending;
      assert.equal(prepared.sourceHash, digest);
      assert.deepEqual(prepared.accepted.state, transition.state);
      assert.equal(prepared.accepted.outcome, undefined);
      tamper = true;
      await assert.rejects(
        worker.prepareAction({
          state,
          userId: 'alice',
          action: { type: 'offer-draw' },
          participants,
        }),
        { code: 'proof_binding' },
      );
    } finally {
      await worker.close();
    }
  });
  void it('rejects unsafe inputs and resource settings before creating a worker', async () => {
    for (const options of [
      { connectionString: '' },
      { connectionString, maxMemoryMb: 1 },
      { connectionString, maxConcurrent: 3 as 1 },
    ])
      assert.throws(
        () => new ArtifactChessProofWorker(options),
        ArtifactChessProofWorkerError,
      );
    const worker = new ArtifactChessProofWorker({ connectionString });
    try {
      for (const roster of [
        [],
        participants.slice(0, 1),
        [participants[0]!, participants[0]!],
        [
          { userId: 'alice', seat: 0 },
          { userId: 'alice', seat: 1 },
        ],
      ])
        await assert.rejects(worker.prepareInitial(roster), {
          code: 'proof_binding',
        });
      let getterRead = false;
      const bad = {
        get participants() {
          getterRead = true;
          return participants;
        },
      };
      await assert.rejects(
        worker.prepareInitial(bad as unknown as typeof participants),
        { code: 'proof_resource' },
      );
      assert.equal(getterRead, false);
      await assert.rejects(
        worker.observe({ state: { schemaVersion: 2 }, participants }),
        { code: 'proof_binding' },
      );
      assert.equal(worker.activeCount, 0);
    } finally {
      await worker.close();
    }
  });
  void it('keeps failures operational, bounds admission and cancels owned workers', async () => {
    const worker = new ArtifactChessProofWorker({ connectionString });
    try {
      const pending = worker.prepareInitial(participants),
        rejected = assert.rejects(pending, { code: 'proof_closed' });
      assert.equal(worker.activeCount, 1);
      await assert.rejects(worker.prepareInitial(participants), {
        code: 'proof_capacity',
      });
      await worker.close();
      await rejected;
      assert.equal(worker.activeCount, 0);
      await assert.rejects(worker.prepareInitial(participants), {
        code: 'proof_closed',
      });
    } finally {
      await worker.close();
    }
    const another = new ArtifactChessProofWorker({ connectionString }),
      controller = new AbortController();
    try {
      controller.abort();
      await assert.rejects(
        another.prepareInitial(participants, { signal: controller.signal }),
        { code: 'proof_cancelled' },
      );
      assert.equal(another.activeCount, 0);
      const active = new AbortController(),
        pending = another.prepareInitial(participants, {
          signal: active.signal,
        }),
        rejected = assert.rejects(pending, { code: 'proof_cancelled' });
      active.abort();
      await rejected;
      assert.equal(another.activeCount, 0);
      await assert.rejects(
        another.prepareInitial(participants),
        (error: unknown) =>
          error instanceof ArtifactChessProofWorkerError &&
          error.code === 'proof_failed' &&
          !error.message.includes('private-secret'),
      );
      assert.equal(another.activeCount, 0);
    } finally {
      await another.close();
    }
  });
});
