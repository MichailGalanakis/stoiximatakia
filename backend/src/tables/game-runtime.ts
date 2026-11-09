import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { GameId } from './game-catalog';

export type GameOutcome =
  | { kind: 'win'; winnerUserIds: readonly string[]; reason: string }
  | { kind: 'draw'; reason: string };

export interface GameActionInput {
  state: unknown;
  userId: string;
  action: unknown;
  participants: readonly { userId: string; seat: number }[];
}
export interface GameActionTransition {
  state: unknown;
  gameplay: boolean;
  outcome?: GameOutcome;
}
export interface GameStartInput {
  gameId: GameId;
  formatId: string;
  participants: readonly { userId: string; seat: number }[];
}
export interface GameInitialization {
  rulesVersion: string;
  state: unknown;
}

/** Trusted server adapter. Browser requests never choose outcome or move classification. */
export interface TableGameRuntime {
  readonly version?: string;
  start(input: GameStartInput): GameInitialization;
  /** Optional initial preparation outside transactions, revalidated before funding. */
  prepareStart?: (input: GameStartInput) => Promise<GameInitialization>;
  apply?(input: GameActionInput): GameActionTransition;
  /**
   * Optional detached preparation outside database transactions. CPU-heavy adapters
   * must use workers/processes rather than blocking the HTTP event loop. Inputs
   * are frozen snapshots; the store reauthenticates/rebinds before committing.
   * No delivery, financial effects or authoritative match changes belong here.
   * Private checkpointed proof storage may be written before a match commits.
   * An adapter using prepare must also expose apply; a strict adapter may use
   * a guarded apply implementation that refuses use without preparation.
   */
  prepare?: (input: GameActionInput) => Promise<GameActionTransition>;
  /** Whitelisted player view only; authoritative state never crosses transport. */
  observe?(input: { state: unknown; userId: string }): unknown;
  preview?(input: {
    state: unknown;
    userId: string;
    selection: unknown;
  }): unknown;
  /** Optional owned resources; registry shutdown awaits each distinct runtime once. */
  close?(): void | Promise<void>;
}

@Injectable()
export class GameRuntimeRegistry implements OnModuleDestroy {
  private readonly engines = new Map<GameId, TableGameRuntime>();
  private closing: Promise<void> | undefined;

  register(game: GameId, engine: TableGameRuntime): void {
    if (this.closing) throw new Error('Game runtime registry is closed');
    if (this.engines.has(game))
      throw new Error('Game runtime already registered');
    this.engines.set(game, engine);
  }

  get(game: GameId): TableGameRuntime | undefined {
    return this.engines.get(game);
  }

  /** Capability detection only; this does not approve or activate an engine. */
  hasPreparation(): boolean {
    return [...this.engines.values()].some((engine) => !!engine.prepare);
  }

  hasStartPreparation(): boolean {
    return [...this.engines.values()].some((engine) => !!engine.prepareStart);
  }

  onModuleDestroy(): Promise<void> {
    this.closing ??= this.closeAll();
    return this.closing;
  }

  private async closeAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...new Set(this.engines.values())].map(async (engine) => {
        await engine.close?.();
      }),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
