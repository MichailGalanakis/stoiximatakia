/**
 * Standard chess position mechanics, independently implemented.
 * a1 = 0, b1 = 1, ..., h8 = 63. Piece case denotes color.
 * This module knows nothing about players, matches, claims, or transport.
 */
import type {
  Color,
  MoveSpec,
  PieceSymbol,
  Promotion,
  Square,
} from './types.js';
import { fail, object, keys } from './errors.js';

export interface Position {
  board: (PieceSymbol | null)[];
  turn: Color;
  castling: string;
  ep: number | null;
  halfmove: number;
  fullmove: number;
}
export interface BoardMove {
  from: number;
  to: number;
  promotion?: Promotion;
  /** The captured pawn's square, not the destination square. */
  enPassant?: number;
  castle?: 'king' | 'queen';
}
const KNIGHT = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
] as const;
const DIAGONAL = [
  [1, 1],
  [1, -1],
  [-1, -1],
  [-1, 1],
] as const;
const ORTHOGONAL = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
] as const;
const ALL_DIRECTIONS = [...DIAGONAL, ...ORTHOGONAL];
const PROMOTIONS = ['q', 'r', 'b', 'n'] as const;
const SQUARE = /^[a-h][1-8]$/u;
const FILES = 'abcdefgh';
/** Shared import/committed-snapshot counter bound; not a chess termination rule. */
export const MAX_FEN_COUNTER = 1_000_000;
export const opposite = (color: Color): Color =>
  color === 'white' ? 'black' : 'white';
export const fileOf = (sq: number): number => sq % 8;
export const rankOf = (sq: number): number => Math.floor(sq / 8);
export const colorOf = (piece: PieceSymbol): Color =>
  piece === piece.toUpperCase() ? 'white' : 'black';
export const symbol = (type: string, color: Color): PieceSymbol =>
  (color === 'white' ? type.toUpperCase() : type.toLowerCase()) as PieceSymbol;
export function squareName(sq: number): Square {
  return `${FILES[fileOf(sq)]}${rankOf(sq) + 1}` as Square;
}
export function squareIndex(sq: string): number {
  return FILES.indexOf(sq[0]!) + 8 * (Number(sq[1]) - 1);
}
function inside(f: number, r: number): boolean {
  return f >= 0 && f < 8 && r >= 0 && r < 8;
}

export function parseMove(value: unknown): MoveSpec {
  const o = object(value);
  keys(o, ['from', 'to', 'promotion']);
  if (
    typeof o.from !== 'string' ||
    !SQUARE.test(o.from) ||
    typeof o.to !== 'string' ||
    !SQUARE.test(o.to)
  )
    fail(
      'INVALID_ACTION',
      'Move squares must use lowercase a1–h8 coordinates.',
    );
  if (o.from === o.to) fail('ILLEGAL_MOVE', 'A move must change squares.');
  if ('promotion' in o && !PROMOTIONS.includes(o.promotion as Promotion))
    fail('INVALID_ACTION', 'Promotion must be q, r, b, or n.');
  return {
    from: o.from as Square,
    to: o.to as Square,
    ...('promotion' in o ? { promotion: o.promotion as Promotion } : {}),
  };
}
export function moveSpec(move: BoardMove): MoveSpec {
  return {
    from: squareName(move.from),
    to: squareName(move.to),
    ...(move.promotion ? { promotion: move.promotion } : {}),
  };
}
export function uci(move: MoveSpec): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}
export function sameMove(a: MoveSpec, b: MoveSpec): boolean {
  return a.from === b.from && a.to === b.to && a.promotion === b.promotion;
}

/** Attack maps deliberately include pinned attackers (FIDE 3.1.3). */
export function isAttacked(
  board: readonly (PieceSymbol | null)[],
  square: number,
  by: Color,
): boolean {
  const f = fileOf(square),
    r = rankOf(square);
  const pawnRank = r + (by === 'white' ? -1 : 1);
  for (const df of [-1, 1])
    if (
      inside(f + df, pawnRank) &&
      board[pawnRank * 8 + f + df] === symbol('p', by)
    )
      return true;
  for (const [df, dr] of KNIGHT)
    if (
      inside(f + df, r + dr) &&
      board[(r + dr) * 8 + f + df] === symbol('n', by)
    )
      return true;
  for (const [df, dr] of ALL_DIRECTIONS) {
    let ff = f + df,
      rr = r + dr,
      distance = 1;
    while (inside(ff, rr)) {
      const p = board[rr * 8 + ff];
      if (p) {
        if (colorOf(p) === by) {
          const t = p.toLowerCase();
          if (
            t === 'q' ||
            (t === 'b' && df !== 0 && dr !== 0) ||
            (t === 'r' && (df === 0 || dr === 0)) ||
            (t === 'k' && distance === 1)
          )
            return true;
        }
        break;
      }
      ff += df;
      rr += dr;
      distance++;
    }
  }
  return false;
}
export function inCheck(
  position: Position,
  color: Color = position.turn,
): boolean {
  const king = position.board.indexOf(symbol('k', color));
  if (king < 0) fail('INVALID_FEN', `Missing ${color} king.`);
  return isAttacked(position.board, king, opposite(color));
}

/**
 * Strict syntactic and local legality validation, not a retrograde reachability proof.
 * Imported analysis FENs are trusted scenarios; production resumes use the replayed snapshot.
 */
export function parseFen(fen: unknown): Position {
  if (typeof fen !== 'string' || fen.length > 256)
    fail('INVALID_FEN', 'FEN must be a string of at most 256 characters.');
  const parts = fen.trim().split(/\s+/u);
  if (parts.length !== 6)
    fail('INVALID_FEN', 'FEN must contain all six fields.');
  const [placement, active, rights, ep, half, full] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const rows = placement.split('/');
  if (rows.length !== 8) fail('INVALID_FEN', 'FEN must contain eight ranks.');
  const board: (PieceSymbol | null)[] = Array<PieceSymbol | null>(64).fill(
    null,
  );
  rows.forEach((row, index) => {
    let file = 0,
      lastWasNumber = false;
    for (const c of row) {
      if (/^[1-8]$/u.test(c)) {
        if (lastWasNumber)
          fail(
            'INVALID_FEN',
            'Adjacent empty-square digits are not canonical FEN.',
          );
        file += Number(c);
        lastWasNumber = true;
      } else if (/^[pnbrqkPNBRQK]$/u.test(c)) {
        if (file >= 8) fail('INVALID_FEN', 'A FEN rank exceeds eight squares.');
        board[(7 - index) * 8 + file] = c as PieceSymbol;
        file++;
        lastWasNumber = false;
      } else fail('INVALID_FEN', 'Unknown piece or empty-square symbol.');
    }
    if (file !== 8)
      fail('INVALID_FEN', 'Each FEN rank must contain exactly eight squares.');
  });
  if (active !== 'w' && active !== 'b')
    fail('INVALID_FEN', 'FEN side to move must be w or b.');
  if (
    rights !== '-' &&
    (!/^[KQkq]+$/u.test(rights) || new Set(rights).size !== rights.length)
  )
    fail('INVALID_FEN', 'Invalid or duplicated castling rights.');
  if (!/^(0|[1-9][0-9]*)$/u.test(half) || !/^[1-9][0-9]*$/u.test(full))
    fail('INVALID_FEN', 'Invalid FEN move counters.');
  const halfmove = Number(half),
    fullmove = Number(full);
  if (
    !Number.isSafeInteger(halfmove) ||
    !Number.isSafeInteger(fullmove) ||
    halfmove > MAX_FEN_COUNTER ||
    fullmove > MAX_FEN_COUNTER
  )
    fail('INVALID_FEN', 'FEN move counters exceed the supported bound.');
  const position: Position = {
    board,
    turn: active === 'w' ? 'white' : 'black',
    castling: [...'KQkq'].filter((c) => rights.includes(c)).join(''),
    ep: null,
    halfmove,
    fullmove,
  };
  for (const color of ['white', 'black'] as const) {
    const pieces = board.filter(
      (p): p is PieceSymbol => p !== null && colorOf(p) === color,
    );
    const pawns = pieces.filter((p) => p.toLowerCase() === 'p').length;
    if (pieces.filter((p) => p.toLowerCase() === 'k').length !== 1)
      fail('INVALID_FEN', 'Exactly one king of each color is required.');
    if (pieces.length > 16 || pawns > 8)
      fail('INVALID_FEN', 'Too many pieces or pawns for one color.');
    const excess =
      Math.max(0, pieces.filter((p) => p.toLowerCase() === 'q').length - 1) +
      Math.max(0, pieces.filter((p) => p.toLowerCase() === 'r').length - 2) +
      Math.max(0, pieces.filter((p) => p.toLowerCase() === 'n').length - 2) +
      [0, 1].reduce(
        (sum, parity) =>
          sum +
          Math.max(
            0,
            board.filter(
              (p, sq) =>
                p === symbol('b', color) &&
                (fileOf(sq) + rankOf(sq)) % 2 === parity,
            ).length - 1,
          ),
        0,
      );
    if (excess > 8 - pawns)
      fail(
        'INVALID_FEN',
        'Extra promoted pieces require enough missing pawns.',
      );
  }
  for (let sq = 0; sq < 64; sq++)
    if (
      (rankOf(sq) === 0 || rankOf(sq) === 7) &&
      board[sq]?.toLowerCase() === 'p'
    )
      fail(
        'INVALID_FEN',
        'A pawn cannot remain on its promotion rank or first rank.',
      );
  const whiteKing = board.indexOf('K'),
    blackKing = board.indexOf('k');
  if (
    Math.max(
      Math.abs(fileOf(whiteKing) - fileOf(blackKing)),
      Math.abs(rankOf(whiteKing) - rankOf(blackKing)),
    ) <= 1
  )
    fail('INVALID_FEN', 'Kings cannot be adjacent.');
  for (const [right, kingSq, rookSq, king, rook] of [
    ['K', 4, 7, 'K', 'R'],
    ['Q', 4, 0, 'K', 'R'],
    ['k', 60, 63, 'k', 'r'],
    ['q', 60, 56, 'k', 'r'],
  ] as const) {
    if (
      position.castling.includes(right) &&
      (board[kingSq] !== king || board[rookSq] !== rook)
    )
      fail(
        'INVALID_FEN',
        'Castling rights require the king and rook on their original squares.',
      );
  }
  if (ep !== '-') {
    if (!SQUARE.test(ep) || (active === 'w' ? ep[1] !== '6' : ep[1] !== '3'))
      fail('INVALID_FEN', 'Invalid en-passant target rank.');
    const target = squareIndex(ep),
      pawnSquare = target + (active === 'w' ? -8 : 8),
      origin = target + (active === 'w' ? 8 : -8);
    if (
      board[target] !== null ||
      board[pawnSquare] !== symbol('p', opposite(position.turn)) ||
      board[origin] !== null ||
      halfmove !== 0
    )
      fail(
        'INVALID_FEN',
        'En-passant field is inconsistent with the immediately preceding double pawn move.',
      );
    position.ep = target;
  }
  // The player that just moved cannot have left their king in check.
  if (inCheck(position, opposite(position.turn)))
    fail(
      'INVALID_FEN',
      'The non-moving king is in check: this cannot follow a legal move.',
    );
  return position;
}
export function toFen(position: Position): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = '',
      empty = 0;
    for (let file = 0; file < 8; file++) {
      const p = position.board[rank * 8 + file];
      if (!p) empty++;
      else {
        if (empty) {
          row += empty;
          empty = 0;
        }
        row += p;
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return `${rows.join('/')} ${position.turn === 'white' ? 'w' : 'b'} ${position.castling || '-'} ${position.ep === null ? '-' : squareName(position.ep)} ${position.halfmove} ${position.fullmove}`;
}

/** Apply a generated board move; caller is responsible for legal-move membership. */
export function advance(position: Position, move: BoardMove): Position {
  const board = position.board.slice();
  const piece = board[move.from]!;
  const captured =
    move.enPassant !== undefined ? board[move.enPassant] : board[move.to];
  board[move.from] = null;
  board[move.to] = move.promotion
    ? symbol(move.promotion, position.turn)
    : piece;
  if (move.enPassant !== undefined) board[move.enPassant] = null;
  if (move.castle) {
    const rank = position.turn === 'white' ? 0 : 7;
    const rookFrom = rank * 8 + (move.castle === 'king' ? 7 : 0);
    const rookTo = rank * 8 + (move.castle === 'king' ? 5 : 3);
    board[rookTo] = board[rookFrom]!;
    board[rookFrom] = null;
  }
  let castling = position.castling;
  if (piece.toLowerCase() === 'k')
    castling = castling.replace(
      position.turn === 'white' ? /[KQ]/gu : /[kq]/gu,
      '',
    );
  for (const [sq, right] of [
    [0, 'Q'],
    [7, 'K'],
    [56, 'q'],
    [63, 'k'],
  ] as const) {
    if (move.from === sq || move.to === sq)
      castling = castling.replace(right, '');
  }
  return {
    board,
    turn: opposite(position.turn),
    castling,
    ep:
      piece.toLowerCase() === 'p' && Math.abs(move.to - move.from) === 16
        ? (move.from + move.to) / 2
        : null,
    halfmove:
      piece.toLowerCase() === 'p' || captured ? 0 : position.halfmove + 1,
    fullmove: position.fullmove + (position.turn === 'black' ? 1 : 0),
  };
}
function pseudoMoves(position: Position): BoardMove[] {
  const moves: BoardMove[] = [],
    board = position.board,
    color = position.turn;
  const append = (
    from: number,
    to: number,
    rest: Partial<BoardMove> = {},
  ): void => {
    if (
      board[from]?.toLowerCase() === 'p' &&
      (rankOf(to) === 0 || rankOf(to) === 7)
    ) {
      for (const promotion of PROMOTIONS)
        moves.push({ from, to, ...rest, promotion });
    } else moves.push({ from, to, ...rest });
  };
  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (!piece || colorOf(piece) !== color) continue;
    const type = piece.toLowerCase(),
      f = fileOf(from),
      r = rankOf(from);
    if (type === 'p') {
      const step = color === 'white' ? 1 : -1,
        nextRank = r + step;
      if (!inside(f, nextRank)) continue;
      const one = nextRank * 8 + f;
      if (!board[one]) {
        append(from, one);
        if (r === (color === 'white' ? 1 : 6) && !board[from + step * 16])
          append(from, from + step * 16);
      }
      for (const df of [-1, 1]) {
        if (!inside(f + df, nextRank)) continue;
        const to = nextRank * 8 + f + df,
          target = board[to];
        if (target && colorOf(target) !== color && target.toLowerCase() !== 'k')
          append(from, to);
        else if (
          !target &&
          to === position.ep &&
          board[to - step * 8] === symbol('p', opposite(color))
        )
          append(from, to, { enPassant: to - step * 8 });
      }
    } else if (type === 'n' || type === 'k') {
      for (const [df, dr] of type === 'n' ? KNIGHT : ALL_DIRECTIONS) {
        if (!inside(f + df, r + dr)) continue;
        const to = (r + dr) * 8 + f + df,
          target = board[to];
        if (
          !target ||
          (colorOf(target) !== color && target.toLowerCase() !== 'k')
        )
          append(from, to);
      }
      if (
        type === 'k' &&
        from === (color === 'white' ? 4 : 60) &&
        !inCheck(position)
      ) {
        const base = color === 'white' ? 0 : 56;
        for (const [right, castle, rook, through, destination, empty] of [
          [color === 'white' ? 'K' : 'k', 'king', 7, 5, 6, [5, 6]],
          [color === 'white' ? 'Q' : 'q', 'queen', 0, 3, 2, [1, 2, 3]],
        ] as const) {
          if (
            !position.castling.includes(right) ||
            board[base + rook] !== symbol('r', color) ||
            empty.some((sq) => board[base + sq] !== null)
          )
            continue;
          const transit = board.slice();
          transit[from] = null;
          transit[base + through] = piece;
          if (!isAttacked(transit, base + through, opposite(color)))
            append(from, base + destination, { castle });
        }
      }
    } else {
      const directions =
        type === 'b' ? DIAGONAL : type === 'r' ? ORTHOGONAL : ALL_DIRECTIONS;
      for (const [df, dr] of directions) {
        let ff = f + df,
          rr = r + dr;
        while (inside(ff, rr)) {
          const to = rr * 8 + ff,
            target = board[to];
          if (!target) append(from, to);
          else {
            if (colorOf(target) !== color && target.toLowerCase() !== 'k')
              append(from, to);
            break;
          }
          ff += df;
          rr += dr;
        }
      }
    }
  }
  return moves;
}
export function legalBoardMoves(position: Position): BoardMove[] {
  return pseudoMoves(position).filter(
    (move) => !inCheck(advance(position, move), position.turn),
  );
}
export function findLegalMove(
  position: Position,
  spec: MoveSpec,
  candidates = legalBoardMoves(position),
): BoardMove {
  const from = squareIndex(spec.from),
    to = squareIndex(spec.to);
  const matching = candidates.filter((m) => m.from === from && m.to === to);
  if (
    spec.promotion === undefined &&
    matching.some((m) => m.promotion !== undefined)
  )
    fail(
      'PROMOTION_REQUIRED',
      'Select q, r, b, or n explicitly for promotion.',
    );
  const move = matching.find((m) => m.promotion === spec.promotion);
  if (!move)
    fail('ILLEGAL_MOVE', 'This move is not legal in the current position.');
  return move;
}
/** Canonical FIDE repetition identity. A pinned/unusable en-passant option is omitted. */
export function positionKey(position: Position): string {
  const fields = toFen(position).split(' ');
  let ep = '-';
  if (
    position.ep !== null &&
    legalBoardMoves(position).some((m) => m.enPassant !== undefined)
  )
    ep = squareName(position.ep);
  return `${fields[0]} ${fields[1]} ${fields[2]} ${ep}`;
}
export function san(
  position: Position,
  move: BoardMove,
  candidates = legalBoardMoves(position),
): string {
  let result: string;
  const piece = position.board[move.from]!,
    type = piece.toLowerCase();
  const capture =
    position.board[move.to] !== null || move.enPassant !== undefined;
  if (move.castle) result = move.castle === 'king' ? 'O-O' : 'O-O-O';
  else {
    result =
      type === 'p'
        ? capture
          ? FILES[fileOf(move.from)]!
          : ''
        : type.toUpperCase();
    if (type !== 'p') {
      const competitors = candidates.filter(
        (m) =>
          m.from !== move.from &&
          m.to === move.to &&
          position.board[m.from] === piece,
      );
      if (competitors.length) {
        if (!competitors.some((m) => fileOf(m.from) === fileOf(move.from)))
          result += FILES[fileOf(move.from)];
        else if (!competitors.some((m) => rankOf(m.from) === rankOf(move.from)))
          result += String(rankOf(move.from) + 1);
        else result += squareName(move.from);
      }
    }
    if (capture) result += 'x';
    result += squareName(move.to);
    if (move.promotion) result += `=${move.promotion.toUpperCase()}`;
  }
  const after = advance(position, move);
  if (inCheck(after)) result += legalBoardMoves(after).length ? '+' : '#';
  return result;
}
/** Sound material-only dead-position certificates, not all possible locked positions. */
export function materialDead(position: Position): boolean {
  const nonKings = position.board.flatMap((p, sq) =>
    p && p.toLowerCase() !== 'k' ? [{ p, sq }] : [],
  );
  if (!nonKings.length) return true;
  if (nonKings.some(({ p }) => /[pqr]/iu.test(p))) return false;
  if (nonKings.length === 1) return true; // exactly one bishop or knight
  if (nonKings.every(({ p }) => p.toLowerCase() === 'b')) {
    const parity = (fileOf(nonKings[0]!.sq) + rankOf(nonKings[0]!.sq)) % 2;
    return nonKings.every(({ sq }) => (fileOf(sq) + rankOf(sq)) % 2 === parity);
  }
  return false; // In particular, two knights are NOT an automatic draw.
}
export function hasOnlyKing(position: Position, color: Color): boolean {
  return !position.board.some(
    (p) => p && colorOf(p) === color && p.toLowerCase() !== 'k',
  );
}
/** Conventional move-generator perft: deliberately ignores claimable/automatic draws. */
export function perft(fen: string, depth: number): number {
  if (!Number.isInteger(depth) || depth < 0 || depth > 6)
    fail(
      'INVALID_CONFIG',
      'Perft depth must be 0–6. Use modest depths in an HTTP process.',
    );
  const walk = (p: Position, remaining: number): number => {
    if (remaining === 0) return 1;
    const moves = legalBoardMoves(p);
    if (remaining === 1) return moves.length;
    let total = 0;
    for (const move of moves) total += walk(advance(p, move), remaining - 1);
    return total;
  };
  return walk(parseFen(fen), depth);
}
