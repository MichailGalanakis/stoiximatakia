import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import {
  REGISTRATION_SETTINGS,
  type RegistrationSettings,
} from '../registration/registration-settings';
import {
  InvalidProviderEvent,
  SandboxPaymentProvider,
  type PaymentProvider,
  type ProviderEvent,
} from './payment-provider';
import {
  adminTokenHash,
  audit,
  hasRole,
  type AdminActor,
  type AdminRole,
} from './admin';
import {
  adminOpenDispute,
  adminResolveDispute,
  applyDisputeEvent,
  auditLog,
  createAdmin,
  deactivateAdmin,
  decideCorrection,
  listCorrections,
  listDisputes,
  listReconciliations,
  reconcile,
  requestCorrection,
} from './finance-controls';
import {
  HOUSE_MATCH_COLUMNS,
  houseMatchView,
  settleHouseMatch,
  startHouseMatch,
  type HouseOutcome,
} from './house-matches';
import { WalletError } from './wallet-error';
import { externalAccount, postWallet, userAccount } from './wallet-ledger';
import {
  WALLET_SETTINGS,
  maxWithdrawableMinor,
  type WalletSettings,
} from './wallet-settings';

const SESSION_PATTERN = /^[a-f0-9]{64}$/;
const fingerprintOf = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface Actor {
  id: string;
  account_kind: string;
  email_verified: boolean;
  phone_verified: boolean;
}
interface DepositRow {
  id: string;
  user_id: string;
  provider: string;
  amount_minor: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed';
  created_at: Date;
}
interface WithdrawalRow {
  id: string;
  user_id: string;
  provider: string;
  amount_minor: number;
  currency: string;
  status:
    'requested' | 'processing' | 'paid' | 'rejected' | 'cancelled' | 'failed';
  provider_reference: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  created_at: Date;
  updated_at: Date;
}
const DEPOSIT_COLUMNS =
  'id,user_id,provider,amount_minor::float8 AS amount_minor,currency,status,created_at';
const WITHDRAWAL_COLUMNS =
  'id,user_id,provider,amount_minor::float8 AS amount_minor,currency,status,provider_reference,reviewed_by,review_note,created_at,updated_at';

const depositView = (d: DepositRow) => ({
  id: d.id,
  provider: d.provider,
  amountMinor: d.amount_minor,
  currency: d.currency,
  status: d.status,
  createdAt: d.created_at.toISOString(),
});
const withdrawalView = (w: WithdrawalRow) => ({
  id: w.id,
  provider: w.provider,
  amountMinor: w.amount_minor,
  currency: w.currency,
  status: w.status,
  createdAt: w.created_at.toISOString(),
  updatedAt: w.updated_at.toISOString(),
});

export type WebhookOutcome =
  { status: 'processed' | 'duplicate' } | { status: 'ignored'; reason: string };

@Injectable()
export class WalletStore implements OnModuleDestroy {
  private readonly pool: Pool | undefined;
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(
    @Inject(REGISTRATION_SETTINGS) registration: RegistrationSettings,
    @Inject(WALLET_SETTINGS) private readonly settings: WalletSettings,
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
    if (settings.sandboxSecret)
      this.registerProvider(
        new SandboxPaymentProvider(
          settings.sandboxSecret,
          registration.appOrigin,
        ),
      );
  }
  registerProvider(provider: PaymentProvider): void {
    this.providers.set(provider.id, provider);
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

  /** Locks the account row, so one account's money commands run one at a time. */
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

  private requireEligible(actor: Actor) {
    // Real money needs a registered account with a verified contact; identity
    // checks (KYC, age) attach here once a provider and legal basis exist.
    if (
      actor.account_kind !== 'registered' ||
      !(actor.email_verified || actor.phone_verified)
    )
      throw new WalletError('account_not_eligible', 403);
  }

  private async balanceOf(c: PoolClient, userId: string) {
    const { rows } = await c.query<{ kind: string; amount: number }>(
      'SELECT kind,balance_minor::float8 AS amount FROM wallet_accounts WHERE user_id=$1',
      [userId],
    );
    const of = (kind: string) => {
      const amount = rows.find((r) => r.kind === kind)?.amount;
      if (amount === undefined)
        throw new WalletError('wallet_unavailable', 503);
      return amount;
    };
    const availableMinor = of('available');
    const reservedMinor = of('reserved');
    const pendingWithdrawalMinor = of('withdrawal_pending');
    return {
      currency: 'EUR' as const,
      availableMinor,
      reservedMinor,
      pendingWithdrawalMinor,
      totalMinor: availableMinor + reservedMinor + pendingWithdrawalMinor,
      withdrawableMinor: maxWithdrawableMinor(availableMinor, this.settings),
    };
  }

  balance(hash: string) {
    return this.session(hash, (c, actor) => this.balanceOf(c, actor.id));
  }

  history(hash: string) {
    return this.session(hash, async (c, actor) => {
      const { rows } = await c.query<{
        transactionId: string;
        kind: string;
        referenceId: string;
        account: string;
        amountMinor: number;
        createdAt: Date;
      }>(
        `SELECT t.id AS "transactionId",t.kind,t.reference_id AS "referenceId",e.account_key AS account,
         e.amount_minor::float8 AS "amountMinor",t.created_at AS "createdAt"
         FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id
         WHERE e.account_key=ANY($1::text[]) ORDER BY t.created_at DESC,t.id,e.account_key LIMIT 100`,
        [
          [
            userAccount('available', actor.id),
            userAccount('reserved', actor.id),
            userAccount('withdrawal_pending', actor.id),
          ],
        ],
      );
      return {
        entries: rows.map((r) => ({
          transactionId: r.transactionId,
          kind: r.kind,
          referenceId: r.referenceId,
          account: r.account.slice(0, r.account.indexOf(':')),
          amountMinor: r.amountMinor,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    });
  }

  deposits(hash: string) {
    return this.session(hash, async (c, actor) => {
      const { rows } = await c.query<DepositRow>(
        `SELECT ${DEPOSIT_COLUMNS} FROM deposits WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 50`,
        [actor.id],
      );
      return { deposits: rows.map(depositView) };
    });
  }

  withdrawals(hash: string) {
    return this.session(hash, async (c, actor) => {
      const { rows } = await c.query<WithdrawalRow>(
        `SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawal_requests WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 50`,
        [actor.id],
      );
      return { withdrawals: rows.map(withdrawalView) };
    });
  }

  private defaultProvider(): PaymentProvider {
    const provider = this.providers.values().next().value;
    if (!provider) throw new WalletError('wallet_unavailable', 503);
    return provider;
  }

  createDeposit(hash: string, operationId: string, amountMinor: number) {
    return this.session(hash, (c, actor) =>
      this.operation(
        c,
        actor.id,
        operationId,
        { type: 'deposit', amountMinor },
        async () => {
          this.requireEligible(actor);
          if (
            amountMinor < this.settings.minDepositMinor ||
            amountMinor > this.settings.maxDepositMinor
          )
            throw new WalletError('invalid_amount', 400);
          const provider = this.defaultProvider();
          const id = randomUUID();
          const session = await provider.createDeposit({
            depositId: id,
            amountMinor,
            currency: 'EUR',
          });
          const { rows } = await c.query<DepositRow>(
            `INSERT INTO deposits(id,user_id,provider,amount_minor,provider_reference)
             VALUES($1,$2,$3,$4,$5) RETURNING ${DEPOSIT_COLUMNS}`,
            [id, actor.id, provider.id, amountMinor, session.providerReference],
          );
          return {
            deposit: depositView(rows[0]!),
            redirectUrl: session.redirectUrl,
          };
        },
      ),
    );
  }

  requestWithdrawal(hash: string, operationId: string, amountMinor: number) {
    return this.session(hash, (c, actor) =>
      this.operation(
        c,
        actor.id,
        operationId,
        { type: 'withdrawal', amountMinor },
        async () => {
          this.requireEligible(actor);
          if (amountMinor < this.settings.minWithdrawalMinor)
            throw new WalletError('invalid_amount', 400);
          const recent = await c.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM withdrawal_requests
             WHERE user_id=$1 AND status<>'cancelled' AND created_at>now()-interval '24 hours'`,
            [actor.id],
          );
          if (recent.rows[0]!.count >= this.settings.withdrawalsPerDay)
            throw new WalletError('withdrawal_limit_reached', 429);
          // Money must not leave while a deposit is contested.
          const disputed = await c.query(
            "SELECT 1 FROM deposit_disputes WHERE user_id=$1 AND status='open' LIMIT 1",
            [actor.id],
          );
          if (disputed.rowCount)
            throw new WalletError('account_restricted', 403);
          // Pay out through the method last used to deposit.
          const source = await c.query<{ provider: string }>(
            "SELECT provider FROM deposits WHERE user_id=$1 AND status='succeeded' ORDER BY created_at DESC,id LIMIT 1",
            [actor.id],
          );
          const providerId = source.rows[0]?.provider;
          if (!providerId || !this.providers.has(providerId))
            throw new WalletError('account_not_eligible', 403);
          const available = await c.query<{ amount: number }>(
            'SELECT balance_minor::float8 AS amount FROM wallet_accounts WHERE key=$1 FOR UPDATE',
            [userAccount('available', actor.id)],
          );
          const availableMinor = available.rows[0]?.amount ?? 0;
          if (availableMinor < amountMinor)
            throw new WalletError('insufficient_funds', 409);
          if (amountMinor > maxWithdrawableMinor(availableMinor, this.settings))
            throw new WalletError('withdrawal_share_exceeded', 409);
          const id = randomUUID();
          const hold = await postWallet(c, {
            operationKey: `withdrawal_hold:${id}`,
            kind: 'withdrawal_hold',
            referenceId: id,
            actorId: actor.id,
            entries: [
              {
                account: userAccount('available', actor.id),
                amount: -amountMinor,
              },
              {
                account: userAccount('withdrawal_pending', actor.id),
                amount: amountMinor,
              },
            ],
          });
          const { rows } = await c.query<WithdrawalRow>(
            `INSERT INTO withdrawal_requests(id,user_id,provider,amount_minor,hold_transaction_id)
             VALUES($1,$2,$3,$4,$5) RETURNING ${WITHDRAWAL_COLUMNS}`,
            [id, actor.id, providerId, amountMinor, hold],
          );
          return {
            withdrawal: withdrawalView(rows[0]!),
            balance: await this.balanceOf(c, actor.id),
          };
        },
      ),
    );
  }

  cancelWithdrawal(hash: string, operationId: string, withdrawalId: string) {
    return this.session(hash, (c, actor) =>
      this.operation(
        c,
        actor.id,
        operationId,
        { type: 'cancel_withdrawal', withdrawalId },
        async () => {
          const w = await this.lockWithdrawal(c, withdrawalId, actor.id);
          if (w.status !== 'requested')
            throw new WalletError('withdrawal_state_conflict', 409);
          const updated = await this.release(c, w, 'cancelled', actor.id);
          return {
            withdrawal: withdrawalView(updated),
            balance: await this.balanceOf(c, actor.id),
          };
        },
      ),
    );
  }

  private async lockWithdrawal(c: PoolClient, id: string, userId?: string) {
    const { rows } = await c.query<WithdrawalRow>(
      `SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawal_requests WHERE id=$1 FOR UPDATE`,
      [id],
    );
    const w = rows[0];
    if (!w || (userId !== undefined && w.user_id !== userId))
      throw new WalletError('withdrawal_not_found', 404);
    return w;
  }

  /** Returns held funds to the player's available balance. */
  private async release(
    c: PoolClient,
    w: WithdrawalRow,
    status: 'cancelled' | 'rejected' | 'failed',
    actorId?: string,
    review?: { reviewer: string; note?: string | undefined },
  ) {
    const tx = await postWallet(c, {
      operationKey: `withdrawal_release:${w.id}`,
      kind: 'withdrawal_release',
      referenceId: w.id,
      actorId,
      entries: [
        {
          account: userAccount('withdrawal_pending', w.user_id),
          amount: -w.amount_minor,
        },
        {
          account: userAccount('available', w.user_id),
          amount: w.amount_minor,
        },
      ],
    });
    const { rows } = await c.query<WithdrawalRow>(
      `UPDATE withdrawal_requests SET status=$2,final_transaction_id=$3,updated_at=now(),
       reviewed_by=coalesce($4,reviewed_by),review_note=coalesce($5,review_note)
       WHERE id=$1 RETURNING ${WITHDRAWAL_COLUMNS}`,
      [w.id, status, tx, review?.reviewer ?? null, review?.note ?? null],
    );
    return rows[0]!;
  }

  async handleWebhook(
    providerId: string,
    raw: Buffer | undefined,
    headers: IncomingHttpHeaders,
  ): Promise<WebhookOutcome> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new WalletError('provider_not_found', 404);
    let event: ProviderEvent;
    try {
      if (!raw) throw new InvalidProviderEvent('payload');
      event = provider.parseWebhook(raw, headers);
    } catch (error) {
      if (error instanceof InvalidProviderEvent)
        throw new WalletError('invalid_signature', 400);
      throw error;
    }
    return this.transaction(async (c) => {
      const stored = await c.query(
        `INSERT INTO provider_events(provider,event_id,event_type,payload) VALUES($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [provider.id, event.id, event.type, JSON.stringify(event)],
      );
      if (!stored.rowCount) return { status: 'duplicate' } as const;
      switch (event.type) {
        case 'deposit.succeeded':
        case 'deposit.failed':
          return this.applyDepositEvent(c, provider.id, event);
        case 'payout.succeeded':
        case 'payout.failed':
          return this.applyPayoutEvent(c, provider.id, event);
        default:
          return applyDisputeEvent(c, provider.id, event);
      }
    });
  }

  private async applyDepositEvent(
    c: PoolClient,
    providerId: string,
    event: ProviderEvent,
  ): Promise<WebhookOutcome> {
    const { rows } = await c.query<DepositRow>(
      `SELECT ${DEPOSIT_COLUMNS} FROM deposits WHERE id=$1 AND provider=$2 FOR UPDATE`,
      [event.paymentId, providerId],
    );
    const d = rows[0];
    if (!d) return { status: 'ignored', reason: 'unknown_payment' };
    if (d.status !== 'pending') return { status: 'ignored', reason: 'final' };
    // Leave mismatches pending for finance review rather than guessing.
    if (event.amountMinor !== d.amount_minor || event.currency !== d.currency)
      return { status: 'ignored', reason: 'amount_mismatch' };
    if (event.type === 'deposit.failed') {
      await c.query(
        "UPDATE deposits SET status='failed',updated_at=now() WHERE id=$1",
        [d.id],
      );
      return { status: 'processed' };
    }
    const tx = await postWallet(c, {
      operationKey: `deposit:${d.id}`,
      kind: 'deposit',
      referenceId: d.id,
      entries: [
        { account: externalAccount(providerId), amount: -d.amount_minor },
        {
          account: userAccount('available', d.user_id),
          amount: d.amount_minor,
        },
      ],
    });
    await c.query(
      "UPDATE deposits SET status='succeeded',transaction_id=$2,updated_at=now() WHERE id=$1",
      [d.id, tx],
    );
    return { status: 'processed' };
  }

  private async applyPayoutEvent(
    c: PoolClient,
    providerId: string,
    event: ProviderEvent,
  ): Promise<WebhookOutcome> {
    const { rows } = await c.query<WithdrawalRow>(
      `SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawal_requests WHERE id=$1 AND provider=$2 FOR UPDATE`,
      [event.paymentId, providerId],
    );
    const w = rows[0];
    if (!w) return { status: 'ignored', reason: 'unknown_payment' };
    if (w.status !== 'processing')
      return { status: 'ignored', reason: 'final' };
    if (
      event.amountMinor !== w.amount_minor ||
      event.currency !== w.currency ||
      event.providerReference !== w.provider_reference
    )
      return { status: 'ignored', reason: 'amount_mismatch' };
    if (event.type === 'payout.failed') {
      await this.release(c, w, 'failed');
      return { status: 'processed' };
    }
    const tx = await postWallet(c, {
      operationKey: `withdrawal_paid:${w.id}`,
      kind: 'withdrawal_paid',
      referenceId: w.id,
      entries: [
        {
          account: userAccount('withdrawal_pending', w.user_id),
          amount: -w.amount_minor,
        },
        { account: externalAccount(providerId), amount: w.amount_minor },
      ],
    });
    await c.query(
      "UPDATE withdrawal_requests SET status='paid',final_transaction_id=$2,updated_at=now() WHERE id=$1",
      [w.id, tx],
    );
    return { status: 'processed' };
  }

  /**
   * Named admins authenticate with their own token; WALLET_ADMIN_TOKEN remains a
   * break-glass `root` admin. Every admin action is attributed to the actor.
   */
  async authorizeAdmin(
    header: string | undefined,
    required: AdminRole,
  ): Promise<AdminActor> {
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new WalletError('admin_unauthorized', 401);
    let actor: AdminActor | undefined;
    const root = this.settings.adminToken;
    if (root) {
      const given = Buffer.from(token);
      const expected = Buffer.from(root);
      if (given.length === expected.length && timingSafeEqual(given, expected))
        actor = { name: 'root', role: 'admin' };
    }
    if (!actor) {
      if (!this.pool) throw new WalletError('wallet_unavailable', 503);
      const { rows } = await this.pool
        .query<AdminActor>(
          'SELECT name,role FROM admin_users WHERE token_hash=$1 AND active',
          [adminTokenHash(token)],
        )
        .catch(() => {
          throw new WalletError('wallet_unavailable', 503);
        });
      actor = rows[0];
    }
    if (!actor) throw new WalletError('admin_unauthorized', 401);
    if (!hasRole(actor, required))
      throw new WalletError('admin_forbidden', 403);
    return actor;
  }

  adminWithdrawals(status: string | undefined) {
    return this.transaction(async (c) => {
      const { rows } = await c.query<WithdrawalRow>(
        `SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawal_requests
         WHERE $1::text IS NULL OR status=$1 ORDER BY created_at,id LIMIT 200`,
        [status ?? null],
      );
      return {
        withdrawals: rows.map((w) => ({
          ...withdrawalView(w),
          userId: w.user_id,
          providerReference: w.provider_reference,
          reviewedBy: w.reviewed_by,
          reviewNote: w.review_note,
        })),
      };
    });
  }

  approveWithdrawal(id: string, actor: AdminActor, note?: string) {
    const reviewer = actor.name;
    return this.transaction(async (c) => {
      const w = await this.lockWithdrawal(c, id);
      if (w.status !== 'requested')
        throw new WalletError('withdrawal_state_conflict', 409);
      const disputed = await c.query(
        "SELECT 1 FROM deposit_disputes WHERE user_id=$1 AND status='open' LIMIT 1",
        [w.user_id],
      );
      if (disputed.rowCount) throw new WalletError('account_restricted', 403);
      const provider = this.providers.get(w.provider);
      if (!provider) throw new WalletError('wallet_unavailable', 503);
      const payout = await provider.createPayout({
        withdrawalId: w.id,
        amountMinor: w.amount_minor,
        currency: 'EUR',
      });
      const { rows } = await c.query<WithdrawalRow>(
        `UPDATE withdrawal_requests SET status='processing',provider_reference=$2,
         reviewed_by=$3,review_note=$4,updated_at=now() WHERE id=$1 RETURNING ${WITHDRAWAL_COLUMNS}`,
        [w.id, payout.providerReference, reviewer, note ?? null],
      );
      await audit(c, actor, 'withdrawal.approve', w.id, {
        amountMinor: w.amount_minor,
        note: note ?? null,
      });
      return { withdrawal: withdrawalView(rows[0]!) };
    });
  }

  rejectWithdrawal(id: string, actor: AdminActor, note?: string) {
    return this.transaction(async (c) => {
      const w = await this.lockWithdrawal(c, id);
      if (w.status !== 'requested')
        throw new WalletError('withdrawal_state_conflict', 409);
      const updated = await this.release(c, w, 'rejected', undefined, {
        reviewer: actor.name,
        note,
      });
      await audit(c, actor, 'withdrawal.reject', w.id, {
        amountMinor: w.amount_minor,
        note: note ?? null,
      });
      return { withdrawal: withdrawalView(updated) };
    });
  }

  /** Reconciliation view: player liabilities, house funds and provider positions. */
  summary() {
    return this.transaction(async (c) => {
      const accounts = await c.query<{
        key: string;
        kind: string;
        amount: number;
      }>(
        "SELECT key,kind,balance_minor::float8 AS amount FROM wallet_accounts WHERE kind IN ('external','house_revenue','prize_pool') OR balance_minor<>0",
      );
      const total = (kind: string) =>
        accounts.rows
          .filter((a) => a.kind === kind)
          .reduce((sum, a) => sum + a.amount, 0);
      const ledger = await c.query<{ sum: number; count: number }>(
        'SELECT coalesce(sum(amount_minor),0)::float8 AS sum,count(DISTINCT transaction_id)::int AS count FROM ledger_entries',
      );
      const open = await c.query<{
        deposits: number;
        withdrawals: number;
        houseMatches: number;
        disputes: number;
        shortfallMinor: number;
      }>(
        `SELECT (SELECT count(*)::int FROM deposits WHERE status='pending') AS deposits,
                (SELECT count(*)::int FROM withdrawal_requests WHERE status IN ('requested','processing')) AS withdrawals,
                (SELECT count(*)::int FROM house_matches WHERE status='active') AS "houseMatches",
                (SELECT count(*)::int FROM deposit_disputes WHERE status='open') AS "disputes",
                (SELECT coalesce(sum(shortfall_minor),0)::float8 FROM deposit_disputes WHERE status='lost') AS "shortfallMinor"`,
      );
      return {
        currency: 'EUR',
        playerAvailableMinor: total('available'),
        playerReservedMinor: total('reserved'),
        pendingWithdrawalMinor: total('withdrawal_pending'),
        prizePoolMinor: total('prize_pool'),
        houseRevenueMinor: total('house_revenue'),
        house: {
          // Free reserve can back new matches; exposure is locked for active ones.
          reserveMinor: total('house_reserve'),
          exposureMinor: total('house_match'),
          activeMatches: open.rows[0]!.houseMatches,
        },
        providers: accounts.rows
          .filter((a) => a.kind === 'external')
          .map((a) => ({
            provider: a.key.slice('external:'.length),
            // External accounts are negative while the provider holds player money.
            heldMinor: -a.amount,
          })),
        ledger: {
          transactions: ledger.rows[0]!.count,
          balanced: ledger.rows[0]!.sum === 0,
        },
        open: {
          deposits: open.rows[0]!.deposits,
          withdrawals: open.rows[0]!.withdrawals,
          disputes: open.rows[0]!.disputes,
        },
        // Lost chargebacks the player could not cover; absorbed by the company.
        chargebackShortfallMinor: open.rows[0]!.shortfallMinor,
      };
    });
  }

  /** Moves company capital into or out of the reserve; never touches player funds. */
  moveCapital(
    input: {
      operationId: string;
      direction: 'in' | 'out';
      amountMinor: number;
      note?: string | undefined;
    },
    actor: AdminActor,
  ) {
    return this.transaction(async (c) => {
      const previous = await c.query<{
        direction: string;
        amount: number;
      }>(
        'SELECT direction,amount_minor::float8 AS amount FROM house_capital_movements WHERE id=$1',
        [input.operationId],
      );
      if (previous.rows[0]) {
        if (
          previous.rows[0].direction !== input.direction ||
          previous.rows[0].amount !== input.amountMinor
        )
          throw new WalletError('operation_conflict', 409);
        return { reserveMinor: await this.reserveOf(c) };
      }
      if (input.direction === 'out') {
        const reserve = await c.query<{ amount: number }>(
          "SELECT balance_minor::float8 AS amount FROM wallet_accounts WHERE key='house_reserve' FOR UPDATE",
        );
        if (reserve.rows[0]!.amount < input.amountMinor)
          throw new WalletError('house_reserve_insufficient', 409);
      }
      const sign = input.direction === 'in' ? 1 : -1;
      const tx = await postWallet(c, {
        operationKey: `capital:${input.operationId}`,
        kind: input.direction === 'in' ? 'capital_in' : 'capital_out',
        referenceId: input.operationId,
        entries: [
          { account: 'external:company', amount: -sign * input.amountMinor },
          { account: 'house_reserve', amount: sign * input.amountMinor },
        ],
      });
      await c.query(
        'INSERT INTO house_capital_movements(id,direction,amount_minor,reviewer,note,transaction_id) VALUES($1,$2,$3,$4,$5,$6)',
        [
          input.operationId,
          input.direction,
          input.amountMinor,
          actor.name,
          input.note ?? null,
          tx,
        ],
      );
      await audit(c, actor, `capital.${input.direction}`, input.operationId, {
        amountMinor: input.amountMinor,
        note: input.note ?? null,
      });
      return { reserveMinor: await this.reserveOf(c) };
    });
  }
  private async reserveOf(c: PoolClient) {
    const { rows } = await c.query<{ amount: number }>(
      "SELECT balance_minor::float8 AS amount FROM wallet_accounts WHERE key='house_reserve'",
    );
    return rows[0]!.amount;
  }

  adminHouseMatches(status: string | undefined) {
    return this.transaction(async (c) => {
      const { rows } = await c.query<Parameters<typeof houseMatchView>[0]>(
        `SELECT ${HOUSE_MATCH_COLUMNS} FROM house_matches
         WHERE $1::text IS NULL OR status=$1 ORDER BY created_at DESC,id LIMIT 200`,
        [status ?? null],
      );
      return { matches: rows.map(houseMatchView) };
    });
  }

  /** Server-side entry point for a player-vs-platform game; not exposed over HTTP. */
  startHouseMatch(input: {
    matchId: string;
    userId: string;
    offerId: string;
    gameId: string;
  }) {
    return this.transaction(async (c) => {
      // Same account row lock as session commands, so stakes and withdrawals serialize.
      const { rows } = await c.query<Actor>(
        'SELECT id,account_kind,email_verified,phone_verified FROM users WHERE id=$1 FOR NO KEY UPDATE',
        [input.userId],
      );
      if (!rows[0]) throw new WalletError('account_not_eligible', 403);
      this.requireEligible(rows[0]);
      return startHouseMatch(c, input);
    });
  }

  /** Called only with the server's authoritative game result. */
  settleHouseMatch(matchId: string, outcome: HouseOutcome) {
    return this.transaction((c) => settleHouseMatch(c, matchId, outcome));
  }

  createAdmin(actor: AdminActor, name: string, role: AdminRole) {
    return this.transaction((c) => createAdmin(c, actor, name, role));
  }
  deactivateAdmin(actor: AdminActor, name: string) {
    return this.transaction((c) => deactivateAdmin(c, actor, name));
  }
  admins() {
    return this.transaction(async (c) => {
      const { rows } = await c.query(
        'SELECT name,role,active,created_by AS "createdBy",created_at AS "createdAt" FROM admin_users ORDER BY name',
      );
      return { admins: rows };
    });
  }
  auditLog(limit: number) {
    return this.transaction((c) => auditLog(c, limit));
  }
  requestCorrection(
    actor: AdminActor,
    input: { id: string; userId: string; amountMinor: number; reason: string },
  ) {
    return this.transaction((c) => requestCorrection(c, actor, input));
  }
  decideCorrection(actor: AdminActor, id: string, approve: boolean) {
    return this.transaction((c) => decideCorrection(c, actor, id, approve));
  }
  corrections(status?: string) {
    return this.transaction((c) => listCorrections(c, status));
  }
  openDispute(actor: AdminActor, depositId: string, reason: string) {
    return this.transaction((c) =>
      adminOpenDispute(c, actor, depositId, reason),
    );
  }
  resolveDispute(
    actor: AdminActor,
    id: string,
    outcome: 'won' | 'lost',
    note?: string,
  ) {
    return this.transaction((c) =>
      adminResolveDispute(c, actor, id, outcome, note),
    );
  }
  disputes(status?: string) {
    return this.transaction((c) => listDisputes(c, status));
  }
  reconcile(
    actor: AdminActor,
    input: { provider: string; periodEnd: string; reportedHeldMinor: number },
  ) {
    return this.transaction((c) => reconcile(c, actor, input));
  }
  reconciliations() {
    return this.transaction((c) => listReconciliations(c));
  }
}
