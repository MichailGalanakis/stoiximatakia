import { test } from 'node:test';
import {
  engine as e,
  assert,
  ok,
  start,
  setup,
  move,
  play,
  sequence,
  rejected,
  cycle,
  hasMove,
} from './helpers.mjs';

test('Fool’s mate ends the round and match separately and rejects all later actions', () => {
  let state = sequence(start(), ['f2f3', 'e7e5', 'g2g4']);
  const result = e.applyAction(state, 'bob', move('d8', 'h4'), state.revision);
  state = ok(result);
  assert.equal(result.events[0].san, 'Qh4#');
  assert.deepEqual(
    result.events.slice(-2).map((x) => x.type),
    ['round-ended', 'match-ended'],
  );
  assert.equal(state.roundOutcome.reason, 'checkmate');
  assert.equal(state.roundOutcome.winner, 'black');
  assert.equal(state.matchOutcome.reason, 'single-game-complete');
  assert.deepEqual(
    state.roundOutcome.scores.map((x) => x.points),
    [0, 1],
  );
  rejected(state, move('e2', 'e4'), 'GAME_ENDED');
  rejected(state, { type: 'resign' }, 'GAME_ENDED');
});
test('stalemate is a draw, not a loss', () => {
  const state = setup('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.equal(state.roundOutcome.reason, 'stalemate');
  assert.equal(state.roundOutcome.winner, null);
  assert.deepEqual(
    state.roundOutcome.scores.map((x) => x.points),
    [0.5, 0.5],
  );
});
for (const [name, fen] of [
  ['bare kings', '4k3/8/8/8/8/8/8/4K3 w - - 0 1'],
  ['single bishop', '4k3/8/8/8/8/8/8/2B1K3 w - - 0 1'],
  ['single knight', '4k3/8/8/8/8/8/8/1N2K3 w - - 0 1'],
  [
    'same-colored bishops on opposite sides',
    '4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1',
  ],
  [
    'multiple same-colored bishops including promotions',
    '4kb2/8/8/8/8/6B1/8/2B1K3 w - - 0 1',
  ],
])
  test(`material dead-position certificate: ${name}`, () =>
    assert.equal(setup(fen).roundOutcome.reason, 'dead-position-material'));
for (const [name, fen] of [
  ['two knights', '4k3/8/8/8/8/8/8/1N2K1N1 w - - 0 1'],
  ['bishop and knight', '4k3/8/8/8/8/8/8/1NB1K3 w - - 0 1'],
  ['opposite-colored bishops', '2b1k3/8/8/8/8/8/8/2B1K3 w - - 0 1'],
  ['opposing knights', '1n2k3/8/8/8/8/8/8/1N2K3 w - - 0 1'],
  ['one pawn', '4k3/8/8/8/8/8/P7/4K3 w - - 0 1'],
])
  test(`does not conflate cannot force mate with impossible mate: ${name}`, () =>
    assert.equal(setup(fen).phase, 'playing'));
test('rulebook’s two-knight legal continuation actually checkmates', () => {
  const state = sequence(setup('4N1k1/8/6K1/4N3/8/8/8/8 w - - 0 1'), [
    'e8f6',
    'g8h8',
    'e5f7',
  ]);
  assert.equal(state.roundOutcome.reason, 'checkmate');
  assert.equal(state.roundOutcome.winner, 'white');
});
test('a capture can create an immediately dead position', () => {
  const state = setup('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1');
  const next = play(state, move('e1', 'e2'));
  assert.equal(next.roundOutcome.reason, 'dead-position-material');
});
test('threefold is claimable, not automatic', () => {
  const state = sequence(start(), [...cycle, ...cycle]);
  assert.equal(state.phase, 'playing');
  assert.ok(
    ok(e.getDrawClaims(state, 'alice')).current.includes(
      'threefold-repetition',
    ),
  );
  const next = play(state, {
    type: 'claim-draw',
    reason: 'threefold-repetition',
  });
  assert.equal(next.roundOutcome.reason, 'threefold-repetition');
  assert.equal(next.ply, 8);
});
test('a threefold claim on an intended move does not play the move', () => {
  const state = sequence(start(), [...cycle, ...cycle.slice(0, 3)]),
    beforeFen = state.fen;
  const claims = ok(e.getDrawClaims(state, 'bob'));
  assert.ok(
    claims.byIntendedMove.some(
      (c) => c.reason === 'threefold-repetition' && e.uci(c.move) === 'f6g8',
    ),
  );
  const next = play(state, {
    type: 'claim-draw',
    reason: 'threefold-repetition',
    intendedMove: { from: 'f6', to: 'g8' },
  });
  assert.equal(next.fen, beforeFen);
  assert.equal(next.ply, 7);
  assert.equal(next.roundOutcome.reason, 'threefold-repetition');
});
test('fourfold is still playable; fifth occurrence ends automatically', () => {
  const fourth = sequence(start(), [...cycle, ...cycle, ...cycle]);
  assert.equal(fourth.phase, 'playing');
  const fifth = sequence(fourth, cycle);
  assert.equal(fifth.roundOutcome.reason, 'fivefold-repetition');
  assert.equal(fifth.ply, 16);
});
test('position identity includes side to move and castling rights, ignores counters', () => {
  const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  const key = e.positionKey(e.parseFen(fen));
  assert.notEqual(key, e.positionKey(e.parseFen(fen.replace(' w ', ' b '))));
  assert.notEqual(key, e.positionKey(e.parseFen(fen.replace('KQkq', '-'))));
  assert.equal(key, e.positionKey(e.parseFen(fen.replace('0 1', '41 65'))));
});
test('legal en-passant availability distinguishes repetition positions', () => {
  const fen = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2';
  assert.notEqual(
    e.positionKey(e.parseFen(fen)),
    e.positionKey(e.parseFen(fen.replace('d6', '-'))),
  );
});
test('pinned/unusable en-passant does not distinguish repetition positions', () => {
  const fen = 'k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 2';
  assert.equal(
    e.positionKey(e.parseFen(fen)),
    e.positionKey(e.parseFen(fen.replace('d6', '-'))),
  );
});
test('repetition after losing blocked castling rights starts a new equivalence class', () => {
  const initial = setup('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const state = sequence(initial, ['e1f1', 'e8f8', 'f1e1', 'f8e8']);
  assert.notEqual(state.positionHistory[0], state.positionHistory[4]);
});
test('fifty-move threshold is 100 plies and requires a claim', () => {
  const state = setup('4k3/8/8/8/8/8/8/R3K3 w - - 100 70');
  assert.equal(state.phase, 'playing');
  assert.ok(ok(e.getDrawClaims(state, 'alice')).current.includes('fifty-move'));
  assert.equal(
    play(state, { type: 'claim-draw', reason: 'fifty-move' }).roundOutcome
      .reason,
    'fifty-move',
  );
});
test('fifty-move intended claim is checked on a legal hypothetical move', () => {
  const state = setup('4k3/8/8/8/8/8/8/R3K3 w - - 99 70');
  const next = play(state, {
    type: 'claim-draw',
    reason: 'fifty-move',
    intendedMove: { from: 'a1', to: 'a2' },
  });
  assert.equal(next.fen, state.fen);
  assert.equal(next.ply, 0);
  assert.equal(next.roundOutcome.reason, 'fifty-move');
});
test('an intended pawn move cannot satisfy a fifty-move claim', () => {
  const state = setup('4k3/8/8/8/8/8/P7/R3K3 w - - 99 70');
  const result = e.applyAction(state, 'alice', {
    type: 'claim-draw',
    reason: 'fifty-move',
    intendedMove: { from: 'a2', to: 'a3' },
  });
  const next = ok(result);
  assert.equal(next.phase, 'playing');
  assert.ok(result.events.some((x) => x.type === 'draw-claim-rejected'));
  assert.deepEqual(next.forcedMove, { from: 'a2', to: 'a3' });
});
test('incorrect intended claims are draw offers and bind the intended move without clock penalties', () => {
  const state = start();
  const result = e.applyAction(state, 'alice', {
    type: 'claim-draw',
    reason: 'threefold-repetition',
    intendedMove: { from: 'e2', to: 'e4' },
  });
  const next = ok(result);
  assert.equal(next.drawOffer.by, 'white');
  assert.equal(next.fen, state.fen);
  assert.equal(next.ply, 0);
  assert.equal(
    result.events.find((x) => x.type === 'draw-claim-rejected')
      .clockPenaltyApplied,
    false,
  );
  assert.equal(
    ok(e.getLegalActions(next, 'alice')).filter((x) => x.type === 'move')
      .length,
    1,
  );
  rejected(next, move('d2', 'd4'), 'FORCED_MOVE');
  rejected(
    next,
    {
      type: 'claim-draw',
      reason: 'fifty-move',
      intendedMove: { from: 'd2', to: 'd4' },
    },
    'FORCED_MOVE',
  );
  const moved = play(next, move('e2', 'e4'));
  assert.equal(moved.forcedMove, null);
});
test('invalid intended moves are rejected atomically, not treated as formal failed claims', () => {
  rejected(
    start(),
    {
      type: 'claim-draw',
      reason: 'threefold-repetition',
      intendedMove: { from: 'e2', to: 'e5' },
    },
    'ILLEGAL_MOVE',
  );
});
test('a claim belongs to the player to move, not the previous mover', () => {
  rejected(
    sequence(start(), [...cycle, ...cycle]),
    { type: 'claim-draw', reason: 'threefold-repetition' },
    'NOT_YOUR_TURN',
    'bob',
  );
});
test('75 moves by each side produce an automatic draw', () => {
  const state = play(
    setup('4k3/8/8/8/8/8/8/R3K3 w - - 149 80'),
    move('a1', 'a2'),
  );
  assert.equal(state.roundOutcome.reason, 'seventy-five-move');
});
test('checkmate on ply 150 takes precedence over automatic 75-move draw', () => {
  const state = play(
    setup('7k/5Q2/6K1/8/8/8/8/8 w - - 149 80'),
    move('f7', 'g7'),
  );
  assert.equal(e.parseFen(state.fen).halfmove, 150);
  assert.equal(state.roundOutcome.reason, 'checkmate');
  assert.equal(state.roundOutcome.winner, 'white');
});
test('a checkmated analysis root also takes precedence over its counter', () => {
  assert.equal(
    setup('7k/6Q1/6K1/8/8/8/8/8 b - - 150 80').roundOutcome.reason,
    'checkmate',
  );
});
test('mate-in-one remains legal despite a claimable fifty-move draw', () => {
  const state = setup('7k/5Q2/6K1/8/8/8/8/8 w - - 100 80');
  assert.ok(hasMove(state, 'f7g7'));
  assert.equal(play(state, move('f7', 'g7')).roundOutcome.kind, 'win');
});
test('draw agreement requires a real opponent offer and at least one move each', () => {
  const offered = play(start(), { type: 'offer-draw' });
  rejected(offered, { type: 'accept-draw' }, 'OWN_DRAW_OFFER', 'alice');
  rejected(offered, { type: 'accept-draw' }, 'DRAW_TOO_EARLY', 'bob');
  rejected(start(), { type: 'accept-draw' }, 'NO_DRAW_OFFER');
});
test('draw offer attached to a move can be accepted after each side has moved', () => {
  const state = sequence(start(), ['e2e4']);
  const offered = play(state, { ...move('e7', 'e5'), offerDraw: true });
  const next = play(offered, { type: 'accept-draw' }, 'alice');
  assert.equal(next.roundOutcome.reason, 'draw-agreement');
  assert.equal(next.ply, 2);
});
test('an offer survives its own maker’s move but an opponent move declines it', () => {
  let state = play(start(), { type: 'offer-draw' });
  state = play(state, move('e2', 'e4'));
  assert.equal(state.drawOffer.by, 'white');
  state = play(state, move('e7', 'e5'));
  assert.equal(state.drawOffer, null);
});
test('offers may be made out of turn but cannot be withdrawn or duplicated', () => {
  const state = play(start(), { type: 'offer-draw' }, 'bob');
  assert.equal(state.turn, 'white');
  rejected(state, { type: 'decline-draw' }, 'OWN_DRAW_OFFER', 'bob');
  rejected(state, { type: 'offer-draw' }, 'DRAW_OFFER_PENDING', 'alice');
  const declined = play(state, { type: 'decline-draw' }, 'alice');
  assert.equal(declined.drawOffer, null);
});
