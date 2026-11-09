/** Versioned, JSON-only contracts. No UI, transport, database, clocks or accounting. */
export const SCHEMA_VERSION = 2 as const;
export const ENGINE_VERSION = '0.2.0' as const;
export const RULES_VERSION =
  'skillbetting.tichu.nanking-four-player.v2' as const;
export const SEATS = 4 as const;
export const FIRST_DEAL = 8 as const;
export const SECOND_DEAL = 6 as const;
/** A target of 0 ends the match after `rounds`; an exact tie plays on in every format. */
export const FORMATS = {
  single: { target: 0, rounds: 1 },
  '500': { target: 500, rounds: 0 },
  '1000': { target: 1000, rounds: 0 },
} as const;
export type FormatId = keyof typeof FORMATS;
export type Suit = 'C' | 'D' | 'H' | 'S';
export type Rank =
  '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';
export type Special = 'MAHJONG' | 'DOG' | 'PHOENIX' | 'DRAGON';
export type Card = `${Rank}${Suit}` | Special;
/** Indexed by table seat. Partners sit opposite: seats 0 and 2, seats 1 and 3. */
export type Players = readonly string[];
export interface GrandAction {
  readonly type: 'grand';
  readonly call: boolean;
}
/** The cards go, in order, to the next seat, the partner and the seat before. */
export interface ExchangeAction {
  readonly type: 'exchange';
  readonly cards: readonly Card[];
}
export interface DeclareAction {
  readonly type: 'declare';
}
/**
 * `option` picks one reading of the cards; it defaults to 0. `wish` is required with
 * the Mah Jong and refused without it: 0 for none, otherwise a rank from 2 to 14.
 */
export interface PlayAction {
  readonly type: 'play';
  readonly cards: readonly Card[];
  readonly option: number;
  readonly wish?: number;
}
export interface PassAction {
  readonly type: 'pass';
}
/** Declines a bomb while the bomb window is open. */
export interface ContinueAction {
  readonly type: 'continue';
}
export interface DragonAction {
  readonly type: 'dragon';
  readonly to: number;
}
/** Any participant moves a finished round on to the next deal. */
export interface NextAction {
  readonly type: 'next';
}
export type PlayerAction =
  | GrandAction
  | ExchangeAction
  | DeclareAction
  | PlayAction
  | PassAction
  | ContinueAction
  | DragonAction
  | NextAction;
/** `seed` is 64 lowercase hex characters from a CSPRNG; it decides every hidden card. */
export interface CreateGameOptions {
  readonly players: Players;
  readonly seed: string;
  readonly format: FormatId;
}
/** Testing/import scenarios only. Scripted decks and opening scores are not fair play. */
export interface CreateAnalysisOptions extends CreateGameOptions {
  readonly decks: readonly (readonly Card[])[];
  readonly scores?: readonly number[];
}
export interface InitialState {
  readonly mode: 'standard' | 'analysis';
  readonly players: Players;
  readonly seed: string;
  readonly format: FormatId;
  /** One complete deck per scripted round, top card first. Empty in standard games. */
  readonly decks: readonly (readonly Card[])[];
  readonly scores: readonly number[];
}
export type ComboKind =
  'single' | 'dog' | 'pair' | 'triple' | 'full' | 'pairs' | 'straight' | 'bomb';
/** `bomb` is 0 for ordinary plays, otherwise the card count: a longer bomb wins. */
export interface Combo {
  readonly kind: ComboKind;
  readonly size: number;
  readonly value: number;
  readonly bomb: number;
}
export interface TopPlay {
  readonly player: number;
  readonly combo: Combo;
  readonly cards: readonly Card[];
}
export interface TeamResult {
  readonly side: number;
  readonly seats: readonly number[];
  /** 200 and 0 on a double victory, otherwise the card points won. */
  readonly cardPoints: number;
  readonly declarationPoints: number;
  readonly points: number;
}
export interface RoundOutcome {
  readonly roundNumber: number;
  /** Seats in the order they went out. */
  readonly order: readonly number[];
  readonly doubleVictory: boolean;
  readonly declarations: readonly number[];
  readonly results: readonly TeamResult[];
  /** Cumulative match scores after this round. */
  readonly scores: readonly number[];
}
export interface MatchOutcome {
  readonly kind: 'win';
  readonly side: number;
  readonly winners: readonly number[];
  readonly winnerIds: readonly string[];
  readonly reason: 'single-round' | 'target-reached';
  readonly roundNumber: number;
  readonly scores: readonly number[];
}
export interface HistoryRecord {
  readonly kind: 'player';
  readonly playerId: string;
  readonly action: PlayerAction;
}
export type Phase =
  | 'grand'
  | 'exchange'
  | 'play'
  | 'bomb-window'
  | 'dragon'
  | 'round-end'
  | 'ended';
/** Authoritative backend state. `initial.seed`, `hands`, `stock` and `exchange` must never reach a client. */
export interface TichuState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly engineVersion: typeof ENGINE_VERSION;
  readonly rulesVersion: typeof RULES_VERSION;
  readonly game: 'tichu';
  readonly initial: InitialState;
  readonly revision: number;
  /** Accepted game actions, not counting `next`; nonzero means a move has been accepted. */
  readonly ply: number;
  readonly roundNumber: number;
  readonly phase: Phase;
  /** Null while several seats may act, and at the round-end screen. */
  readonly turn: number | null;
  readonly hands: readonly (readonly Card[])[];
  /** Top card first; the six cards each that follow the Grand Tichu decisions. */
  readonly stock: readonly Card[];
  /** 0, 100 for Tichu or 200 for Grand Tichu, per seat. */
  readonly declarations: readonly number[];
  readonly grandDecided: readonly boolean[];
  /** Per seat: the three committed cards, kept out of sight until all four commit. */
  readonly exchange: readonly (readonly Card[] | null)[];
  readonly hasPlayed: readonly boolean[];
  readonly top: TopPlay | null;
  /** Every card played to the current trick. */
  readonly pile: readonly Card[];
  readonly captured: readonly (readonly Card[])[];
  /** Seats in the order they went out. */
  readonly order: readonly number[];
  readonly wish: number | null;
  readonly passes: readonly number[];
  readonly dragonWinner: number | null;
  /** Remaining seats yet to answer the public bomb window, independently of held cards. */
  readonly windowPending: readonly number[];
  readonly scores: readonly number[];
  readonly rounds: readonly RoundOutcome[];
  readonly history: readonly HistoryRecord[];
  readonly matchOutcome: MatchOutcome | null;
}
/** Every event is safe to send to every player: none carries a hand, the stock or an exchange. */
export type GameEvent =
  | { readonly type: 'game-created'; readonly mode: 'standard' | 'analysis' }
  | { readonly type: 'round-started'; readonly roundNumber: number }
  | {
      readonly type: 'grand-decided';
      readonly playerId: string;
      readonly seat: number;
      readonly call: boolean;
    }
  | { readonly type: 'cards-dealt'; readonly roundNumber: number }
  | {
      readonly type: 'exchange-committed';
      readonly playerId: string;
      readonly seat: number;
    }
  | { readonly type: 'exchange-done'; readonly lead: number }
  | {
      readonly type: 'tichu-declared';
      readonly playerId: string;
      readonly seat: number;
    }
  | {
      readonly type: 'cards-played';
      readonly playerId: string;
      readonly seat: number;
      readonly cards: readonly Card[];
      readonly combo: Combo;
      readonly wish: number | null;
      readonly outOfTurn: boolean;
    }
  | {
      readonly type: 'passed';
      readonly playerId: string;
      readonly seat: number;
    }
  | {
      readonly type: 'player-out';
      readonly seat: number;
      readonly place: number;
    }
  | {
      readonly type: 'trick-taken';
      readonly seat: number;
      readonly cardCount: number;
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
      readonly state: TichuState;
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
 * `actions` holds only legal actions. Too many can exist to list, such as the choices
 * of an exchange, so `complete: false` means more exist; `applyAction` alone decides.
 */
export interface LegalActions {
  readonly actions: readonly PlayerAction[];
  readonly complete: boolean;
}
export interface PlayOption extends Combo {
  readonly option: number;
}
/** Whitelisted per-viewer view. Captured tricks and committed exchanges are counts only. */
export interface TichuObservation {
  readonly game: 'tichu';
  readonly rulesVersion: typeof RULES_VERSION;
  readonly format: FormatId;
  readonly revision: number;
  readonly viewer: string | null;
  readonly viewerSeat: number | null;
  readonly players: Players;
  readonly ply: number;
  readonly roundNumber: number;
  readonly phase: Phase;
  readonly turn: number | null;
  /** True when the game waits on this viewer. Bombs and Tichu calls can come at any time. */
  readonly yourMove: boolean;
  readonly hand: readonly Card[];
  readonly handCounts: readonly number[];
  readonly declarations: readonly number[];
  readonly grandDecided: readonly boolean[];
  readonly exchangeCommitted: readonly boolean[];
  readonly hasPlayed: readonly boolean[];
  readonly top: TopPlay | null;
  readonly pileCount: number;
  readonly capturedCounts: readonly number[];
  readonly order: readonly number[];
  readonly wish: number | null;
  readonly dragonWinner: number | null;
  readonly scores: readonly number[];
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

export interface SelectionPreview {
  readonly selection: {
    readonly cards: readonly Card[];
    readonly wish?: number;
  };
  readonly options: readonly (PlayOption & { readonly legal: boolean })[];
}
