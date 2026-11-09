import { createHash, randomUUID } from 'node:crypto';
import {
  isMainThread,
  parentPort,
  workerData,
  Worker,
} from 'node:worker_threads';
import { Pool } from 'pg';
import * as chess from '#engines/chess';
import { ChessProofRepository } from './chess-proof-repository';
import { canonicalChessJson, chessSnapshotDigest } from './chess-proof-json';
import type {
  GameActionInput,
  GameActionTransition,
  GameInitialization,
  GameOutcome,
} from './game-runtime';

const PROTOCOL = 'skillbetting.chess.artifact-worker.v1';
const MAX_JSON_CHARS = 16_000_000;
const PINS = {
  schemaVersion: 3,
  engineVersion: '0.4.0-strict.2',
  rulesVersion: 'skillbetting.chess.fide-2023.strict-proof-artifacts.v1',
  proofEngineVersion: '0.3.0',
  proofRulesVersion: 'skillbetting.chess.fide-2023.v2',
  proofFormat: 'skillbetting.chess.reachability-stream.v1',
} as const;
const VIEW_KEYS = [
  'game',
  'rulesVersion',
  'revision',
  'viewer',
  'viewerColor',
  'players',
  'fen',
  'turn',
  'ply',
  'phase',
  'inCheck',
  'drawOffer',
  'forcedMove',
  'awaitingResignationDecision',
  'moves',
  'legalActions',
  'roundOutcome',
  'matchOutcome',
  'analysisRoot',
  'conformance',
];
const ENGINE_CODES = new Set<string>([
  'INVALID_CONFIG',
  'INVALID_FEN',
  'INVALID_STATE',
  'UNSUPPORTED_VERSION',
  'INVALID_ACTION',
  'UNKNOWN_PLAYER',
  'NOT_YOUR_TURN',
  'ILLEGAL_MOVE',
  'PROMOTION_REQUIRED',
  'STALE_REVISION',
  'GAME_ENDED',
  'ADJUDICATION_PENDING',
  'NO_DRAW_OFFER',
  'OWN_DRAW_OFFER',
  'DRAW_OFFER_PENDING',
  'DRAW_TOO_EARLY',
  'FORCED_MOVE',
  'INVALID_ADJUDICATION',
  'PROOF_INCONCLUSIVE',
  'PROOF_REQUIRED',
  'INVALID_PROOF',
  'RESOURCE_LIMIT',
] satisfies readonly chess.ErrorCode[]);
const REF_KEYS = [
  'revision',
  'artifactId',
  'root',
  'kernelEngineVersion',
  'kernelRulesVersion',
  'format',
];
type FailureCode =
  | 'proof_capacity'
  | 'proof_cancelled'
  | 'proof_closed'
  | 'proof_failed'
  | 'proof_binding'
  | 'proof_resource';
export class ArtifactChessProofWorkerError extends Error {
  constructor(
    readonly code: FailureCode,
    readonly engineCode?: chess.ErrorCode,
  ) {
    super(code);
    this.name = 'ArtifactChessProofWorkerError';
  }
}
export interface ArtifactChessInitialInput {
  participants: GameActionInput['participants'];
}
export interface ArtifactChessObservationInput extends ArtifactChessInitialInput {
  state: unknown;
}
export interface ArtifactChessObserved {
  readonly schemaVersion: typeof PINS.schemaVersion;
  readonly engineVersion: typeof PINS.engineVersion;
  readonly rulesVersion: typeof PINS.rulesVersion;
  readonly proofEngineVersion: typeof PINS.proofEngineVersion;
  readonly proofRulesVersion: typeof PINS.proofRulesVersion;
  readonly proofFormat: typeof PINS.proofFormat;
  readonly sourceHash: string;
  readonly stateHash: string;
  readonly observations: readonly {
    readonly userId: string;
    readonly observation: chess.ArtifactChessObservation;
  }[];
}
export interface ArtifactChessInitial extends ArtifactChessObserved {
  readonly initial: GameInitialization;
}
export interface ArtifactChessPrepared extends ArtifactChessObserved {
  readonly accepted: GameActionTransition;
}
interface Binding {
  protocol: typeof PROTOCOL;
  job: string;
  inputHash: string;
  mode: 'initial' | 'action' | 'observe';
  schemaVersion: typeof PINS.schemaVersion;
  engineVersion: typeof PINS.engineVersion;
  rulesVersion: typeof PINS.rulesVersion;
  proofEngineVersion: typeof PINS.proofEngineVersion;
  proofRulesVersion: typeof PINS.proofRulesVersion;
  proofFormat: typeof PINS.proofFormat;
}
interface Task extends Binding {
  input: string;
  /** Server-only credentials: never echoed, hashed into public state, or logged. */
  connectionString: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function fail(code: FailureCode = 'proof_binding'): never {
  throw new ArtifactChessProofWorkerError(code);
}
function pins(): void {
  if (
    chess.ARTIFACT_SCHEMA_VERSION !== PINS.schemaVersion ||
    chess.ARTIFACT_ENGINE_VERSION !== PINS.engineVersion ||
    chess.ARTIFACT_RULES_VERSION !== PINS.rulesVersion ||
    chess.STRICT_PROOF_ENGINE_VERSION !== PINS.proofEngineVersion ||
    chess.STRICT_PROOF_RULES_VERSION !== PINS.proofRulesVersion ||
    chess.ENGINE_VERSION !== PINS.proofEngineVersion ||
    chess.RULES_VERSION !== PINS.proofRulesVersion ||
    chess.REACHABILITY_STREAM_FORMAT !== PINS.proofFormat
  )
    fail();
}
function encode(value: unknown): string {
  try {
    const text = canonicalChessJson(value);
    if (text.length > MAX_JSON_CHARS) fail('proof_resource');
    return text;
  } catch (error) {
    if (error instanceof ArtifactChessProofWorkerError) throw error;
    fail('proof_resource');
  }
}
function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
function fixedPlayers(value: unknown): chess.Players {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every(
      (entry) =>
        record(entry) &&
        typeof entry.userId === 'string' &&
        entry.userId.length > 0 &&
        entry.userId.length <= 200 &&
        (entry.seat === 0 || entry.seat === 1) &&
        Object.keys(entry).every((key) => ['userId', 'seat'].includes(key)),
    )
  )
    fail();
  const ordered = [...(value as { userId: string; seat: number }[])].sort(
    (a, b) => a.seat - b.seat,
  );
  if (
    ordered[0]!.seat !== 0 ||
    ordered[1]!.seat !== 1 ||
    ordered[0]!.userId === ordered[1]!.userId
  )
    fail();
  return { white: ordered[0]!.userId, black: ordered[1]!.userId };
}
function unwrap<T>(result: chess.Result<T>): T {
  if (!result.ok)
    throw new ArtifactChessProofWorkerError('proof_failed', result.error.code);
  return result.value;
}
function finished(
  result: chess.ArtifactTransitionResult,
): chess.ArtifactChessState {
  if (!result.ok)
    throw new ArtifactChessProofWorkerError('proof_failed', result.error.code);
  return result.state;
}
function outcome(state: chess.ArtifactChessState): GameOutcome | undefined {
  const result = state.matchOutcome;
  if (!result) return undefined;
  if (result.kind === 'draw') {
    if (result.winner !== null || result.winnerId !== null) fail();
    return { kind: 'draw', reason: result.gameReason };
  }
  if (
    !result.winner ||
    result.winnerId !== state.initial.players[result.winner]
  )
    fail();
  return {
    kind: 'win',
    winnerUserIds: [result.winnerId],
    reason: result.gameReason,
  };
}
function refs(value: unknown): Map<string, string> {
  if (
    !record(value) ||
    !Array.isArray(value.decisions) ||
    value.decisions.length > 50_001
  )
    fail();
  const unique = new Map<string, string>();
  for (const ref of value.decisions) {
    if (
      !record(ref) ||
      Object.keys(ref).length !== REF_KEYS.length ||
      Object.keys(ref).some((key) => !REF_KEYS.includes(key)) ||
      !Number.isSafeInteger(ref.revision) ||
      (ref.revision as number) < 0 ||
      typeof ref.artifactId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(ref.artifactId) ||
      typeof ref.root !== 'string' ||
      ref.root.length > 120 ||
      ref.kernelEngineVersion !== PINS.proofEngineVersion ||
      ref.kernelRulesVersion !== PINS.proofRulesVersion ||
      ref.format !== PINS.proofFormat
    )
      fail();
    if (unique.has(ref.artifactId) && unique.get(ref.artifactId) !== ref.root)
      fail();
    unique.set(ref.artifactId, ref.root);
  }
  return unique;
}
function validateState(
  state: unknown,
  players: chess.Players,
): asserts state is chess.ArtifactChessState {
  if (
    !record(state) ||
    state.schemaVersion !== PINS.schemaVersion ||
    state.engineVersion !== PINS.engineVersion ||
    state.rulesVersion !== PINS.rulesVersion ||
    !record(state.initial) ||
    state.initial.mode !== 'standard' ||
    !record(state.initial.players) ||
    state.initial.players.white !== players.white ||
    state.initial.players.black !== players.black ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision as number) < 0 ||
    !Number.isSafeInteger(state.ply) ||
    (state.ply as number) < 0 ||
    !Array.isArray(state.history) ||
    state.history.length !== state.revision ||
    typeof state.fen !== 'string' ||
    state.fen.length > 256 ||
    !['playing', 'ended'].includes(state.phase as string) ||
    state.pendingResignation !== null
  )
    fail();
  refs(state);
}
function validateViews(
  value: unknown,
  state: chess.ArtifactChessState,
  players: chess.Players,
): asserts value is ArtifactChessObserved['observations'] {
  if (!Array.isArray(value) || value.length !== 2) fail();
  for (const [seat, entry] of value.entries()) {
    const color = seat === 0 ? 'white' : 'black';
    if (
      !record(entry) ||
      Object.keys(entry).some(
        (key) => !['userId', 'observation'].includes(key),
      ) ||
      entry.userId !== players[color] ||
      !record(entry.observation)
    )
      fail();
    const view = entry.observation;
    if (
      Object.keys(view).length !== VIEW_KEYS.length ||
      Object.keys(view).some((key) => !VIEW_KEYS.includes(key)) ||
      view.game !== 'chess' ||
      view.rulesVersion !== PINS.rulesVersion ||
      view.viewer !== players[color] ||
      view.viewerColor !== color ||
      view.revision !== state.revision ||
      view.fen !== state.fen ||
      view.turn !== state.turn ||
      view.ply !== state.ply ||
      view.phase !== state.phase ||
      !record(view.players) ||
      view.players.white !== players.white ||
      view.players.black !== players.black ||
      view.analysisRoot !== false ||
      view.awaitingResignationDecision !== false ||
      !record(view.conformance) ||
      view.conformance.unprovedContinuation !== false ||
      view.conformance.automaticDeadPositionDetection !==
        'required-verified-evidence' ||
      view.conformance.exhaustiveDeadPositionOracle !== false ||
      view.conformance.clocks !== false
    )
      fail();
  }
}
function replyBinding(task: Task): Binding {
  return {
    protocol: PROTOCOL,
    job: task.job,
    inputHash: task.inputHash,
    mode: task.mode,
    ...PINS,
  };
}
async function compute(task: Task): Promise<string> {
  pins();
  if (
    task.protocol !== PROTOCOL ||
    Object.entries(PINS).some(
      ([k, v]) => (task as unknown as Record<string, unknown>)[k] !== v,
    ) ||
    !['initial', 'action', 'observe'].includes(task.mode) ||
    typeof task.input !== 'string' ||
    task.input.length > MAX_JSON_CHARS ||
    createHash('sha256').update(task.input).digest('hex') !== task.inputHash
  )
    fail();
  const input: unknown = JSON.parse(task.input);
  if (
    !record(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          'participants',
          ...(task.mode === 'initial' ? [] : ['state']),
          ...(task.mode === 'action' ? ['userId', 'action'] : []),
        ].includes(key),
    )
  )
    fail();
  const players = fixedPlayers(input.participants);
  if (
    task.mode === 'action' &&
    (typeof input.userId !== 'string' ||
      ![players.white, players.black].includes(input.userId))
  )
    fail();
  const pool = new Pool({
    connectionString: task.connectionString,
    max: 2,
    connectionTimeoutMillis: 3_000,
  });
  try {
    const repository = new ChessProofRepository(pool),
      bindings: chess.CheckedArtifactBinding[] = [];
    let prior: chess.ArtifactChessState | undefined;
    if (task.mode !== 'initial') {
      // Untrusted refs route immutable reads only. The engine checks all refs and
      // authoritative history after each stream has been independently verified.
      for (const [id, root] of refs(input.state)) {
        if (chess.positionKey(chess.parseFen(root + ' 0 1')) !== root) fail();
        const token = await repository.verifyArtifact(id, root + ' 0 1');
        bindings.push(await repository.checkedBinding(token));
      }
      prior = unwrap(chess.restoreArtifactState(input.state, bindings));
      validateState(prior, players);
    }
    let state: chess.ArtifactChessState,
      accepted: GameActionTransition | undefined;
    if (task.mode === 'observe') state = prior!;
    else {
      const candidate =
        task.mode === 'initial'
          ? unwrap(chess.prepareArtifactGame({ players }))
          : unwrap(
              chess.prepareArtifactAction(
                prior,
                input.userId as string,
                input.action,
                prior!.revision,
                bindings,
              ),
            );
      const binding = candidate.needsEvidence
        ? await repository.solveAndBind(candidate.fen)
        : undefined;
      state = finished(chess.finishArtifactCandidate(candidate, binding));
      if (binding) bindings.push(binding);
      validateState(state, players);
      if (task.mode === 'action') {
        if (
          state.revision !== prior!.revision + 1 ||
          (state.ply !== prior!.ply && state.ply !== prior!.ply + 1)
        )
          fail();
        const result = outcome(state);
        accepted = {
          state,
          gameplay: true,
          ...(result ? { outcome: result } : {}),
        };
      }
    }
    validateState(state, players);
    const observations = (['white', 'black'] as const).map((color) => ({
      userId: players[color],
      observation: unwrap(
        chess.getArtifactObservation(state, players[color], bindings),
      ),
    }));
    validateViews(observations, state, players);
    return encode({
      ...replyBinding(task),
      ok: true,
      result: {
        ...PINS,
        sourceHash: task.inputHash,
        stateHash: chessSnapshotDigest(state),
        observations,
        ...(accepted ? { accepted } : {}),
        ...(task.mode === 'initial'
          ? { initial: { rulesVersion: PINS.rulesVersion, state } }
          : {}),
      },
    });
  } finally {
    await pool.end();
  }
}
if (!isMainThread && record(workerData) && workerData.protocol === PROTOCOL) {
  const task = workerData as unknown as Task;
  void (async () => {
    try {
      parentPort?.postMessage(await compute(task));
    } catch (error) {
      parentPort?.postMessage(
        JSON.stringify({
          ...replyBinding(task),
          ok: false,
          ...(error instanceof ArtifactChessProofWorkerError && error.engineCode
            ? { engineCode: error.engineCode }
            : {}),
        }),
      );
    } finally {
      parentPort?.close();
    }
  })();
}
interface Running {
  cancel(code: 'proof_cancelled' | 'proof_closed'): void;
  done: Promise<void>;
}
export interface ArtifactChessProofWorkerOptions {
  /** Trusted server configuration; browser input must never select a database. */
  connectionString: string;
  /** Operational limits only: no queue, outcome, or total proof cutoff. */
  maxConcurrent?: 1 | 2;
  maxMemoryMb?: number;
}
/** Dedicated durable-proof jobs; no search, replay, or SQL on the HTTP thread. */
export class ArtifactChessProofWorker {
  private readonly workers = new Map<Worker, Running>();
  private readonly maxConcurrent: number;
  private readonly maxMemoryMb: number;
  private readonly connectionString: string;
  private closed = false;
  constructor(options: ArtifactChessProofWorkerOptions) {
    this.maxConcurrent = options.maxConcurrent ?? 1;
    this.maxMemoryMb = options.maxMemoryMb ?? 128;
    this.connectionString = options.connectionString;
    if (
      typeof this.connectionString !== 'string' ||
      !this.connectionString.length ||
      this.connectionString.length > 8_192 ||
      ![1, 2].includes(this.maxConcurrent) ||
      !Number.isSafeInteger(this.maxMemoryMb) ||
      this.maxMemoryMb < 32 ||
      this.maxMemoryMb > 256
    )
      fail('proof_resource');
  }
  get activeCount(): number {
    return this.workers.size;
  }
  prepareInitial(
    participants: GameActionInput['participants'],
    options: { signal?: AbortSignal } = {},
  ): Promise<ArtifactChessInitial> {
    return this.run(
      { participants },
      'initial',
      options.signal,
    ) as Promise<ArtifactChessInitial>;
  }
  prepareAction(
    input: GameActionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ArtifactChessPrepared> {
    return this.run(
      input,
      'action',
      options.signal,
    ) as Promise<ArtifactChessPrepared>;
  }
  observe(
    input: ArtifactChessObservationInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ArtifactChessObserved> {
    return this.run(input, 'observe', options.signal);
  }
  private async run(
    input:
      | ArtifactChessInitialInput
      | GameActionInput
      | ArtifactChessObservationInput,
    mode: Binding['mode'],
    signal: AbortSignal | undefined,
  ): Promise<ArtifactChessObserved> {
    pins();
    const encoded = encode(input),
      stable: unknown = JSON.parse(encoded);
    if (!record(stable)) fail();
    const players = fixedPlayers(stable.participants);
    if (
      mode === 'action' &&
      (typeof stable.userId !== 'string' ||
        ![players.white, players.black].includes(stable.userId))
    )
      fail();
    if (mode !== 'initial') validateState(stable.state, players);
    const source: Binding = {
      protocol: PROTOCOL,
      job: randomUUID(),
      inputHash: createHash('sha256').update(encoded).digest('hex'),
      mode,
      ...PINS,
    };
    if (this.closed) fail('proof_closed');
    if (signal?.aborted) fail('proof_cancelled');
    if (this.workers.size >= this.maxConcurrent) fail('proof_capacity');
    let worker: Worker;
    try {
      worker = new Worker(__filename, {
        workerData: {
          ...source,
          input: encoded,
          connectionString: this.connectionString,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: this.maxMemoryMb,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      });
    } catch {
      fail('proof_failed');
    }
    return new Promise<ArtifactChessObserved>((resolve, reject) => {
      let settled = false,
        finished!: () => void;
      const done = new Promise<void>((complete) => {
        finished = complete;
      });
      const finish = (
        failure?: ArtifactChessProofWorkerError,
        result?: ArtifactChessObserved,
      ) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
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
            reject(new ArtifactChessProofWorkerError('proof_failed'));
          },
        );
      };
      const abort = () =>
        finish(new ArtifactChessProofWorkerError('proof_cancelled'));
      this.workers.set(worker, {
        cancel: (code) => finish(new ArtifactChessProofWorkerError(code)),
        done,
      });
      worker.on('message', (message: unknown) => {
        if (settled) return;
        try {
          if (typeof message !== 'string' || message.length > MAX_JSON_CHARS)
            fail('proof_resource');
          const reply: unknown = JSON.parse(message);
          if (
            !record(reply) ||
            Object.entries(source).some(([key, value]) => reply[key] !== value)
          )
            fail();
          if (reply.ok !== true) {
            if (
              reply.engineCode !== undefined &&
              (typeof reply.engineCode !== 'string' ||
                !ENGINE_CODES.has(reply.engineCode))
            )
              fail();
            throw new ArtifactChessProofWorkerError(
              'proof_failed',
              reply.engineCode as chess.ErrorCode | undefined,
            );
          }
          const result = reply.result;
          if (
            !record(result) ||
            Object.keys(result).some(
              (key) =>
                ![
                  ...Object.keys(PINS),
                  'sourceHash',
                  'stateHash',
                  'observations',
                  ...(mode === 'initial'
                    ? ['initial']
                    : mode === 'action'
                      ? ['accepted']
                      : []),
                ].includes(key),
            ) ||
            Object.entries(PINS).some(([k, v]) => result[k] !== v) ||
            result.sourceHash !== source.inputHash ||
            typeof result.stateHash !== 'string' ||
            !/^[a-f0-9]{64}$/.test(result.stateHash)
          )
            fail();
          const state: unknown =
            mode === 'initial' && record(result.initial)
              ? result.initial.state
              : mode === 'action' && record(result.accepted)
                ? result.accepted.state
                : stable.state;
          validateState(state, players);
          if (chessSnapshotDigest(state) !== result.stateHash) fail();
          validateViews(result.observations, state, players);
          if (
            mode === 'observe' &&
            result.stateHash !== chessSnapshotDigest(stable.state)
          )
            fail();
          if (
            mode === 'initial' &&
            (!record(result.initial) ||
              Object.keys(result.initial).some(
                (key) => !['state', 'rulesVersion'].includes(key),
              ) ||
              result.initial.rulesVersion !== PINS.rulesVersion ||
              state.revision !== 0 ||
              state.ply !== 0 ||
              state.fen !== chess.START_FEN ||
              state.phase !== 'playing')
          )
            fail();
          if (mode === 'action') {
            const prior = stable.state as chess.ArtifactChessState;
            if (
              !record(result.accepted) ||
              Object.keys(result.accepted).some(
                (key) => !['state', 'gameplay', 'outcome'].includes(key),
              ) ||
              result.accepted.gameplay !== true ||
              chessSnapshotDigest(result.accepted.state) !== result.stateHash ||
              state.revision !== prior.revision + 1 ||
              (state.ply !== prior.ply && state.ply !== prior.ply + 1) ||
              encode(result.accepted.outcome ?? null) !==
                encode(outcome(state) ?? null)
            )
              fail();
          } else if ('accepted' in result) fail();
          if (mode !== 'initial' && 'initial' in result) fail();
          finish(
            undefined,
            freezeJson(result) as unknown as ArtifactChessObserved,
          );
        } catch (error) {
          finish(
            error instanceof ArtifactChessProofWorkerError
              ? error
              : new ArtifactChessProofWorkerError('proof_failed'),
          );
        }
      });
      worker.once('error', () =>
        finish(new ArtifactChessProofWorkerError('proof_failed')),
      );
      worker.once('exit', () => {
        if (!settled) finish(new ArtifactChessProofWorkerError('proof_failed'));
      });
      signal?.addEventListener('abort', abort, { once: true });
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
