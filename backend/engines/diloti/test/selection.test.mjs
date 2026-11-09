import { test } from 'node:test';
import {
  assert,
  engine,
  ok,
  start,
  players,
  scripted,
  act,
  declare,
  capture,
  lay,
  finishRound,
  advance,
} from './helpers.mjs';
const preview = (state, card, table = []) =>
  ok(engine.previewSelection(state, players[state.turn], { card, table }));

test('selection feedback is read-only, private and matches exact captures', () => {
  const state = scripted(['2C', '3C', '4C', '5C'], ['7H', '8H']);
  const saved = JSON.stringify(state),
    view = preview(state, '7H', ['2C', '5C']);
  assert.equal(view.capture.legal, true);
  assert.equal(view.capture.capturedCount, 3);
  assert.equal(view.capture.xeri, false);
  assert.equal(view.lay.legal, true);
  assert.equal(view.declarations.length, 10);
  assert.equal(JSON.stringify(state), saved);
  assert.equal(state.history.length, 0);
  assert.equal(state.ply, 0);
  for (const key of ['initial', 'seed', 'hands', 'stock', 'state', 'history'])
    assert.equal(Object.hasOwn(view, key), false);
  assert.ok(!JSON.stringify(view).includes(state.initial.seed));
});
test('exact declarations expose valid targets, retained-card restrictions and groups', () => {
  const state = scripted(['2C', '3C', '4C', '5C'], ['3D', '8H']);
  const p = preview(state, '3D', ['5C']);
  assert.equal(p.declarations[7].legal, true);
  assert.equal(p.declarations[7].group, false);
  assert.equal(p.declarations[8].legal, false);
  const raised = act(state, declare('3D', 8, '5C'));
  for (const card of raised.hands[raised.turn]) {
    const p = preview(raised, card, ['declaration-1']);
    for (let i = 0; i < 10; i++)
      assert.equal(
        p.declarations[i].legal,
        engine.applyAction(
          raised,
          players[raised.turn],
          declare(card, i + 1, 'declaration-1'),
        ).ok,
      );
  }
  const grouped = scripted(['2C', '6C', '4C', '8S'], ['8H', '8D']);
  const group = preview(grouped, '8H', ['2C', '6C', '8S']);
  assert.equal(group.declarations[7].legal, true);
  assert.equal(group.declarations[7].group, true);
});
test('forced courts and declaration obligations are reflected before committing', () => {
  const state = scripted(['KC', '3C', '4C', '5C'], ['KH']);
  assert.equal(preview(state, 'KH').lay.legal, false);
  assert.equal(preview(state, 'KH', ['KC']).capture.legal, true);
  const declared = act(
    scripted(['2C', '3C', '4C', '5C'], ['3D', '8H'], ['KS']),
    declare('3D', 8, '5C'),
  );
  const again = act(declared, lay('KS'));
  assert.equal(preview(again, '8H').lay.legal, false);
});
test('first-round play cannot preview a xeri; later clearing captures can', () => {
  const state = scripted(['AC', 'AD', '3C', '3D'], ['8C', '4D'], ['4C', '8S']);
  assert.equal(
    preview(state, '8C', ['AC', 'AD', '3C', '3D']).capture.xeri,
    false,
  );
  let next = act(state, capture('8C', 'AC', 'AD', '3C', '3D'));
  next = act(next, lay('4C'));
  next = act(next, lay('4D'));
  assert.equal(preview(next, '8S', ['4C', '4D']).capture.xeri, true);
});
test('previews reject strangers, hidden/unknown cards, bad selections and authority fields atomically', () => {
  const state = start(),
    actor = players[state.turn],
    card = state.hands[state.turn][0],
    saved = JSON.stringify(state);
  for (const input of [
    { card, table: ['forged'] },
    { card, table: [state.table[0].id, state.table[0].id] },
    { card, table: [], winner: 'alice' },
    { card: state.stock[0], table: [] },
    { card, table: new Array(53).fill('AC') },
  ])
    assert.equal(engine.previewSelection(state, actor, input).ok, false);
  assert.equal(
    engine.previewSelection(state, 'stranger', { card, table: [] }).ok,
    false,
  );
  assert.equal(
    engine.previewSelection(state, players[1 - state.turn], {
      card: state.hands[1 - state.turn][0],
      table: [],
    }).ok,
    false,
  );
  assert.equal(JSON.stringify(state), saved);
  const round = finishRound(start());
  assert.equal(
    engine.previewSelection(round, actor, { card, table: [] }).ok,
    false,
  );
});
test('previewed actions agree with accepted actions for many exact selections across real turns', () => {
  let state = start(5);
  for (let i = 0; i < 35 && state.phase === 'playing'; i++) {
    const actor = players[state.turn],
      card = state.hands[state.turn][0];
    for (const ids of [
      [],
      state.table.slice(0, 1).map((i) => i.id),
      state.table.slice(0, 3).map((i) => i.id),
    ]) {
      const p = preview(state, card, ids);
      assert.equal(p.lay.legal, engine.applyAction(state, actor, lay(card)).ok);
      const result = engine.applyAction(state, actor, capture(card, ...ids));
      assert.equal(p.capture.legal, result.ok);
      if (result.ok) {
        assert.equal(
          p.capture.capturedCount,
          result.state.lastPlay.capturedCount,
        );
        assert.equal(p.capture.xeri, result.state.lastPlay.xeri);
      }
      for (let v = 1; v <= 10; v++)
        assert.equal(
          p.declarations[v - 1].legal,
          engine.applyAction(state, actor, declare(card, v, ...ids)).ok,
        );
    }
    state = advance(state);
  }
});

test('exact selection checks accept a legal capture omitted by the capped suggestions', () => {
  let state = start(0);
  for (let i = 0; i < 14; i++) state = advance(state);
  const list = ok(engine.getLegalActions(state, players[state.turn]));
  assert.equal(list.complete, false);
  const table = ['2S', '3C', '6S', '7C', '8D', '9D', 'AD'];
  assert.equal(
    list.actions.some(
      (a) =>
        a.type === 'capture' &&
        a.card === '9S' &&
        [...a.table].sort().join() === table.join(),
    ),
    false,
  );
  const saved = JSON.stringify(state),
    p = preview(state, '9S', table);
  assert.equal(p.capture.legal, true);
  assert.equal(p.capture.capturedCount, 8);
  assert.equal(
    engine.applyAction(state, players[state.turn], capture('9S', ...table)).ok,
    true,
  );
  assert.equal(JSON.stringify(state), saved);
});
