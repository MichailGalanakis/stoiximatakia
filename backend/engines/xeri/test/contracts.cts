import engine = require('../dist/cjs/index.js');
const created = engine.createGame({
  players: ['a', 'b'],
  seed: 'a'.repeat(64),
});
if (created.ok) {
  const result: engine.TransitionResult = engine.applyAction(
    created.state,
    'a',
    { type: 'play-card', card: 'JC' },
    0,
  );
  void result;
}
