import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import {
  REGISTRATION_SETTINGS,
  type RegistrationSettings,
} from '../registration/registration-settings';
import type { GameId } from '../tables/game-catalog';
import { audit, type AdminActor } from '../wallet/admin';
import { WalletError } from '../wallet/wallet-error';
import { postWallet, userAccount } from '../wallet/wallet-ledger';

const SESSION_PATTERN = /^[a-f0-9]{64}$/;
const fingerprintOf = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
// jsonb reorders keys, so compare stored configurations field by field.
const sameConfig = (a: TournamentConfig, b: TournamentConfig) =>
  (Object.keys(b) as (keyof TournamentConfig)[]).every(
    (key) => JSON.stringify(a[key]) === JSON.stringify(b[key]),
  ) && Object.keys(a).length === Object.keys(b).length;
const poolAccount = (id: string) => `tournament_pool:${id}`;
const feesAccount = (id: string) => `tournament_fees:${id}`;

export interface TournamentConfig {
  gameId: GameId;
  name: string;
  entryFeeMinor: number;
  contributionMinor: number;
  minPlayers: number;
  maxPlayers: number;
  startsAt: string;
  cancellationPolicy: string;
  /** Basis points for places 1, 2, 3…; must sum to 10000. */
  prizeShares: number[];
}

interface Actor {
  id: string;
  account_kind: string;
  email_verified: boolean;
  phone_verified: boolean;
}
interface TournamentRow {
  id: string;
  game_id: GameId;
  name: string;
  entry_fee_minor: number;
  contribution_minor: number;
  min_players: number;
  max_players: number;
  starts_at: Date;
  cancellation_policy: string;
  status: 'open' | 'running' | 'completed' | 'cancelled';
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}
interface TicketRow {
  id: string;
  tournament_id: string;
  user_id: string;
  fee_minor: number;
  contribution_minor: number;
  state: 'active' | 'cancelled' | 'refunded' | 'settled';
  created_at: Date;
}
const TOURNAMENT_COLUMNS = `id,game_id,name,entry_fee_minor::float8 AS entry_fee_minor,
  contribution_minor::float8 AS contribution_minor,min_players,max_players,starts_at,
  cancellation_policy,status,created_at,started_at,finished_at`;
const TICKET_COLUMNS = `id,tournament_id,user_id,fee_minor::float8 AS fee_minor,
  contribution_minor::float8 AS contribution_minor,state,created_at`;

const ticketView = (t: TicketRow) => ({
  id: t.id,
  tournamentId: t.tournament_id,
  feeMinor: t.fee_minor,
  contributionMinor: t.contribution_minor,
  state: t.state,
  createdAt: t.created_at.toISOString(),
});

/** Splits the pool by basis points; rounding remainders go to first place. */
export function prizeAmounts(
  poolMinor: number,
  shares: readonly number[],
): number[] {
  const pool = BigInt(poolMinor);
  const amounts = shares.map((bps) => (pool * BigInt(bps)) / 10_000n);
  amounts[0]! += pool - amounts.reduce((a, b) => a + b, 0n);
  return amounts.map(Number);
}

function validConfig(c: TournamentConfig): boolean {
  const starts = Date.parse(c.startsAt);
  return (
    c.name.trim().length > 0 &&
    c.maxPlayers >= c.minPlayers &&
    c.prizeShares.length >= 1 &&
    c.prizeShares.length <= c.minPlayers &&
    c.prizeShares.reduce((a, b) => a + b, 0) === 10_000 &&
    Number.isFinite(starts) &&
    starts > Date.now()
  );
}

@Injectable()
export class TournamentStore implements OnModuleDestroy {
  private readonly pool: Pool | undefined;

  constructor(
    @Inject(REGISTRATION_SETTINGS) registration: RegistrationSettings,
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

  private async transaction<T>(run: (c: PoolClient) => Promise<T>) {
    if (!this.pool) throw new WalletError('wallet_unavailable', 503);
    const client = await this.pool.connect().catch(() => {
      throw new WalletError('wallet_unavailable', 503);
    });
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof WalletError) throw error;
      throw new WalletError('wallet_unavailable', 503);
    } finally {
      client.release();
    }
  }

  /** Same account row lock as wallet and table commands. */
  private session<T>(
    hash: string,
    run: (c: PoolClient, actor: Actor) => Promise<T>,
  ) {
    if (!SESSION_PATTERN.test(hash))
      throw new WalletError('account_session_expired', 401);
    return this.transaction(async (c) => {
      const { rows } = await c.query<Actor>(
        `SELECT u.id,u.account_kind,u.email_verified,u.phone_verified FROM users u
         JOIN account_sessions s ON s.user_id=u.id
         WHERE s.token_hash=$1 AND s.expires_at>now() FOR NO KEY UPDATE OF u FOR SHARE OF s`,
        [hash],
      );
      if (!rows[0]) throw new WalletError('account_session_expired', 401);
      return run(c, rows[0]);
    });
  }

  private async operation<T>(
    c: PoolClient,
    userId: string,
    operationId: string,
    request: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    const fingerprint = fingerprintOf(request);
    const previous = await c.query<{ fingerprint: string; response: T }>(
      'SELECT fingerprint,response FROM wallet_operations WHERE user_id=$1 AND operation_id=$2',
      [userId, operationId],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].fingerprint !== fingerprint)
        throw new WalletError('operation_conflict', 409);
      return previous.rows[0].response;
    }
    const response = await run();
    await c.query(
      'INSERT INTO wallet_operations(user_id,operation_id,fingerprint,response) VALUES($1,$2,$3,$4)',
      [userId, operationId, fingerprint, JSON.stringify(response)],
    );
    return response;
  }

  private async lockTournament(c: PoolClient, id: string) {
    const { rows } = await c.query<TournamentRow>(
      `SELECT ${TOURNAMENT_COLUMNS} FROM tournaments WHERE id=$1 FOR UPDATE`,
      [id],
    );
    if (!rows[0]) throw new WalletError('tournament_not_found', 404);
    return rows[0];
  }
  private async activeTickets(c: PoolClient, id: string) {
    const { rows } = await c.query<TicketRow>(
      `SELECT ${TICKET_COLUMNS} FROM tournament_tickets WHERE tournament_id=$1 AND state='active' ORDER BY created_at,id`,
      [id],
    );
    return rows;
  }

  private async view(c: PoolClient, t: TournamentRow, viewer?: string) {
    const rules = await c.query<{ place: number; basisPoints: number }>(
      'SELECT place,basis_points AS "basisPoints" FROM tournament_prize_rules WHERE tournament_id=$1 ORDER BY place',
      [t.id],
    );
    const counts = await c.query<{ players: number; pool: number }>(
      `SELECT count(*) FILTER (WHERE state IN ('active','settled'))::int AS players,
              coalesce(sum(contribution_minor) FILTER (WHERE state IN ('active','settled')),0)::float8 AS pool
       FROM tournament_tickets WHERE tournament_id=$1`,
      [t.id],
    );
    const own = viewer
      ? await c.query<TicketRow>(
          `SELECT ${TICKET_COLUMNS} FROM tournament_tickets WHERE tournament_id=$1 AND user_id=$2 ORDER BY created_at DESC,id LIMIT 1`,
          [t.id, viewer],
        )
      : undefined;
    const results =
      t.status === 'completed'
        ? (
            await c.query<{ place: number; payoutMinor: number }>(
              'SELECT place,payout_minor::float8 AS "payoutMinor" FROM tournament_results WHERE tournament_id=$1 AND payout_minor>0 ORDER BY place',
              [t.id],
            )
          ).rows
        : null;
    return {
      id: t.id,
      gameId: t.game_id,
      name: t.name,
      currency: 'EUR' as const,
      entryFeeMinor: t.entry_fee_minor,
      contributionMinor: t.contribution_minor,
      minPlayers: t.min_players,
      maxPlayers: t.max_players,
      startsAt: t.starts_at.toISOString(),
      cancellationPolicy: t.cancellation_policy,
      status: t.status,
      players: counts.rows[0]!.players,
      prizePoolMinor: counts.rows[0]!.pool,
      prizeShares: rules.rows,
      ...(results ? { payouts: results } : {}),
      ...(own ? { ticket: own.rows[0] ? ticketView(own.rows[0]) : null } : {}),
    };
  }

  // Player commands

  list(hash: string) {
    return this.session(hash, async (c, actor) => {
      const { rows } = await c.query<TournamentRow>(
        `SELECT ${TOURNAMENT_COLUMNS} FROM tournaments WHERE status IN ('open','running') ORDER BY starts_at,id LIMIT 100`,
      );
      const tournaments = [];
      for (const t of rows) tournaments.push(await this.view(c, t, actor.id));
      return { tournaments };
    });
  }

  get(hash: string, id: string) {
    return this.session(hash, async (c, actor) => {
      const { rows } = await c.query<TournamentRow>(
        `SELECT ${TOURNAMENT_COLUMNS} FROM tournaments WHERE id=$1`,
        [id],
      );
      if (!rows[0]) throw new WalletError('tournament_not_found', 404);
      return { tournament: await this.view(c, rows[0], actor.id) };
    });
  }

  tickets(hash: string) {
    return this.session(hash, async (c, actor) => {
      const { rows } = await c.query<TicketRow>(
        `SELECT ${TICKET_COLUMNS} FROM tournament_tickets WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 100`,
        [actor.id],
      );
      return { tickets: rows.map(ticketView) };
    });
  }

  buy(hash: string, operationId: string, id: string) {
    return this.session(hash, (c, actor) =>
      this.operation(
        c,
        actor.id,
        operationId,
        { type: 'buy', id },
        async () => {
          if (
            actor.account_kind !== 'registered' ||
            !(actor.email_verified || actor.phone_verified)
          )
            throw new WalletError('account_not_eligible', 403);
          const t = await this.lockTournament(c, id);
          if (t.status !== 'open' || t.starts_at.getTime() <= Date.now())
            throw new WalletError('tournament_unavailable', 409);
          const active = await this.activeTickets(c, id);
          if (active.some((k) => k.user_id === actor.id))
            throw new WalletError('already_registered', 409);
          if (active.length >= t.max_players)
            throw new WalletError('tournament_full', 409);
          const cost = t.entry_fee_minor + t.contribution_minor;
          const balance = await c.query<{ amount: number }>(
            'SELECT balance_minor::float8 AS amount FROM wallet_accounts WHERE key=$1 FOR UPDATE',
            [userAccount('available', actor.id)],
          );
          if ((balance.rows[0]?.amount ?? 0) < cost)
            throw new WalletError('insufficient_funds', 409);
          const ticketId = randomUUID();
          const tx = await postWallet(c, {
            operationKey: `tournament_entry:${ticketId}`,
            kind: 'tournament_entry',
            referenceId: ticketId,
            actorId: actor.id,
            entries: [
              { account: userAccount('available', actor.id), amount: -cost },
              { account: poolAccount(id), amount: t.contribution_minor },
              ...(t.entry_fee_minor > 0
                ? [{ account: feesAccount(id), amount: t.entry_fee_minor }]
                : []),
            ],
          });
          const { rows } = await c.query<TicketRow>(
            `INSERT INTO tournament_tickets(id,tournament_id,user_id,fee_minor,contribution_minor,purchase_transaction_id)
           VALUES($1,$2,$3,$4,$5,$6) RETURNING ${TICKET_COLUMNS}`,
            [
              ticketId,
              id,
              actor.id,
              t.entry_fee_minor,
              t.contribution_minor,
              tx,
            ],
          );
          return {
            ticket: ticketView(rows[0]!),
            tournament: await this.view(c, t, actor.id),
          };
        },
      ),
    );
  }

  cancelTicket(hash: string, operationId: string, id: string) {
    return this.session(hash, (c, actor) =>
      this.operation(
        c,
        actor.id,
        operationId,
        { type: 'cancel_ticket', id },
        async () => {
          const t = await this.lockTournament(c, id);
          if (t.status !== 'open')
            throw new WalletError('tournament_unavailable', 409);
          const ticket = (await this.activeTickets(c, id)).find(
            (k) => k.user_id === actor.id,
          );
          if (!ticket) throw new WalletError('not_registered', 404);
          await this.refund(c, ticket, 'cancelled', false);
          return { tournament: await this.view(c, t, actor.id) };
        },
      ),
    );
  }

  /** Before the start fees are still held; afterwards they come back from revenue. */
  private async refund(
    c: PoolClient,
    ticket: TicketRow,
    state: 'cancelled' | 'refunded',
    feesRecognised: boolean,
  ) {
    const tx = await postWallet(c, {
      operationKey: `tournament_refund:${ticket.id}`,
      kind: 'tournament_refund',
      referenceId: ticket.id,
      entries: [
        {
          account: poolAccount(ticket.tournament_id),
          amount: -ticket.contribution_minor,
        },
        ...(ticket.fee_minor > 0
          ? [
              {
                account: feesRecognised
                  ? 'house_revenue'
                  : feesAccount(ticket.tournament_id),
                amount: -ticket.fee_minor,
              },
            ]
          : []),
        {
          account: userAccount('available', ticket.user_id),
          amount: ticket.contribution_minor + ticket.fee_minor,
        },
      ],
    });
    await c.query(
      'UPDATE tournament_tickets SET state=$2,refund_transaction_id=$3,updated_at=now() WHERE id=$1',
      [ticket.id, state, tx],
    );
  }

  // Admin commands

  private async writeRules(c: PoolClient, id: string, shares: number[]) {
    await c.query('DELETE FROM tournament_prize_rules WHERE tournament_id=$1', [
      id,
    ]);
    for (const [index, bps] of shares.entries())
      await c.query(
        'INSERT INTO tournament_prize_rules(tournament_id,place,basis_points) VALUES($1,$2,$3)',
        [id, index + 1, bps],
      );
  }
  private async recordChange(
    c: PoolClient,
    id: string,
    by: string,
    config: TournamentConfig,
  ) {
    await c.query(
      'INSERT INTO tournament_changes(id,tournament_id,changed_by,config) VALUES($1,$2,$3,$4)',
      [randomUUID(), id, by, JSON.stringify(config)],
    );
  }

  create(id: string, config: TournamentConfig, actor: AdminActor) {
    if (!validConfig(config)) throw new WalletError('invalid_tournament', 400);
    const by = actor.name;
    return this.transaction(async (c) => {
      const existing = await c.query<{ config: TournamentConfig }>(
        'SELECT config FROM tournament_changes WHERE tournament_id=$1 ORDER BY created_at LIMIT 1',
        [id],
      );
      if (existing.rows[0]) {
        if (!sameConfig(existing.rows[0].config, config))
          throw new WalletError('operation_conflict', 409);
        return {
          tournament: await this.view(c, await this.lockTournament(c, id)),
        };
      }
      await c.query(
        `INSERT INTO tournaments(id,game_id,name,entry_fee_minor,contribution_minor,min_players,max_players,starts_at,cancellation_policy,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          config.gameId,
          config.name.trim(),
          config.entryFeeMinor,
          config.contributionMinor,
          config.minPlayers,
          config.maxPlayers,
          config.startsAt,
          config.cancellationPolicy,
          by,
        ],
      );
      await this.writeRules(c, id, config.prizeShares);
      await c.query(
        "INSERT INTO wallet_accounts(key,kind) VALUES($1,'tournament_pool'),($2,'tournament_fees')",
        [poolAccount(id), feesAccount(id)],
      );
      await this.recordChange(c, id, by, config);
      await audit(c, actor, 'tournament.create', id, { ...config });
      return {
        tournament: await this.view(c, await this.lockTournament(c, id)),
      };
    });
  }

  /** Prices and prizes can only change before anyone has bought a ticket. */
  update(id: string, config: TournamentConfig, actor: AdminActor) {
    if (!validConfig(config)) throw new WalletError('invalid_tournament', 400);
    const by = actor.name;
    return this.transaction(async (c) => {
      const t = await this.lockTournament(c, id);
      const sold = await c.query(
        'SELECT 1 FROM tournament_tickets WHERE tournament_id=$1 LIMIT 1',
        [id],
      );
      if (t.status !== 'open' || sold.rowCount)
        throw new WalletError('tournament_locked', 409);
      await c.query(
        `UPDATE tournaments SET game_id=$2,name=$3,entry_fee_minor=$4,contribution_minor=$5,min_players=$6,
         max_players=$7,starts_at=$8,cancellation_policy=$9,updated_at=now() WHERE id=$1`,
        [
          id,
          config.gameId,
          config.name.trim(),
          config.entryFeeMinor,
          config.contributionMinor,
          config.minPlayers,
          config.maxPlayers,
          config.startsAt,
          config.cancellationPolicy,
        ],
      );
      await this.writeRules(c, id, config.prizeShares);
      await this.recordChange(c, id, by, config);
      await audit(c, actor, 'tournament.update', id, { ...config });
      return {
        tournament: await this.view(c, await this.lockTournament(c, id)),
      };
    });
  }

  start(id: string, actor: AdminActor) {
    return this.transaction(async (c) => {
      const t = await this.lockTournament(c, id);
      if (t.status !== 'open')
        throw new WalletError('tournament_unavailable', 409);
      const active = await this.activeTickets(c, id);
      if (active.length < t.min_players)
        throw new WalletError('tournament_underfilled', 409);
      const fees = active.reduce((sum, k) => sum + k.fee_minor, 0);
      const tx =
        fees > 0
          ? await postWallet(c, {
              operationKey: `tournament_start:${id}`,
              kind: 'tournament_start',
              referenceId: id,
              entries: [
                { account: feesAccount(id), amount: -fees },
                { account: 'house_revenue', amount: fees },
              ],
            })
          : null;
      await c.query(
        "UPDATE tournaments SET status='running',started_at=now(),start_transaction_id=$2,updated_at=now() WHERE id=$1",
        [id, tx],
      );
      await audit(c, actor, 'tournament.start', id, {
        players: active.length,
        feesMinor: fees,
      });
      return {
        tournament: await this.view(c, await this.lockTournament(c, id)),
      };
    });
  }

  /** Organiser cancellation refunds every active ticket in full. */
  cancel(id: string, actor: AdminActor) {
    return this.transaction(async (c) => {
      const t = await this.lockTournament(c, id);
      if (t.status !== 'open' && t.status !== 'running')
        throw new WalletError('tournament_unavailable', 409);
      const tickets = await this.activeTickets(c, id);
      for (const ticket of tickets)
        await this.refund(c, ticket, 'refunded', t.status === 'running');
      await c.query(
        "UPDATE tournaments SET status='cancelled',finished_at=now(),updated_at=now() WHERE id=$1",
        [id],
      );
      await audit(c, actor, 'tournament.cancel', id, {
        refundedTickets: tickets.length,
        wasRunning: t.status === 'running',
      });
      return {
        tournament: await this.view(c, await this.lockTournament(c, id)),
      };
    });
  }

  /**
   * Pays the pool by final placing, exactly once. Only the server's validated
   * tournament result may call this; ranking lists every entrant, winner first.
   */
  complete(id: string, ranking: readonly string[]) {
    return this.transaction(async (c) => {
      const t = await this.lockTournament(c, id);
      if (t.status !== 'running')
        throw new WalletError('tournament_unavailable', 409);
      const active = await this.activeTickets(c, id);
      const entrants = new Set(active.map((k) => k.user_id));
      if (
        ranking.length !== active.length ||
        new Set(ranking).size !== ranking.length ||
        ranking.some((u) => !entrants.has(u))
      )
        throw new WalletError('invalid_ranking', 400);
      const shares = (
        await c.query<{ bps: number }>(
          'SELECT basis_points AS bps FROM tournament_prize_rules WHERE tournament_id=$1 ORDER BY place',
          [id],
        )
      ).rows.map((r) => r.bps);
      const pool = active.reduce((sum, k) => sum + k.contribution_minor, 0);
      const amounts = prizeAmounts(pool, shares);
      const payouts = ranking.map((userId, index) => ({
        userId,
        place: index + 1,
        amount: amounts[index] ?? 0,
      }));
      const tx = await postWallet(c, {
        operationKey: `tournament_payout:${id}`,
        kind: 'tournament_payout',
        referenceId: id,
        entries: [
          { account: poolAccount(id), amount: -pool },
          ...payouts
            .filter((p) => p.amount > 0)
            .map((p) => ({
              account: userAccount('available', p.userId),
              amount: p.amount,
            })),
        ],
      });
      for (const p of payouts)
        await c.query(
          'INSERT INTO tournament_results(tournament_id,user_id,place,payout_minor) VALUES($1,$2,$3,$4)',
          [id, p.userId, p.place, p.amount],
        );
      await c.query(
        "UPDATE tournament_tickets SET state='settled',updated_at=now() WHERE tournament_id=$1 AND state='active'",
        [id],
      );
      await c.query(
        "UPDATE tournaments SET status='completed',finished_at=now(),payout_transaction_id=$2,updated_at=now() WHERE id=$1",
        [id, tx],
      );
      return {
        tournament: await this.view(c, await this.lockTournament(c, id)),
      };
    });
  }

  /** Finance view per tournament, including a reconciliation flag. */
  dashboard() {
    return this.transaction(async (c) => {
      const { rows } = await c.query<{
        id: string;
        name: string;
        status: string;
        startsAt: Date;
        active: number;
        cancelled: number;
        refunded: number;
        settled: number;
        feesMinor: number;
        refundsMinor: number;
        expectedPoolMinor: number;
        poolMinor: number;
        heldFeesMinor: number;
        payoutsMinor: number;
      }>(
        `SELECT t.id,t.name,t.status,t.starts_at AS "startsAt",
           count(k.*) FILTER (WHERE k.state='active')::int AS active,
           count(k.*) FILTER (WHERE k.state='cancelled')::int AS cancelled,
           count(k.*) FILTER (WHERE k.state='refunded')::int AS refunded,
           count(k.*) FILTER (WHERE k.state='settled')::int AS settled,
           coalesce(sum(k.fee_minor) FILTER (WHERE k.state IN ('active','settled')),0)::float8 AS "feesMinor",
           coalesce(sum(k.fee_minor+k.contribution_minor) FILTER (WHERE k.state IN ('cancelled','refunded')),0)::float8 AS "refundsMinor",
           coalesce(sum(k.contribution_minor) FILTER (WHERE k.state='active'),0)::float8 AS "expectedPoolMinor",
           (SELECT balance_minor::float8 FROM wallet_accounts WHERE key='tournament_pool:'||t.id) AS "poolMinor",
           (SELECT balance_minor::float8 FROM wallet_accounts WHERE key='tournament_fees:'||t.id) AS "heldFeesMinor",
           (SELECT coalesce(sum(payout_minor),0)::float8 FROM tournament_results r WHERE r.tournament_id=t.id) AS "payoutsMinor"
         FROM tournaments t LEFT JOIN tournament_tickets k ON k.tournament_id=t.id
         GROUP BY t.id ORDER BY t.starts_at DESC,t.id LIMIT 200`,
      );
      return {
        currency: 'EUR',
        tournaments: rows.map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          startsAt: r.startsAt.toISOString(),
          tickets: {
            active: r.active,
            cancelled: r.cancelled,
            refunded: r.refunded,
            settled: r.settled,
          },
          entryFeesMinor: r.feesMinor,
          prizePoolMinor: r.poolMinor,
          payoutsMinor: r.payoutsMinor,
          refundsMinor: r.refundsMinor,
          reconciled: r.poolMinor === r.expectedPoolMinor,
          heldFeesMinor: r.heldFeesMinor,
        })),
      };
    });
  }
}
