import {
  createGame,
  applyAction,
  getObservation,
  chooseBotAction,
} from '../dist/esm/index.js';
function unwrap(result) {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.state ?? result.value;
}
let state = unwrap(
  createGame({ players: { white: 'bot-white', black: 'bot-black' } }),
);
let randomState = 7; // server-only test RNG; NOT in the game state or observations
while (state.phase === 'playing' && state.ply < 1400) {
  const actor = state.initial.players[state.turn];
  const decision = unwrap(
    chooseBotAction(unwrap(getObservation(state, actor)), {
      strategy: 'random',
      randomState,
    }),
  );
  randomState = decision.nextRandomState;
  state = unwrap(applyAction(state, actor, decision.action, state.revision));
}
if (state.phase !== 'ended')
  throw new Error(
    'The example safety bound was reached; no result has been invented.',
  );
console.log(
  JSON.stringify({ plies: state.ply, outcome: state.matchOutcome }, null, 2),
);
