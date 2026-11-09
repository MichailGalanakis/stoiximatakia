import { createHash } from 'node:crypto';
import type { Card, Rank, Suit } from './types.js';

const SUITS: readonly Suit[] = ['C', 'D', 'H', 'S'];
const RANKS: readonly Rank[] = [
  'A',
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
];
export const DECK: readonly Card[] = Object.freeze(
  SUITS.flatMap((suit) => RANKS.map((rank): Card => `${rank}${suit}`)),
);
const KNOWN_CARDS: ReadonlySet<string> = new Set(DECK);
export function isCard(value: unknown): value is Card {
  return typeof value === 'string' && KNOWN_CARDS.has(value);
}
export function rankOf(card: Card): Rank {
  return card.slice(0, -1) as Rank;
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
