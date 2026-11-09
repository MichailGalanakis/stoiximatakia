import * as chess from '#engines/chess';
import type { GameId } from './game-catalog';
import type {
  GameActionInput,
  GameActionTransition,
  GameOutcome,
  TableGameRuntime,
} from './game-runtime';
import {
  ChessProofWorker,
  ChessProofWorkerError,
  chessSnapshotDigest,
  type StrictChessObserved,
} from './chess-proof-worker';
import { PlatformError } from './platform-error';

type Participants = GameActionInput['participants'];
interface ViewEntry {
  readonly observations: ReadonlyMap<string, chess.StrictChessObservation>;
  readonly bytes: number;
}
const PINS = {
  schemaVersion: chess.STRICT_SCHEMA_VERSION,
  engineVersion: chess.STRICT_ENGINE_VERSION,
  rulesVersion: chess.STRICT_RULES_VERSION,
  proofEngineVersion: chess.STRICT_PROOF_ENGINE_VERSION,
  proofRulesVersion: chess.STRICT_PROOF_RULES_VERSION,
} as const;

function players(participants: Participants): chess.Players {
  const ordered = [...participants].sort((a, b) => a.seat - b.seat);
  if (
    ordered.length !== 2 ||
    ordered.some((p, seat) => p.seat !== seat || !p.userId) ||
    ordered[0]!.userId === ordered[1]!.userId
  )
    throw new PlatformError('platform_unavailable', 503);
  return { white: ordered[0]!.userId, black: ordered[1]!.userId };
}
function frozenJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozenJson(child);
    Object.freeze(value);
  }
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function snapshot(value: unknown): chess.StrictChessState {
  // The shared digest rejects non-JSON/accessor inputs before they can alias a
  // cached valid state. The detached copy is the one submitted to a worker.
  chessSnapshotDigest(value);
  const detached = JSON.parse(JSON.stringify(value)) as unknown;
  if (
    !record(detached) ||
    detached.game !== 'chess' ||
    detached.schemaVersion !== PINS.schemaVersion ||
    detached.engineVersion !== PINS.engineVersion ||
    detached.rulesVersion !== PINS.rulesVersion ||
    !record(detached.initial) ||
    detached.initial.mode !== 'standard' ||
    !record(detached.initial.players) ||
    typeof detached.initial.players.white !== 'string' ||
    typeof detached.initial.players.black !== 'string' ||
    !detached.initial.players.white ||
    !detached.initial.players.black ||
    detached.initial.players.white === detached.initial.players.black
  )
    throw new PlatformError('engine_unavailable', 503);
  // This checks only cheap routing fields. Full strict verification is worker-owned.
  return detached as unknown as chess.StrictChessState;
}
function participants(state: chess.StrictChessState): Participants {
  return [
    { userId: state.initial.players.white, seat: 0 },
    { userId: state.initial.players.black, seat: 1 },
  ];
}
function mappedOutcome(state: chess.StrictChessState): GameOutcome | undefined {
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
  if (error instanceof ChessProofWorkerError && error.engineCode) {
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

export interface StrictChessRuntimeOptions {
  /** Supplied workers remain caller-owned; the default worker is runtime-owned. */
  worker?: ChessProofWorker;
  maxCachedStates?: number;
  maxCachedBytes?: number;
}

/** Prepared-only experiment. This class is deliberately absent from PlatformModule. */
export class StrictChessGameRuntime implements TableGameRuntime {
  readonly version = chess.STRICT_ENGINE_VERSION;
  private readonly views = new Map<string, ViewEntry>();
  private readonly warming = new Map<
    string,
    { promise: Promise<void>; abort: AbortController }
  >();
  private cachedBytes = 0;
  private closed = false;

  private constructor(
    private readonly worker: ChessProofWorker,
    private readonly ownsWorker: boolean,
    private readonly rootEvidence: chess.ReachabilityEvidence,
    private readonly maxCachedStates: number,
    private readonly maxCachedBytes: number,
  ) {}

  static async create(
    options: StrictChessRuntimeOptions = {},
  ): Promise<StrictChessGameRuntime> {
    const maxCachedStates = options.maxCachedStates ?? 64,
      maxCachedBytes = options.maxCachedBytes ?? 16 * 1024 * 1024;
    if (
      !Number.isSafeInteger(maxCachedStates) ||
      maxCachedStates < 1 ||
      maxCachedStates > 256 ||
      !Number.isSafeInteger(maxCachedBytes) ||
      maxCachedBytes < 1 ||
      maxCachedBytes > 32 * 1024 * 1024
    )
      throw new PlatformError('platform_unavailable', 503);
    const worker = options.worker ?? new ChessProofWorker();
    try {
      // A standard-root mating witness is independent of participant identities.
      // It is verified in the worker, then rechecked for each strict initial state.
      const evidence: chess.ReachableMateWitness = {
        kind: 'reachable-mate',
        engineVersion: PINS.proofEngineVersion,
        rulesVersion: PINS.proofRulesVersion,
        root: chess.positionKey(chess.parseFen(chess.START_FEN)),
        winner: 'black',
        moves: [
          { from: 'f2', to: 'f3' },
          { from: 'e7', to: 'e5' },
          { from: 'g2', to: 'g4' },
          { from: 'd8', to: 'h4' },
        ],
      };
      const checked = await worker.verify(chess.START_FEN, evidence);
      if (checked.status !== 'not-dead')
        throw new PlatformError('platform_unavailable', 503);
      return new StrictChessGameRuntime(
        worker,
        !options.worker,
        frozenJson(checked.evidence),
        maxCachedStates,
        maxCachedBytes,
      );
    } catch (error) {
      if (!options.worker) await worker.close();
      throw failure(error);
    }
  }

  private key(stateHash: string): string {
    return chessSnapshotDigest({ ...PINS, stateHash });
  }
  private remember(
    state: chess.StrictChessState,
    observations: StrictChessObserved['observations'],
  ): void {
    if (this.closed) throw new PlatformError('engine_unavailable', 503);
    const roster = state.initial.players;
    if (
      observations.length !== 2 ||
      observations.some((entry, seat) => {
        const color = seat === 0 ? 'white' : 'black',
          view = entry.observation;
        return (
          entry.userId !== roster[color] ||
          view.viewer !== entry.userId ||
          view.viewerColor !== color ||
          view.rulesVersion !== PINS.rulesVersion ||
          view.revision !== state.revision ||
          view.fen !== state.fen ||
          view.phase !== state.phase ||
          view.players.white !== roster.white ||
          view.players.black !== roster.black
        );
      })
    )
      throw new PlatformError('platform_unavailable', 503);
    const encoded = JSON.stringify(observations),
      bytes = Buffer.byteLength(encoded),
      key = this.key(chessSnapshotDigest(state));
    if (bytes > this.maxCachedBytes)
      throw new PlatformError('platform_unavailable', 503);
    const stable = frozenJson(JSON.parse(encoded) as typeof observations);
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
      observations: new Map(
        stable.map((entry) => [entry.userId, entry.observation]),
      ),
      bytes,
    });
    this.cachedBytes += bytes;
  }
  private verifiedBinding(
    result: StrictChessObserved,
    input: unknown,
    state: chess.StrictChessState,
  ): void {
    if (
      Object.entries(PINS).some(
        ([name, value]) => result[name as keyof typeof PINS] !== value,
      ) ||
      result.sourceHash !== chessSnapshotDigest(input) ||
      result.stateHash !== chessSnapshotDigest(state)
    )
      throw new PlatformError('platform_unavailable', 503);
  }

  start(input: {
    gameId: GameId;
    formatId: string;
    participants: Participants;
  }): { rulesVersion: string; state: chess.StrictChessState } {
    if (
      this.closed ||
      input.gameId !== 'chess' ||
      input.formatId !== 'standard'
    )
      throw new PlatformError('engine_unavailable', 503);
    const prepared = chess.prepareStrictGame({
      players: players(input.participants),
    });
    if (!prepared.ok) throw new PlatformError('platform_unavailable', 503);
    const finished = chess.finishStrictCandidate(
      prepared.value,
      this.rootEvidence,
    );
    if (!finished.ok) throw new PlatformError('platform_unavailable', 503);
    const observations = ['white', 'black'].map((color) => {
      const userId = finished.state.initial.players[color as chess.Color],
        view = chess.getStrictObservation(finished.state, userId);
      if (!view.ok) throw new PlatformError('platform_unavailable', 503);
      return { userId, observation: view.value };
    });
    this.remember(finished.state, observations);
    return { rulesVersion: PINS.rulesVersion, state: finished.state };
  }

  apply(): never {
    throw new PlatformError('engine_unavailable', 503);
  }

  async prepare(input: GameActionInput): Promise<GameActionTransition> {
    try {
      if (this.closed) throw new PlatformError('engine_unavailable', 503);
      const state = snapshot(input.state),
        roster = players(input.participants);
      if (
        roster.white !== state.initial.players.white ||
        roster.black !== state.initial.players.black
      )
        throw new PlatformError('platform_unavailable', 503);
      if (input.userId !== roster.white && input.userId !== roster.black)
        throw new PlatformError('not_participating', 403);
      const stableInput = {
        state,
        userId: input.userId,
        action: JSON.parse(JSON.stringify(input.action)) as unknown,
        participants: input.participants,
      };
      const result = await this.worker.prepareStrictAction(stableInput),
        next = snapshot(result.accepted.state);
      this.verifiedBinding(result, stableInput, next);
      if (
        next.initial.players.white !== roster.white ||
        next.initial.players.black !== roster.black ||
        next.revision !== state.revision + 1 ||
        result.accepted.gameplay !== true ||
        chessSnapshotDigest(result.accepted.outcome ?? null) !==
          chessSnapshotDigest(mappedOutcome(next) ?? null)
      )
        throw new PlatformError('platform_unavailable', 503);
      this.remember(next, result.observations);
      return result.accepted;
    } catch (error) {
      throw failure(error);
    }
  }

  /** Explicit cold repair is safe to await only outside a database transaction. */
  warmObservations(value: unknown): Promise<void> {
    try {
      if (this.closed) throw new PlatformError('engine_unavailable', 503);
      const state = snapshot(value),
        key = this.key(chessSnapshotDigest(state));
      if (this.views.has(key)) return Promise.resolve();
      const existing = this.warming.get(key);
      if (existing) return existing.promise;
      if (this.warming.size >= 2)
        throw new PlatformError('platform_unavailable', 503);
      const input = { state, participants: participants(state) },
        abort = new AbortController(),
        promise = this.worker
          .observeStrict(input, { signal: abort.signal })
          .then((result) => {
            this.verifiedBinding(result, input, state);
            this.remember(state, result.observations);
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
  }): chess.StrictChessObservation {
    if (this.closed) throw new PlatformError('engine_unavailable', 503);
    let state: chess.StrictChessState, key: string;
    try {
      state = snapshot(input.state);
      key = this.key(chessSnapshotDigest(state));
    } catch (error) {
      throw failure(error);
    }
    if (
      input.userId !== state.initial.players.white &&
      input.userId !== state.initial.players.black
    )
      throw new PlatformError('not_participating', 403);
    const entry = this.views.get(key),
      view = entry?.observations.get(input.userId);
    if (!entry || !view) {
      // No proof replay under PlatformStore's synchronous snapshot lock. Existing
      // repair retries can observe the verified cache after this worker finishes.
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
