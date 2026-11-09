import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as engine from '../dist/esm/index.js';
export { engine, assert };
export const players = ['alice', 'bob'];
export const seed = (n = 0) =>
  createHash('sha256').update(`diloti-test:${n}`).digest('hex');
export function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.state ?? result.value;
}
export function start(n = 0) {
  return ok(engine.createGame({ players, seed: seed(n) }));
}
export const lay = (card) => ({ type: 'lay', card });
export const capture = (card, ...table) => ({ type: 'capture', card, table });
export const declare = (card, value, ...table) => ({
  type: 'declare',
  card,
  table,
  value,
});
export function act(state, action, actor = players[state.turn]) {
  return ok(engine.applyAction(state, actor, action, state.revision));
}
export function rejected(state, action, code, actor) {
  const result = engine.applyAction(
    state,
    actor ?? players[state.turn],
    action,
    state.revision,
  );
  assert.equal(result.ok, false, `accepted ${JSON.stringify(action)}`);
  assert.equal(result.error.code, code, result.error.message);
  return result;
}
/**
 * The 52-card deck that deals these cards: the starter's six, the dealer's six,
 * the layout, then the stock. Unnamed slots fill from the unused cards in deck
 * order. The dealing order is restated here rather than imported from the engine.
 */
export function deckFor(layout, starter = [], dealer = [], rest = []) {
  const used = new Set([...layout, ...starter, ...dealer, ...rest]);
  assert.equal(
    used.size,
    layout.length + starter.length + dealer.length + rest.length,
    'duplicate scripted card',
  );
  // Courts fill empty hand slots first: they add no numeral capture card.
  const isCourt = (card) => engine.cardValue(card) > 10;
  const unused = engine.DECK.filter((card) => !used.has(card));
  const spare = [
    ...unused.filter(isCourt),
    ...unused.filter((c) => !isCourt(c)),
  ];
  const fill = (cards, size) => [
    ...cards,
    ...spare.splice(0, size - cards.length),
  ];
  const hands = [...fill(starter, 6), ...fill(dealer, 6)];
  return [...hands, ...layout, ...rest, ...spare];
}
/** `alice` (seat 0) starts because `bob` (seat 1) deals. */
export function scripted(layout, starter = [], dealer = [], options = {}) {
  return ok(
    engine.createAnalysisGame({
      players,
      seed: seed(),
      firstDealer: 1,
      decks: [deckFor(layout, starter, dealer)],
      ...options,
    }),
  );
}
export function sequence(state, actions) {
  for (const action of actions) state = act(state, action);
  return state;
}
export function firstLegal(state) {
  return ok(engine.getLegalActions(state, players[state.turn])).actions[0];
}
/** Lays the first card when allowed, otherwise plays the first listed legal action. */
export function advance(state) {
  const player = players[state.turn];
  const laid = engine.applyAction(
    state,
    player,
    lay(state.hands[state.turn][0]),
  );
  return laid.ok ? laid.state : act(state, firstLegal(state));
}
export function nextRound(state, actor = players[state.turn]) {
  return ok(engine.applyAction(state, actor, { type: 'next' }, state.revision));
}
export function finishRound(state) {
  if (state.phase === 'round-end') state = nextRound(state);
  const { roundNumber } = state;
  while (state.phase === 'playing' && state.roundNumber === roundNumber)
    state = advance(state);
  return state;
}
/** Independent restatement of rulebook 6.5 for one captured pile. */
export function expectedCardPoints(cards) {
  let points = 0;
  for (const card of cards) {
    if (card.startsWith('A')) points += 1;
    if (card === '10D') points += 2;
    if (card === '2C') points += 1;
  }
  return points;
}
export function allCards(state) {
  return [
    ...state.hands.flat(),
    ...state.stock,
    ...state.table.flatMap((item) => item.cards),
    ...state.captured.flat(),
  ];
}
export const tableIds = (state) => state.table.map((item) => item.id);
export const declarationOf = (state) =>
  state.table.find((item) => item.cards.length > 1);
