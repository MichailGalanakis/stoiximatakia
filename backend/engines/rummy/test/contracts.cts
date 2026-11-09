import engine = require('../dist/cjs/index.js');
const created = engine.createGame({
  game: 'thanasis',
  players: ['a', 'b'],
  seed: 'a'.repeat(64),
});
if (created.ok) {
  const result: engine.TransitionResult = engine.applyAction(
    created.state,
    'a',
    { type: 'draw', source: 'stock' },
    0,
  );
  void result;
}
