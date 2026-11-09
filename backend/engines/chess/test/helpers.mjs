import assert from 'node:assert/strict';
import * as engine from '../dist/esm/index.js';
export { engine, assert };
export const players = { white: 'alice', black: 'bob' };
export function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.state ?? result.value;
}
export function start() {
  return ok(engine.createGame({ players }));
}
export function setup(fen, movesBeforeStart) {
  return ok(
    engine.createAnalysisGame({
      players,
      fen,
      ...(movesBeforeStart ? { movesBeforeStart } : {}),
    }),
  );
}
export function move(from, to, promotion) {
  return { type: 'move', from, to, ...(promotion ? { promotion } : {}) };
}
export function play(state, action, actor = state.initial.players[state.turn]) {
  return ok(engine.applyAction(state, actor, action, state.revision));
}
export function sequence(state, coordinates) {
  for (const coordinate of coordinates)
    state = play(
      state,
      move(coordinate.slice(0, 2), coordinate.slice(2, 4), coordinate[4]),
    );
  return state;
}
export function rejected(
  state,
  action,
  code,
  actor = state.initial.players[state.turn],
  revision = state.revision,
) {
  const before = JSON.stringify(state),
    result = engine.applyAction(state, actor, action, revision);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code);
  assert.equal(
    JSON.stringify(state),
    before,
    'Rejection must not mutate state.',
  );
  return result;
}
export function moves(state, actor = state.initial.players[state.turn]) {
  return ok(engine.getLegalActions(state, actor)).filter(
    (a) => a.type === 'move',
  );
}
export function hasMove(state, coordinate) {
  return moves(state).some((m) => engine.uci(m) === coordinate);
}
export const cycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
