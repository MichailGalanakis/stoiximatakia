/** Cooperative mate reachability. No minimax scores or guessed draw results. */
import type { Color, MoveSpec } from './types.js';
import { ENGINE_VERSION, RULES_VERSION } from './types.js';
import {
  advance,
  findLegalMove,
  inCheck,
  legalBoardMoves,
  materialDead,
  moveSpec,
  opposite,
  parseFen,
  parseMove,
  positionKey,
  uci,
  type BoardMove,
  type Position,
} from './position.js';
import { lockedPositionCertificate } from './locked.js';
import { kingCorridorCertificate } from './joint-kings.js';
import { temporalPositionCertificate } from './temporal.js';
import { fail, uint } from './errors.js';

export interface ReachabilityLimits {
  readonly maxPositions?: number;
  readonly maxExpanded?: number;
  readonly maxEdges?: number;
}
export interface ReachabilityMetrics {
  readonly positions: number;
  readonly expanded: number;
  readonly edges: number;
  readonly terminalLeaves: number;
  readonly certifiedLeaves: number;
}
type Leaf = 'stalemate' | 'material' | 'locked' | 'king-corridor' | 'temporal';
export interface ReachabilityProofNode {
  /** Canonical movement identity, including turn, castling and legal EP rights. */
  readonly position: string;
  readonly leaf: Leaf | null;
  /** Complete successor SET. Multiple legal moves may share an identity. */
  readonly successors: readonly string[];
}
interface EvidenceBinding {
  readonly engineVersion: string;
  readonly rulesVersion: string;
  readonly root: string;
}
export interface ClosedReachabilityProof extends EvidenceBinding {
  readonly kind: 'closed-movement-graph';
  readonly nodes: readonly ReachabilityProofNode[];
}
export interface ReachableMateWitness extends EvidenceBinding {
  readonly kind: 'reachable-mate';
  readonly winner: Color;
  /** Hypothetical legal play, never accepted player history. */
  readonly moves: readonly MoveSpec[];
}
export type ReachabilityEvidence =
  ClosedReachabilityProof | ReachableMateWitness;
export type MateReachabilityResult =
  | {
      readonly status: 'dead';
      readonly evidence: ClosedReachabilityProof;
      readonly metrics: ReachabilityMetrics;
    }
  | {
      readonly status: 'not-dead';
      readonly evidence: ReachableMateWitness;
      readonly metrics: ReachabilityMetrics;
    }
  | {
      readonly status: 'unknown';
      readonly evidence: null;
      readonly metrics: ReachabilityMetrics;
    };

/** Pending is analysis work, never a chess result or permission to keep playing. */
export type MateReachabilityProgress =
  | Exclude<MateReachabilityResult, { readonly status: 'unknown' }>
  | {
      readonly status: 'pending';
      readonly evidence: null;
      readonly metrics: ReachabilityMetrics;
    };
export interface MateReachabilitySearch {
  /** Continue the SAME graph, spending at most this many additional legal edges. */
  readonly advance: (maxEdges?: number) => MateReachabilityProgress;
}
export interface MateWitnessSearchOptions {
  readonly maxNodes?: number;
  readonly maxPlies?: number;
  readonly randomState?: number;
  readonly strategy?: 'capture' | 'pawn-bait-before-capture';
}
export type MateWitnessSearchResult =
  | {
      readonly status: 'not-dead';
      readonly evidence: ReachableMateWitness;
      readonly visited: number;
    }
  | {
      readonly status: 'unknown';
      readonly evidence: null;
      readonly visited: number;
    };
export type ExactMateReachabilityResult =
  | { readonly status: 'dead'; readonly evidence: ClosedReachabilityProof }
  | { readonly status: 'not-dead'; readonly evidence: ReachableMateWitness };
export type ReachabilityDecisionVerification =
  | {
      readonly valid: true;
      readonly verdict: 'dead' | 'not-dead';
      readonly root: string;
      readonly engineVersion: typeof ENGINE_VERSION;
      readonly rulesVersion: typeof RULES_VERSION;
    }
  | { readonly valid: false; readonly reason: string };
interface ReachabilityExpansionBinding {
  readonly position: string;
  readonly fen: string;
  readonly kernelEngineVersion: typeof ENGINE_VERSION;
  readonly kernelRulesVersion: typeof RULES_VERSION;
}
export type ReachabilityExpansion = ReachabilityExpansionBinding &
  (
    | { readonly kind: 'mate'; readonly winner: Color }
    | { readonly kind: 'leaf'; readonly node: ReachabilityProofNode }
    | {
        readonly kind: 'branch';
        readonly node: ReachabilityProofNode;
        readonly successors: readonly {
          readonly position: string;
          readonly fen: string;
          readonly move: MoveSpec;
        }[];
      }
  );

interface WitnessNode {
  parent: WitnessNode | null;
  move: MoveSpec | null;
}
interface Node extends WitnessNode {
  position: Position;
  key: string;
  moves: readonly BoardMove[];
  leaf: Leaf | null;
  successors: string[];
}
const DEFAULTS = {
  maxPositions: 4096,
  maxExpanded: 256,
  maxEdges: 8192,
} as const;
function limits(input: ReachabilityLimits): Required<ReachabilityLimits> {
  return {
    maxPositions: uint(
      input.maxPositions ?? DEFAULTS.maxPositions,
      'maxPositions',
      100_000,
      'INVALID_CONFIG',
    ),
    maxExpanded: uint(
      input.maxExpanded ?? DEFAULTS.maxExpanded,
      'maxExpanded',
      100_000,
      'INVALID_CONFIG',
    ),
    maxEdges: uint(
      input.maxEdges ?? DEFAULTS.maxEdges,
      'maxEdges',
      2_000_000,
      'INVALID_CONFIG',
    ),
  };
}
/** Internal shared proof kernel, also used by the bounded-record streaming checker. */
export function reachabilityLeafKind(
  position: Position,
  moves: readonly BoardMove[],
  certificates: boolean,
): Leaf | null {
  // Actual mate/stalemate has precedence over every sufficient certificate.
  if (moves.length === 0) return inCheck(position) ? null : 'stalemate';
  if (!certificates) return null;
  if (materialDead(position)) return 'material';
  if (lockedPositionCertificate(position)) return 'locked';
  if (kingCorridorCertificate(position)) return 'king-corridor';
  if (temporalPositionCertificate(position)) return 'temporal';
  return null;
}
/** One deterministic, bounded analysis expansion for private durable builders. */
export function expandReachabilityPosition(fen: string): ReachabilityExpansion {
  const key = positionKey(parseFen(fen)),
    position = parseFen(key + ' 0 1'),
    binding: ReachabilityExpansionBinding = {
      position: key,
      fen: key + ' 0 1',
      kernelEngineVersion: ENGINE_VERSION,
      kernelRulesVersion: RULES_VERSION,
    },
    moves = legalBoardMoves(position);
  if (!moves.length && inCheck(position))
    return Object.freeze({
      ...binding,
      kind: 'mate',
      winner: opposite(position.turn),
    });
  const leaf = reachabilityLeafKind(position, moves, true);
  if (leaf !== null)
    return Object.freeze({
      ...binding,
      kind: 'leaf',
      node: Object.freeze({
        position: key,
        leaf,
        successors: Object.freeze([]),
      }),
    });
  const byPosition = new Map<
    string,
    { position: string; fen: string; move: MoveSpec }
  >();
  for (const move of moves) {
    const next = positionKey(advance(position, move)),
      spec = moveSpec(move),
      known = byPosition.get(next);
    if (!known || uci(spec) < uci(known.move))
      byPosition.set(next, {
        position: next,
        fen: next + ' 0 1',
        move: Object.freeze(spec),
      });
  }
  const successors = Object.freeze(
    [...byPosition.values()]
      .sort((a, b) =>
        a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
      )
      .map((value) => Object.freeze(value)),
  );
  return Object.freeze({
    ...binding,
    kind: 'branch',
    successors,
    node: Object.freeze({
      position: key,
      leaf: null,
      successors: Object.freeze(successors.map((value) => value.position)),
    }),
  });
}
function witness(node: WitnessNode): MoveSpec[] {
  const moves: MoveSpec[] = [];
  for (let cursor = node; cursor.parent !== null; cursor = cursor.parent)
    moves.push(cursor.move!);
  return moves.reverse();
}
function pawnCheckBaits(position: Position): number[] {
  // A hypothetical opposing turn is move-ordering information only. Actual
  // continuations always come from the unchanged side's legal move generator.
  const opposing = { ...position, turn: opposite(position.turn), ep: null },
    targets = new Set<number>();
  for (const move of legalBoardMoves(opposing)) {
    if (
      opposing.board[move.from]?.toLowerCase() !== 'p' ||
      move.from % 8 !== move.to % 8 ||
      move.promotion
    )
      continue;
    const rank = Math.floor(move.to / 8) + (opposing.turn === 'white' ? 1 : -1);
    if (rank < 0 || rank > 7) continue;
    for (const file of [(move.to % 8) - 1, (move.to % 8) + 1])
      if (file >= 0 && file < 8) targets.add(rank * 8 + file);
  }
  return [...targets];
}
const kingDistance = (from: number, to: number): number =>
  Math.max(
    Math.abs((from % 8) - (to % 8)),
    Math.abs(Math.floor(from / 8) - Math.floor(to / 8)),
  );

/**
 * Positive-only acceleration, not a bot or an unwinnability predicate. Biased
 * legal playouts and cycle removal seek an actual mate; every returned line is
 * verified independently. Search failure proves nothing. The heuristic affects
 * only discovery order, never the accepted proof or a game's rules.
 */
export function findMateReachabilityWitness(
  fen: string,
  options: MateWitnessSearchOptions = {},
): MateWitnessSearchResult {
  const strategy = options.strategy ?? 'capture';
  if (!['capture', 'pawn-bait-before-capture'].includes(strategy))
    fail('INVALID_CONFIG', 'Unknown mate-witness search strategy.');
  const maxNodes = uint(
      options.maxNodes ?? 30000,
      'maxNodes',
      100000,
      'INVALID_CONFIG',
    ),
    maxPlies = uint(options.maxPlies ?? 256, 'maxPlies', 256, 'INVALID_CONFIG'),
    initial = parseFen(fen),
    root = positionKey(initial);
  let random = uint(
      options.randomState ?? 1729,
      'randomState',
      0xffffffff,
      'INVALID_CONFIG',
    ),
    visited = 0;
  const rng = (): number => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random / 4294967296;
  };
  const values: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const unknown = (): MateWitnessSearchResult =>
    Object.freeze({
      status: 'unknown',
      evidence: null,
      visited,
    });
  while (visited < maxNodes) {
    let position = initial,
      capturedOnce = false;
    const line: MoveSpec[] = [],
      seen = new Map([[root, 0]]);
    for (let ply = 0; ply < 2000 && visited < maxNodes; ply++) {
      visited++;
      const moves = legalBoardMoves(position);
      if (!moves.length) {
        if (!inCheck(position)) break;
        const evidence: ReachableMateWitness = Object.freeze({
          kind: 'reachable-mate',
          engineVersion: ENGINE_VERSION,
          rulesVersion: RULES_VERSION,
          root,
          winner: opposite(position.turn),
          moves: Object.freeze(line.map((move) => Object.freeze(move))),
        });
        if (!verifyReachabilityEvidence(fen, evidence).valid)
          fail('INVALID_PROOF', 'Guided mate witness failed verification.');
        return Object.freeze({ status: 'not-dead', evidence, visited });
      }
      if (materialDead(position) || line.length >= maxPlies) break;
      const baitPhase =
          strategy === 'pawn-bait-before-capture' && !capturedOnce,
        baits = baitPhase ? pawnCheckBaits(position) : [];
      let selected = moves[0]!,
        best = -Infinity;
      for (const move of moves) {
        const captured = position.board[move.enPassant ?? move.to],
          after = advance(position, move),
          check = inCheck(after),
          type = position.board[move.from]!.toLowerCase();
        let score =
          (captured ? values[captured.toLowerCase()]! * 3 : 0) +
          (move.promotion ? values[move.promotion]! * 3 : 0) +
          (check ? 6 : 0) +
          rng() * 12;
        if (baitPhase) {
          if (type === 'p' && !captured && !check && !move.promotion)
            score -= 16;
          if (type === 'k' && baits.length)
            score +=
              (Math.min(...baits.map((sq) => kingDistance(move.from, sq))) -
                Math.min(...baits.map((sq) => kingDistance(move.to, sq)))) *
              16;
        }
        if (score > best) {
          selected = move;
          best = score;
        }
      }
      if (position.board[selected.enPassant ?? selected.to])
        capturedOnce = true;
      position = { ...advance(position, selected), halfmove: 0, fullmove: 1 };
      const key = positionKey(position),
        previous = seen.get(key);
      if (previous !== undefined) {
        line.length = previous;
        for (const [key, index] of seen) if (index > previous) seen.delete(key);
      } else {
        line.push(moveSpec(selected));
        seen.set(key, line.length);
      }
    }
    // Repeating a terminal/material-dead root cannot improve the search.
    if (
      visited === 1 &&
      (!legalBoardMoves(initial).length || materialDead(initial))
    )
      return unknown();
  }
  return unknown();
}

/**
 * Analysis-only total decision procedure, subject to available memory/time.
 * A bounded witness attempt accelerates ordinary live roots. Failure then falls
 * back to fair exhaustive retained exploration, without a semantic "unknown" or
 * permission to commit an unresolved move. Never call this synchronously from a
 * live request: practical runtime/resource acceptance is still outstanding.
 */
export function solveMateReachabilityExactly(
  fen: string,
  certificates = true,
): ExactMateReachabilityResult {
  const search = createMateReachabilitySearch(fen, certificates);
  const immediate = search.advance(0);
  if (immediate.status === 'dead')
    return Object.freeze({ status: 'dead', evidence: immediate.evidence });
  if (immediate.status === 'not-dead')
    return Object.freeze({ status: 'not-dead', evidence: immediate.evidence });
  for (const strategy of ['capture', 'pawn-bait-before-capture'] as const) {
    const guided = findMateReachabilityWitness(fen, { strategy });
    if (guided.status === 'not-dead')
      return Object.freeze({ status: 'not-dead', evidence: guided.evidence });
  }
  for (;;) {
    const result = search.advance(65536);
    if (result.status === 'dead')
      return Object.freeze({ status: 'dead', evidence: result.evidence });
    if (result.status === 'not-dead')
      return Object.freeze({ status: 'not-dead', evidence: result.evidence });
  }
}

/**
 * Analysis-only, retained exhaustive exploration. Each call bounds work, not the
 * mathematical answer. Repeated positive work slices eventually cover the finite
 * movement graph or find a mate; no total node/depth/work limit changes a result.
 *
 * This is NOT wired into automaticOutcome and introduces no product pause state.
 * Memory exhaustion remains an error, never evidence. Large completed evidence
 * can exceed the independent verifier's deliberately separate input limits.
 */
export function createMateReachabilitySearch(
  fen: string,
  certificates = true,
): MateReachabilitySearch {
  interface RetainedNode extends WitnessNode {
    key: string;
    turn: Color;
    isMate: boolean;
    leaf: Leaf | null;
    successors: string[];
    position: Position | null;
    moves: readonly BoardMove[] | null;
    edgeIndex: number;
    successorKeys: Set<string> | null;
  }
  const initial = parseFen(fen),
    binding: EvidenceBinding = {
      engineVersion: ENGINE_VERSION,
      rulesVersion: RULES_VERSION,
      root: positionKey(initial),
    },
    nodes = new Map<string, RetainedNode>(),
    queue: RetainedNode[] = [];
  let queueIndex = 0,
    edges = 0,
    expanded = 0,
    terminalLeaves = 0,
    certifiedLeaves = 0,
    completed: MateReachabilityProgress | null = null;
  const metrics = (): ReachabilityMetrics =>
    Object.freeze({
      positions: nodes.size,
      expanded,
      edges,
      terminalLeaves,
      certifiedLeaves,
    });
  const discover = (
    position: Position,
    parent: WitnessNode | null,
    move: MoveSpec | null,
  ): RetainedNode => {
    const key = positionKey(position),
      known = nodes.get(key);
    if (known) return known;
    // Counters are outside movement reachability. Do not let a very long proof
    // path accumulate irrelevant counters or eventually exceed numeric bounds.
    const movementPosition = { ...position, halfmove: 0, fullmove: 1 },
      moves = legalBoardMoves(movementPosition),
      leaf = reachabilityLeafKind(movementPosition, moves, certificates),
      needsExpansion = leaf === null && moves.length > 0,
      node: RetainedNode = {
        position: needsExpansion ? movementPosition : null,
        key,
        turn: movementPosition.turn,
        isMate: moves.length === 0 && leaf === null,
        moves: needsExpansion ? moves : null,
        leaf,
        parent,
        move,
        successors: [],
        edgeIndex: 0,
        successorKeys: needsExpansion ? new Set() : null,
      };
    nodes.set(key, node);
    if (leaf === 'stalemate') terminalLeaves++;
    else if (leaf !== null) certifiedLeaves++;
    else queue.push(node);
    return node;
  };
  const mate = (node: RetainedNode): MateReachabilityProgress =>
    Object.freeze({
      status: 'not-dead',
      metrics: metrics(),
      evidence: Object.freeze({
        ...binding,
        kind: 'reachable-mate',
        winner: opposite(node.turn),
        moves: Object.freeze(witness(node).map((move) => Object.freeze(move))),
      }),
    });
  discover(initial, null, null);
  return Object.freeze({
    advance(maxEdges = 256): MateReachabilityProgress {
      uint(maxEdges, 'maxEdges', 2_000_000, 'INVALID_CONFIG');
      if (completed) return completed;
      let work = 0;
      while (queueIndex < queue.length) {
        const node = queue[queueIndex]!;
        if (node.isMate) return (completed = mate(node));
        if (!node.moves || !node.position || !node.successorKeys)
          fail(
            'INVALID_PROOF',
            'Retained search lost its unresolved frontier.',
          );
        while (node.edgeIndex < node.moves.length) {
          if (work >= maxEdges)
            return Object.freeze({
              status: 'pending',
              evidence: null,
              metrics: metrics(),
            });
          // Do not discard a partially expanded node between work slices.
          const move = node.moves[node.edgeIndex]!,
            next = discover(advance(node.position, move), node, moveSpec(move));
          if (node.edgeIndex === 0) expanded++;
          node.edgeIndex++;
          edges++;
          work++;
          node.successorKeys.add(next.key);
          if (next.isMate) return (completed = mate(next));
        }
        node.successors = [...node.successorKeys].sort();
        // Future transpositions and mate witnesses need only movement identity,
        // proof edges and the minimal parent/move chain. Keep full boards and
        // generated legal moves only on the unresolved frontier.
        node.successorKeys = null;
        node.position = null;
        node.moves = null;
        queueIndex++;
      }
      completed = Object.freeze({
        status: 'dead',
        metrics: metrics(),
        evidence: Object.freeze({
          ...binding,
          kind: 'closed-movement-graph',
          nodes: Object.freeze(
            [...nodes.values()].map((node) =>
              Object.freeze({
                position: node.key,
                leaf: node.leaf,
                successors: Object.freeze([...node.successors]),
              }),
            ),
          ),
        }),
      });
      return completed;
    },
  });
}

/**
 * Classify every discovered state BEFORE spending an unresolved expansion slot.
 * Terminal/certified leaves still consume position, legal-edge and memory limits.
 * This avoids spending the entire branch budget merely queuing known leaves.
 * Closed cycles are allowed; a cutoff can NEVER produce a closed proof.
 * With certificates=false this traverses the full movement graph without pruning.
 */
export function solveMateReachability(
  fen: string,
  input: ReachabilityLimits = {},
  certificates = true,
): MateReachabilityResult {
  const bound = limits(input),
    initial = parseFen(fen),
    rootKey = positionKey(initial);
  const binding: EvidenceBinding = {
    engineVersion: ENGINE_VERSION,
    rulesVersion: RULES_VERSION,
    root: rootKey,
  };
  const nodes = new Map<string, Node>(),
    queue: Node[] = [];
  let edges = 0,
    expanded = 0,
    terminalLeaves = 0,
    certifiedLeaves = 0;
  const metrics = (): ReachabilityMetrics => ({
    positions: nodes.size,
    expanded,
    edges,
    terminalLeaves,
    certifiedLeaves,
  });
  const unknown = (): MateReachabilityResult => ({
    status: 'unknown',
    evidence: null,
    metrics: metrics(),
  });
  const discover = (
    position: Position,
    parent: Node | null,
    move: MoveSpec | null,
  ): Node | null => {
    const key = positionKey(position),
      known = nodes.get(key);
    if (known) return known;
    if (nodes.size >= bound.maxPositions) return null;
    const moves = legalBoardMoves(position);
    const leaf = reachabilityLeafKind(position, moves, certificates);
    const node: Node = {
      position,
      key,
      moves,
      leaf,
      parent,
      move,
      successors: [],
    };
    nodes.set(key, node);
    if (leaf === 'stalemate') terminalLeaves++;
    else if (leaf !== null) certifiedLeaves++;
    else queue.push(node);
    return node;
  };
  const initialNode = discover(initial, null, null);
  if (!initialNode) return unknown();
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]!;
    if (!node.moves.length) {
      return {
        status: 'not-dead',
        metrics: metrics(),
        evidence: {
          ...binding,
          kind: 'reachable-mate',
          winner: opposite(node.position.turn),
          moves: witness(node),
        },
      };
    }
    if (
      expanded >= bound.maxExpanded ||
      edges + node.moves.length > bound.maxEdges
    )
      return unknown();
    expanded++;
    const successors = new Set<string>();
    for (const move of node.moves) {
      edges++;
      const next = discover(advance(node.position, move), node, moveSpec(move));
      if (!next) return unknown();
      // Do not let a nearly full queue hide a mate that was already discovered.
      if (!next.moves.length && next.leaf === null) {
        return {
          status: 'not-dead',
          metrics: metrics(),
          evidence: {
            ...binding,
            kind: 'reachable-mate',
            winner: opposite(next.position.turn),
            moves: witness(next),
          },
        };
      }
      successors.add(next.key);
    }
    node.successors = [...successors].sort();
  }
  return {
    status: 'dead',
    metrics: metrics(),
    evidence: {
      ...binding,
      kind: 'closed-movement-graph',
      nodes: [...nodes.values()].map((node) => ({
        position: node.key,
        leaf: node.leaf,
        successors: node.successors,
      })),
    },
  };
}

/** Internal shared node checker. Input must already be detached JSON data. */
export function checkReachabilityProofNode(value: unknown): {
  readonly node: ReachabilityProofNode;
  readonly expanded: boolean;
  readonly edges: number;
} {
  const node = value as ReachabilityProofNode;
  if (
    !node ||
    typeof node.position !== 'string' ||
    node.position.length > 120 ||
    !Array.isArray(node.successors) ||
    node.successors.length > 256
  )
    throw new Error('Invalid graph node.');
  const position = parseFen(node.position + ' 0 1');
  if (positionKey(position) !== node.position)
    throw new Error('Noncanonical graph position.');
  const moves = legalBoardMoves(position);
  if (!moves.length && inCheck(position))
    throw new Error('Graph contains checkmate.');
  if (node.leaf !== null) {
    if (
      reachabilityLeafKind(position, moves, true) !== node.leaf ||
      node.successors.length
    )
      throw new Error('Unproved leaf.');
  } else {
    const actual = [
      ...new Set(moves.map((move) => positionKey(advance(position, move)))),
    ].sort();
    if (
      actual.length !== node.successors.length ||
      actual.some((key, i) => key !== node.successors[i])
    )
      throw new Error('Missing or incorrect legal successor.');
  }
  return {
    node,
    expanded: node.leaf === null,
    edges: node.leaf === null ? moves.length : 0,
  };
}

/**
 * Recompute the legal successor sets, terminals and any sufficient certificates.
 * This does not trust the search frontier, its statistics, or a supplied outcome.
 * The frozen verdict and binding come only from the detached verified snapshot;
 * callers must not classify the original, potentially mutable input afterward.
 * Caller still authenticates state/revision and runs verification off player input.
 */
export function verifyReachabilityDecision(
  fen: string,
  evidence: unknown,
  input: ReachabilityLimits = {},
): ReachabilityDecisionVerification {
  try {
    const bound = limits(input),
      root = positionKey(parseFen(fen));
    // Detach once: a getter/proxy must not change its claimed successors
    // between rule checking and the final graph-closure traversal.
    const encoded = JSON.stringify(evidence);
    if (typeof encoded !== 'string' || encoded.length > 16_000_000)
      throw new Error('Evidence exceeds the supported JSON size.');
    const stable: unknown = JSON.parse(encoded);
    if (!stable || typeof stable !== 'object' || Array.isArray(stable))
      throw new Error('Expected evidence object.');
    const e = stable as ReachabilityEvidence;
    if (
      e.root !== root ||
      e.engineVersion !== ENGINE_VERSION ||
      e.rulesVersion !== RULES_VERSION
    )
      throw new Error('Evidence binding mismatch.');
    if (e.kind === 'reachable-mate') {
      if (
        !Array.isArray(e.moves) ||
        e.moves.length > bound.maxEdges ||
        !['white', 'black'].includes(e.winner)
      )
        throw new Error('Invalid witness.');
      let position = parseFen(fen);
      for (const value of e.moves) {
        const moves = legalBoardMoves(position);
        if (
          !moves.length ||
          reachabilityLeafKind(position, moves, true) !== null
        )
          throw new Error('Witness continues past an ending.');
        position = advance(
          position,
          findLegalMove(position, parseMove(value), moves),
        );
      }
      if (
        legalBoardMoves(position).length ||
        !inCheck(position) ||
        opposite(position.turn) !== e.winner
      )
        throw new Error('Witness does not end in the stated mate.');
      return Object.freeze({
        valid: true,
        verdict: 'not-dead',
        root,
        engineVersion: ENGINE_VERSION,
        rulesVersion: RULES_VERSION,
      });
    }
    if (
      e.kind !== 'closed-movement-graph' ||
      !Array.isArray(e.nodes) ||
      !e.nodes.length ||
      e.nodes.length > bound.maxPositions
    )
      throw new Error('Invalid graph size or kind.');
    const nodes = new Map<string, ReachabilityProofNode>();
    let edges = 0,
      expanded = 0;
    const graph: ClosedReachabilityProof = e;
    for (const node of graph.nodes) {
      const checked = checkReachabilityProofNode(node);
      if (nodes.has(node.position)) throw new Error('Invalid graph node.');
      expanded += checked.expanded ? 1 : 0;
      edges += checked.edges;
      if (expanded > bound.maxExpanded || edges > bound.maxEdges)
        throw new Error('Verification work limit.');
      nodes.set(node.position, node);
    }
    if (!nodes.has(root)) throw new Error('Missing root.');
    const visited = new Set<string>(),
      queue = [root];
    for (let index = 0; index < queue.length; index++) {
      const key = queue[index]!;
      if (visited.has(key)) continue;
      const node = nodes.get(key);
      if (!node) throw new Error('Graph is not closed.');
      visited.add(key);
      queue.push(...node.successors);
    }
    if (visited.size !== nodes.size)
      throw new Error('Unreachable proof nodes.');
    return Object.freeze({
      valid: true,
      verdict: 'dead',
      root,
      engineVersion: ENGINE_VERSION,
      rulesVersion: RULES_VERSION,
    });
  } catch (error) {
    return Object.freeze({
      valid: false,
      reason:
        error instanceof Error
          ? error.message
          : 'Invalid reachability evidence.',
    });
  }
}

/** Compatibility-only validity view over the same detached proof verification. */
export function verifyReachabilityEvidence(
  fen: string,
  evidence: unknown,
  input: ReachabilityLimits = {},
): { readonly valid: boolean; readonly reason?: string } {
  const checked = verifyReachabilityDecision(fen, evidence, input);
  return checked.valid
    ? { valid: true }
    : { valid: false, reason: checked.reason };
}
