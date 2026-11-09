import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as engine from '../dist/esm/index.js';
export { engine, assert };
export const players = ['alice', 'bob'];
export const seed = (n = 0) =>
  createHash('sha256').update(`xeri-test:${n}`).digest('hex');
export function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.state ?? result.value;
}
export function start(n = 0) {
  return ok(engine.createGame({ players, seed: seed(n) }));
}
const play = (card) => ({ type: 'play-card', card });
export function act(state, card, actor = players[state.turn]) {
  return ok(engine.applyAction(state, actor, play(card), state.revision));
}
export function step(state, card, actor = players[state.turn]) {
  const result = engine.applyAction(state, actor, play(card), state.revision);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
export function rejected(state, action, code, actor, revision) {
  const result = engine.applyAction(
    state,
    actor ?? players[state.turn],
    action,
    revision ?? state.revision,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  return result;
}
/**
 * The 52-card deck that makes `sequence` the legal order of play: odd positions
 * belong to the round's starter, even positions to its dealer, six cards a batch.
 * The dealing order is restated here rather than imported from the engine.
 */
export function deckFor(table, sequence) {
  assert.equal(table.length, 4);
  const used = new Set([...table, ...sequence]);
  assert.equal(used.size, 4 + sequence.length, 'duplicate scripted card');
  const order = [...sequence, ...engine.DECK.filter((c) => !used.has(c))];
  assert.equal(order.length, 48);
  const batches = [];
  for (let i = 0; i < 48; i += 12) {
    const batch = order.slice(i, i + 12);
    batches.push(batch.filter((_, index) => index % 2 === 0));
    batches.push(batch.filter((_, index) => index % 2 === 1));
  }
  const [first, second, ...rest] = batches;
  return [...first, ...second, ...table, ...rest.flat()];
}
export function scripted(table, sequence = [], options = {}) {
  return ok(
    engine.createAnalysisGame({
      players,
      seed: seed(),
      firstDealer: 1,
      decks: [deckFor(table, sequence)],
      ...options,
    }),
  );
}
export function sequence(state, cards) {
  for (const card of cards) state = act(state, card);
  return state;
}
/** Plays hands out in dealt order until the current round has ended. */
export function nextRound(state, actor = players[state.turn]) {
  return ok(engine.applyAction(state, actor, { type: 'next' }, state.revision));
}
export function finishRound(state) {
  if (state.phase === 'round-end') state = nextRound(state);
  const { roundNumber } = state;
  while (state.phase === 'playing' && state.roundNumber === roundNumber)
    state = act(state, state.hands[state.turn][0]);
  return state;
}
/** Independent restatement of rulebook 7.4 for one captured pile. */
export function expectedCardPoints(cards) {
  let points = 0;
  for (const card of cards) {
    const rank = card.slice(0, -1);
    if (['A', 'K', 'Q', 'J', '10'].includes(rank)) points += 1;
    if (card === '10D') points += 1;
    if (card === '2C') points += 1;
  }
  return points;
}
export function allCards(state) {
  return [
    ...state.hands.flat(),
    ...state.stock,
    ...state.table,
    ...state.captured.flat(),
  ];
}
