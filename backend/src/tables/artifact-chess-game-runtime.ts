import * as chess from '#engines/chess';
import type {
  GameActionInput,
  GameActionTransition,
  GameInitialization,
  GameOutcome,
  GameStartInput,
  TableGameRuntime,
} from './game-runtime';
import {
  ArtifactChessProofWorker,
  ArtifactChessProofWorkerError,
  type ArtifactChessObserved,
} from './artifact-chess-proof-worker';
import { chessSnapshotDigest } from './chess-proof-json';
import { PlatformError } from './platform-error';

type Participants = GameStartInput['participants'];
const PINS = {
  schemaVersion: chess.ARTIFACT_SCHEMA_VERSION,
  engineVersion: chess.ARTIFACT_ENGINE_VERSION,
  rulesVersion: chess.ARTIFACT_RULES_VERSION,
  proofEngineVersion: chess.STRICT_PROOF_ENGINE_VERSION,
  proofRulesVersion: chess.STRICT_PROOF_RULES_VERSION,
} as const;
interface ViewEntry {
  observations: ReadonlyMap<string, chess.ArtifactChessObservation>;
  bytes: number;
}
function roster(input: Participants): chess.Players {
  const sorted = [...input].sort((a, b) => a.seat - b.seat);
  if (
    sorted.length !== 2 ||
    sorted.some((p, seat) => p.seat !== seat || !p.userId) ||
    sorted[0]!.userId === sorted[1]!.userId
  )
    throw new PlatformError('platform_unavailable', 503);
  return { white: sorted[0]!.userId, black: sorted[1]!.userId };
}
function members(state: chess.ArtifactChessState): Participants {
  return [
    { userId: state.initial.players.white, seat: 0 },
    { userId: state.initial.players.black, seat: 1 },
  ];
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function snapshot(value: unknown): chess.ArtifactChessState {
  chessSnapshotDigest(value);
  const state = JSON.parse(JSON.stringify(value)) as unknown;
  if (
    !record(state) ||
    state.game !== 'chess' ||
    state.schemaVersion !== PINS.schemaVersion ||
    state.engineVersion !== PINS.engineVersion ||
    state.rulesVersion !== PINS.rulesVersion ||
    !record(state.initial) ||
    state.initial.mode !== 'standard' ||
    !record(state.initial.players) ||
    typeof state.initial.players.white !== 'string' ||
    typeof state.initial.players.black !== 'string' ||
    !state.initial.players.white ||
    !state.initial.players.black ||
    state.initial.players.white === state.initial.players.black ||
    !Array.isArray(state.decisions)
  )
    throw new PlatformError('engine_unavailable', 503);
  // Routing only. The worker replays every referenced checked artifact.
  return state as unknown as chess.ArtifactChessState;
}
function outcome(state: chess.ArtifactChessState): GameOutcome | undefined {
  const result = state.matchOutcome;
  if (!result) return undefined;
  if (result.kind === 'draw')
    return { kind: 'draw', reason: result.gameReason };
  if (
    !result.winner ||
    result.winnerId !== state.initial.players[result.winner]
  )
    throw new PlatformError('platform_unavailable', 503);
  return {
    kind: 'win',
    winnerUserIds: [result.winnerId],
    reason: result.gameReason,
  };
}
function failure(error: unknown): PlatformError {
  if (error instanceof ArtifactChessProofWorkerError && error.engineCode) {
    switch (error.engineCode) {
      case 'GAME_ENDED':
        return new PlatformError('match_ended', 409);
      case 'STALE_REVISION':
        return new PlatformError('stale_game_revision', 409);
      case 'UNSUPPORTED_VERSION':
        return new PlatformError('engine_unavailable', 503);
      case 'INVALID_STATE':
      case 'INVALID_CONFIG':
      case 'RESOURCE_LIMIT':
      case 'INVALID_PROOF':
      case 'PROOF_REQUIRED':
      case 'PROOF_INCONCLUSIVE':
        return new PlatformError('platform_unavailable', 503);
      default:
        return new PlatformError('invalid_game_action', 400);
    }
  }
  return error instanceof PlatformError
    ? error
    : new PlatformError('platform_unavailable', 503);
}
export interface ArtifactChessRuntimeOptions {
  connectionString?: string;
  /** Supplied workers remain caller-owned. */
  worker?: ArtifactChessProofWorker;
  maxCachedStates?: number;
  maxCachedBytes?: number;
}

/** Server-owned artifact proofs; startup, actions and cold replay stay in workers. */
export class ArtifactChessGameRuntime implements TableGameRuntime {
  readonly version = chess.ARTIFACT_ENGINE_VERSION;
  private readonly worker: ArtifactChessProofWorker;
  private readonly ownsWorker: boolean;
  private readonly maxCachedStates: number;
  private readonly maxCachedBytes: number;
  private readonly views = new Map<string, ViewEntry>();
  private readonly warming = new Map<
    string,
    { promise: Promise<void>; abort: AbortController }
  >();
  private cachedBytes = 0;
  private closed = false;

  constructor(options: ArtifactChessRuntimeOptions) {
    this.maxCachedStates = options.maxCachedStates ?? 64;
    this.maxCachedBytes = options.maxCachedBytes ?? 16 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.maxCachedStates) ||
      this.maxCachedStates < 1 ||
      this.maxCachedStates > 256 ||
      !Number.isSafeInteger(this.maxCachedBytes) ||
      this.maxCachedBytes < 1 ||
      this.maxCachedBytes > 32 * 1024 * 1024 ||
      (!options.worker && !options.connectionString)
    )
      throw new PlatformError('platform_unavailable', 503);
    this.ownsWorker = !options.worker;
    this.worker =
      options.worker ??
      new ArtifactChessProofWorker({
        connectionString: options.connectionString!,
      });
  }
  start(input: GameStartInput): never {
    void input;
    throw new PlatformError('engine_unavailable', 503);
  }
  apply(): never {
    throw new PlatformError('engine_unavailable', 503);
  }

  private verified(
    result: ArtifactChessObserved,
    input: unknown,
    state: chess.ArtifactChessState,
  ): void {
    if (
      this.closed ||
      Object.entries(PINS).some(
        ([key, value]) => result[key as keyof typeof PINS] !== value,
      ) ||
      result.sourceHash !== chessSnapshotDigest(input) ||
      result.stateHash !== chessSnapshotDigest(state)
    )
      throw new PlatformError('platform_unavailable', 503);
  }
  private remember(
    state: chess.ArtifactChessState,
    result: ArtifactChessObserved,
  ): void {
    const players = state.initial.players;
    if (
      this.closed ||
      result.observations.length !== 2 ||
      result.observations.some((entry, seat) => {
        const color = seat === 0 ? 'white' : 'black',
          view = entry.observation;
        return (
          entry.userId !== players[color] ||
          view.viewer !== entry.userId ||
          view.viewerColor !== color ||
          view.rulesVersion !== PINS.rulesVersion ||
          view.revision !== state.revision ||
          view.fen !== state.fen ||
          view.phase !== state.phase ||
          view.players.white !== players.white ||
          view.players.black !== players.black
        );
      })
    )
      throw new PlatformError('platform_unavailable', 503);
    const encoded = JSON.stringify(result.observations),
      bytes = Buffer.byteLength(encoded),
      key = chessSnapshotDigest(state);
    if (bytes > this.maxCachedBytes)
      throw new PlatformError('platform_unavailable', 503);
    const observations = frozen(
      JSON.parse(encoded) as ArtifactChessObserved['observations'],
    );
    const previous = this.views.get(key);
    if (previous) {
      this.cachedBytes -= previous.bytes;
      this.views.delete(key);
    }
    while (
      this.views.size >= this.maxCachedStates ||
      this.cachedBytes + bytes > this.maxCachedBytes
    ) {
      const oldest = this.views.keys().next().value!;
      this.cachedBytes -= this.views.get(oldest)!.bytes;
      this.views.delete(oldest);
    }
    this.views.set(key, {
      bytes,
      observations: new Map(
        observations.map((entry) => [entry.userId, entry.observation]),
      ),
    });
    this.cachedBytes += bytes;
  }
  async prepareStart(input: GameStartInput): Promise<GameInitialization> {
    try {
      if (
        this.closed ||
        input.gameId !== 'chess' ||
        input.formatId !== 'standard'
      )
        throw new PlatformError('engine_unavailable', 503);
      const players = roster(input.participants),
        stableInput = { participants: input.participants },
        result = await this.worker.prepareInitial(input.participants),
        state = snapshot(result.initial.state);
      this.verified(result, stableInput, state);
      if (
        result.initial.rulesVersion !== PINS.rulesVersion ||
        state.revision !== 0 ||
        state.matchOutcome ||
        state.initial.players.white !== players.white ||
        state.initial.players.black !== players.black
      )
        throw new PlatformError('platform_unavailable', 503);
      this.remember(state, result);
      return result.initial;
    } catch (error) {
      throw failure(error);
    }
  }
  async prepare(input: GameActionInput): Promise<GameActionTransition> {
    try {
      if (this.closed) throw new PlatformError('engine_unavailable', 503);
      const state = snapshot(input.state),
        players = roster(input.participants);
      if (
        state.initial.players.white !== players.white ||
        state.initial.players.black !== players.black
      )
        throw new PlatformError('platform_unavailable', 503);
      if (input.userId !== players.white && input.userId !== players.black)
        throw new PlatformError('not_participating', 403);
      chessSnapshotDigest(input.action);
      const stableInput = {
          state,
          userId: input.userId,
          action: JSON.parse(JSON.stringify(input.action)) as unknown,
          participants: input.participants,
        },
        result = await this.worker.prepareAction(stableInput),
        next = snapshot(result.accepted.state);
      this.verified(result, stableInput, next);
      if (
        next.initial.players.white !== players.white ||
        next.initial.players.black !== players.black ||
        next.revision !== state.revision + 1 ||
        result.accepted.gameplay !== true ||
        chessSnapshotDigest(result.accepted.outcome ?? null) !==
          chessSnapshotDigest(outcome(next) ?? null)
      )
        throw new PlatformError('platform_unavailable', 503);
      this.remember(next, result);
      return result.accepted;
    } catch (error) {
      throw failure(error);
    }
  }
  warmObservations(value: unknown): Promise<void> {
    try {
      if (this.closed) throw new PlatformError('engine_unavailable', 503);
      const state = snapshot(value),
        key = chessSnapshotDigest(state);
      if (this.views.has(key)) return Promise.resolve();
      const existing = this.warming.get(key);
      if (existing) return existing.promise;
      if (this.warming.size >= 2)
        throw new PlatformError('platform_unavailable', 503);
      const input = { state, participants: members(state) },
        abort = new AbortController(),
        promise = this.worker
          .observe(input, { signal: abort.signal })
          .then((result) => {
            this.verified(result, input, state);
            this.remember(state, result);
          })
          .catch((error: unknown) => {
            throw failure(error);
          });
      this.warming.set(key, { promise, abort });
      void promise.then(
        () => this.warming.delete(key),
        () => this.warming.delete(key),
      );
      return promise;
    } catch (error) {
      return Promise.reject(failure(error));
    }
  }
  observe(input: {
    state: unknown;
    userId: string;
  }): chess.ArtifactChessObservation {
    if (this.closed) throw new PlatformError('engine_unavailable', 503);
    let state: chess.ArtifactChessState;
    try {
      state = snapshot(input.state);
    } catch (error) {
      throw failure(error);
    }
    if (!Object.values(state.initial.players).includes(input.userId))
      throw new PlatformError('not_participating', 403);
    const key = chessSnapshotDigest(state),
      entry = this.views.get(key),
      view = entry?.observations.get(input.userId);
    if (!entry || !view) {
      void this.warmObservations(state).catch(() => {});
      throw new PlatformError('platform_unavailable', 503);
    }
    this.views.delete(key);
    this.views.set(key, entry);
    return view;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.warming.values()) job.abort.abort();
    await Promise.allSettled(
      [...this.warming.values()].map((job) => job.promise),
    );
    this.warming.clear();
    this.views.clear();
    this.cachedBytes = 0;
    if (this.ownsWorker) await this.worker.close();
  }
}
