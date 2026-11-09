/** Sufficient dead-position proof by a finite joint-king over-approximation. */
import type { Color, PieceSymbol, Square } from './types.js';
import {
  advance,
  colorOf,
  fileOf,
  inCheck,
  legalBoardMoves,
  opposite,
  parseFen,
  rankOf,
  squareName,
  type Position,
} from './position.js';
import { canLeave } from './locked.js';

export interface KingCorridorCertificate {
  readonly kind: 'terminal-king-corridor';
  readonly bishopOwner: Color;
  readonly bishopParity: 0 | 1;
  readonly blockers: readonly {
    readonly piece: PieceSymbol;
    readonly square: Square;
  }[];
  readonly states: number;
  readonly terminalFrontier: readonly {
    readonly from: Square;
    readonly to: Square;
    readonly otherKing: Square;
    readonly capture: boolean;
  }[];
}
const parity = (sq: number): 0 | 1 => ((fileOf(sq) + rankOf(sq)) % 2) as 0 | 1;
const kingSquare = (p: Position, color: Color): number =>
  p.board.indexOf(color === 'white' ? 'K' : 'k');

/**
 * Before the first fixed-piece change, erase one side's same-complex bishops.
 * This enlarges king mobility; bishop moves become waits for their owner only.
 * Every potential mate must still have a king escape that no erased bishop can
 * occupy or attack. A wall-breaking king move is permitted only as a proved
 * terminal stalemate: it has no relaxed reply and cannot newly discover check.
 * null declines this sufficient theorem; it never asserts mate is possible.
 */
export function kingCorridorCertificate(
  position: Position,
): KingCorridorCertificate | null {
  if (
    position.castling ||
    position.ep !== null ||
    inCheck(position, 'white') ||
    inCheck(position, 'black')
  )
    return null;
  for (const owner of ['white', 'black'] as const) {
    const bishops = position.board.flatMap((piece, sq) =>
      piece?.toLowerCase() === 'b' && colorOf(piece) === owner ? [sq] : [],
    );
    if (
      !bishops.length ||
      bishops.some((sq) => parity(sq) !== parity(bishops[0]!))
    )
      continue;
    const complex = parity(bishops[0]!),
      erased = new Set(bishops),
      fixed = new Set(
        position.board.flatMap((piece, sq) =>
          piece && piece.toLowerCase() !== 'k' && !erased.has(sq) ? [sq] : [],
        ),
      );
    // Fixed geometry is checked without either king or any mobile bishop.
    if (
      ![...fixed].some((sq) => position.board[sq]!.toLowerCase() === 'p') ||
      [...fixed].some((sq) => canLeave(position, fixed, sq))
    )
      continue;
    // A bishop cannot capture an opposite-complex fixed unit. Pawn captures
    // preserve square colour, so enemy pawns cannot capture an offered bishop.
    if (
      [...fixed].some(
        (sq) =>
          colorOf(position.board[sq]!) !== owner && parity(sq) === complex,
      )
    )
      continue;
    const enemy = opposite(owner),
      root: Position = {
        ...position,
        board: position.board.map((piece, sq) =>
          erased.has(sq) ? null : piece,
        ),
        halfmove: 0,
        fullmove: 1,
      },
      queue = [root],
      seen = new Set<string>(),
      frontier: {
        from: Square;
        to: Square;
        otherKing: Square;
        capture: boolean;
      }[] = [];
    let valid = true;
    for (let index = 0; valid && index < queue.length; index++) {
      const state = queue[index]!,
        ownKing = kingSquare(state, owner),
        otherKing = kingSquare(state, enemy),
        key = `${ownKing}:${otherKing}:${state.turn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const moves = legalBoardMoves(state);
      if (moves.some((move) => state.board[move.from]!.toLowerCase() !== 'k')) {
        valid = false;
        break;
      }
      if (
        state.turn === enemy &&
        (parity(otherKing) === complex || inCheck(state))
      ) {
        // Empty opposite-complex destinations remain empty and unattacked by
        // every possible placement of the erased bishops, including captures.
        const safe = moves.some(
          (move) =>
            state.board[move.to] === null && parity(move.to) !== complex,
        );
        if (!safe) {
          valid = false;
          break;
        }
      }
      if (state.turn === owner) queue.push({ ...state, turn: enemy });
      for (const move of moves) {
        const capture = fixed.has(move.to),
          after = advance(state, move);
        if (state.turn === owner) {
          const replies = legalBoardMoves(after);
          const cannotDiscover =
            parity(otherKing) !== complex ||
            Math.abs(fileOf(move.from) - fileOf(otherKing)) !==
              Math.abs(rankOf(move.from) - rankOf(otherKing));
          if (!replies.length && !inCheck(after) && cannotDiscover) {
            // In every REAL owner-turn predecessor the other king is not in
            // check. The moving king cannot check it; the occupied destination
            // stays occupied, and the vacated source cannot open a bishop ray.
            frontier.push({
              from: squareName(move.from),
              to: squareName(move.to),
              otherKing: squareName(otherKing),
              capture,
            });
            continue;
          }
        }
        if (capture) {
          valid = false;
          break;
        }
        queue.push(after);
      }
    }
    if (valid)
      return {
        kind: 'terminal-king-corridor',
        bishopOwner: owner,
        bishopParity: complex,
        blockers: [...fixed]
          .sort((a, b) => a - b)
          .map((sq) => ({
            piece: position.board[sq]!,
            square: squareName(sq),
          })),
        states: seen.size,
        terminalFrontier: frontier,
      };
  }
  return null;
}

/** Diagnostic only. Recompute from the authoritative position, never trust input proof claims. */
export function analyzeKingCorridor(
  fen: string,
): KingCorridorCertificate | null {
  return kingCorridorCertificate(parseFen(fen));
}
