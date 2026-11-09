import {
  createGame,
  applyAction,
  getObservation,
  chooseBotAction,
  type PlayerAction,
  type XeriState,
} from '../dist/esm/index.js';
const seed = 'a'.repeat(64);
const created = createGame({ players: ['alice', 'bob'], seed });
const action: PlayerAction = { type: 'play-card', card: '10D' };
if (created.ok) {
  const state: XeriState = created.state;
  const moved = applyAction(state, 'alice', action, state.revision);
  if (moved.ok) {
    const view = getObservation(moved.state, 'bob');
    if (view.ok)
      chooseBotAction(view.value, { strategy: 'random', randomState: 42 });
  }
  // @ts-expect-error State snapshots are readonly.
  state.turn = 1;
}
// @ts-expect-error Players are listed by seat, exactly two.
createGame({ players: ['alice'], seed });
// @ts-expect-error A game needs its secret seed.
createGame({ players: ['alice', 'bob'] });
// @ts-expect-error Clocks are deliberately outside this game package.
createGame({ players: ['alice', 'bob'], seed, clock: '5+3' });
// @ts-expect-error Cards use a known rank and suit.
const unknown: PlayerAction = { type: 'play-card', card: '11D' };
void unknown;
