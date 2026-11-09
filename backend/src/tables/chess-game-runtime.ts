import * as chess from '#engines/chess';
import type { GameId } from './game-catalog';
import type { GameOutcome, TableGameRuntime } from './game-runtime';
import { PlatformError } from './platform-error';

type Participants = readonly { userId: string; seat: number }[];
export type ChessTableObservation = chess.ChessObservation;

function players(participants: Participants): chess.Players {
  const ordered = [...participants].sort((a, b) => a.seat - b.seat);
  if (
    ordered.length !== 2 ||
    ordered.some((p, seat) => p.seat !== seat || !p.userId) ||
    ordered[0]!.userId === ordered[1]!.userId
  )
    throw new PlatformError('platform_unavailable', 503);
  return { white: ordered[0]!.userId, black: ordered[1]!.userId };
}

/** Prepared adapter only: live registration still requires chess rules release clearance. */
export class ChessGameRuntime implements TableGameRuntime {
  readonly version = chess.ENGINE_VERSION;

  start(input: {
    gameId: GameId;
    formatId: string;
    participants: Participants;
  }): { rulesVersion: string; state: chess.ChessState } {
    if (input.gameId !== 'chess' || input.formatId !== 'standard')
      throw new PlatformError('engine_unavailable', 503);
    const created = chess.createGame({ players: players(input.participants) });
    if (!created.ok) throw new PlatformError('platform_unavailable', 503);
    return { rulesVersion: chess.RULES_VERSION, state: created.state };
  }

  private restore(value: unknown): chess.ChessState {
    const restored = chess.restoreState(value);
    if (!restored.ok)
      throw new PlatformError(
        restored.error.code === 'UNSUPPORTED_VERSION'
          ? 'engine_unavailable'
          : 'platform_unavailable',
        503,
      );
    const state = restored.value;
    if (
      state.initial.mode !== 'standard' ||
      state.game !== 'chess' ||
      state.phase === 'awaiting-adjudication' ||
      state.history.some(
        (record) => record.kind !== 'player' || record.action.type === 'resign',
      )
    )
      throw new PlatformError('platform_unavailable', 503);
    return state;
  }

  apply(input: {
    state: unknown;
    userId: string;
    action: unknown;
    participants: Participants;
  }): { state: chess.ChessState; gameplay: boolean; outcome?: GameOutcome } {
    const state = this.restore(input.state),
      roster = players(input.participants);
    if (
      roster.white !== state.initial.players.white ||
      roster.black !== state.initial.players.black
    )
      throw new PlatformError('platform_unavailable', 503);
    if (input.userId !== roster.white && input.userId !== roster.black)
      throw new PlatformError('not_participating', 403);
    // The shared platform forfeit has its own authorised, atomic settlement path.
    // The inherited engine resignation may await adjudication and is not that path.
    if (
      input.action &&
      typeof input.action === 'object' &&
      'type' in input.action &&
      input.action.type === 'resign'
    )
      throw new PlatformError('invalid_game_action', 400);
    const accepted = chess.applyAction(state, input.userId, input.action);
    if (!accepted.ok) {
      switch (accepted.error.code) {
        case 'GAME_ENDED':
          throw new PlatformError('match_ended', 409);
        case 'STALE_REVISION':
          throw new PlatformError('stale_game_revision', 409);
        case 'INVALID_STATE':
        case 'INVALID_CONFIG':
        case 'RESOURCE_LIMIT':
        case 'ADJUDICATION_PENDING':
          throw new PlatformError('platform_unavailable', 503);
        case 'UNSUPPORTED_VERSION':
          throw new PlatformError('engine_unavailable', 503);
        default:
          throw new PlatformError('invalid_game_action', 400);
      }
    }
    const next = accepted.state,
      result = next.matchOutcome;
    if (
      next.revision !== state.revision + 1 ||
      (next.ply !== state.ply && next.ply !== state.ply + 1) ||
      next.phase === 'awaiting-adjudication' ||
      (result?.kind === 'win' &&
        (!result.winner || result.winnerId !== roster[result.winner]))
    )
      throw new PlatformError('platform_unavailable', 503);
    return {
      state: next,
      // Accepted draw commands are durable game decisions too; none reopen refunds.
      gameplay: true,
      ...(result
        ? {
            outcome:
              result.kind === 'draw'
                ? { kind: 'draw' as const, reason: result.gameReason }
                : {
                    kind: 'win' as const,
                    winnerUserIds: [result.winnerId!],
                    reason: result.gameReason,
                  },
          }
        : {}),
    };
  }

  observe(input: { state: unknown; userId: string }): ChessTableObservation {
    const state = this.restore(input.state);
    if (
      input.userId !== state.initial.players.white &&
      input.userId !== state.initial.players.black
    )
      throw new PlatformError('not_participating', 403);
    const view = chess.getObservation(state, input.userId);
    if (!view.ok) throw new PlatformError('platform_unavailable', 503);
    return {
      ...view.value,
      legalActions: view.value.legalActions.filter((a) => a.type !== 'resign'),
    };
  }
}
