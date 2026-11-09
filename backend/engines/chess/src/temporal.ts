/**
 * Sufficient finite-tempo dead-position proof, not a search allowance.
 *
 * A frozen side can only advance pawns toward opposing pawns on their files.
 * Their initial gaps bound its remaining moves. The other side's finite regions
 * retain promotion time: promotion attacks immediately, but cannot move again
 * after the other side has run out of moves. All first captures/releases that
 * could invalidate that argument are conservatively excluded.
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
  symbol,
  type Position,
} from './position.js';
import {
  canLeave,
  invariantAttacks,
  type LockedBlocker,
  type LockedEscapeSet,
  type LockedCastlingExclusion,
} from './locked.js';
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
const PROMOTIONS = ['q', 'r', 'b', 'n'] as const;
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
  type === 'q' || type === 'r' || type === 'b';

export interface TemporalPawnBound {
  readonly piece: PieceSymbol;
  readonly from: Square;
  readonly barrier: Square;
  /** Initial intervening ranks; every ordinary advance consumes at least one. */
  readonly maxAdvances: number;
}
export interface TemporalPieceState {
  readonly piece: PieceSymbol;
  readonly square: Square;
  /** Shortest own-move distance in the enlarged geometry, not an actual line. */
  readonly minMoves: number;
}
export interface TemporalPieceRegion {
  readonly piece: PieceSymbol;
  readonly from: Square;
  /** One original identity, including all alternative promoted types. */
  readonly reachable: readonly Square[];
  readonly states: readonly TemporalPieceState[];
}
export interface TemporalCastlingTransition {
  readonly right: 'K' | 'Q' | 'k' | 'q';
  readonly kingFrom: Square;
  readonly kingTo: Square;
  readonly rookFrom: Square;
  readonly rookTo: Square;
  /** Both relocations share one own turn. Relaxed timing, not actual legality. */
  readonly minMoves: number;
}
export interface TemporalPositionCertificate {
  readonly kind: 'finite-pawn-tempo';
  readonly clockSide: Color;
  readonly frozenKing: Square;
  readonly maxClockMoves: number;
  readonly maxOtherMoves: number;
  readonly blockers: readonly LockedBlocker[];
  readonly pawnBounds: readonly TemporalPawnBound[];
  readonly regions: readonly TemporalPieceRegion[];
  readonly escapes: readonly {
    readonly color: Color;
    readonly from: Square;
    readonly to: Square;
  }[];
  readonly escapeSets: readonly LockedEscapeSet[];
  /** Non-clock-side castles included in the enlarged timed regions. */
  readonly castlingTransitions: readonly TemporalCastlingTransition[];
  /** Every clock-side castle must be permanently excluded by the invariant. */
  readonly clockCastlingExclusions: readonly LockedCastlingExclusion[];
  readonly unusableEnPassant: Square | null;
}
interface PawnBound {
  from: number;
  barrier: number;
  gap: number;
}
interface TimedState {
  type: string;
  square: number;
  distance: number;
}
interface Castle {
  right: TemporalCastlingTransition['right'];
  color: Color;
  kingFrom: number;
  kingTo: number;
  rookFrom: number;
  rookTo: number;
  corridor: number[];
  kingPath: number[];
}
interface Region {
  from: number;
  piece: PieceSymbol;
  states: TimedState[];
  squares: Set<number>;
  attacks: Set<number>;
  captureFixed: Set<number>;
  pawnCaptureTargets: Set<number>;
}

function pawnAttacks(from: number, color: Color): number[] {
  const r = rankOf(from) + (color === 'white' ? 1 : -1),
    result: number[] = [];
  for (const df of [-1, 1])
    if (inside(fileOf(from) + df, r)) result.push(r * 8 + fileOf(from) + df);
  return result;
}
function refineGeometry(position: Position, fixed: Set<number>): void {
  for (;;) {
    const moving = [...fixed].filter((sq) => canLeave(position, fixed, sq));
    if (!moving.length) return;
    for (const sq of moving) fixed.delete(sq);
  }
}
function pawnBounds(position: Position, clock: Color): PawnBound[] | null {
  const step = clock === 'white' ? 8 : -8,
    result: PawnBound[] = [];
  for (let from = 0; from < 64; from++) {
    if (position.board[from] !== symbol('p', clock)) continue;
    let barrier = from + step;
    while (
      barrier >= 0 &&
      barrier < 64 &&
      position.board[barrier] !== symbol('p', opposite(clock))
    )
      barrier += step;
    if (barrier < 0 || barrier >= 64) return null;
    result.push({
      from,
      barrier,
      gap: Math.abs(rankOf(from) - rankOf(barrier)) - 1,
    });
  }
  return result;
}
function frozenKing(
  position: Position,
  fixed: ReadonlySet<number>,
  king: number,
  clock: Color,
  enemyAttacks: ReadonlySet<number>,
): boolean {
  for (const [df, dr] of KING) {
    const f = fileOf(king) + df,
      r = rankOf(king) + dr;
    if (!inside(f, r)) continue;
    const sq = r * 8 + f;
    if (
      !(fixed.has(sq) && colorOf(position.board[sq]!) === clock) &&
      !enemyAttacks.has(sq)
    )
      return false;
  }
  return true;
}
function region(from: number, piece: PieceSymbol): Region {
  return {
    from,
    piece,
    states: [],
    squares: new Set(),
    attacks: new Set(),
    captureFixed: new Set(),
    pawnCaptureTargets: new Set(),
  };
}

function retainedCastles(position: Position): Castle[] {
  return [...position.castling].map((flag) => {
    const color: Color = flag === flag.toUpperCase() ? 'white' : 'black';
    const base = color === 'white' ? 0 : 56,
      kingside = flag.toLowerCase() === 'k';
    return {
      right: flag as Castle['right'],
      color,
      kingFrom: base + 4,
      kingTo: base + (kingside ? 6 : 2),
      rookFrom: base + (kingside ? 7 : 0),
      rookTo: base + (kingside ? 5 : 3),
      corridor: (kingside ? [5, 6] : [1, 2, 3]).map((file) => base + file),
      kingPath: (kingside ? [4, 5, 6] : [4, 3, 2]).map((file) => base + file),
    };
  });
}

/**
 * Breadth-first geometry for ONE original piece, not a game-tree search. Every
 * other mobile blocker is absent, and each piece independently gets the full
 * own-turn horizon. This deliberately includes impossible combined schedules.
 */
function otherRegion(
  position: Position,
  fixed: ReadonlySet<number>,
  clockKing: number,
  guaranteedEnemyAttacks: ReadonlySet<number>,
  from: number,
  horizon: number,
  castles: readonly Castle[],
): Region {
  const piece = position.board[from]!,
    color = colorOf(piece),
    result = region(from, piece);
  const queue: TimedState[] = [
    { type: piece.toLowerCase(), square: from, distance: 0 },
  ];
  const seen = new Set([`${piece.toLowerCase()}:${from}`]);
  const obstacles = (sq: number): boolean => fixed.has(sq) || sq === clockKing;
  const add = (type: string, square: number, distance: number): void => {
    const key = `${type}:${square}`;
    if (!seen.has(key)) {
      seen.add(key);
      queue.push({ type, square, distance });
    }
  };
  // A castle moves the king AND its original rook on the SAME own turn.
  // Grant both destinations at turn one even if the real corridor first needs
  // clearing. Earlier availability only enlarges this per-piece abstraction.
  // Every real later castle is included, without erasing the actual rights or
  // counting the two relocations as separate turns. Original identities stay
  // distinct for occupancy matching; a castle creates no extra piece.
  if (horizon >= 1)
    for (const castle of castles) {
      if (from === castle.kingFrom) add('k', castle.kingTo, 1);
      if (from === castle.rookFrom) add('r', castle.rookTo, 1);
    }
  const enqueuePawn = (square: number, distance: number): void => {
    if (rankOf(square) === 0 || rankOf(square) === 7)
      for (const type of PROMOTIONS) add(type, square, distance);
    else add('p', square, distance);
  };
  for (let index = 0; index < queue.length; index++) {
    const state = queue[index]!,
      { type, square, distance } = state;
    result.states.push(state);
    result.squares.add(square);
    // A fixed piece has no ordinary motion. A fixed pawn's possible captures
    // are still tested below, including captures of offered mobile pieces.
    const mayMove = distance < horizon && !fixed.has(from);
    if (type === 'p') {
      for (const target of pawnAttacks(square, color)) {
        result.attacks.add(target);
        if (distance < horizon) result.pawnCaptureTargets.add(target);
      }
      if (!mayMove) continue;
      const step = color === 'white' ? 8 : -8,
        one = square + step;
      if (one < 0 || one >= 64 || obstacles(one)) continue;
      enqueuePawn(one, distance + 1);
      const two = square + 2 * step;
      if (rankOf(square) === (color === 'white' ? 1 : 6) && !obstacles(two))
        enqueuePawn(two, distance + 1);
      continue;
    }
    for (const [df, dr] of directions(type)) {
      let f = fileOf(square) + df,
        r = rankOf(square) + dr;
      while (inside(f, r)) {
        const target = r * 8 + f;
        result.attacks.add(target);
        const kingSafe = type !== 'k' || !guaranteedEnemyAttacks.has(target);
        if (obstacles(target)) {
          if (
            mayMove &&
            kingSafe &&
            fixed.has(target) &&
            colorOf(position.board[target]!) !== color
          )
            result.captureFixed.add(target);
          break;
        }
        if (mayMove && kingSafe) add(type, target, distance + 1);
        if (!sliding(type)) break;
        f += df;
        r += dr;
      }
    }
  }
  return result;
}

function clockRegion(
  position: Position,
  fixed: ReadonlySet<number>,
  king: number,
  from: number,
  bound: PawnBound | undefined,
): Region {
  const piece = position.board[from]!,
    type = piece.toLowerCase(),
    color = colorOf(piece),
    result = region(from, piece);
  const squares: number[] = [from];
  if (type === 'p' && !fixed.has(from)) {
    const step = color === 'white' ? 8 : -8;
    for (
      let sq = from + step;
      sq !== bound!.barrier && !fixed.has(sq) && sq !== king;
      sq += step
    )
      squares.push(sq);
  }
  for (const sq of squares) {
    const displacement = Math.abs(rankOf(sq) - rankOf(from));
    const distance =
      type === 'p' &&
      rankOf(from) === (color === 'white' ? 1 : 6) &&
      displacement >= 2
        ? displacement - 1
        : displacement;
    result.states.push({ type, square: sq, distance });
    result.squares.add(sq);
    if (type === 'p') {
      for (const target of pawnAttacks(sq, color)) result.attacks.add(target);
    } else {
      for (const [df, dr] of directions(type)) {
        let f = fileOf(sq) + df,
          r = rankOf(sq) + dr;
        while (inside(f, r)) {
          const target = r * 8 + f;
          result.attacks.add(target);
          if (fixed.has(target) || target === king || !sliding(type)) break;
          f += df;
          r += dr;
        }
      }
    }
  }
  return result;
}

function tryClock(
  position: Position,
  initialFixed: ReadonlySet<number>,
  clock: Color,
): TemporalPositionCertificate | null {
  const bounds = pawnBounds(position, clock);
  if (!bounds) return null;
  const other = opposite(clock),
    king = position.board.indexOf(symbol('k', clock));
  const maxClockMoves = bounds.reduce((sum, bound) => sum + bound.gap, 0);
  const maxOtherMoves = maxClockMoves + (position.turn === other ? 1 : 0);
  const castles = retainedCastles(position),
    otherCastles = castles.filter((castle) => castle.color === other);
  const fixed = new Set(initialFixed);
  // Ordinary immobility cannot make a castling rook a permanent obstacle or
  // attack source. A possible joint relocation must be accounted for first.
  for (const castle of otherCastles) fixed.delete(castle.rookFrom);
  for (;;) {
    refineGeometry(position, fixed);
    // Every clock-side non-pawn must remain frozen, not merely pinned today.
    for (let sq = 0; sq < 64; sq++) {
      const piece = position.board[sq];
      if (
        piece &&
        colorOf(piece) === clock &&
        !['p', 'k'].includes(piece.toLowerCase()) &&
        !fixed.has(sq)
      )
        return null;
    }
    const guaranteed = invariantAttacks(position, fixed);
    if (!frozenKing(position, fixed, king, clock, guaranteed[other]))
      return null;
    const clockCastlingExclusions: LockedCastlingExclusion[] = [];
    for (const castle of castles.filter((entry) => entry.color === clock)) {
      const blockers = castle.corridor.filter((sq) => fixed.has(sq));
      const attackedKingPath = castle.kingPath.filter((sq) =>
        guaranteed[other].has(sq),
      );
      // The frozen-king invariant also excludes the adjacent castle transit:
      // it is permanently occupied by a friendly fixed piece or attacked by a
      // fixed enemy. A clock-side castle can therefore never add a pawn tempo.
      if (!blockers.length && !attackedKingPath.length) return null;
      clockCastlingExclusions.push({
        right: castle.right,
        blockers: blockers.map(squareName),
        attackedKingPath: attackedKingPath.map(squareName),
      });
    }
    // The clock king is now part of this finite invariant, including its
    // attacks when excluding impossible opponent-king moves and captures.
    for (const [df, dr] of KING) {
      const f = fileOf(king) + df,
        r = rankOf(king) + dr;
      if (inside(f, r)) guaranteed[clock].add(r * 8 + f);
    }
    const regions: Region[] = [],
      removable = new Set<number>();
    for (let from = 0; from < 64; from++) {
      const piece = position.board[from];
      if (!piece) continue;
      const entry =
        colorOf(piece) === clock
          ? clockRegion(
              position,
              fixed,
              king,
              from,
              bounds.find((bound) => bound.from === from),
            )
          : otherRegion(
              position,
              fixed,
              king,
              guaranteed[clock],
              from,
              maxOtherMoves,
              otherCastles,
            );
      regions.push(entry);
      for (const target of entry.captureFixed) removable.add(target);
    }
    if (removable.size) {
      for (const sq of removable) fixed.delete(sq);
      continue;
    }
    const otherPieces = regions.filter(
      (entry) =>
        colorOf(entry.piece) === other && entry.piece.toLowerCase() !== 'k',
    );
    const clockPieces = regions.filter(
      (entry) =>
        colorOf(entry.piece) === clock && entry.piece.toLowerCase() !== 'k',
    );
    // Test POST-horizon occupancy too. A capture on the putative extra clock
    // turn would invalidate exhaustion (e.g. a final pawn offer frees a cage).
    for (const pawn of clockPieces.filter(
      (entry) => entry.piece.toLowerCase() === 'p',
    )) {
      for (const target of otherPieces)
        for (const sq of target.squares) if (pawn.attacks.has(sq)) return null;
    }
    // File-only opponent pawn regions require absence of a first capture.
    // Every double advance's intermediate square is included on both sides,
    // so this test also conservatively excludes future en-passant captures.
    for (const pawn of otherPieces.filter(
      (entry) => entry.piece.toLowerCase() === 'p',
    )) {
      for (const target of clockPieces)
        for (const sq of target.squares)
          if (pawn.pawnCaptureTargets.has(sq)) return null;
    }
    // Non-pawn captures of mobile clock pawns ARE allowed: they only remove
    // tempo credits. All mobile blockers were already absent from our regions.
    const escapes: { color: Color; from: Square; to: Square }[] = [],
      escapeSets: LockedEscapeSet[] = [];
    for (const color of ['white', 'black'] as const) {
      const movingKing = regions.find(
        (entry) => entry.piece === symbol('k', color),
      )!;
      const enemy = opposite(color),
        checking = new Set<number>(),
        allAttacks = new Set<number>();
      const occupants = regions.filter((entry) => entry !== movingKing);
      const occupied = new Set([...fixed, king]);
      for (const entry of occupants) {
        for (const sq of entry.squares) occupied.add(sq);
        if (colorOf(entry.piece) !== enemy) continue;
        for (const sq of entry.attacks) {
          allAttacks.add(sq);
          if (entry.piece.toLowerCase() !== 'k') checking.add(sq);
        }
      }
      for (const sq of movingKing.squares) {
        if (!checking.has(sq)) continue;
        const candidates: number[] = [];
        let escape: number | null = null;
        for (const [df, dr] of KING) {
          const f = fileOf(sq) + df,
            r = rankOf(sq) + dr,
            target = r * 8 + f;
          if (
            !inside(f, r) ||
            fixed.has(target) ||
            target === king ||
            allAttacks.has(target)
          )
            continue;
          candidates.push(target);
          if (!occupied.has(target)) {
            escape = target;
            break;
          }
        }
        if (escape !== null) {
          escapes.push({ color, from: squareName(sq), to: squareName(escape) });
          continue;
        }
        const maxOccupants = maximumMatching(
          candidates,
          occupants.map((entry) => entry.squares),
        );
        if (maxOccupants >= candidates.length) return null;
        escapeSets.push({
          color,
          from: squareName(sq),
          candidates: candidates.map(squareName),
          maxOccupants,
        });
      }
    }
    return {
      kind: 'finite-pawn-tempo',
      clockSide: clock,
      frozenKing: squareName(king),
      maxClockMoves,
      maxOtherMoves,
      blockers: [...fixed]
        .sort((a, b) => a - b)
        .map((square) => ({
          piece: position.board[square]!,
          square: squareName(square),
        })),
      pawnBounds: bounds.map((bound) => ({
        piece: position.board[bound.from]!,
        from: squareName(bound.from),
        barrier: squareName(bound.barrier),
        maxAdvances: bound.gap,
      })),
      regions: regions.map((entry) => ({
        piece: entry.piece,
        from: squareName(entry.from),
        reachable: [...entry.squares].sort((a, b) => a - b).map(squareName),
        states: entry.states.map((state) => ({
          piece: symbol(state.type, colorOf(entry.piece)),
          square: squareName(state.square),
          minMoves: state.distance,
        })),
      })),
      escapes,
      escapeSets,
      castlingTransitions:
        maxOtherMoves < 1
          ? []
          : otherCastles.map((castle) => ({
              right: castle.right,
              kingFrom: squareName(castle.kingFrom),
              kingTo: squareName(castle.kingTo),
              rookFrom: squareName(castle.rookFrom),
              rookTo: squareName(castle.rookTo),
              minMoves: 1,
            })),
      clockCastlingExclusions,
      unusableEnPassant: position.ep === null ? null : squareName(position.ep),
    };
  }
}

/** Pure sufficient certificate. null never means that a mating line exists. */
export function temporalPositionCertificate(
  position: Position,
): TemporalPositionCertificate | null {
  // A legal initial EP capture still requires exact successors. Castles are
  // modeled as joint timed relocations or proved invariantly unavailable.
  if (
    position.ep !== null &&
    legalBoardMoves(position).some((move) => move.enPassant !== undefined)
  )
    return null;
  const fixed = new Set(
    position.board.flatMap((piece, sq) =>
      piece && piece.toLowerCase() !== 'k' ? [sq] : [],
    ),
  );
  refineGeometry(position, fixed);
  if (!fixed.size) return null;
  return (
    tryClock(position, fixed, 'white') ?? tryClock(position, fixed, 'black')
  );
}

/** Detached analysis data, never player authority or a stored proof assertion. */
export function analyzeTemporalPosition(
  fen: string,
): TemporalPositionCertificate | null {
  return temporalPositionCertificate(parseFen(fen));
}
