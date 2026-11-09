import type {
  BotDecision,
  BotOptions,
  Result,
  TichuObservation,
} from './types.js';
import { asError, fail, keys, object, uint } from './errors.js';

/** Deterministic, non-cryptographic RNG for bot choices, never for dealing cards. */
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
  observation: TichuObservation,
  options: BotOptions = {},
): Result<BotDecision> {
  try {
    const o = object(options, 'INVALID_CONFIG');
    keys(o, ['strategy', 'randomState'], 'INVALID_CONFIG');
    if ('randomState' in o)
      uint(o.randomState, 'randomState', 0xffffffff, 'INVALID_CONFIG');
    const strategy = options.strategy ?? 'first-legal';
    if (!['first-legal', 'random'].includes(strategy))
      fail('INVALID_CONFIG', 'Unknown bot strategy.');
    if (observation.phase === 'ended')
      fail('GAME_ENDED', 'The bot cannot act after the match has ended.');
    if (!observation.yourMove)
      fail('NOT_YOUR_TURN', 'The game is not waiting on this participant.');
    const moves = observation.legalActions;
    if (strategy === 'first-legal')
      return { ok: true, value: { action: moves[0]!, nextRandomState: null } };
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
  } catch (error) {
    return { ok: false, error: asError(error) };
  }
}
