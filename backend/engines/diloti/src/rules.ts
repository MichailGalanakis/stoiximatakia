import type {
  Card,
  LegalActionList,
  PlayerAction,
  Rank,
  Seat,
  TableItem,
} from './types.js';
import { rankOf } from './deck.js';

const NAMED_VALUES: Partial<Record<Rank, number>> = {
  A: 1,
  J: 11,
  Q: 12,
  K: 13,
};
const MAX_DECLARED_VALUE = 10;
const MAX_ACTIONS_PER_CARD = 256;
const MAX_SEARCH_STEPS = 20_000;

export function cardValue(card: Card): number {
  const rank = rankOf(card);
  return NAMED_VALUES[rank] ?? Number(rank);
}
export function looseItem(card: Card): TableItem {
  return {
    id: card,
    cards: [card],
    value: cardValue(card),
    owner: null,
    group: false,
  };
}
const isDeclaration = (item: TableItem): boolean => item.cards.length > 1;
const totalOf = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0);

/** The one unresolved declaration this seat is bound to, if any. */
export function ownDeclaration(
  table: readonly TableItem[],
  seat: Seat,
): TableItem | null {
  return table.find((item) => item.owner === seat) ?? null;
}
/**
 * True when every value fits into disjoint sets each summing exactly to `target`.
 * Works on value counts with memoization, so a large table stays cheap.
 */
export function splitsInto(values: readonly number[], target: number): boolean {
  if (target < 1 || totalOf(values) % target !== 0) return false;
  if (values.some((value) => value < 1 || value > target)) return false;
  const counts = new Array<number>(target + 1).fill(0);
  for (const value of values) counts[value]!++;
  const memo = new Map<string, boolean>();
  const clear = (): boolean => {
    let largest = target;
    while (largest > 0 && counts[largest] === 0) largest--;
    if (largest === 0) return true;
    const key = counts.join();
    const known = memo.get(key);
    if (known !== undefined) return known;
    counts[largest]!--;
    const result = fill(target - largest, largest);
    counts[largest]!++;
    memo.set(key, result);
    return result;
  };
  const fill = (gap: number, limit: number): boolean => {
    if (gap === 0) return clear();
    for (let value = Math.min(gap, limit); value > 0; value--) {
      if (counts[value] === 0) continue;
      counts[value]!--;
      const result = fill(gap - value, value);
      counts[value]!++;
      if (result) return true;
    }
    return false;
  };
  return clear();
}
function selectedItems(
  table: readonly TableItem[],
  ids: readonly string[],
): TableItem[] | null {
  const items = table.filter((item) => ids.includes(item.id));
  return items.length === ids.length ? items : null;
}
function keepsCaptureCard(
  hand: readonly Card[],
  played: Card,
  value: number,
): boolean {
  return hand.some((held) => held !== played && cardValue(held) === value);
}
/** Declarations go at their exact value only, never inside a larger sum. */
function capturesTogether(items: readonly TableItem[], value: number): boolean {
  if (items.some((item) => isDeclaration(item) && item.value !== value))
    return false;
  const loose = items.filter((item) => !isDeclaration(item));
  return splitsInto(
    loose.map((item) => item.value),
    value,
  );
}
export function layProblem(
  table: readonly TableItem[],
  seat: Seat,
  card: Card,
): string | null {
  if (ownDeclaration(table, seat))
    return 'Resolve your declaration before leaving a loose card.';
  const value = cardValue(card);
  if (value > 10 && table.some((item) => item.value === value))
    return 'A court card must capture the matching court card.';
  return null;
}
export function captureProblem(
  table: readonly TableItem[],
  hand: readonly Card[],
  seat: Seat,
  card: Card,
  ids: readonly string[],
): string | null {
  const items = selectedItems(table, ids);
  if (!items) return 'The selection does not match the table.';
  if (!items.length) return 'Choose what to capture.';
  const value = cardValue(card),
    first = items[0]!;
  const valid =
    value > 10
      ? items.length === 1 && !isDeclaration(first) && first.value === value
      : capturesTogether(items, value);
  if (!valid) return 'This card cannot capture that selection.';
  const own = ownDeclaration(table, seat);
  if (own && !items.includes(own) && !keepsCaptureCard(hand, card, own.value))
    return 'Keep a card that can capture your declaration.';
  return null;
}
function isFlexible(item: TableItem, seat: Seat): boolean {
  return !isDeclaration(item) || (!item.group && item.owner !== seat);
}
function declarationGroup(
  items: readonly TableItem[],
  played: number,
  value: number,
  seat: Seat,
): boolean | null {
  const total = totalOf(items.map((item) => item.value)) + played;
  if (total === value)
    return items.every((item) => !item.group && item.owner !== seat)
      ? false
      : null;
  // Items already worth the value are components as they stand; the rest,
  // with the played card, must make further components of that same value.
  const moved = items.filter((item) => item.value !== value);
  if (!moved.every((item) => isFlexible(item, seat))) return null;
  return splitsInto([...moved.map((item) => item.value), played], value)
    ? true
    : null;
}
/** The resulting group flag, or the reason this declaration is illegal. */
export function declaration(
  table: readonly TableItem[],
  hand: readonly Card[],
  seat: Seat,
  card: Card,
  ids: readonly string[],
  value: number,
): { group: boolean } | { problem: string } {
  const items = selectedItems(table, ids);
  if (!items) return { problem: 'The selection does not match the table.' };
  if (!items.length) return { problem: 'Choose what to declare.' };
  const played = cardValue(card);
  if (played > 10 || value < 1 || value > MAX_DECLARED_VALUE)
    return { problem: 'Declarations use numerals and total at most 10.' };
  if (items.some((item) => item.value > 10))
    return { problem: 'Court cards cannot be declared.' };
  if (!keepsCaptureCard(hand, card, value))
    return { problem: 'Keep a card that can capture the declaration.' };
  const own = ownDeclaration(table, seat);
  if (own && !items.includes(own))
    return { problem: 'Resolve your declaration before starting another.' };
  const group = declarationGroup(items, played, value, seat);
  if (group === null)
    return { problem: 'That selection does not make this declaration.' };
  return { group };
}

interface Search {
  steps: number;
  complete: boolean;
}
/** Index sets of `pool` summing to `total`. Values are positive, so depth stays small. */
function sumsTo(
  pool: readonly TableItem[],
  total: number,
  search: Search,
): bigint[] {
  const found: bigint[] = [];
  const visit = (start: number, gap: number, mask: bigint): void => {
    if (gap === 0) {
      found.push(mask);
      return;
    }
    for (let index = start; index < pool.length; index++) {
      if (search.steps++ >= MAX_SEARCH_STEPS) {
        search.complete = false;
        return;
      }
      const value = pool[index]!.value;
      if (value <= gap)
        visit(index + 1, gap - value, mask | (1n << BigInt(index)));
    }
  };
  visit(0, total, 0n);
  return found;
}
/** Every union of pairwise disjoint sets, including the empty one. */
function disjointUnions(sets: readonly bigint[], search: Search): bigint[] {
  const unions = new Set<bigint>([0n]);
  for (const set of sets)
    for (const union of [...unions]) {
      if ((union & set) !== 0n) continue;
      if (unions.size >= MAX_ACTIONS_PER_CARD) {
        search.complete = false;
        return [...unions];
      }
      unions.add(union | set);
    }
  return [...unions];
}
function idsOf(pool: readonly TableItem[], mask: bigint): string[] {
  return pool
    .filter((_, index) => (mask & (1n << BigInt(index))) !== 0n)
    .map((item) => item.id);
}
function subsetsOf<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>(
    (subsets, item) => [
      ...subsets,
      ...subsets.map((subset) => [...subset, item]),
    ],
    [[]],
  );
}
function captureSelections(
  table: readonly TableItem[],
  value: number,
  search: Search,
): string[][] {
  const loose = table.filter((item) => !isDeclaration(item));
  const declared = table.filter(
    (item) => isDeclaration(item) && item.value === value,
  );
  const unions = disjointUnions(sumsTo(loose, value, search), search);
  return unions.flatMap((union) =>
    subsetsOf(declared.map((item) => item.id)).map((extra) => [
      ...idsOf(loose, union),
      ...extra,
    ]),
  );
}
function declarationSelections(
  table: readonly TableItem[],
  seat: Seat,
  played: number,
  value: number,
  search: Search,
): string[][] {
  const pool = table.filter(
    (item) => item.value < value && isFlexible(item, seat),
  );
  const fixed = table.filter((item) => item.value === value);
  const plainGroups = sumsTo(pool, value, search);
  const cardGroups = played > value ? [] : sumsTo(pool, value - played, search);
  const unions = disjointUnions(plainGroups, search);
  const selections = new Map<string, string[]>();
  for (const cardGroup of cardGroups)
    for (const union of unions) {
      if ((union & cardGroup) !== 0n) continue;
      const moved = idsOf(pool, union | cardGroup);
      for (const extra of subsetsOf(fixed.map((item) => item.id))) {
        const ids = [...moved, ...extra];
        selections.set([...ids].sort().join(), ids);
        if (selections.size >= MAX_ACTIONS_PER_CARD) {
          search.complete = false;
          return [...selections.values()];
        }
      }
    }
  return [...selections.values()];
}
/**
 * Legal plays by construction, each confirmed by the same predicates applyAction
 * uses. Laying and captures come first, so a legal action is always listed.
 */
export function listActions(
  table: readonly TableItem[],
  hand: readonly Card[],
  seat: Seat,
): LegalActionList {
  const actions: PlayerAction[] = [];
  let complete = true;
  for (const card of hand) {
    const listed: PlayerAction[] = [];
    const search: Search = { steps: 0, complete: true };
    const value = cardValue(card);
    if (!layProblem(table, seat, card)) listed.push({ type: 'lay', card });
    const captures =
      value > 10
        ? table.filter((item) => item.value === value).map((item) => [item.id])
        : captureSelections(table, value, search);
    for (const ids of captures)
      if (ids.length && !captureProblem(table, hand, seat, card, ids))
        listed.push({ type: 'capture', card, table: ids });
    if (value <= 10)
      for (const held of new Set(hand.map(cardValue))) {
        if (held > MAX_DECLARED_VALUE) continue;
        for (const ids of declarationSelections(
          table,
          seat,
          value,
          held,
          search,
        ))
          if ('group' in declaration(table, hand, seat, card, ids, held))
            listed.push({ type: 'declare', card, table: ids, value: held });
      }
    if (listed.length > MAX_ACTIONS_PER_CARD) {
      listed.length = MAX_ACTIONS_PER_CARD;
      search.complete = false;
    }
    actions.push(...listed);
    complete &&= search.complete;
  }
  return { actions, complete };
}
