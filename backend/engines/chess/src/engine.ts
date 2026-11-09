import {
  ENGINE_VERSION,
  RULES_VERSION,
  SCHEMA_VERSION,
  START_FEN,
  STRICT_SCHEMA_VERSION,
  STRICT_ENGINE_VERSION,
  STRICT_RULES_VERSION,
  STRICT_PROOF_ENGINE_VERSION,
  STRICT_PROOF_RULES_VERSION,
  ARTIFACT_SCHEMA_VERSION,
  ARTIFACT_ENGINE_VERSION,
  ARTIFACT_RULES_VERSION,
  type Adjudication,
  type ChessObservation,
  type ChessState,
  type ClaimOptions,
  type Color,
  type CreateGameOptions,
  type CreateAnalysisOptions,
  type EngineError,
  type GameEvent,
  type HistoryRecord,
  type InitialState,
  type MatchOutcome,
  type MoveAction,
  type MoveSpec,
  type OutcomeReason,
  type PlayerAction,
  type Players,
  type Result,
  type RoundOutcome,
  type TransitionResult,
  type ValidationResult,
  type StrictChessState,
  type StrictChessCandidate,
  type StrictDecisionReceipt,
  type StrictTransitionResult,
  type StrictChessObservation,
  type ArtifactDescriptor,
  type CheckedArtifactBinding,
  type ArtifactDecisionRef,
  type ArtifactChessState,
  type ArtifactChessCandidate,
  type ArtifactTransitionResult,
  type ArtifactChessObservation,
} from './types.js';
import { asError, fail, keys, object, text, uint } from './errors.js';
import {
  MAX_FEN_COUNTER,
  advance,
  findLegalMove,
  inCheck,
  legalBoardMoves,
  materialDead,
  moveSpec,
  opposite,
  parseFen,
  parseMove,
  positionKey,
  sameMove,
  san,
  toFen,
  uci,
  type BoardMove,
  type Position,
} from './position.js';
import {
  analyzeDeadPosition,
  analyzeMatePossibility,
  validateMateWitness,
} from './proofs.js';
import { lockedPositionCertificate } from './locked.js';
import { kingCorridorCertificate } from './joint-kings.js';
import { temporalPositionCertificate } from './temporal.js';
import {
  solveMateReachability,
  verifyReachabilityEvidence,
  verifyReachabilityDecision,
  type ReachabilityEvidence,
} from './reachability.js';
import {
  REACHABILITY_STREAM_FORMAT,
  isVerifiedStreamingReachabilityDecision,
} from './streaming-reachability.js';

const MAX_RECORDS = 50_000;
const MAX_SNAPSHOT_CHARS = 16_000_000;
const trusted = new WeakSet<object>();
interface Transition {
  state: ChessState;
  events: GameEvent[];
}
type PositionDecisionResolver = (
  position: Position,
  revision: number,
  ply: number,
) => 'dead' | 'not-dead';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function seal(state: ChessState): ChessState {
  // JSON escaping can be much longer than the underlying strings. Enforce the
  // same exact text bound on accepted states as on later imports. Replay seals
  // once after all records, avoiding serialization of every replay prefix.
  if (JSON.stringify(state).length > MAX_SNAPSHOT_CHARS)
    fail('RESOURCE_LIMIT', 'Snapshot exceeds the supported resource bound.');
  freeze(state);
  trusted.add(state);
  return state;
}
function success(transition: Transition): TransitionResult {
  return {
    ok: true,
    state: seal(transition.state),
    events: freeze(transition.events),
  };
}
function reject(error: unknown): { ok: false; error: EngineError } {
  return { ok: false, error: asError(error) };
}
function parsePlayers(value: unknown): Players {
  const p = object(value, 'INVALID_CONFIG');
  keys(p, ['white', 'black'], 'INVALID_CONFIG');
  const white = text(p.white, 'White player id'),
    black = text(p.black, 'Black player id');
  if (white === black)
    fail('INVALID_CONFIG', 'White and Black must be different participants.');
  return { white, black };
}
function parseCounts(value: unknown): { white: number; black: number } {
  const c = object(value, 'INVALID_CONFIG');
  keys(c, ['white', 'black'], 'INVALID_CONFIG');
  return {
    white: uint(c.white, 'White move count', 1_000_000, 'INVALID_CONFIG'),
    black: uint(c.black, 'Black move count', 1_000_000, 'INVALID_CONFIG'),
  };
}
function parseInitial(value: unknown): InitialState {
  const o = object(value, 'INVALID_STATE');
  keys(o, ['mode', 'players', 'fen', 'movesBeforeStart'], 'INVALID_STATE');
  if (o.mode !== 'standard' && o.mode !== 'analysis')
    fail('INVALID_CONFIG', 'Only standard and analysis roots are supported.');
  const players = parsePlayers(o.players),
    fen = toFen(parseFen(o.fen)),
    movesBeforeStart = parseCounts(o.movesBeforeStart);
  if (
    o.mode === 'standard' &&
    (fen !== START_FEN ||
      movesBeforeStart.white !== 0 ||
      movesBeforeStart.black !== 0)
  )
    fail(
      'INVALID_CONFIG',
      'Production standard games must start at the standard initial position. Restore snapshots to resume.',
    );
  return { mode: o.mode, players, fen, movesBeforeStart };
}
function parseAction(value: unknown): PlayerAction {
  const a = object(value);
  switch (a.type) {
    case 'move': {
      keys(a, ['type', 'from', 'to', 'promotion', 'offerDraw']);
      if ('offerDraw' in a && typeof a.offerDraw !== 'boolean')
        fail('INVALID_ACTION', 'offerDraw must be boolean.');
      const move = parseMove({
        from: a.from,
        to: a.to,
        ...('promotion' in a ? { promotion: a.promotion } : {}),
      });
      return {
        type: 'move',
        ...move,
        ...(a.offerDraw ? { offerDraw: true } : {}),
      };
    }
    case 'offer-draw':
    case 'accept-draw':
    case 'decline-draw':
      keys(a, ['type']);
      return { type: a.type };
    case 'claim-draw': {
      keys(a, ['type', 'reason', 'intendedMove']);
      if (a.reason !== 'threefold-repetition' && a.reason !== 'fifty-move')
        fail('INVALID_ACTION', 'Unsupported draw claim.');
      return {
        type: 'claim-draw',
        reason: a.reason,
        ...('intendedMove' in a
          ? { intendedMove: parseMove(a.intendedMove) }
          : {}),
      };
    }
    case 'resign': {
      keys(a, ['type', 'mateWitness']);
      if ('mateWitness' in a) {
        if (
          !Array.isArray(a.mateWitness) ||
          a.mateWitness.length < 1 ||
          a.mateWitness.length > 256
        )
          fail('INVALID_PROOF', 'mateWitness must contain 1–256 moves.');
        return { type: 'resign', mateWitness: a.mateWitness.map(parseMove) };
      }
      return { type: 'resign' };
    }
    default:
      fail(
        'INVALID_ACTION',
        'Unknown action type. Clocks, disconnects, takebacks and Chess960 are not supported.',
      );
  }
}
function parseAdjudication(value: unknown): Adjudication {
  const a = object(value, 'INVALID_ADJUDICATION');
  if (a.type !== 'dead-position' && a.type !== 'resignation')
    fail('INVALID_ADJUDICATION', 'Unsupported adjudication.');
  keys(
    a,
    a.type === 'dead-position'
      ? ['type', 'authority', 'evidence']
      : ['type', 'opponentCanMate', 'authority', 'evidence'],
    'INVALID_ADJUDICATION',
  );
  const authority = text(
    a.authority,
    'Adjudicator identity',
    'INVALID_ADJUDICATION',
  );
  const evidence = text(
    a.evidence,
    'Adjudication evidence/reference',
    'INVALID_ADJUDICATION',
    4096,
  );
  if (a.type === 'dead-position')
    return { type: 'dead-position', authority, evidence };
  if (typeof a.opponentCanMate !== 'boolean')
    fail('INVALID_ADJUDICATION', 'opponentCanMate must be boolean.');
  return {
    type: 'resignation',
    opponentCanMate: a.opponentCanMate,
    authority,
    evidence,
  };
}
function parseRecord(value: unknown): HistoryRecord {
  const r = object(value, 'INVALID_STATE');
  switch (r.kind) {
    case 'player':
      keys(r, ['kind', 'playerId', 'action'], 'INVALID_STATE');
      return {
        kind: 'player',
        playerId: text(r.playerId, 'Player id', 'INVALID_STATE'),
        action: parseAction(r.action),
      };
    case 'adjudication':
      keys(r, ['kind', 'decision'], 'INVALID_STATE');
      return { kind: 'adjudication', decision: parseAdjudication(r.decision) };
    case 'dead-position-proof':
      keys(r, ['kind', 'maxNodes'], 'INVALID_STATE');
      return {
        kind: 'dead-position-proof',
        maxNodes: uint(r.maxNodes, 'maxNodes', 100_000, 'INVALID_STATE'),
      };
    case 'resignation-proof':
      keys(r, ['kind', 'moves'], 'INVALID_STATE');
      if (!Array.isArray(r.moves) || r.moves.length < 1 || r.moves.length > 256)
        fail('INVALID_PROOF', 'A witness must contain 1–256 moves.');
      return { kind: 'resignation-proof', moves: r.moves.map(parseMove) };
    default:
      fail('INVALID_STATE', 'Unknown history record kind.');
  }
}
function playerColor(state: ChessState, playerId: unknown): Color {
  if (typeof playerId !== 'string')
    fail('UNKNOWN_PLAYER', 'Player id must identify a participant.');
  if (state.initial.players.white === playerId) return 'white';
  if (state.initial.players.black === playerId) return 'black';
  fail('UNKNOWN_PLAYER', 'Player is not a participant in this game.');
}
function requirePlaying(state: ChessState): void {
  if (state.phase === 'ended')
    fail('GAME_ENDED', 'The game has already ended.');
  if (state.phase === 'awaiting-adjudication')
    fail(
      'ADJUDICATION_PENDING',
      'Play has stopped; the resignation result requires a mating-possibility decision.',
    );
}
function checkRevision(state: ChessState, expectedRevision: unknown): void {
  if (expectedRevision === undefined) return;
  if (
    uint(
      expectedRevision,
      'expectedRevision',
      MAX_RECORDS,
      'STALE_REVISION',
    ) !== state.revision
  )
    fail('STALE_REVISION', 'State revision no longer matches the command.');
}
function finish(
  state: ChessState,
  winner: Color | null,
  reason: OutcomeReason,
  events: GameEvent[],
): ChessState {
  const scores = [
    {
      playerId: state.initial.players.white,
      color: 'white' as const,
      points:
        winner === null
          ? (0.5 as const)
          : winner === 'white'
            ? (1 as const)
            : (0 as const),
    },
    {
      playerId: state.initial.players.black,
      color: 'black' as const,
      points:
        winner === null
          ? (0.5 as const)
          : winner === 'black'
            ? (1 as const)
            : (0 as const),
    },
  ] as const;
  const roundOutcome: RoundOutcome = {
    roundNumber: 1,
    kind: winner === null ? 'draw' : 'win',
    winner,
    winnerId: winner ? state.initial.players[winner] : null,
    reason,
    ply: state.ply,
    scores,
  };
  const matchOutcome: MatchOutcome = {
    kind: roundOutcome.kind,
    winner,
    winnerId: roundOutcome.winnerId,
    reason: 'single-game-complete',
    gameReason: reason,
    scores,
  };
  events.push(
    { type: 'round-ended', outcome: roundOutcome },
    { type: 'match-ended', outcome: matchOutcome },
  );
  return {
    ...state,
    phase: 'ended',
    drawOffer: null,
    forcedMove: null,
    pendingResignation: null,
    roundOutcome,
    matchOutcome,
  };
}
function occurrences(history: readonly string[], key: string): number {
  let count = 0;
  for (const entry of history) if (entry === key) count++;
  return count;
}
// Bounded memoization only avoids redoing the SAME deterministic proof on replay.
// Preserve the literal exceptional-right fields in this internal cache key too.
// False means "not automatically proved", not "mate is possible".
const automaticProofCache = new Map<string, boolean>();
function computeAutomaticDeadProof(
  position: Position,
  moves: readonly BoardMove[],
): boolean {
  // This structural proof applies to mixed-piece pawn walls too, at EVERY
  // initial root and accepted move. Lack of pawn mobility alone is not proof.
  if (lockedPositionCertificate(position)) return true;
  if (kingCorridorCertificate(position)) return true;
  if (temporalPositionCertificate(position)) return true;
  // General exact graph proof for forced/low-mobility endings, checks, and
  // pawn-blocked positions (including bishops and other non-pawn pieces).
  // Gates only control work; a draw still requires closure or a sound certificate.
  const hasPawn = position.board.some((p) => p?.toLowerCase() === 'p');
  // Either side may be running out of legal moves. Looking only at the side
  // to move misses finite-tempo positions whose opponent is nearly stalemated.
  // This hypothetical turn only schedules work; it is NEVER proof evidence.
  // Search still starts from the unchanged actual turn and exceptional rights.
  const otherMoves = legalBoardMoves({
    ...position,
    turn: opposite(position.turn),
    ep: null,
  });
  const noPawnMove =
    hasPawn &&
    !moves.some((m) => position.board[m.from]?.toLowerCase() === 'p') &&
    !otherMoves.some((m) => position.board[m.from]?.toLowerCase() === 'p');
  if (
    moves.length <= 4 ||
    otherMoves.length <= 4 ||
    inCheck(position) ||
    noPawnMove
  ) {
    const fen = toFen(position);
    const limits = {
      maxPositions: 4096,
      maxExpanded: noPawnMove ? 2048 : 256,
      maxEdges: 8192,
    };
    const proof = solveMateReachability(fen, limits);
    if (proof.status === 'dead') {
      // Recheck closure rather than trusting the search's bookkeeping at a cutoff.
      if (!verifyReachabilityEvidence(fen, proof.evidence, limits).valid)
        fail(
          'INVALID_PROOF',
          'Automatic reachability proof failed verification.',
        );
      return true;
    }
  }
  return false;
}
function automaticDeadProof(
  position: Position,
  moves: readonly BoardMove[],
): boolean {
  const key = toFen(position).split(' ').slice(0, 4).join(' ');
  const cached = automaticProofCache.get(key);
  if (cached !== undefined) return cached;
  const proved = computeAutomaticDeadProof(position, moves);
  if (automaticProofCache.size >= 1024)
    automaticProofCache.delete(automaticProofCache.keys().next().value!);
  automaticProofCache.set(key, proved);
  return proved;
}
function automaticOutcome(
  state: ChessState,
  position: Position,
  events: GameEvent[],
  decisionResolver?: PositionDecisionResolver,
): ChessState {
  const moves = legalBoardMoves(position);
  const decision = decisionResolver?.(position, state.revision, state.ply);
  if (!moves.length)
    return finish(
      state,
      inCheck(position) ? opposite(position.turn) : null,
      inCheck(position) ? 'checkmate' : 'stalemate',
      events,
    );
  if (materialDead(position))
    return finish(state, null, 'dead-position-material', events);
  if (
    decisionResolver ? decision === 'dead' : automaticDeadProof(position, moves)
  )
    return finish(state, null, 'dead-position-proven', events);
  if (occurrences(state.positionHistory, positionKey(position)) >= 5)
    return finish(state, null, 'fivefold-repetition', events);
  if (position.halfmove >= 150)
    return finish(state, null, 'seventy-five-move', events);
  return state;
}
function root(
  initial: InitialState,
  decisionResolver?: PositionDecisionResolver,
): Transition {
  const p = parseFen(initial.fen),
    events: GameEvent[] = [{ type: 'game-created', mode: initial.mode }];
  const state: ChessState = {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    rulesVersion: RULES_VERSION,
    game: 'chess',
    initial,
    revision: 0,
    fen: toFen(p),
    turn: p.turn,
    ply: 0,
    movesByColor: { ...initial.movesBeforeStart },
    positionHistory: [positionKey(p)],
    history: [],
    phase: 'playing',
    drawOffer: null,
    forcedMove: null,
    pendingResignation: null,
    roundOutcome: null,
    matchOutcome: null,
  };
  return {
    state: automaticOutcome(state, p, events, decisionResolver),
    events,
  };
}
function setOffer(
  state: ChessState,
  by: Color,
  events: GameEvent[],
): ChessState {
  if (state.drawOffer?.by === by) return state;
  if (state.drawOffer) events.push({ type: 'draw-declined', by });
  events.push({ type: 'draw-offered', by });
  return { ...state, drawOffer: { by, atRevision: state.revision } };
}
function reducePlayer(
  state: ChessState,
  playerId: string,
  action: PlayerAction,
  events: GameEvent[],
  decisionResolver?: PositionDecisionResolver,
): ChessState {
  requirePlaying(state);
  const color = playerColor(state, playerId),
    position = parseFen(state.fen);
  if (action.type === 'move' || action.type === 'claim-draw') {
    if (color !== state.turn)
      fail(
        'NOT_YOUR_TURN',
        'Only the player to move can move or claim a repetition/move-count draw.',
      );
  }
  switch (action.type) {
    case 'move': {
      const spec: MoveSpec = {
        from: action.from,
        to: action.to,
        ...(action.promotion ? { promotion: action.promotion } : {}),
      };
      if (state.forcedMove && !sameMove(spec, state.forcedMove))
        fail(
          'FORCED_MOVE',
          'The legal intended move from the rejected draw claim is binding.',
        );
      const legal = legalBoardMoves(position),
        move = findLegalMove(position, spec, legal),
        after = advance(position, move);
      // Never accept a transition whose emitted FEN cannot be consumed again.
      // Hypothetical proof/perft moves keep their existing counter-independent
      // semantics; this is only a committed-state resource guard, not a result.
      if (after.halfmove > MAX_FEN_COUNTER || after.fullmove > MAX_FEN_COUNTER)
        fail(
          'RESOURCE_LIMIT',
          'The move exceeds the supported snapshot counter bound.',
        );
      const notation = san(position, move, legal),
        fen = toFen(after);
      if (state.drawOffer && state.drawOffer.by !== color)
        events.push({ type: 'draw-declined', by: color });
      let next: ChessState = {
        ...state,
        fen,
        turn: after.turn,
        ply: state.ply + 1,
        movesByColor: {
          ...state.movesByColor,
          [color]: state.movesByColor[color] + 1,
        },
        positionHistory: [...state.positionHistory, positionKey(after)],
        forcedMove: null,
        drawOffer: state.drawOffer?.by === color ? state.drawOffer : null,
      };
      events.push({
        type: 'move-played',
        playerId,
        color,
        move: spec,
        uci: uci(spec),
        san: notation,
        fen,
        ply: next.ply,
      });
      next = automaticOutcome(next, after, events, decisionResolver);
      if (next.phase === 'playing' && action.offerDraw)
        next = setOffer(next, color, events);
      return next;
    }
    case 'offer-draw':
      if (state.drawOffer)
        fail(
          'DRAW_OFFER_PENDING',
          'An offer is already pending; the opponent must accept, decline, or move.',
        );
      return setOffer(state, color, events);
    case 'accept-draw':
    case 'decline-draw': {
      if (!state.drawOffer)
        fail('NO_DRAW_OFFER', 'There is no draw offer to answer.');
      if (state.drawOffer.by === color)
        fail(
          'OWN_DRAW_OFFER',
          'A player cannot accept, withdraw, or decline their own offer.',
        );
      if (action.type === 'accept-draw') {
        if (state.movesByColor.white < 1 || state.movesByColor.black < 1)
          fail(
            'DRAW_TOO_EARLY',
            'Both players must have made at least one move before agreeing a draw.',
          );
        return finish(state, null, 'draw-agreement', events);
      }
      events.push({ type: 'draw-declined', by: color });
      return { ...state, drawOffer: null };
    }
    case 'claim-draw': {
      let candidate = position,
        repetitionCount: number;
      if (action.intendedMove) {
        if (
          state.forcedMove &&
          !sameMove(state.forcedMove, action.intendedMove)
        )
          fail(
            'FORCED_MOVE',
            'A previous intended-move claim already committed this turn to another move.',
          );
        candidate = advance(
          position,
          findLegalMove(position, action.intendedMove),
        );
        repetitionCount =
          occurrences(state.positionHistory, positionKey(candidate)) + 1;
      } else
        repetitionCount = occurrences(
          state.positionHistory,
          positionKey(position),
        );
      const valid =
        action.reason === 'threefold-repetition'
          ? repetitionCount >= 3
          : candidate.halfmove >= 100;
      if (valid) {
        events.push({
          type: 'draw-claim-accepted',
          by: color,
          reason: action.reason,
          intendedMove: action.intendedMove ?? null,
        });
        return finish(state, null, action.reason, events); // intended move is NOT played
      }
      // This is an adjudicated but incorrect CLAIM, not an invalid network request.
      // Keep its rule consequences. The excluded clock subsystem supplies no penalty.
      const offered = setOffer(state, color, events);
      const forcedMove = action.intendedMove ?? state.forcedMove;
      events.push({
        type: 'draw-claim-rejected',
        by: color,
        reason: action.reason,
        forcedMove,
        clockPenaltyApplied: false,
      });
      return { ...offered, forcedMove };
    }
    case 'resign': {
      const winner = opposite(color);
      if (action.mateWitness)
        validateMateWitness(state.fen, winner, action.mateWitness);
      events.push({ type: 'resignation-received', by: color });
      if (action.mateWitness)
        return finish(state, winner, 'resignation', events);
      const analysis = analyzeMatePossibility(state.fen, winner, 256);
      if (analysis.status === 'impossible')
        return finish(state, null, 'resignation-no-possible-mate', events);
      if (analysis.status === 'possible')
        return finish(state, winner, 'resignation', events);
      events.push({
        type: 'adjudication-required',
        reason: 'mate-possibility-unresolved',
      });
      return {
        ...state,
        phase: 'awaiting-adjudication',
        drawOffer: null,
        forcedMove: null,
        pendingResignation: {
          resigned: color,
          prospectiveWinner: winner,
          reason: 'mate-possibility-unresolved',
        },
      };
    }
  }
}
function reduce(
  state: ChessState,
  record: HistoryRecord,
  decisionResolver?: PositionDecisionResolver,
): Transition {
  if (state.phase === 'ended')
    fail('GAME_ENDED', 'The game has already ended.');
  if (state.history.length >= MAX_RECORDS)
    fail(
      'RESOURCE_LIMIT',
      'History resource limit reached; do not discard past repetition history to bypass it.',
    );
  let next: ChessState = {
    ...state,
    revision: state.revision + 1,
    history: [...state.history, record],
  };
  const events: GameEvent[] = [];
  switch (record.kind) {
    case 'player':
      next = reducePlayer(
        next,
        record.playerId,
        record.action,
        events,
        decisionResolver,
      );
      break;
    case 'adjudication': {
      const d = record.decision;
      if (d.type === 'dead-position') {
        if (state.phase !== 'playing')
          fail(
            'INVALID_ADJUDICATION',
            'Use a resignation decision while a resignation is pending.',
          );
        events.push({ type: 'adjudication-recorded', decision: d.type });
        next = finish(next, null, 'dead-position-adjudicated', events);
      } else {
        if (
          !state.pendingResignation ||
          state.phase !== 'awaiting-adjudication'
        )
          fail(
            'INVALID_ADJUDICATION',
            'No resignation result is awaiting adjudication.',
          );
        events.push({ type: 'adjudication-recorded', decision: d.type });
        next = finish(
          next,
          d.opponentCanMate ? state.pendingResignation.prospectiveWinner : null,
          d.opponentCanMate ? 'resignation' : 'resignation-no-possible-mate',
          events,
        );
      }
      break;
    }
    case 'dead-position-proof': {
      requirePlaying(state);
      const proof = analyzeDeadPosition(state.fen, record.maxNodes);
      if (proof.status === 'unknown')
        fail(
          'PROOF_INCONCLUSIVE',
          'The resource bound was reached; this is NOT proof of a dead position.',
        );
      if (proof.status === 'not-dead')
        fail('INVALID_PROOF', 'A legal checkmating continuation exists.');
      next = finish(next, null, 'dead-position-proven', events);
      break;
    }
    case 'resignation-proof': {
      if (!state.pendingResignation || state.phase !== 'awaiting-adjudication')
        fail('INVALID_PROOF', 'No resignation result is awaiting proof.');
      validateMateWitness(
        state.fen,
        state.pendingResignation.prospectiveWinner,
        record.moves,
      );
      next = finish(
        next,
        state.pendingResignation.prospectiveWinner,
        'resignation',
        events,
      );
      break;
    }
  }
  return { state: next, events };
}

/** JSON structural equality with a strict JSON-only boundary; ignores object key order. */
function canonical(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): string {
  if (depth > 40) fail('INVALID_STATE', 'Snapshot exceeds the nesting limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (typeof value !== 'object' || value === null)
    fail('INVALID_STATE', 'State must contain only JSON values.');
  if (seen.has(value))
    fail('INVALID_STATE', 'Cyclic state is not serializable.');
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length)
      fail(
        'INVALID_STATE',
        'Sparse arrays and extra array properties are not permitted.',
      );
    result = `[${value.map((v) => canonical(v, seen, depth + 1)).join(',')}]`;
  } else {
    const o = object(value, 'INVALID_STATE');
    result = `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k], seen, depth + 1)}`)
      .join(',')}}`;
  }
  seen.delete(value);
  return result;
}
function restore(value: unknown): ChessState {
  if (value && typeof value === 'object' && trusted.has(value))
    return value as ChessState;
  const o = object(value, 'INVALID_STATE');
  if (
    o.schemaVersion !== SCHEMA_VERSION ||
    o.engineVersion !== ENGINE_VERSION ||
    o.rulesVersion !== RULES_VERSION
  )
    fail(
      'UNSUPPORTED_VERSION',
      'Snapshot version is unsupported. Migrate explicitly; do not reinterpret an old rules version.',
    );
  keys(
    o,
    [
      'schemaVersion',
      'engineVersion',
      'rulesVersion',
      'game',
      'initial',
      'revision',
      'fen',
      'turn',
      'ply',
      'movesByColor',
      'positionHistory',
      'history',
      'phase',
      'drawOffer',
      'forcedMove',
      'pendingResignation',
      'roundOutcome',
      'matchOutcome',
    ],
    'INVALID_STATE',
  );
  if (!Array.isArray(o.history) || o.history.length > MAX_RECORDS)
    fail('INVALID_STATE', 'History is missing or exceeds the record limit.');
  const actual = canonical(value);
  if (actual.length > MAX_SNAPSHOT_CHARS)
    fail('RESOURCE_LIMIT', 'Snapshot exceeds the supported resource bound.');
  let state = root(parseInitial(o.initial)).state;
  for (let index = 0; index < o.history.length; index++) {
    try {
      state = reduce(state, parseRecord(o.history[index])).state;
    } catch (error) {
      fail(
        'INVALID_STATE',
        `Invalid history record ${index}: ${asError(error).message}`,
      );
    }
  }
  if (canonical(state) !== actual)
    fail(
      'INVALID_STATE',
      'Snapshot does not match its replayed history, counters, position, or outcome.',
    );
  return seal(state);
}

export function createGame(options: CreateGameOptions): TransitionResult {
  try {
    const o = object(options, 'INVALID_CONFIG');
    keys(o, ['players'], 'INVALID_CONFIG');
    return success(
      root({
        mode: 'standard',
        players: parsePlayers(o.players),
        fen: START_FEN,
        movesBeforeStart: { white: 0, black: 0 },
      }),
    );
  } catch (error) {
    return reject(error);
  }
}
/** Testing/puzzles/import scenarios only. This does not fabricate the missing earlier history. */
export function createAnalysisGame(
  options: CreateAnalysisOptions,
): TransitionResult {
  try {
    const o = object(options, 'INVALID_CONFIG');
    keys(o, ['players', 'fen', 'movesBeforeStart'], 'INVALID_CONFIG');
    return success(
      root({
        mode: 'analysis',
        players: parsePlayers(o.players),
        fen: toFen(parseFen(o.fen)),
        movesBeforeStart:
          o.movesBeforeStart === undefined
            ? { white: 0, black: 0 }
            : parseCounts(o.movesBeforeStart),
      }),
    );
  } catch (error) {
    return reject(error);
  }
}
/** Both humans and bots MUST enter through this same transition function. */
export function applyAction(
  value: ChessState,
  actingPlayer: string,
  input: unknown,
  expectedRevision?: number,
): TransitionResult {
  try {
    const state = restore(value);
    checkRevision(state, expectedRevision);
    playerColor(state, actingPlayer);
    return success(
      reduce(state, {
        kind: 'player',
        playerId: actingPlayer,
        action: parseAction(input),
      }),
    );
  } catch (error) {
    return reject(error);
  }
}
/** Not a player endpoint. Authenticate/authorize the adjudicator in the backend. */
export function adjudicate(
  value: ChessState,
  decision: Adjudication,
  expectedRevision: number,
): TransitionResult {
  try {
    const state = restore(value);
    uint(expectedRevision, 'expectedRevision', MAX_RECORDS, 'STALE_REVISION');
    checkRevision(state, expectedRevision);
    return success(
      reduce(state, {
        kind: 'adjudication',
        decision: parseAdjudication(decision),
      }),
    );
  } catch (error) {
    return reject(error);
  }
}
/** A failed/inconclusive proof leaves the state unchanged. No heuristic draw ruling. */
export function proveDeadPosition(
  value: ChessState,
  maxNodes = 2048,
  expectedRevision?: number,
): TransitionResult {
  try {
    const state = restore(value);
    checkRevision(state, expectedRevision);
    return success(
      reduce(state, parseRecord({ kind: 'dead-position-proof', maxNodes })),
    );
  } catch (error) {
    return reject(error);
  }
}
export function resolveResignationWithWitness(
  value: ChessState,
  moves: unknown,
  expectedRevision: number,
): TransitionResult {
  try {
    const state = restore(value);
    uint(expectedRevision, 'expectedRevision', MAX_RECORDS, 'STALE_REVISION');
    checkRevision(state, expectedRevision);
    return success(
      reduce(state, parseRecord({ kind: 'resignation-proof', moves })),
    );
  } catch (error) {
    return reject(error);
  }
}
function permittedBoardMoves(
  state: ChessState,
  position: Position,
): BoardMove[] {
  const moves = legalBoardMoves(position);
  return state.forcedMove
    ? moves.filter((m) => sameMove(moveSpec(m), state.forcedMove!))
    : moves;
}
function claimOptions(state: ChessState, position: Position): ClaimOptions {
  const current: ('threefold-repetition' | 'fifty-move')[] = [],
    byIntendedMove: {
      reason: 'threefold-repetition' | 'fifty-move';
      move: MoveSpec;
    }[] = [];
  if (state.phase !== 'playing') return { current, byIntendedMove };
  if (occurrences(state.positionHistory, positionKey(position)) >= 3)
    current.push('threefold-repetition');
  if (position.halfmove >= 100) current.push('fifty-move');
  for (const move of permittedBoardMoves(state, position)) {
    const candidate = advance(position, move),
      spec = moveSpec(move);
    if (occurrences(state.positionHistory, positionKey(candidate)) + 1 >= 3)
      byIntendedMove.push({ reason: 'threefold-repetition', move: spec });
    if (candidate.halfmove >= 100)
      byIntendedMove.push({ reason: 'fifty-move', move: spec });
  }
  return { current, byIntendedMove };
}
export function getDrawClaims(
  value: ChessState,
  actingPlayer: string,
): Result<ClaimOptions> {
  try {
    const state = restore(value),
      color = playerColor(state, actingPlayer);
    return {
      ok: true,
      value:
        color === state.turn
          ? freeze(claimOptions(state, parseFen(state.fen)))
          : { current: [], byIntendedMove: [] },
    };
  } catch (error) {
    return reject(error);
  }
}
function actions(state: ChessState, color: Color): PlayerAction[] {
  if (state.phase !== 'playing') return [];
  const result: PlayerAction[] = [];
  if (color === state.turn) {
    const position = parseFen(state.fen);
    result.push(
      ...permittedBoardMoves(state, position)
        .map((move): MoveAction => ({ type: 'move', ...moveSpec(move) }))
        .sort((a, b) => (uci(a) < uci(b) ? -1 : uci(a) > uci(b) ? 1 : 0)),
    );
    const claims = claimOptions(state, position);
    result.push(
      ...claims.current.map((reason): PlayerAction => ({
        type: 'claim-draw',
        reason,
      })),
    );
    result.push(
      ...claims.byIntendedMove.map(({ reason, move }): PlayerAction => ({
        type: 'claim-draw',
        reason,
        intendedMove: move,
      })),
    );
  }
  if (!state.drawOffer) result.push({ type: 'offer-draw' });
  else if (state.drawOffer.by !== color) {
    if (state.movesByColor.white >= 1 && state.movesByColor.black >= 1)
      result.push({ type: 'accept-draw' });
    result.push({ type: 'decline-draw' });
  }
  result.push({ type: 'resign' });
  return result;
}
/** Returns canonical available actions. Moves may also attach offerDraw:true. */
export function getLegalActions(
  value: ChessState,
  actingPlayer: string,
): Result<readonly PlayerAction[]> {
  try {
    const state = restore(value);
    return {
      ok: true,
      value: freeze(actions(state, playerColor(state, actingPlayer))),
    };
  } catch (error) {
    return reject(error);
  }
}
function observation(
  state: ChessState,
  viewer: string | null,
): ChessObservation {
  const viewerColor = viewer === null ? null : playerColor(state, viewer);
  // Reconstruct public notation from each historical board, rather than from
  // transient events or the current board. Non-move decisions do not advance
  // this position and no automatic outcome/proof work is repeated here.
  let movePosition = parseFen(state.initial.fen);
  const moves = state.history.flatMap((record) => {
    if (record.kind !== 'player' || record.action.type !== 'move') return [];
    const action = record.action;
    const legal = legalBoardMoves(movePosition),
      boardMove = findLegalMove(movePosition, action, legal),
      notation = san(movePosition, boardMove, legal);
    movePosition = advance(movePosition, boardMove);
    return [
      {
        by: playerColor(state, record.playerId),
        san: notation,
        move: {
          from: action.from,
          to: action.to,
          ...(action.promotion ? { promotion: action.promotion } : {}),
        },
      },
    ];
  });
  return freeze({
    game: 'chess',
    rulesVersion: RULES_VERSION,
    revision: state.revision,
    viewer,
    viewerColor,
    players: { ...state.initial.players },
    fen: state.fen,
    turn: state.turn,
    ply: state.ply,
    phase: state.phase,
    inCheck: inCheck(parseFen(state.fen)),
    drawOffer: state.drawOffer,
    forcedMove: state.forcedMove,
    awaitingResignationDecision: state.pendingResignation !== null,
    moves,
    legalActions: viewerColor ? actions(state, viewerColor) : [],
    roundOutcome: state.roundOutcome,
    matchOutcome: state.matchOutcome,
    analysisRoot: state.initial.mode === 'analysis',
    conformance: {
      clocks: false,
      automaticDeadPositionDetection: 'material-and-bounded-proof',
      exhaustiveDeadPositionOracle: false,
    },
  });
}
export function getObservation(
  value: ChessState,
  viewer: string | null,
): Result<ChessObservation> {
  try {
    return { ok: true, value: observation(restore(value), viewer) };
  } catch (error) {
    return reject(error);
  }
}
export function validateState(value: unknown): ValidationResult {
  try {
    restore(value);
    return { valid: true, issues: [] };
  } catch (error) {
    return {
      valid: false,
      issues: [
        {
          path: '$',
          message: `${asError(error).code}: ${asError(error).message}`,
        },
      ],
    };
  }
}
export function serializeState(value: ChessState): Result<string> {
  try {
    return { ok: true, value: JSON.stringify(restore(value)) };
  } catch (error) {
    return reject(error);
  }
}
export function restoreState(value: unknown): Result<ChessState> {
  try {
    if (typeof value === 'string' && value.length > MAX_SNAPSHOT_CHARS)
      fail('RESOURCE_LIMIT', 'Snapshot is too large.');
    let parsed: unknown = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value) as unknown;
      } catch {
        fail('INVALID_STATE', 'Malformed snapshot JSON.');
      }
    }
    return { ok: true, value: restore(parsed) };
  } catch (error) {
    return reject(error);
  }
}
/** Replay authoritative accepted records. This verifies rules, not their provenance/signatures. */
export function replay(initial: unknown, records: unknown): Result<ChessState> {
  try {
    if (!Array.isArray(records) || records.length > MAX_RECORDS)
      fail('INVALID_STATE', 'Replay records must be a bounded array.');
    let state = root(parseInitial(initial)).state;
    for (const record of records)
      state = reduce(state, parseRecord(record)).state;
    return { ok: true, value: seal(state) };
  } catch (error) {
    return reject(error);
  }
}

// The experimental strict profile has its own trust boundary and snapshots.
// Its temporary core values are reducer inputs, NEVER legacy-restorable states.
const strictTrusted = new WeakSet<object>();
const strictCandidates = new WeakMap<
  StrictChessCandidate,
  {
    build: (resolver: PositionDecisionResolver) => Transition;
    decisions: readonly StrictDecisionReceipt[];
    completed: Transition | null;
  }
>();
const STRICT_PROOF_LIMITS = {
  maxPositions: 100_000,
  maxExpanded: 100_000,
  maxEdges: 2_000_000,
} as const;
class StrictDecisionRequest extends Error {
  constructor(
    readonly fen: string,
    readonly revision: number,
  ) {
    super('A reachability decision is required.');
  }
}
function detachedStrictJSON(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string') fail('INVALID_STATE', 'Expected JSON data.');
  if (encoded.length > MAX_SNAPSHOT_CHARS)
    fail(
      'RESOURCE_LIMIT',
      'Strict snapshot or evidence exceeds the JSON limit.',
    );
  return JSON.parse(encoded) as unknown;
}
function strictCore(state: StrictChessState | ArtifactChessState): ChessState {
  const { decisions, ...fields } = state;
  void decisions;
  return {
    ...fields,
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    rulesVersion: RULES_VERSION,
  };
}
function strictSeal(
  core: ChessState,
  decisions: readonly StrictDecisionReceipt[],
): StrictChessState {
  validateProofProfileCore(core);
  const state = {
    ...core,
    schemaVersion: STRICT_SCHEMA_VERSION,
    engineVersion: STRICT_ENGINE_VERSION,
    rulesVersion: STRICT_RULES_VERSION,
    decisions,
  } as StrictChessState;
  if (JSON.stringify(state).length > MAX_SNAPSHOT_CHARS)
    fail('RESOURCE_LIMIT', 'Strict snapshot exceeds the JSON limit.');
  freeze(state);
  strictTrusted.add(state);
  return state;
}
function validateProofProfileCore(core: ChessState): void {
  if (
    core.initial.mode !== 'standard' ||
    core.phase === 'awaiting-adjudication' ||
    core.pendingResignation ||
    core.history.some(
      (record) => record.kind !== 'player' || record.action.type === 'resign',
    )
  )
    fail(
      'INVALID_STATE',
      'Strict play supports standard roots and ordinary non-resignation player actions only.',
    );
}
function checkedStrictDecision(
  position: Position,
  evidence: unknown,
): 'dead' | 'not-dead' {
  requirePinnedProofKernel();
  const checked = verifyReachabilityDecision(
    toFen(position),
    evidence,
    STRICT_PROOF_LIMITS,
  );
  if (!checked.valid) fail('INVALID_PROOF', checked.reason);
  return checked.verdict;
}
function requirePinnedProofKernel(): void {
  if (
    ENGINE_VERSION !== STRICT_PROOF_ENGINE_VERSION ||
    RULES_VERSION !== STRICT_PROOF_RULES_VERSION
  )
    fail(
      'UNSUPPORTED_VERSION',
      'The strict profile requires its pinned verification kernel.',
    );
}
function strictReplayParts(
  initial: unknown,
  records: unknown,
  decisionInput: unknown,
): StrictChessState {
  if (
    !Array.isArray(records) ||
    records.length > MAX_RECORDS ||
    !Array.isArray(decisionInput) ||
    decisionInput.length > MAX_RECORDS + 1
  )
    fail(
      'INVALID_STATE',
      'Strict history and decisions must be bounded arrays.',
    );
  const decisions: StrictDecisionReceipt[] = [];
  let cursor = 0;
  const resolver: PositionDecisionResolver = (position, revision) => {
    if (cursor >= decisionInput.length)
      fail('PROOF_REQUIRED', 'A board position has no decision evidence.');
    const receipt = object(decisionInput[cursor], 'INVALID_PROOF');
    keys(receipt, ['revision', 'evidence'], 'INVALID_PROOF');
    if (
      uint(
        receipt.revision,
        'decision revision',
        MAX_RECORDS,
        'INVALID_PROOF',
      ) !== revision
    )
      fail('INVALID_PROOF', 'Decision receipt is bound to another revision.');
    const verdict = checkedStrictDecision(position, receipt.evidence);
    decisions.push({
      revision,
      evidence: receipt.evidence as ReachabilityEvidence,
    });
    cursor++;
    return verdict;
  };
  const core = replayProofCore(initial, records, resolver);
  if (cursor !== decisionInput.length)
    fail('INVALID_PROOF', 'Unused or duplicate decision evidence.');
  return strictSeal(core, decisions);
}
function replayProofCore(
  initial: unknown,
  records: unknown,
  resolver: PositionDecisionResolver,
): ChessState {
  const parsedInitial = parseInitial(initial);
  if (parsedInitial.mode !== 'standard')
    fail(
      'INVALID_STATE',
      'Strict play requires the standard initial position.',
    );
  if (!Array.isArray(records) || records.length > MAX_RECORDS)
    fail('INVALID_STATE', 'Strict history must be a bounded array.');
  let core = root(parsedInitial, resolver).state;
  for (const input of records) {
    const record = parseRecord(input);
    if (record.kind !== 'player' || record.action.type === 'resign')
      fail(
        'INVALID_ACTION',
        'Strict play does not accept resignation, adjudication or proof commands.',
      );
    core = reduce(core, record, resolver).state;
  }
  return core;
}
function restoreStrict(value: unknown): StrictChessState {
  if (value && typeof value === 'object' && strictTrusted.has(value))
    return value as StrictChessState;
  const o = readProofSnapshot(value, {
    schemaVersion: STRICT_SCHEMA_VERSION,
    engineVersion: STRICT_ENGINE_VERSION,
    rulesVersion: STRICT_RULES_VERSION,
  });
  const replayed = strictReplayParts(o.initial, o.history, o.decisions);
  if (canonical(replayed) !== canonical(o))
    fail(
      'INVALID_STATE',
      'Strict snapshot does not match its evidence-verified replay.',
    );
  return replayed;
}
function readProofSnapshot(
  value: unknown,
  pins: {
    schemaVersion: number;
    engineVersion: string;
    rulesVersion: string;
  },
): Record<string, unknown> {
  let decoded: unknown = value;
  if (typeof value === 'string') {
    if (value.length > MAX_SNAPSHOT_CHARS)
      fail('RESOURCE_LIMIT', 'Strict snapshot exceeds the JSON limit.');
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      fail('INVALID_STATE', 'Malformed strict snapshot JSON.');
    }
  }
  const stable = detachedStrictJSON(decoded),
    o = object(stable, 'INVALID_STATE');
  if (
    o.schemaVersion !== pins.schemaVersion ||
    o.engineVersion !== pins.engineVersion ||
    o.rulesVersion !== pins.rulesVersion
  )
    fail(
      'UNSUPPORTED_VERSION',
      'Expected an original strict-profile snapshot; legacy histories cannot be relabelled.',
    );
  keys(
    o,
    [
      'schemaVersion',
      'engineVersion',
      'rulesVersion',
      'game',
      'initial',
      'revision',
      'fen',
      'turn',
      'ply',
      'movesByColor',
      'positionHistory',
      'history',
      'phase',
      'drawOffer',
      'forcedMove',
      'pendingResignation',
      'roundOutcome',
      'matchOutcome',
      'decisions',
    ],
    'INVALID_STATE',
  );
  return o;
}
function prepareProofTransition(
  kind: StrictChessCandidate['kind'],
  baseRevision: number | null,
  build: (resolver: PositionDecisionResolver) => Transition,
): {
  readonly summary: StrictChessCandidate;
  readonly completed: Transition | null;
} {
  let completed: Transition | null = null,
    request: StrictDecisionRequest | null = null;
  try {
    completed = build((position, revision) => {
      throw new StrictDecisionRequest(toFen(position), revision);
    });
  } catch (error) {
    if (!(error instanceof StrictDecisionRequest)) throw error;
    request = error;
  }
  const fen = request ? request.fen : completed!.state.fen;
  const candidate: StrictChessCandidate = Object.freeze({
    kind,
    baseRevision,
    revision: request ? request.revision : completed!.state.revision,
    fen,
    root: positionKey(parseFen(fen)),
    needsEvidence: request !== null,
    proofEngineVersion: STRICT_PROOF_ENGINE_VERSION,
    proofRulesVersion: STRICT_PROOF_RULES_VERSION,
  });
  return { summary: candidate, completed };
}
function prepareStrict(
  kind: StrictChessCandidate['kind'],
  base: StrictChessState | null,
  build: (resolver: PositionDecisionResolver) => Transition,
): StrictChessCandidate {
  const prepared = prepareProofTransition(kind, base?.revision ?? null, build);
  strictCandidates.set(prepared.summary, {
    build,
    decisions: base?.decisions ?? [],
    completed: prepared.completed,
  });
  return prepared.summary;
}
/** Preparation exposes a position needing proof, never an accepted initial state. */
export function prepareStrictGame(
  options: CreateGameOptions,
): Result<StrictChessCandidate> {
  try {
    const input = object(detachedStrictJSON(options), 'INVALID_CONFIG');
    keys(input, ['players'], 'INVALID_CONFIG');
    const initial: InitialState = freeze({
      mode: 'standard',
      players: parsePlayers(input.players),
      fen: START_FEN,
      movesBeforeStart: { white: 0, black: 0 },
    });
    return {
      ok: true,
      value: prepareStrict('initial', null, (resolver) =>
        root(initial, resolver),
      ),
    };
  } catch (error) {
    return reject(error);
  }
}
/** Authentication/revalidation belong to the backend. This validates actor, revision and rules only. */
export function prepareStrictAction(
  value: unknown,
  actingPlayer: string,
  action: unknown,
  expectedRevision: number,
): Result<StrictChessCandidate> {
  try {
    const state = restoreStrict(value),
      core = strictCore(state);
    uint(expectedRevision, 'expectedRevision', MAX_RECORDS, 'STALE_REVISION');
    checkRevision(core, expectedRevision);
    playerColor(core, actingPlayer);
    const record = parseRecord({
      kind: 'player',
      playerId: actingPlayer,
      action: detachedStrictJSON(action),
    });
    if (record.kind !== 'player' || record.action.type === 'resign')
      fail(
        'INVALID_ACTION',
        'Strict play does not accept resignation or administrative commands.',
      );
    freeze(record);
    return {
      ok: true,
      value: prepareStrict('action', state, (resolver) =>
        reduce(core, record, resolver),
      ),
    };
  } catch (error) {
    return reject(error);
  }
}
/** Finish only the exact locally prepared transition. Evidence is never a player action. */
export function finishStrictCandidate(
  candidate: StrictChessCandidate,
  evidence?: unknown,
): StrictTransitionResult {
  try {
    const context = strictCandidates.get(candidate);
    if (!context) fail('INVALID_ACTION', 'Unknown or copied strict candidate.');
    let transition: Transition,
      decisions = context.decisions;
    if (candidate.needsEvidence) {
      if (evidence === undefined || evidence === null)
        fail(
          'PROOF_REQUIRED',
          'The candidate position requires checked evidence.',
        );
      const stable = detachedStrictJSON(evidence),
        verdict = checkedStrictDecision(parseFen(candidate.fen), stable);
      let consumed = false;
      transition = context.build((position, revision) => {
        if (
          consumed ||
          revision !== candidate.revision ||
          positionKey(position) !== candidate.root
        )
          fail(
            'INVALID_PROOF',
            'Prepared transition and checked decision disagree.',
          );
        consumed = true;
        return verdict;
      });
      if (!consumed)
        fail(
          'INVALID_PROOF',
          'Prepared transition did not consume its evidence.',
        );
      decisions = [
        ...decisions,
        {
          revision: candidate.revision,
          evidence: stable as ReachabilityEvidence,
        },
      ];
    } else {
      if (evidence !== undefined && evidence !== null)
        fail(
          'INVALID_PROOF',
          'An unchanged-position command takes no new evidence.',
        );
      transition = context.completed!;
    }
    return {
      ok: true,
      state: strictSeal(transition.state, decisions),
      events: freeze(transition.events),
    };
  } catch (error) {
    return reject(error);
  }
}
export function restoreStrictState(value: unknown): Result<StrictChessState> {
  try {
    return { ok: true, value: restoreStrict(value) };
  } catch (error) {
    return reject(error);
  }
}
export function replayStrict(
  initial: unknown,
  records: unknown,
  decisions: unknown,
): Result<StrictChessState> {
  try {
    const input = object(
      detachedStrictJSON({ initial, records, decisions }),
      'INVALID_STATE',
    );
    return {
      ok: true,
      value: strictReplayParts(input.initial, input.records, input.decisions),
    };
  } catch (error) {
    return reject(error);
  }
}
export function getStrictObservation(
  value: unknown,
  viewer: string | null,
): Result<StrictChessObservation> {
  try {
    const state = restoreStrict(value),
      view = observation(strictCore(state), viewer);
    return {
      ok: true,
      value: freeze({
        ...view,
        rulesVersion: STRICT_RULES_VERSION,
        phase: state.phase,
        legalActions: view.legalActions.filter(
          (action) => action.type !== 'resign',
        ),
        analysisRoot: false,
        awaitingResignationDecision: false,
        conformance: {
          clocks: false,
          automaticDeadPositionDetection: 'required-verified-evidence',
          unprovedContinuation: false,
          exhaustiveDeadPositionOracle: false,
        },
      }),
    };
  } catch (error) {
    return reject(error);
  }
}

// Artifact identities are transport references. Only checked in-worker handles
// carry a mathematical verdict; no JSON flag is an accepted proof capability.
const artifactBindings = new WeakMap<object, 'dead' | 'not-dead'>();
const artifactCandidates = new WeakMap<
  ArtifactChessCandidate,
  {
    build: (resolver: PositionDecisionResolver) => Transition;
    decisions: readonly ArtifactDecisionRef[];
    bindings: readonly CheckedArtifactBinding[];
    completed: Transition | null;
  }
>();
const ARTIFACT_PINS = {
  schemaVersion: ARTIFACT_SCHEMA_VERSION,
  engineVersion: ARTIFACT_ENGINE_VERSION,
  rulesVersion: ARTIFACT_RULES_VERSION,
} as const;
function artifactDescriptor(
  value: unknown,
  withRevision = false,
): ArtifactDescriptor {
  const input = object(value, 'INVALID_PROOF');
  keys(
    input,
    [
      'artifactId',
      'root',
      'kernelEngineVersion',
      'kernelRulesVersion',
      'format',
      ...(withRevision ? ['revision'] : []),
    ],
    'INVALID_PROOF',
  );
  if (
    typeof input.artifactId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.artifactId) ||
    typeof input.root !== 'string' ||
    input.root.length > 120 ||
    input.kernelEngineVersion !== STRICT_PROOF_ENGINE_VERSION ||
    input.kernelRulesVersion !== STRICT_PROOF_RULES_VERSION ||
    input.format !== REACHABILITY_STREAM_FORMAT
  )
    fail(
      'INVALID_PROOF',
      'Artifact descriptor identity/kernel/format is invalid.',
    );
  return {
    artifactId: input.artifactId,
    root: input.root,
    kernelEngineVersion: STRICT_PROOF_ENGINE_VERSION,
    kernelRulesVersion: STRICT_PROOF_RULES_VERSION,
    format: REACHABILITY_STREAM_FORMAT,
  };
}
/**
 * Repository-only bridge: the repository must privately associate this exact
 * token with its sealed bytes/manifest before supplying the descriptor. Matching
 * hashes/JSON are not mathematical authority. The resulting handle is local to
 * this engine module/worker and must not be reconstructed from transport data.
 */
export function bindVerifiedArtifact(
  token: unknown,
  descriptor: ArtifactDescriptor,
): Result<CheckedArtifactBinding> {
  try {
    requirePinnedProofKernel();
    if (!isVerifiedStreamingReachabilityDecision(token))
      fail('INVALID_PROOF', 'A genuine streaming decision is required.');
    const stable = artifactDescriptor(detachedStrictJSON(descriptor));
    if (
      stable.root !== token.root ||
      stable.kernelEngineVersion !== token.engineVersion ||
      stable.kernelRulesVersion !== token.rulesVersion ||
      stable.format !== token.format
    )
      fail(
        'INVALID_PROOF',
        'Artifact descriptor does not match its checked stream.',
      );
    const binding = freeze(stable) as CheckedArtifactBinding;
    artifactBindings.set(binding, token.verdict);
    return { ok: true, value: binding };
  } catch (error) {
    return reject(error);
  }
}
function artifactIndex(
  bindings: readonly CheckedArtifactBinding[],
): Map<string, CheckedArtifactBinding> {
  const supplied = bindings;
  if (!Array.isArray(bindings))
    fail('PROOF_REQUIRED', 'Checked artifact bindings are required.');
  const index = new Map<string, CheckedArtifactBinding>();
  for (const binding of supplied) {
    if (
      !binding ||
      typeof binding !== 'object' ||
      !artifactBindings.has(binding)
    )
      fail('INVALID_PROOF', 'Copied or unverified artifact binding.');
    const previous = index.get(binding.artifactId);
    if (
      previous &&
      (canonical(previous) !== canonical(binding) ||
        artifactBindings.get(previous) !== artifactBindings.get(binding))
    )
      fail('INVALID_PROOF', 'Conflicting artifact identities.');
    index.set(binding.artifactId, binding);
  }
  return index;
}
function artifactSeal(
  core: ChessState,
  decisions: readonly ArtifactDecisionRef[],
): ArtifactChessState {
  validateProofProfileCore(core);
  const state = { ...core, ...ARTIFACT_PINS, decisions } as ArtifactChessState;
  if (JSON.stringify(state).length > MAX_SNAPSHOT_CHARS)
    fail('RESOURCE_LIMIT', 'Artifact snapshot exceeds the JSON limit.');
  return freeze(state);
}
function artifactReplayParts(
  initial: unknown,
  records: unknown,
  decisionInput: unknown,
  bindings: readonly CheckedArtifactBinding[],
): ArtifactChessState {
  const index = artifactIndex(bindings);
  if (!Array.isArray(decisionInput) || decisionInput.length > MAX_RECORDS + 1)
    fail('INVALID_STATE', 'Artifact decisions must be a bounded array.');
  const decisions: ArtifactDecisionRef[] = [];
  let cursor = 0;
  const resolver: PositionDecisionResolver = (position, revision) => {
    if (cursor >= decisionInput.length)
      fail('PROOF_REQUIRED', 'A board position has no artifact reference.');
    const raw = object(decisionInput[cursor], 'INVALID_PROOF'),
      descriptor = artifactDescriptor(raw, true);
    if (
      uint(
        raw.revision,
        'artifact decision revision',
        MAX_RECORDS,
        'INVALID_PROOF',
      ) !== revision ||
      descriptor.root !== positionKey(position)
    )
      fail(
        'INVALID_PROOF',
        'Artifact reference is bound to another position or revision.',
      );
    const checked = index.get(descriptor.artifactId);
    if (!checked)
      fail(
        'PROOF_REQUIRED',
        'A referenced artifact has no checked in-worker binding.',
      );
    if (canonical(artifactDescriptor(checked)) !== canonical(descriptor))
      fail(
        'INVALID_PROOF',
        'Artifact reference and checked descriptor disagree.',
      );
    decisions.push({ revision, ...descriptor });
    cursor++;
    return artifactBindings.get(checked)!;
  };
  const core = replayProofCore(initial, records, resolver);
  if (cursor !== decisionInput.length)
    fail('INVALID_PROOF', 'Unused or duplicate artifact references.');
  return artifactSeal(core, decisions);
}
function restoreArtifact(
  value: unknown,
  bindings: readonly CheckedArtifactBinding[],
): ArtifactChessState {
  const input = readProofSnapshot(value, ARTIFACT_PINS);
  const replayed = artifactReplayParts(
    input.initial,
    input.history,
    input.decisions,
    bindings,
  );
  if (canonical(replayed) !== canonical(input))
    fail(
      'INVALID_STATE',
      'Artifact snapshot does not match its checked-reference replay.',
    );
  return replayed;
}
function prepareArtifact(
  kind: StrictChessCandidate['kind'],
  base: ArtifactChessState | null,
  bindings: readonly CheckedArtifactBinding[],
  build: (resolver: PositionDecisionResolver) => Transition,
): ArtifactChessCandidate {
  const prepared = prepareProofTransition(kind, base?.revision ?? null, build);
  const candidate: ArtifactChessCandidate = freeze({
    ...prepared.summary,
    ...ARTIFACT_PINS,
  });
  artifactCandidates.set(candidate, {
    build,
    decisions: base?.decisions ?? [],
    bindings: [...bindings],
    completed: prepared.completed,
  });
  return candidate;
}
export function prepareArtifactGame(
  options: CreateGameOptions,
): Result<ArtifactChessCandidate> {
  try {
    const input = object(detachedStrictJSON(options), 'INVALID_CONFIG');
    keys(input, ['players'], 'INVALID_CONFIG');
    const initial: InitialState = freeze({
      mode: 'standard',
      players: parsePlayers(input.players),
      fen: START_FEN,
      movesBeforeStart: { white: 0, black: 0 },
    });
    return {
      ok: true,
      value: prepareArtifact('initial', null, [], (resolver) =>
        root(initial, resolver),
      ),
    };
  } catch (error) {
    return reject(error);
  }
}
export function prepareArtifactAction(
  value: unknown,
  actingPlayer: string,
  action: unknown,
  expectedRevision: number,
  bindings: readonly CheckedArtifactBinding[],
): Result<ArtifactChessCandidate> {
  try {
    const supplied = bindings;
    if (!Array.isArray(bindings))
      fail('PROOF_REQUIRED', 'Checked artifact bindings are required.');
    const stableBindings = [...supplied],
      state = restoreArtifact(value, stableBindings),
      core = strictCore(state);
    uint(expectedRevision, 'expectedRevision', MAX_RECORDS, 'STALE_REVISION');
    checkRevision(core, expectedRevision);
    playerColor(core, actingPlayer);
    const record = parseRecord({
      kind: 'player',
      playerId: actingPlayer,
      action: detachedStrictJSON(action),
    });
    if (record.kind !== 'player' || record.action.type === 'resign')
      fail(
        'INVALID_ACTION',
        'Artifact play does not accept resignation or administrative commands.',
      );
    freeze(record);
    return {
      ok: true,
      value: prepareArtifact('action', state, stableBindings, (resolver) =>
        reduce(core, record, resolver),
      ),
    };
  } catch (error) {
    return reject(error);
  }
}
export function finishArtifactCandidate(
  candidate: ArtifactChessCandidate,
  binding?: CheckedArtifactBinding,
): ArtifactTransitionResult {
  try {
    const context = artifactCandidates.get(candidate);
    if (!context)
      fail(
        'INVALID_ACTION',
        'Unknown, copied or differently profiled artifact candidate.',
      );
    artifactIndex(context.bindings);
    let transition: Transition,
      decisions = context.decisions;
    if (candidate.needsEvidence) {
      if (!binding)
        fail(
          'PROOF_REQUIRED',
          'The candidate position requires a checked artifact.',
        );
      artifactIndex([...context.bindings, binding]);
      if (binding.root !== candidate.root)
        fail(
          'INVALID_PROOF',
          'Checked artifact belongs to another candidate position.',
        );
      let consumed = false;
      transition = context.build((position, revision) => {
        if (
          consumed ||
          revision !== candidate.revision ||
          positionKey(position) !== binding.root
        )
          fail(
            'INVALID_PROOF',
            'Prepared artifact transition and decision disagree.',
          );
        consumed = true;
        return artifactBindings.get(binding)!;
      });
      if (!consumed)
        fail(
          'INVALID_PROOF',
          'Prepared transition did not consume its artifact.',
        );
      decisions = [
        ...decisions,
        { revision: candidate.revision, ...artifactDescriptor(binding) },
      ];
    } else {
      if (binding !== undefined)
        fail(
          'INVALID_PROOF',
          'An unchanged-position command takes no new artifact.',
        );
      transition = context.completed!;
    }
    return {
      ok: true,
      state: artifactSeal(transition.state, decisions),
      events: freeze(transition.events),
    };
  } catch (error) {
    return reject(error);
  }
}
export function restoreArtifactState(
  value: unknown,
  bindings: readonly CheckedArtifactBinding[],
): Result<ArtifactChessState> {
  try {
    return { ok: true, value: restoreArtifact(value, bindings) };
  } catch (error) {
    return reject(error);
  }
}
export function replayArtifact(
  initial: unknown,
  records: unknown,
  refs: unknown,
  bindings: readonly CheckedArtifactBinding[],
): Result<ArtifactChessState> {
  try {
    const input = object(
      detachedStrictJSON({ initial, records, refs }),
      'INVALID_STATE',
    );
    return {
      ok: true,
      value: artifactReplayParts(
        input.initial,
        input.records,
        input.refs,
        bindings,
      ),
    };
  } catch (error) {
    return reject(error);
  }
}
export function getArtifactObservation(
  value: unknown,
  viewer: string | null,
  bindings: readonly CheckedArtifactBinding[],
): Result<ArtifactChessObservation> {
  try {
    const state = restoreArtifact(value, bindings),
      view = observation(strictCore(state), viewer);
    return {
      ok: true,
      value: freeze({
        ...view,
        rulesVersion: ARTIFACT_RULES_VERSION,
        phase: state.phase,
        legalActions: view.legalActions.filter(
          (action) => action.type !== 'resign',
        ),
        analysisRoot: false,
        awaitingResignationDecision: false,
        conformance: {
          clocks: false,
          automaticDeadPositionDetection: 'required-verified-evidence',
          unprovedContinuation: false,
          exhaustiveDeadPositionOracle: false,
        },
      }),
    };
  } catch (error) {
    return reject(error);
  }
}
/** True only after a final result exists. A pending resignation is not a settled result. */
export function isGameOver(value: ChessState): Result<boolean> {
  try {
    return { ok: true, value: restore(value).phase === 'ended' };
  } catch (error) {
    return reject(error);
  }
}
/** Includes stopped play whose result is awaiting a mating-possibility decision. */
export function isPlayStopped(value: ChessState): Result<boolean> {
  try {
    return { ok: true, value: restore(value).phase !== 'playing' };
  } catch (error) {
    return reject(error);
  }
}
