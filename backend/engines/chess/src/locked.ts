/**
 * Sufficient, NOT complete, dead-position certificates.
 *
 * Find a simultaneously immobile AND uncapturable set of non-king blockers by
 * descending refinement. Mobile pieces get an over-approximation of every
 * future square, with all other mobile blockers removed. A candidate is kept
 * only when no first legal move/capture can change it. This supports mutually
 * dependent pawn/piece cages, not just pawn-only walls.
 *
 * No current pin, good defence, side-to-move restriction or search cutoff is a
 * proof. Promotion/capturing reserve pawns and actionable exceptional rights
 * are left to the exact graph. Invariant exclusions may prove retained castling
 * rights unusable without changing them.
 */
import type { Color, PieceSymbol, Square } from './types.js';
import {
  colorOf,
  fileOf,
  legalBoardMoves,
  opposite,
  parseFen,
  rankOf,
  squareName,
  type Position,
} from './position.js';
import { maximumMatching } from './matching.js';

const KING = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;
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
  [-1, 1],
  [-1, -1],
] as const;
const STRAIGHT = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const inside = (f: number, r: number): boolean =>
  f >= 0 && f < 8 && r >= 0 && r < 8;
const directions = (type: string) =>
  type === 'n'
    ? KNIGHT
    : type === 'b'
      ? DIAGONAL
      : type === 'r'
        ? STRAIGHT
        : KING;
const sliding = (type: string): boolean =>
  type === 'b' || type === 'r' || type === 'q';
const emptyAttacks = (): Record<Color, Set<number>> => ({
  white: new Set(),
  black: new Set(),
});

export interface LockedPieceRegion {
  readonly piece: PieceSymbol;
  readonly from: Square;
  /** Superset of all squares this surviving MOBILE piece could ever occupy. */
  readonly reachable: readonly Square[];
}
export interface LockedBlocker {
  readonly piece: PieceSymbol;
  readonly square: Square;
}
export interface LockedEscapeSet {
  readonly color: Color;
  readonly from: Square;
  /** All these adjacent squares are permanently unattacked and free of fixed pieces. */
  readonly candidates: readonly Square[];
  /** Upper bound on simultaneously occupied candidates; strictly less than their count. */
  readonly maxOccupants: number;
}
export interface LockedCastlingExclusion {
  readonly right: 'K' | 'Q' | 'k' | 'q';
  /** Fixed pieces between the original king and rook, including b1/b8 for queenside. */
  readonly blockers: readonly Square[];
  /** King start/transit/destination squares under guaranteed fixed enemy attack. */
  readonly attackedKingPath: readonly Square[];
}
export interface LockedPositionCertificate {
  readonly kind:
    | 'permanent-pawn-wall-no-check'
    | 'permanent-pawn-wall-escape-squares'
    | 'permanent-blocker-no-check'
    | 'permanent-blocker-escape-squares'
    | 'permanent-pawn-wall-escape-sets'
    | 'permanent-blocker-escape-sets';
  /** Backward-compatible pawn-only subset of blockers. */
  readonly pawns: readonly Square[];
  /** All simultaneously proved immobile and uncapturable pieces, including pawns. */
  readonly blockers: readonly LockedBlocker[];
  readonly regions: readonly LockedPieceRegion[];
  /** Individually guaranteed safe, empty escapes; other checked squares use escapeSets. */
  readonly escapes: readonly {
    readonly color: Color;
    readonly from: Square;
    readonly to: Square;
  }[];
  /** At least one candidate stays empty; no particular candidate is promised empty. */
  readonly escapeSets: readonly LockedEscapeSet[];
  /** Proof exclusions only. The actual FEN/identity/snapshot castling flags are retained. */
  readonly castlingExclusions: readonly LockedCastlingExclusion[];
  /** Raw root target with no legal EP capture; null when the root has no EP field. */
  readonly unusableEnPassant: Square | null;
}
interface Region {
  piece: PieceSymbol;
  from: number;
  squares: Set<number>;
  attacks: Set<number>;
}

function pawnAttacks(from: number, color: Color): number[] {
  const r = rankOf(from) + (color === 'white' ? 1 : -1),
    result: number[] = [];
  for (const df of [-1, 1]) {
    const f = fileOf(from) + df;
    if (inside(f, r)) result.push(r * 8 + f);
  }
  return result;
}

/**
 * Ignore EVERY mobile blocker and all pins/checks. If a candidate can leave
 * even on this enlarged board, it cannot be used as a permanent obstacle.
 * Only first ray squares are needed: a clear first step already permits motion.
 * Pawn captures of mobile pieces are checked separately against their regions.
 */
export function canLeave(
  position: Position,
  fixed: ReadonlySet<number>,
  from: number,
): boolean {
  const piece = position.board[from]!,
    color = colorOf(piece),
    type = piece.toLowerCase();
  if (type === 'p') {
    if (!fixed.has(from + (color === 'white' ? 8 : -8))) return true;
    return pawnAttacks(from, color).some(
      (sq) => fixed.has(sq) && colorOf(position.board[sq]!) !== color,
    );
  }
  for (const [df, dr] of directions(type)) {
    const f = fileOf(from) + df,
      r = rankOf(from) + dr;
    if (!inside(f, r)) continue;
    const target = r * 8 + f;
    if (!fixed.has(target) || colorOf(position.board[target]!) !== color)
      return true;
  }
  return false;
}

/**
 * Attacks guaranteed regardless of where mobile pieces stand. Pawn/knight
 * attacks cannot be interposed. A slider's ADJACENT ray square is also always
 * attacked; do not use a potentially blockable long ray to exclude king moves.
 * After canLeave has stabilized, all fixed slider rays stop at that first square.
 */
export function invariantAttacks(
  position: Position,
  fixed: ReadonlySet<number>,
): Record<Color, Set<number>> {
  const result = emptyAttacks();
  for (const from of fixed) {
    const piece = position.board[from]!,
      color = colorOf(piece),
      type = piece.toLowerCase();
    if (type === 'p') {
      for (const sq of pawnAttacks(from, color)) result[color].add(sq);
    } else {
      for (const [df, dr] of directions(type)) {
        const f = fileOf(from) + df,
          r = rankOf(from) + dr;
        if (inside(f, r)) result[color].add(r * 8 + f);
      }
    }
  }
  return result;
}

/**
 * Regions assume the candidates persist. Capturable candidates are returned for
 * removal; no certification is possible until refinement reaches a fixed point.
 * Mobile pawns are limited to capture-free, non-promoting file advances. A null
 * result merely declines this sufficient theorem.
 */
function mobileRegions(
  position: Position,
  fixed: ReadonlySet<number>,
  permanentAttacks: Record<Color, Set<number>>,
): { regions: Region[]; removable: Set<number> } | null {
  const regions: Region[] = [],
    removable = new Set<number>();
  for (let from = 0; from < 64; from++) {
    const piece = position.board[from];
    if (!piece || fixed.has(from)) continue;
    const color = colorOf(piece),
      enemy = opposite(color),
      type = piece.toLowerCase();
    const squares = new Set<number>(),
      attacks = new Set<number>();
    if (type === 'p') {
      // Every intermediate square is included, even when a pawn could double
      // step. Capture tests below consequently exclude future en-passant breaks.
      const step = color === 'white' ? 8 : -8;
      for (let sq = from; sq >= 0 && sq < 64 && !fixed.has(sq); sq += step) {
        if (rankOf(sq) === 0 || rankOf(sq) === 7) return null; // possible promotion
        squares.add(sq);
        for (const target of pawnAttacks(sq, color)) {
          attacks.add(target);
          if (fixed.has(target) && colorOf(position.board[target]!) !== color)
            return null;
        }
      }
    } else {
      const king = type === 'k',
        queue = [from];
      squares.add(from);
      for (let index = 0; index < queue.length; index++) {
        const sq = queue[index]!;
        for (const [df, dr] of directions(type)) {
          let f = fileOf(sq) + df,
            r = rankOf(sq) + dr;
          while (inside(f, r)) {
            const target = r * 8 + f;
            attacks.add(target); // includes protected/occupied targets as attacks
            if (fixed.has(target)) {
              if (
                colorOf(position.board[target]!) !== color &&
                (!king || !permanentAttacks[enemy].has(target))
              )
                removable.add(target);
              break;
            }
            if (king && permanentAttacks[enemy].has(target)) break;
            if (!squares.has(target)) {
              squares.add(target);
              queue.push(target);
            }
            if (!sliding(type)) break;
            f += df;
            r += dr;
          }
        }
      }
    }
    regions.push({ piece, from, squares, attacks });
  }
  // A stationary pawn may capture an offered piece. Such a pawn is not fixed,
  // even if no sensible opponent would offer the sacrifice.
  for (const from of fixed) {
    const piece = position.board[from]!;
    if (piece.toLowerCase() !== 'p') continue;
    const color = colorOf(piece),
      attacks = pawnAttacks(from, color);
    for (const region of regions) {
      if (colorOf(region.piece) === color || region.piece.toLowerCase() === 'k')
        continue;
      if (attacks.some((sq) => region.squares.has(sq))) removable.add(from);
    }
  }
  // Captures by mobile reserve pawns would change files, invalidate these regions
  // and possibly allow promotions. Do not guess about their subsequent mobility.
  for (const pawn of regions) {
    if (pawn.piece.toLowerCase() !== 'p') continue;
    for (const target of regions) {
      if (
        target.piece.toLowerCase() === 'k' ||
        colorOf(target.piece) === colorOf(pawn.piece)
      )
        continue;
      for (const sq of target.squares) if (pawn.attacks.has(sq)) return null;
    }
  }
  return { regions, removable };
}

/** Internal pure certificate builder. null means "not certified", NEVER "not dead". */
export function lockedPositionCertificate(
  position: Position,
): LockedPositionCertificate | null {
  // The initial EP option expires after any board move. A currently illegal EP
  // capture cannot become legal first by changing the board and keeping that
  // same entitlement. Future double advances remain covered by mobileRegions.
  if (
    position.ep !== null &&
    legalBoardMoves(position).some((move) => move.enPassant !== undefined)
  )
    return null;
  // Kings are never fixed obstacles. Start with all other pieces, not just pawns:
  // mutually dependent cages may have no pawn-only certificate to build upon.
  const fixed = new Set(
    position.board.flatMap((p, sq) =>
      p && p.toLowerCase() !== 'k' ? [sq] : [],
    ),
  );
  let regions: Region[];
  let permanentAttacks = emptyAttacks();
  for (;;) {
    const moving = [...fixed].filter((sq) => canLeave(position, fixed, sq));
    if (moving.length) {
      for (const sq of moving) fixed.delete(sq);
      continue;
    }
    if (![...fixed].some((sq) => position.board[sq]!.toLowerCase() === 'p'))
      return null;
    permanentAttacks = invariantAttacks(position, fixed);
    const result = mobileRegions(position, fixed, permanentAttacks);
    if (!result) return null;
    if (result.removable.size) {
      for (const sq of result.removable) fixed.delete(sq);
      continue;
    }
    regions = result.regions;
    break;
  }
  // Close the no-first-change argument for castling as well as ordinary moves.
  // A castle cannot be the first change to this candidate invariant if a fixed
  // intervening piece still blocks it, or a guaranteed enemy attack still hits
  // the king's path. Mere current occupancy/mobile attacks are insufficient.
  // Every retained flag must be excluded; rights are NEVER deleted from state.
  const castlingExclusions: LockedCastlingExclusion[] = [];
  for (const flag of position.castling) {
    const right = flag as LockedCastlingExclusion['right'];
    const color = flag === flag.toUpperCase() ? 'white' : 'black';
    const base = color === 'white' ? 0 : 56,
      kingside = flag.toLowerCase() === 'k';
    const blockers = (kingside ? [5, 6] : [1, 2, 3])
      .map((file) => base + file)
      .filter((sq) => fixed.has(sq));
    const attackedKingPath = (kingside ? [4, 5, 6] : [4, 3, 2])
      .map((file) => base + file)
      .filter((sq) => permanentAttacks[opposite(color)].has(sq));
    if (!blockers.length && !attackedKingPath.length) return null;
    castlingExclusions.push({
      right,
      blockers: blockers.map(squareName),
      attackedKingPath: attackedKingPath.map(squareName),
    });
  }
  // No first change to fixed pieces exists. The mobile regions now form an
  // inductive over-approximation. Exclude mate using either no possible check,
  // or an empty, safe escape for EVERY potentially checked king square.
  const escapes: { color: Color; from: Square; to: Square }[] = [];
  const escapeSets: LockedEscapeSet[] = [];
  for (const color of ['white', 'black'] as const) {
    const king = regions.find(
      (r) => r.piece === (color === 'white' ? 'K' : 'k'),
    )!;
    const enemy = opposite(color);
    const checkingAttacks = new Set(permanentAttacks[enemy]),
      allAttacks = new Set(permanentAttacks[enemy]);
    const possiblyOccupied = new Set(fixed);
    for (const region of regions) {
      if (region === king) continue;
      for (const sq of region.squares) possiblyOccupied.add(sq);
      if (colorOf(region.piece) !== enemy) continue;
      for (const sq of region.attacks) {
        allAttacks.add(sq);
        if (region.piece.toLowerCase() !== 'k') checkingAttacks.add(sq);
      }
    }
    for (const sq of king.squares) {
      if (!checkingAttacks.has(sq)) continue;
      let escape: number | null = null;
      const candidates: number[] = [];
      for (const [df, dr] of KING) {
        const f = fileOf(sq) + df,
          r = rankOf(sq) + dr,
          target = r * 8 + f;
        if (!inside(f, r) || fixed.has(target) || allAttacks.has(target))
          continue;
        candidates.push(target);
        if (!possiblyOccupied.has(target)) {
          escape = target;
          break;
        }
      }
      if (escape !== null) {
        escapes.push({ color, from: squareName(sq), to: squareName(escape) });
        continue;
      }
      // Regions are unions of POSSIBLE occupancies, not simultaneous occupants.
      // Every actual occupancy injects distinct original pieces into distinct
      // candidate squares. Even allowing impossible piece combinations, a
      // maximum matching bounds how many candidates can be occupied at once.
      // Captures only remove vertices; supported pawns cannot promote. The
      // moving king is excluded, but all other pieces (including either color
      // and the enemy king) retain their own vertex. A deficient matching proves
      // an empty escape in every concrete position without choosing one square.
      const occupants = regions
        .filter((region) => region !== king)
        .map((region) => region.squares);
      const maxOccupants = maximumMatching(candidates, occupants);
      if (maxOccupants >= candidates.length) return null;
      escapeSets.push({
        color,
        from: squareName(sq),
        candidates: candidates.map(squareName),
        maxOccupants,
      });
    }
  }
  const ordered = [...fixed].sort((a, b) => a - b);
  const mixed = ordered.some((sq) => position.board[sq]!.toLowerCase() !== 'p');
  return {
    kind: mixed
      ? escapeSets.length
        ? 'permanent-blocker-escape-sets'
        : escapes.length
          ? 'permanent-blocker-escape-squares'
          : 'permanent-blocker-no-check'
      : escapeSets.length
        ? 'permanent-pawn-wall-escape-sets'
        : escapes.length
          ? 'permanent-pawn-wall-escape-squares'
          : 'permanent-pawn-wall-no-check',
    pawns: ordered
      .filter((sq) => position.board[sq]!.toLowerCase() === 'p')
      .map(squareName),
    blockers: ordered.map((sq) => ({
      piece: position.board[sq]!,
      square: squareName(sq),
    })),
    escapes,
    escapeSets,
    castlingExclusions,
    unusableEnPassant: position.ep === null ? null : squareName(position.ep),
    regions: regions.map((region) => ({
      piece: region.piece,
      from: squareName(region.from),
      reachable: [...region.squares].sort((a, b) => a - b).map(squareName),
    })),
  };
}

/** Diagnostic only. Recompute this certificate; never trust a client-supplied one. */
export function analyzeLockedPosition(
  fen: string,
): LockedPositionCertificate | null {
  return lockedPositionCertificate(parseFen(fen));
}
