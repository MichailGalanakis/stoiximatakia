/** Versioned, JSON-only contracts. No UI, transport, database, clocks or accounting. */
export const SCHEMA_VERSION = 1 as const;
export const ENGINE_VERSION = '0.1.0' as const;
export type GameId = 'koumkan' | 'thanasis' | 'biriba';
export const RULES_VERSIONS = {
  koumkan: 'skillbetting.koumkan.two-player-100.v1',
  thanasis: 'skillbetting.thanasis.two-player-five-deals.v1',
  biriba: 'skillbetting.biriba.four-player-2005.v1',
} as const;
export const SEATS = { koumkan: 2, thanasis: 2, biriba: 4 } as const;
export const HAND_SIZE = { koumkan: 10, thanasis: 10, biriba: 11 } as const;
export const RESERVE_SIZE = 11 as const;
export const KOUMKAN_LIMIT = 100 as const;
export const THANASIS_DEALS = 5 as const;
export const BIRIBA_TARGET = 2005 as const;
export const BIRIBA_LENGTH = 7 as const;
export type Suit = 'C' | 'D' | 'H' | 'S';
export type Rank =
  'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';
/** Two-pack games hold two copies of each card, so every physical card has its own id. */
export type Card = `${Rank}${Suit}-${0 | 1}` | `JOKER-${0 | 1 | 2 | 3}`;
/** Indexed by table seat. Biriba partners sit opposite: seats 0 and 2, seats 1 and 3. */
export type Players = readonly string[];
export type DrawSource = 'stock' | 'discard';
export interface DrawAction {
  readonly type: 'draw';
  readonly source: DrawSource;
}
/** `option` picks one reading of the cards from `getMeldOptions`; it defaults to 0. */
export interface MeldAction {
  readonly type: 'meld';
  readonly cards: readonly Card[];
  readonly option: number;
}
export interface ExtendAction {
  readonly type: 'extend';
  readonly meld: string;
  readonly cards: readonly Card[];
  readonly option: number;
}
export interface ReplaceAction {
  readonly type: 'replace';
  readonly meld: string;
  readonly card: Card;
}
export interface DiscardAction {
  readonly type: 'discard';
  readonly card: Card;
}
export interface CloseAction {
  readonly type: 'close';
  readonly card: Card;
}
/** Any participant moves a finished round on to the next deal. */
export interface NextAction {
  readonly type: 'next';
}
export type PlayerAction =
  | DrawAction
  | MeldAction
  | ExtendAction
  | ReplaceAction
  | DiscardAction
  | CloseAction
  | NextAction;
/** `seed` is 64 lowercase hex characters from a CSPRNG; it decides every hidden card. */
export interface CreateGameOptions {
  readonly game: GameId;
  readonly players: Players;
  readonly seed: string;
}
/** Testing/import scenarios only. Scripted decks and opening scores are not fair play. */
export interface CreateAnalysisOptions extends CreateGameOptions {
  readonly firstStarter: number;
  readonly decks: readonly (readonly Card[])[];
  readonly scores?: readonly number[];
}
export interface InitialState {
  readonly mode: 'standard' | 'analysis';
  readonly game: GameId;
  readonly players: Players;
  readonly seed: string;
  readonly firstStarter: number;
  /** One complete deck per scripted round, top card first. Empty in standard games. */
  readonly decks: readonly (readonly Card[])[];
  readonly scores: readonly number[];
}
/** `rank` runs 1 to 14: an Ace sits at 1 when low and 14 when high. */
export interface MeldSlot {
  readonly card: Card;
  readonly rank: number;
  readonly suit: Suit;
  /** True while this card stands in for the rank and suit above. */
  readonly wild: boolean;
}
export interface MeldShape {
  readonly kind: 'set' | 'run';
  readonly slots: readonly MeldSlot[];
}
export interface Meld extends MeldShape {
  readonly id: string;
  /** The seat, or the partnership in Biriba. */
  readonly owner: number;
}
/** Koum Kan and Thanasis points are penalties, so lower is better there. */
export interface SideResult {
  /** The seat, or the partnership in Biriba. */
  readonly side: number;
  readonly seats: readonly number[];
  readonly meldPoints: number;
  readonly bonusPoints: number;
  readonly handPoints: number;
  readonly reservePenalty: 0 | 100;
  readonly closingBonus: 0 | 100;
  /** What this round adds to the side's match score. */
  readonly points: number;
}
export interface RoundOutcome {
  readonly roundNumber: number;
  readonly starter: number;
  readonly reason: 'closed' | 'stock';
  readonly closer: number | null;
  readonly melds: readonly Meld[];
  readonly results: readonly SideResult[];
  /** Cumulative match scores after this round. */
  readonly scores: readonly number[];
}
export interface MatchOutcome {
  readonly kind: 'win';
  /** The winning seat, or partnership in Biriba. */
  readonly side: number;
  readonly winners: readonly number[];
  readonly winnerIds: readonly string[];
  readonly reason: 'limit-reached' | 'deals-completed' | 'target-reached';
  readonly roundNumber: number;
  readonly scores: readonly number[];
}
export interface HistoryRecord {
  readonly kind: 'player';
  readonly playerId: string;
  readonly action: PlayerAction;
}
/** Authoritative backend state. `initial.seed`, `hands`, `stock` and `reserves` must never reach a client. */
export interface RummyState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly engineVersion: typeof ENGINE_VERSION;
  readonly rulesVersion: (typeof RULES_VERSIONS)[GameId];
  readonly game: GameId;
  readonly initial: InitialState;
  readonly revision: number;
  /** Accepted game actions, not counting `next`; nonzero means a move has been accepted. */
  readonly ply: number;
  readonly roundNumber: number;
  readonly starter: number;
  readonly turn: number;
  /** `draw` and `meld` are the stages of a turn; `round-end` waits for `next`. */
  readonly phase: 'draw' | 'meld' | 'round-end' | 'ended';
  readonly hands: readonly (readonly Card[])[];
  /** Top card first. */
  readonly stock: readonly Card[];
  /** Bottom to top. Every card in it was exposed face up. */
  readonly discard: readonly Card[];
  readonly indicator: Card;
  /** Thanasis only: the rank made wild by the indicator. */
  readonly wildRank: number | null;
  /** Biriba only: the suit that doubles a biriba's bonus. */
  readonly trump: Suit | null;
  readonly melds: readonly Meld[];
  readonly opened: readonly boolean[];
  /** Biriba's packets, one per partnership. */
  readonly reserves: readonly (readonly Card[])[];
  readonly reserveTaken: readonly boolean[];
  /** Per partnership: the seat that took its packet by discarding and has not drawn since. */
  readonly reserveWaiting: readonly (number | null)[];
  /** Biriba: the pile cards taken this turn. */
  readonly pickup: readonly Card[];
  readonly mustUsePickup: boolean;
  readonly turnDrawn: Card | null;
  readonly scores: readonly number[];
  readonly rounds: readonly RoundOutcome[];
  readonly history: readonly HistoryRecord[];
  readonly matchOutcome: MatchOutcome | null;
}
/** Every event is safe to send to every player: none carries a hand, the stock or a packet. */
export type GameEvent =
  | { readonly type: 'game-created'; readonly mode: 'standard' | 'analysis' }
  | {
      readonly type: 'round-started';
      readonly roundNumber: number;
      readonly starter: number;
      readonly indicator: Card;
      readonly wildRank: number | null;
      readonly trump: Suit | null;
    }
  | {
      readonly type: 'card-drawn';
      readonly playerId: string;
      readonly seat: number;
      readonly source: DrawSource;
      /** Only cards that were already face up are named. */
      readonly cards: readonly Card[];
    }
  | {
      readonly type: 'meld-placed';
      readonly playerId: string;
      readonly seat: number;
      readonly meld: Meld;
    }
  | {
      readonly type: 'meld-extended';
      readonly playerId: string;
      readonly seat: number;
      readonly meld: Meld;
      readonly cards: readonly Card[];
    }
  | {
      readonly type: 'joker-replaced';
      readonly playerId: string;
      readonly seat: number;
      readonly meld: Meld;
      readonly card: Card;
      readonly joker: Card;
    }
  | {
      readonly type: 'reserve-taken';
      readonly playerId: string;
      readonly seat: number;
      readonly side: number;
      /** True when the last card went by discard, so the packet waits for the next turn. */
      readonly afterDiscard: boolean;
    }
  | {
      readonly type: 'card-discarded';
      readonly playerId: string;
      readonly seat: number;
      readonly card: Card;
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
      readonly state: RummyState;
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
 * `actions` holds only legal actions. A crowded hand can allow too many to list,
 * so `complete: false` means more exist; `applyAction` alone decides legality.
 */
export interface LegalActions {
  readonly actions: readonly PlayerAction[];
  readonly complete: boolean;
}
export interface MeldOption extends MeldShape {
  readonly option: number;
}
export interface MeldOptionsRequest {
  readonly cards: readonly Card[];
  /** The table meld these cards would extend. Omit for a new meld. */
  readonly meld?: string;
}
/** Read-only feedback for the frontend's exact selection, independent of capped hints. */
export interface SelectionPreview {
  readonly selection: MeldOptionsRequest;
  /** Original option indices are retained, including structurally valid but illegal choices. */
  readonly options: readonly (MeldOption & { readonly legal: boolean })[];
  readonly discard: boolean;
  readonly replace: boolean;
}
/**
 * Whitelisted per-viewer view. The discard pile and melds are public because every
 * card in them was exposed face up; packets and other hands are counts only.
 */
export interface RummyObservation {
  readonly game: GameId;
  readonly rulesVersion: RummyState['rulesVersion'];
  readonly revision: number;
  readonly viewer: string | null;
  readonly viewerSeat: number | null;
  readonly players: Players;
  readonly ply: number;
  readonly roundNumber: number;
  readonly starter: number;
  readonly turn: number;
  readonly phase: RummyState['phase'];
  readonly hand: readonly Card[];
  readonly handCounts: readonly number[];
  readonly stockCount: number;
  readonly discard: readonly Card[];
  readonly indicator: Card;
  readonly wildRank: number | null;
  readonly trump: Suit | null;
  readonly melds: readonly Meld[];
  readonly opened: readonly boolean[];
  readonly reserveCounts: readonly number[];
  readonly reserveTaken: readonly boolean[];
  readonly pickup: readonly Card[];
  readonly mustUsePickup: boolean;
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
