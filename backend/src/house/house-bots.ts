import * as chess from '#engines/chess';
import * as diloti from '#engines/diloti';
import * as rummy from '#engines/rummy';
import * as tichu from '#engines/tichu';
import * as xeri from '#engines/xeri';
import type { GameId } from '../tables/game-catalog';
import { PlatformError } from '../tables/platform-error';

type Choose = (
  observation: never,
  options: { strategy: 'random'; randomState: number },
) =>
  | { ok: true; value: { action: unknown; nextRandomState: number | null } }
  | { ok: false; error: { code: string } };

const SELECTORS: Record<GameId, Choose> = {
  xeri: xeri.chooseBotAction,
  diloti: diloti.chooseBotAction,
  koumkan: rummy.chooseBotAction,
  thanasis: rummy.chooseBotAction,
  biriba: rummy.chooseBotAction,
  tichu: tichu.chooseBotAction,
  chess: chess.chooseBotAction,
};
// The engine reports these when the bot simply has nothing to do right now.
const IDLE = new Set(['NOT_YOUR_TURN', 'ILLEGAL_MOVE', 'GAME_ENDED']);

/**
 * Picks a legal action from the bot seat's own observation (never hidden state),
 * or null when it is not that seat's move. Bots never advance to the next deal:
 * the player controls round transitions. The engine still validates every move.
 */
export function botDecision(
  gameId: GameId,
  observation: unknown,
  randomState: number,
): { action: unknown; nextRandomState: number } | null {
  const result = SELECTORS[gameId](observation as never, {
    strategy: 'random',
    randomState,
  });
  if (!result.ok) {
    if (IDLE.has(result.error.code)) return null;
    throw new PlatformError('platform_unavailable', 503);
  }
  const action = result.value.action;
  if (
    action &&
    typeof action === 'object' &&
    (action as { type?: unknown }).type === 'next'
  )
    return null;
  return {
    action,
    nextRandomState: result.value.nextRandomState ?? randomState,
  };
}
