/** Sound, bounded cooperative reachability proofs. Unknown is NEVER reported as a draw. */
import type {
  Color,
  DeadPositionResult,
  MoveSpec,
  SearchResult,
} from './types.js';
import {
  advance,
  findLegalMove,
  hasOnlyKing,
  inCheck,
  legalBoardMoves,
  materialDead,
  moveSpec,
  opposite,
  parseFen,
  parseMove,
  positionKey,
  type Position,
} from './position.js';
import { fail, uint } from './errors.js';
import { lockedPositionCertificate } from './locked.js';
import { kingCorridorCertificate } from './joint-kings.js';
import { temporalPositionCertificate } from './temporal.js';

interface Node {
  readonly position: Position;
  readonly parent: number | null;
  readonly move: MoveSpec | null;
}
function line(nodes: readonly Node[], index: number): MoveSpec[] {
  const result: MoveSpec[] = [];
  while (nodes[index]!.parent !== null) {
    result.push(nodes[index]!.move!);
    index = nodes[index]!.parent!;
  }
  return result.reverse();
}
/**
 * All sides cooperate, unlike a winning-strategy/tablebase test. Move counters and
 * repetition are intentionally ignored: this asks about a series of legal moves,
 * not whether a mate can be forced or whether an opponent would claim a draw.
 * Exhausting the complete reachable graph proves impossibility. Hitting the
 * resource bound proves nothing and returns unknown.
 */
export function analyzeMatePossibility(
  fen: string,
  winner: Color | 'either',
  maxNodes = 2048,
): SearchResult {
  uint(maxNodes, 'maxNodes', 100_000, 'INVALID_CONFIG');
  if (maxNodes < 1) fail('INVALID_CONFIG', 'maxNodes must be positive.');
  if (winner !== 'white' && winner !== 'black' && winner !== 'either')
    fail('INVALID_CONFIG', 'Winner must be white, black, or either.');
  const root = parseFen(fen);
  const nodes: Node[] = [{ position: root, parent: null, move: null }];
  const seen = new Set([positionKey(root)]);
  let cutoff = false;
  for (let index = 0; index < nodes.length; index++) {
    const position = nodes[index]!.position;
    const moves = legalBoardMoves(position);
    if (moves.length === 0) {
      if (
        inCheck(position) &&
        (winner === 'either' || opposite(position.turn) === winner)
      )
        return {
          status: 'possible',
          nodes: index + 1,
          witness: line(nodes, index),
        };
      continue;
    }
    if (
      materialDead(position) ||
      (winner !== 'either' && hasOnlyKing(position, winner)) ||
      lockedPositionCertificate(position) ||
      kingCorridorCertificate(position) ||
      temporalPositionCertificate(position)
    )
      continue;
    for (const move of moves) {
      const next = advance(position, move),
        key = positionKey(next);
      if (seen.has(key)) continue;
      if (nodes.length >= maxNodes) {
        cutoff = true;
        continue;
      }
      seen.add(key);
      nodes.push({ position: next, parent: index, move: moveSpec(move) });
    }
  }
  return {
    status: cutoff ? 'unknown' : 'impossible',
    nodes: nodes.length,
    witness: null,
  };
}
export function analyzeDeadPosition(
  fen: string,
  maxNodes = 2048,
): DeadPositionResult {
  const proof = analyzeMatePossibility(fen, 'either', maxNodes);
  return {
    status:
      proof.status === 'possible'
        ? 'not-dead'
        : proof.status === 'impossible'
          ? 'dead'
          : 'unknown',
    nodes: proof.nodes,
    witness: proof.witness,
  };
}
export function validateMateWitness(
  fen: string,
  winner: Color,
  witness: unknown,
): MoveSpec[] {
  if (!Array.isArray(witness) || witness.length === 0 || witness.length > 256)
    fail('INVALID_PROOF', 'A mate witness must contain 1–256 legal moves.');
  let position = parseFen(fen);
  const canonical: MoveSpec[] = [];
  for (let i = 0; i < witness.length; i++) {
    const legal = legalBoardMoves(position);
    if (
      !legal.length ||
      materialDead(position) ||
      lockedPositionCertificate(position) ||
      kingCorridorCertificate(position) ||
      temporalPositionCertificate(position)
    )
      fail(
        'INVALID_PROOF',
        'The witness continues past an already terminal position.',
      );
    let spec: MoveSpec;
    try {
      spec = parseMove(witness[i]);
      position = advance(position, findLegalMove(position, spec, legal));
    } catch {
      fail('INVALID_PROOF', `Witness move ${i + 1} is invalid or illegal.`);
    }
    canonical.push(spec);
  }
  if (
    legalBoardMoves(position).length !== 0 ||
    !inCheck(position) ||
    opposite(position.turn) !== winner
  )
    fail(
      'INVALID_PROOF',
      'The witness must end in checkmate by the specified prospective winner.',
    );
  return canonical;
}
