/** Versioned, JSON-only contracts. No UI, transport, database, clocks or accounting. */
import type { ReachabilityEvidence } from './reachability.js';
import type { REACHABILITY_STREAM_FORMAT } from './streaming-reachability.js';
export const SCHEMA_VERSION = 1 as const;
export const ENGINE_VERSION = '0.3.0' as const;
export const RULES_VERSION = 'skillbetting.chess.fide-2023.v2' as const;
/** Experimental proof-required execution profile; never relabel a legacy snapshot. */
export const STRICT_SCHEMA_VERSION = 2 as const;
export const STRICT_ENGINE_VERSION = '0.4.0-strict.1' as const;
export const STRICT_RULES_VERSION =
  'skillbetting.chess.fide-2023.strict-proof.v1' as const;
export const STRICT_PROOF_ENGINE_VERSION = '0.3.0' as const;
export const STRICT_PROOF_RULES_VERSION =
  'skillbetting.chess.fide-2023.v2' as const;
export const ARTIFACT_SCHEMA_VERSION = 3 as const;
export const ARTIFACT_ENGINE_VERSION = '0.4.0-strict.2' as const;
export const ARTIFACT_RULES_VERSION =
  'skillbetting.chess.fide-2023.strict-proof-artifacts.v1' as const;
export const START_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export type Color = 'white' | 'black';
export type File = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h';
export type Rank = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';
export type Square = `${File}${Rank}`;
export type Promotion = 'q' | 'r' | 'b' | 'n';
export type PieceSymbol =
  'P' | 'N' | 'B' | 'R' | 'Q' | 'K' | 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export interface Players {
  readonly white: string;
  readonly black: string;
}
export interface MoveSpec {
  readonly from: Square;
  readonly to: Square;
  readonly promotion?: Promotion;
}
export interface MoveAction extends MoveSpec {
  readonly type: 'move';
  readonly offerDraw?: boolean;
}
export type DrawClaimReason = 'threefold-repetition' | 'fifty-move';
export type PlayerAction =
  | MoveAction
  | { readonly type: 'offer-draw' }
  | { readonly type: 'accept-draw' }
  | { readonly type: 'decline-draw' }
  | {
      readonly type: 'claim-draw';
      readonly reason: DrawClaimReason;
      readonly intendedMove?: MoveSpec;
    }
  | { readonly type: 'resign'; readonly mateWitness?: readonly MoveSpec[] };
export interface CreateGameOptions {
  readonly players: Players;
}
/** Analysis roots are explicitly NOT complete histories or proof of reachability. */
export interface CreateAnalysisOptions extends CreateGameOptions {
  readonly fen: string;
  readonly movesBeforeStart?: {
    readonly white: number;
    readonly black: number;
  };
}
export interface InitialState {
  readonly mode: 'standard' | 'analysis';
  readonly players: Players;
  readonly fen: string;
  readonly movesBeforeStart: { readonly white: number; readonly black: number };
}
export type OutcomeReason =
  | 'checkmate'
  | 'stalemate'
  | 'dead-position-material'
  | 'dead-position-proven'
  | 'dead-position-adjudicated'
  | 'threefold-repetition'
  | 'fifty-move'
  | 'fivefold-repetition'
  | 'seventy-five-move'
  | 'draw-agreement'
  | 'resignation'
  | 'resignation-no-possible-mate';
export interface Score {
  readonly playerId: string;
  readonly color: Color;
  readonly points: 0 | 0.5 | 1;
}
export interface RoundOutcome {
  readonly roundNumber: 1;
  readonly kind: 'win' | 'draw';
  readonly winner: Color | null;
  readonly winnerId: string | null;
  readonly reason: OutcomeReason;
  readonly ply: number;
  readonly scores: readonly [Score, Score];
}
export interface MatchOutcome {
  readonly kind: 'win' | 'draw';
  readonly winner: Color | null;
  readonly winnerId: string | null;
  readonly reason: 'single-game-complete';
  readonly gameReason: OutcomeReason;
  readonly scores: readonly [Score, Score];
}
export interface DrawOffer {
  readonly by: Color;
  readonly atRevision: number;
}
export interface PendingResignation {
  readonly resigned: Color;
  readonly prospectiveWinner: Color;
  readonly reason: 'mate-possibility-unresolved';
}
/** Trusted backend/arbiter operation, NEVER a human or bot action. */
export type Adjudication =
  | {
      readonly type: 'dead-position';
      readonly authority: string;
      readonly evidence: string;
    }
  | {
      readonly type: 'resignation';
      readonly opponentCanMate: boolean;
      readonly authority: string;
      readonly evidence: string;
    };
export type HistoryRecord =
  | {
      readonly kind: 'player';
      readonly playerId: string;
      readonly action: PlayerAction;
    }
  | { readonly kind: 'adjudication'; readonly decision: Adjudication }
  | { readonly kind: 'dead-position-proof'; readonly maxNodes: number }
  | { readonly kind: 'resignation-proof'; readonly moves: readonly MoveSpec[] };
export interface ChessState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly engineVersion: typeof ENGINE_VERSION;
  readonly rulesVersion: typeof RULES_VERSION;
  readonly game: 'chess';
  readonly initial: InitialState;
  readonly revision: number;
  readonly fen: string;
  readonly turn: Color;
  /** Plies played since this root; differs from FEN fullmove number in analysis games. */
  readonly ply: number;
  readonly movesByColor: { readonly white: number; readonly black: number };
  /** Includes the root; canonical keys include only legally usable en-passant rights. */
  readonly positionHistory: readonly string[];
  readonly history: readonly HistoryRecord[];
  readonly phase: 'playing' | 'awaiting-adjudication' | 'ended';
  readonly drawOffer: DrawOffer | null;
  /** A rejected, otherwise well-formed intended-move draw claim binds this move. */
  readonly forcedMove: MoveSpec | null;
  readonly pendingResignation: PendingResignation | null;
  readonly roundOutcome: RoundOutcome | null;
  readonly matchOutcome: MatchOutcome | null;
}
export type GameEvent =
  | { readonly type: 'game-created'; readonly mode: 'standard' | 'analysis' }
  | {
      readonly type: 'move-played';
      readonly playerId: string;
      readonly color: Color;
      readonly move: MoveSpec;
      readonly uci: string;
      readonly san: string;
      readonly fen: string;
      readonly ply: number;
    }
  | { readonly type: 'draw-offered'; readonly by: Color }
  | { readonly type: 'draw-declined'; readonly by: Color }
  | {
      readonly type: 'draw-claim-rejected';
      readonly by: Color;
      readonly reason: DrawClaimReason;
      readonly forcedMove: MoveSpec | null;
      readonly clockPenaltyApplied: false;
    }
  | {
      readonly type: 'draw-claim-accepted';
      readonly by: Color;
      readonly reason: DrawClaimReason;
      readonly intendedMove: MoveSpec | null;
    }
  | { readonly type: 'resignation-received'; readonly by: Color }
  | {
      readonly type: 'adjudication-required';
      readonly reason: 'mate-possibility-unresolved';
    }
  | {
      readonly type: 'adjudication-recorded';
      readonly decision: 'dead-position' | 'resignation';
    }
  | { readonly type: 'round-ended'; readonly outcome: RoundOutcome }
  | { readonly type: 'match-ended'; readonly outcome: MatchOutcome };
export type ErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_FEN'
  | 'INVALID_STATE'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_ACTION'
  | 'UNKNOWN_PLAYER'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_MOVE'
  | 'PROMOTION_REQUIRED'
  | 'STALE_REVISION'
  | 'GAME_ENDED'
  | 'ADJUDICATION_PENDING'
  | 'NO_DRAW_OFFER'
  | 'OWN_DRAW_OFFER'
  | 'DRAW_OFFER_PENDING'
  | 'DRAW_TOO_EARLY'
  | 'FORCED_MOVE'
  | 'INVALID_ADJUDICATION'
  | 'PROOF_INCONCLUSIVE'
  | 'PROOF_REQUIRED'
  | 'INVALID_PROOF'
  | 'RESOURCE_LIMIT';
export interface EngineError {
  readonly code: ErrorCode;
  readonly message: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: EngineError };
export type TransitionResult =
  | {
      readonly ok: true;
      readonly state: ChessState;
      readonly events: readonly GameEvent[];
    }
  | { readonly ok: false; readonly error: EngineError };
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}
export type ValidationResult =
  | { readonly valid: true; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] };
export interface ClaimOptions {
  readonly current: readonly DrawClaimReason[];
  readonly byIntendedMove: readonly {
    readonly reason: DrawClaimReason;
    readonly move: MoveSpec;
  }[];
}
/** Public, whitelisted view. No adjudicator evidence, private RNG, or backend metadata. */
export interface ChessObservation {
  readonly game: 'chess';
  readonly rulesVersion: typeof RULES_VERSION;
  readonly revision: number;
  readonly viewer: string | null;
  readonly viewerColor: Color | null;
  readonly players: Players;
  readonly fen: string;
  readonly turn: Color;
  readonly ply: number;
  readonly phase: ChessState['phase'];
  readonly inCheck: boolean;
  readonly drawOffer: DrawOffer | null;
  readonly forcedMove: MoveSpec | null;
  readonly awaitingResignationDecision: boolean;
  readonly moves: readonly {
    readonly by: Color;
    readonly move: MoveSpec;
    /** Standard algebraic notation reconstructed from the accepted board history. */
    readonly san: string;
  }[];
  readonly legalActions: readonly PlayerAction[];
  readonly roundOutcome: RoundOutcome | null;
  readonly matchOutcome: MatchOutcome | null;
  readonly analysisRoot: boolean;
  readonly conformance: {
    readonly clocks: false;
    readonly automaticDeadPositionDetection: 'material-and-bounded-proof';
    readonly exhaustiveDeadPositionOracle: false;
  };
}
export type StrictPlayerAction = Exclude<
  PlayerAction,
  { readonly type: 'resign' }
>;
export interface StrictDecisionReceipt {
  /** Revision 0 for the initial position, otherwise the accepted board-move revision. */
  readonly revision: number;
  /** Evidence keeps its original 0.3.0/FIDE-v2 verification-kernel binding. */
  readonly evidence: ReachabilityEvidence;
}
export interface StrictChessState extends Omit<
  ChessState,
  | 'schemaVersion'
  | 'engineVersion'
  | 'rulesVersion'
  | 'initial'
  | 'history'
  | 'phase'
  | 'pendingResignation'
> {
  readonly schemaVersion: typeof STRICT_SCHEMA_VERSION;
  readonly engineVersion: typeof STRICT_ENGINE_VERSION;
  readonly rulesVersion: typeof STRICT_RULES_VERSION;
  readonly initial: InitialState & { readonly mode: 'standard' };
  readonly history: readonly {
    readonly kind: 'player';
    readonly playerId: string;
    readonly action: StrictPlayerAction;
  }[];
  readonly phase: 'playing' | 'ended';
  readonly pendingResignation: null;
  readonly decisions: readonly StrictDecisionReceipt[];
}
/** A frozen summary backed by private, immutable preparation context in this process. */
export interface StrictChessCandidate {
  readonly kind: 'initial' | 'action';
  readonly baseRevision: number | null;
  readonly revision: number;
  readonly fen: string;
  readonly root: string;
  readonly needsEvidence: boolean;
  readonly proofEngineVersion: typeof STRICT_PROOF_ENGINE_VERSION;
  readonly proofRulesVersion: typeof STRICT_PROOF_RULES_VERSION;
}
export type StrictTransitionResult =
  | {
      readonly ok: true;
      readonly state: StrictChessState;
      readonly events: readonly GameEvent[];
    }
  | { readonly ok: false; readonly error: EngineError };
export interface StrictChessObservation extends Omit<
  ChessObservation,
  | 'rulesVersion'
  | 'phase'
  | 'legalActions'
  | 'analysisRoot'
  | 'awaitingResignationDecision'
  | 'conformance'
> {
  readonly rulesVersion: typeof STRICT_RULES_VERSION;
  readonly phase: StrictChessState['phase'];
  readonly legalActions: readonly StrictPlayerAction[];
  readonly analysisRoot: false;
  readonly awaitingResignationDecision: false;
  readonly conformance: {
    readonly clocks: false;
    readonly automaticDeadPositionDetection: 'required-verified-evidence';
    readonly unprovedContinuation: false;
    readonly exhaustiveDeadPositionOracle: false;
  };
}
/** Content identity only. Repository publication must bind it to exact verified bytes. */
export interface ArtifactDescriptor {
  readonly artifactId: string;
  readonly root: string;
  readonly kernelEngineVersion: typeof STRICT_PROOF_ENGINE_VERSION;
  readonly kernelRulesVersion: typeof STRICT_PROOF_RULES_VERSION;
  readonly format: typeof REACHABILITY_STREAM_FORMAT;
}
/** Runtime identity is checked in a private engine WeakMap; copied JSON is not a binding. */
declare const checkedArtifactBindingType: unique symbol;
export interface CheckedArtifactBinding extends ArtifactDescriptor {
  readonly [checkedArtifactBindingType]: true;
}
export interface ArtifactDecisionRef extends ArtifactDescriptor {
  readonly revision: number;
}
export interface ArtifactChessState extends Omit<
  StrictChessState,
  'schemaVersion' | 'engineVersion' | 'rulesVersion' | 'decisions'
> {
  readonly schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  readonly engineVersion: typeof ARTIFACT_ENGINE_VERSION;
  readonly rulesVersion: typeof ARTIFACT_RULES_VERSION;
  readonly decisions: readonly ArtifactDecisionRef[];
}
export interface ArtifactChessCandidate extends StrictChessCandidate {
  readonly schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  readonly engineVersion: typeof ARTIFACT_ENGINE_VERSION;
  readonly rulesVersion: typeof ARTIFACT_RULES_VERSION;
}
export type ArtifactTransitionResult =
  | {
      readonly ok: true;
      readonly state: ArtifactChessState;
      readonly events: readonly GameEvent[];
    }
  | { readonly ok: false; readonly error: EngineError };
export interface ArtifactChessObservation extends Omit<
  StrictChessObservation,
  'rulesVersion'
> {
  readonly rulesVersion: typeof ARTIFACT_RULES_VERSION;
}
export interface BotOptions {
  readonly strategy?: 'first-legal' | 'random' | 'capture';
  readonly randomState?: number;
}
export interface BotDecision {
  readonly action: PlayerAction;
  readonly nextRandomState: number | null;
}
export interface SearchResult {
  readonly status: 'possible' | 'impossible' | 'unknown';
  readonly nodes: number;
  readonly witness: readonly MoveSpec[] | null;
}
export interface DeadPositionResult {
  readonly status: 'dead' | 'not-dead' | 'unknown';
  readonly nodes: number;
  readonly witness: readonly MoveSpec[] | null;
}
