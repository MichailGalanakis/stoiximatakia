import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { movesFor } from '../dist/esm/combos.js';
import * as engine from '../dist/esm/index.js';
export { engine, assert };
export const players = ['north', 'east', 'south', 'west'];
export const seed = (n = 0) =>
  createHash('sha256').update(`tichu-test:${n}`).digest('hex');
export function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.state ?? result.value;
}
export function start(n = 0, format = 'single') {
  return ok(engine.createGame({ players, seed: seed(n), format }));
}
function dealRest(hands, shift) {
  const out = [0, 1, 2, 3].map((seat) => [...(hands[seat] ?? [])]);
  const named = new Set(out.flat());
  assert.equal(named.size, out.flat().length, 'duplicate scripted card');
  const order = (card) =>
    engine.rankOf(card) * 4 +
    ((engine.DECK.indexOf(card) + shift * engine.rankOf(card)) % 4);
  const rest = engine.DECK.filter((card) => !named.has(card)).sort(
    (a, b) => order(a) - order(b),
  );
  rest.forEach((card, index) => {
    const rank = engine.rankOf(card);
    const sameRank = (seat) =>
      out[seat].filter((held) => engine.rankOf(held) === rank).length;
    const [seat] = [0, 1, 2, 3]
      .map((offset) => (index + rank + offset) % 4)
      .filter((item) => out[item].length < 14)
      .sort(
        (a, b) => sameRank(a) - sameRank(b) || out[a].length - out[b].length,
      );
    out[seat].push(card);
  });
  return out;
}
/** Completes partial hands to fourteen cards each, without adding any bomb. */
export function filled(hands) {
  for (let shift = 0; shift < 500; shift++) {
    const out = dealRest(hands, shift);
    const clean = out.every((hand, seat) =>
      movesFor(hand, null).every(
        (move) =>
          !move.combo.bomb ||
          move.cards.every((card) => hands[seat]?.includes(card)),
      ),
    );
    if (clean) return out;
  }
  return assert.fail('no deal without an extra bomb');
}
/** The deck that deals these fourteen-card hands, restating the dealing order. */
export function deckOf(hands) {
  const deck = [];
  for (let index = 0; index < 14; index++)
    for (let seat = 0; seat < 4; seat++) deck.push(hands[seat][index]);
  return deck;
}
export function scripted(hands, options = {}) {
  return ok(
    engine.createAnalysisGame({
      players,
      seed: seed(),
      format: 'single',
      decks: [deckOf(hands)],
      ...options,
    }),
  );
}
export function step(state, seat, action) {
  const result = engine.applyAction(
    state,
    players[seat],
    action,
    state.revision,
  );
  assert.equal(result.ok, true, JSON.stringify([action, result]));
  return result;
}
export function act(state, seat, action) {
  return step(state, seat, action).state;
}
export function rejected(state, seat, action, code) {
  const result = engine.applyAction(
    state,
    players[seat],
    action,
    state.revision,
  );
  assert.equal(result.ok, false, JSON.stringify(action));
  assert.equal(result.error.code, code, result.error.message);
  return result.error;
}
export const noGrand = { type: 'grand', call: false };
export const pass = { type: 'pass' };
export const play = (cards, extra = {}) => ({
  type: 'play',
  cards,
  option: 0,
  ...extra,
});
export const single = (card) => play([card]);
export function allGrandsPass(state) {
  return [0, 1, 2, 3].reduce(
    (current, seat) => act(current, seat, noGrand),
    state,
  );
}
/**
 * A game at the first lead, holding exactly `hands`. Each seat's last three cards
 * arrive in the exchange, so the deal puts those with the seats that give them.
 */
export function playing(partial, options = {}) {
  const final = filled(partial);
  const given = [0, 1, 2, 3].map((seat) => [
    final[(seat + 1) % 4][11],
    final[(seat + 2) % 4][12],
    final[(seat + 3) % 4][13],
  ]);
  const dealt = final.map((hand, seat) => [
    ...hand.slice(0, 11),
    ...given[seat],
  ]);
  let state = allGrandsPass(scripted(dealt, options));
  for (let seat = 0; seat < 4; seat++)
    state = act(state, seat, { type: 'exchange', cards: given[seat] });
  return state;
}
const rotation = {
  1: ['H', 'S', 'D'],
  2: ['S', 'D', 'H'],
  3: ['D', 'H', 'S'],
};
const RANKS = [
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
/** A whole mixed-suit straight, 2 to Ace, so no seat holds a bomb. */
export const rotated = (seat) =>
  RANKS.map((rank, index) => `${rank}${rotation[seat][index % 3]}`);
export const clubs = RANKS.map((rank) => `${rank}C`);
/** Seat 0 can go straight out; the others hold a straight and one special card. */
export function straightDeal(extras, options) {
  return playing(
    [
      ['MAHJONG', ...clubs],
      [...rotated(1), extras[0]],
      [...rotated(2), extras[1]],
      [...rotated(3), extras[2]],
    ],
    options,
  );
}
export function nextMover(state) {
  for (const id of players)
    if (ok(engine.getObservation(state, id)).yourMove) return id;
  return null;
}
/** Plays random legal actions until `done` holds, checking the invariants at each step. */
export function playOut(state, randomState, done, check = () => {}) {
  let random = randomState;
  while (!done(state) && state.phase !== 'ended') {
    const id = nextMover(state);
    assert.ok(id, `nothing waits for a move in ${state.phase}`);
    const view = ok(engine.getObservation(state, id));
    assert.ok(view.legalActions.length > 0, 'the player must have a move');
    const decision = ok(
      engine.chooseBotAction(view, { strategy: 'random', randomState: random }),
    );
    random = decision.nextRandomState;
    const before = state;
    const result = engine.applyAction(
      state,
      id,
      decision.action,
      state.revision,
    );
    assert.equal(result.ok, true, JSON.stringify([decision.action, result]));
    state = result.state;
    check(state, before, result.events, decision.action);
  }
  return state;
}
export function allCards(state) {
  return [
    ...state.hands.flat(),
    ...state.stock,
    ...state.pile,
    ...state.captured.flat(),
  ];
}
