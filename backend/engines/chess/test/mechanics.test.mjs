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
  moves,
  hasMove,
} from './helpers.mjs';
import { isAttacked, squareIndex } from '../dist/esm/position.js';

test('initial standard position has twenty board moves, explicit colors and complete counters', () => {
  const state = start();
  assert.equal(state.fen, e.START_FEN);
  assert.equal(moves(state).length, 20);
  assert.equal(state.turn, 'white');
  assert.equal(state.ply, 0);
  assert.equal(state.positionHistory.length, 1);
  assert.deepEqual(state.movesByColor, { white: 0, black: 0 });
});
test('moves are immutable and FEN tracks raw double-push en-passant plus side/fullmove', () => {
  const root = start(),
    state = sequence(root, ['e2e4', 'e7e5']);
  assert.equal(root.fen, e.START_FEN);
  assert.equal(
    state.fen,
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
  );
  assert.equal(state.positionHistory.at(-1).split(' ')[3], '-');
  assert.equal(state.ply, 2);
  assert.equal(state.revision, 2);
});
test('players cannot pass, move twice, impersonate an opponent, or use unsupported actions', () => {
  let state = start();
  rejected(state, move('e7', 'e5'), 'NOT_YOUR_TURN', 'bob');
  rejected(state, move('e7', 'e5'), 'ILLEGAL_MOVE', 'alice');
  rejected(state, move('e2', 'e4'), 'UNKNOWN_PLAYER', 'mallory');
  rejected(state, { type: 'pass' }, 'INVALID_ACTION');
  rejected(state, { type: 'timeout' }, 'INVALID_ACTION');
  rejected(state, { type: 'disconnect' }, 'INVALID_ACTION');
  rejected(state, { type: 'undo' }, 'INVALID_ACTION');
  state = play(state, move('e2', 'e4'));
  rejected(state, move('d2', 'd4'), 'NOT_YOUR_TURN', 'alice');
});
for (const [name, action] of [
  ['pawn three-square move', move('e2', 'e5')],
  ['pawn diagonal without capture', move('e2', 'f3')],
  ['blocked bishop', move('c1', 'h6')],
  ['blocked rook', move('a1', 'a4')],
  ['blocked queen', move('d1', 'd3')],
  ['own-piece capture', move('e1', 'e2')],
  ['knight non-L move', move('b1', 'b3')],
  ['empty origin', move('a3', 'a4')],
  ['irrelevant promotion', move('g1', 'f3', 'q')],
])
  test(`rejects ${name}`, () => rejected(start(), action, 'ILLEGAL_MOVE'));
test('knight jumps over pieces while sliders do not', () =>
  assert.ok(hasMove(start(), 'b1c3')));
test('pawn cannot move backward or double-push off its starting rank', () => {
  const state = sequence(start(), ['e2e3', 'a7a6']);
  rejected(state, move('e3', 'e2'), 'ILLEGAL_MOVE');
  rejected(state, move('e3', 'e5'), 'ILLEGAL_MOVE');
});
test('king cannot enter check or move next to the other king', () => {
  const state = setup('8/8/8/8/8/4k3/8/R3K3 w - - 0 1');
  rejected(state, move('e1', 'e2'), 'ILLEGAL_MOVE');
});
test('a pinned rook cannot expose its king', () => {
  const state = setup('k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1');
  rejected(state, move('e2', 'f2'), 'ILLEGAL_MOVE');
  assert.ok(hasMove(state, 'e2e8'));
});
test('pinned enemy pieces still attack squares for king safety', () => {
  const state = setup('4k3/4n3/8/8/2K5/8/4R3/8 w - - 0 1');
  assert.equal(
    isAttacked(e.parseFen(state.fen).board, squareIndex('d5'), 'black'),
    true,
  );
  rejected(state, move('c4', 'd5'), 'ILLEGAL_MOVE');
});
test('double check permits only king moves', () => {
  const state = setup('4r2k/8/8/8/1b6/8/8/R3K3 w - - 0 1');
  assert.ok(moves(state).length > 0);
  assert.ok(moves(state).every((m) => m.from === 'e1'));
});
test('both white castlings relocate rook and irreversibly remove both rights', () => {
  for (const [to, board] of [
    ['g1', 'R4RK1'],
    ['c1', '2KR3R'],
  ]) {
    const state = setup('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const result = e.applyAction(state, 'alice', move('e1', to));
    const next = ok(result);
    assert.equal(next.fen.split(' ')[0].split('/').at(-1), board);
    assert.equal(next.fen.split(' ')[2], 'kq');
    assert.equal(
      result.events.find((x) => x.type === 'move-played').san,
      to === 'g1' ? 'O-O' : 'O-O-O',
    );
  }
});
test('both black castlings use correct files, fullmove and rights', () => {
  for (const [to, board] of [
    ['g8', 'r4rk1'],
    ['c8', '2kr3r'],
  ]) {
    const next = play(
      setup('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1'),
      move('e8', to),
    );
    assert.equal(next.fen.split(' ')[0].split('/')[0], board);
    assert.equal(next.fen.split(' ')[2], 'KQ');
    assert.equal(next.fen.split(' ')[5], '2');
  }
});
for (const [name, fen, destination] of [
  ['through check', '4kr2/8/8/8/8/8/8/4K2R w K - 0 1', 'g1'],
  ['into check', '4k1r1/8/8/8/8/8/8/4K2R w K - 0 1', 'g1'],
  ['out of check', 'k3r3/8/8/8/8/8/8/4K2R w K - 0 1', 'g1'],
  ['blocked b-file', '4k3/8/8/8/8/8/8/RN2K3 w Q - 0 1', 'c1'],
  ['without rights', '4k3/8/8/8/8/8/8/R3K2R w - - 0 1', 'g1'],
])
  test(`cannot castle ${name}`, () =>
    rejected(setup(fen), move('e1', destination), 'ILLEGAL_MOVE'));
test('an attacked rook does not prevent kingside castling', () =>
  assert.ok(hasMove(setup('4k2r/8/8/8/8/8/8/4K2R w K - 0 1'), 'e1g1')));
test('an attacked b1 does not prevent queenside castling', () =>
  assert.ok(hasMove(setup('1r2k3/8/8/8/8/8/8/R3K3 w Q - 0 1'), 'e1c1')));
test('returning a moved rook does not restore castling rights', () => {
  const state = sequence(setup('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'), [
    'h1h2',
    'a8a7',
    'h2h1',
    'a7a8',
  ]);
  assert.equal(state.fen.split(' ')[2], 'Qk');
  rejected(state, move('e1', 'g1'), 'ILLEGAL_MOVE');
});
test('returning a moved king does not restore either castling right', () => {
  const state = sequence(setup('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'), [
    'e1f1',
    'e8f8',
    'f1e1',
    'f8e8',
  ]);
  assert.equal(state.fen.split(' ')[2], '-');
});
test('capturing a rook on its original square removes only the relevant right', () => {
  const state = play(
    setup('r3k2r/1B6/8/8/8/8/8/4K3 w kq - 0 1'),
    move('b7', 'a8'),
  );
  assert.equal(state.fen.split(' ')[2], 'k');
});
test('en passant captures the adjacent pawn, not an imaginary target-square piece', () => {
  const state = play(
    setup('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2'),
    move('e5', 'd6'),
  );
  const position = e.parseFen(state.fen);
  assert.equal(position.board[squareIndex('d5')], null);
  assert.equal(position.board[squareIndex('d6')], 'P');
  assert.equal(position.halfmove, 0);
  assert.equal(position.ep, null);
});
test('en passant expires after any other move', () => {
  const state = sequence(setup('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2'), [
    'e1f1',
    'e8f8',
  ]);
  rejected(state, move('e5', 'd6'), 'ILLEGAL_MOVE');
});
test('en passant cannot expose a horizontal rook attack on the king', () => {
  const state = setup('4k3/8/8/r4pPK/8/8/8/8 w - f6 0 2');
  rejected(state, move('g5', 'f6'), 'ILLEGAL_MOVE');
  assert.equal(e.positionKey(e.parseFen(state.fen)).split(' ')[3], '-');
});
test('en passant cannot expose a vertical rook attack', () => {
  const state = setup('k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
  rejected(state, move('e5', 'd6'), 'ILLEGAL_MOVE');
});
test('en passant can remove the checking pawn', () => {
  const state = setup('4k3/8/8/3pP3/4K3/8/8/8 w - d6 0 2');
  assert.equal(ok(e.getObservation(state, 'alice')).inCheck, true);
  assert.ok(hasMove(state, 'e5d6'));
  play(state, move('e5', 'd6'));
});
for (const promotion of ['q', 'r', 'b', 'n']) {
  test(`white explicit ${promotion} promotion`, () => {
    const state = play(
      setup('7k/P7/8/8/8/8/8/7K w - - 0 1'),
      move('a7', 'a8', promotion),
    );
    assert.equal(
      e.parseFen(state.fen).board[squareIndex('a8')],
      promotion.toUpperCase(),
    );
  });
  test(`black explicit ${promotion} promotion`, () => {
    const state = play(
      setup('7k/8/8/8/8/8/p7/7K b - - 0 1'),
      move('a2', 'a1', promotion),
    );
    assert.equal(e.parseFen(state.fen).board[0], promotion);
  });
  test(`capture promotion to ${promotion}`, () => {
    const state = play(
      setup('1r5k/P7/8/8/8/8/8/7K w - - 0 1'),
      move('a7', 'b8', promotion),
    );
    assert.equal(
      e.parseFen(state.fen).board[squareIndex('b8')],
      promotion.toUpperCase(),
    );
    assert.equal(e.parseFen(state.fen).board[squareIndex('a7')], null);
  });
}
test('promotion is mandatory and never silently defaults to queen', () => {
  const state = setup('7k/P7/8/8/8/8/8/7K w - - 0 1');
  assert.equal(moves(state).filter((m) => m.from === 'a7').length, 4);
  rejected(state, move('a7', 'a8'), 'PROMOTION_REQUIRED');
  rejected(state, move('a7', 'a8', 'k'), 'INVALID_ACTION');
});
test('captures and pawn moves reset the halfmove clock', () => {
  for (const [fen, action] of [
    ['4k3/8/8/8/8/8/p7/R3K3 w - - 99 60', move('a1', 'a2')],
    ['4k3/8/8/8/8/8/P7/R3K3 w - - 99 60', move('a2', 'a3')],
  ])
    assert.equal(e.parseFen(play(setup(fen), action).fen).halfmove, 0);
});
test('castling and ordinary non-captures increment the halfmove clock', () => {
  const state = play(
    setup('4k3/8/8/8/8/8/8/4K2R w K - 30 30'),
    move('e1', 'g1'),
  );
  assert.equal(e.parseFen(state.fen).halfmove, 31);
});
test('SAN disambiguates by origin file when either knight can reach d2', () => {
  const state = setup('4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1');
  const result = e.applyAction(state, 'alice', move('b1', 'd2'));
  ok(result);
  assert.equal(result.events[0].san, 'Nbd2');
});
test('SAN disambiguates by origin rank for same-file rooks', () => {
  const state = setup('4k3/8/8/8/8/R7/8/R3K3 w - - 0 1');
  const result = e.applyAction(state, 'alice', move('a1', 'a2'));
  ok(result);
  assert.equal(result.events[0].san, 'R1a2');
});
test('SAN excludes an absolutely pinned alternative from disambiguation', () => {
  const state = setup('4r2k/8/8/8/8/8/R3R3/4K3 w - - 0 1');
  const result = e.applyAction(state, 'alice', move('a2', 'd2'));
  ok(result);
  assert.equal(result.events[0].san, 'Rd2');
});
