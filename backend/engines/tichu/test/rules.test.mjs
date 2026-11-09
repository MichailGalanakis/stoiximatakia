import test from 'node:test';
import {
  act,
  allCards,
  allGrandsPass,
  assert,
  clubs,
  deckOf,
  engine,
  filled,
  noGrand,
  ok,
  pass,
  play,
  playing,
  playOut,
  players,
  rejected,
  rotated,
  scripted,
  seed,
  single,
  start,
  step,
  straightDeal,
} from './helpers.mjs';

const nextRound = { type: 'next' };
const view = (state, seat) => ok(engine.getObservation(state, players[seat]));
const legal = (state, seat) =>
  ok(engine.getLegalActions(state, players[seat])).actions;

test('eight cards come first, and a Grand Tichu decision for each seat', () => {
  const state = start();
  assert.equal(state.phase, 'grand');
  assert.deepEqual(
    state.hands.map((hand) => hand.length),
    [8, 8, 8, 8],
  );
  assert.equal(state.stock.length, 24);
  assert.equal(new Set(allCards(state)).size, 56);
  for (let seat = 0; seat < 4; seat++)
    assert.deepEqual(legal(state, seat), [
      { type: 'grand', call: false },
      { type: 'grand', call: true },
    ]);
});
test('Grand Tichu decisions come in any order, and only once', () => {
  let state = act(start(), 2, { type: 'grand', call: true });
  assert.deepEqual(state.declarations, [0, 0, 200, 0]);
  rejected(state, 2, noGrand, 'ILLEGAL_MOVE');
  state = act(state, 3, noGrand);
  state = act(state, 0, noGrand);
  assert.equal(state.phase, 'grand');
  assert.equal(state.hands[0].length, 8);
  state = act(state, 1, noGrand);
  assert.equal(state.phase, 'exchange');
  assert.deepEqual(
    state.hands.map((hand) => hand.length),
    [14, 14, 14, 14],
  );
  assert.equal(state.stock.length, 0);
  assert.equal(new Set(allCards(state)).size, 56);
});
test('nobody sees a ninth card before all four decide', () => {
  let state = start();
  for (const seat of [0, 1, 2]) state = act(state, seat, noGrand);
  assert.equal(view(state, 0).hand.length, 8);
  assert.equal(view(state, 3).hand.length, 8);
});
test('Tichu cannot be called during the Grand Tichu decisions', () => {
  rejected(start(), 0, { type: 'declare' }, 'ILLEGAL_MOVE');
});
test('Tichu can be called during the exchange, out of turn, and only once', () => {
  let state = allGrandsPass(start());
  state = act(state, 3, { type: 'declare' });
  assert.deepEqual(state.declarations, [0, 0, 0, 100]);
  rejected(state, 3, { type: 'declare' }, 'ILLEGAL_MOVE');
  assert.equal(state.phase, 'exchange');
});
test('a Grand Tichu caller cannot add a Tichu', () => {
  let state = act(start(), 1, { type: 'grand', call: true });
  for (const seat of [0, 2, 3]) state = act(state, seat, noGrand);
  rejected(state, 1, { type: 'declare' }, 'ILLEGAL_MOVE');
});
test("Tichu ends with the player's first card, whoever's turn it is", () => {
  let state = playing([['MAHJONG', '3C', '4C'], ['5D'], ['6H'], ['7S']]);
  state = act(state, 1, { type: 'declare' });
  state = act(state, 0, play(['MAHJONG'], { wish: 0 }));
  rejected(state, 0, { type: 'declare' }, 'ILLEGAL_MOVE');
  assert.equal(act(state, 2, { type: 'declare' }).declarations[2], 100);
});
test('an exchange holds exactly three different cards from the hand', () => {
  const state = allGrandsPass(start());
  const hand = state.hands[0];
  const other = state.hands[1][0];
  const swap = (cards) => ({ type: 'exchange', cards });
  rejected(state, 0, swap(hand.slice(0, 2)), 'ILLEGAL_MOVE');
  rejected(state, 0, swap(hand.slice(0, 4)), 'ILLEGAL_MOVE');
  rejected(state, 0, swap([hand[0], hand[0], hand[1]]), 'ILLEGAL_MOVE');
  rejected(state, 0, swap([hand[0], hand[1], other]), 'ILLEGAL_MOVE');
  const done = act(state, 0, swap(hand.slice(0, 3)));
  rejected(done, 0, swap(hand.slice(3, 6)), 'ILLEGAL_MOVE');
});
test('cards go to the next seat, the partner and the seat before', () => {
  let state = allGrandsPass(start(5));
  const given = state.hands.map((hand) => hand.slice(0, 3));
  for (const seat of [2, 0, 3])
    state = act(state, seat, { type: 'exchange', cards: given[seat] });
  assert.equal(state.phase, 'exchange');
  assert.equal(state.hands[1].includes(given[0][0]), false);
  state = act(state, 1, { type: 'exchange', cards: given[1] });
  assert.equal(state.phase, 'play');
  for (let seat = 0; seat < 4; seat++) {
    assert.equal(state.hands[seat].length, 14);
    assert.ok(state.hands[(seat + 1) % 4].includes(given[seat][0]));
    assert.ok(state.hands[(seat + 2) % 4].includes(given[seat][1]));
    assert.ok(state.hands[(seat + 3) % 4].includes(given[seat][2]));
    assert.equal(state.hands[seat].includes(given[seat][0]), false);
  }
});
test('a committed exchange stays hidden until all four commit', () => {
  let state = allGrandsPass(start(6));
  const cards = state.hands[0].slice(0, 3);
  state = act(state, 0, { type: 'exchange', cards });
  const seen = view(state, 1);
  assert.deepEqual(seen.exchangeCommitted, [true, false, false, false]);
  const text = JSON.stringify({ ...seen, hand: [] });
  for (const card of cards)
    assert.ok(!text.includes(`"${card}"`), `leaked ${card}`);
});
test('the Mah Jong holder after the exchange leads', () => {
  const dealt = filled([['2C'], ['MAHJONG']]);
  let state = allGrandsPass(scripted(dealt));
  const send = (seat, first) => {
    const others = state.hands[seat].filter((card) => card !== first);
    return { type: 'exchange', cards: [first, ...others.slice(0, 2)] };
  };
  for (const seat of [0, 2, 3])
    state = act(state, seat, send(seat, state.hands[seat][0]));
  // Seat 1 passes the Mah Jong on to seat 2, who leads.
  state = act(state, 1, send(1, 'MAHJONG'));
  assert.equal(state.phase, 'play');
  assert.equal(state.turn, 2);
  assert.ok(state.hands[2].includes('MAHJONG'));
});
test('the leader must play and need not play the Mah Jong', () => {
  const state = playing([['MAHJONG', '3C', '4C']]);
  rejected(state, 0, pass, 'ILLEGAL_MOVE');
  assert.equal(
    legal(state, 0).some((action) => action.type === 'pass'),
    false,
  );
  assert.equal(act(state, 0, single('3C')).turn, 1);
});
test('only the player in turn can pass or play ordinary cards', () => {
  const state = playing([['MAHJONG'], ['3C']]);
  rejected(state, 2, pass, 'NOT_YOUR_TURN');
  rejected(state, 1, single('3C'), 'NOT_YOUR_TURN');
});
test('a player can pass and come back into the same trick', () => {
  let state = playing([
    ['MAHJONG', '3C', '9C'],
    ['4D', 'JD'],
    ['5H', 'QH'],
    ['6S', 'KS'],
  ]);
  state = act(state, 0, single('3C'));
  state = settled(act(state, 1, pass));
  state = act(state, 2, single('5H'));
  state = settled(act(state, 3, pass));
  state = settled(act(state, 0, pass));
  assert.equal(state.turn, 1);
  state = act(state, 1, single('JD'));
  assert.equal(state.top.player, 1);
  assert.deepEqual(state.passes, []);
});
test('a trick goes to its last player, who leads again', () => {
  let state = playing([['MAHJONG', '3C'], ['4D'], ['5H'], ['6S']]);
  state = act(state, 0, single('3C'));
  state = act(state, 1, single('4D'));
  state = settled(act(state, 2, pass));
  state = settled(act(state, 3, pass));
  state = act(state, 0, pass);
  for (const seat of [0, 1, 2]) state = act(state, seat, { type: 'continue' });
  const taken = step(state, 3, { type: 'continue' });
  const event = taken.events.find((item) => item.type === 'trick-taken');
  assert.equal(event.seat, 1);
  assert.equal(event.cardCount, 2);
  assert.equal(taken.state.turn, 1);
  assert.equal(taken.state.top, null);
  assert.deepEqual([...taken.state.captured[1]].sort(), ['3C', '4D']);
  assert.deepEqual(taken.state.pile, []);
});
test('the Mah Jong needs its wish stated, and only it can make one', () => {
  const state = playing([['MAHJONG', '3C']]);
  rejected(state, 0, single('MAHJONG'), 'ILLEGAL_MOVE');
  rejected(state, 0, play(['MAHJONG'], { wish: 1 }), 'ILLEGAL_MOVE');
  rejected(state, 0, play(['MAHJONG'], { wish: 15 }), 'INVALID_ACTION');
  rejected(state, 0, play(['3C'], { wish: 7 }), 'INVALID_ACTION');
  assert.equal(act(state, 0, play(['MAHJONG'], { wish: 0 })).wish, null);
  assert.equal(act(state, 0, play(['MAHJONG'], { wish: 14 })).wish, 14);
});
function wished(rank = 7, hands = {}) {
  const deal = playing([
    ['MAHJONG', '3C'],
    hands[1] ?? ['7D', '9D'],
    hands[2] ?? ['JH', '7C'],
    hands[3] ?? ['QS', '7H', '7S'],
  ]);
  return act(deal, 0, play(['MAHJONG'], { wish: rank }));
}
test('a player who can fulfil the wish must', () => {
  const state = wished();
  rejected(state, 1, pass, 'ILLEGAL_MOVE');
  rejected(state, 1, single('9D'), 'ILLEGAL_MOVE');
  const plays = legal(state, 1).filter((action) => action.type === 'play');
  assert.ok(plays.every((action) => action.cards.includes('7D')));
  const next = act(state, 1, single('7D'));
  assert.equal(next.wish, null);
});
test('a player who cannot fulfil the wish plays freely and it stays', () => {
  const state = wished(7, {
    1: ['8D', '9D'],
    2: ['7D', '7C', '10H'],
    3: ['7H', '7S', 'QS'],
  });
  assert.ok(legal(state, 1).some((action) => action.type === 'pass'));
  assert.equal(act(state, 1, single('9D')).wish, 7);
});
test('a wish can only be met by a play that beats the table', () => {
  let state = playing([
    ['MAHJONG', '3C', 'AC'],
    ['KD', '2D'],
    ['7D', '7C', '2H'],
    ['7H', '7S', '2S'],
  ]);
  state = act(state, 0, play(['MAHJONG'], { wish: 7 }));
  state = act(state, 1, single('KD'));
  assert.equal(state.wish, 7);
  // Seat 2 holds the wished 7, but it cannot beat the King on the table.
  assert.ok(legal(state, 2).some((action) => action.type === 'pass'));
  state = settled(act(state, 2, pass));
  assert.equal(state.wish, 7);
});
test('a Phoenix pairing a wished card meets the wish', () => {
  let state = playing([
    ['MAHJONG', '3C', '3D'],
    ['KD', 'KS', '5S'],
    ['7D', 'PHOENIX'],
    ['7H', '7S', '7C'],
  ]);
  state = act(state, 0, play(['3C', '3D']));
  state = settled(act(state, 1, pass));
  const pairs = legal(state, 2).filter(
    (action) => action.type === 'play' && action.cards.includes('7D'),
  );
  assert.ok(pairs.some((action) => action.cards.includes('PHOENIX')));
  const wishing = playing([
    ['MAHJONG', '3C', '3D'],
    ['KD', '5S'],
    ['7D', 'PHOENIX', 'QD'],
    ['7H', '7S', '7C'],
  ]);
  let led = act(wishing, 0, play(['MAHJONG'], { wish: 7 }));
  led = act(led, 1, pass);
  const forced = legal(led, 2).filter((action) => action.type === 'play');
  assert.ok(forced.every((action) => action.cards.includes('7D')));
  assert.equal(act(led, 2, single('7D')).wish, null);
});
test('a Phoenix does not meet a wish by standing in for the rank', () => {
  const state = wished(7, {
    1: ['PHOENIX', '9D'],
    2: ['7D', '7C', '10H'],
    3: ['7H', '7S', 'QS'],
  });
  assert.equal(act(state, 1, single('PHOENIX')).wish, 7);
});
test('a wish stays on the table and binds a later trick', () => {
  let state = wished(7, {
    1: ['KD', '3D'],
    2: ['7D', '7C', '10H'],
    3: ['7H', '7S', 'QS'],
  });
  state = act(state, 1, single('KD'));
  assert.equal(state.wish, 7);
  for (const seat of [2, 3, 0]) state = settled(act(state, seat, pass));
  assert.equal(state.turn, 1);
  state = act(state, 1, single('3D'));
  rejected(state, 2, pass, 'ILLEGAL_MOVE');
  rejected(state, 2, single('10H'), 'ILLEGAL_MOVE');
  assert.equal(act(state, 2, single('7D')).wish, null);
});
test('the Dog hands the lead to the partner and takes no trick', () => {
  let state = playing([['MAHJONG', 'DOG', '3C'], ['4D'], ['5H'], ['6S']]);
  const played = step(state, 0, single('DOG'));
  state = played.state;
  assert.equal(state.turn, 2);
  assert.equal(state.top, null);
  assert.deepEqual(state.pile, []);
  assert.ok(state.captured[0].includes('DOG'));
});
test('the Dog cannot follow a play', () => {
  let state = playing([
    ['MAHJONG', '3C'],
    ['4D', 'DOG'],
  ]);
  state = act(state, 0, single('3C'));
  rejected(state, 1, single('DOG'), 'ILLEGAL_MOVE');
});
test('the Dog goes past a partner who is out', () => {
  let state = straightDeal(['PHOENIX', 'DOG', 'DRAGON']);
  state = act(state, 0, play(['MAHJONG', ...clubs], { wish: 0 }));
  assert.deepEqual(state.order, [0]);
  for (const seat of [1, 2, 3]) state = settled(act(state, seat, pass));
  assert.equal(state.turn, 1);
  state = act(state, 1, single('2H'));
  state = act(state, 2, single(rotated(2).at(-1)));
  state = settled(act(state, 3, pass));
  state = settled(act(state, 1, pass));
  assert.equal(state.turn, 2);
  // Seat 2's partner, seat 0, is out, so the lead moves on to seat 1.
  assert.equal(act(state, 2, single('DOG')).turn, 1);
});
test('a Dragon trick goes to an opponent, and its player leads', () => {
  let state = playing([['MAHJONG', 'DRAGON', '3C'], ['4D'], ['5H'], ['6S']]);
  state = act(state, 0, single('DRAGON'));
  for (const seat of [1, 2]) state = settled(act(state, seat, pass));
  state = settled(act(state, 3, pass));
  assert.equal(state.phase, 'dragon');
  assert.equal(state.turn, 0);
  rejected(state, 1, { type: 'dragon', to: 3 }, 'NOT_YOUR_TURN');
  rejected(state, 0, { type: 'dragon', to: 2 }, 'ILLEGAL_MOVE');
  rejected(state, 0, { type: 'dragon', to: 0 }, 'ILLEGAL_MOVE');
  rejected(state, 0, single('3C'), 'ILLEGAL_MOVE');
  rejected(state, 0, { type: 'dragon', to: 5 }, 'INVALID_ACTION');
  assert.deepEqual(legal(state, 0), [
    { type: 'dragon', to: 1 },
    { type: 'dragon', to: 3 },
  ]);
  const given = act(state, 0, { type: 'dragon', to: 3 });
  assert.deepEqual(given.captured[3], ['DRAGON']);
  assert.deepEqual(given.captured[0], []);
  assert.equal(given.turn, 0);
  assert.equal(given.phase, 'play');
});
test('a bombed Dragon is kept like any other trick', () => {
  let state = playing([
    ['MAHJONG', 'DRAGON', '3C'],
    ['9C', '9D', '9H', '9S', '4D'],
  ]);
  state = act(state, 0, single('DRAGON'));
  state = act(state, 1, play(['9C', '9D', '9H', '9S']));
  for (const seat of [2, 3, 0]) state = settled(act(state, seat, pass));
  assert.equal(state.phase, 'play');
  assert.equal(state.turn, 1);
  assert.ok(state.captured[1].includes('DRAGON'));
});
test('a bomb can come out of turn and even over a pass', () => {
  let state = playing([
    ['MAHJONG', '3C'],
    ['4D'],
    ['9C', '9D', '9H', '9S', '5H'],
    ['6S'],
  ]);
  state = act(state, 0, single('3C'));
  state = act(state, 1, single('4D'));
  const bombed = step(state, 2, play(['9C', '9D', '9H', '9S']));
  assert.equal(bombed.events[0].outOfTurn, false);
  state = bombed.state;
  assert.equal(state.turn, 3);
  const later = playing([
    ['MAHJONG', '3C'],
    ['9C', '9D', '9H', '9S', '4D'],
    ['5H'],
    ['6S'],
  ]);
  const first = act(later, 0, single('3C'));
  const skipped = act(act(first, 1, pass), 2, single('5H'));
  const out = step(skipped, 1, play(['9C', '9D', '9H', '9S']));
  assert.equal(out.events[0].outOfTurn, true);
  assert.equal(out.state.top.player, 1);
  assert.equal(out.state.turn, 2, 'play resumes after the bomber');
});
test('an out-of-turn bomb cannot take over an empty table', () => {
  const state = playing([
    ['MAHJONG', '3C'],
    ['9C', '9D', '9H', '9S', '4D'],
  ]);
  rejected(state, 1, play(['9C', '9D', '9H', '9S']), 'ILLEGAL_MOVE');
  assert.equal(
    legal(state, 1).some((action) => action.type === 'play'),
    false,
  );
});
test('a player can bomb their own play', () => {
  let state = playing([['MAHJONG', '3C', '9C', '9D', '9H', '9S']]);
  state = act(state, 0, single('3C'));
  const own = act(state, 0, play(['9C', '9D', '9H', '9S']));
  assert.equal(own.top.player, 0);
  assert.equal(own.top.combo.kind, 'bomb');
});
test('an out-of-turn bomb need not meet the wish, and leaves it pending', () => {
  let state = playing([
    ['MAHJONG', '3C'],
    ['7D', '8D'],
    ['9C', '9D', '9H', '9S', '4H'],
    ['5S'],
  ]);
  state = act(state, 0, play(['MAHJONG'], { wish: 7 }));
  state = act(state, 2, play(['9C', '9D', '9H', '9S']));
  assert.equal(state.wish, 7);
});

// Scoring/turn fixtures explicitly answer the new public window before continuing.
function settled(state) {
  if (state.phase !== 'bomb-window') return state;
  for (const seat of [...state.windowPending])
    state = act(state, seat, { type: 'continue' });
  return state;
}
function windowDeal() {
  return playing([
    ['MAHJONG', '3C'],
    ['4D'],
    ['9C', '9D', '9H', '9S', '5H'],
    ['6S'],
  ]);
}
function allPassed() {
  let state = act(windowDeal(), 0, single('3C'));
  state = act(state, 1, single('4D'));
  state = act(state, 2, pass);
  state = act(state, 3, pass);
  return act(state, 0, pass);
}
test('after the passes, every remaining seat is asked', () => {
  const state = allPassed();
  assert.equal(state.phase, 'bomb-window');
  assert.deepEqual(state.windowPending, [0, 1, 2, 3]);
  assert.equal(state.turn, null);
  assert.equal(view(state, 2).yourMove, true);
  assert.equal(view(state, 0).yourMove, true);

  rejected(state, 0, pass, 'NOT_YOUR_TURN');
  rejected(state, 2, single('5H'), 'NOT_YOUR_TURN');
});
test('declining the window gives the trick to its winner', () => {
  const state = settled(allPassed());
  assert.equal(state.phase, 'play');
  assert.equal(state.turn, 1);
  assert.deepEqual([...state.captured[1]].sort(), ['3C', '4D']);
});
test('a bomb in the window reopens the trick', () => {
  const state = act(allPassed(), 2, play(['9C', '9D', '9H', '9S']));
  assert.equal(state.phase, 'play');
  assert.equal(state.top.player, 2);
  assert.deepEqual(state.windowPending, []);
  assert.equal(state.turn, 3);
});
test('the window stays open until every remaining seat has answered', () => {
  let state = playing([
    ['MAHJONG', '3C'],
    ['4D', '8C', '8D', '8H', '8S'],
    ['9C', '9D', '9H', '9S', '5H'],
    ['6S'],
  ]);
  state = act(state, 0, single('3C'));
  state = act(state, 1, single('4D'));
  state = act(state, 2, pass);
  state = act(state, 3, pass);
  state = act(state, 0, pass);
  assert.deepEqual(state.windowPending, [0, 1, 2, 3]);
  const first = act(state, 2, { type: 'continue' });
  assert.equal(first.phase, 'bomb-window');
  assert.deepEqual(first.windowPending, [0, 1, 3]);
  rejected(first, 2, { type: 'continue' }, 'ILLEGAL_MOVE');
  assert.equal(settled(first).phase, 'play');
});
test('without bombs the same public window still opens', () => {
  const state = playing([['MAHJONG', '3C'], ['4D'], ['5H'], ['6S']]);
  let current = act(state, 0, single('3C'));
  for (const seat of [1, 2]) current = act(current, seat, pass);
  current = act(current, 3, pass);
  assert.equal(current.phase, 'bomb-window');
  assert.deepEqual(current.windowPending, [0, 1, 2, 3]);
  assert.equal(settled(current).turn, 0);
});
test('a bomb too weak for the table still gets a public decline', () => {
  let state = playing([
    ['MAHJONG', 'KC', 'KD', 'KH', 'KS'],
    ['3C', '3D', '3H', '3S', '4D'],
  ]);
  state = act(state, 0, play(['KC', 'KD', 'KH', 'KS']));
  for (const seat of [1, 2, 3]) state = act(state, seat, pass);
  assert.equal(state.phase, 'bomb-window');
  assert.equal(settled(state).turn, 0);
});
test('a pending bomb seat is not named to the others', () => {
  const seen = view(allPassed(), 0);
  assert.equal(seen.phase, 'bomb-window');
  assert.ok(!('windowPending' in seen));
  assert.ok(!JSON.stringify(seen).includes('windowPending'));
});
test('Tichu can still be called while a Dragon trick waits', () => {
  let state = playing([['MAHJONG', 'DRAGON', '3C'], ['4D'], ['5H'], ['6S']]);
  state = act(state, 0, single('DRAGON'));
  for (const seat of [1, 2, 3]) state = settled(act(state, seat, pass));
  assert.equal(state.phase, 'dragon');
  assert.equal(act(state, 1, { type: 'declare' }).declarations[1], 100);
});
/** Seat 0 goes out, then seat 1, then seat 2, leaving seat 3's hand unplayed. */
function normalFinish(to = 0, options) {
  let state = straightDeal(['DRAGON', 'PHOENIX', 'DOG'], options);
  state = act(state, 0, play(['MAHJONG', ...clubs], { wish: 0 }));
  for (const seat of [1, 2, 3]) state = settled(act(state, seat, pass));
  state = act(state, 1, play(rotated(1)));
  for (const seat of [2, 3]) state = settled(act(state, seat, pass));
  state = act(state, 1, single('DRAGON'));
  assert.deepEqual(state.order, [0, 1]);
  for (const seat of [2, 3]) state = settled(act(state, seat, pass));
  state = act(state, 1, { type: 'dragon', to });
  assert.equal(state.turn, 2);
  state = act(state, 2, play(rotated(2)));
  state = settled(act(state, 3, pass));
  return step(state, 2, single('PHOENIX'));
}
test('the third player out ends the round at once', () => {
  const { state, events } = normalFinish();
  assert.equal(state.phase, 'ended');
  const round = state.rounds[0];
  assert.deepEqual(round.order, [0, 1, 2]);
  assert.equal(round.doubleVictory, false);
  assert.ok(events.some((event) => event.type === 'round-ended'));
});
test('the last player gives tricks to the first out, the hand to the opponents', () => {
  const { state } = normalFinish();
  const [north, east] = state.rounds[0].results;
  // Seat 0's straight 25, seat 2's 25 less the Phoenix, the Dragon 25, seat 3's hand 25.
  assert.equal(north.cardPoints, 75);
  assert.equal(east.cardPoints, 25);
  assert.equal(north.cardPoints + east.cardPoints, 100);
});
test('the last hand goes to the opponents, not to a first-out partner', () => {
  let state = playing([
    [...rotated(1), 'PHOENIX'],
    ['MAHJONG', ...clubs],
    [...rotated(2), 'DRAGON'],
    [...rotated(3), 'DOG'],
  ]);
  state = act(state, 1, play(['MAHJONG', ...clubs], { wish: 0 }));
  for (const seat of [2, 3, 0]) state = settled(act(state, seat, pass));
  state = act(state, 2, play(rotated(2)));
  for (const seat of [3, 0]) state = settled(act(state, seat, pass));
  state = act(state, 2, single('DRAGON'));
  for (const seat of [3, 0]) state = settled(act(state, seat, pass));
  state = act(state, 2, { type: 'dragon', to: 3 });
  state = act(state, 3, single(rotated(3)[0]));
  state = act(state, 0, single('PHOENIX'));
  state = settled(act(state, 3, pass));
  state = act(state, 0, play(rotated(1)));
  const [north, east] = state.rounds[0].results;
  assert.deepEqual(state.rounds[0].order, [1, 2, 0]);
  // Seat 3 holds the last hand, and its partner went out first.
  assert.equal(north.cardPoints, 50);
  assert.equal(east.cardPoints, 50);
});
test('where the Dragon goes decides its 25 points', () => {
  const given = normalFinish(2).state.rounds[0].results;
  assert.equal(given[0].cardPoints, 75);
  const scoring = straightDeal(['PHOENIX', 'DRAGON', 'DOG']);
  let state = act(scoring, 0, play(['MAHJONG', ...clubs], { wish: 0 }));
  for (const seat of [1, 2, 3]) state = settled(act(state, seat, pass));
  state = act(state, 1, play(rotated(1)));
  for (const seat of [2, 3]) state = settled(act(state, seat, pass));
  state = act(state, 1, single('PHOENIX'));
  state = act(state, 2, single('DRAGON'));
  state = settled(act(state, 3, pass));
  assert.equal(state.phase, 'dragon');
  state = act(state, 2, { type: 'dragon', to: 3 });
  assert.deepEqual(state.captured[3].slice(-2).sort(), ['DRAGON', 'PHOENIX']);
});
test('a double victory scores 200 to 0 and stops at once', () => {
  let state = straightDeal(['PHOENIX', 'DRAGON', 'DOG']);
  state = act(state, 0, play(['MAHJONG', ...clubs], { wish: 0 }));
  for (const seat of [1, 2, 3]) state = settled(act(state, seat, pass));
  state = act(state, 1, single(rotated(1)[0]));
  state = act(state, 2, single('DRAGON'));
  state = settled(act(state, 3, pass));
  state = settled(act(state, 1, pass));
  state = act(state, 2, { type: 'dragon', to: 3 });
  const ended = act(state, 2, play(rotated(2)));
  const round = ended.rounds[0];
  assert.equal(round.doubleVictory, true);
  assert.deepEqual(round.order, [0, 2]);
  assert.deepEqual(
    round.results.map((item) => item.points),
    [200, 0],
  );
});
test('a declaration wins only for its own caller going out first', () => {
  let state = straightDeal(['DRAGON', 'PHOENIX', 'DOG']);
  state = act(state, 0, { type: 'declare' });
  state = act(state, 2, { type: 'declare' });
  state = act(state, 3, { type: 'declare' });
  state = act(state, 0, play(['MAHJONG', ...clubs], { wish: 0 }));
  for (const seat of [1, 2, 3]) state = settled(act(state, seat, pass));
  state = act(state, 1, play(rotated(1)));
  for (const seat of [2, 3]) state = settled(act(state, seat, pass));
  state = act(state, 1, single('DRAGON'));
  for (const seat of [2, 3]) state = settled(act(state, seat, pass));
  state = act(state, 1, { type: 'dragon', to: 0 });
  state = act(state, 2, play(rotated(2)));
  state = settled(act(state, 3, pass));
  const round = act(state, 2, single('PHOENIX')).rounds[0];
  assert.deepEqual(
    round.results.map((item) => item.declarationPoints),
    [0, -100],
  );
  assert.equal(round.results[0].points, 75);
  assert.equal(round.results[1].points, 25 - 100);
  assert.deepEqual(round.declarations, [100, 0, 100, 100]);
});
test('a failed Grand Tichu costs 200 even in a double victory', () => {
  const final = filled([
    ['MAHJONG', ...clubs],
    [...rotated(1), 'PHOENIX'],
    [...rotated(2), 'DRAGON'],
    [...rotated(3), 'DOG'],
  ]);
  let state = scripted(final);
  state = act(state, 2, { type: 'grand', call: true });
  for (const seat of [0, 1, 3]) state = act(state, seat, noGrand);
  assert.deepEqual(state.declarations, [0, 0, 200, 0]);
  // Everyone hands the same card round in a circle, so the hands barely move.
  for (let seat = 0; seat < 4; seat++)
    state = act(state, seat, {
      type: 'exchange',
      cards: state.hands[seat].slice(-3),
    });
  assert.equal(state.phase, 'play');
  const round = playOut(state, 3, (current) => current.rounds.length > 0)
    .rounds[0];
  const south = round.order[0] === 2 ? 200 : -200;
  assert.equal(
    round.results[0].declarationPoints,
    south,
    'the Grand Tichu counts for the team of its caller',
  );
});
test('single format ends after one round with a clear leader', () => {
  const { state } = normalFinish();
  assert.equal(state.matchOutcome.side, 0);
  assert.deepEqual(state.matchOutcome.winners, [0, 2]);
  assert.deepEqual(state.matchOutcome.winnerIds, ['north', 'south']);
  assert.equal(state.matchOutcome.reason, 'single-round');
});
test('a level single round plays another, with no new entry', () => {
  const { state } = normalFinish(0, { scores: [-50, 0] });
  assert.deepEqual(state.scores, [25, 25]);
  assert.equal(state.phase, 'round-end');
  assert.equal(state.matchOutcome, null);
  assert.equal(act(state, 1, nextRound).phase, 'grand');
});
test('a points format plays on until a team reaches its target', () => {
  const { state } = normalFinish(0, { format: '500' });
  assert.equal(state.phase, 'round-end');
  const done = normalFinish(0, { format: '500', scores: [430, 0] }).state;
  assert.equal(done.phase, 'ended');
  assert.equal(done.matchOutcome.reason, 'target-reached');
  const longer = normalFinish(0, { format: '1000', scores: [430, 0] }).state;
  assert.equal(longer.phase, 'round-end');
});
test('a team over the target still needs the higher score', () => {
  const tied = normalFinish(0, { format: '500', scores: [450, 500] }).state;
  assert.deepEqual(tied.scores, [525, 525]);
  assert.equal(tied.phase, 'round-end');
  const behind = normalFinish(0, { format: '500', scores: [450, 700] }).state;
  assert.equal(behind.matchOutcome.side, 1);
});
test('round-end waits for next from any seat', () => {
  const { state } = normalFinish(0, { format: '500' });
  assert.deepEqual(state.scores, state.rounds[0].scores);
  for (let seat = 0; seat < 4; seat++) {
    assert.deepEqual(legal(state, seat), [nextRound]);
    assert.equal(view(state, seat).yourMove, true);
  }
  rejected(state, 0, pass, 'ILLEGAL_MOVE');
  rejected(state, 3, { type: 'declare' }, 'ILLEGAL_MOVE');
  const next = act(state, 3, nextRound);
  assert.equal(next.roundNumber, 2);
  assert.equal(next.phase, 'grand');
  assert.equal(next.ply, state.ply);
  assert.equal(next.revision, state.revision + 1);
  assert.deepEqual(next.scores, state.scores);
  rejected(next, 3, nextRound, 'ILLEGAL_MOVE');
});
test('a finished match refuses next', () => {
  const { state } = normalFinish();
  rejected(state, 0, nextRound, 'GAME_ENDED');
  rejected(state, 0, pass, 'GAME_ENDED');
  assert.deepEqual(legal(state, 0), []);
});
function checkRound(state, _before, events) {
  if (state.phase === 'play' || state.phase === 'bomb-window') {
    assert.equal(allCards(state).length, 56);
    assert.equal(new Set(allCards(state)).size, 56);
  }
  for (const event of events)
    if (event.type === 'round-ended' && !event.outcome.doubleVictory) {
      const cards = event.outcome.results.map((item) => item.cardPoints);
      assert.equal(cards[0] + cards[1], 100);
    }
}
test('random single matches keep every card accounted for and always end', () => {
  for (let n = 0; n < 8; n++) {
    const end = playOut(start(n), n + 9, () => false, checkRound);
    assert.equal(end.phase, 'ended');
    assert.notEqual(end.scores[0], end.scores[1]);
  }
});
test('random points matches keep going round after round', () => {
  // Random Grand Tichu calls can push both teams down, so these stop at three rounds.
  const end = playOut(
    start(3, '500'),
    9,
    (state) => state.rounds.length === 3,
    checkRound,
  );
  assert.equal(end.rounds.length, 3);
  assert.deepEqual(end.scores, end.rounds[2].scores);
});
test('deck helper deals the promised hands', () => {
  const hands = filled([['MAHJONG']]);
  const state = ok(
    engine.createAnalysisGame({
      players,
      seed: seed(),
      format: 'single',
      decks: [deckOf(hands)],
    }),
  );
  assert.deepEqual(state.hands[0], hands[0].slice(0, 8));
});
