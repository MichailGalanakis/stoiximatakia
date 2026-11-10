import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import {
  REGISTRATION_SETTINGS,
  type RegistrationSettings,
} from '../registration/registration-settings';
import { GAME_CONFIG, ENTRY_FEE_MINOR, type GameId } from './game-catalog';
import {
  GameRuntimeRegistry,
  type GameActionInput,
  type GameActionTransition,
  type GameStartInput,
  type GameInitialization,
  type TableGameRuntime,
} from './game-runtime';
import { PlatformError } from './platform-error';
import { PLATFORM_SETTINGS, type PlatformSettings } from './platform-settings';
import { requireJurisdiction } from '../wallet/jurisdiction';
import { WalletError } from '../wallet/wallet-error';
import type { CreateTableDto } from './table.dto';
import {
  feeAccount,
  openPool,
  playerBalance,
  poolAccount,
  postTableMoney,
  type TableCurrency,
} from './table-ledger';
import {
  advanceGame,
  checkRevision,
  concludeMatch,
  loadGame,
  participant,
  requirePlaying,
  startHistory,
  summary,
  type MatchSummary,
  type GameRow,
  type RosterMember,
} from './match-lifecycle';

export interface TableRow {
  id: string;
  creator_id: string;
  game_id: GameId;
  name: string;
  visibility: 'public' | 'private';
  format_id: string;
  capacity: number;
  entry_fee_minor: number;
  contribution_minor: number;
  status: 'waiting' | 'playing' | 'completed' | 'cancelled';
  revision: number;
  created_at: Date;
  started_at: Date | null;
  currency: TableCurrency;
}
export interface TableSnapshot {
  id: string;
  gameId: GameId;
  name: string;
  visibility: 'public' | 'private';
  revision: number;
  status: TableRow['status'];
  capacity: number;
  minPlayers: number;
  formatId: string;
  formatLabel: string;
  currency: TableCurrency;
  entryFee: number;
  prizeContribution: number;
  createdAt: string;
  startsAt: string | null;
  startLabel: string;
  rulesVersion: string;
  seats: {
    index: number;
    player: { id: string; name: string; ready: boolean } | null;
  }[];
  prizeShares: { label: string; basisPoints: number; splitLabel: string }[];
  cancellationPolicy: { published: boolean; text: string };
  ticket: {
    id: string;
    state: string;
    feeMinor: number;
    contributionMinor: number;
  } | null;
  gameAvailable: boolean;
}
export interface CommandResult {
  table: TableSnapshot;
  balance: { availableMinor: number; reservedMinor: number };
  match?: MatchSummary;
  game?: PlayerGameView;
}
export interface PlayerGameView {
  status: TableRow['status'];
  /** Platform revision used by actions/forfeit, separate from engine revision. */
  revision: number;
  engineVersion: string;
  rulesVersion: string;
  observation: unknown;
}
const SESSION_PATTERN = /^[a-f0-9]{64}$/;
const fingerprintOf = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

interface ActionSource {
  table: TableRow;
  members: RosterMember[];
  game: GameRow;
  runtime: TableGameRuntime & {
    apply: NonNullable<TableGameRuntime['apply']>;
  };
}
interface PreparationSource {
  userId: string;
  fingerprint: string;
  engineVersion: string;
  rulesVersion: string;
  runtime: TableGameRuntime;
  prepare: NonNullable<TableGameRuntime['prepare']>;
  input: GameActionInput;
}
type ActionPreparation =
  | {
      kind: 'ready';
      source: PreparationSource;
      accepted: GameActionTransition;
    }
  | { kind: 'failed'; source?: PreparationSource; error: unknown };

interface WaitingMember extends RosterMember {
  ready: boolean;
  ticket_state: string;
  fee_minor: number;
  contribution_minor: number;
}
interface StartSource {
  userId: string;
  fingerprint: string;
  version: string | undefined;
  runtime: TableGameRuntime;
  prepare: NonNullable<TableGameRuntime['prepareStart']>;
  input: GameStartInput;
}
type StartPreparation =
  | { kind: 'ready'; source: StartSource; accepted: GameInitialization }
  | { kind: 'failed'; source?: StartSource; error: unknown };

function startFingerprint(
  table: TableRow,
  members: WaitingMember[],
  userId: string,
  requestFingerprint: string,
): string {
  return fingerprintOf({
    userId,
    requestFingerprint,
    table: {
      id: table.id,
      creator: table.creator_id,
      game: table.game_id,
      format: table.format_id,
      status: table.status,
      capacity: table.capacity,
      fee: table.entry_fee_minor,
      contribution: table.contribution_minor,
    },
    // Ready flags may advance concurrently; the engine input does not depend on
    // them. A replacement reservation, seat change or money change invalidates it.
    members: members.map((member) => ({
      userId: member.user_id,
      seat: member.seat_index,
      ticketId: member.ticket_id,
      ticketState: member.ticket_state,
      fee: member.fee_minor,
      contribution: member.contribution_minor,
    })),
  });
}

function detachedInitialization(value: GameInitialization): GameInitialization {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string' || encoded.length > 16_032_768)
    throw new PlatformError('platform_unavailable', 503);
  const detached = JSON.parse(encoded) as GameInitialization,
    state = JSON.stringify(detached.state);
  if (
    typeof detached.rulesVersion !== 'string' ||
    !detached.rulesVersion ||
    detached.rulesVersion.length > 128 ||
    typeof state !== 'string' ||
    state.length > 16_000_000
  )
    throw new PlatformError('platform_unavailable', 503);
  return freezeJson(detached);
}

function sourceFingerprint(
  source: ActionSource,
  userId: string,
  requestFingerprint: string,
): string {
  return fingerprintOf({
    userId,
    requestFingerprint,
    table: {
      id: source.table.id,
      game: source.table.game_id,
      format: source.table.format_id,
      status: source.table.status,
      revision: source.table.revision,
    },
    game: source.game,
    members: source.members,
  });
}

/** Snapshot the trusted adapter's result before the next asynchronous boundary. */
function detachedTransition(value: GameActionTransition): GameActionTransition {
  const encoded = JSON.stringify({
    state: value.state,
    gameplay: value.gameplay,
    outcome: value.outcome,
  });
  if (encoded.length > 16_032_768)
    throw new PlatformError('platform_unavailable', 503);
  const detached = JSON.parse(encoded) as GameActionTransition;
  const state = JSON.stringify(detached.state),
    outcome: unknown = detached.outcome;
  if (
    typeof state !== 'string' ||
    state.length > 16_000_000 ||
    typeof detached.gameplay !== 'boolean' ||
    (outcome !== undefined &&
      (outcome === null ||
        typeof outcome !== 'object' ||
        Array.isArray(outcome) ||
        !('kind' in outcome) ||
        !['win', 'draw'].includes(String(outcome.kind)) ||
        !('reason' in outcome) ||
        typeof outcome.reason !== 'string' ||
        JSON.stringify(outcome).length > 16_384))
  )
    throw new PlatformError('platform_unavailable', 503);
  return freezeJson(detached);
}

@Injectable()
export class PlatformStore implements OnModuleDestroy {
  readonly pool: Pool | undefined;
  constructor(
    @Inject(REGISTRATION_SETTINGS) registration: RegistrationSettings,
    @Inject(PLATFORM_SETTINGS) private readonly settings: PlatformSettings,
    @Inject(GameRuntimeRegistry) private readonly engines: GameRuntimeRegistry,
  ) {
    if (registration.databaseUrl) {
      this.pool = new Pool({
        connectionString: registration.databaseUrl,
        max: 8,
        connectionTimeoutMillis: 3000,
        query_timeout: 5000,
      });
      this.pool.on('error', () => {});
    }
  }
  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  async session<T>(
    hash: string,
    run: (client: PoolClient, userId: string) => Promise<T>,
  ): Promise<T> {
    if (!SESSION_PATTERN.test(hash))
      throw new PlatformError('account_session_expired', 401);
    if (!this.pool) throw new PlatformError('platform_unavailable', 503);
    const client = await this.pool.connect().catch(() => {
      throw new PlatformError('platform_unavailable', 503);
    });
    try {
      await client.query('BEGIN');
      // Same account commands serialize across devices/processes. Lock the session
      // too so a successful mutation and concurrent logout have a defined order.
      // NO KEY UPDATE still serializes this account, but permits FK KEY SHARE
      // checks when another participant updates a table this account created.
      const actor = await client.query<{ id: string }>(
        `SELECT u.id FROM users u JOIN account_sessions s ON s.user_id=u.id
         WHERE s.token_hash=$1 AND s.expires_at>now() FOR NO KEY UPDATE OF u FOR SHARE OF s`,
        [hash],
      );
      const id = actor.rows[0]?.id;
      if (!id) throw new PlatformError('account_session_expired', 401);
      const result = await run(client, id);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505' &&
        'constraint' in error &&
        error.constraint === 'game_tables_code_hash_key'
      )
        throw new PlatformError('private_code_unavailable', 409);
      if (error instanceof PlatformError || error instanceof WalletError)
        throw error;
      throw new PlatformError('platform_unavailable', 503);
    } finally {
      client.release();
    }
  }

  async balance(
    client: PoolClient,
    id: string,
    currency: TableCurrency = 'credits',
  ) {
    const balance = await playerBalance(client, currency, id);
    if (!balance) throw new PlatformError('platform_unavailable', 503);
    return balance;
  }

  async snapshot(
    client: PoolClient,
    id: string,
    viewer: string,
  ): Promise<TableSnapshot> {
    const { rows } = await client.query<TableRow>(
      `SELECT t.* FROM game_tables t WHERE t.id=$1 AND (t.visibility='public' OR
       EXISTS(SELECT 1 FROM table_access a WHERE a.table_id=t.id AND a.user_id=$2))`,
      [id, viewer],
    );
    const table = rows[0];
    if (!table) throw new PlatformError('table_not_found', 404);
    const participants = await client.query<{
      user_id: string;
      seat_index: number;
      ready: boolean;
      username: string;
    }>(
      table.status === 'waiting' || table.status === 'playing'
        ? 'SELECT p.user_id,p.seat_index,p.ready,u.username FROM table_participations p JOIN users u ON u.id=p.user_id WHERE p.table_id=$1 ORDER BY p.seat_index'
        : 'SELECT p.user_id,p.seat_index,false AS ready,u.username FROM match_roster p JOIN users u ON u.id=p.user_id WHERE p.table_id=$1 ORDER BY p.seat_index',
      [id],
    );
    const ticket = await client.query<{
      id: string;
      state: string;
      fee_minor: number;
      contribution_minor: number;
    }>(
      'SELECT id,state,fee_minor,contribution_minor FROM table_tickets WHERE table_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
      [id, viewer],
    );
    const own = ticket.rows[0];
    const game = GAME_CONFIG[table.game_id];
    return {
      id: table.id,
      gameId: table.game_id,
      name: table.name,
      visibility: table.visibility,
      revision: table.revision,
      status: table.status,
      capacity: table.capacity,
      minPlayers: table.capacity,
      formatId: table.format_id,
      formatLabel: game.formats[table.format_id]!,
      currency: table.currency,
      entryFee: table.entry_fee_minor,
      prizeContribution: table.contribution_minor,
      createdAt: table.created_at.toISOString(),
      startsAt: table.started_at?.toISOString() ?? null,
      startLabel:
        'Όταν συμπληρωθούν οι θέσεις και όλοι οι παίκτες είναι έτοιμοι',
      rulesVersion: 'platform-v1',
      gameAvailable: !!this.engines.get(table.game_id),
      seats: Array.from({ length: table.capacity }, (_, index) => {
        const p = participants.rows.find((p) => p.seat_index === index);
        return {
          index,
          player: p
            ? { id: p.user_id, name: p.username, ready: p.ready }
            : null,
        };
      }),
      prizeShares: [
        {
          label: game.team ? 'Νικήτρια ομάδα' : 'Νικητής',
          basisPoints: 10000,
          splitLabel: game.team
            ? '50% σε κάθε συμπαίκτη'
            : 'Ολόκληρο το ταμείο επάθλων',
        },
      ],
      cancellationPolicy: {
        published: true,
        text: 'Πριν από την έναρξη, η ακύρωση συμμετοχής επιστρέφει ολόκληρο το ποσό, μαζί με την αμοιβή διοργάνωσης.',
      },
      ticket: own
        ? {
            id: own.id,
            state: own.state,
            feeMinor: own.fee_minor,
            contributionMinor: own.contribution_minor,
          }
        : null,
    };
  }

  async list(
    hash: string,
    gameId: GameId,
    currency: TableCurrency = 'credits',
  ) {
    return this.session(hash, async (client, id) =>
      this.lobby(client, id, gameId, currency),
    );
  }
  /** Lists one currency only, so a credit lobby never offers a euro table. */
  private async lobby(
    client: PoolClient,
    id: string,
    gameId: GameId,
    currency: TableCurrency = 'credits',
  ) {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM game_tables WHERE game_id=$1 AND currency=$2 AND visibility='public' AND status IN ('waiting','playing') ORDER BY created_at DESC,id",
      [gameId, currency],
    );
    const tables: TableSnapshot[] = [];
    for (const row of rows) {
      const table = await this.snapshot(client, row.id, id);
      // Another participant may finish the match after the ID query above.
      if (table.status === 'waiting' || table.status === 'playing')
        tables.push(table);
    }
    return { tables };
  }
  /** The room lock keeps results, player views and balances from different revisions apart. */
  async liveSnapshot(hash: string, gameId: GameId, tableId?: string) {
    return this.session(hash, async (c, u) => {
      if (tableId) await this.locked(c, tableId, u);
      const table = tableId ? await this.snapshot(c, tableId, u) : null;
      return {
        balance: await this.balance(c, u, table?.currency),
        ...(await this.lobby(c, u, gameId)),
        table,
        ...(tableId ? await this.playerMatch(c, tableId, u) : {}),
      };
    });
  }
  async get(hash: string, id: string) {
    return this.session(hash, async (c, u) => {
      await this.locked(c, id, u);
      return {
        table: await this.snapshot(c, id, u),
        ...(await this.playerMatch(c, id, u)),
      };
    });
  }
  private async playerMatch(c: PoolClient, id: string, userId: string) {
    const seated = await c.query(
      'SELECT 1 FROM match_roster WHERE table_id=$1 AND user_id=$2',
      [id, userId],
    );
    if (!seated.rowCount) return {};
    const match = await summary(c, id, userId);
    const game = await loadGame(c, id);
    const table = (
      await c.query<TableRow>('SELECT * FROM game_tables WHERE id=$1', [id])
    ).rows[0]!;
    const runtime = this.engines.get(table.game_id);
    if (!runtime?.observe || runtime.version !== game.engine_version)
      return { match };
    return {
      match,
      game: {
        status: table.status,
        revision: game.revision,
        engineVersion: game.engine_version,
        rulesVersion: game.rules_version,
        observation: runtime.observe({ state: game.state, userId }),
      } satisfies PlayerGameView,
    };
  }
  async game(hash: string, id: string) {
    return this.session(hash, async (c, u) => {
      await this.locked(c, id, u);
      await participant(c, id, u);
      const view = await this.playerMatch(c, id, u);
      if (!view.game) throw new PlatformError('engine_unavailable', 503);
      return view;
    });
  }
  async credits(hash: string) {
    return this.session(hash, async (c, u) => ({
      balance: await this.balance(c, u),
    }));
  }
  /** Read-only, participant-bound feedback. No operation/event/financial write. */
  async previewGameSelection(
    hash: string,
    id: string,
    expectedRevision: number,
    selection: unknown,
  ) {
    const encoded = JSON.stringify(selection);
    if (typeof encoded !== 'string' || encoded.length > 4096)
      throw new PlatformError('invalid_game_action', 400);
    const input: unknown = JSON.parse(encoded);
    return this.session(hash, async (c, u) => {
      const table = await this.locked(c, id, u);
      requirePlaying(table);
      await participant(c, id, u);
      const game = await loadGame(c, id);
      checkRevision(game, expectedRevision);
      const runtime = this.engines.get(table.game_id);
      if (!runtime?.preview || runtime.version !== game.engine_version)
        throw new PlatformError('engine_unavailable', 503);
      return {
        revision: game.revision,
        preview: runtime.preview({
          state: game.state,
          userId: u,
          selection: input,
        }),
      };
    });
  }
  async tickets(hash: string) {
    return this.session(hash, async (c, u) => {
      const { rows } = await c.query<{
        id: string;
        tableId: string;
        feeMinor: number;
        contributionMinor: number;
        state: string;
        currency: TableCurrency;
      }>(
        `SELECT k.id,k.table_id AS "tableId",k.fee_minor AS "feeMinor",k.contribution_minor AS "contributionMinor",k.state,t.currency
         FROM table_tickets k JOIN game_tables t ON t.id=k.table_id WHERE k.user_id=$1 ORDER BY k.created_at DESC,k.id DESC`,
        [u],
      );
      return { tickets: rows };
    });
  }

  private codeHash(code: string): string {
    if (!this.settings.codeSecret)
      throw new PlatformError('platform_unavailable', 503);
    return createHmac('sha256', this.settings.codeSecret)
      .update('table-code-v1\0' + code)
      .digest('hex');
  }
  async access(hash: string, code: string, ip: string) {
    // Authenticate before writing attempt counters; invalid cookies cannot grow
    // the rate-limit table. Counter rows are bounded by account/IP keys.
    const userId = await this.session(hash, (_client, id) =>
      Promise.resolve(id),
    );
    const digest = this.codeHash(code);
    const keys = [
      'account:' + userId,
      'ip:' + createHash('sha256').update(ip).digest('hex'),
    ].sort();
    for (const key of keys) {
      const attempt = await this.pool!.query(
        `INSERT INTO table_access_limits(key,bucket,attempts) VALUES($1,date_trunc('minute',now()),1)
        ON CONFLICT(key) DO UPDATE SET bucket=EXCLUDED.bucket,
        attempts=CASE WHEN table_access_limits.bucket=EXCLUDED.bucket THEN table_access_limits.attempts+1 ELSE 1 END
        WHERE table_access_limits.bucket<>EXCLUDED.bucket OR table_access_limits.attempts<20 RETURNING attempts`,
        [key],
      );
      if (!attempt.rowCount) throw new PlatformError('access_limited', 429);
    }
    return this.session(hash, async (c, u) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM game_tables WHERE code_hash=$1 AND status IN ('waiting','playing')",
        [digest],
      );
      const tableId = rows[0]?.id;
      if (!tableId) throw new PlatformError('private_code_invalid', 404);
      await c.query(
        'INSERT INTO table_access(table_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [tableId, u],
      );
      return { table: await this.snapshot(c, tableId, u) };
    });
  }

  private async command(
    hash: string,
    operationId: string,
    request: unknown,
    run: (c: PoolClient, u: string) => Promise<string>,
  ): Promise<CommandResult> {
    const fingerprint = fingerprintOf(request);
    return this.session(hash, async (c, u) => {
      const previous = await this.previousOperation(
        c,
        u,
        operationId,
        fingerprint,
      );
      if (previous) return previous;
      const id = await run(c, u);
      const table = await this.snapshot(c, id, u);
      const result: CommandResult = {
        table,
        balance: await this.balance(c, u, table.currency),
        ...(await this.playerMatch(c, id, u)),
      };
      await c.query(
        'INSERT INTO platform_operations(user_id,operation_id,fingerprint,response) VALUES($1,$2,$3,$4)',
        [u, operationId, fingerprint, JSON.stringify(result)],
      );
      // PostgreSQL delivers this only after commit; snapshots remain authoritative
      // when a process, connection or notification is lost.
      await c.query("SELECT pg_notify('platform_updates',$1)", [
        JSON.stringify({ tableId: id, gameId: result.table.gameId }),
      ]);
      return result;
    });
  }

  private async previousOperation(
    c: PoolClient,
    userId: string,
    operationId: string,
    fingerprint: string,
  ): Promise<CommandResult | undefined> {
    const previous = await c.query<{
      fingerprint: string;
      response: CommandResult;
    }>(
      'SELECT fingerprint,response FROM platform_operations WHERE user_id=$1 AND operation_id=$2',
      [userId, operationId],
    );
    if (previous.rows[0]?.fingerprint !== undefined) {
      if (previous.rows[0].fingerprint !== fingerprint)
        throw new PlatformError('operation_conflict', 409);
      return previous.rows[0].response;
    }
    return undefined;
  }

  private async reserve(c: PoolClient, u: string, t: TableRow, seat: number) {
    if (t.status !== 'waiting')
      throw new PlatformError('table_unavailable', 409);
    this.requireRegisteredRuntime(t.game_id);
    if (seat < 0 || seat >= t.capacity)
      throw new PlatformError('seat_unavailable', 409);
    if (
      (
        await c.query('SELECT 1 FROM table_participations WHERE user_id=$1', [
          u,
        ])
      ).rowCount
    )
      throw new PlatformError('already_participating', 409);
    if (
      (
        await c.query(
          'SELECT 1 FROM table_participations WHERE table_id=$1 AND seat_index=$2',
          [t.id, seat],
        )
      ).rowCount
    )
      throw new PlatformError('seat_unavailable', 409);
    if (t.currency === 'EUR') await this.requireEuroEligible(c, u);
    const cost = t.entry_fee_minor + t.contribution_minor;
    if ((await this.balance(c, u, t.currency)).availableMinor < cost)
      throw new PlatformError(
        t.currency === 'EUR' ? 'insufficient_funds' : 'insufficient_credits',
        409,
      );
    const ticket = randomUUID();
    await c.query(
      'INSERT INTO table_tickets(id,table_id,user_id,fee_minor,contribution_minor) VALUES($1,$2,$3,$4,$5)',
      [ticket, t.id, u, t.entry_fee_minor, t.contribution_minor],
    );
    await c.query(
      'INSERT INTO table_participations(user_id,table_id,seat_index,ticket_id) VALUES($1,$2,$3,$4)',
      [u, t.id, seat, ticket],
    );
    await c.query(
      'INSERT INTO table_access(table_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [t.id, u],
    );
    await postTableMoney(c, t.currency, {
      operationKey: 'reserve:' + ticket,
      kind: 'reserve',
      actorId: u,
      referenceId: ticket,
      postings: [
        { account: 'available:' + u, amount: -cost },
        { account: 'reserved:' + u, amount: cost },
      ],
    });
  }
  /** Same rule as the wallet: real money needs a verified, registered account. */
  private async requireEuroEligible(c: PoolClient, u: string) {
    const { rows } = await c.query(
      "SELECT 1 FROM users WHERE id=$1 AND account_kind='registered' AND (email_verified OR phone_verified)",
      [u],
    );
    if (!rows.length) throw new PlatformError('account_not_eligible', 403);
    await requireJurisdiction(c, u);
  }
  private async locked(
    c: PoolClient,
    id: string,
    u: string,
  ): Promise<TableRow> {
    const result = await c.query<TableRow>(
      `SELECT t.* FROM game_tables t WHERE t.id=$1 AND (visibility='public' OR EXISTS(SELECT 1 FROM table_access a WHERE a.table_id=t.id AND a.user_id=$2)) FOR UPDATE`,
      [id, u],
    );
    const table = result.rows[0];
    if (!table) throw new PlatformError('table_not_found', 404);
    return table;
  }
  private async bump(c: PoolClient, id: string) {
    await c.query('UPDATE game_tables SET revision=revision+1 WHERE id=$1', [
      id,
    ]);
  }

  private requireRegisteredRuntime(gameId: GameId): void {
    if (this.settings.requireGameRuntime && !this.engines.get(gameId))
      throw new PlatformError('engine_unavailable', 503);
  }

  async create(hash: string, input: CreateTableDto): Promise<CommandResult> {
    const name = input.name.trim().normalize('NFC');
    const game = GAME_CONFIG[input.gameId];
    if (
      !name ||
      !Object.hasOwn(game.formats, input.formatId) ||
      (input.visibility === 'private') !== !!input.accessCode
    )
      throw new PlatformError('invalid_table_request', 400);
    const code = input.accessCode ? this.codeHash(input.accessCode) : null;
    const currency = input.currency ?? 'credits';
    // Fingerprints never persist plaintext access codes.
    return this.command(
      hash,
      input.operationId,
      {
        type: 'create',
        gameId: input.gameId,
        name,
        visibility: input.visibility,
        formatId: input.formatId,
        contribution: input.prizeContributionMinor,
        code,
        currency,
      },
      async (c, u) => {
        const id = randomUUID();
        const { rows } = await c.query<TableRow>(
          `INSERT INTO game_tables(id,creator_id,game_id,name,visibility,code_hash,format_id,capacity,entry_fee_minor,contribution_minor,currency)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            id,
            u,
            input.gameId,
            name,
            input.visibility,
            code,
            input.formatId,
            game.seats,
            ENTRY_FEE_MINOR,
            input.prizeContributionMinor,
            currency,
          ],
        );
        await this.reserve(c, u, rows[0]!, 0);
        return id;
      },
    );
  }
  async join(
    hash: string,
    id: string,
    operationId: string,
    seat: number,
  ): Promise<CommandResult> {
    return this.command(
      hash,
      operationId,
      { type: 'join', id, seat },
      async (c, u) => {
        const table = await this.locked(c, id, u);
        await this.reserve(c, u, table, seat);
        await this.bump(c, id);
        return id;
      },
    );
  }
  async move(
    hash: string,
    id: string,
    operationId: string,
    seat: number,
  ): Promise<CommandResult> {
    return this.command(
      hash,
      operationId,
      { type: 'move', id, seat },
      async (c, u) => {
        const table = await this.locked(c, id, u);
        if (table.status !== 'waiting')
          throw new PlatformError('table_unavailable', 409);
        this.requireRegisteredRuntime(table.game_id);
        if (seat < 0 || seat >= table.capacity)
          throw new PlatformError('seat_unavailable', 409);
        const own = await c.query<{ seat_index: number }>(
          'SELECT seat_index FROM table_participations WHERE user_id=$1 AND table_id=$2',
          [u, id],
        );
        if (!own.rowCount) throw new PlatformError('not_participating', 403);
        if (own.rows[0]!.seat_index === seat) return id;
        // Chess colours are fixed: the creator starts in white's seat 0 and
        // the joining player takes black's seat 1. Do not swap colours via seats.
        if (table.game_id === 'chess')
          throw new PlatformError('seat_unavailable', 409);
        if (
          (
            await c.query(
              'SELECT 1 FROM table_participations WHERE table_id=$1 AND seat_index=$2',
              [id, seat],
            )
          ).rowCount
        )
          throw new PlatformError('seat_unavailable', 409);
        await c.query(
          'UPDATE table_participations SET seat_index=$3,ready=false WHERE user_id=$1 AND table_id=$2',
          [u, id, seat],
        );
        await this.bump(c, id);
        return id;
      },
    );
  }
  async cancel(
    hash: string,
    id: string,
    operationId: string,
  ): Promise<CommandResult> {
    return this.command(
      hash,
      operationId,
      { type: 'cancel', id },
      async (c, u) => {
        const table = await this.locked(c, id, u);
        if (table.status === 'playing') {
          await participant(c, id, u);
          const game = await loadGame(c, id);
          if (game.accepted_gameplay_count > 0)
            throw new PlatformError('cancellation_unavailable', 409);
          const revision = await advanceGame(c, game, {
            kind: 'cancel',
            actor: u,
            payload: {},
          });
          await concludeMatch(c, table, revision, {
            kind: 'cancel',
            reason: 'cancelled-before-play',
            source: 'participant',
            actor: u,
            evidence: {},
          });
          await this.bump(c, id);
          return id;
        }
        if (table.status !== 'waiting')
          throw new PlatformError('table_unavailable', 409);
        const { rows } = await c.query<{ ticket_id: string }>(
          'SELECT ticket_id FROM table_participations WHERE user_id=$1 AND table_id=$2',
          [u, id],
        );
        const ticket = rows[0]?.ticket_id;
        if (!ticket) throw new PlatformError('not_participating', 403);
        // Individual cancellation only; no implicit creator power over others.
        const cost = table.entry_fee_minor + table.contribution_minor;
        await postTableMoney(c, table.currency, {
          operationKey: 'release:' + ticket,
          kind: 'release',
          actorId: u,
          referenceId: ticket,
          postings: [
            { account: 'reserved:' + u, amount: -cost },
            { account: 'available:' + u, amount: cost },
          ],
        });
        await c.query(
          "UPDATE table_tickets SET state='cancelled' WHERE id=$1",
          [ticket],
        );
        await c.query('DELETE FROM table_participations WHERE user_id=$1', [u]);
        // The table lock also serializes joins and other withdrawals. Close only
        // when the final reservation has been released in this transaction.
        await c.query(
          `UPDATE game_tables SET status='cancelled'
           WHERE id=$1 AND status='waiting'
           AND NOT EXISTS (SELECT 1 FROM table_participations WHERE table_id=$1)`,
          [id],
        );
        await this.bump(c, id);
        return id;
      },
    );
  }
  async match(hash: string, id: string): Promise<{ match: MatchSummary }> {
    return this.session(hash, async (c, u) => {
      await this.locked(c, id, u);
      return { match: await summary(c, id, u) };
    });
  }

  async forfeit(
    hash: string,
    id: string,
    operationId: string,
    expectedRevision: number,
  ): Promise<CommandResult> {
    return this.command(
      hash,
      operationId,
      { type: 'forfeit', id, expectedRevision },
      async (c, u) => {
        const table = await this.locked(c, id, u);
        requirePlaying(table);
        const members = await participant(c, id, u),
          game = await loadGame(c, id);
        checkRevision(game, expectedRevision);
        const own = members.find((m) => m.user_id === u)!;
        const winners = members
          .filter((m) =>
            table.capacity === 4
              ? m.seat_index % 2 !== own.seat_index % 2
              : m.user_id !== u,
          )
          .map((m) => m.user_id);
        const revision = await advanceGame(c, game, {
          kind: 'forfeit',
          actor: u,
          payload: {},
        });
        await concludeMatch(c, table, revision, {
          kind: 'win',
          reason: 'explicit-forfeit',
          winners,
          source: 'participant',
          actor: u,
          evidence: {},
        });
        await this.bump(c, id);
        return id;
      },
    );
  }

  private async gameActionSource(
    c: PoolClient,
    userId: string,
    id: string,
    expectedRevision: number,
  ): Promise<ActionSource> {
    const table = await this.locked(c, id, userId);
    requirePlaying(table);
    const members = await participant(c, id, userId),
      game = await loadGame(c, id);
    checkRevision(game, expectedRevision);
    const runtime = this.engines.get(table.game_id);
    if (!runtime?.apply || runtime.version !== game.engine_version)
      throw new PlatformError('engine_unavailable', 503);
    return {
      table,
      members,
      game,
      runtime: runtime as ActionSource['runtime'],
    };
  }

  private async prepareAction(
    hash: string,
    id: string,
    operationId: string,
    expectedRevision: number,
    input: unknown,
    requestFingerprint: string,
  ): Promise<ActionPreparation | undefined> {
    let source: PreparationSource | undefined;
    try {
      source = await this.session(hash, async (c, userId) => {
        if (
          await this.previousOperation(
            c,
            userId,
            operationId,
            requestFingerprint,
          )
        )
          return undefined;
        const current = await this.gameActionSource(
            c,
            userId,
            id,
            expectedRevision,
          ),
          prepare = current.runtime.prepare;
        if (!prepare) return undefined;
        return {
          userId,
          fingerprint: sourceFingerprint(current, userId, requestFingerprint),
          engineVersion: current.game.engine_version,
          rulesVersion: current.game.rules_version,
          runtime: current.runtime,
          prepare,
          input: freezeJson({
            state: current.game.state,
            userId,
            // Give preparation its own JSON copy, never the eventual request object.
            action: JSON.parse(JSON.stringify(input)) as unknown,
            participants: current.members.map((m) => ({
              userId: m.user_id,
              seat: m.seat_index,
            })),
          }),
        };
      });
      if (!source) return undefined;
      // session() has committed and released its client before worker work starts.
      const accepted = detachedTransition(
        await source.prepare.call(source.runtime, source.input),
      );
      return { kind: 'ready', source, accepted };
    } catch (error) {
      // Even a failed computation must enter command() again: a concurrent
      // identical request may already have committed its authoritative receipt.
      return { kind: 'failed', ...(source ? { source } : {}), error };
    }
  }

  /** Authenticated commands; only the trusted adapter classifies moves/results. */
  async applyGameAction(
    hash: string,
    id: string,
    operationId: string,
    expectedRevision: number,
    action: unknown,
  ): Promise<CommandResult> {
    const encoded = JSON.stringify(action);
    if (typeof encoded !== 'string' || encoded.length > 16_384)
      throw new PlatformError('invalid_game_action', 400);
    const input: unknown = JSON.parse(encoded);
    const request = {
        type: 'game-action',
        id,
        expectedRevision,
        action: input,
      },
      requestFingerprint = fingerprintOf(request),
      preparation = this.engines.hasPreparation()
        ? await this.prepareAction(
            hash,
            id,
            operationId,
            expectedRevision,
            input,
            requestFingerprint,
          )
        : undefined;
    return this.command(hash, operationId, request, async (c, u) => {
      const current = await this.gameActionSource(c, u, id, expectedRevision),
        { table, members, game, runtime } = current,
        source = preparation?.source;
      if (source) {
        if (source.userId !== u)
          throw new PlatformError('account_session_expired', 401);
        if (
          source.runtime !== runtime ||
          source.prepare !== runtime.prepare ||
          source.engineVersion !== game.engine_version ||
          source.rulesVersion !== game.rules_version
        )
          throw new PlatformError('engine_unavailable', 503);
        if (
          source.fingerprint !==
          sourceFingerprint(current, u, requestFingerprint)
        )
          throw new PlatformError('stale_game_revision', 409);
      }
      if (preparation?.kind === 'failed') throw preparation.error;
      if (runtime.prepare && preparation?.kind !== 'ready')
        throw new PlatformError('engine_unavailable', 503);
      const accepted =
        preparation?.kind === 'ready'
          ? preparation.accepted
          : runtime.apply({
              state: game.state,
              userId: u,
              action: input,
              participants: members.map((m) => ({
                userId: m.user_id,
                seat: m.seat_index,
              })),
            });
      const state = JSON.stringify(accepted.state);
      if (
        typeof state !== 'string' ||
        state.length > 16_000_000 ||
        typeof accepted.gameplay !== 'boolean'
      )
        throw new Error('Invalid game transition');
      const revision = await advanceGame(c, game, {
        kind: 'action',
        actor: u,
        gameplay: accepted.gameplay,
        payload: { action: input },
        state: JSON.parse(state) as unknown,
      });
      if (accepted.outcome) {
        const outcome = accepted.outcome;
        if (outcome.kind !== 'win' && outcome.kind !== 'draw')
          throw new Error('Unsupported engine outcome');
        await concludeMatch(c, table, revision, {
          kind: outcome.kind,
          reason: outcome.reason,
          ...(outcome.kind === 'win' ? { winners: outcome.winnerUserIds } : {}),
          source: 'engine',
          actor: u,
          evidence: {
            engineVersion: game.engine_version,
            rulesVersion: game.rules_version,
          },
        });
      }
      await this.bump(c, id);
      return id;
    });
  }

  /** Trusted backend job only; deliberately absent from HTTP/WS controllers. */
  async voidForBackendFailure(input: {
    tableId: string;
    operationId: string;
    expectedRevision: number;
    reason: 'confirmed-rules-state-error' | 'unrecoverable-platform-failure';
    evidenceReference: string;
  }): Promise<{ tableId: string; resultId: string; revision: number }> {
    if (
      ![
        'confirmed-rules-state-error',
        'unrecoverable-platform-failure',
      ].includes(input.reason) ||
      typeof input.evidenceReference !== 'string' ||
      !input.evidenceReference.trim() ||
      input.evidenceReference.length > 512
    )
      throw new PlatformError('invalid_game_action', 400);
    if (!this.pool) throw new PlatformError('platform_unavailable', 503);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          tableId: input.tableId,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          evidenceReference: input.evidenceReference,
        }),
      )
      .digest('hex');
    const c = await this.pool.connect().catch(() => {
      throw new PlatformError('platform_unavailable', 503);
    });
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'match-backend:' + input.operationId,
      ]);
      const previous = (
        await c.query<{
          fingerprint: string;
          response: { tableId: string; resultId: string; revision: number };
        }>(
          'SELECT fingerprint,response FROM match_backend_operations WHERE operation_id=$1',
          [input.operationId],
        )
      ).rows[0];
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new PlatformError('operation_conflict', 409);
        await c.query('COMMIT');
        return previous.response;
      }
      const table = (
        await c.query<TableRow>(
          'SELECT * FROM game_tables WHERE id=$1 FOR UPDATE',
          [input.tableId],
        )
      ).rows[0];
      if (!table) throw new PlatformError('table_not_found', 404);
      requirePlaying(table);
      const game = await loadGame(c, table.id);
      checkRevision(game, input.expectedRevision);
      const revision = await advanceGame(c, game, {
        kind: 'void',
        payload: {
          category: input.reason,
          evidenceReference: input.evidenceReference,
        },
      });
      const resultId = await concludeMatch(c, table, revision, {
        kind: 'void',
        reason: input.reason,
        source: 'backend',
        evidence: { reference: input.evidenceReference },
      });
      await this.bump(c, table.id);
      const response = { tableId: table.id, resultId, revision };
      await c.query(
        'INSERT INTO match_backend_operations(operation_id,fingerprint,response) VALUES($1,$2,$3)',
        [input.operationId, fingerprint, JSON.stringify(response)],
      );
      await c.query("SELECT pg_notify('platform_updates',$1)", [
        JSON.stringify({ tableId: table.id, gameId: table.game_id }),
      ]);
      await c.query('COMMIT');
      return response;
    } catch (error) {
      await c.query('ROLLBACK');
      if (error instanceof PlatformError) throw error;
      throw new PlatformError('platform_unavailable', 503);
    } finally {
      c.release();
    }
  }

  private async waitingRoster(
    c: PoolClient,
    id: string,
  ): Promise<WaitingMember[]> {
    return (
      await c.query<WaitingMember>(
        `SELECT p.user_id,p.seat_index,p.ticket_id,p.ready,
                t.state AS ticket_state,t.fee_minor,t.contribution_minor
         FROM table_participations p JOIN table_tickets t ON t.id=p.ticket_id
         WHERE p.table_id=$1 ORDER BY p.seat_index`,
        [id],
      )
    ).rows;
  }

  private async prepareGameStart(
    hash: string,
    id: string,
    operationId: string,
    requestFingerprint: string,
  ): Promise<StartPreparation | undefined> {
    let source: StartSource | undefined;
    try {
      source = await this.session(hash, async (c, userId) => {
        if (
          await this.previousOperation(
            c,
            userId,
            operationId,
            requestFingerprint,
          )
        )
          return undefined;
        const table = await this.locked(c, id, userId);
        if (table.status !== 'waiting')
          throw new PlatformError('table_unavailable', 409);
        this.requireRegisteredRuntime(table.game_id);
        const runtime = this.engines.get(table.game_id),
          prepare = runtime?.prepareStart;
        if (!runtime || !prepare) return undefined;
        const members = await this.waitingRoster(c, id);
        if (!members.some((member) => member.user_id === userId))
          throw new PlatformError('not_participating', 403);
        if (members.length !== table.capacity) return undefined;
        return {
          userId,
          fingerprint: startFingerprint(
            table,
            members,
            userId,
            requestFingerprint,
          ),
          runtime,
          version: runtime.version,
          prepare,
          input: freezeJson({
            gameId: table.game_id,
            formatId: table.format_id,
            participants: members.map((member) => ({
              userId: member.user_id,
              seat: member.seat_index,
            })),
          }),
        };
      });
      if (!source) return undefined;
      const accepted = detachedInitialization(
        await source.prepare.call(source.runtime, source.input),
      );
      return { kind: 'ready', source, accepted };
    } catch (error) {
      return { kind: 'failed', ...(source ? { source } : {}), error };
    }
  }

  async ready(
    hash: string,
    id: string,
    operationId: string,
  ): Promise<CommandResult> {
    const request = { type: 'ready', id },
      requestFingerprint = fingerprintOf(request),
      preparation = this.engines.hasStartPreparation()
        ? await this.prepareGameStart(hash, id, operationId, requestFingerprint)
        : undefined;
    return this.command(hash, operationId, request, async (c, u) => {
      const table = await this.locked(c, id, u);
      if (table.status !== 'waiting')
        throw new PlatformError('table_unavailable', 409);
      this.requireRegisteredRuntime(table.game_id);
      const marked = await c.query(
        'UPDATE table_participations SET ready=true WHERE user_id=$1 AND table_id=$2 RETURNING user_id',
        [u, id],
      );
      if (!marked.rowCount) throw new PlatformError('not_participating', 403);
      const rows = await this.waitingRoster(c, id);
      if (rows.length === table.capacity && rows.every((p) => p.ready)) {
        const engine = this.engines.get(table.game_id);
        if (!engine) throw new PlatformError('engine_unavailable', 503);
        const source = preparation?.source;
        if (source) {
          if (source.userId !== u)
            throw new PlatformError('account_session_expired', 401);
          if (
            source.runtime !== engine ||
            source.prepare !== engine.prepareStart ||
            source.version !== engine.version
          )
            throw new PlatformError('engine_unavailable', 503);
          if (
            source.fingerprint !==
            startFingerprint(table, rows, u, requestFingerprint)
          )
            throw new PlatformError('table_unavailable', 409);
        }
        if (preparation?.kind === 'failed') throw preparation.error;
        if (engine.prepareStart && preparation?.kind !== 'ready')
          throw new PlatformError('engine_unavailable', 503);
        const game =
          preparation?.kind === 'ready'
            ? preparation.accepted
            : engine.start({
                gameId: table.game_id,
                formatId: table.format_id,
                participants: rows.map((p) => ({
                  userId: p.user_id,
                  seat: p.seat_index,
                })),
              });
        const initialState = JSON.stringify(game.state);
        if (
          typeof game.rulesVersion !== 'string' ||
          !game.rulesVersion ||
          game.rulesVersion.length > 128 ||
          typeof initialState !== 'string' ||
          initialState.length > 16_000_000
        )
          throw new Error('Invalid engine initialization');
        if (engine.apply && !engine.version)
          throw new Error('Action adapters must be versioned');
        if (
          engine.version !== undefined &&
          (typeof engine.version !== 'string' ||
            !engine.version ||
            engine.version.length > 128)
        )
          throw new Error('Invalid adapter version');
        await c.query(
          'INSERT INTO table_games(table_id,rules_version,state,engine_version) VALUES($1,$2,$3,$4)',
          [
            id,
            game.rulesVersion,
            initialState,
            engine.version ?? 'initialization-only',
          ],
        );
        await startHistory(c, id, u);
        await openPool(c, table.currency, id);
        await postTableMoney(c, table.currency, {
          operationKey: 'start:' + id,
          kind: 'start',
          actorId: u,
          referenceId: id,
          postings: [
            ...rows.map((p) => ({
              account: 'reserved:' + p.user_id,
              amount: -(table.entry_fee_minor + table.contribution_minor),
            })),
            {
              account: poolAccount(table.currency, id),
              amount: table.capacity * table.contribution_minor,
            },
            {
              account: feeAccount(table.currency),
              amount: table.capacity * table.entry_fee_minor,
            },
          ],
        });
        await c.query(
          "UPDATE table_tickets SET state='committed' WHERE table_id=$1 AND state='reserved'",
          [id],
        );
        await c.query(
          "UPDATE game_tables SET status='playing',started_at=now() WHERE id=$1",
          [id],
        );
      }
      await this.bump(c, id);
      return id;
    });
  }
}
