import test from 'node:test';
import { biribaBonus } from '../dist/esm/rules.js';
import {
  act,
  allCards,
  assert,
  deckFor,
  discard,
  engine,
  extend,
  legal,
  meld,
  ok,
  pass,
  pileDraw,
  playersOf,
  playOut,
  rejected,
  scripted,
  seed,
  start,
  step,
  stockDraw,
} from './helpers.mjs';

const game = 'biriba';
const table = { game, wildRank: null };
const clubs = ['3C-0', '4C-0', '5C-0', '6C-0', '7C-0', '8C-0', '9C-0'];
const run = (suit, ranks, copy = 0) =>
  ranks.map((rank) => `${rank}${suit}-${copy}`);
const value = (cards) =>
  cards.reduce((sum, card) => sum + engine.cardPoints(card, table), 0);

test('a deal is eleven cards each, with a packet per team', () => {
  const state = start(game);
  assert.equal(engine.DECKS.biriba.length, 108);
  assert.deepEqual(
    state.hands.map((hand) => hand.length),
    [11, 11, 11, 11],
  );
  assert.deepEqual(
    state.reserves.map((packet) => packet.length),
    [11, 11],
  );
  assert.equal(state.stock.length, 41);
  assert.equal(new Set(allCards(state)).size, 108);
  assert.equal(state.rulesVersion, engine.RULES_VERSIONS.biriba);
});
test('the open card sets the trump suit and is never a Joker', () => {
  const state = scripted(game, {
    hands: [],
    indicator: 'JOKER-0',
    stock: ['JOKER-1', '7H-0'],
  });
  assert.equal(state.indicator, '7H-0');
  assert.equal(state.trump, 'H');
  assert.deepEqual(state.stock.slice(-2), ['JOKER-0', 'JOKER-1']);
});
test('card values match the designer table', () => {
  const points = (card) => engine.cardPoints(card, table);
  assert.equal(points('JOKER-0'), 20);
  assert.equal(points('AC-0'), 15);
  assert.equal(points('2C-0'), 10);
  for (const rank of ['8', '9', '10', 'J', 'Q', 'K'])
    assert.equal(points(`${rank}C-0`), 10);
  for (const rank of ['3', '4', '5', '6', '7'])
    assert.equal(points(`${rank}C-0`), 5);
});
test('partners sit opposite and share melds; opponents do not', () => {
  const dealt = scripted(game, {
    hands: [
      ['5H-0', '6H-0', '7H-0', 'QD-0'],
      ['8H-0', 'KD-0'],
      ['4H-0', 'KS-0'],
    ],
    indicator: '9D-0',
    stock: ['2S-1', '3S-1', '4S-1'],
  });
  let state = act(act(dealt, stockDraw), meld(['5H-0', '6H-0', '7H-0']));
  assert.equal(state.melds[0].owner, 0);
  state = act(state, discard('QD-0'));
  state = act(state, stockDraw);
  rejected(state, extend('meld-0', ['8H-0']), 'ILLEGAL_MOVE');
  state = act(state, discard('KD-0'));
  state = act(state, stockDraw);
  const partner = act(state, extend('meld-0', ['4H-0']));
  assert.equal(partner.melds[0].slots.length, 4);
  assert.equal(partner.melds[0].owner, 0);
});
test('a partner lays off without opening first', () => {
  const dealt = scripted(game, {
    hands: [['5H-0', '6H-0', '7H-0', 'QD-0'], ['KD-0'], ['8H-0']],
    indicator: '9D-0',
    stock: ['2S-1', '3S-1', '4S-1'],
  });
  let state = act(act(dealt, stockDraw), meld(['5H-0', '6H-0', '7H-0']));
  state = pass(act(state, discard('QD-0')));
  state = act(state, stockDraw);
  assert.equal(state.opened[2], false);
  assert.equal(act(state, extend('meld-0', ['8H-0'])).melds[0].slots.length, 4);
});
function pileHand(hand, indicator = '9D-0', stock = []) {
  return scripted(game, { hands: [hand], indicator, stock });
}
test('the pile can only be taken when one of its cards can be used', () => {
  rejected(pileHand(['KS-0', 'QH-0']), pileDraw, 'ILLEGAL_MOVE');
  const state = pileHand(['8D-0', '10D-0']);
  assert.deepEqual(
    legal(state).actions.map((action) => action.source),
    ['stock', 'discard'],
  );
});
test('taking the pile takes all of it and the card must then be used', () => {
  const dealt = scripted(game, {
    hands: [['8D-1', '10D-1', 'KS-0'], ['2H-0'], ['3H-0'], ['4H-0']],
    indicator: '9D-0',
    stock: ['QC-1', 'QD-1', 'QH-1', 'QS-1'],
  });
  let state = dealt;
  state = act(state, stockDraw);
  state = act(state, discard('QC-1'));
  for (const seat of [1, 2, 3]) {
    const card = state.hands[seat].at(-1);
    state = act(state, stockDraw);
    state = act(state, discard(card));
  }
  const pile = state.discard;
  assert.equal(pile.length, 5);
  const before = state.hands[0].length;
  const taken = step(state, pileDraw);
  assert.deepEqual(taken.state.discard, []);
  assert.equal(taken.state.hands[0].length, before + 5);
  assert.deepEqual(taken.state.pickup, pile);
  assert.equal(taken.state.mustUsePickup, true);
  assert.deepEqual(taken.events[0].cards, pile);
  const after = taken.state;
  rejected(after, discard('KS-0'), 'ILLEGAL_MOVE');
  const used = act(after, meld(['8D-1', '9D-0', '10D-1']));
  assert.equal(used.mustUsePickup, false);
  assert.equal(act(used, discard('KS-0')).turn, 1);
});
test('a meld without a pile card leaves the duty to use one', () => {
  const state = act(
    pileHand(['8D-0', '10D-0', '3C-0', '4C-0', '5C-0', 'KS-0']),
    pileDraw,
  );
  const other = act(state, meld(['3C-0', '4C-0', '5C-0']));
  assert.equal(other.mustUsePickup, true);
  rejected(other, discard('KS-0'), 'ILLEGAL_MOVE');
  assert.equal(
    act(other, meld(['8D-0', '9D-0', '10D-0'])).mustUsePickup,
    false,
  );
});
test('a pile card used in a lay-off settles the duty', () => {
  const dealt = scripted(game, {
    hands: [
      ['5H-0', '6H-0', '7H-0', 'KD-0'],
      ['9H-0'],
      ['8H-0', 'QS-0'],
      ['KS-0'],
    ],
    indicator: '9D-0',
    stock: ['2S-1', '3S-1', '4S-1'],
  });
  let state = act(act(dealt, stockDraw), meld(['5H-0', '6H-0', '7H-0']));
  state = act(state, discard('KD-0'));
  state = act(act(state, stockDraw), discard('9H-0'));
  const taken = act(state, pileDraw);
  assert.equal(taken.turn, 2);
  const used = act(taken, extend('meld-0', ['8H-0', '9H-0']));
  assert.equal(used.mustUsePickup, false);
  assert.equal(used.melds[0].slots.length, 5);
});
test('the copy in the pile counts even with its twin in hand', () => {
  const state = act(
    scripted(game, {
      hands: [['8D-0', '9D-1', '10D-0', 'KS-0']],
      indicator: '9D-0',
    }),
    pileDraw,
  );
  rejected(state, discard('KS-0'), 'ILLEGAL_MOVE');
  const used = act(state, meld(['8D-0', '9D-0', '10D-0']));
  assert.equal(used.mustUsePickup, false);
  const error = rejected(
    state,
    meld(['8D-0', '9D-1', '10D-0']),
    'ILLEGAL_MOVE',
  );
  assert.match(error.message, /Keep a way to use/);
});
test('the use listed for a taken pile really uses a pile card', () => {
  const state = act(
    scripted(game, {
      hands: [['8D-0', '9D-1', '10D-0', 'KS-0']],
      indicator: '9D-0',
    }),
    pileDraw,
  );
  const [first] = legal(state).actions;
  assert.ok(first.cards.includes('9D-0'), JSON.stringify(first));
});
test('a wild card from the pile can be the card that gets used', () => {
  const dealt = scripted(game, {
    hands: [['4H-0', '5H-0', 'KS-0'], ['JC-0'], ['QC-0'], ['2C-0', 'KC-0']],
    indicator: 'KD-0',
    stock: ['QD-1', '3S-1', '4S-1', '5S-1'],
  });
  let state = act(act(dealt, stockDraw), discard('QD-1'));
  state = pass(pass(state));
  state = act(act(state, stockDraw), discard('2C-0'));
  const used = act(act(state, pileDraw), meld(['2C-0', '4H-0', '5H-0']));
  assert.equal(used.mustUsePickup, false);
  assert.equal(used.melds[0].slots.filter((slot) => slot.wild).length, 1);
});
test('the last way of using the pile cannot be spent', () => {
  const state = act(
    scripted(game, {
      hands: [
        [
          '8D-0',
          'JOKER-0',
          '4S-0',
          '5S-0',
          'KC-0',
          'QC-0',
          '3H-0',
          '6H-0',
          '9H-0',
          'JH-0',
          'KH-0',
        ],
      ],
      indicator: '9D-0',
    }),
    pileDraw,
  );
  const error = rejected(
    state,
    meld(['4S-0', '5S-0', 'JOKER-0']),
    'ILLEGAL_MOVE',
  );
  assert.match(error.message, /Keep a way to use/);
  assert.equal(
    legal(state).actions.some(
      (action) => action.type === 'meld' && action.cards.includes('4S-0'),
    ),
    false,
  );
  assert.equal(
    act(state, meld(['8D-0', '9D-0', 'JOKER-0'])).mustUsePickup,
    false,
  );
});
test('a spare substitute keeps the other meld available', () => {
  const state = act(
    scripted(game, {
      hands: [['8D-0', 'JOKER-0', 'JOKER-1', '4S-0', '5S-0', 'KC-0']],
      indicator: '9D-0',
    }),
    pileDraw,
  );
  assert.equal(
    act(state, meld(['4S-0', '5S-0', 'JOKER-0'])).mustUsePickup,
    true,
  );
});
test('a player with the pile always has a legal move', () => {
  const state = act(pileHand(['8D-0', '10D-0', 'KS-0']), pileDraw);
  const listed = legal(state);
  assert.ok(listed.actions.length > 0);
  assert.ok(listed.actions.every((action) => action.type !== 'discard'));
});
function smallMelds() {
  return act(
    scripted(game, {
      hands: [
        [
          '3C-0',
          '4C-0',
          '5C-0',
          '6D-0',
          '7D-0',
          '8D-0',
          '9H-0',
          '10H-0',
          'JH-0',
          '6C-0',
          '7C-0',
        ],
      ],
      indicator: '9S-0',
      stock: ['KS-0'],
    }),
    stockDraw,
  );
}
test('without a biriba a player must keep two cards', () => {
  let state = smallMelds();
  state = act(state, meld(['3C-0', '4C-0', '5C-0']));
  state = act(state, meld(['6D-0', '7D-0', '8D-0']));
  state = act(state, meld(['9H-0', '10H-0', 'JH-0']));
  rejected(state, extend('meld-0', ['6C-0', '7C-0']), 'ILLEGAL_MOVE');
  rejected(state, meld(['6C-0', '7C-0', 'KS-0']), 'ILLEGAL_MOVE');
  const kept = act(state, extend('meld-0', ['6C-0']));
  assert.equal(kept.hands[0].length, 2);
  assert.equal(act(kept, discard('7C-0')).hands[0].length, 1);
});
function biribaHand(rest, indicator = '9S-0', stock = ['KS-0']) {
  return scripted(game, {
    hands: [[...clubs, ...rest]],
    indicator,
    stock,
  });
}
test('a six-card meld is not a biriba', () => {
  const six = ['3C-0', '4C-0', '5C-0', '6C-0', '7C-0', '8C-0'];
  const diamonds = ['6D-0', '7D-0', '8D-0'];
  let state = act(
    scripted(game, {
      hands: [[...six, ...diamonds, '9D-0', '10D-0']],
      indicator: '9S-0',
      stock: ['KS-0'],
    }),
    stockDraw,
  );
  state = act(act(state, meld(six)), meld(diamonds));
  const error = rejected(
    state,
    extend('meld-1', ['9D-0', '10D-0']),
    'ILLEGAL_MOVE',
  );
  assert.match(error.message, /Keep two cards/);
});
test('a seven-card meld is a biriba and lifts the hand limit', () => {
  const state = act(
    act(biribaHand(['10C-0', 'JC-0', 'QC-0', 'KD-0']), stockDraw),
    meld(clubs),
  );
  assert.equal(state.melds[0].slots.length, 7);
  const down = act(state, extend('meld-0', ['10C-0', 'JC-0', 'QC-0']));
  assert.deepEqual(down.hands[0], ['KD-0', 'KS-0']);
  assert.equal(down.melds[0].slots.length, 10);
});
test('a biriba lets a lay-off leave one card', () => {
  const state = act(
    act(biribaHand(['10C-0', 'JC-0', 'QC-0', 'KC-0']), stockDraw),
    meld([...clubs, '10C-0', 'JC-0', 'QC-0']),
  );
  const left = act(state, extend('meld-0', ['KC-0']));
  assert.deepEqual(left.hands[0], ['KS-0']);
});
test('melding the last card takes the packet and the turn goes on', () => {
  const packet = run('H', ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q']);
  const state = act(
    scripted(game, {
      hands: [[...clubs, '10C-0', 'JC-0', 'QC-0', 'KC-0']],
      reserves: [[...packet, 'KD-1']],
      indicator: '9S-0',
      stock: ['2C-0'],
    }),
    stockDraw,
  );
  const result = step(
    state,
    meld([...clubs, '10C-0', 'JC-0', 'QC-0', 'KC-0', '2C-0']),
  );
  const next = result.state;
  assert.equal(next.reserveTaken[0], true);
  assert.deepEqual(next.reserves[0], []);
  assert.deepEqual(next.hands[0], [...packet, 'KD-1']);
  assert.equal(next.turn, 0);
  assert.equal(next.phase, 'meld');
  assert.deepEqual(next.reserveWaiting, [null, null]);
  assert.equal(
    result.events.find((event) => event.type === 'reserve-taken').afterDiscard,
    false,
  );
});
test('a team takes its own packet once, and melding out then needs a discard', () => {
  const packet = run('H', ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q']);
  let state = act(
    scripted(game, {
      hands: [[...clubs, '10C-0', 'JC-0', 'QC-0', 'KC-0']],
      reserves: [[...packet, 'KH-1']],
      indicator: '9S-0',
      stock: ['2C-0'],
    }),
    stockDraw,
  );
  state = act(state, meld([...clubs, '10C-0', 'JC-0', 'QC-0', 'KC-0', '2C-0']));
  rejected(state, meld([...packet, 'KH-1']), 'ILLEGAL_MOVE');
  const out = step(act(state, meld(packet)), discard('KH-1'));
  assert.equal(
    out.events.find((event) => event.type === 'round-ended').outcome.closer,
    0,
  );
});
test('discarding the last card takes the packet for the next turn', () => {
  const state = act(
    scripted(game, {
      hands: [[...clubs, '10C-0', 'JC-0', 'QC-0', 'KC-0']],
      reserves: [run('H', ['3', '4'])],
      indicator: '9S-0',
      stock: ['KS-0', 'KD-1', 'KD-0', 'KH-1', '2D-1'],
    }),
    stockDraw,
  );
  const melded = act(state, meld([...clubs, '10C-0', 'JC-0', 'QC-0', 'KC-0']));
  assert.deepEqual(melded.hands[0], ['KS-0']);
  const result = step(melded, discard('KS-0'));
  const next = result.state;
  assert.equal(next.turn, 1);
  assert.equal(next.hands[0].length, 11);
  assert.deepEqual(next.reserveWaiting, [0, null]);
  assert.equal(
    result.events.find((event) => event.type === 'reserve-taken').afterDiscard,
    true,
  );
  let around = pass(pass(pass(next)));
  assert.deepEqual(around.reserveWaiting, [0, null]);
  around = act(around, stockDraw);
  assert.deepEqual(around.reserveWaiting, [null, null]);
});
test('a partner can end the round while the other still holds cards', () => {
  const packet = run('H', ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q']);
  let state = act(
    scripted(game, {
      hands: [
        [...clubs, '10C-0', 'JC-0', 'QC-0', 'KC-0'],
        [],
        run('D', ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']),
      ],
      reserves: [[...packet, 'KH-1']],
      indicator: '9S-0',
      stock: ['2C-0'],
    }),
    stockDraw,
  );
  state = act(state, meld([...clubs, '10C-0', 'JC-0', 'QC-0', 'KC-0', '2C-0']));
  state = act(state, discard('KH-1'));
  state = pass(state);
  const held = state.hands[0].length;
  state = act(state, stockDraw);
  state = act(
    state,
    meld(run('D', ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q'])),
  );
  const drawn = state.hands[2].at(-1);
  state = act(state, extend('meld-1', ['KD-0']));
  const closed = step(state, discard(drawn));
  const outcome = closed.events.find(
    (event) => event.type === 'round-ended',
  ).outcome;
  assert.equal(outcome.closer, 2);
  assert.equal(outcome.results[0].closingBonus, 100);
  assert.equal(outcome.results[1].closingBonus, 0);
  assert.equal(held, 10);
  assert.ok(outcome.results[0].handPoints > 0, 'seat 0 is still holding cards');
});
/** Seat 0 goes out on the first turn with a 12-card run and a 10-card run. */
function closingRound(options = {}) {
  const { indicator = '9S-0', scores } = options;
  const packet = run('H', ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q']);
  const state = act(
    scripted(
      game,
      {
        hands: [[...clubs, '10C-0', 'JC-0', 'QC-0', 'KC-0']],
        reserves: [[...packet, 'KD-1']],
        indicator,
        stock: ['2C-0'],
      },
      scores ? { scores } : {},
    ),
    stockDraw,
  );
  const melded = act(
    act(state, meld([...clubs, '10C-0', 'JC-0', 'QC-0', 'KC-0', '2C-0'])),
    meld(packet),
  );
  return step(melded, discard('KD-1'));
}
test('a closing round adds melds, bonuses and the closing 100', () => {
  const closed = closingRound();
  const outcome = closed.events.find(
    (event) => event.type === 'round-ended',
  ).outcome;
  const [ours, theirs] = outcome.results;
  const melded = value([...clubs, '10C-0', 'JC-0', 'QC-0', 'KC-0', '2C-0']);
  const packet = run('H', ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q']);
  assert.equal(ours.meldPoints, melded + value(packet));
  assert.equal(ours.bonusPoints, 400);
  assert.equal(ours.closingBonus, 100);
  assert.equal(ours.reservePenalty, 0);
  assert.equal(ours.handPoints, value(closedHand(closed, 2)));
  assert.equal(
    ours.points,
    ours.meldPoints + ours.bonusPoints + 100 - ours.handPoints,
  );
  assert.deepEqual(ours.seats, [0, 2]);
  assert.deepEqual(theirs.seats, [1, 3]);
  assert.equal(theirs.reservePenalty, 100);
  assert.equal(theirs.meldPoints, 0);
  assert.equal(theirs.closingBonus, 0);
  assert.equal(theirs.points, -theirs.handPoints - 100);
});
const closedHand = (closed, seat) =>
  closed.state.initial.decks[0]
    .slice(22, 22 + 44)
    .filter((_, index) => index % 4 === seat);
test('biriba bonuses depend on length, cleanness and trump', () => {
  const clean = clubs.map((card, index) => ({
    card,
    rank: 3 + index,
    suit: 'C',
    wild: false,
  }));
  const dirty = clean.map((slot, index) =>
    index === 3 ? { ...slot, card: 'JOKER-0', wild: true } : slot,
  );
  const thirteen = Array.from({ length: 13 }, (_, index) => ({
    card: 'AC-0',
    rank: index + 1,
    suit: 'C',
    wild: false,
  }));
  const dirtyThirteen = thirteen.map((slot, index) =>
    index === 5 ? { ...slot, wild: true } : slot,
  );
  const short = clean.slice(0, 6);
  const bonus = (slots, trump) => biribaBonus({ slots }, trump);
  assert.equal(bonus(short, 'H'), 0);
  assert.equal(bonus(clean, 'H'), 200);
  assert.equal(bonus(dirty, 'H'), 100);
  assert.equal(bonus(thirteen, 'H'), 1000);
  assert.equal(bonus(dirtyThirteen, 'H'), 500);
  assert.equal(bonus(clean, 'C'), 400);
  assert.equal(bonus(dirty, 'C'), 200);
  assert.equal(bonus(thirteen, 'C'), 2000);
  assert.equal(bonus(dirtyThirteen, 'C'), 1000);
});
test('a trump run doubles its bonus in a scored round', () => {
  const plain = closingRound();
  const trump = closingRound({ indicator: '9C-1' });
  const bonus = (closed) =>
    closed.events.find((event) => event.type === 'round-ended').outcome
      .results[0].bonusPoints;
  // The 2C run here reads as clean, so 200 doubles while the heart run stays 200.
  assert.equal(bonus(plain), 400);
  assert.equal(bonus(trump), 600);
});
test('the stock running out ends the round with no closing bonus', () => {
  let state = start(game, 2);
  while (state.stock.length > 1) state = pass(state);
  assert.equal(state.roundNumber, 1);
  const drawn = act(state, stockDraw);
  const result = step(drawn, discard(drawn.hands[drawn.turn].at(-1)));
  const outcome = result.events.find(
    (event) => event.type === 'round-ended',
  ).outcome;
  assert.equal(outcome.reason, 'stock');
  assert.equal(outcome.closer, null);
  assert.ok(outcome.results.every((item) => item.closingBonus === 0));
  assert.ok(outcome.results.every((item) => item.reservePenalty === 100));
});
test('a packet not reached before the end costs 100, not its cards', () => {
  let state = act(
    scripted(game, {
      hands: [[...clubs, '10C-0', 'JC-0', 'QC-0', 'KC-0']],
      indicator: '9S-0',
      stock: ['2S-1'],
    }),
    stockDraw,
  );
  state = act(state, meld([...clubs, '10C-0', 'JC-0', 'QC-0']));
  state = act(state, discard('2S-1'));
  while (state.stock.length > 1) {
    if (state.turn === 0) {
      state = act(state, stockDraw);
      state = act(state, discard(state.hands[0].at(-1)));
    } else state = pass(state);
  }
  assert.equal(state.turn, 0);
  const drawn = act(state, stockDraw);
  const last = act(drawn, extend('meld-0', ['KC-0']));
  const result = step(last, discard(last.hands[0][0]));
  assert.deepEqual(result.state.rounds.at(-1).closer, null);
  const outcome = result.state.rounds.at(-1);
  assert.equal(outcome.results[0].reservePenalty, 100);
  assert.equal(outcome.reason, 'stock');
  assert.equal(outcome.results[0].closingBonus, 0);
  assert.equal(
    outcome.results[0].handPoints,
    value(last.hands[2]),
    'seat 0 is not charged for the packet',
  );
});
test('the match ends at 2,005 and the higher total wins', () => {
  const closed = closingRound({ scores: [1900, 100] });
  assert.equal(closed.state.phase, 'ended');
  assert.equal(closed.state.matchOutcome.side, 0);
  assert.deepEqual(closed.state.matchOutcome.winners, [0, 2]);
  assert.deepEqual(closed.state.matchOutcome.winnerIds, ['seat0', 'seat2']);
  assert.equal(closed.state.matchOutcome.reason, 'target-reached');
});
test('a total just under 2,005 plays on', () => {
  const probe = closingRound().state.scores[0];
  const closed = closingRound({ scores: [2004 - probe, 0] });
  assert.equal(closed.state.phase, 'round-end');
  assert.equal(closed.state.scores[0], 2004);
  const reached = closingRound({ scores: [2005 - probe, 0] });
  assert.equal(reached.state.phase, 'ended');
});
test('an exact tie at the target plays another round', () => {
  const probe = closingRound().state.scores;
  const closed = closingRound({
    scores: [2100 - probe[0], 2100 - probe[1]],
  });
  assert.deepEqual(closed.state.scores, [2100, 2100]);
  assert.equal(closed.state.phase, 'round-end');
  assert.equal(act(closed.state, { type: 'next' }).roundNumber, 2);
});
test('a losing team can cross the target only behind a higher one', () => {
  const probe = closingRound().state.scores;
  const closed = closingRound({
    scores: [3000 - probe[0], 2500 - probe[1]],
  });
  assert.equal(closed.state.matchOutcome.side, 0);
  assert.deepEqual(closed.state.scores, [3000, 2500]);
});
test('scores can go negative', () => {
  const closed = closingRound();
  assert.ok(closed.state.scores[1] < 0);
});
test('the starter moves round the table', () => {
  const state = scripted(
    game,
    { hands: [], indicator: '9S-0' },
    {
      firstStarter: 3,
      decks: [deckFor(game, { hands: [], indicator: '9S-0' })],
    },
  );
  assert.equal(state.starter, 3);
  assert.equal(state.turn, 3);
  const next = pass(state);
  assert.equal(next.turn, 0);
});
test('random matches stay legal and keep every card accounted for', () => {
  let state = start(game, 5);
  const check = (current) => {
    assert.equal(allCards(current).length, 108);
    assert.equal(new Set(allCards(current)).size, 108);
  };
  state = playOut(state, 11, (current) => current.roundNumber === 3, check);
  assert.equal(state.roundNumber, 3);
  assert.equal(state.rounds.length, 2);
});
test('a game needs four players', () => {
  const bad = engine.createGame({
    game,
    players: playersOf('koumkan'),
    seed: seed(),
  });
  assert.equal(bad.error.code, 'INVALID_CONFIG');
  assert.equal(
    ok(engine.createGame({ game, players: playersOf(game), seed: seed() }))
      .game,
    game,
  );
});
