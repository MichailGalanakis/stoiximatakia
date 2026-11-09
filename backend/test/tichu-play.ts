import type { TichuObservation, PlayerAction } from '#engines/tichu';
/** Test/review helper only: every decision uses this actor's observation. */
export function tichuMove(v: TichuObservation): PlayerAction | null {
  if (v.phase === 'grand' && v.yourMove) return { type: 'grand', call: false };
  if (v.phase === 'exchange' && v.yourMove)
    return { type: 'exchange', cards: v.hand.slice(0, 3) };
  if (v.phase === 'round-end') return { type: 'next' };
  const a = v.legalActions;
  if (v.phase === 'bomb-window')
    return a.find((x) => x.type === 'continue') ?? null;
  if (v.phase === 'dragon') return a.find((x) => x.type === 'dragon') ?? null;
  if (v.turn !== v.viewerSeat) return null;
  const moves = a.filter(
    (x): x is Extract<PlayerAction, { type: 'play' }> => x.type === 'play',
  );
  return (
    moves.sort(
      (x, y) => y.cards.length - x.cards.length || x.option - y.option,
    )[0] ??
    a.find((x) => x.type === 'pass') ??
    null
  );
}
