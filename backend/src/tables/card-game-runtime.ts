import { randomBytes } from 'node:crypto';
import * as xeri from '#engines/xeri';
import * as diloti from '#engines/diloti';
import * as rummy from '#engines/rummy';
import * as tichu from '#engines/tichu';
import type { GameId } from './game-catalog';
import type { GameOutcome, TableGameRuntime } from './game-runtime';
import { PlatformError } from './platform-error';

type Participants = readonly { userId: string; seat: number }[];
interface CardState {
  readonly game: string;
  readonly initial: {
    readonly mode: 'standard' | 'analysis';
    readonly players: readonly string[];
  };
  readonly ply: number;
  readonly matchOutcome: {
    readonly kind: 'win';
    readonly winnerId?: string;
    readonly winnerIds?: readonly string[];
    readonly reason: string;
  } | null;
}
interface EngineFailure {
  readonly ok: false;
  readonly error: { readonly code: string };
}
type EngineResult<T> = { readonly ok: true; readonly value: T } | EngineFailure;
type EngineTransition<S> =
  { readonly ok: true; readonly state: S } | EngineFailure;
type Players =
  readonly [string, string] | readonly [string, string, string, string];
interface CardEngine<S extends CardState, P extends readonly string[]> {
  readonly ENGINE_VERSION: string;
  readonly RULES_VERSION: string;
  createGame(input: {
    players: P;
    seed: string;
    format?: tichu.FormatId;
  }): EngineTransition<S>;
  restoreState(input: unknown): EngineResult<S>;
  applyAction(state: S, userId: string, action: unknown): EngineTransition<S>;
  getObservation(state: S, userId: string): EngineResult<unknown>;
}

function playerIds(participants: Participants, capacity: 2 | 4): Players {
  const ordered = [...participants].sort((a, b) => a.seat - b.seat);
  if (
    ordered.length !== capacity ||
    ordered.some((p, index) => p.seat !== index || !p.userId) ||
    new Set(ordered.map((p) => p.userId)).size !== capacity
  )
    throw new PlatformError('platform_unavailable', 503);
  return ordered.map((p) => p.userId) as unknown as Players;
}

/** No browser state, seed, result, dealer or analysis configuration enters this boundary. */
class CardGameRuntime<
  S extends CardState,
  P extends readonly string[] = readonly [string, string],
> implements TableGameRuntime {
  readonly version: string;

  constructor(
    private readonly game:
      'xeri' | 'diloti' | 'koumkan' | 'thanasis' | 'biriba' | 'tichu',
    private readonly engine: CardEngine<S, P>,
  ) {
    this.version = engine.ENGINE_VERSION;
  }

  start(input: {
    gameId: GameId;
    formatId: string;
    participants: Participants;
  }): { rulesVersion: string; state: S } {
    if (
      input.gameId !== this.game ||
      (this.game === 'tichu'
        ? !Object.hasOwn(tichu.FORMATS, input.formatId)
        : input.formatId !== 'standard')
    )
      throw new PlatformError('engine_unavailable', 503);
    const created = this.engine.createGame({
      players: playerIds(
        input.participants,
        this.game === 'biriba' || this.game === 'tichu' ? 4 : 2,
      ) as unknown as P,
      seed: randomBytes(32).toString('hex'),
      ...(this.game === 'tichu'
        ? { format: input.formatId as tichu.FormatId }
        : {}),
    });
    if (!created.ok) throw new PlatformError('platform_unavailable', 503);
    return { rulesVersion: this.engine.RULES_VERSION, state: created.state };
  }

  protected restore(value: unknown): S {
    const restored = this.engine.restoreState(value);
    if (!restored.ok)
      throw new PlatformError(
        restored.error.code === 'UNSUPPORTED_VERSION'
          ? 'engine_unavailable'
          : 'platform_unavailable',
        503,
      );
    if (
      restored.value.initial.mode !== 'standard' ||
      restored.value.game !== this.game
    )
      throw new PlatformError('platform_unavailable', 503);
    return restored.value;
  }

  apply(input: {
    state: unknown;
    userId: string;
    action: unknown;
    participants: Participants;
  }): { state: S; gameplay: boolean; outcome?: GameOutcome } {
    const state = this.restore(input.state),
      players = playerIds(
        input.participants,
        this.game === 'biriba' || this.game === 'tichu' ? 4 : 2,
      );
    if (
      players.length !== state.initial.players.length ||
      players.some((id, seat) => id !== state.initial.players[seat])
    )
      throw new PlatformError('platform_unavailable', 503);
    if (!players.includes(input.userId))
      throw new PlatformError('not_participating', 403);
    const accepted = this.engine.applyAction(state, input.userId, input.action);
    if (!accepted.ok) {
      switch (accepted.error.code) {
        case 'GAME_ENDED':
          throw new PlatformError('match_ended', 409);
        case 'STALE_REVISION':
          throw new PlatformError('stale_game_revision', 409);
        case 'INVALID_STATE':
        case 'INVALID_CONFIG':
        case 'RESOURCE_LIMIT':
          throw new PlatformError('platform_unavailable', 503);
        case 'UNSUPPORTED_VERSION':
          throw new PlatformError('engine_unavailable', 503);
        default:
          throw new PlatformError('invalid_game_action', 400);
      }
    }
    const playedCards = accepted.state.ply - state.ply;
    if (playedCards !== 0 && playedCards !== 1)
      throw new PlatformError('platform_unavailable', 503);
    const outcome = accepted.state.matchOutcome;
    const winners = outcome ? (outcome.winnerIds ?? [outcome.winnerId!]) : [];
    if (
      outcome &&
      (winners.length !==
        (this.game === 'biriba' || this.game === 'tichu' ? 2 : 1) ||
        new Set(winners).size !== winners.length ||
        winners.some((id) => !players.includes(id)) ||
        ((this.game === 'biriba' || this.game === 'tichu') &&
          new Set(winners.map((id) => players.indexOf(id) % 2)).size !== 1))
    )
      throw new PlatformError('platform_unavailable', 503);
    return {
      state: accepted.state,
      gameplay: playedCards === 1,
      ...(outcome
        ? {
            outcome: {
              kind: 'win' as const,
              winnerUserIds: winners,
              reason: outcome.reason,
            },
          }
        : {}),
    };
  }

  observe(input: { state: unknown; userId: string }): unknown {
    const state = this.restore(input.state);
    if (!state.initial.players.includes(input.userId))
      throw new PlatformError('not_participating', 403);
    const view = this.engine.getObservation(state, input.userId);
    if (!view.ok) throw new PlatformError('platform_unavailable', 503);
    return view.value;
  }
}

export class XeriGameRuntime extends CardGameRuntime<xeri.XeriState> {
  constructor() {
    super('xeri', xeri);
  }
}

export class DilotiGameRuntime extends CardGameRuntime<diloti.DilotiState> {
  constructor() {
    super('diloti', diloti);
  }
  preview(input: {
    state: unknown;
    userId: string;
    selection: unknown;
  }): diloti.SelectionPreview {
    const restored = diloti.restoreState(input.state);
    if (!restored.ok || restored.value.initial.mode !== 'standard')
      throw new PlatformError('platform_unavailable', 503);
    const result = diloti.previewSelection(
      restored.value,
      input.userId,
      input.selection,
    );
    if (!result.ok) throw new PlatformError('invalid_game_action', 400);
    return result.value;
  }
}

/** Only explicitly approved rummy variants enter this adapter. */
class RummyGameRuntime extends CardGameRuntime<
  rummy.RummyState,
  rummy.Players
> {
  constructor(game: 'koumkan' | 'thanasis' | 'biriba') {
    super(game, {
      ...rummy,
      RULES_VERSION: rummy.RULES_VERSIONS[game],
      createGame: (input) => rummy.createGame({ ...input, game }),
    });
  }
  override observe(input: { state: unknown; userId: string }): unknown {
    const state = this.restore(input.state);
    const view = super.observe({
      state,
      userId: input.userId,
    }) as rummy.RummyObservation;
    const last = state.history.at(-1);
    // Draw history names the source only. Never add the newly drawn hidden card.
    return {
      ...view,
      // The shared room represents the two unused reserve slots as zero counts.
      // Keep engine state untouched; Biriba retains its real packet counts.
      reserveCounts:
        state.initial.game === 'biriba' ? view.reserveCounts : [0, 0],
      lastPlay: last ? { playerId: last.playerId, action: last.action } : null,
    };
  }
}

export class ThanasisGameRuntime extends RummyGameRuntime {
  constructor() {
    super('thanasis');
  }
}

class MeldRummyGameRuntime extends RummyGameRuntime {
  preview(input: {
    state: unknown;
    userId: string;
    selection: unknown;
  }): rummy.SelectionPreview {
    const result = rummy.previewSelection(
      this.restore(input.state),
      input.userId,
      input.selection,
    );
    if (!result.ok) throw new PlatformError('invalid_game_action', 400);
    return result.value;
  }
}

export class KoumkanGameRuntime extends MeldRummyGameRuntime {
  constructor() {
    super('koumkan');
  }
}

export class BiribaGameRuntime extends MeldRummyGameRuntime {
  constructor() {
    super('biriba');
  }
}

export class TichuGameRuntime extends CardGameRuntime<
  tichu.TichuState,
  tichu.Players
> {
  constructor() {
    super('tichu', {
      ...tichu,
      createGame: (input) =>
        tichu.createGame({ ...input, format: input.format ?? '1000' }),
    });
  }
  override observe(input: { state: unknown; userId: string }): unknown {
    const state = this.restore(input.state),
      view = super.observe({
        state,
        userId: input.userId,
      }) as tichu.TichuObservation;
    const last = state.history.at(-1);
    return {
      ...view,
      lastPlay: last
        ? {
            playerId: last.playerId,
            action:
              last.action.type === 'exchange'
                ? { type: 'exchange' }
                : last.action,
          }
        : null,
    };
  }
  preview(input: {
    state: unknown;
    userId: string;
    selection: unknown;
  }): tichu.SelectionPreview {
    const result = tichu.previewSelection(
      this.restore(input.state),
      input.userId,
      input.selection,
    );
    if (!result.ok) throw new PlatformError('invalid_game_action', 400);
    return result.value;
  }
}
