import {
  createGame,
  applyAction,
  getObservation,
  chooseBotAction,
  type PlayerAction,
  type RummyState,
} from '../dist/esm/index.js';
const seed = 'a'.repeat(64);
const created = createGame({
  game: 'koumkan',
  players: ['alice', 'bob'],
  seed,
});
const action: PlayerAction = { type: 'discard', card: '10D-1' };
if (created.ok) {
  const state: RummyState = created.state;
  const moved = applyAction(state, 'alice', action, state.revision);
  if (moved.ok) {
    const view = getObservation(moved.state, 'bob');
    if (view.ok)
      chooseBotAction(view.value, { strategy: 'random', randomState: 42 });
  }
  // @ts-expect-error State snapshots are readonly.
  state.turn = 1;
}
// @ts-expect-error Only the three rummy games are known.
createGame({ game: 'xeri', players: ['alice', 'bob'], seed });
// @ts-expect-error A game needs its secret seed.
createGame({ game: 'biriba', players: ['alice', 'bob', 'carol', 'dan'] });
// @ts-expect-error Clocks are deliberately outside this game package.
createGame({ game: 'thanasis', players: ['alice', 'bob'], seed, clock: '5+3' });
// @ts-expect-error Cards name their copy.
const unknown: PlayerAction = { type: 'discard', card: '10D' };
void unknown;
