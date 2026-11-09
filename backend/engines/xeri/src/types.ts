/** Versioned, JSON-only contracts. No UI, transport, database, clocks or accounting. */
export const SCHEMA_VERSION = 2 as const;
export const ENGINE_VERSION = '0.2.0' as const;
export const RULES_VERSION = 'skillbetting.xeri.two-player-151.v2' as const;
export const TARGET_SCORE = 151 as const;
export const HAND_SIZE = 6 as const;
export const LAYOUT_SIZE = 4 as const;
export type Seat = 0 | 1;
export type Suit = 'C' | 'D' | 'H' | 'S';
export type Rank =
  'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';
export type Card = `${Rank}${Suit}`;
/** Indexed by table seat. */
export type Players = readonly [string, string];
export type SeatPair<T> = readonly [T, T];
export interface PlayCardAction {
  readonly type: 'play-card';
  readonly card: Card;
}
export interface NextRoundAction {
  readonly type: 'next';
}
export type PlayerAction = PlayCardAction | NextRoundAction;
/** `seed` is 64 lowercase hex characters from a CSPRNG; it decides every hidden card. */
export interface CreateGameOptions {
  readonly players: Players;
  readonly seed: string;
}
/** Testing/import scenarios only. Scripted decks and opening scores are not fair play. */
export interface CreateAnalysisOptions extends CreateGameOptions {
  readonly firstDealer: Seat;
  readonly decks: readonly (readonly Card[])[];
  readonly scores?: SeatPair<number>;
}
export interface InitialState {
  readonly mode: 'standard' | 'analysis';
  readonly players: Players;
  readonly seed: string;
  readonly firstDealer: Seat;
  /** One complete deck per scripted round. Empty in standard games. */
  readonly decks: readonly (readonly Card[])[];
  readonly scores: SeatPair<number>;
}
export type XeriKind = 'ordinary' | 'jack';
export interface XeriMark {
  readonly seat: Seat;
  readonly card: Card;
  readonly kind: XeriKind;
  readonly points: 10 | 20;
}
export interface LastPlay {
  readonly seat: Seat;
  readonly card: Card;
  /** Cards taken, including the played card; 0 when it stayed on the pile. */
  readonly capturedCount: number;
  readonly xeri: XeriKind | null;
}
export interface RoundSeatResult {
  readonly playerId: string;
  readonly seat: Seat;
  readonly cards: number;
  /** One point for each Ace, King, Queen, Jack and 10. */
  readonly cardPoints: number;
  readonly tenOfDiamonds: 0 | 1;
  readonly twoOfClubs: 0 | 1;
  readonly majority: 0 | 3;
  readonly xeriPoints: number;
  readonly total: number;
}
export interface RoundOutcome {
  readonly roundNumber: number;
  readonly dealer: Seat;
  readonly lastCapturer: Seat;
  /** Table cards collected automatically by the last capturer. Never a xeri. */
  readonly leftoverCards: number;
  readonly results: SeatPair<RoundSeatResult>;
  /** Cumulative match scores after this round. */
  readonly scores: SeatPair<number>;
}
export interface Score {
  readonly playerId: string;
  readonly seat: Seat;
  readonly points: number;
}
export interface MatchOutcome {
  readonly kind: 'win';
  readonly winner: Seat;
  readonly winnerId: string;
  readonly reason: 'target-reached';
  readonly roundNumber: number;
  readonly scores: SeatPair<Score>;
}
export interface HistoryRecord {
  readonly kind: 'player';
  readonly playerId: string;
  readonly action: PlayerAction;
}
/** Authoritative backend state. `initial.seed`, `hands` and `stock` must never reach a client. */
export interface XeriState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly engineVersion: typeof ENGINE_VERSION;
  readonly rulesVersion: typeof RULES_VERSION;
  readonly game: 'xeri';
  readonly initial: InitialState;
  readonly revision: number;
  /** Cards played across the whole match; nonzero means a move has been accepted. */
  readonly ply: number;
  readonly roundNumber: number;
  readonly dealer: Seat;
  readonly batch: number;
  readonly turn: Seat;
  readonly hands: SeatPair<readonly Card[]>;
  readonly stock: readonly Card[];
  /** Bottom to top. Only the top card decides a capture. */
  readonly table: readonly Card[];
  readonly captured: SeatPair<readonly Card[]>;
  readonly xeris: readonly XeriMark[];
  readonly lastCapturer: Seat | null;
  readonly lastPlay: LastPlay | null;
  readonly scores: SeatPair<number>;
  readonly rounds: readonly RoundOutcome[];
  readonly history: readonly HistoryRecord[];
  readonly phase: 'playing' | 'round-end' | 'ended';
  readonly matchOutcome: MatchOutcome | null;
}
/** Every event is safe to send to both players: none carries a hand or the stock. */
export type GameEvent =
  | { readonly type: 'game-created'; readonly mode: 'standard' | 'analysis' }
  | {
      readonly type: 'round-started';
      readonly roundNumber: number;
      readonly dealer: Seat;
      readonly starter: Seat;
    }
  | {
      readonly type: 'card-played';
      readonly playerId: string;
      readonly seat: Seat;
      readonly card: Card;
      readonly capturedCount: number;
      readonly xeri: XeriKind | null;
      readonly ply: number;
    }
  | {
      readonly type: 'batch-dealt';
      readonly roundNumber: number;
      readonly batch: number;
      readonly starter: Seat;
    }
  | { readonly type: 'round-ended'; readonly outcome: RoundOutcome }
  | { readonly type: 'match-ended'; readonly outcome: MatchOutcome };
export type ErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_STATE'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_ACTION'
  | 'UNKNOWN_PLAYER'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_MOVE'
  | 'STALE_REVISION'
  | 'GAME_ENDED'
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
      readonly state: XeriState;
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
/**
 * Whitelisted per-viewer view. The table pile is public because every card in it
 * was played face up; captured piles are counts only until the round is scored.
 */
export interface XeriObservation {
  readonly game: 'xeri';
  readonly rulesVersion: typeof RULES_VERSION;
  readonly revision: number;
  readonly viewer: string | null;
  readonly viewerSeat: Seat | null;
  readonly players: Players;
  readonly ply: number;
  readonly roundNumber: number;
  readonly batch: number;
  readonly dealer: Seat;
  readonly turn: Seat;
  readonly phase: XeriState['phase'];
  readonly hand: readonly Card[];
  readonly handCounts: SeatPair<number>;
  readonly stockCount: number;
  readonly table: readonly Card[];
  readonly capturedCounts: SeatPair<number>;
  readonly xeris: readonly XeriMark[];
  readonly lastPlay: LastPlay | null;
  readonly scores: SeatPair<number>;
  readonly target: typeof TARGET_SCORE;
  readonly rounds: readonly RoundOutcome[];
  readonly legalActions: readonly PlayerAction[];
  readonly matchOutcome: MatchOutcome | null;
  readonly analysisRoot: boolean;
  readonly conformance: { readonly clocks: false };
}
export interface BotOptions {
  readonly strategy?: 'first-legal' | 'random';
  readonly randomState?: number;
}
export interface BotDecision {
  readonly action: PlayerAction;
  readonly nextRandomState: number | null;
}
