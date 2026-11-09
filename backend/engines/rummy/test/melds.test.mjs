import test from 'node:test';
import { extendProblem, meldProblem } from '../dist/esm/legal.js';
import { extendOptions, meldOptions } from '../dist/esm/rules.js';
import {
  act,
  assert,
  engine,
  extend,
  legal,
  meld,
  ok,
  playersOf,
  playOut,
  rejected,
  scripted,
  start,
  stockDraw,
} from './helpers.mjs';

const koum = (hand) => {
  const [first] = hand;
  const state = scripted('koumkan', {
    hands: [hand, []],
    indicator: first.startsWith('2') ? '3S-1' : '2S-1',
    stock: ['KD-1'],
  });
  return act(state, stockDraw);
};
const readings = (state, cards, id) =>
  ok(
    engine.getMeldOptions(
      state,
      state.initial.players[state.turn],
      id ? { cards, meld: id } : { cards },
    ),
  );
const shape = (option) =>
  `${option.kind} ${option.slots
    .map((slot) => `${slot.rank}${slot.suit}${slot.wild ? '*' : ''}`)
    .join(' ')}`;

test('a run needs three consecutive ranks of one suit', () => {
  const state = koum(['4C-0', '5C-0', '6C-0', '6D-0', '8C-0']);
  assert.deepEqual(readings(state, ['4C-0', '5C-0', '6C-0']).map(shape), [
    'run 4C 5C 6C',
  ]);
  assert.deepEqual(readings(state, ['4C-0', '5C-0', '6D-0']), []);
  assert.deepEqual(readings(state, ['4C-0', '5C-0', '8C-0']), []);
  assert.deepEqual(readings(state, ['4C-0', '5C-0']), []);
});
test('a set needs three or four equal ranks of different suits', () => {
  const state = koum(['7C-0', '7D-0', '7H-0', '7S-0', '7C-1']);
  assert.deepEqual(readings(state, ['7C-0', '7D-0', '7H-0']).map(shape), [
    'set 7C 7D 7H',
  ]);
  assert.deepEqual(
    readings(state, ['7C-0', '7D-0', '7H-0', '7S-0']).map(shape),
    ['set 7C 7D 7H 7S'],
  );
  assert.deepEqual(readings(state, ['7C-0', '7C-1', '7D-0']), []);
  assert.deepEqual(
    readings(state, ['7C-0', '7C-1', '7D-0', '7H-0', '7S-0']),
    [],
  );
});
test('an Ace plays low or high but never around the corner', () => {
  const state = koum(['AC-0', '2C-0', '3C-0', 'QC-0', 'KC-0']);
  assert.deepEqual(readings(state, ['AC-0', '2C-0', '3C-0']).map(shape), [
    'run 1C 2C 3C',
  ]);
  assert.deepEqual(readings(state, ['QC-0', 'KC-0', 'AC-0']).map(shape), [
    'run 12C 13C 14C',
  ]);
  assert.deepEqual(readings(state, ['KC-0', 'AC-0', '2C-0']), []);
});
test('a thirteen-card run is the longest, and an Ace sits at only one end', () => {
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const row = ['AC-0', ...ranks.map((rank) => `${rank}C-0`)];
  const table = { game: 'biriba', wildRank: null };
  const clean = meldOptions(row, table).filter(
    (option) => !option.slots.some((slot) => slot.wild),
  );
  assert.deepEqual(
    clean.map((option) => [option.slots[0].rank, option.slots.at(-1).rank]),
    [
      [1, 13],
      [2, 14],
    ],
  );
  assert.deepEqual(meldOptions([...row, 'AC-1'], table), []);
  const koum = { game: 'koumkan', wildRank: null };
  assert.deepEqual(meldOptions([...row, 'JOKER-0'], koum), []);
});
test('a Joker fills a gap or an end, and the reading can be chosen', () => {
  const state = koum(['8C-0', '9C-0', 'JOKER-0', '5H-0', '5D-0']);
  assert.deepEqual(readings(state, ['8C-0', '9C-0', 'JOKER-0']).map(shape), [
    'run 7C* 8C 9C',
    'run 8C 9C 10C*',
  ]);
  const gap = koum(['8C-0', '10C-0', 'JOKER-0', '5H-0', '5D-0']);
  assert.deepEqual(readings(gap, ['8C-0', '10C-0', 'JOKER-0']).map(shape), [
    'run 8C 9C* 10C',
  ]);
  const chosen = act(state, meld(['8C-0', '9C-0', 'JOKER-0'], 1));
  assert.deepEqual(
    chosen.melds[0].slots.map((slot) => slot.rank),
    [8, 9, 10],
  );
});
test('selection order does not change the readings', () => {
  const state = koum(['8C-0', '9C-0', 'JOKER-0', '5H-0', '5D-0']);
  assert.deepEqual(
    readings(state, ['JOKER-0', '9C-0', '8C-0']).map(shape),
    readings(state, ['8C-0', '9C-0', 'JOKER-0']).map(shape),
  );
});
test('readings list the cleanest first, with no repeats', () => {
  const state = koum(['5C-0', '6C-0', '7C-0', 'JOKER-0', 'JOKER-1']);
  const options = readings(state, ['5C-0', '6C-0', '7C-0']);
  assert.equal(options.length, 1);
  const wild = readings(state, ['5C-0', '6C-0', 'JOKER-0', 'JOKER-1']);
  assert.ok(wild.length >= 3);
  assert.equal(new Set(wild.map(shape)).size, wild.length);
  assert.deepEqual(
    wild.map((option) => option.option),
    wild.map((_, index) => index),
  );
});
test('every meld keeps at least one natural card', () => {
  const state = koum(['JOKER-0', 'JOKER-1', '5H-0', '6H-0', '9D-0']);
  assert.deepEqual(readings(state, ['JOKER-0', 'JOKER-1']), []);
  const one = readings(state, ['5H-0', 'JOKER-0', 'JOKER-1']).map(shape);
  assert.ok(one.includes('set 5H 5C* 5D*'));
  assert.ok(one.includes('run 3H* 4H* 5H'));
  assert.ok(one.includes('run 5H 6H* 7H*'));
});
test('a Joker in a set takes the first free suit', () => {
  const state = koum(['6C-0', '6H-0', 'JOKER-0', '9D-0', 'KD-0']);
  assert.deepEqual(readings(state, ['6C-0', '6H-0', 'JOKER-0']).map(shape), [
    'set 6C 6H 6D*',
  ]);
});
test('a Biriba meld is a run with at most one substitute', () => {
  const state = act(
    scripted('biriba', {
      hands: [['5C-0', '6C-0', '7C-0', 'JOKER-0', 'JOKER-1', '2H-0', '9C-0']],
      indicator: '3D-1',
    }),
    stockDraw,
  );
  assert.deepEqual(readings(state, ['5C-0', '6C-0', 'JOKER-0']).map(shape), [
    'run 4C* 5C 6C',
    'run 5C 6C 7C*',
  ]);
  assert.deepEqual(readings(state, ['5C-0', 'JOKER-0', 'JOKER-1']), []);
  assert.deepEqual(readings(state, ['5C-0', '6C-0', '2H-0']).length, 2);
});
test('Biriba has no sets', () => {
  const state = act(
    scripted('biriba', {
      hands: [['9C-0', '9D-0', '9H-0', '9S-0']],
      indicator: '3D-1',
    }),
    stockDraw,
  );
  assert.deepEqual(readings(state, ['9C-0', '9D-0', '9H-0']), []);
});
test('a natural 2 in its own place is not a substitute', () => {
  const state = act(
    scripted('biriba', {
      hands: [['AC-0', '2C-0', '3C-0', 'JOKER-0', '6C-0', '4H-0']],
      indicator: '3D-1',
    }),
    stockDraw,
  );
  assert.equal(
    readings(state, ['AC-0', '2C-0', '3C-0']).map(shape)[0],
    'run 1C 2C 3C',
  );
  const both = readings(state, ['AC-0', '2C-0', '3C-0', 'JOKER-0']).map(shape);
  assert.ok(both.includes('run 1C 2C 3C 4C*'));
  // A second substitute is out, so the Joker cannot join a 2 standing in elsewhere.
  assert.deepEqual(readings(state, ['2C-0', '3C-0', '6C-0', 'JOKER-0']), []);
});
test('a natural 2 stays natural when its run is extended', () => {
  const state = act(
    act(
      scripted('biriba', {
        hands: [['AC-0', '2C-0', '3C-0', '4C-0', 'KD-0']],
        indicator: '3D-1',
      }),
      stockDraw,
    ),
    meld(['AC-0', '2C-0', '3C-0']),
  );
  const options = readings(state, ['4C-0'], 'meld-0');
  assert.deepEqual(options.map(shape), ['run 1C 2C 3C 4C']);
});
test('a Thanasis wild-rank card can stand in or stand for itself', () => {
  const state = act(
    scripted('thanasis', {
      hands: [['7C-0', '8C-0', '7D-0', '3H-0', '4H-0']],
      indicator: '7S-0',
    }),
    stockDraw,
  );
  const self = readings(state, ['7C-0', '8C-0', '7D-0']).map(shape);
  assert.ok(self.includes('run 6C* 7C 8C'));
  assert.ok(self.includes('run 7C 8C 9C*'));
  const wild = readings(state, ['3H-0', '4H-0', '7D-0']).map(shape);
  assert.deepEqual(wild, ['run 2H* 3H 4H', 'run 3H 4H 5H*']);
});
test('getMeldOptions answers only about cards the player holds', () => {
  const state = koum(['8C-0', '9C-0', '10C-0', '5H-0', '5D-0']);
  const id = playersOf('koumkan')[state.turn];
  const missing = engine.getMeldOptions(state, id, {
    cards: ['KC-0', 'QC-0', 'JC-0'],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'ILLEGAL_MOVE');
  const twice = engine.getMeldOptions(state, id, {
    cards: ['8C-0', '8C-0', '9C-0'],
  });
  assert.equal(twice.ok, false);
  const stranger = engine.getMeldOptions(state, 'nobody', { cards: ['8C-0'] });
  assert.equal(stranger.error.code, 'UNKNOWN_PLAYER');
  const unknown = engine.getMeldOptions(state, id, {
    cards: ['8C-0', '9C-0', '10C-0'],
    meld: 'meld-9',
  });
  assert.equal(unknown.error.code, 'ILLEGAL_MOVE');
});
test('a meld action checks the chosen option', () => {
  const state = koum(['8C-0', '9C-0', 'JOKER-0', '5H-0', '5D-0']);
  rejected(state, meld(['8C-0', '9C-0', 'JOKER-0'], 2), 'ILLEGAL_MOVE');
  rejected(state, meld(['8C-0', '9C-0', 'JOKER-0'], 5000), 'INVALID_ACTION');
  rejected(state, meld(['8C-0', '8C-0', '9C-0']), 'ILLEGAL_MOVE');
});
test('every small selection agrees with the listed actions', () => {
  const state = koum([
    '6C-0',
    '7C-0',
    '8C-0',
    '6D-0',
    '6H-0',
    'JOKER-0',
    'JOKER-1',
    '9C-0',
  ]);
  const listed = legal(state);
  assert.equal(listed.complete, true);
  const melds = new Set(
    listed.actions
      .filter((action) => action.type === 'meld')
      .map((action) => JSON.stringify(action)),
  );
  const hand = state.hands[state.turn];
  const order = engine.DECKS.biriba;
  const found = new Set();
  for (let mask = 1; mask < 1 << hand.length; mask++) {
    const cards = hand
      .filter((_, index) => mask & (1 << index))
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
    for (let option = 0; option < 12; option++) {
      const result = engine.applyAction(
        state,
        state.initial.players[state.turn],
        meld(cards, option),
        state.revision,
      );
      if (result.ok) found.add(JSON.stringify(meld(cards, option)));
    }
  }
  assert.deepEqual([...found].sort(), [...melds].sort());
});
function everyPlacement(state) {
  const seat = state.turn,
    hand = state.hands[seat],
    order = engine.DECKS.biriba;
  const found = new Set();
  for (let mask = 1; mask < 1 << hand.length; mask++) {
    const cards = hand
      .filter((_, index) => mask & (1 << index))
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
    for (let option = 0; option < 40; option++) {
      if (!meldOptions(cards, state)[option]) break;
      if (!meldProblem(state, seat, cards, option))
        found.add(JSON.stringify(meld(cards, option)));
    }
    for (const item of state.melds)
      for (let option = 0; option < 40; option++) {
        if (!extendOptions(item, cards, state)[option]) break;
        if (!extendProblem(state, seat, item.id, cards, option))
          found.add(JSON.stringify(extend(item.id, cards, option)));
      }
  }
  return found;
}
for (const game of ['koumkan', 'biriba'])
  test(`${game}: listed placements match every selection in real positions`, () => {
    let compared = 0,
      withMelds = 0;
    for (let n = 0; n < 40 && compared < 30; n++) {
      const reached = playOut(
        start(game, n),
        n + 1,
        (state) =>
          state.phase === 'meld' &&
          state.hands[state.turn].length <= 11 &&
          state.melds.length >= (n % 3) + 1,
      );
      if (reached.phase !== 'meld') continue;
      const listed = legal(reached);
      if (!listed.complete) continue;
      const placed = listed.actions
        .filter((action) => ['meld', 'extend'].includes(action.type))
        .map((action) => JSON.stringify(action));
      assert.deepEqual(placed.sort(), [...everyPlacement(reached)].sort());
      compared += 1;
      if (placed.length) withMelds += 1;
    }
    assert.ok(compared >= 10, `compared ${compared}`);
    assert.ok(withMelds >= 3, `only ${withMelds} had placements`);
  });
test('biriba: the pile can be taken exactly when some play uses it', () => {
  const counts = { takeable: 0, closed: 0, withMelds: 0 };
  const check = (state) => {
    const seat = state.turn;
    const taken = {
      ...state,
      hands: state.hands.map((hand, index) =>
        index === seat ? [...hand, ...state.discard] : hand,
      ),
      discard: [],
      pickup: state.discard,
      mustUsePickup: true,
      phase: 'meld',
    };
    const uses = [...everyPlacement(taken)].filter((text) =>
      JSON.parse(text).cards.some((card) => state.discard.includes(card)),
    );
    const allowed = legal(state).actions.some(
      (action) => action.source === 'discard',
    );
    assert.equal(allowed, uses.length > 0, JSON.stringify(state.discard));
    counts[allowed ? 'takeable' : 'closed'] += 1;
    if (state.melds.length) counts.withMelds += 1;
  };
  for (let n = 0; n < 60; n++) check(start('biriba', n));
  for (let n = 0; n < 60; n++) {
    const state = playOut(
      start('biriba', n),
      n + 1,
      (current) =>
        current.phase === 'draw' &&
        current.melds.some((item) => item.owner === current.turn % 2) &&
        current.hands[current.turn].length + current.discard.length <= 13,
    );
    if (state.phase === 'draw') check(state);
  }
  assert.ok(counts.takeable >= 5, JSON.stringify(counts));
  assert.ok(counts.closed >= 20, JSON.stringify(counts));
  assert.ok(counts.withMelds >= 3, JSON.stringify(counts));
});
