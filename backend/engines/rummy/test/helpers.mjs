import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as engine from '../dist/esm/index.js';
export { engine, assert };
export const playersOf = (game) =>
  Array.from({ length: engine.SEATS[game] }, (_, seat) => `seat${seat}`);
export const seed = (n = 0) =>
  createHash('sha256').update(`rummy-test:${n}`).digest('hex');
export function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.state ?? result.value;
}
export function start(game, n = 0) {
  return ok(
    engine.createGame({ game, players: playersOf(game), seed: seed(n) }),
  );
}
/**
 * One complete deck, top card first, that deals exactly `hands`. Packets, the
 * indicator and `stock` follow in table order, and unnamed cards go below them.
 * The dealing order is restated here rather than imported from the engine.
 */
export function deckFor(game, { hands, indicator, stock = [], reserves = [] }) {
  const seats = engine.SEATS[game],
    size = engine.HAND_SIZE[game];
  const named = [...hands.flat(), indicator, ...stock, ...reserves.flat()];
  assert.equal(new Set(named).size, named.length, 'duplicate scripted card');
  const rest = engine.DECKS[game].filter(
    (card) => !named.includes(card) && !card.startsWith('JOKER'),
  );
  const jokers = engine.DECKS[game].filter(
    (card) => !named.includes(card) && card.startsWith('JOKER'),
  );
  const take = () => {
    const card = rest.shift();
    assert.ok(card, 'ran out of filler cards');
    return card;
  };
  const dealt = Array.from({ length: seats }, (_, seat) => {
    const hand = [...(hands[seat] ?? [])];
    while (hand.length < size) hand.push(take());
    return hand;
  });
  const packets =
    game === 'biriba'
      ? [0, 1].map((packet) => {
          const cards = [...(reserves[packet] ?? [])];
          while (cards.length < engine.RESERVE_SIZE) cards.push(take());
          return cards;
        })
      : [];
  const order = [];
  for (let index = 0; index < size; index++)
    for (let seat = 0; seat < seats; seat++) order.push(dealt[seat][index]);
  const deck = [
    ...packets.flat(),
    ...order,
    indicator,
    ...stock,
    ...rest,
    ...jokers,
  ];
  assert.equal(deck.length, engine.DECKS[game].length);
  return deck;
}
export function scripted(game, layout, options = {}) {
  return ok(
    engine.createAnalysisGame({
      game,
      players: playersOf(game),
      seed: seed(),
      firstStarter: 0,
      decks: [deckFor(game, layout)],
      ...options,
    }),
  );
}
export function act(state, action, actor) {
  const id = actor ?? state.initial.players[state.turn];
  return ok(engine.applyAction(state, id, action, state.revision));
}
export function step(state, action, actor) {
  const id = actor ?? state.initial.players[state.turn];
  const result = engine.applyAction(state, id, action, state.revision);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
export function rejected(state, action, code, actor) {
  const id = actor ?? state.initial.players[state.turn];
  const result = engine.applyAction(state, id, action, state.revision);
  assert.equal(result.ok, false, JSON.stringify(action));
  assert.equal(result.error.code, code, result.error.message);
  return result.error;
}
export const stockDraw = { type: 'draw', source: 'stock' };
export const pileDraw = { type: 'draw', source: 'discard' };
export const meld = (cards, option = 0) => ({ type: 'meld', cards, option });
export const extend = (meldId, cards, option = 0) => ({
  type: 'extend',
  meld: meldId,
  cards,
  option,
});
export const discard = (card) => ({ type: 'discard', card });
export const close = (card) => ({ type: 'close', card });
export const replace = (meldId, card) => ({
  type: 'replace',
  meld: meldId,
  card,
});
/** A turn that only draws from the stock and discards `card`, or the drawn card. */
export function pass(state, card) {
  const drawn = act(state, stockDraw);
  return act(drawn, discard(card ?? drawn.hands[drawn.turn].at(-1)));
}
export function allCards(state) {
  return [
    ...state.hands.flat(),
    ...state.stock,
    ...state.discard,
    ...state.reserves.flat(),
    ...state.melds.flatMap((item) => item.slots.map((slot) => slot.card)),
  ];
}
export function legal(state, seat = state.turn) {
  return ok(engine.getLegalActions(state, state.initial.players[seat]));
}
/** Plays random legal actions until `done` holds, checking the invariants at each step. */
export function playOut(state, randomState, done, check = () => {}) {
  let random = randomState;
  while (!done(state) && state.phase !== 'ended') {
    const id = state.initial.players[state.turn];
    const view = ok(engine.getObservation(state, id));
    assert.ok(view.legalActions.length > 0, 'the player must have a move');
    const decision = ok(
      engine.chooseBotAction(view, { strategy: 'random', randomState: random }),
    );
    random = decision.nextRandomState;
    const before = state;
    const result = step(state, decision.action, id);
    state = result.state;
    check(state, before, result.events, decision.action);
  }
  return state;
}
