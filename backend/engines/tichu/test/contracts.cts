import engine = require('../dist/cjs/index.js');
const created = engine.createGame({
  players: ['a', 'b', 'c', 'd'],
  seed: 'a'.repeat(64),
  format: '1000',
});
if (created.ok) {
  const result: engine.TransitionResult = engine.applyAction(
    created.state,
    'a',
    { type: 'grand', call: true },
    0,
  );
  void result;
}
