import {
  createGame,
  applyAction,
  getObservation,
  chooseBotAction,
  type PlayerAction,
  type TichuState,
} from '../dist/esm/index.js';
const seed = 'a'.repeat(64);
const players = ['north', 'east', 'south', 'west'];
const created = createGame({ players, seed, format: 'single' });
const action: PlayerAction = { type: 'grand', call: false };
if (created.ok) {
  const state: TichuState = created.state;
  const moved = applyAction(state, 'north', action, state.revision);
  if (moved.ok) {
    const view = getObservation(moved.state, 'east');
    if (view.ok)
      chooseBotAction(view.value, { strategy: 'random', randomState: 42 });
  }
  // @ts-expect-error State snapshots are readonly.
  state.turn = 1;
}
// @ts-expect-error A format comes from the table catalog.
createGame({ players, seed, format: '750' });
// @ts-expect-error A game needs its secret seed.
createGame({ players, format: '500' });
// @ts-expect-error Clocks are deliberately outside this game package.
createGame({ players, seed, format: '1000', clock: '5+3' });
// @ts-expect-error Cards use a known rank and suit.
const unknown: PlayerAction = { type: 'play', cards: ['11D'], option: 0 };
void unknown;
