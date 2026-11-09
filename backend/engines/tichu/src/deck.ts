import { createHash } from 'node:crypto';
import type { Card, Rank, Special, Suit } from './types.js';

const SUITS: readonly Suit[] = ['C', 'D', 'H', 'S'];
const RANKS: readonly Rank[] = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
  'A',
];
const SPECIALS: readonly Special[] = ['MAHJONG', 'DOG', 'PHOENIX', 'DRAGON'];
export const DECK: readonly Card[] = Object.freeze([
  ...SUITS.flatMap((suit) => RANKS.map((rank): Card => `${rank}${suit}`)),
  ...SPECIALS,
]);
const ORDER: ReadonlyMap<string, number> = new Map(
  DECK.map((card, index) => [card, index]),
);
export function isCard(value: unknown): value is Card {
  return typeof value === 'string' && ORDER.has(value);
}
export function isSpecial(card: Card): card is Special {
  return (SPECIALS as readonly string[]).includes(card);
}
/** 2 through 14 for an Ace, 1 for the Mah Jong and 0 for the other special cards. */
export function rankOf(card: Card): number {
  if (card === 'MAHJONG') return 1;
  if (isSpecial(card)) return 0;
  return RANKS.indexOf(card.slice(0, -1) as Rank) + 2;
}
/** Null for a special card. */
export function suitOf(card: Card): Suit | null {
  return isSpecial(card) ? null : (card.slice(-1) as Suit);
}
export function byDeckOrder(a: Card, b: Card): number {
  return ORDER.get(a)! - ORDER.get(b)!;
}
export interface RandomStream {
  below(limit: number): number;
}
/**
 * SHA-256 in counter mode, keyed by the secret game seed. Deterministic so replay
 * reproduces every deal, and unpredictable without the seed, unlike the bot RNG.
 */
export function randomStream(seed: string, label: string): RandomStream {
  let block = Buffer.alloc(0),
    offset = 0,
    counter = 0;
  const next = (): number => {
    if (offset === block.length) {
      block = createHash('sha256')
        .update(`${seed}:${label}:${counter++}`)
        .digest();
      offset = 0;
    }
    const value = block.readUInt32BE(offset);
    offset += 4;
    return value;
  };
  return {
    below(limit) {
      // Rejection sampling keeps every result equally likely.
      const ceiling = 2 ** 32 - (2 ** 32 % limit);
      let value = next();
      while (value >= ceiling) value = next();
      return value % limit;
    },
  };
}
export function shuffled<T>(items: readonly T[], stream: RandomStream): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = stream.below(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
