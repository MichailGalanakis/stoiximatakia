import { createHash } from 'node:crypto';
import type { Card, GameId, Rank, Suit } from './types.js';

export const SUITS: readonly Suit[] = ['C', 'D', 'H', 'S'];
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
function packs(copies: number, jokers: number): Card[] {
  const cards: string[] = [];
  for (let copy = 0; copy < copies; copy++)
    for (const suit of SUITS)
      for (const rank of RANKS) cards.push(`${rank}${suit}-${copy}`);
  for (let joker = 0; joker < jokers; joker++) cards.push(`JOKER-${joker}`);
  return cards as Card[];
}
export const DECKS: Readonly<Record<GameId, readonly Card[]>> = Object.freeze({
  koumkan: Object.freeze(packs(2, 2)),
  thanasis: Object.freeze(packs(1, 0)),
  biriba: Object.freeze(packs(2, 4)),
});
interface Face {
  readonly rank: number;
  readonly suit: Suit | null;
  readonly order: number;
}
const FACES: ReadonlyMap<string, Face> = new Map(
  DECKS.biriba.map((card, order) => {
    const name = card.split('-')[0]!;
    return [
      card,
      name === 'JOKER'
        ? { rank: 0, suit: null, order }
        : {
            rank: RANKS.indexOf(name.slice(0, -1) as Rank) + 1,
            suit: name.slice(-1) as Suit,
            order,
          },
    ];
  }),
);
export function isCard(value: unknown): value is Card {
  return typeof value === 'string' && FACES.has(value);
}
/** 1 for an Ace through 13 for a King, and 0 for a Joker. */
export function rankOf(card: Card): number {
  return FACES.get(card)!.rank;
}
/** Null for a Joker. */
export function suitOf(card: Card): Suit | null {
  return FACES.get(card)!.suit;
}
export function byDeckOrder(a: Card, b: Card): number {
  return FACES.get(a)!.order - FACES.get(b)!.order;
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
