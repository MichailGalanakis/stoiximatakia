import test from 'node:test';
import {
  assert,
  engine,
  playing,
  act,
  play,
  pass,
  ok,
  players,
} from './helpers.mjs';
function window() {
  let s = playing([['MAHJONG', '3C'], [], ['9C', '9D', '9H', '9S'], []]);
  s = act(s, 0, play(['3C']));
  for (const seat of [1, 2, 3]) s = act(s, seat, pass);
  return s;
}
test('every remaining seat responds to the same window independently of hidden bombs', () => {
  const s = window();
  assert.equal(s.phase, 'bomb-window');
  assert.deepEqual(s.windowPending, [0, 1, 2, 3]);
  for (let seat = 0; seat < 4; seat++) {
    const v = ok(engine.getObservation(s, players[seat]));
    assert.equal(v.yourMove, true);
    assert.ok(v.legalActions.some((a) => a.type === 'continue'));
    assert.ok(!('windowPending' in v));
  }
  let next = act(s, 1, { type: 'continue' });
  assert.equal(next.phase, 'bomb-window');
  for (const seat of [0, 3, 2]) next = act(next, seat, { type: 'continue' });
  assert.equal(next.phase, 'play');
  assert.equal(next.top, null);
  assert.equal(next.turn, 0);
});
test('a response cannot be repeated, and a legal bomb reopens normal play', () => {
  let s = act(window(), 1, { type: 'continue' });
  assert.equal(
    engine.applyAction(s, players[1], { type: 'continue' }).ok,
    false,
  );
  s = act(s, 2, play(['9C', '9D', '9H', '9S']));
  assert.equal(s.phase, 'play');
  assert.deepEqual(s.windowPending, []);
  assert.equal(s.top.player, 2);
});

test('exact selection checks private ownership, wishes and out-of-turn bombs without mutation', () => {
  const s = playing([['MAHJONG', '3C'], [], ['9C', '9D', '9H', '9S'], []]),
    before = JSON.stringify(s);
  const preview = ok(
    engine.previewSelection(s, players[0], { cards: ['MAHJONG'], wish: 7 }),
  );
  assert.ok(preview.options.some((p) => p.legal));
  assert.equal(
    engine.previewSelection(s, players[0], { cards: ['MAHJONG'] }).ok,
    false,
  );
  assert.equal(
    engine.previewSelection(s, players[0], { cards: ['9C'] }).ok,
    false,
  );
  const onTable = act(s, 0, play(['3C']));
  const bomb = ok(
    engine.previewSelection(onTable, players[2], {
      cards: ['9C', '9D', '9H', '9S'],
    }),
  );
  assert.ok(bomb.options.some((p) => p.legal));
  const normal = ok(
    engine.previewSelection(onTable, players[2], { cards: ['9C'] }),
  );
  assert.ok(normal.options.every((p) => !p.legal));
  assert.equal(JSON.stringify(s), before);
});
test('the old bomb-window contract cannot be silently restored as v2', () => {
  const s = structuredClone(window());
  s.schemaVersion = 1;
  s.engineVersion = '0.1.0';
  s.rulesVersion = 'skillbetting.tichu.nanking-four-player.v1';
  const result = engine.restoreState(s);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNSUPPORTED_VERSION');
});

test('exact Phoenix selections retain their original reading index after weaker readings are filtered', () => {
  let s = playing([
    ['MAHJONG', '2C', '3D', '4H', '5S', '6C'],
    ['3C', '4D', '5H', '6S', 'PHOENIX'],
  ]);
  s = act(s, 0, play(['2C', '3D', '4H', '5S', '6C']));
  const before = JSON.stringify(s),
    p = ok(
      engine.previewSelection(s, players[1], {
        cards: ['3C', '4D', '5H', '6S', 'PHOENIX'],
      }),
    );
  assert.deepEqual(
    p.options.map((o) => [o.option, o.value, o.legal]),
    [[1, 7, true]],
  );
  assert.equal(JSON.stringify(s), before);
});
