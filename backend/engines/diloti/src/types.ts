/** Versioned, JSON-only contracts. No UI, transport, database, clocks or accounting. */
export const SCHEMA_VERSION = 2 as const;
export const ENGINE_VERSION = '0.2.0' as const;
export const RULES_VERSION = 'skillbetting.diloti.two-player-61.v2' as const;
export const TARGET_SCORE = 61 as const;
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
export interface LayAction {
  readonly type: 'lay';
  readonly card: Card;
}
/** `table` lists table item ids; every selected item is taken. */
export interface CaptureAction {
  readonly type: 'capture';
  readonly card: Card;
  readonly table: readonly string[];
}
/** `value` is the declared capture value, at most 10. */
export interface DeclareAction {
  readonly type: 'declare';
  readonly card: Card;
  readonly table: readonly string[];
  readonly value: number;
}
export type CardAction = LayAction | CaptureAction | DeclareAction;
export interface NextRoundAction {
  readonly type: 'next';
}
export type PlayerAction = CardAction | NextRoundAction;
/** Read-only UI selection; never an accepted action or a complete legal-action list. */
export interface Selection {
  readonly card: Card;
  readonly table: readonly string[];
}
export interface SelectionOption {
  readonly legal: boolean;
  readonly capturedCount: number;
  readonly xeri: boolean;
  readonly group: boolean;
}
export interface SelectionPreview {
  readonly selection: Selection;
  readonly lay: SelectionOption;
  readonly capture: SelectionOption;
  /** Exactly ten entries, indexed by declaration value minus one. */
  readonly declarations: readonly SelectionOption[];
}
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
/** One unit on the table: a loose card, or a declaration with two or more cards. */
export interface TableItem {
  /** The card for a loose item; `declaration-<ply>` for a declaration. */
  readonly id: string;
  readonly cards: readonly Card[];
  /** Capture value: 1 to 10, or 11 to 13 for a loose Jack, Queen or King. */
  readonly value: number;
  /** The seat bound to capture this declaration; null for a loose card. */
  readonly owner: Seat | null;
  readonly group: boolean;
}
export interface XeriMark {
  readonly seat: Seat;
  readonly card: Card;
}
export interface LastPlay {
  readonly seat: Seat;
  readonly card: Card;
  readonly type: CardAction['type'];
  /** Cards taken, including the played card; 0 unless this play captured. */
  readonly capturedCount: number;
  readonly xeri: boolean;
  readonly value: number | null;
  readonly group: boolean;
}
export interface RoundSeatResult {
  readonly playerId: string;
  readonly seat: Seat;
  readonly cards: number;
  /** One point for each Ace. */
  readonly aces: number;
  readonly tenOfDiamonds: 0 | 2;
  readonly twoOfClubs: 0 | 1;
  readonly majority: 0 | 4;
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
export interface DilotiState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly engineVersion: typeof ENGINE_VERSION;
  readonly rulesVersion: typeof RULES_VERSION;
  readonly game: 'diloti';
  readonly initial: InitialState;
  readonly revision: number;
  /** Cards played across the whole match; nonzero means a move has been accepted. */
  readonly ply: number;
  /** Cards played this round. The first play of a round cannot score a xeri. */
  readonly roundPly: number;
  readonly roundNumber: number;
  readonly dealer: Seat;
  readonly batch: number;
  readonly turn: Seat;
  readonly hands: SeatPair<readonly Card[]>;
  readonly stock: readonly Card[];
  readonly table: readonly TableItem[];
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
      readonly action: PlayerAction;
      readonly capturedCount: number;
      readonly xeri: boolean;
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
      readonly state: DilotiState;
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
/** A crowded table can allow too many selections to list; applyAction still decides each. */
export interface LegalActionList {
  readonly actions: readonly PlayerAction[];
  readonly complete: boolean;
}
/**
 * Whitelisted per-viewer view. Table items are public; captured piles are counts
 * only until the round is scored.
 */
export interface DilotiObservation {
  readonly game: 'diloti';
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
  readonly phase: DilotiState['phase'];
  readonly hand: readonly Card[];
  readonly handCounts: SeatPair<number>;
  readonly stockCount: number;
  readonly table: readonly TableItem[];
  readonly capturedCounts: SeatPair<number>;
  readonly xeris: readonly XeriMark[];
  readonly lastPlay: LastPlay | null;
  readonly scores: SeatPair<number>;
  readonly target: typeof TARGET_SCORE;
  readonly rounds: readonly RoundOutcome[];
  readonly legalActions: readonly PlayerAction[];
  readonly legalActionsComplete: boolean;
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
