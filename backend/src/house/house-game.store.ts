import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import {
  REGISTRATION_SETTINGS,
  type RegistrationSettings,
} from '../registration/registration-settings';
import { GAME_CONFIG, type GameId } from '../tables/game-catalog';
import {
  GameRuntimeRegistry,
  type GameActionInput,
  type GameActionTransition,
  type GameOutcome,
  type TableGameRuntime,
} from '../tables/game-runtime';
import { PlatformError } from '../tables/platform-error';
import {
  HOUSE_MATCH_COLUMNS,
  houseMatchView,
  settleHouseMatch,
  startHouseMatch,
  type HouseMatch,
  type HouseOutcome,
} from '../wallet/house-matches';
import { WalletError } from '../wallet/wallet-error';
import { botDecision } from './house-bots';

const SESSION_PATTERN = /^[a-f0-9]{64}$/;
// A deal can need many consecutive bot moves; this only stops a runaway loop.
const MAX_BOT_STEPS = 5000;
const fingerprintOf = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface Actor {
  id: string;
  account_kind: string;
  email_verified: boolean;
  phone_verified: boolean;
}
interface GameRow {
  match_id: string;
  format_id: string;
  engine_version: string;
  rules_version: string;
  players: string[];
  state: unknown;
  revision: number;
  bot_random_state: string;
}
interface Step {
  actor: string;
  action: unknown;
}
interface Played {
  state: unknown;
  steps: Step[];
  randomState: number;
  outcome?: GameOutcome | undefined;
}
type Participants = { userId: string; seat: number }[];

export interface HouseGameView {
  match: HouseMatch;
  game: {
    revision: number;
    formatId: string;
    engineVersion: string;
    rulesVersion: string;
    seats: { seat: number; kind: 'player' | 'bot' }[];
    observation: unknown;
  };
}

const participantsOf = (players: readonly string[]): Participants =>
  players.map((userId, seat) => ({ userId, seat }));
const outcomeFor = (outcome: GameOutcome, userId: string): HouseOutcome =>
  outcome.kind === 'draw'
    ? 'void'
    : outcome.winnerUserIds.includes(userId)
      ? 'won'
      : 'lost';

/** Player-vs-platform games: the server plays every bot seat and settles the result. */
@Injectable()
export class HouseGameStore implements OnModuleDestroy {
  private readonly pool: Pool | undefined;

  constructor(
    @Inject(REGISTRATION_SETTINGS) registration: RegistrationSettings,
    @Inject(GameRuntimeRegistry) private readonly engines: GameRuntimeRegistry,
  ) {
    if (registration.databaseUrl) {
      this.pool = new Pool({
        connectionString: registration.databaseUrl,
        max: 4,
        connectionTimeoutMillis: 3000,
        query_timeout: 5000,
      });
      this.pool.on('error', () => {});
    }
  }
  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  private async session<T>(
    hash: string,
    run: (c: PoolClient, actor: Actor) => Promise<T>,
  ): Promise<T> {
    if (!SESSION_PATTERN.test(hash))
      throw new PlatformError('account_session_expired', 401);
    if (!this.pool) throw new PlatformError('platform_unavailable', 503);
    const client = await this.pool.connect().catch(() => {
      throw new PlatformError('platform_unavailable', 503);
    });
    try {
      await client.query('BEGIN');
      // Same account lock as table and wallet commands.
      const { rows } = await client.query<Actor>(
        `SELECT u.id,u.account_kind,u.email_verified,u.phone_verified FROM users u
         JOIN account_sessions s ON s.user_id=u.id
         WHERE s.token_hash=$1 AND s.expires_at>now() FOR NO KEY UPDATE OF u FOR SHARE OF s`,
        [hash],
      );
      if (!rows[0]) throw new PlatformError('account_session_expired', 401);
      const result = await run(client, rows[0]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof PlatformError || error instanceof WalletError)
        throw error;
      throw new PlatformError('platform_unavailable', 503);
    } finally {
      client.release();
    }
  }

  private async previous<T>(
    c: PoolClient,
    userId: string,
    operationId: string,
    fingerprint: string,
  ): Promise<T | undefined> {
    const { rows } = await c.query<{ fingerprint: string; response: T }>(
      'SELECT fingerprint,response FROM wallet_operations WHERE user_id=$1 AND operation_id=$2',
      [userId, operationId],
    );
    if (!rows[0]) return undefined;
    if (rows[0].fingerprint !== fingerprint)
      throw new PlatformError('operation_conflict', 409);
    return rows[0].response;
  }
  private async remember(
    c: PoolClient,
    userId: string,
    operationId: string,
    fingerprint: string,
    response: unknown,
  ) {
    await c.query(
      'INSERT INTO wallet_operations(user_id,operation_id,fingerprint,response) VALUES($1,$2,$3,$4)',
      [userId, operationId, fingerprint, JSON.stringify(response)],
    );
  }

  private requireEligible(actor: Actor) {
    if (
      actor.account_kind !== 'registered' ||
      !(actor.email_verified || actor.phone_verified)
    )
      throw new WalletError('account_not_eligible', 403);
  }

  private runtime(gameId: GameId, version?: string) {
    const runtime = this.engines.get(gameId);
    if (
      !runtime?.observe ||
      !(runtime.apply || runtime.prepare) ||
      (version !== undefined && runtime.version !== version)
    )
      throw new PlatformError('engine_unavailable', 503);
    return runtime as TableGameRuntime & {
      observe: NonNullable<TableGameRuntime['observe']>;
    };
  }

  /** Detached engines (chess) prepare moves outside database transactions. */
  private async transition(
    runtime: TableGameRuntime,
    input: GameActionInput,
  ): Promise<GameActionTransition> {
    return runtime.prepare ? runtime.prepare(input) : runtime.apply!(input);
  }

  private async playBots(
    gameId: GameId,
    runtime: TableGameRuntime & {
      observe: NonNullable<TableGameRuntime['observe']>;
    },
    participants: Participants,
    from: Played,
  ): Promise<Played> {
    let { state, randomState } = from;
    const steps = [...from.steps];
    for (let i = 0; i < MAX_BOT_STEPS; i++) {
      let acted = false;
      for (const bot of participants.slice(1)) {
        const decision = botDecision(
          gameId,
          runtime.observe({ state, userId: bot.userId }),
          randomState,
        );
        if (!decision) continue;
        const next = await this.transition(runtime, {
          state,
          userId: bot.userId,
          action: decision.action,
          participants,
        });
        state = next.state;
        randomState = decision.nextRandomState;
        steps.push({ actor: bot.userId, action: decision.action });
        if (next.outcome)
          return { state, steps, randomState, outcome: next.outcome };
        acted = true;
        break;
      }
      if (!acted) return { state, steps, randomState };
    }
    throw new PlatformError('platform_unavailable', 503);
  }

  private async loadMatch(c: PoolClient, matchId: string, userId: string) {
    const { rows } = await c.query<Parameters<typeof houseMatchView>[0]>(
      `SELECT ${HOUSE_MATCH_COLUMNS} FROM house_matches WHERE id=$1`,
      [matchId],
    );
    if (!rows[0] || rows[0].user_id !== userId)
      throw new WalletError('house_match_not_found', 404);
    return houseMatchView(rows[0]);
  }
  private async loadGame(c: PoolClient, matchId: string, lock = false) {
    const { rows } = await c.query<GameRow>(
      `SELECT * FROM house_games WHERE match_id=$1${lock ? ' FOR UPDATE' : ''}`,
      [matchId],
    );
    if (!rows[0]) throw new WalletError('house_match_not_found', 404);
    return rows[0];
  }

  private async record(
    c: PoolClient,
    matchId: string,
    fromRevision: number,
    steps: readonly Step[],
  ) {
    let revision = fromRevision;
    for (const step of steps)
      await c.query(
        "INSERT INTO house_game_events(match_id,revision,kind,actor,action) VALUES($1,$2,'action',$3,$4)",
        [matchId, ++revision, step.actor, JSON.stringify(step.action)],
      );
    return revision;
  }

  private view(
    match: HouseMatch,
    game: Pick<
      GameRow,
      'format_id' | 'engine_version' | 'rules_version' | 'players' | 'state'
    > & { revision: number },
  ): HouseGameView {
    const runtime = this.runtime(match.gameId as GameId, game.engine_version);
    return {
      match,
      game: {
        revision: game.revision,
        formatId: game.format_id,
        engineVersion: game.engine_version,
        rulesVersion: game.rules_version,
        seats: game.players.map((_, seat) => ({
          seat,
          kind: seat === 0 ? 'player' : 'bot',
        })),
        observation: runtime.observe({
          state: game.state,
          userId: match.userId,
        }),
      },
    };
  }

  offers(hash: string) {
    return this.session(hash, async (c) => {
      const { rows } = await c.query<{
        id: string;
        stakeMinor: number;
        prizeMinor: number;
      }>(
        'SELECT id,stake_minor::float8 AS "stakeMinor",prize_minor::float8 AS "prizeMinor" FROM house_offers WHERE active ORDER BY stake_minor,id',
      );
      return { currency: 'EUR', offers: rows };
    });
  }

  game(hash: string, matchId: string) {
    return this.session(hash, async (c, actor) => {
      const match = await this.loadMatch(c, matchId, actor.id);
      return this.view(match, await this.loadGame(c, matchId));
    });
  }

  async start(
    hash: string,
    input: {
      operationId: string;
      gameId: GameId;
      offerId: string;
      formatId?: string | undefined;
    },
  ): Promise<HouseGameView> {
    const formatId =
      input.formatId ?? (input.gameId === 'tichu' ? 'single' : 'standard');
    if (!Object.hasOwn(GAME_CONFIG[input.gameId].formats, formatId))
      throw new PlatformError('invalid_table_request', 400);
    const fingerprint = fingerprintOf({
      type: 'house_start',
      ...input,
      formatId,
    });
    const pre = await this.session(hash, async (c, actor) => {
      const done = await this.previous<HouseGameView>(
        c,
        actor.id,
        input.operationId,
        fingerprint,
      );
      if (!done) this.requireEligible(actor);
      return { done, userId: actor.id };
    });
    if (pre.done) return pre.done;

    const runtime = this.runtime(input.gameId);
    const matchId = randomUUID();
    const players = [
      pre.userId,
      ...Array.from(
        { length: GAME_CONFIG[input.gameId].seats - 1 },
        (_, i) => `bot-${i + 1}`,
      ),
    ];
    const participants = participantsOf(players);
    const startInput = { gameId: input.gameId, formatId, participants };
    const initial = runtime.prepareStart
      ? await runtime.prepareStart(startInput)
      : runtime.start(startInput);
    const played = await this.playBots(input.gameId, runtime, participants, {
      state: initial.state,
      steps: [],
      randomState: randomInt(0, 2 ** 32),
    });

    return this.session(hash, async (c, actor) => {
      if (actor.id !== pre.userId)
        throw new PlatformError('account_session_expired', 401);
      const done = await this.previous<HouseGameView>(
        c,
        actor.id,
        input.operationId,
        fingerprint,
      );
      if (done) return done;
      this.requireEligible(actor);
      let match = await startHouseMatch(c, {
        matchId,
        userId: actor.id,
        offerId: input.offerId,
        gameId: input.gameId,
      });
      const revision = 1 + played.steps.length;
      await c.query(
        `INSERT INTO house_games(match_id,format_id,engine_version,rules_version,players,state,revision,bot_random_state)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          matchId,
          formatId,
          runtime.version ?? 'initialization-only',
          initial.rulesVersion,
          players,
          JSON.stringify(played.state),
          revision,
          played.randomState,
        ],
      );
      await c.query(
        "INSERT INTO house_game_events(match_id,revision,kind,actor) VALUES($1,1,'start',$2)",
        [matchId, actor.id],
      );
      await this.record(c, matchId, 1, played.steps);
      if (played.outcome)
        match = await settleHouseMatch(
          c,
          matchId,
          outcomeFor(played.outcome, actor.id),
        );
      const response = this.view(match, {
        format_id: formatId,
        engine_version: runtime.version ?? 'initialization-only',
        rules_version: initial.rulesVersion,
        players,
        state: played.state,
        revision,
      });
      await this.remember(
        c,
        actor.id,
        input.operationId,
        fingerprint,
        response,
      );
      return response;
    });
  }

  async act(
    hash: string,
    input: {
      operationId: string;
      matchId: string;
      expectedRevision: number;
      action: unknown;
    },
  ): Promise<HouseGameView> {
    const encoded = JSON.stringify(input.action);
    if (typeof encoded !== 'string' || encoded.length > 4096)
      throw new PlatformError('invalid_game_action', 400);
    const fingerprint = fingerprintOf({ type: 'house_action', ...input });
    const pre = await this.session(hash, async (c, actor) => {
      const done = await this.previous<HouseGameView>(
        c,
        actor.id,
        input.operationId,
        fingerprint,
      );
      if (done) return { done };
      const match = await this.loadMatch(c, input.matchId, actor.id);
      if (match.status !== 'active')
        throw new PlatformError('match_ended', 409);
      const game = await this.loadGame(c, input.matchId);
      if (game.revision !== input.expectedRevision)
        throw new PlatformError('stale_game_revision', 409);
      return { match, game };
    });
    if (pre.done) return pre.done;
    const { match, game } = pre as { match: HouseMatch; game: GameRow };

    const gameId = match.gameId as GameId;
    const runtime = this.runtime(gameId, game.engine_version);
    const participants = participantsOf(game.players);
    const human = await this.transition(runtime, {
      state: game.state,
      userId: match.userId,
      action: JSON.parse(encoded) as unknown,
      participants,
    });
    const first: Played = {
      state: human.state,
      steps: [{ actor: match.userId, action: JSON.parse(encoded) as unknown }],
      randomState: Number(game.bot_random_state),
      outcome: human.outcome,
    };
    const played = first.outcome
      ? first
      : await this.playBots(gameId, runtime, participants, first);

    return this.session(hash, async (c, actor) => {
      const done = await this.previous<HouseGameView>(
        c,
        actor.id,
        input.operationId,
        fingerprint,
      );
      if (done) return done;
      // Optimistic check: another command may have moved the game meanwhile.
      const current = await this.loadGame(c, input.matchId, true);
      let latest = await this.loadMatch(c, input.matchId, actor.id);
      if (latest.status !== 'active')
        throw new PlatformError('match_ended', 409);
      if (current.revision !== input.expectedRevision)
        throw new PlatformError('stale_game_revision', 409);
      const revision = await this.record(
        c,
        input.matchId,
        current.revision,
        played.steps,
      );
      await c.query(
        'UPDATE house_games SET state=$2,revision=$3,bot_random_state=$4,updated_at=now() WHERE match_id=$1',
        [
          input.matchId,
          JSON.stringify(played.state),
          revision,
          played.randomState,
        ],
      );
      if (played.outcome)
        latest = await settleHouseMatch(
          c,
          input.matchId,
          outcomeFor(played.outcome, actor.id),
        );
      const response = this.view(latest, {
        ...current,
        state: played.state,
        revision,
      });
      await this.remember(
        c,
        actor.id,
        input.operationId,
        fingerprint,
        response,
      );
      return response;
    });
  }

  forfeit(hash: string, operationId: string, matchId: string) {
    const fingerprint = fingerprintOf({ type: 'house_forfeit', matchId });
    return this.session(hash, async (c, actor) => {
      const done = await this.previous<HouseGameView>(
        c,
        actor.id,
        operationId,
        fingerprint,
      );
      if (done) return done;
      const game = await this.loadGame(c, matchId, true);
      const match = await this.loadMatch(c, matchId, actor.id);
      if (match.status !== 'active')
        throw new PlatformError('match_ended', 409);
      const revision = game.revision + 1;
      await c.query(
        "INSERT INTO house_game_events(match_id,revision,kind,actor) VALUES($1,$2,'forfeit',$3)",
        [matchId, revision, actor.id],
      );
      await c.query(
        'UPDATE house_games SET revision=$2,updated_at=now() WHERE match_id=$1',
        [matchId, revision],
      );
      const settled = await settleHouseMatch(c, matchId, 'lost');
      const response = this.view(settled, { ...game, revision });
      await this.remember(c, actor.id, operationId, fingerprint, response);
      return response;
    });
  }
}
