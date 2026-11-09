import type { Card, Combo, ComboKind } from './types.js';
import { byDeckOrder, isSpecial, rankOf, suitOf } from './deck.js';

const ACE = 14;
const DRAGON_VALUE = 100;
const MIN_STRAIGHT = 5;
export interface Move {
  readonly cards: readonly Card[];
  readonly option: number;
  readonly combo: Combo;
}
export function cardPoints(card: Card): number {
  if (card === 'DRAGON') return 25;
  if (card === 'PHOENIX') return -25;
  const rank = rankOf(card);
  if (rank === 5) return 5;
  return rank === 10 || rank === 13 ? 10 : 0;
}
function singles(card: Card, top: Combo | null): Combo[] {
  const single = (value: number): Combo[] => [
    { kind: 'single', size: 1, value, bomb: 0 },
  ];
  if (card === 'DOG')
    return top ? [] : [{ kind: 'dog', size: 1, value: 0, bomb: 0 }];
  if (card === 'PHOENIX') {
    if (!top) return single(1.5);
    return top.value >= DRAGON_VALUE ? [] : single(top.value + 0.5);
  }
  return single(card === 'DRAGON' ? DRAGON_VALUE : rankOf(card));
}
function fullHouses(
  size: number,
  phoenix: boolean,
  keys: readonly number[],
  counts: ReadonlyMap<number, number>,
): number[] {
  if (size !== 5 || keys.length !== 2 || keys[0]! <= 1) return [];
  return keys.filter((triple) => {
    const pair = keys.find((rank) => rank !== triple)!,
      three = counts.get(triple)!,
      two = counts.get(pair)!;
    return (
      three <= 3 && two <= 2 && 3 - three + (2 - two) === (phoenix ? 1 : 0)
    );
  });
}
function isConsecutivePairs(
  size: number,
  phoenix: boolean,
  keys: readonly number[],
  counts: ReadonlyMap<number, number>,
): boolean {
  if (size < 4 || size % 2 !== 0 || keys[0]! <= 1) return false;
  if (keys.length !== size / 2) return false;
  if (
    !keys.every(
      (rank, index) => rank === keys[0]! + index && counts.get(rank)! <= 2,
    )
  )
    return false;
  const missing = keys.reduce((sum, rank) => sum + 2 - counts.get(rank)!, 0);
  return missing === (phoenix ? 1 : 0);
}
/** The top rank of every straight reading; the Phoenix can fill a gap or either end. */
function straightEnds(
  size: number,
  phoenix: boolean,
  keys: readonly number[],
): number[] {
  const ends: number[] = [];
  for (let start = 1; start + size - 1 <= ACE; start++) {
    const end = start + size - 1;
    if (!keys.every((rank) => rank >= start && rank <= end)) continue;
    if (start === 1 && !keys.includes(1)) continue;
    if (size - keys.length === (phoenix ? 1 : 0)) ends.push(end);
  }
  return ends;
}
/** Every reading of the cards, given the combination on the table. */
export function combinations(
  cards: readonly Card[],
  top: Combo | null = null,
): Combo[] {
  const size = cards.length;
  if (!size) return [];
  if (size === 1) return singles(cards[0]!, top);
  if (cards.includes('DOG') || cards.includes('DRAGON')) return [];
  const phoenix = cards.includes('PHOENIX');
  const natural = cards.filter((card) => card !== 'PHOENIX');
  const ranks = natural.map(rankOf);
  const counts = new Map<number, number>();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  const keys = [...counts.keys()].sort((a, b) => a - b);
  const out: Combo[] = [];
  const add = (kind: ComboKind, value: number, bomb = 0) =>
    out.push({ kind, size, value, bomb });
  if (size === 4 && !phoenix && keys.length === 1) add('bomb', keys[0]!, 4);
  if ((size === 2 || size === 3) && keys.length === 1 && keys[0]! > 1)
    add(size === 2 ? 'pair' : 'triple', keys[0]!);
  for (const triple of fullHouses(size, phoenix, keys, counts))
    add('full', triple);
  if (isConsecutivePairs(size, phoenix, keys, counts))
    add('pairs', keys.at(-1)!);
  if (size >= MIN_STRAIGHT && keys.length === ranks.length) {
    // A natural same-suit run is always a bomb, never an optional ordinary straight.
    const flush = cards.every(
      (card) => !isSpecial(card) && suitOf(card) === suitOf(cards[0]!),
    );
    for (const end of straightEnds(size, phoenix, keys))
      if (flush) add('bomb', end, size);
      else add('straight', end);
  }
  return out;
}
export function beats(combo: Combo, top: Combo | null): boolean {
  if (!top) return true;
  if (combo.bomb)
    return (
      !top.bomb ||
      combo.bomb > top.bomb ||
      (combo.bomb === top.bomb && combo.value > top.value)
    );
  return (
    combo.kind === top.kind &&
    combo.size === top.size &&
    combo.value > top.value
  );
}
function choose<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  return items.flatMap((item, index) =>
    choose(items.slice(index + 1), size - 1).map((rest) => [item, ...rest]),
  );
}
function byRank(hand: readonly Card[]): Map<number, Card[]> {
  const groups = new Map<number, Card[]>();
  for (const card of hand) {
    const rank = rankOf(card);
    if (card === 'PHOENIX' || rank === 0) continue;
    groups.set(rank, [...(groups.get(rank) ?? []), card]);
  }
  return groups;
}
/** Every run of `length` groups taken from `pick(rank)`, with the Phoenix filling one. */
function acrossRanks(
  groups: ReadonlyMap<number, readonly Card[]>,
  phoenix: boolean,
  start: number,
  length: number,
  pick: (cards: readonly Card[]) => Card[][],
  fill: (cards: readonly Card[]) => Card[][],
  visit: (cards: readonly Card[]) => void,
): void {
  const go = (index: number, chosen: readonly Card[], spare: boolean): void => {
    if (index === length) {
      visit(chosen);
      return;
    }
    const cards = groups.get(start + index) ?? [];
    for (const part of pick(cards)) go(index + 1, [...chosen, ...part], spare);
    if (spare)
      for (const part of fill(cards))
        go(index + 1, [...chosen, ...part, 'PHOENIX'], false);
  };
  go(0, [], phoenix);
}
function candidates(hand: readonly Card[]): Card[][] {
  const groups = byRank(hand),
    phoenix = hand.includes('PHOENIX'),
    found = new Map<string, Card[]>();
  const add = (cards: readonly Card[]) => {
    const sorted = [...cards].sort(byDeckOrder);
    found.set(sorted.join(), sorted);
  };
  for (const card of hand) add([card]);
  const plain = [...groups].filter(([rank]) => rank > 1);
  // Pairs, triples and four of a kind.
  for (const [, cards] of plain)
    for (const size of [2, 3, 4]) {
      for (const part of choose(cards, size)) add(part);
      if (phoenix && size < 4)
        for (const part of choose(cards, size - 1)) add([...part, 'PHOENIX']);
    }
  // Full houses: a triple and a pair, with the Phoenix completing either.
  for (const [high, three] of plain)
    for (const [low, two] of plain) {
      if (high === low) continue;
      for (const triple of choose(three, 3))
        for (const pair of choose(two, 2)) add([...triple, ...pair]);
      if (phoenix) {
        for (const triple of choose(three, 3))
          for (const card of two) add([...triple, card, 'PHOENIX']);
        for (const pair of choose(three, 2))
          for (const other of choose(two, 2))
            add([...pair, ...other, 'PHOENIX']);
      }
    }
  const pairOf = (cards: readonly Card[]) => choose(cards, 2);
  const oneOf = (cards: readonly Card[]) => cards.map((card) => [card]);
  const none = (cards: readonly Card[]) => [...oneOf(cards), []];
  for (let start = 2; start < ACE; start++)
    for (let length = 2; start + length - 1 <= ACE; length++)
      acrossRanks(groups, phoenix, start, length, pairOf, oneOf, add);
  for (let start = 1; start + MIN_STRAIGHT - 1 <= ACE; start++)
    for (let length = MIN_STRAIGHT; start + length - 1 <= ACE; length++)
      acrossRanks(groups, phoenix, start, length, oneOf, none, (cards) => {
        if (cards.length === length) add(cards);
      });
  return [...found.values()];
}
/** Every play from `hand` that beats the table, one entry per reading of the cards. */
export function movesFor(hand: readonly Card[], top: Combo | null): Move[] {
  const moves: Move[] = [];
  for (const cards of candidates(hand))
    combinations(cards, top).forEach((combo, option) => {
      if (beats(combo, top)) moves.push({ cards, option, combo });
    });
  return moves;
}
export function fulfilsWish(cards: readonly Card[], wish: number): boolean {
  return cards.some((card) => rankOf(card) === wish);
}
