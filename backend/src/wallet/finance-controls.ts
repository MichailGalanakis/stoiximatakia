import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  adminTokenHash,
  audit,
  type AdminActor,
  type AdminRole,
} from './admin';
import type { ProviderEvent } from './payment-provider';
import { WalletError } from './wallet-error';
import { externalAccount, postWallet, userAccount } from './wallet-ledger';
import type { WebhookOutcome } from './wallet.store';

// Admin accounts

export async function createAdmin(
  c: PoolClient,
  actor: AdminActor,
  name: string,
  role: AdminRole,
) {
  const token = randomBytes(32).toString('hex');
  const created = await c.query(
    `INSERT INTO admin_users(id,name,role,token_hash,created_by) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (name) DO NOTHING`,
    [randomUUID(), name, role, adminTokenHash(token), actor.name],
  );
  if (!created.rowCount) throw new WalletError('admin_exists', 409);
  await audit(c, actor, 'admin.create', name, { role });
  // The token is shown once; only its hash is stored.
  return { admin: { name, role, active: true }, token };
}

export async function deactivateAdmin(
  c: PoolClient,
  actor: AdminActor,
  name: string,
) {
  const updated = await c.query(
    'UPDATE admin_users SET active=false WHERE name=$1 AND active',
    [name],
  );
  if (!updated.rowCount) throw new WalletError('admin_not_found', 404);
  await audit(c, actor, 'admin.deactivate', name);
  return { admin: { name, active: false } };
}

// Two-person balance corrections

interface CorrectionRow {
  id: string;
  user_id: string;
  amount_minor: number;
  reason: string;
  status: 'pending' | 'applied' | 'rejected';
  requested_by: string;
  decided_by: string | null;
  created_at: Date;
  decided_at: Date | null;
}
const CORRECTION_COLUMNS =
  'id,user_id,amount_minor::float8 AS amount_minor,reason,status,requested_by,decided_by,created_at,decided_at';
const correctionView = (r: CorrectionRow) => ({
  id: r.id,
  userId: r.user_id,
  amountMinor: r.amount_minor,
  reason: r.reason,
  status: r.status,
  requestedBy: r.requested_by,
  decidedBy: r.decided_by,
  createdAt: r.created_at.toISOString(),
  decidedAt: r.decided_at?.toISOString() ?? null,
});

export async function requestCorrection(
  c: PoolClient,
  actor: AdminActor,
  input: { id: string; userId: string; amountMinor: number; reason: string },
) {
  const user = await c.query('SELECT 1 FROM users WHERE id=$1', [input.userId]);
  if (!user.rowCount) throw new WalletError('user_not_found', 404);
  const existing = await c.query<CorrectionRow>(
    `SELECT ${CORRECTION_COLUMNS} FROM balance_corrections WHERE id=$1`,
    [input.id],
  );
  if (existing.rows[0]) {
    const e = existing.rows[0];
    if (
      e.user_id !== input.userId ||
      e.amount_minor !== input.amountMinor ||
      e.reason !== input.reason ||
      e.requested_by !== actor.name
    )
      throw new WalletError('operation_conflict', 409);
    return { correction: correctionView(e) };
  }
  const { rows } = await c.query<CorrectionRow>(
    `INSERT INTO balance_corrections(id,user_id,amount_minor,reason,requested_by)
     VALUES($1,$2,$3,$4,$5) RETURNING ${CORRECTION_COLUMNS}`,
    [input.id, input.userId, input.amountMinor, input.reason, actor.name],
  );
  await audit(c, actor, 'correction.request', input.id, {
    userId: input.userId,
    amountMinor: input.amountMinor,
    reason: input.reason,
  });
  return { correction: correctionView(rows[0]!) };
}

/**
 * A second admin applies or rejects. Credits come from company funds and debits
 * return to them, so a correction never creates or destroys money.
 */
export async function decideCorrection(
  c: PoolClient,
  actor: AdminActor,
  id: string,
  approve: boolean,
) {
  const { rows } = await c.query<CorrectionRow>(
    `SELECT ${CORRECTION_COLUMNS} FROM balance_corrections WHERE id=$1 FOR UPDATE`,
    [id],
  );
  const r = rows[0];
  if (!r) throw new WalletError('correction_not_found', 404);
  if (r.status !== 'pending') throw new WalletError('correction_decided', 409);
  if (r.requested_by === actor.name)
    throw new WalletError('same_reviewer', 403);
  let tx: string | null = null;
  if (approve) {
    const available = userAccount('available', r.user_id);
    if (r.amount_minor < 0) {
      const balance = await c.query<{ amount: number }>(
        'SELECT balance_minor::float8 AS amount FROM wallet_accounts WHERE key=$1 FOR UPDATE',
        [available],
      );
      if ((balance.rows[0]?.amount ?? 0) < -r.amount_minor)
        throw new WalletError('insufficient_funds', 409);
    }
    tx = await postWallet(c, {
      operationKey: `correction:${r.id}`,
      kind: 'correction',
      referenceId: r.id,
      entries: [
        { account: available, amount: r.amount_minor },
        { account: 'external:company', amount: -r.amount_minor },
      ],
    });
  }
  const updated = await c.query<CorrectionRow>(
    `UPDATE balance_corrections SET status=$2,decided_by=$3,transaction_id=$4,decided_at=now()
     WHERE id=$1 RETURNING ${CORRECTION_COLUMNS}`,
    [r.id, approve ? 'applied' : 'rejected', actor.name, tx],
  );
  await audit(
    c,
    actor,
    approve ? 'correction.apply' : 'correction.reject',
    r.id,
    {
      userId: r.user_id,
      amountMinor: r.amount_minor,
    },
  );
  return { correction: correctionView(updated.rows[0]!) };
}

export async function listCorrections(c: PoolClient, status?: string) {
  const { rows } = await c.query<CorrectionRow>(
    `SELECT ${CORRECTION_COLUMNS} FROM balance_corrections
     WHERE $1::text IS NULL OR status=$1 ORDER BY created_at DESC,id LIMIT 200`,
    [status ?? null],
  );
  return { corrections: rows.map(correctionView) };
}

// Deposit disputes (chargebacks)

interface DisputeRow {
  id: string;
  deposit_id: string;
  user_id: string;
  provider: string;
  amount_minor: number;
  status: 'open' | 'won' | 'lost';
  reason: string;
  opened_by: string;
  resolved_by: string | null;
  recovered_minor: number | null;
  shortfall_minor: number | null;
  created_at: Date;
  resolved_at: Date | null;
}
const DISPUTE_COLUMNS = `id,deposit_id,user_id,provider,amount_minor::float8 AS amount_minor,status,reason,
  opened_by,resolved_by,recovered_minor::float8 AS recovered_minor,shortfall_minor::float8 AS shortfall_minor,
  created_at,resolved_at`;
const disputeView = (d: DisputeRow) => ({
  id: d.id,
  depositId: d.deposit_id,
  userId: d.user_id,
  provider: d.provider,
  amountMinor: d.amount_minor,
  status: d.status,
  reason: d.reason,
  openedBy: d.opened_by,
  resolvedBy: d.resolved_by,
  recoveredMinor: d.recovered_minor,
  shortfallMinor: d.shortfall_minor,
  createdAt: d.created_at.toISOString(),
  resolvedAt: d.resolved_at?.toISOString() ?? null,
});

export async function openDispute(
  c: PoolClient,
  depositId: string,
  reason: string,
  openedBy: string,
) {
  const deposit = await c.query<{
    user_id: string;
    provider: string;
    amount: number;
  }>(
    "SELECT user_id,provider,amount_minor::float8 AS amount FROM deposits WHERE id=$1 AND status='succeeded' FOR UPDATE",
    [depositId],
  );
  const d = deposit.rows[0];
  if (!d) throw new WalletError('deposit_not_found', 404);
  const exists = await c.query(
    "SELECT 1 FROM deposit_disputes WHERE deposit_id=$1 AND status IN ('open','lost')",
    [depositId],
  );
  if (exists.rowCount) throw new WalletError('dispute_exists', 409);
  const { rows } = await c.query<DisputeRow>(
    `INSERT INTO deposit_disputes(id,deposit_id,user_id,provider,amount_minor,reason,opened_by)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${DISPUTE_COLUMNS}`,
    [
      randomUUID(),
      depositId,
      d.user_id,
      d.provider,
      d.amount,
      reason,
      openedBy,
    ],
  );
  return rows[0]!;
}

/**
 * Lost: the provider has returned the deposit to the cardholder. Take back what
 * the player still holds; the company absorbs and records any shortfall.
 */
export async function resolveDispute(
  c: PoolClient,
  disputeId: string,
  outcome: 'won' | 'lost',
  resolvedBy: string,
) {
  const { rows } = await c.query<DisputeRow>(
    `SELECT ${DISPUTE_COLUMNS} FROM deposit_disputes WHERE id=$1 FOR UPDATE`,
    [disputeId],
  );
  const d = rows[0];
  if (!d) throw new WalletError('dispute_not_found', 404);
  if (d.status !== 'open') throw new WalletError('dispute_resolved', 409);
  let recovered: number | null = null,
    shortfall: number | null = null,
    tx: string | null = null;
  if (outcome === 'lost') {
    const available = userAccount('available', d.user_id);
    const balance = await c.query<{ amount: number }>(
      'SELECT balance_minor::float8 AS amount FROM wallet_accounts WHERE key=$1 FOR UPDATE',
      [available],
    );
    recovered = Math.min(d.amount_minor, balance.rows[0]?.amount ?? 0);
    shortfall = d.amount_minor - recovered;
    tx = await postWallet(c, {
      operationKey: `chargeback:${d.id}`,
      kind: 'chargeback',
      referenceId: d.id,
      entries: [
        { account: externalAccount(d.provider), amount: d.amount_minor },
        ...(recovered > 0 ? [{ account: available, amount: -recovered }] : []),
        ...(shortfall > 0
          ? [{ account: 'external:company', amount: -shortfall }]
          : []),
      ],
    });
  }
  const updated = await c.query<DisputeRow>(
    `UPDATE deposit_disputes SET status=$2,resolved_by=$3,recovered_minor=$4,shortfall_minor=$5,
     transaction_id=$6,resolved_at=now() WHERE id=$1 RETURNING ${DISPUTE_COLUMNS}`,
    [d.id, outcome, resolvedBy, recovered, shortfall, tx],
  );
  return updated.rows[0]!;
}

export async function applyDisputeEvent(
  c: PoolClient,
  providerId: string,
  event: ProviderEvent,
): Promise<WebhookOutcome> {
  const deposit = await c.query<{ amount: number; provider: string }>(
    'SELECT amount_minor::float8 AS amount,provider FROM deposits WHERE id=$1',
    [event.paymentId],
  );
  const d = deposit.rows[0];
  if (!d || d.provider !== providerId)
    return { status: 'ignored', reason: 'unknown_payment' };
  if (event.amountMinor !== d.amount || event.currency !== 'EUR')
    return { status: 'ignored', reason: 'amount_mismatch' };
  if (event.type === 'deposit.disputed') {
    try {
      await c.query('SAVEPOINT dispute');
      await openDispute(
        c,
        event.paymentId,
        'Provider dispute',
        `provider:${providerId}`,
      );
      await c.query('RELEASE SAVEPOINT dispute');
      return { status: 'processed' };
    } catch (error) {
      await c.query('ROLLBACK TO SAVEPOINT dispute');
      if (error instanceof WalletError)
        return { status: 'ignored', reason: error.code };
      throw error;
    }
  }
  const open = await c.query<{ id: string }>(
    "SELECT id FROM deposit_disputes WHERE deposit_id=$1 AND status='open'",
    [event.paymentId],
  );
  if (!open.rows[0]) return { status: 'ignored', reason: 'no_open_dispute' };
  await resolveDispute(
    c,
    open.rows[0].id,
    event.type === 'dispute.won' ? 'won' : 'lost',
    `provider:${providerId}`,
  );
  return { status: 'processed' };
}

export async function adminOpenDispute(
  c: PoolClient,
  actor: AdminActor,
  depositId: string,
  reason: string,
) {
  const d = await openDispute(c, depositId, reason, actor.name);
  await audit(c, actor, 'dispute.open', d.id, { depositId, reason });
  return { dispute: disputeView(d) };
}

export async function adminResolveDispute(
  c: PoolClient,
  actor: AdminActor,
  disputeId: string,
  outcome: 'won' | 'lost',
  note?: string,
) {
  const d = await resolveDispute(c, disputeId, outcome, actor.name);
  await audit(c, actor, `dispute.${outcome}`, d.id, {
    amountMinor: d.amount_minor,
    shortfallMinor: d.shortfall_minor,
    note: note ?? null,
  });
  return { dispute: disputeView(d) };
}

export async function listDisputes(c: PoolClient, status?: string) {
  const { rows } = await c.query<DisputeRow>(
    `SELECT ${DISPUTE_COLUMNS} FROM deposit_disputes
     WHERE $1::text IS NULL OR status=$1 ORDER BY created_at DESC,id LIMIT 200`,
    [status ?? null],
  );
  return { disputes: rows.map(disputeView) };
}

// Reconciliation

/**
 * Compares the provider's reported balance with the ledger, and re-derives the
 * provider position from deposits, payouts and chargebacks. Every run is stored.
 */
export async function reconcile(
  c: PoolClient,
  actor: AdminActor,
  input: { provider: string; periodEnd: string; reportedHeldMinor: number },
) {
  const account = await c.query<{ amount: number }>(
    'SELECT balance_minor::float8 AS amount FROM wallet_accounts WHERE key=$1',
    [externalAccount(input.provider)],
  );
  if (!account.rows[0]) throw new WalletError('provider_not_found', 404);
  const internalHeld = -account.rows[0].amount;
  const facts = await c.query<{
    ledgerSum: number;
    driftedAccounts: number;
    operationalHeld: number;
    openTerminalPools: number;
    unsettledHouseMatches: number;
  }>(
    `SELECT
       (SELECT coalesce(sum(amount_minor),0)::float8 FROM ledger_entries) AS "ledgerSum",
       (SELECT count(*)::int FROM (SELECT a.key FROM wallet_accounts a LEFT JOIN ledger_entries e ON e.account_key=a.key
          GROUP BY a.key,a.balance_minor HAVING a.balance_minor<>coalesce(sum(e.amount_minor),0)) x) AS "driftedAccounts",
       ((SELECT coalesce(sum(amount_minor),0) FROM deposits WHERE provider=$1 AND status='succeeded')
        - (SELECT coalesce(sum(amount_minor),0) FROM withdrawal_requests WHERE provider=$1 AND status='paid')
        - (SELECT coalesce(sum(amount_minor),0) FROM deposit_disputes WHERE provider=$1 AND status='lost'))::float8 AS "operationalHeld",
       (SELECT count(*)::int FROM tournaments t JOIN wallet_accounts a ON a.key='tournament_pool:'||t.id
          WHERE t.status IN ('completed','cancelled') AND a.balance_minor<>0)
       + (SELECT count(*)::int FROM game_tables t JOIN wallet_accounts a ON a.key='prize_pool:'||t.id
          WHERE t.status IN ('completed','cancelled') AND a.balance_minor<>0) AS "openTerminalPools",
       (SELECT count(*)::int FROM house_matches m JOIN wallet_accounts a ON a.key='house_match:'||m.id
          WHERE m.status<>'active' AND a.balance_minor<>0) AS "unsettledHouseMatches"`,
    [input.provider],
  );
  const f = facts.rows[0]!;
  const checks = {
    ledgerBalanced: f.ledgerSum === 0,
    projectionsMatchHistory: f.driftedAccounts === 0,
    operationsMatchLedger: f.operationalHeld === internalHeld,
    terminalPoolsEmpty: f.openTerminalPools === 0,
    settledHouseMatchesEmpty: f.unsettledHouseMatches === 0,
  };
  const difference = input.reportedHeldMinor - internalHeld;
  const status =
    difference === 0 && Object.values(checks).every(Boolean)
      ? 'ok'
      : 'mismatch';
  const id = randomUUID();
  await c.query(
    `INSERT INTO reconciliation_runs(id,provider,period_end,reported_held_minor,internal_held_minor,difference_minor,checks,status,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      input.provider,
      input.periodEnd,
      input.reportedHeldMinor,
      internalHeld,
      difference,
      JSON.stringify(checks),
      status,
      actor.name,
    ],
  );
  await audit(c, actor, 'reconciliation.run', id, {
    provider: input.provider,
    status,
    differenceMinor: difference,
  });
  return {
    reconciliation: {
      id,
      provider: input.provider,
      periodEnd: input.periodEnd,
      reportedHeldMinor: input.reportedHeldMinor,
      internalHeldMinor: internalHeld,
      differenceMinor: difference,
      checks,
      status,
    },
  };
}

export async function listReconciliations(c: PoolClient) {
  const { rows } = await c.query(
    `SELECT id,provider,period_end AS "periodEnd",reported_held_minor::float8 AS "reportedHeldMinor",
       internal_held_minor::float8 AS "internalHeldMinor",difference_minor::float8 AS "differenceMinor",
       checks,status,created_by AS "createdBy",created_at AS "createdAt"
     FROM reconciliation_runs ORDER BY created_at DESC,id LIMIT 100`,
  );
  return { reconciliations: rows };
}

export async function auditLog(c: PoolClient, limit: number) {
  const { rows } = await c.query(
    `SELECT id,actor,role,action,target,details,created_at AS "createdAt"
     FROM admin_audit_log ORDER BY created_at DESC,id LIMIT $1`,
    [limit],
  );
  return { entries: rows };
}
