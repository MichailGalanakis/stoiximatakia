import type { Card, GameId, Meld, MeldShape, MeldSlot, Suit } from './types.js';
import { BIRIBA_LENGTH } from './types.js';
import { SUITS, byDeckOrder, rankOf, suitOf } from './deck.js';

const MAX_MELD = 13;
const ACE_HIGH = 14;
export interface Table {
  readonly game: GameId;
  readonly wildRank: number | null;
}
export interface ShortMeld {
  readonly size: number;
  readonly mask: number;
  readonly points: number;
  readonly shape: MeldShape;
}
/** Biriba partnerships are opposite seats; the other games are individual. */
export function sideOf(game: GameId, seat: number): number {
  return game === 'biriba' ? seat % 2 : seat;
}
export function isWild(card: Card, table: Table): boolean {
  const rank = rankOf(card);
  return (
    rank === 0 ||
    (table.game === 'biriba' && rank === 2) ||
    rank === table.wildRank
  );
}
/** The card values in the designer's rules: the same in hand and on the table. */
export function cardPoints(card: Card, table: Table): number {
  const rank = rankOf(card);
  if (table.game === 'biriba') {
    if (rank === 0) return 20;
    if (rank === 1) return 15;
    return rank === 2 || rank >= 8 ? 10 : 5;
  }
  if (isWild(card, table)) return table.game === 'thanasis' ? 25 : 20;
  if (rank === 1) return table.game === 'koumkan' ? 11 : 1;
  return Math.min(10, rank);
}
export function pointsOf(cards: readonly Card[], table: Table): number {
  return cards.reduce((sum, card) => sum + cardPoints(card, table), 0);
}
export function hasBiriba(melds: readonly Meld[], side: number): boolean {
  return melds.some(
    (meld) => meld.owner === side && meld.slots.length >= BIRIBA_LENGTH,
  );
}
export function biribaBonus(meld: Meld, trump: Suit | null): number {
  if (meld.slots.length < BIRIBA_LENGTH) return 0;
  const dirty = meld.slots.some((slot) => slot.wild);
  const base =
    meld.slots.length === MAX_MELD ? (dirty ? 500 : 1000) : dirty ? 100 : 200;
  return meld.slots[0]!.suit === trump ? base * 2 : base;
}
function setShape(natural: readonly Card[], substitutes: readonly Card[]) {
  const rank = rankOf(natural[0]!);
  const free = SUITS.filter(
    (suit) => !natural.some((card) => suitOf(card) === suit),
  );
  const slots: MeldSlot[] = [
    ...natural.map((card) => ({
      card,
      rank,
      suit: suitOf(card)!,
      wild: false,
    })),
    ...substitutes.map((card, index) => ({
      card,
      rank,
      suit: free[index]!,
      wild: true,
    })),
  ];
  return { kind: 'set', slots } satisfies MeldShape;
}
function isSet(natural: readonly Card[]): boolean {
  return (
    natural.every((card) => rankOf(card) === rankOf(natural[0]!)) &&
    new Set(natural.map(suitOf)).size === natural.length
  );
}
function runSlots(
  natural: readonly Card[],
  ranks: readonly number[],
  substitutes: readonly Card[],
  start: number,
  end: number,
): MeldSlot[] | null {
  const suit = suitOf(natural[0]!)!;
  const slots: MeldSlot[] = [];
  let used = 0;
  for (let rank = start; rank <= end; rank++) {
    const at = ranks.indexOf(rank),
      card = at >= 0 ? natural[at] : substitutes[used++];
    if (!card) return null;
    slots.push({ card, rank, suit, wild: at < 0 });
  }
  return used === substitutes.length ? slots : null;
}
/** A run takes an Ace below the 2 or above the King, never around the corner. */
function runShapes(
  natural: readonly Card[],
  substitutes: readonly Card[],
  length: number,
): MeldShape[] {
  const shapes: MeldShape[] = [];
  for (const aceHigh of [false, true]) {
    const ranks = natural.map((card) =>
      rankOf(card) === 1 && aceHigh ? ACE_HIGH : rankOf(card),
    );
    if (new Set(ranks).size !== ranks.length) continue;
    for (let start = 1; start + length - 1 <= ACE_HIGH; start++) {
      const end = start + length - 1;
      if (!ranks.every((rank) => rank >= start && rank <= end)) continue;
      const slots = runSlots(natural, ranks, substitutes, start, end);
      if (slots) shapes.push({ kind: 'run', slots });
    }
  }
  return shapes;
}
function shapeKey(shape: MeldShape): string {
  return `${shape.kind}|${shape.slots
    .map((slot) => `${slot.card}:${slot.rank}:${slot.suit}:${slot.wild}`)
    .sort()
    .join()}`;
}
function distinct(shapes: readonly MeldShape[]): MeldShape[] {
  const found = new Map<string, MeldShape>();
  for (const shape of shapes)
    if (!found.has(shapeKey(shape))) found.set(shapeKey(shape), shape);
  return [...found.values()];
}
function wildCount(shape: MeldShape): number {
  return shape.slots.filter((slot) => slot.wild).length;
}
function readings(cards: readonly Card[], table: Table): MeldShape[] {
  if (
    cards.length < 3 ||
    cards.length > MAX_MELD ||
    new Set(cards).size !== cards.length
  )
    return [];
  const wild = cards.filter((card) => isWild(card, table));
  const maxWild = table.game === 'biriba' ? 1 : cards.length - 1;
  const shapes: MeldShape[] = [];
  for (let mask = 0; mask < 1 << wild.length; mask++) {
    const substitutes = wild.filter((_, index) => mask & (1 << index));
    if (substitutes.length > maxWild) continue;
    const natural = cards.filter((card) => !substitutes.includes(card));
    // maxWild leaves at least one natural card, and a Joker is never one.
    if (natural.some((card) => rankOf(card) === 0)) continue;
    if (table.game !== 'biriba' && isSet(natural)) {
      if (substitutes.length <= 4 - natural.length)
        shapes.push(setShape(natural, substitutes));
    }
    if (natural.every((card) => suitOf(card) === suitOf(natural[0]!)))
      shapes.push(...runShapes(natural, substitutes, cards.length));
  }
  return shapes;
}
function ordered(shapes: readonly MeldShape[]): MeldShape[] {
  return distinct(shapes).sort((a, b) => wildCount(a) - wildCount(b));
}
/** Every way to read `cards` as one meld, cleanest first. Selection order does not matter. */
export function meldOptions(cards: readonly Card[], table: Table): MeldShape[] {
  return ordered(readings([...cards].sort(byDeckOrder), table));
}
function keepsSlots(next: MeldShape, meld: MeldShape): boolean {
  return (
    next.kind === meld.kind &&
    meld.slots.every((old) =>
      next.slots.some(
        (slot) =>
          slot.card === old.card &&
          slot.wild === old.wild &&
          slot.suit === old.suit &&
          (slot.rank === old.rank ||
            (old.rank === 1 && slot.rank === ACE_HIGH)),
      ),
    )
  );
}
/**
 * The meld grown by `cards`, every card already down keeping its role. Wild cards
 * fill gaps in listed order, so both orders are read: a new Joker can then land
 * below one already placed.
 */
export function extendOptions(
  meld: MeldShape,
  cards: readonly Card[],
  table: Table,
): MeldShape[] {
  if (!cards.length) return [];
  const old = meld.slots.map((slot) => slot.card),
    added = [...cards].sort(byDeckOrder);
  return ordered([
    ...readings([...old, ...added], table),
    ...readings([...added, ...old], table),
  ]).filter((shape) => keepsSlots(shape, meld));
}
export function combinations<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const visit = (start: number, part: T[]): void => {
    if (part.length === size) {
      out.push(part);
      return;
    }
    for (let i = start; i <= items.length - (size - part.length); i++)
      visit(i + 1, [...part, items[i]!]);
  };
  visit(0, []);
  return out;
}
/** Thanasis: every three- or four-card meld inside a hand, as bitmasks of that hand. */
export function shortMelds(hand: readonly Card[], table: Table): ShortMeld[] {
  const melds: ShortMeld[] = [];
  for (const size of [3, 4])
    for (const cards of combinations(hand, size)) {
      const shape = meldOptions(cards, table)[0];
      if (!shape) continue;
      melds.push({
        size,
        shape,
        points: pointsOf(cards, table),
        mask: cards.reduce((mask, card) => mask | (1 << hand.indexOf(card)), 0),
      });
    }
  return melds;
}
/** Thanasis close: two triples and a four that avoid the `blocked` cards, or null. */
export function closingMelds(
  melds: readonly ShortMeld[],
  blocked: number,
): MeldShape[] | null {
  const free = melds.filter((meld) => !(meld.mask & blocked)),
    triples = free.filter((meld) => meld.size === 3);
  for (const four of free.filter((meld) => meld.size === 4))
    for (const first of triples) {
      if (first.mask & four.mask) continue;
      const taken = four.mask | first.mask;
      const second = triples.find((meld) => !(meld.mask & taken));
      if (second) return [four.shape, first.shape, second.shape];
    }
  return null;
}
/** Thanasis: the most a hand can remove in disjoint three- and four-card melds. */
export function leastPenalty(hand: readonly Card[], table: Table): number {
  const melds = shortMelds(hand, table),
    known = new Map<number, number>();
  const best = (used: number): number => {
    const saved = known.get(used);
    if (saved !== undefined) return saved;
    let value = 0;
    for (const meld of melds)
      if (!(meld.mask & used))
        value = Math.max(value, meld.points + best(used | meld.mask));
    known.set(used, value);
    return value;
  };
  return pointsOf(hand, table) - best(0);
}
