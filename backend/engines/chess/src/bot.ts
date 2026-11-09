import type {
  BotDecision,
  BotOptions,
  ChessObservation,
  MoveAction,
  Result,
} from './types.js';
import { asError, fail, keys, object, uint } from './errors.js';
import {
  advance,
  findLegalMove,
  inCheck,
  legalBoardMoves,
  parseFen,
  squareIndex,
  uci,
} from './position.js';

/** Deterministic, non-cryptographic RNG for bot tests, not future hidden-card dealing. */
export function nextRandom(state: number): { state: number; value: number } {
  uint(state, 'randomState', 0xffffffff, 'INVALID_CONFIG');
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = Math.imul(next ^ (next >>> 15), next | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { state: next, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}
/**
 * Selects from the player's observation, never from authoritative/private state.
 * Always apply the returned action through applyAction; this is not an authority.
 * Randomness is explicit, external and resumable; no seed is stored in observations.
 */
export function chooseBotAction(
  observation: ChessObservation,
  options: BotOptions = {},
): Result<BotDecision> {
  try {
    const o = object(options, 'INVALID_CONFIG');
    keys(o, ['strategy', 'randomState'], 'INVALID_CONFIG');
    if ('randomState' in o)
      uint(o.randomState, 'randomState', 0xffffffff, 'INVALID_CONFIG');
    const strategy = options.strategy ?? 'capture';
    if (!['first-legal', 'random', 'capture'].includes(strategy))
      fail('INVALID_CONFIG', 'Unknown bot strategy.');
    if (observation.phase !== 'playing')
      fail('GAME_ENDED', 'The bot cannot act while play is stopped.');
    if (
      observation.viewerColor === null ||
      observation.viewerColor !== observation.turn
    )
      fail(
        'NOT_YOUR_TURN',
        'The bot needs the active participant observation.',
      );
    const moves = observation.legalActions
      .filter((a): a is MoveAction => a.type === 'move')
      .slice()
      .sort((a, b) => (uci(a) < uci(b) ? -1 : uci(a) > uci(b) ? 1 : 0));
    if (!moves.length) fail('ILLEGAL_MOVE', 'No playable move is available.');
    if (strategy === 'random') {
      const randomState = uint(
        options.randomState,
        'randomState',
        0xffffffff,
        'INVALID_CONFIG',
      );
      const next = nextRandom(randomState);
      return {
        ok: true,
        value: {
          action: moves[Math.floor(next.value * moves.length)]!,
          nextRandomState: next.state,
        },
      };
    }
    if (strategy === 'first-legal')
      return { ok: true, value: { action: moves[0]!, nextRandomState: null } };
    const position = parseFen(observation.fen),
      legal = legalBoardMoves(position);
    const values: Record<string, number> = {
      p: 100,
      n: 320,
      b: 330,
      r: 500,
      q: 900,
      k: 0,
    };
    let best = moves[0]!,
      bestScore = -Infinity;
    for (const action of moves) {
      const move = findLegalMove(position, action, legal),
        after = advance(position, move);
      const captured = position.board[move.enPassant ?? squareIndex(action.to)];
      let score = captured ? values[captured.toLowerCase()]! : 0;
      if (action.promotion) score += values[action.promotion]! - values.p!;
      if (inCheck(after))
        score += legalBoardMoves(after).length ? 20 : 1_000_000;
      if (score > bestScore) {
        best = action;
        bestScore = score;
      }
    }
    return { ok: true, value: { action: best, nextRandomState: null } };
  } catch (error) {
    return { ok: false, error: asError(error) };
  }
}
