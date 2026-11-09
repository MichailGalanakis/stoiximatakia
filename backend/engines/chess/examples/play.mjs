import {
  createGame,
  applyAction,
  getObservation,
  serializeState,
  restoreState,
} from '../dist/esm/index.js';
function unwrap(result) {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.state ?? result.value;
}
let state = unwrap(createGame({ players: { white: 'alice', black: 'bob' } }));
const notation = [];
for (const [from, to] of [
  ['f2', 'f3'],
  ['e7', 'e5'],
  ['g2', 'g4'],
  ['d8', 'h4'],
]) {
  // In a real backend, load state from SERVER persistence, and derive this actor
  // from authentication, never from an untrusted browser-supplied playerId.
  const authenticatedPlayerId = state.initial.players[state.turn];
  const result = applyAction(
    state,
    authenticatedPlayerId,
    { type: 'move', from, to },
    state.revision,
  );
  state = unwrap(result);
  notation.push(
    result.events.find((event) => event.type === 'move-played').san,
  );
  // The snapshot retains position history, counters and rules/schema versions.
  state = unwrap(restoreState(unwrap(serializeState(state))));
}
const publicView = unwrap(getObservation(state, 'alice'));
console.log(
  JSON.stringify(
    {
      moves: notation,
      roundOutcome: publicView.roundOutcome,
      matchOutcome: publicView.matchOutcome,
    },
    null,
    2,
  ),
);
