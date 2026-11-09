import type {
  Card,
  LegalActions,
  Meld,
  PlayerAction,
  RummyState,
  Suit,
} from './types.js';
import { SUITS, byDeckOrder, rankOf, suitOf } from './deck.js';
import {
  closingMelds,
  combinations,
  extendOptions,
  hasBiriba,
  isWild,
  meldOptions,
  shortMelds,
  sideOf,
} from './rules.js';

const MAX_LISTED = 256;
const MAX_SEARCH_STEPS = 20_000;
const SHORTEST_RUN = 3;
const LONGEST_RUN = 13;
/** Every rank range a run can cover; rank 14 is a high Ace. */
const WINDOWS: readonly (readonly number[])[] = Object.freeze(
  Array.from({ length: 14 }, (_, offset) => offset + 1).flatMap((start) =>
    Array.from({ length: LONGEST_RUN - SHORTEST_RUN + 1 }, (_, extra) => {
      const length = SHORTEST_RUN + extra;
      return Array.from({ length }, (_, index) => start + index);
    }).filter((window) => window.at(-1)! <= 14),
  ),
);
const rankAt = (position: number) => (position === 14 ? 1 : position);
interface Search {
  steps: number;
  readonly limit: number;
}
export function without(hand: readonly Card[], cards: readonly Card[]): Card[] {
  return hand.filter((card) => !cards.includes(card));
}
export function replacedHand(
  state: RummyState,
  seat: number,
  hand: readonly Card[],
): readonly (readonly Card[])[] {
  return state.hands.map((held, index) => (index === seat ? hand : held));
}
function selectionProblem(
  hand: readonly Card[],
  cards: readonly Card[],
): string | null {
  if (new Set(cards).size !== cards.length) return 'Choose different cards.';
  return cards.every((card) => hand.includes(card))
    ? null
    : 'A chosen card is not in hand.';
}
/** What a meld or lay-off leaves in hand decides whether it is allowed at all. */
function handSizeProblem(
  state: RummyState,
  seat: number,
  melds: readonly Meld[],
  remaining: readonly Card[],
): string | null {
  const keepLast = 'Keep one last card to discard.';
  if (state.game !== 'biriba') return remaining.length ? null : keepLast;
  if (remaining.length > 1) return null;
  const side = sideOf(state.game, seat);
  if (!hasBiriba(melds, side))
    return 'Keep two cards until your team has a biriba.';
  return remaining.length === 0 && state.reserveTaken[side] ? keepLast : null;
}
/**
 * A pile taken must be used, and an unused pile would block the discard for good,
 * leaving the player with no legal move. So a play that spends the last way of
 * using it is refused; the designer's game does not catch this.
 */
function strandingProblem(
  state: RummyState,
  seat: number,
  melds: readonly Meld[],
  placed: readonly Card[],
): string | null {
  if (
    !state.mustUsePickup ||
    placed.some((card) => state.pickup.includes(card))
  )
    return null;
  const hand = without(state.hands[seat]!, placed);
  const after = { ...state, melds, hands: replacedHand(state, seat, hand) };
  return pileUse(after, seat)
    ? null
    : 'Keep a way to use a card from the discard pile.';
}
function placementProblem(
  state: RummyState,
  seat: number,
  melds: readonly Meld[],
  placed: readonly Card[],
): string | null {
  const hand = without(state.hands[seat]!, placed);
  return (
    handSizeProblem(state, seat, melds, hand) ??
    strandingProblem(state, seat, melds, placed)
  );
}
export function drawProblem(
  state: RummyState,
  seat: number,
  source: 'stock' | 'discard',
): string | null {
  if (state.phase !== 'draw') return 'You have already drawn.';
  if (source === 'stock') return null;
  if (state.game === 'thanasis') return 'Thanasis draws from the stock only.';
  const hand = state.hands[seat]!;
  if (state.game === 'koumkan')
    return hand.length > 1 ? null : 'With one card, draw from the stock.';
  const taken: RummyState = {
    ...state,
    hands: replacedHand(state, seat, [...hand, ...state.discard]),
    discard: [],
    pickup: state.discard,
    mustUsePickup: true,
  };
  return pileUse(taken, seat)
    ? null
    : 'You must be able to use a card from the pile in a combination.';
}
export function withSlots(
  melds: readonly Meld[],
  meld: Meld,
  slots: Meld['slots'],
): Meld[] {
  return melds.map((item) => (item === meld ? { ...item, slots } : item));
}
export function meldFrom(
  state: RummyState,
  seat: number,
  shape: ReturnType<typeof meldOptions>[number],
): Meld {
  return {
    ...shape,
    id: `meld-${state.melds.length}`,
    owner: sideOf(state.game, seat),
  };
}
export function meldProblem(
  state: RummyState,
  seat: number,
  cards: readonly Card[],
  option: number,
): string | null {
  if (state.phase !== 'meld') return 'Draw first.';
  if (state.game === 'thanasis')
    return 'Thanasis hands go down together when closing.';
  const problem = selectionProblem(state.hands[seat]!, cards);
  if (problem) return problem;
  const shape = meldOptions(cards, state)[option];
  if (!shape) return 'A meld needs at least three cards that combine.';
  const melds = [...state.melds, meldFrom(state, seat, shape)];
  return placementProblem(state, seat, melds, cards);
}
export function extendProblem(
  state: RummyState,
  seat: number,
  id: string,
  cards: readonly Card[],
  option: number,
): string | null {
  if (state.phase !== 'meld') return 'Draw first.';
  if (state.game === 'thanasis') return 'Thanasis has no lay-offs.';
  const meld = state.melds.find((item) => item.id === id);
  if (!meld) return 'Choose a meld on the table.';
  const allowed =
    state.game === 'biriba'
      ? meld.owner === sideOf(state.game, seat)
      : state.opened[seat];
  if (!allowed) return 'Lay off on your own team, or open first.';
  const problem = selectionProblem(state.hands[seat]!, cards);
  if (problem) return problem;
  const shape = extendOptions(meld, cards, state)[option];
  if (!shape) return 'Those cards do not extend the meld.';
  const melds = withSlots(state.melds, meld, shape.slots);
  return placementProblem(state, seat, melds, cards);
}
export function replaceProblem(
  state: RummyState,
  seat: number,
  id: string,
  card: Card,
): string | null {
  if (state.phase !== 'meld') return 'Draw first.';
  if (state.game !== 'koumkan' || !state.opened[seat])
    return 'Jokers are replaced in Koum Kan, after opening.';
  const meld = state.melds.find((item) => item.id === id);
  if (!meld) return 'Choose a meld on the table.';
  if (!state.hands[seat]!.includes(card)) return 'That card is not in hand.';
  return replacedSlot(meld, card)
    ? null
    : 'You need the exact card the Joker stands for.';
}
/** A high Ace sits at rank 14, so both ends of the rank scale accept an Ace. */
export function replacedSlot(meld: Meld, card: Card) {
  const rank = rankOf(card);
  return meld.slots.find(
    (slot) =>
      slot.wild &&
      slot.suit === suitOf(card) &&
      (slot.rank === rank || (rank === 1 && slot.rank === 14)),
  );
}
export function discardProblem(
  state: RummyState,
  seat: number,
  card: Card,
): string | null {
  if (state.phase !== 'meld') return 'Draw first.';
  if (state.mustUsePickup) return 'Use a card from the pile first.';
  const hand = state.hands[seat]!;
  if (!hand.includes(card)) return 'That card is not in hand.';
  return state.game === 'koumkan' &&
    card === state.turnDrawn &&
    hand.length === 2
    ? 'Keep the new card and discard the old one.'
    : null;
}
export function closeProblem(
  state: RummyState,
  seat: number,
  card: Card,
): string | null {
  if (state.phase !== 'meld') return 'Draw first.';
  if (state.game !== 'thanasis') return 'Closing belongs to Thanasis.';
  const hand = state.hands[seat]!;
  if (!hand.includes(card)) return 'That card is not in hand.';
  return closingMelds(shortMelds(hand, state), 1 << hand.indexOf(card))
    ? null
    : 'Closing needs two triples and a four, with one card to discard.';
}
/**
 * Fills `positions` of a one-suit run from `pool`, trying each `keyOf` value once per
 * position. Stops as soon as `visit` returns true, which is also the result.
 */
function fillRun(
  state: RummyState,
  pool: readonly Card[],
  suit: Suit,
  positions: readonly number[],
  allowedWild: number,
  keyOf: (card: Card) => string,
  search: Search,
  visit: (cards: readonly Card[]) => boolean,
): boolean {
  const chosen: Card[] = [];
  const go = (index: number, wildLeft: number): boolean => {
    if (index === positions.length) return visit(chosen);
    const rank = rankAt(positions[index]!),
      tried = new Set<string>();
    for (const card of pool) {
      if (chosen.includes(card) || tried.has(keyOf(card))) continue;
      const natural = suitOf(card) === suit && rankOf(card) === rank;
      if (!natural && (wildLeft === 0 || !isWild(card, state))) continue;
      tried.add(keyOf(card));
      if (++search.steps > search.limit) return true;
      chosen.push(card);
      if (go(index + 1, natural ? wildLeft : wildLeft - 1)) return true;
      chosen.pop();
    }
    return false;
  };
  return go(0, allowedWild);
}
/** The ranks a run can still add, one list per reachable window. */
function freshRanks(meld: Meld): number[][] {
  const base = meld.slots.map((slot) => slot.rank);
  const readings = base.includes(1)
    ? [base, base.map((rank) => (rank === 1 ? 14 : rank))]
    : [base];
  const fresh: number[][] = [];
  for (const window of WINDOWS)
    for (const ranks of readings)
      if (ranks.every((rank) => window.includes(rank)))
        fresh.push(window.filter((rank) => !ranks.includes(rank)));
  return fresh.filter((ranks) => ranks.length > 0);
}
function allowedWilds(state: RummyState, count: number): number {
  return state.game === 'biriba' ? 1 : count;
}
function ownMelds(state: RummyState, seat: number): readonly Meld[] {
  if (state.game === 'biriba')
    return state.melds.filter(
      (meld) => meld.owner === sideOf(state.game, seat),
    );
  return state.opened[seat] ? state.melds : [];
}
/**
 * One legal meld or lay-off that uses a card from the pile just taken, or null.
 * Copies differ only by being in the pile or not, so each is tried once.
 */
export function pileUse(state: RummyState, seat: number): PlayerAction | null {
  const hand = state.hands[seat]!,
    pile = new Set(state.pickup);
  const fromPile = (card: Card) => pile.has(card);
  const pileWild = hand.some((card) => fromPile(card) && isWild(card, state));
  const keyOf = (card: Card) => `${fromPile(card)}:${card.split('-')[0]}`;
  const search: Search = { steps: 0, limit: Number.POSITIVE_INFINITY };
  const placeable = (positions: readonly number[], suit: Suit) =>
    pileWild ||
    positions.some((position) =>
      hand.some(
        (card) =>
          fromPile(card) &&
          suitOf(card) === suit &&
          rankOf(card) === rankAt(position),
      ),
    );
  let found: PlayerAction | null = null;
  const tryMeld = (cards: readonly Card[]): boolean => {
    const shape = cards.some(fromPile)
      ? meldOptions(cards, state)[0]
      : undefined;
    if (!shape) return false;
    const melds = [...state.melds, meldFrom(state, seat, shape)];
    if (handSizeProblem(state, seat, melds, without(hand, cards))) return false;
    found = { type: 'meld', cards: [...cards].sort(byDeckOrder), option: 0 };
    return true;
  };
  for (const suit of SUITS)
    for (const positions of WINDOWS)
      if (
        placeable(positions, suit) &&
        fillRun(state, hand, suit, positions, 1, keyOf, search, tryMeld)
      )
        return found;
  for (const meld of ownMelds(state, seat)) {
    const tryExtend = (cards: readonly Card[]): boolean => {
      const shape = cards.some(fromPile)
        ? extendOptions(meld, cards, state)[0]
        : undefined;
      if (!shape) return false;
      const melds = withSlots(state.melds, meld, shape.slots);
      if (handSizeProblem(state, seat, melds, without(hand, cards)))
        return false;
      found = {
        type: 'extend',
        meld: meld.id,
        cards: [...cards].sort(byDeckOrder),
        option: 0,
      };
      return true;
    };
    const suit = meld.slots[0]!.suit;
    for (const ranks of freshRanks(meld)) {
      const wilds = allowedWilds(state, ranks.length);
      if (fillRun(state, hand, suit, ranks, wilds, keyOf, search, tryExtend))
        return found;
    }
  }
  return found;
}
function placements(
  state: RummyState,
  seat: number,
): { actions: PlayerAction[]; complete: boolean } {
  const hand = state.hands[seat]!,
    actions: PlayerAction[] = [],
    seen = new Set<string>(),
    search: Search = { steps: 0, limit: MAX_SEARCH_STEPS };
  const keyOf = (card: Card) => card;
  const add = (action: PlayerAction): void => {
    const key = JSON.stringify(action);
    if (seen.has(key)) return;
    seen.add(key);
    actions.push(action);
  };
  const full = () => actions.length >= MAX_LISTED;
  const addMeld = (cards: readonly Card[]): boolean => {
    const sorted = [...cards].sort(byDeckOrder);
    meldOptions(sorted, state).forEach((_, option) => {
      if (!meldProblem(state, seat, sorted, option))
        add({ type: 'meld', cards: sorted, option });
    });
    return full();
  };
  if (state.mustUsePickup) {
    const use = pileUse(state, seat);
    if (use) add(use);
  }
  if (state.game === 'koumkan')
    for (let rank = 1; rank <= 13 && !full(); rank++) {
      const pool = hand.filter(
        (card) => rankOf(card) === rank || isWild(card, state),
      );
      for (const size of [3, 4])
        for (const cards of combinations(pool, size)) if (addMeld(cards)) break;
    }
  for (const suit of SUITS)
    for (const positions of WINDOWS) {
      if (full() || search.steps > search.limit) break;
      const wilds = state.game === 'biriba' ? 1 : positions.length;
      fillRun(state, hand, suit, positions, wilds, keyOf, search, addMeld);
    }
  for (const meld of ownMelds(state, seat)) {
    const addExtend = (cards: readonly Card[]): boolean => {
      const sorted = [...cards].sort(byDeckOrder);
      extendOptions(meld, sorted, state).forEach((_, option) => {
        if (!extendProblem(state, seat, meld.id, sorted, option))
          add({ type: 'extend', meld: meld.id, cards: sorted, option });
      });
      return full();
    };
    if (meld.kind === 'set') {
      for (const card of hand) if (addExtend([card])) break;
      continue;
    }
    for (const ranks of freshRanks(meld)) {
      if (full() || search.steps > search.limit) break;
      const wilds = allowedWilds(state, ranks.length);
      fillRun(
        state,
        hand,
        meld.slots[0]!.suit,
        ranks,
        wilds,
        keyOf,
        search,
        addExtend,
      );
    }
  }
  return {
    actions,
    complete: !full() && search.steps <= search.limit,
  };
}
function replacements(state: RummyState, seat: number): PlayerAction[] {
  const actions: PlayerAction[] = [];
  for (const meld of state.melds)
    for (const card of state.hands[seat]!)
      if (!replaceProblem(state, seat, meld.id, card))
        actions.push({ type: 'replace', meld: meld.id, card });
  return actions;
}
function closes(state: RummyState, seat: number): PlayerAction[] {
  const hand = state.hands[seat]!,
    melds = shortMelds(hand, state);
  return hand
    .filter((_, index) => closingMelds(melds, 1 << index))
    .map((card) => ({ type: 'close', card }));
}
/** Melds and lay-offs come first; discards are always listed, even past the cap. */
export function listActions(state: RummyState, seat: number): LegalActions {
  if (state.phase === 'round-end')
    return { actions: [{ type: 'next' }], complete: true };
  if (state.phase === 'ended' || state.turn !== seat)
    return { actions: [], complete: true };
  if (state.phase === 'draw') {
    const sources = (['stock', 'discard'] as const).filter(
      (source) => !drawProblem(state, seat, source),
    );
    return {
      actions: sources.map((source) => ({ type: 'draw', source })),
      complete: true,
    };
  }
  const discards: PlayerAction[] = state.hands[seat]!.filter(
    (card) => !discardProblem(state, seat, card),
  ).map((card) => ({ type: 'discard', card }));
  if (state.game === 'thanasis')
    return { actions: [...closes(state, seat), ...discards], complete: true };
  const placed = placements(state, seat);
  const swaps = state.game === 'koumkan' ? replacements(state, seat) : [];
  return {
    actions: [...placed.actions, ...swaps, ...discards],
    complete: placed.complete,
  };
}
