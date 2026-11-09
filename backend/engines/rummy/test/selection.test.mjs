import test from 'node:test';
import { engine, assert, ok, start, scripted, act } from './helpers.mjs';
const player = (s) => s.initial.players[s.turn];
const preview = (s, selection, actor = player(s)) =>
  ok(engine.previewSelection(s, actor, selection));
const draw = (s) => act(s, { type: 'draw', source: 'stock' });

test('selection feedback binds phase, player, distinct own cards and current melds', () => {
  const root = start('koumkan'),
    s = draw(root),
    mine = player(s);
  const saved = JSON.stringify(s);
  for (const [state, actor, selection] of [
    [root, player(root), { cards: [] }],
    [s, 'stranger', { cards: [] }],
    [s, s.initial.players[1 - s.turn], { cards: [] }],
    [s, mine, { cards: [s.hands[1 - s.turn][0]] }],
    [s, mine, { cards: [s.hands[s.turn][0], s.hands[s.turn][0]] }],
    [s, mine, { cards: [], meld: 'missing' }],
    [s, mine, { cards: [], winnerId: mine }],
    [s, mine, { cards: new Array(109).fill('AC-0') }],
  ])
    assert.equal(engine.previewSelection(state, actor, selection).ok, false);
  assert.equal(JSON.stringify(s), saved);
});
test('exact Joker readings remain selectable and feedback is read-only and private', () => {
  const s = draw(
    scripted('koumkan', {
      hands: [['3C-0', '4C-0', 'JOKER-0', '5C-0'], ['KS-0']],
      indicator: 'KD-0',
      stock: ['8S-0'],
    }),
  );
  const selection = { cards: ['3C-0', '4C-0', 'JOKER-0'] },
    saved = JSON.stringify(s);
  const p = preview(s, selection);
  assert.deepEqual(p.selection, selection);
  assert.ok(p.options.length > 1);
  assert.ok(p.options.every((o) => o.legal));
  assert.equal(p.discard, false);
  assert.equal(p.replace, false);
  for (const o of p.options) {
    assert.equal(
      engine.applyAction(s, player(s), {
        type: 'meld',
        cards: selection.cards,
        option: o.option,
      }).ok,
      o.legal,
    );
    assert.equal(Object.isFrozen(o.slots), true);
  }
  assert.equal(JSON.stringify(s), saved);
  assert.equal(JSON.stringify(p).includes(s.initial.seed), false);
  for (const key of ['state', 'hand', 'stock', 'history', 'turnDrawn'])
    assert.equal(Object.hasOwn(p, key), false);
});
test('Joker replacement requires the exact natural card and an opened hand', () => {
  let s = draw(
    scripted('koumkan', {
      hands: [['3C-0', '4C-0', 'JOKER-0', '5C-0', '5D-0'], ['KS-0']],
      indicator: 'KD-0',
      stock: ['8S-0'],
    }),
  );
  const cards = ['3C-0', '4C-0', 'JOKER-0'];
  const chosen = preview(s, { cards }).options.find((o) =>
    o.slots.some((slot) => slot.card === 'JOKER-0' && slot.rank === 5),
  );
  assert.ok(chosen);
  s = act(s, { type: 'meld', cards, option: chosen.option });
  const meld = s.melds[0].id;
  assert.equal(preview(s, { cards: ['5C-0'], meld }).replace, true);
  assert.equal(preview(s, { cards: ['5D-0'], meld }).replace, false);
  const accepted = act(s, { type: 'replace', card: '5C-0', meld });
  assert.ok(accepted.hands[accepted.turn].includes('JOKER-0'));
});
test('an opponent meld cannot be extended before opening, then can be extended', () => {
  let s = scripted('koumkan', {
    hands: [
      ['8S-0', '3C-0', '3D-0', '3H-0'],
      ['5S-0', '6S-0', '7S-0', 'KC-0'],
    ],
    indicator: 'KD-0',
    stock: ['9C-0', '10C-0', 'JC-0'],
  });
  s = draw(s);
  s = act(s, { type: 'discard', card: '9C-0' });
  s = draw(s);
  s = act(s, { type: 'meld', cards: ['5S-0', '6S-0', '7S-0'], option: 0 });
  s = act(s, { type: 'discard', card: '10C-0' });
  s = draw(s);
  const selection = { cards: ['8S-0'], meld: s.melds[0].id };
  assert.equal(preview(s, selection).options[0].legal, false);
  s = act(s, { type: 'meld', cards: ['3C-0', '3D-0', '3H-0'], option: 0 });
  assert.equal(preview(s, selection).options[0].legal, true);
  assert.equal(
    engine.applyAction(s, player(s), {
      type: 'extend',
      ...selection,
      option: 0,
    }).ok,
    true,
  );
});
test('a structurally valid meld cannot empty the hand before final discard', () => {
  const cards = [
    'AC-0',
    '2C-0',
    '3C-0',
    '4C-0',
    '5C-0',
    '6C-0',
    '7C-0',
    '8C-0',
    '9C-0',
    '10C-0',
    'JC-0',
  ];
  const s = draw(
    scripted('koumkan', {
      hands: [cards.slice(0, 10), ['KS-0']],
      indicator: 'KD-0',
      stock: ['JC-0'],
    }),
  );
  const p = preview(s, { cards });
  assert.ok(p.options.length);
  assert.ok(p.options.every((o) => !o.legal));
  assert.equal(
    engine.applyAction(s, player(s), { type: 'meld', cards, option: 0 }).ok,
    false,
  );
});
test('one-card draw feedback preserves the newly drawn card until the old card is discarded', () => {
  const cards = [
    'AC-0',
    '2C-0',
    '3C-0',
    '4C-0',
    '5C-0',
    '6C-0',
    '7C-0',
    '8C-0',
    '9C-0',
    '10C-0',
  ];
  let s = draw(
    scripted('koumkan', {
      hands: [cards, ['KS-0']],
      indicator: 'KD-0',
      stock: ['JC-0', 'QS-0', '5S-0'],
    }),
  );
  s = act(s, { type: 'meld', cards: cards.slice(0, 9), option: 0 });
  s = act(s, { type: 'discard', card: '10C-0' });
  s = draw(s);
  s = act(s, { type: 'discard', card: 'QS-0' });
  s = draw(s);
  assert.equal(preview(s, { cards: ['5S-0'] }).discard, false);
  assert.equal(preview(s, { cards: ['JC-0'] }).discard, true);
  assert.equal(
    engine.applyAction(s, player(s), { type: 'discard', card: '5S-0' }).ok,
    false,
  );
});
test('standard restored selections agree with accepted actions across both player seats', () => {
  let s = start('koumkan', 4);
  for (let turn = 0; turn < 12; turn++) {
    s = draw(s);
    const own = s.hands[s.turn],
      saved = JSON.stringify(s);
    for (const cards of [[], [own[0]], own.slice(0, 3), own.slice(1, 5)]) {
      const p = preview(JSON.parse(saved), { cards });
      for (const o of p.options)
        assert.equal(
          engine.applyAction(s, player(s), {
            type: 'meld',
            cards,
            option: o.option,
          }).ok,
          o.legal,
        );
      if (cards.length === 1)
        assert.equal(
          engine.applyAction(s, player(s), { type: 'discard', card: cards[0] })
            .ok,
          p.discard,
        );
    }
    s = act(s, { type: 'discard', card: own[0] });
  }
});
