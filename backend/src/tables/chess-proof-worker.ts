import { createHash, randomUUID } from 'node:crypto';
import {
  isMainThread,
  parentPort,
  workerData,
  Worker,
} from 'node:worker_threads';
import * as chess from '#engines/chess';
import type { GameActionInput, GameActionTransition } from './game-runtime';
import {
  canonicalChessJson,
  CanonicalChessJsonError,
  chessSnapshotDigest,
} from './chess-proof-json';
export { chessSnapshotDigest } from './chess-proof-json';

const PROTOCOL = 'skillbetting.chess.proof-worker.v1';
const ENGINE_VERSION = '0.3.0';
const RULES_VERSION = 'skillbetting.chess.fide-2023.v2';
const STRICT_ENGINE_VERSION = '0.4.0-strict.1';
const STRICT_RULES_VERSION = 'skillbetting.chess.fide-2023.strict-proof.v1';
const MAX_JSON_CHARS = 16_000_000;
const VERIFICATION_LIMITS = {
  maxPositions: 100_000,
  maxExpanded: 100_000,
  maxEdges: 2_000_000,
} as const;
type FailureCode =
  | 'proof_capacity'
  | 'proof_cancelled'
  | 'proof_closed'
  | 'proof_failed'
  | 'proof_binding'
  | 'proof_resource';
export class ChessProofWorkerError extends Error {
  constructor(
    readonly code: FailureCode,
    readonly engineCode?: chess.ErrorCode,
  ) {
    super(code);
    this.name = 'ChessProofWorkerError';
  }
}
interface Binding {
  protocol: typeof PROTOCOL;
  job: string;
  fen: string;
  root: string;
  engineVersion: typeof ENGINE_VERSION;
  rulesVersion: typeof RULES_VERSION;
}
interface Task extends Binding {
  mode: 'solve' | 'verify';
  evidence?: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
function encode(value: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ChessProofWorkerError('proof_failed');
  }
  if (typeof encoded !== 'string' || encoded.length > MAX_JSON_CHARS)
    throw new ChessProofWorkerError('proof_resource');
  return encoded;
}
function binding(fen: string): Binding {
  if (
    typeof fen !== 'string' ||
    fen.length > 256 ||
    chess.ENGINE_VERSION !== ENGINE_VERSION ||
    chess.RULES_VERSION !== RULES_VERSION
  )
    throw new ChessProofWorkerError('proof_binding');
  try {
    return {
      protocol: PROTOCOL,
      job: randomUUID(),
      fen,
      root: chess.positionKey(chess.parseFen(fen)),
      engineVersion: ENGINE_VERSION,
      rulesVersion: RULES_VERSION,
    };
  } catch {
    throw new ChessProofWorkerError('proof_binding');
  }
}

export interface StrictChessObservationInput {
  state: unknown;
  participants: GameActionInput['participants'];
}
export interface StrictChessObserved {
  readonly schemaVersion: 2;
  readonly engineVersion: typeof STRICT_ENGINE_VERSION;
  readonly rulesVersion: typeof STRICT_RULES_VERSION;
  readonly proofEngineVersion: typeof ENGINE_VERSION;
  readonly proofRulesVersion: typeof RULES_VERSION;
  readonly sourceHash: string;
  readonly stateHash: string;
  readonly observations: readonly {
    readonly userId: string;
    readonly observation: chess.StrictChessObservation;
  }[];
}
export interface StrictChessPrepared extends StrictChessObserved {
  readonly accepted: GameActionTransition;
}
interface StrictBinding {
  protocol: typeof PROTOCOL;
  job: string;
  inputHash: string;
  schemaVersion: 2;
  engineVersion: typeof STRICT_ENGINE_VERSION;
  rulesVersion: typeof STRICT_RULES_VERSION;
  proofEngineVersion: typeof ENGINE_VERSION;
  proofRulesVersion: typeof RULES_VERSION;
}
interface StrictTask extends StrictBinding {
  mode: 'strict-action' | 'strict-observe';
  input: string;
}
type AnyTask = Task | StrictTask;

function canonicalJson(value: unknown): string {
  try {
    return canonicalChessJson(value);
  } catch (error) {
    throw new ChessProofWorkerError(
      error instanceof CanonicalChessJsonError ? error.code : 'proof_failed',
    );
  }
}
function strictPins(): void {
  if (
    chess.STRICT_ENGINE_VERSION !== STRICT_ENGINE_VERSION ||
    chess.STRICT_SCHEMA_VERSION !== 2 ||
    chess.STRICT_RULES_VERSION !== STRICT_RULES_VERSION ||
    chess.STRICT_PROOF_ENGINE_VERSION !== ENGINE_VERSION ||
    chess.STRICT_PROOF_RULES_VERSION !== RULES_VERSION ||
    chess.ENGINE_VERSION !== ENGINE_VERSION ||
    chess.RULES_VERSION !== RULES_VERSION
  )
    throw new ChessProofWorkerError('proof_binding');
}
function replyBinding(task: AnyTask): Binding | StrictBinding {
  if (task.mode === 'strict-action' || task.mode === 'strict-observe') {
    return {
      protocol: task.protocol,
      job: task.job,
      inputHash: task.inputHash,
      schemaVersion: task.schemaVersion,
      engineVersion: task.engineVersion,
      rulesVersion: task.rulesVersion,
      proofEngineVersion: task.proofEngineVersion,
      proofRulesVersion: task.proofRulesVersion,
    };
  }
  const proof = task as Task;
  return {
    protocol: proof.protocol,
    job: proof.job,
    fen: proof.fen,
    root: proof.root,
    engineVersion: proof.engineVersion,
    rulesVersion: proof.rulesVersion,
  };
}
function unwrap<T>(result: chess.Result<T>): T {
  if (!result.ok)
    throw new ChessProofWorkerError('proof_failed', result.error.code);
  return result.value;
}
function fixedPlayers(value: unknown): chess.Players {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every(
      (p) =>
        record(p) &&
        typeof p.userId === 'string' &&
        p.userId.length > 0 &&
        (p.seat === 0 || p.seat === 1) &&
        Object.keys(p).every((k) => ['userId', 'seat'].includes(k)),
    )
  )
    throw new ChessProofWorkerError('proof_binding');
  const ordered = [...(value as { userId: string; seat: number }[])].sort(
    (a: { seat: number }, b: { seat: number }) => a.seat - b.seat,
  ) as { userId: string; seat: number }[];
  if (
    ordered[0]!.seat !== 0 ||
    ordered[1]!.seat !== 1 ||
    ordered[0]!.userId === ordered[1]!.userId
  )
    throw new ChessProofWorkerError('proof_binding');
  return { white: ordered[0]!.userId, black: ordered[1]!.userId };
}
function observations(
  state: chess.StrictChessState,
  players: chess.Players,
): StrictChessObserved['observations'] {
  return (['white', 'black'] as const).map((color) => {
    const userId = players[color],
      observation = unwrap(chess.getStrictObservation(state, userId));
    if (
      observation.viewer !== userId ||
      observation.viewerColor !== color ||
      observation.revision !== state.revision ||
      observation.fen !== state.fen ||
      observation.rulesVersion !== STRICT_RULES_VERSION ||
      observation.players.white !== players.white ||
      observation.players.black !== players.black
    )
      throw new ChessProofWorkerError('proof_binding');
    return { userId, observation };
  });
}
function computeStrict(task: StrictTask): string {
  strictPins();
  if (
    task.protocol !== PROTOCOL ||
    task.schemaVersion !== 2 ||
    task.engineVersion !== STRICT_ENGINE_VERSION ||
    task.rulesVersion !== STRICT_RULES_VERSION ||
    task.proofEngineVersion !== ENGINE_VERSION ||
    task.proofRulesVersion !== RULES_VERSION
  )
    throw new ChessProofWorkerError('proof_binding');
  if (
    task.input.length > MAX_JSON_CHARS ||
    createHash('sha256').update(task.input).digest('hex') !== task.inputHash
  )
    throw new ChessProofWorkerError('proof_binding');
  const input: unknown = JSON.parse(task.input);
  if (
    !record(input) ||
    Object.keys(input).some(
      (k) =>
        ![
          'state',
          'participants',
          ...(task.mode === 'strict-action' ? ['userId', 'action'] : []),
        ].includes(k),
    )
  )
    throw new ChessProofWorkerError('proof_binding');
  const players = fixedPlayers(input.participants),
    prior = unwrap(chess.restoreStrictState(input.state));
  if (
    prior.initial.players.white !== players.white ||
    prior.initial.players.black !== players.black ||
    prior.initial.mode !== 'standard'
  )
    throw new ChessProofWorkerError('proof_binding');
  let state = prior;
  let accepted: GameActionTransition | undefined;
  if (task.mode === 'strict-action') {
    if (
      typeof input.userId !== 'string' ||
      ![players.white, players.black].includes(input.userId)
    )
      throw new ChessProofWorkerError('proof_binding');
    const candidate = unwrap(
      chess.prepareStrictAction(
        prior,
        input.userId,
        input.action,
        prior.revision,
      ),
    );
    const proof = candidate.needsEvidence
      ? chess.solveMateReachabilityExactly(candidate.fen).evidence
      : undefined;
    const finished = chess.finishStrictCandidate(candidate, proof);
    if (!finished.ok)
      throw new ChessProofWorkerError('proof_failed', finished.error.code);
    state = finished.state;
    if (
      state.revision !== prior.revision + 1 ||
      (state.ply !== prior.ply && state.ply !== prior.ply + 1) ||
      state.initial.players.white !== players.white ||
      state.initial.players.black !== players.black
    )
      throw new ChessProofWorkerError('proof_binding');
    const result = state.matchOutcome;
    if (
      result?.kind === 'win' &&
      (!result.winner || result.winnerId !== players[result.winner])
    )
      throw new ChessProofWorkerError('proof_binding');
    if (
      result?.kind === 'draw' &&
      (result.winner !== null || result.winnerId !== null)
    )
      throw new ChessProofWorkerError('proof_binding');
    accepted = {
      state,
      gameplay: true,
      ...(result
        ? {
            outcome:
              result.kind === 'draw'
                ? { kind: 'draw' as const, reason: result.gameReason }
                : {
                    kind: 'win' as const,
                    winnerUserIds: [result.winnerId!],
                    reason: result.gameReason,
                  },
          }
        : {}),
    };
  }
  const result: StrictChessObserved = {
    schemaVersion: 2,
    engineVersion: STRICT_ENGINE_VERSION,
    rulesVersion: STRICT_RULES_VERSION,
    proofEngineVersion: ENGINE_VERSION,
    proofRulesVersion: RULES_VERSION,
    sourceHash: task.inputHash,
    stateHash: chessSnapshotDigest(state),
    observations: observations(state, players),
  };
  return encode({
    ...replyBinding(task),
    ok: true,
    result: { ...result, ...(accepted ? { accepted } : {}) },
  });
}

/** Full search and full verification run only in a dedicated worker. */
function compute(task: AnyTask): string {
  if (task.mode === 'strict-action' || task.mode === 'strict-observe')
    return computeStrict(task);
  const proof = task as Task;
  if (
    proof.protocol !== PROTOCOL ||
    proof.engineVersion !== chess.ENGINE_VERSION ||
    proof.rulesVersion !== chess.RULES_VERSION ||
    proof.root !== chess.positionKey(chess.parseFen(proof.fen))
  )
    throw new ChessProofWorkerError('proof_binding');
  const solved =
    proof.mode === 'solve'
      ? chess.solveMateReachabilityExactly(proof.fen)
      : null;
  const evidence: unknown = solved
    ? solved.evidence
    : proof.mode === 'verify' && typeof proof.evidence === 'string'
      ? (JSON.parse(proof.evidence) as unknown)
      : null;
  const checked = chess.verifyReachabilityDecision(
    proof.fen,
    evidence,
    VERIFICATION_LIMITS,
  );
  if (
    !checked.valid ||
    checked.root !== proof.root ||
    checked.engineVersion !== proof.engineVersion ||
    checked.rulesVersion !== proof.rulesVersion ||
    (solved && solved.status !== checked.verdict)
  )
    throw new ChessProofWorkerError('proof_failed');
  return encode({
    ...replyBinding(proof),
    evidence,
    ok: true,
    verdict: checked.verdict,
  });
}
if (!isMainThread && record(workerData) && workerData.protocol === PROTOCOL) {
  const task = workerData as unknown as AnyTask;
  try {
    parentPort?.postMessage(compute(task));
  } catch (error) {
    parentPort?.postMessage(
      JSON.stringify({
        ...replyBinding(task),
        ok: false,
        ...(error instanceof ChessProofWorkerError && error.engineCode
          ? { engineCode: error.engineCode }
          : {}),
      }),
    );
  } finally {
    parentPort?.close();
  }
}
interface Running {
  cancel(code: 'proof_cancelled' | 'proof_closed'): void;
  done: Promise<void>;
}
export interface ChessProofWorkerOptions {
  /** Operational admission control, not a search cutoff or a chess rule. No queue. */
  maxConcurrent?: 1 | 2;
  maxMemoryMb?: number;
}
/**
 * Unwired computation helper: own-worker replies only, with fresh job/root/version
 * binding. Search and proof verification are off the HTTP event loop. Small FEN
 * parsing and capped JSON parsing/freezing still occur in the calling thread.
 * Abort, capacity, oversized proofs and worker resource failures reject; they
 * never produce an outcome or permission to commit an unresolved transition.
 */
export class ChessProofWorker {
  private readonly workers = new Map<Worker, Running>();
  private readonly maxConcurrent: number;
  private readonly maxMemoryMb: number;
  private closed = false;

  constructor(options: ChessProofWorkerOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 1;
    this.maxMemoryMb = options.maxMemoryMb ?? 128;
    if (
      ![1, 2].includes(this.maxConcurrent) ||
      !Number.isSafeInteger(this.maxMemoryMb) ||
      this.maxMemoryMb < 32 ||
      this.maxMemoryMb > 256
    )
      throw new ChessProofWorkerError('proof_resource');
  }
  get activeCount(): number {
    return this.workers.size;
  }
  solve(
    fen: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<chess.ExactMateReachabilityResult> {
    return this.run(fen, 'solve', undefined, options.signal);
  }
  verify(
    fen: string,
    evidence: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<chess.ExactMateReachabilityResult> {
    // Snapshot once, before any asynchronous boundary. Never retain caller objects.
    let encoded: string;
    try {
      encoded = encode(evidence);
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new ChessProofWorkerError('proof_failed'),
      );
    }
    return this.run(fen, 'verify', encoded, options.signal);
  }
  prepareStrictAction(
    input: GameActionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<StrictChessPrepared> {
    return this.strictJob(
      input,
      'strict-action',
      options.signal,
    ) as Promise<StrictChessPrepared>;
  }
  observeStrict(
    input: StrictChessObservationInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<StrictChessObserved> {
    return this.strictJob(input, 'strict-observe', options.signal);
  }
  private async strictJob(
    input: GameActionInput | StrictChessObservationInput,
    mode: StrictTask['mode'],
    signal: AbortSignal | undefined,
  ): Promise<StrictChessObserved> {
    strictPins();
    const encoded = canonicalJson(input),
      source: StrictBinding = {
        protocol: PROTOCOL,
        job: randomUUID(),
        inputHash: createHash('sha256').update(encoded).digest('hex'),
        schemaVersion: 2,
        engineVersion: STRICT_ENGINE_VERSION,
        rulesVersion: STRICT_RULES_VERSION,
        proofEngineVersion: ENGINE_VERSION,
        proofRulesVersion: RULES_VERSION,
      };
    const stableInput = JSON.parse(encoded) as Record<string, unknown>;
    const expectedPlayers = fixedPlayers(stableInput.participants);
    return this.dispatch(
      { ...source, mode, input: encoded },
      source,
      (reply) => {
        const result = reply.result;
        if (
          !record(result) ||
          result.sourceHash !== source.inputHash ||
          result.schemaVersion !== 2 ||
          result.engineVersion !== STRICT_ENGINE_VERSION ||
          result.rulesVersion !== STRICT_RULES_VERSION ||
          result.proofEngineVersion !== ENGINE_VERSION ||
          result.proofRulesVersion !== RULES_VERSION ||
          typeof result.stateHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(result.stateHash) ||
          !Array.isArray(result.observations) ||
          result.observations.length !== 2 ||
          !result.observations.every(
            (v) =>
              record(v) &&
              typeof v.userId === 'string' &&
              record(v.observation) &&
              v.observation.viewer === v.userId &&
              v.observation.rulesVersion === STRICT_RULES_VERSION,
          )
        )
          throw new ChessProofWorkerError('proof_binding');
        const state =
          mode === 'strict-action' && record(result.accepted)
            ? result.accepted.state
            : stableInput.state;
        if (
          !record(state) ||
          result.stateHash !== chessSnapshotDigest(state) ||
          result.observations.some((entry: unknown, seat: number) => {
            if (!record(entry) || !record(entry.observation)) return true;
            const observation = entry.observation,
              color = seat === 0 ? 'white' : 'black';
            return (
              entry.userId !== expectedPlayers[color] ||
              observation.viewerColor !== color ||
              observation.revision !== state.revision ||
              observation.fen !== state.fen ||
              observation.phase !== state.phase ||
              !record(observation.players) ||
              observation.players.white !== expectedPlayers.white ||
              observation.players.black !== expectedPlayers.black
            );
          })
        )
          throw new ChessProofWorkerError('proof_binding');
        if (
          mode === 'strict-action' &&
          (!record(result.accepted) ||
            !record(result.accepted.state) ||
            result.accepted.state.engineVersion !== STRICT_ENGINE_VERSION ||
            result.accepted.state.rulesVersion !== STRICT_RULES_VERSION ||
            result.accepted.gameplay !== true ||
            chessSnapshotDigest(result.accepted.state) !== result.stateHash)
        )
          throw new ChessProofWorkerError('proof_binding');
        return freezeJson(result) as unknown as StrictChessObserved;
      },
      signal,
    );
  }
  private async run(
    fen: string,
    mode: Task['mode'],
    evidence: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<chess.ExactMateReachabilityResult> {
    const source = binding(fen),
      task: Task = { ...source, mode, ...(evidence ? { evidence } : {}) };
    return this.dispatch(
      task,
      source,
      (reply) => {
        if (
          !['dead', 'not-dead'].includes(reply.verdict as string) ||
          !record(reply.evidence) ||
          reply.evidence.root !== source.root ||
          reply.evidence.engineVersion !== source.engineVersion ||
          reply.evidence.rulesVersion !== source.rulesVersion ||
          reply.evidence.kind !==
            (reply.verdict === 'dead'
              ? 'closed-movement-graph'
              : 'reachable-mate')
        )
          throw new ChessProofWorkerError('proof_binding');
        return freezeJson({
          status: reply.verdict,
          evidence: reply.evidence,
        }) as unknown as chess.ExactMateReachabilityResult;
      },
      signal,
    );
  }
  private async dispatch<T>(
    task: AnyTask,
    source: Binding | StrictBinding,
    parse: (reply: Record<string, unknown>) => T,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (this.closed) throw new ChessProofWorkerError('proof_closed');
    if (signal?.aborted) throw new ChessProofWorkerError('proof_cancelled');
    if (this.workers.size >= this.maxConcurrent)
      throw new ChessProofWorkerError('proof_capacity');
    let worker: Worker;
    try {
      worker = new Worker(__filename, {
        workerData: task,
        resourceLimits: {
          maxOldGenerationSizeMb: this.maxMemoryMb,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      });
    } catch {
      throw new ChessProofWorkerError('proof_failed');
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let finished!: () => void;
      const done = new Promise<void>((complete) => {
        finished = complete;
      });
      const finish = (failure?: ChessProofWorkerError, result?: T) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        // Keep admission occupied until the worker is actually terminated.
        void worker.terminate().then(
          () => {
            this.workers.delete(worker);
            finished();
            if (failure) reject(failure);
            else resolve(result!);
          },
          () => {
            this.workers.delete(worker);
            finished();
            reject(new ChessProofWorkerError('proof_failed'));
          },
        );
      };
      const abort = () => finish(new ChessProofWorkerError('proof_cancelled'));
      this.workers.set(worker, {
        cancel: (code) => finish(new ChessProofWorkerError(code)),
        done,
      });
      worker.on('message', (message: unknown) => {
        if (settled) return;
        try {
          if (typeof message !== 'string' || message.length > MAX_JSON_CHARS)
            throw new ChessProofWorkerError('proof_resource');
          const reply: unknown = JSON.parse(message);
          if (
            !record(reply) ||
            Object.entries(source).some(([key, value]) => reply[key] !== value)
          )
            throw new ChessProofWorkerError('proof_binding');
          if (reply.ok !== true)
            throw new ChessProofWorkerError(
              'proof_failed',
              typeof reply.engineCode === 'string'
                ? (reply.engineCode as chess.ErrorCode)
                : undefined,
            );
          finish(undefined, parse(reply));
        } catch (error) {
          finish(
            error instanceof ChessProofWorkerError
              ? error
              : new ChessProofWorkerError('proof_failed'),
          );
        }
      });
      worker.once('error', () =>
        finish(new ChessProofWorkerError('proof_failed')),
      );
      worker.once('exit', () => {
        if (!settled) finish(new ChessProofWorkerError('proof_failed'));
      });
      signal?.addEventListener('abort', abort, { once: true });
      // Covers an abort that arrived while constructing/attaching the worker.
      if (signal?.aborted) abort();
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    const running = [...this.workers.values()];
    for (const entry of running) entry.cancel('proof_closed');
    await Promise.all(running.map((entry) => entry.done));
  }
  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
